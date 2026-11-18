import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export interface LowStockItem {
  productId: string;
  name: string;
  stock: number;
  reorderLevel: number;
}

/**
 * Stock is never stored as a single number. It is the sum of an append-only
 * list of movements, so every change is auditable and merges cleanly later.
 */
export class InventoryService {
  constructor(private readonly db: Db) {}

  stockOf(productId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(qty_delta), 0) AS qty FROM stock_movements WHERE product_id = ?",
      )
      .get(productId) as { qty: number };
    return row.qty;
  }

  /** Current stock for every product that has at least one movement. */
  stockLevels(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT product_id AS id, SUM(qty_delta) AS qty FROM stock_movements GROUP BY product_id",
      )
      .all() as { id: string; qty: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = r.qty;
    return out;
  }

  /** Add (positive) or remove (negative) stock with a reason such as "purchase" or "damage". */
  adjust(
    productId: string,
    qtyDelta: number,
    reason: string,
    ref?: { type: string; id: string },
  ): void {
    if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
      throw new Error("Stock adjustment must be a non-zero number");
    }
    if (!reason.trim()) throw new Error("A reason is required");
    this.db
      .prepare(
        `INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        productId,
        qtyDelta,
        reason.trim(),
        ref?.type ?? null,
        ref?.id ?? null,
        new Date().toISOString(),
      );
  }

  /** Tracked, active products at or below their reorder level. */
  lowStock(): LowStockItem[] {
    const rows = this.db
      .prepare(
        `SELECT p.id AS productId, p.name AS name, p.reorder_level AS reorderLevel,
                COALESCE(SUM(m.qty_delta), 0) AS stock
           FROM products p
           LEFT JOIN stock_movements m ON m.product_id = p.id
          WHERE p.active = 1 AND p.track_stock = 1
          GROUP BY p.id
         HAVING stock <= p.reorder_level
          ORDER BY stock ASC, p.name`,
      )
      .all() as LowStockItem[];
    return rows;
  }
}
