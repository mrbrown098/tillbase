import type { Db } from "./db.js";
import { assertDate, dayEndISO, dayStartISO, daysInclusive, eachDate, localDate } from "./dates.js";
import { ExpenseService } from "./expenses.js";
import { InventoryService, lossReasons } from "./inventory.js";
import { LabourService } from "./labour.js";
import { PurchaseService } from "./purchases.js";

export interface BreakdownLine {
  key: "cogs" | "wastage" | "labour" | "expenses" | "profit";
  label: string;
  amountMinor: number;
  /** Share of net sales, 0 to 100 (can be negative for a loss). Null when there were no sales. */
  pctOfSales: number | null;
}

export interface DailyPoint {
  date: string;
  orders: number;
  salesMinor: number;
  cogsMinor: number;
  grossProfitMinor: number;
}

export interface ItemProfit {
  productId: string;
  name: string;
  qty: number;
  salesMinor: number;
  cogsMinor: number;
  profitMinor: number;
  marginPct: number | null;
  /** Sold, but no cost is known, so its profit looks better than it is. */
  costMissing: boolean;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  days: number;

  salesCount: number;
  voidCount: number;
  /** Sales before tax and after discounts. This is the revenue figure. */
  netSalesMinor: number;
  discountsMinor: number;
  /** Sales tax collected for the government. Not income. */
  taxCollectedMinor: number;
  averageOrderMinor: number;

  cogsMinor: number;
  grossProfitMinor: number;
  grossMarginPct: number | null;

  wastageMinor: number;
  wastageByReason: { reason: string; costMinor: number }[];

  expensesMinor: number;
  expensesByCategory: { name: string; totalMinor: number }[];

  labourMinor: number;
  labourActualMinor: number;
  labourEstimatedMinor: number;

  netProfitMinor: number;
  netMarginPct: number | null;

  /** Where each rupee (or dollar) of sales went. Adds up to the whole of net sales. */
  breakdown: BreakdownLine[];
  /** Sales needed in this period to cover all costs at the current gross margin. */
  breakEvenSalesMinor: number | null;

  daily: DailyPoint[];
  /** Per menu item, best profit first. */
  items: ItemProfit[];
  /** Sales by hour of the day (0 to 23), for staffing and prep. */
  hourly: { hour: number; orders: number; salesMinor: number }[];

  /** Where the business stands right now (not limited to the period). */
  position: {
    stockValueMinor: number;
    owedToSuppliersMinor: number;
    advancesOutstandingMinor: number;
  };

  /** Reasons this profit figure may be off. */
  warnings: string[];
}

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

/** Answers "are we making money, and where is it going?" */
export class FinanceService {
  private readonly expenses: ExpenseService;
  private readonly labour: LabourService;
  private readonly inventory: InventoryService;
  private readonly purchases: PurchaseService;

  constructor(private readonly db: Db) {
    this.expenses = new ExpenseService(db);
    this.labour = new LabourService(db);
    this.inventory = new InventoryService(db);
    this.purchases = new PurchaseService(db);
  }

  /** Profit and loss for whole local days, `from` to `to` inclusive. */
  profitAndLoss(from: string, to: string): ProfitAndLoss {
    assertDate("From", from);
    assertDate("To", to);
    if (to < from) throw new Error("The end date cannot be before the start date");
    const startIso = dayStartISO(from);
    const endIso = dayEndISO(to);

    // ---- Sales and the cost of what was sold -------------------------------
    const sales = this.db
      .prepare(
        `SELECT s.created_at AS at, s.subtotal_minor AS sub, s.discount_minor AS disc, s.tax_minor AS tax,
                COALESCE((SELECT SUM(cogs_minor) FROM sale_items WHERE sale_id = s.id), 0) AS cogs
           FROM sales s WHERE s.status = 'completed' AND s.created_at >= ? AND s.created_at < ?`,
      )
      .all(startIso, endIso) as { at: string; sub: number; disc: number; tax: number; cogs: number }[];
    const voidCount = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM sales WHERE status = 'void' AND created_at >= ? AND created_at < ?")
        .get(startIso, endIso) as { n: number }
    ).n;

    const dayMap = new Map<string, DailyPoint>();
    for (const d of eachDate(from, to)) {
      dayMap.set(d, { date: d, orders: 0, salesMinor: 0, cogsMinor: 0, grossProfitMinor: 0 });
    }
    const hourMap = new Map<number, { orders: number; salesMinor: number }>();
    let netSales = 0;
    let discounts = 0;
    let tax = 0;
    let cogs = 0;
    for (const s of sales) {
      const net = s.sub - s.disc;
      netSales += net;
      discounts += s.disc;
      tax += s.tax;
      cogs += s.cogs;
      const day = dayMap.get(localDate(s.at));
      if (day) {
        day.orders += 1;
        day.salesMinor += net;
        day.cogsMinor += s.cogs;
        day.grossProfitMinor += net - s.cogs;
      }
      const hour = new Date(s.at).getHours();
      const h = hourMap.get(hour) ?? { orders: 0, salesMinor: 0 };
      h.orders += 1;
      h.salesMinor += net;
      hourMap.set(hour, h);
    }
    const grossProfit = netSales - cogs;

