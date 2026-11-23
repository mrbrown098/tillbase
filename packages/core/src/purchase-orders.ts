import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { assertDate, dayEndISO, dayStartISO } from "./dates.js";
import { tidy } from "./inventory.js";
import { PurchaseService, type PayMethod } from "./purchases.js";

export type PurchaseOrderStatus = "open" | "received" | "cancelled";

export interface PurchaseOrderLineInput {
  productId: string;
  qty: number;
  /** The agreed price of ONE unit, in minor units (for example per kg). */
  unitCostMinor: number;
}

export interface PurchaseOrderInput {
  supplier: string;
  reference?: string;
  note?: string;
  lines: PurchaseOrderLineInput[];
  userId?: string;
}

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  name: string;
  unit: string;
  qtyOrdered: number;
  qtyReceived: number;
  qtyRemaining: number;
  unitCostMinor: number;
  /** Ordered quantity at the agreed price. */
  orderedValueMinor: number;
}

export interface PurchaseOrderReceipt {
  id: string;
  purchaseId: string;
  createdAt: string;
  totalMinor: number;
}

export interface PurchaseOrder {
  id: string;
  number: number;
  /** PO-0001 */
  code: string;
  supplier: string;
  reference: string | null;
  note: string | null;
  status: PurchaseOrderStatus;
  /** What the owner sees: nothing yet, some of it, all of it, or cancelled. */
  progress: "waiting" | "partly_received" | "received" | "cancelled";
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  lines: PurchaseOrderLine[];
  receipts: PurchaseOrderReceipt[];
  /** Everything ordered, at the agreed prices. */
  orderedTotalMinor: number;
  /** What has actually been booked as purchases so far (the real invoice amounts). */
  receivedTotalMinor: number;
  /** Still expected: the unreceived part at agreed prices. Zero once received or cancelled. */
  onOrderMinor: number;
}

export interface ReceiveInput {
  lines: {
    lineId: string;
    /** Quantity that arrived now. */
    qty: number;
    /** What the supplier charged for this delivery of the line, if not qty x the agreed price. */
    costMinor?: number;
  }[];
  /** Paid at the time of delivery. The rest is owed to the supplier. */
  paidMinor?: number;
  method?: PayMethod;
  /** The supplier's own invoice or delivery note number. */
  invoiceRef?: string;
  userId?: string;
}

export interface StatementEntry {
  /** ISO time. */
  at: string;
  kind: "purchase" | "payment";
  /** Purchase reference or payment note, for example "PO-0003". */
  description: string;
  /** What we owe the supplier more (a purchase). */
  debitMinor: number;
  /** What we paid the supplier (a payment). */
  creditMinor: number;
  /** What we owe the supplier after this line. */
  balanceMinor: number;
}

export interface SupplierStatement {
  supplier: string;
  from: string | null;
  to: string | null;
  /** What we owed before `from` (0 when there is no `from`). */
  openingBalanceMinor: number;
  entries: StatementEntry[];
  totalPurchasedMinor: number;
  totalPaidMinor: number;
  /** What we owe at the end of the period. */
  closingBalanceMinor: number;
  /** Orders placed but not yet delivered. Not owed yet: shown so the owner sees what is coming. */
  onOrder: { code: string; createdAt: string; remainingMinor: number }[];
  onOrderTotalMinor: number;
}

interface OrderRow {
  id: string;
  number: number;
  supplier: string;
  reference: string | null;
  note: string | null;
  status: PurchaseOrderStatus;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

/** Quantities are fractions of a kg or a litre, so they can carry tiny rounding noise. */
const EPS = 1e-9;
const code = (n: number) => `PO-${String(n).padStart(4, "0")}`;
const money = (qty: number, unitCostMinor: number) => Math.round(qty * unitCostMinor);

/**
 * Orders sent to suppliers, and receiving them in one or several deliveries.
 *
 * Ordering does not change stock or what you owe. Receiving does, and it always goes through
 * `PurchaseService.record`, so every delivery is a normal purchase: it adds stock movements at the real
 * cost, updates the average cost, and shows up in what you owe the supplier.
 */
export class PurchaseOrderService {
  constructor(
    private readonly db: Db,
    private readonly purchases: PurchaseService = new PurchaseService(db),
  ) {}

