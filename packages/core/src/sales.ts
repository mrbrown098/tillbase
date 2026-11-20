import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { taxFor } from "./money.js";

export type PaymentMethod = "cash" | "card" | "other";

export interface CartLine {
  productId: string;
  qty: number;
  /** Override the catalogue price (minor units). */
  unitPriceMinor?: number;
  /** Discount on this line (minor units). */
  discountMinor?: number;
}

export interface PaymentInput {
  method: PaymentMethod;
  amountMinor: number;
}

export interface CheckoutInput {
  lines: CartLine[];
  payments: PaymentInput[];
  cashier?: string;
  /** Allow selling more than is in stock. Default: false. */
  allowNegativeStock?: boolean;
  /** The open shift this sale belongs to, and who rang it up. */
  shiftId?: string;
  userId?: string;
}

export interface SaleItem {
  id: string;
  productId: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBp: number;
  taxMinor: number;
  totalMinor: number;
  /** What the ingredients or goods sold on this line cost at the time of sale. */
  cogsMinor: number;
}

export interface Payment {
  id: string;
  method: PaymentMethod;
  amountMinor: number;
}

export interface Sale {
  id: string;
  /** For orders taken through the order screen: e.g. "Token 12 · Dine-in · Table 5". */
  orderLabel: string | null;
  receiptNo: string;
  status: "completed" | "void";
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  changeMinor: number;
  cashier: string | null;
  voidReason: string | null;
  shiftId: string | null;
  userId: string | null;
  createdAt: string;
  voidedAt: string | null;
  items: SaleItem[];
  payments: Payment[];
}

interface ProductRow {
  id: string;
  name: string;
  kind: string;
  unit: string;
  price_minor: number;
  tax_rate_bp: number;
  track_stock: number;
  avg_cost: number;
  active: number;
}

/** One stock item used up by a sale line: the product itself, or an ingredient of its recipe. */
interface Use {
  productId: string;
  name: string;
  unit: string;
  qty: number;
  avgCost: number;
  track: boolean;
}

const fmtQty = (n: number): string => String(Math.round(n * 1000) / 1000);

export class SaleService {
  constructor(
    private readonly db: Db,
    /** Short prefix for receipt numbers, e.g. a till or branch code. */
    private readonly receiptPrefix = "R",
  ) {}