    // ---- Items --------------------------------------------------------------
    const itemRows = this.db
      .prepare(
        `SELECT si.product_id AS productId, si.name AS name, SUM(si.qty) AS qty,
                SUM(si.total_minor - si.tax_minor) AS sales, SUM(si.cogs_minor) AS cogs,
                p.is_system AS isSystem
           FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
          WHERE s.status = 'completed' AND s.created_at >= ? AND s.created_at < ?
          GROUP BY si.product_id`,
      )
      .all(startIso, endIso) as { productId: string; name: string; qty: number; sales: number; cogs: number; isSystem: number }[];
    const items: ItemProfit[] = itemRows
      .map((r) => ({
        productId: r.productId,
        name: r.name,
        qty: Math.round(r.qty * 1000) / 1000,
        salesMinor: r.sales,
        cogsMinor: r.cogs,
        profitMinor: r.sales - r.cogs,
        marginPct: pct(r.sales - r.cogs, r.sales),
        // The delivery fee is income with no goods behind it, so it never needs a cost.
        costMissing: r.cogs === 0 && r.sales > 0 && r.isSystem === 0,
      }))
      .sort((a, b) => b.profitMinor - a.profitMinor);

    // ---- Wastage and other losses -------------------------------------------
    const placeholders = lossReasons.map(() => "?").join(",");
    const wasteRows = this.db
      .prepare(
        `SELECT reason, -SUM(value_minor) AS cost FROM stock_movements
          WHERE reason IN (${placeholders}) AND created_at >= ? AND created_at < ?
          GROUP BY reason HAVING cost <> 0 ORDER BY cost DESC`,
      )
      .all(...lossReasons, startIso, endIso) as { reason: string; cost: number }[];
    const wastage = wasteRows.reduce((s, r) => s + r.cost, 0);

    // ---- Running costs and wages --------------------------------------------
    const expenseRows = this.expenses.totalsByCategory(from, to);
    const expensesTotal = expenseRows.reduce((s, r) => s + r.totalMinor, 0);
    const labour = this.labour.costBetween(from, to);
    const labourTotal = labour.actualMinor + labour.estimatedMinor;

    const netProfit = grossProfit - wastage - expensesTotal - labourTotal;

    const breakdown: BreakdownLine[] = [
      { key: "cogs", label: "Ingredients and goods sold", amountMinor: cogs, pctOfSales: pct(cogs, netSales) },
      { key: "wastage", label: "Wastage and losses", amountMinor: wastage, pctOfSales: pct(wastage, netSales) },
      { key: "labour", label: "Wages", amountMinor: labourTotal, pctOfSales: pct(labourTotal, netSales) },
      { key: "expenses", label: "Running costs", amountMinor: expensesTotal, pctOfSales: pct(expensesTotal, netSales) },
      { key: "profit", label: netProfit >= 0 ? "Profit" : "Loss", amountMinor: netProfit, pctOfSales: pct(netProfit, netSales) },
    ];

    const margin = netSales > 0 ? grossProfit / netSales : 0;
    const overheads = wastage + expensesTotal + labourTotal;
    const breakEven = margin > 0 ? Math.round(overheads / margin) : null;

    // ---- Honesty about the data ---------------------------------------------
    const warnings: string[] = [];
    const missing = items.filter((i) => i.costMissing);
    if (missing.length > 0) {
      const names = missing.slice(0, 3).map((i) => i.name).join(", ");
      warnings.push(
        `${missing.length} item${missing.length > 1 ? "s" : ""} sold ${missing.length > 1 ? "have" : "has"} no cost set (${names}${missing.length > 3 ? ", ..." : ""}), so profit is overstated. Add a recipe or a cost.`,
      );
    }
    if (labour.estimatedMinor > 0) {
      warnings.push("Some wages are estimated from attendance and salaries because payroll has not been run for those days yet.");
    }
    if (netSales > 0 && expensesTotal === 0) {
      warnings.push("No running costs (rent, electricity, gas...) are recorded for this period, so profit is overstated.");
    }
    if (netSales > 0 && labourTotal === 0) {
      warnings.push("No wages are recorded for this period, so profit is overstated.");
    }

    return {
      from,
      to,
      days: daysInclusive(from, to),
      salesCount: sales.length,
      voidCount,
      netSalesMinor: netSales,
      discountsMinor: discounts,
      taxCollectedMinor: tax,
      averageOrderMinor: sales.length ? Math.round(netSales / sales.length) : 0,
      cogsMinor: cogs,
      grossProfitMinor: grossProfit,
      grossMarginPct: pct(grossProfit, netSales),
      wastageMinor: wastage,
      wastageByReason: wasteRows.map((r) => ({ reason: r.reason, costMinor: r.cost })),
      expensesMinor: expensesTotal,
      expensesByCategory: expenseRows.map((r) => ({ name: r.name, totalMinor: r.totalMinor })),
      labourMinor: labourTotal,
      labourActualMinor: labour.actualMinor,
      labourEstimatedMinor: labour.estimatedMinor,
      netProfitMinor: netProfit,
      netMarginPct: pct(netProfit, netSales),
      breakdown,
      breakEvenSalesMinor: breakEven,
      daily: [...dayMap.values()],
      items,
      hourly: [...hourMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([hour, v]) => ({ hour, ...v })),
      position: {
        stockValueMinor: this.inventory.stockValue(),
        owedToSuppliersMinor: this.purchases.payables().totalMinor,
        advancesOutstandingMinor: this.labour.totalOutstandingAdvances(),
      },
      warnings,
    };
  }
}