  create(input: PurchaseOrderInput): PurchaseOrder {
    const supplier = input.supplier?.trim();
    if (!supplier) throw new Error("Enter the supplier's name");
    if (!input.lines?.length) throw new Error("Add at least one item to the order");
    const id = randomUUID();
    this.db.transaction(() => {
      const getProduct = this.db.prepare("SELECT id FROM products WHERE id = ? AND is_system = 0");
      for (const l of input.lines) {
        if (!Number.isFinite(l.qty) || !(l.qty > 0)) throw new Error("Quantity must be greater than zero");
        if (!Number.isInteger(l.unitCostMinor) || l.unitCostMinor < 0) throw new Error("Price must be a whole, non-negative amount");
        if (!getProduct.get(l.productId)) throw new Error("Product not found");
      }
      const next = (this.db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM purchase_orders").get() as { n: number }).n;
      this.db
        .prepare(
          `INSERT INTO purchase_orders (id, number, supplier, reference, note, status, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(id, next, supplier, input.reference?.trim() || null, input.note?.trim() || null, input.userId ?? null, new Date().toISOString());
      const ins = this.db.prepare(
        "INSERT INTO purchase_order_lines (id, order_id, product_id, qty_ordered, unit_cost_minor) VALUES (?, ?, ?, ?, ?)",
      );
      for (const l of input.lines) ins.run(randomUUID(), id, l.productId, l.qty, l.unitCostMinor);
    })();
    return this.mustGet(id);
  }

  /**
   * Book a delivery, full or partial. The order closes by itself when every line is complete.
   * More than what is still expected on a line is refused.
   */
  receive(orderId: string, input: ReceiveInput): PurchaseOrder {
    this.db.transaction(() => {
      const order = this.mustGet(orderId);
      if (order.status === "cancelled") throw new Error(`${order.code} was cancelled, so nothing more can be received on it`);
      if (order.status === "received") throw new Error(`${order.code} has already been received in full`);
      if (!input.lines?.length) throw new Error("Choose what arrived");

      const seen = new Set<string>();
      const items: { productId: string; qty: number; costMinor: number }[] = [];
      const booked: { line: PurchaseOrderLine; qty: number; costMinor: number }[] = [];
      for (const r of input.lines) {
        if (seen.has(r.lineId)) throw new Error("The same item is listed twice");
        seen.add(r.lineId);
        const line = order.lines.find((l) => l.id === r.lineId);
        if (!line) throw new Error("That item is not on this order");
        if (!Number.isFinite(r.qty) || !(r.qty > 0)) throw new Error("Quantity must be greater than zero");
        if (r.qty > line.qtyRemaining + EPS) {
          throw new Error(`Only ${line.qtyRemaining} ${line.unit} of ${line.name} is still expected on ${order.code}`);
        }
        const costMinor = r.costMinor ?? money(r.qty, line.unitCostMinor);
        if (!Number.isInteger(costMinor) || costMinor < 0) throw new Error("Cost must be a whole, non-negative amount");
        items.push({ productId: line.productId, qty: r.qty, costMinor });
        booked.push({ line, qty: r.qty, costMinor });
      }

      // The delivery becomes an ordinary purchase: stock movements, average cost and what we owe all
      // come from PurchaseService, never from here.
      const purchase = this.purchases.record({
        supplier: order.supplier,
        reference: order.code,
        note: input.invoiceRef?.trim() ? `Invoice ${input.invoiceRef.trim()}` : undefined,
        items,
        paidMinor: input.paidMinor,
        method: input.method,
        userId: input.userId,
      });

      const now = new Date().toISOString();
      const receiptId = randomUUID();
      this.db
        .prepare("INSERT INTO purchase_order_receipts (id, order_id, purchase_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(receiptId, orderId, purchase.id, input.userId ?? null, now);
      const insLine = this.db.prepare(
        "INSERT INTO purchase_order_receipt_lines (id, receipt_id, line_id, qty, cost_minor) VALUES (?, ?, ?, ?, ?)",
      );
      const bump = this.db.prepare("UPDATE purchase_order_lines SET qty_received = qty_received + ? WHERE id = ?");
      for (const b of booked) {
        insLine.run(randomUUID(), receiptId, b.line.id, b.qty, b.costMinor);
        bump.run(b.qty, b.line.id);
      }

      const open = this.db
        .prepare("SELECT 1 FROM purchase_order_lines WHERE order_id = ? AND qty_ordered - qty_received > ? LIMIT 1")
        .get(orderId, EPS);
      if (!open) this.db.prepare("UPDATE purchase_orders SET status = 'received' WHERE id = ?").run(orderId);
    })();
    return this.mustGet(orderId);
  }

  /** Receive everything still expected, at the agreed prices. */
  receiveAll(orderId: string, opts: Omit<ReceiveInput, "lines"> = {}): PurchaseOrder {
    const order = this.mustGet(orderId);
    const lines = order.lines.filter((l) => l.qtyRemaining > EPS).map((l) => ({ lineId: l.id, qty: l.qtyRemaining }));
    return this.receive(orderId, { ...opts, lines });
  }

  /**
   * Cancel an order that has not been received in full. What already arrived stays booked (it is real
   * stock and a real purchase); only the part still expected is dropped.
   */
  cancel(orderId: string, reason?: string): PurchaseOrder {
    this.db.transaction(() => {
      const order = this.mustGet(orderId);
      if (order.status === "cancelled") throw new Error(`${order.code} is already cancelled`);
      if (order.status === "received") throw new Error(`${order.code} was received in full, so it cannot be cancelled`);
      this.db
        .prepare("UPDATE purchase_orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?")
        .run(new Date().toISOString(), reason?.trim() || null, orderId);
    })();
    return this.mustGet(orderId);
  }

  get(id: string): PurchaseOrder | undefined {
    const r = this.db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id) as OrderRow | undefined;
    return r ? this.build(r) : undefined;
  }

  list(opts: { status?: PurchaseOrderStatus; supplier?: string; limit?: number } = {}): PurchaseOrder[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.supplier?.trim()) {
      where.push("supplier = ? COLLATE NOCASE");
      args.push(opts.supplier.trim());
    }
    const rows = this.db
      .prepare(`SELECT * FROM purchase_orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY number DESC LIMIT ?`)
      .all(...args, opts.limit ?? 200) as OrderRow[];
    return rows.map((r) => this.build(r));
  }

  /** Every supplier name we know, from purchases and from orders, without duplicates that differ only in capitals. */
  suppliers(): string[] {
    const rows = this.db
      .prepare(
        `SELECT name FROM (
           SELECT TRIM(supplier) AS name FROM purchases WHERE supplier IS NOT NULL AND TRIM(supplier) <> ''
           UNION
           SELECT TRIM(supplier) AS name FROM purchase_orders)
         GROUP BY LOWER(name) ORDER BY LOWER(name)`,
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  /**
   * What we owe one supplier, line by line: purchases add to it, payments reduce it. `from` and `to` are
   * whole local days (inclusive); leave them out for the whole history. Supplier names match without
   * regard to capital letters.
   */
  statement(supplier: string, range: { from?: string; to?: string } = {}): SupplierStatement {
    const name = supplier?.trim();
    if (!name) throw new Error("Choose a supplier");
    if (range.from) assertDate("From", range.from);
    if (range.to) assertDate("To", range.to);
    if (range.from && range.to && range.to < range.from) throw new Error("The end date cannot be before the start date");
    const fromIso = range.from ? dayStartISO(range.from) : null;
    const toIso = range.to ? dayEndISO(range.to) : null;

    const purchases = this.db
      .prepare(
        `SELECT id, created_at AS at, reference, total_minor AS amount, rowid AS ord
           FROM purchases WHERE supplier = ? COLLATE NOCASE`,
      )
      .all(name) as { id: string; at: string; reference: string | null; amount: number; ord: number }[];
    const payments = this.db
      .prepare(
        `SELECT pp.created_at AS at, pp.amount_minor AS amount, pp.method AS method, p.reference AS reference, pp.rowid AS ord
           FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
          WHERE p.supplier = ? COLLATE NOCASE`,
      )
      .all(name) as { at: string; amount: number; method: string; reference: string | null; ord: number }[];

    type Raw = { at: string; kind: StatementEntry["kind"]; description: string; debit: number; credit: number; ord: number };
    const raw: Raw[] = [
      ...purchases.map((p) => ({ at: p.at, kind: "purchase" as const, description: p.reference ? `Purchase ${p.reference}` : "Purchase", debit: p.amount, credit: 0, ord: p.ord })),
      ...payments.map((p) => ({ at: p.at, kind: "payment" as const, description: `Payment (${p.method})${p.reference ? ` ${p.reference}` : ""}`, debit: 0, credit: p.amount, ord: p.ord })),
    ].sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? a.ord - b.ord : a.kind === "purchase" ? -1 : 1));

    let balance = 0;
    let opening = 0;
    let purchased = 0;
    let paid = 0;
    const entries: StatementEntry[] = [];
    for (const r of raw) {
      balance += r.debit - r.credit;
      if (fromIso && r.at < fromIso) {
        opening = balance;
        continue;
      }
      if (toIso && r.at >= toIso) continue;
      purchased += r.debit;
      paid += r.credit;
      entries.push({ at: r.at, kind: r.kind, description: r.description, debitMinor: r.debit, creditMinor: r.credit, balanceMinor: balance });
    }
    const closing = opening + purchased - paid;

    const onOrder = this.list({ status: "open", supplier: name })
      .filter((o) => o.onOrderMinor > 0)
      .map((o) => ({ code: o.code, createdAt: o.createdAt, remainingMinor: o.onOrderMinor }));
    return {
      supplier: name,
      from: range.from ?? null,
      to: range.to ?? null,
      openingBalanceMinor: opening,
      entries,
      totalPurchasedMinor: purchased,
      totalPaidMinor: paid,
      closingBalanceMinor: closing,
      onOrder,
      onOrderTotalMinor: onOrder.reduce((s, o) => s + o.remainingMinor, 0),
    };
  }

  private build(r: OrderRow): PurchaseOrder {
    const lines = (
      this.db
        .prepare(
          `SELECT l.id, l.product_id AS productId, p.name, p.unit, l.qty_ordered AS qo, l.qty_received AS qr, l.unit_cost_minor AS unitCostMinor
             FROM purchase_order_lines l JOIN products p ON p.id = l.product_id
            WHERE l.order_id = ? ORDER BY l.rowid`,
        )
        .all(r.id) as { id: string; productId: string; name: string; unit: string; qo: number; qr: number; unitCostMinor: number }[]
    ).map<PurchaseOrderLine>((l) => {
      const received = tidy(l.qr);
      return {
        id: l.id,
        productId: l.productId,
        name: l.name,
        unit: l.unit,
        qtyOrdered: tidy(l.qo),
        qtyReceived: received,
        qtyRemaining: Math.max(0, tidy(l.qo - l.qr)),
        unitCostMinor: l.unitCostMinor,
        orderedValueMinor: money(l.qo, l.unitCostMinor),
      };
    });
    const receipts = this.db
      .prepare(
        `SELECT rc.id, rc.purchase_id AS purchaseId, rc.created_at AS createdAt,
                COALESCE((SELECT SUM(cost_minor) FROM purchase_order_receipt_lines WHERE receipt_id = rc.id), 0) AS totalMinor
           FROM purchase_order_receipts rc WHERE rc.order_id = ? ORDER BY rc.created_at, rc.rowid`,
      )
      .all(r.id) as PurchaseOrderReceipt[];
    const anyReceived = lines.some((l) => l.qtyReceived > 0);
    const progress: PurchaseOrder["progress"] =
      r.status === "cancelled" ? "cancelled" : r.status === "received" ? "received" : anyReceived ? "partly_received" : "waiting";
    return {
      id: r.id,
      number: r.number,
      code: code(r.number),
      supplier: r.supplier,
      reference: r.reference,
      note: r.note,
      status: r.status,
      progress,
      createdAt: r.created_at,
      cancelledAt: r.cancelled_at,
      cancelReason: r.cancel_reason,
      lines,
      receipts,
      orderedTotalMinor: lines.reduce((s, l) => s + l.orderedValueMinor, 0),
      receivedTotalMinor: receipts.reduce((s, x) => s + x.totalMinor, 0),
      onOrderMinor: r.status === "open" ? lines.reduce((s, l) => s + money(l.qtyRemaining, l.unitCostMinor), 0) : 0,
    };
  }

  private mustGet(id: string): PurchaseOrder {
    const o = this.get(id);
    if (!o) throw new Error("Order not found");
    return o;
  }
}
