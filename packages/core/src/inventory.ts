import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export interface LowStockItem {
  productId: string;
  name: string;
  unit: string;
  stock: number;
  reorderLevel: number;
}

/** Reasons that count as money lost rather than normal trading. */
export const lossReasons = ["waste", "spoilage", "expired", "damage", "theft", "stock count"] as const;

/** Stock quantities are decimals (kg, litres), so tidy float noise like 0.30000000000000004. */
export const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Stock is never stored as a single number. It is the sum of an append-only
 * list of movements, so every change is auditable and merges cleanly later.
 * Each movement also records what it was worth, so waste and shrinkage can be
 * reported in money.
 */
export class InventoryService {
  constructor(private readonly db: Db) {}

  stockOf(productId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(qty_delta), 0) AS qty FROM stock_movements WHERE product_id = ?",
      )
      .get(productId) as { qty: number };
    return tidy(row.qty);
  }

  /** Current stock for every product that has at least one movement. */
  stockLevels(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT product_id AS id, SUM(qty_delta) AS qty FROM stock_movements GROUP BY product_id",
      )
      .all() as { id: string; qty: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = tidy(r.qty);
    return out;
  }

  /**
   * Add (positive) or remove (negative) stock with a reason such as "purchase" or "waste".
   * Removed stock is valued at the item's average cost. Added stock is valued at
   * `valueMinor` if given, otherwise at the average cost.
   */
  adjust(
    productId: string,
    qtyDelta: number,
    reason: string,
    ref?: { type: string; id: string },
    valueMinor?: number,
  ): void {
    if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
      throw new Error("Stock adjustment must be a non-zero number");
    }
    if (!reason.trim()) throw new Error("A reason is required");
    const product = this.db
      .prepare("SELECT avg_cost AS avgCost FROM products WHERE id = ?")
      .get(productId) as { avgCost: number } | undefined;
    if (!product) throw new Error("Product not found");

    const value =
      qtyDelta < 0
        ? -Math.round(-qtyDelta * product.avgCost)
        : valueMinor ?? Math.round(qtyDelta * product.avgCost);

    this.db
      .prepare(
        `INSERT INTO stock_movements
           (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        productId,
        qtyDelta,
        reason.trim(),
        ref?.type ?? null,
        ref?.id ?? null,
        new Date().toISOString(),
        value,
      );
  }

  /** Tracked, active items at or below their reorder level. */
  lowStock(): LowStockItem[] {
    const rows = this.db
      .prepare(
        `SELECT p.id AS productId, p.name AS name, p.unit AS unit, p.reorder_level AS reorderLevel,
                COALESCE(SUM(m.qty_delta), 0) AS stock
           FROM products p
           LEFT JOIN stock_movements m ON m.product_id = p.id
          WHERE p.active = 1 AND p.track_stock = 1 AND p.is_system = 0
          GROUP BY p.id
         HAVING stock <= p.reorder_level
          ORDER BY stock ASC, p.name`,
      )
      .all() as LowStockItem[];
    return rows.map((r) => ({ ...r, stock: tidy(r.stock) }));
  }

  /** What the stock on the shelf is worth right now, at average cost. */
  stockValue(): number {
    const rows = this.db
      .prepare(
        `SELECT p.avg_cost AS cost, COALESCE(SUM(m.qty_delta), 0) AS qty
           FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
          WHERE p.track_stock = 1 GROUP BY p.id`,
      )
      .all() as { cost: number; qty: number }[];
    return Math.round(rows.reduce((s, r) => s + Math.max(0, r.qty) * r.cost, 0));
  }
}
