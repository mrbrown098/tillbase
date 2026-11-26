import type { Db } from "./db.js";

export interface SalesSummary {
  salesCount: number;
  voidCount: number;
  /** Refunds made in this period (by the date of the refund) and what they handed back, tax included. `totalMinor` is not reduced. */
  refundCount: number;
  refundedMinor: number;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  byMethod: Record<string, number>;
  topProducts: { name: string; qty: number; totalMinor: number }[];
}

export class ReportService {
  constructor(private readonly db: Db) {}

  /**
   * Summary of completed sales created in [from, to). Both are ISO date-time
   * strings, so the caller decides what "a day" means in the shop's timezone.
   */
  salesSummary(from: string, to: string, topN = 5): SalesSummary {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(subtotal_minor), 0) AS subtotal,
                COALESCE(SUM(discount_minor), 0) AS discount,
                COALESCE(SUM(tax_minor), 0) AS tax,
                COALESCE(SUM(total_minor), 0) AS total
           FROM sales
          WHERE status = 'completed' AND created_at >= ? AND created_at < ?`,
      )
      .get(from, to) as {
      n: number;
      subtotal: number;
      discount: number;
      tax: number;
      total: number;
    };

    const voidCount = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sales WHERE status = 'void' AND created_at >= ? AND created_at < ?",
        )
        .get(from, to) as { n: number }
    ).n;

    const refunds = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total FROM refunds WHERE created_at >= ? AND created_at < ?")
      .get(from, to) as { n: number; total: number };

    // Payments include cash handed over; subtract change from cash so each
    // method reflects money actually kept.
    const methodRows = this.db
      .prepare(
        `SELECT p.method AS method, SUM(p.amount_minor) AS amount
           FROM payments p JOIN sales s ON s.id = p.sale_id
          WHERE s.status = 'completed' AND s.created_at >= ? AND s.created_at < ?
          GROUP BY p.method`,
      )
      .all(from, to) as { method: string; amount: number }[];
    const byMethod: Record<string, number> = {};
    for (const r of methodRows) byMethod[r.method] = r.amount;
    const change = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(change_minor), 0) AS c FROM sales
            WHERE status = 'completed' AND created_at >= ? AND created_at < ?`,
        )
        .get(from, to) as { c: number }
    ).c;
    if (change > 0) byMethod.cash = (byMethod.cash ?? 0) - change;

    const topProducts = this.db
      .prepare(
        `SELECT si.name AS name, SUM(si.qty) AS qty, SUM(si.total_minor) AS totalMinor
           FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
          WHERE s.status = 'completed' AND s.created_at >= ? AND s.created_at < ?
            AND p.is_system = 0
          GROUP BY si.product_id
          ORDER BY totalMinor DESC LIMIT ?`,
      )
      .all(from, to, topN) as { name: string; qty: number; totalMinor: number }[];

    return {
      salesCount: totals.n,
      voidCount,
      refundCount: refunds.n,
      refundedMinor: refunds.total,
      subtotalMinor: totals.subtotal,
      discountMinor: totals.discount,
      taxMinor: totals.tax,
      totalMinor: totals.total,
      byMethod,
      topProducts,
    };
  }
}
