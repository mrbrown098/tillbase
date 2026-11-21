import type { Db } from "./db.js";
import { formatCsv, type CsvCell } from "./csv.js";
import { assertDate, dayEndISO, dayStartISO, eachDate, localDate } from "./dates.js";
import { ExpenseService } from "./expenses.js";
import { FinanceService } from "./finance.js";
import { LabourService } from "./labour.js";

/** One spreadsheet file: a name to save it under and its text (UTF-8 with a byte-order mark, so Excel opens it correctly). */
export interface AccountingFile {
  /** Which report this is. */
  kind: "sales-by-day" | "expenses-by-category" | "purchases" | "payroll" | "profit-and-loss";
  name: string;
  csv: string;
}

/**
 * Money as plain decimal text: `12345` becomes `123.45`, with no currency symbol and no thousands
 * separator, so a spreadsheet reads it as a number. Done with integers, never floating point.
 */
export function decimal(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const hours = (minutes: number) => (minutes / 60).toFixed(2);

/** What the accountant needs, as CSV files for a range of whole local days (`from` to `to` inclusive). */
export class AccountingExportService {
  private readonly expenses: ExpenseService;
  private readonly labour: LabourService;
  private readonly finance: FinanceService;

  constructor(private readonly db: Db) {
    this.expenses = new ExpenseService(db);
    this.labour = new LabourService(db);
    this.finance = new FinanceService(db);
  }

  /** All five files. */
  all(from: string, to: string): AccountingFile[] {
    this.check(from, to);
    return [
      this.salesByDay(from, to),
      this.expensesByCategory(from, to),
      this.purchases(from, to),
      this.payroll(from, to),
      this.profitAndLoss(from, to),
    ];
  }

  private check(from: string, to: string): void {
    assertDate("From", from);
    assertDate("To", to);
    if (to < from) throw new Error("The end date cannot be before the start date");
  }

  private file(kind: AccountingFile["kind"], from: string, to: string, rows: CsvCell[][]): AccountingFile {
    return {
      kind,
      name: `tillbase-${kind}-${from}-to-${to}.csv`,
      // Text typed by staff (supplier names, notes) is escaped so a spreadsheet never runs it as a formula.
      csv: formatCsv(rows, { bom: true, escapeFormulas: true }),
    };
  }

  /**
   * One row per day, including days with no sales, then a Total row. Cancelled (void) sales are left
   * out. Net sales is the revenue figure: before tax and after discounts.
   */
  salesByDay(from: string, to: string): AccountingFile {
    this.check(from, to);
    const sales = this.db
      .prepare(
        `SELECT created_at AS at, subtotal_minor AS sub, discount_minor AS disc, tax_minor AS tax, total_minor AS total
           FROM sales WHERE status = 'completed' AND created_at >= ? AND created_at < ?`,
      )
      .all(dayStartISO(from), dayEndISO(to)) as { at: string; sub: number; disc: number; tax: number; total: number }[];
    const days = new Map<string, { orders: number; sub: number; disc: number; tax: number; total: number }>();
    for (const d of eachDate(from, to)) days.set(d, { orders: 0, sub: 0, disc: 0, tax: 0, total: 0 });
    for (const s of sales) {
      const d = days.get(localDate(s.at));
      if (!d) continue;
      d.orders += 1;
      d.sub += s.sub;
      d.disc += s.disc;
      d.tax += s.tax;
      d.total += s.total;
    }
    const total = { orders: 0, sub: 0, disc: 0, tax: 0, total: 0 };
    const rows: CsvCell[][] = [["Date", "Orders", "Sales before discounts", "Discounts", "Net sales (before tax)", "Tax collected", "Total received"]];
    for (const [date, d] of days) {
      rows.push([date, d.orders, decimal(d.sub), decimal(d.disc), decimal(d.sub - d.disc), decimal(d.tax), decimal(d.total)]);
      total.orders += d.orders;
      total.sub += d.sub;
      total.disc += d.disc;
      total.tax += d.tax;
      total.total += d.total;
    }
    rows.push(["Total", total.orders, decimal(total.sub), decimal(total.disc), decimal(total.sub - total.disc), decimal(total.tax), decimal(total.total)]);
    return this.file("sales-by-day", from, to, rows);
  }

  /** Running costs per category by the date they were spent, biggest first, then a Total row. Cancelled entries are left out. */
  expensesByCategory(from: string, to: string): AccountingFile {
    this.check(from, to);
    const byCategory = new Map<string, { entries: number; total: number }>();
    for (const e of this.expenses.list(from, to)) {
      if (e.voided) continue;
      const c = byCategory.get(e.category) ?? { entries: 0, total: 0 };
      c.entries += 1;
      c.total += e.amountMinor;
      byCategory.set(e.category, c);
    }
    const sorted = [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
    const rows: CsvCell[][] = [["Category", "Entries", "Amount"]];
    let entries = 0;
    let total = 0;
    for (const [name, c] of sorted) {
      rows.push([name, c.entries, decimal(c.total)]);
      entries += c.entries;
      total += c.total;
    }
    rows.push(["Total", entries, decimal(total)]);
    return this.file("expenses-by-category", from, to, rows);
  }

  /**
   * Stock and ingredient purchases, one row per purchase by the day it was recorded, then a Total row.
   * "Outstanding" is what was still owed to the supplier when the file was made.
   */
  purchases(from: string, to: string): AccountingFile {
    this.check(from, to);
    const list = this.db
      .prepare(
        `SELECT p.created_at AS at, p.supplier, p.reference, p.note, p.total_minor AS total, p.paid_minor AS paid,
                (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = p.id) AS lines
           FROM purchases p WHERE p.created_at >= ? AND p.created_at < ?
          ORDER BY p.created_at, p.rowid`,
      )
      .all(dayStartISO(from), dayEndISO(to)) as {
      at: string;
      supplier: string | null;
      reference: string | null;
      note: string | null;
      total: number;
      paid: number;
      lines: number;
    }[];
    const rows: CsvCell[][] = [["Date", "Supplier", "Reference", "Note", "Items", "Total", "Paid", "Outstanding"]];
    let lines = 0;
    let total = 0;
    let paid = 0;
    for (const p of list) {
      rows.push([localDate(p.at), p.supplier ?? "", p.reference ?? "", p.note ?? "", p.lines, decimal(p.total), decimal(p.paid), decimal(p.total - p.paid)]);
      lines += p.lines;
      total += p.total;
      paid += p.paid;
    }
    rows.push(["Total", "", "", "", lines, decimal(total), decimal(paid), decimal(total - paid)]);
    return this.file("purchases", from, to, rows);
  }

  /**
   * Payslips whose pay period ends in the range, oldest first, then a Total row. Only payroll that has
   * been run appears here; wages not yet through payroll are estimated in the profit and loss file.
   */
  payroll(from: string, to: string): AccountingFile {
    this.check(from, to);
    const slips = this.labour
      .payslips({ from, to })
      .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.employeeName.localeCompare(b.employeeName));
    const rows: CsvCell[][] = [
      ["Employee", "Period start", "Period end", "Days", "Hours", "Basic pay", "Overtime", "Bonus", "Deductions", "Advances taken back", "Net pay", "Cost to business", "Paid", "Paid on", "How paid"],
    ];
    const t = { minutes: 0, days: 0, base: 0, ot: 0, bonus: 0, ded: 0, adv: 0, net: 0, cost: 0, paid: 0 };
    for (const s of slips) {
      rows.push([
        s.employeeName, s.periodStart, s.periodEnd, s.days, hours(s.minutes), decimal(s.baseMinor), decimal(s.overtimeMinor),
        decimal(s.bonusMinor), decimal(s.deductionsMinor), decimal(s.advancesMinor), decimal(s.netMinor), decimal(s.costMinor),
        decimal(s.paidMinor), s.paidAt ? localDate(s.paidAt) : "", s.method ?? "",
      ]);
      t.minutes += s.minutes;
      t.days += s.days;
      t.base += s.baseMinor;
      t.ot += s.overtimeMinor;
      t.bonus += s.bonusMinor;
      t.ded += s.deductionsMinor;
      t.adv += s.advancesMinor;
      t.net += s.netMinor;
      t.cost += s.costMinor;
      t.paid += s.paidMinor;
    }
    rows.push(["Total", "", "", t.days, hours(t.minutes), decimal(t.base), decimal(t.ot), decimal(t.bonus), decimal(t.ded), decimal(t.adv), decimal(t.net), decimal(t.cost), decimal(t.paid), "", ""]);
    return this.file("payroll", from, to, rows);
  }

  /**
   * The same profit and loss the Money screen shows, as lines an accountant can follow. Tax collected is
   * shown as a memo line because it belongs to the government, not to the shop.
   */
  profitAndLoss(from: string, to: string): AccountingFile {
    this.check(from, to);
    const pl = this.finance.profitAndLoss(from, to);
    const rows: CsvCell[][] = [["Section", "Line", "Amount"]];
    rows.push(["Income", "Net sales (before tax, after discounts)", decimal(pl.netSalesMinor)]);
    rows.push(["Cost of sales", "Ingredients and goods sold", decimal(pl.cogsMinor)]);
    rows.push(["", "Gross profit", decimal(pl.grossProfitMinor)]);
    rows.push(["Expenses", "Wastage and losses", decimal(pl.wastageMinor)]);
    for (const c of pl.expensesByCategory) rows.push(["Expenses", c.name, decimal(c.totalMinor)]);
    rows.push(["Expenses", "Wages (payroll run plus estimate for days not yet run)", decimal(pl.labourMinor)]);
    rows.push(["", pl.netProfitMinor >= 0 ? "Net profit" : "Net loss", decimal(pl.netProfitMinor)]);
    rows.push(["Memo", "Sales tax collected (owed to the government, not income)", decimal(pl.taxCollectedMinor)]);
    rows.push(["Memo", "Discounts given", decimal(pl.discountsMinor)]);
    rows.push(["Memo", "Wages estimated, not yet through payroll", decimal(pl.labourEstimatedMinor)]);
    for (const w of pl.warnings) rows.push(["Note", w, ""]);
    return this.file("profit-and-loss", from, to, rows);
  }
}
