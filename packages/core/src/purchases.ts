import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { tidy } from "./inventory.js";

export type PayMethod = "cash" | "card" | "other";

export interface PurchaseItemInput {
  productId: string;
  qty: number;
  /** What was paid for this whole line, in minor units. */
  costMinor: number;
}

export interface PurchaseInput {
  supplier?: string;
  reference?: string;
  note?: string;
  items: PurchaseItemInput[];
  /** Paid at the time of purchase. The rest is owed to the supplier. */
  paidMinor?: number;
  method?: PayMethod;
  userId?: string;
}

export interface Purchase {
  id: string;
  supplier: string | null;
  reference: string | null;
  note: string | null;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  createdAt: string;
  items: { productId: string; name: string; unit: string; qty: number; costMinor: number }[];
}

export interface Payables {
  totalMinor: number;
  bySupplier: { supplier: string; outstandingMinor: number }[];
}

interface Row {
  id: string;
  supplier: string | null;
  reference: string | null;
  note: string | null;
  total_minor: number;
  paid_minor: number;
  created_at: string;
}

/**
 * Buying stock. Each purchase adds stock at its real cost and updates the item's
 * weighted-average cost, so margins reflect what you actually paid.
 */
export class PurchaseService {
  constructor(private readonly db: Db) {}

  record(input: PurchaseInput): Purchase {
    if (!input.items.length) throw new Error("Add at least one item to the purchase");
    const paid = input.paidMinor ?? 0;
    if (!Number.isInteger(paid) || paid < 0) throw new Error("Paid amount must be a whole, non-negative amount");

    const id = randomUUID();
    this.db.transaction(() => {
      const now = new Date().toISOString();
      let total = 0;
      for (const it of input.items) {
        if (!(it.qty > 0) || !Number.isFinite(it.qty)) throw new Error("Quantity must be greater than zero");
        if (!Number.isInteger(it.costMinor) || it.costMinor < 0) {
          throw new Error("Cost must be a whole, non-negative amount");
        }
        total += it.costMinor;
      }
      if (paid > total) throw new Error("You cannot pay more than the purchase total");

      this.db
        .prepare(
          `INSERT INTO purchases (id, supplier, reference, note, total_minor, paid_minor, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.supplier?.trim() || null,
          input.reference?.trim() || null,
          input.note?.trim() || null,
          total,
          paid,
          input.userId ?? null,
          now,
        );

      const getProduct = this.db.prepare("SELECT id, avg_cost AS avgCost FROM products WHERE id = ?");
      const stockOf = this.db.prepare(
        "SELECT COALESCE(SUM(qty_delta), 0) AS q FROM stock_movements WHERE product_id = ?",
      );
      const insItem = this.db.prepare(
        "INSERT INTO purchase_items (id, purchase_id, product_id, qty, cost_minor) VALUES (?, ?, ?, ?, ?)",
      );
      const insMove = this.db.prepare(
        `INSERT INTO stock_movements
           (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor)
         VALUES (?, ?, ?, 'purchase', 'purchase', ?, ?, ?)`,
      );
      const setCost = this.db.prepare(
        "UPDATE products SET avg_cost = ?, cost_minor = ?, updated_at = ? WHERE id = ?",
      );

      for (const it of input.items) {
        const p = getProduct.get(it.productId) as { id: string; avgCost: number } | undefined;
        if (!p) throw new Error("Product not found");
        // Stock that is already negative (oversold) carries no value into the average.
        const have = Math.max(0, (stockOf.get(it.productId) as { q: number }).q);
        const newAvg = (have * p.avgCost + it.costMinor) / (have + it.qty);
        insItem.run(randomUUID(), id, it.productId, it.qty, it.costMinor);
        insMove.run(randomUUID(), it.productId, it.qty, id, now, it.costMinor);
        setCost.run(newAvg, Math.round(it.costMinor / it.qty), now, it.productId);
      }

      if (paid > 0) {
        this.db
          .prepare(
            "INSERT INTO purchase_payments (id, purchase_id, amount_minor, method, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(randomUUID(), id, paid, input.method ?? "cash", now);
      }
    })();
    return this.mustGet(id);
  }

  /** Pay some or all of what is still owed on a purchase. */
  pay(purchaseId: string, amountMinor: number, method: PayMethod = "cash"): Purchase {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new Error("Payment must be a positive whole amount");
    }
    this.db.transaction(() => {
      const p = this.mustGet(purchaseId);
      if (amountMinor > p.outstandingMinor) {
        throw new Error("That is more than is owed on this purchase");
      }
      this.db
        .prepare(
          "INSERT INTO purchase_payments (id, purchase_id, amount_minor, method, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), purchaseId, amountMinor, method, new Date().toISOString());
      this.db
        .prepare("UPDATE purchases SET paid_minor = paid_minor + ? WHERE id = ?")
        .run(amountMinor, purchaseId);
    })();
    return this.mustGet(purchaseId);
  }

  get(id: string): Purchase | undefined {
    const r = this.db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as Row | undefined;
    if (!r) return undefined;
    const items = (
      this.db
        .prepare(
          `SELECT pi.product_id AS productId, p.name AS name, p.unit AS unit, pi.qty AS qty, pi.cost_minor AS costMinor
             FROM purchase_items pi JOIN products p ON p.id = pi.product_id
            WHERE pi.purchase_id = ? ORDER BY pi.rowid`,
        )
        .all(id) as Purchase["items"]
    ).map((i) => ({ ...i, qty: tidy(i.qty) }));
    return {
      id: r.id,
      supplier: r.supplier,
      reference: r.reference,
      note: r.note,
      totalMinor: r.total_minor,
      paidMinor: r.paid_minor,
      outstandingMinor: r.total_minor - r.paid_minor,
      createdAt: r.created_at,
      items,
    };
  }

  list(opts: { limit?: number; onlyUnpaid?: boolean } = {}): Purchase[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM purchases ${opts.onlyUnpaid ? "WHERE paid_minor < total_minor" : ""}
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(opts.limit ?? 100) as { id: string }[];
    return rows.map((r) => this.mustGet(r.id));
  }

  /** What we still owe suppliers. */
  payables(): Payables {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(supplier, 'Unnamed supplier') AS supplier,
                SUM(total_minor - paid_minor) AS outstandingMinor
           FROM purchases WHERE paid_minor < total_minor
          GROUP BY COALESCE(supplier, 'Unnamed supplier') ORDER BY outstandingMinor DESC`,
      )
      .all() as { supplier: string; outstandingMinor: number }[];
    return { totalMinor: rows.reduce((s, r) => s + r.outstandingMinor, 0), bySupplier: rows };
  }

  private mustGet(id: string): Purchase {
    const p = this.get(id);
    if (!p) throw new Error("Purchase not found");
    return p;
  }
}