  /**
   * Complete a sale in one database transaction: price the lines, check
   * stock and payment, write the sale, use up stock (ingredients, for menu items
   * with a recipe) and record what it all cost. If anything fails, nothing is saved.
   */
  checkout(input: CheckoutInput): Sale {
    if (input.lines.length === 0) throw new Error("The cart is empty");
    if (input.payments.length === 0) throw new Error("A payment is required");

    const run = this.db.transaction((): string => {
      const now = new Date().toISOString();
      const saleId = randomUUID();

      let subtotal = 0;
      let discount = 0;
      let tax = 0;

      const getProduct = this.db.prepare(
        `SELECT id, name, kind, unit, price_minor, tax_rate_bp, track_stock, avg_cost, active
           FROM products WHERE id = ?`,
      );
      const getRecipe = this.db.prepare(
        `SELECT ri.ingredient_id AS id, i.name AS name, i.unit AS unit, i.track_stock AS track,
                i.avg_cost AS avgCost, ri.qty AS qty
           FROM recipe_items ri JOIN products i ON i.id = ri.ingredient_id
          WHERE ri.product_id = ?`,
      );
      const stockOf = this.db.prepare(
        "SELECT COALESCE(SUM(qty_delta), 0) AS q FROM stock_movements WHERE product_id = ?",
      );

      // Total needed per stock item across the whole cart, so two lines that
      // both use the same chicken are checked together.
      const needs = new Map<string, { name: string; unit: string; qty: number }>();

      const priced = input.lines.map((line) => {
        if (!(line.qty > 0) || !Number.isFinite(line.qty)) {
          throw new Error("Quantity must be greater than zero");
        }
        const p = getProduct.get(line.productId) as ProductRow | undefined;
        if (!p) throw new Error(`Product not found: ${line.productId}`);
        if (p.active !== 1) throw new Error(`Product is inactive: ${p.name}`);
        if (p.kind !== "product") throw new Error(`${p.name} is an ingredient and cannot be sold`);

        const unit = line.unitPriceMinor ?? p.price_minor;
        const lineDiscount = line.discountMinor ?? 0;
        if (!Number.isInteger(unit) || unit < 0) {
          throw new Error("Unit price must be a non-negative integer");
        }
        if (!Number.isInteger(lineDiscount) || lineDiscount < 0) {
          throw new Error("Discount must be a non-negative integer");
        }
        const gross = Math.round(line.qty * unit);
        if (lineDiscount > gross) {
          throw new Error(`Discount is larger than the line total for ${p.name}`);
        }
        const net = gross - lineDiscount;
        const lineTax = taxFor(net, p.tax_rate_bp);

        const recipe = getRecipe.all(p.id) as {
          id: string;
          name: string;
          unit: string;
          track: number;
          avgCost: number;
          qty: number;
        }[];
        const uses: Use[] =
          recipe.length > 0
            ? recipe.map((r) => ({
                productId: r.id,
                name: r.name,
                unit: r.unit,
                qty: r.qty * line.qty,
                avgCost: r.avgCost,
                track: r.track === 1,
              }))
            : [
                {
                  productId: p.id,
                  name: p.name,
                  unit: p.unit,
                  qty: line.qty,
                  avgCost: p.avg_cost,
                  track: p.track_stock === 1,
                },
              ];
        for (const u of uses) {
          if (!u.track) continue;
          const cur = needs.get(u.productId);
          if (cur) cur.qty += u.qty;
          else needs.set(u.productId, { name: u.name, unit: u.unit, qty: u.qty });
        }
        const cogs = uses.reduce((sum, u) => sum + Math.round(u.qty * u.avgCost), 0);

        subtotal += gross;
        discount += lineDiscount;
        tax += lineTax;
        return { p, qty: line.qty, unit, lineDiscount, lineTax, total: net + lineTax, uses, cogs };
      });

      if (!input.allowNegativeStock) {
        for (const [id, need] of needs) {
          const have = (stockOf.get(id) as { q: number }).q;
          if (have + 1e-9 < need.qty) {
            throw new Error(
              `Not enough stock for ${need.name} (have ${fmtQty(have)} ${need.unit}, need ${fmtQty(need.qty)} ${need.unit})`,
            );
          }
        }
      }

      const total = subtotal - discount + tax;

      for (const pay of input.payments) {
        if (!Number.isInteger(pay.amountMinor) || pay.amountMinor <= 0) {
          throw new Error("Payment amounts must be positive integers");
        }
      }
      const paid = input.payments.reduce((s, x) => s + x.amountMinor, 0);
      if (paid < total) {
        throw new Error(`Payment is short by ${total - paid} (minor units)`);
      }
      const change = paid - total;
      const cashPaid = input.payments
        .filter((x) => x.method === "cash")
        .reduce((s, x) => s + x.amountMinor, 0);
      if (change > cashPaid) {
        throw new Error("Change can only be given from a cash payment");
      }

      const receiptNo = this.nextReceiptNo();
      this.db
        .prepare(
          `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor,
             tax_minor, total_minor, paid_minor, change_minor, cashier, created_at,
             shift_id, user_id)
           VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          saleId,
          receiptNo,
          subtotal,
          discount,
          tax,
          total,
          paid,
          change,
          input.cashier ?? null,
          now,
          input.shiftId ?? null,
          input.userId ?? null,
        );

      const insItem = this.db.prepare(
        `INSERT INTO sale_items (id, sale_id, product_id, name, qty, unit_price_minor,
           discount_minor, tax_rate_bp, tax_minor, total_minor, cogs_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insMove = this.db.prepare(
        `INSERT INTO stock_movements
           (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor)
         VALUES (?, ?, ?, 'sale', 'sale', ?, ?, ?)`,
      );
      for (const x of priced) {
        insItem.run(
          randomUUID(),
          saleId,
          x.p.id,
          x.p.name,
          x.qty,
          x.unit,
          x.lineDiscount,
          x.p.tax_rate_bp,
          x.lineTax,
          x.total,
          x.cogs,
        );
        for (const u of x.uses) {
          if (u.track) {
            insMove.run(randomUUID(), u.productId, -u.qty, saleId, now, -Math.round(u.qty * u.avgCost));
          }
        }
      }

      const insPay = this.db.prepare(
        "INSERT INTO payments (id, sale_id, method, amount_minor) VALUES (?, ?, ?, ?)",
      );
      for (const pay of input.payments) {
        insPay.run(randomUUID(), saleId, pay.method, pay.amountMinor);
      }
      return saleId;
    });

    return this.mustGet(run());
  }

  /**
   * Void a completed sale and put its stock back. The stock movements made by the
   * sale are reversed exactly (same items, same quantities, same cost), so recipes
   * and costs stay correct. Cannot be undone.
   */
  voidSale(saleId: string, reason: string): Sale {
    if (!reason.trim()) throw new Error("A reason is required to void a sale");
    this.db.transaction(() => {
      const sale = this.db
        .prepare("SELECT status FROM sales WHERE id = ?")
        .get(saleId) as { status: string } | undefined;
      if (!sale) throw new Error(`Sale not found: ${saleId}`);
      if (sale.status === "void") throw new Error("Sale is already void");

      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE sales SET status='void', void_reason=?, voided_at=? WHERE id=?",
        )
        .run(reason.trim(), now, saleId);

      const original = this.db
        .prepare(
          `SELECT product_id AS productId, qty_delta AS qty, value_minor AS value
             FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ? AND reason = 'sale'`,
        )
        .all(saleId) as { productId: string; qty: number; value: number }[];
      const insMove = this.db.prepare(
        `INSERT INTO stock_movements
           (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor)
         VALUES (?, ?, ?, 'void', 'sale', ?, ?, ?)`,
      );
      for (const m of original) {
        insMove.run(randomUUID(), m.productId, -m.qty, saleId, now, -m.value);
      }
    })();
    return this.mustGet(saleId);
  }

  get(saleId: string): Sale | undefined {
    const s = this.db.prepare("SELECT * FROM sales WHERE id = ?").get(saleId) as
      | Record<string, unknown>
      | undefined;
    if (!s) return undefined;

    const items = (
      this.db
        .prepare("SELECT * FROM sale_items WHERE sale_id = ? ORDER BY rowid")
        .all(saleId) as Record<string, unknown>[]
    ).map(
      (r): SaleItem => ({
        id: r.id as string,
        productId: r.product_id as string,
        name: r.name as string,
        qty: r.qty as number,
        unitPriceMinor: r.unit_price_minor as number,
        discountMinor: r.discount_minor as number,
        taxRateBp: r.tax_rate_bp as number,
        taxMinor: r.tax_minor as number,
        totalMinor: r.total_minor as number,
        cogsMinor: (r.cogs_minor as number | undefined) ?? 0,
      }),
    );
    const payments = (
      this.db
        .prepare("SELECT * FROM payments WHERE sale_id = ? ORDER BY rowid")
        .all(saleId) as Record<string, unknown>[]
    ).map(
      (r): Payment => ({
        id: r.id as string,
        method: r.method as PaymentMethod,
        amountMinor: r.amount_minor as number,
      }),
    );

    const ord = this.db
      .prepare("SELECT token, type, table_label AS tbl FROM orders WHERE sale_id = ?")
      .get(saleId) as { token: number; type: string; tbl: string | null } | undefined;
    const typeName: Record<string, string> = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
    const orderLabel = ord
      ? `Token ${ord.token} · ${typeName[ord.type] ?? ord.type}${ord.tbl ? ` · Table ${ord.tbl}` : ""}`
      : null;

    return {
      id: s.id as string,
      orderLabel,
      receiptNo: s.receipt_no as string,
      status: s.status as "completed" | "void",
      subtotalMinor: s.subtotal_minor as number,
      discountMinor: s.discount_minor as number,
      taxMinor: s.tax_minor as number,
      totalMinor: s.total_minor as number,
      paidMinor: s.paid_minor as number,
      changeMinor: s.change_minor as number,
      cashier: (s.cashier as string | null) ?? null,
      voidReason: (s.void_reason as string | null) ?? null,
      shiftId: (s.shift_id as string | null) ?? null,
      userId: (s.user_id as string | null) ?? null,
      createdAt: s.created_at as string,
      voidedAt: (s.voided_at as string | null) ?? null,
      items,
      payments,
    };
  }

  /** Most recent sales first, including voided ones. */
  recent(limit = 50): Sale[] {
    const ids = this.db
      .prepare("SELECT id FROM sales ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as { id: string }[];
    return ids.map((r) => this.mustGet(r.id));
  }

  findByReceiptNo(receiptNo: string): Sale | undefined {
    const row = this.db
      .prepare("SELECT id FROM sales WHERE receipt_no = ?")
      .get(receiptNo) as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
  }

  private nextReceiptNo(): string {
    this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES ('receipt', 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1`,
      )
      .run();
    const { value } = this.db
      .prepare("SELECT value FROM counters WHERE name = 'receipt'")
      .get() as { value: number };
    return `${this.receiptPrefix}-${String(value).padStart(6, "0")}`;
  }

  private mustGet(id: string): Sale {
    const s = this.get(id);
    if (!s) throw new Error(`Sale not found: ${id}`);
    return s;
  }
}
