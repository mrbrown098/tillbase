import type { Db } from "./db.js";
import { assertDate, dayEndISO, dayStartISO } from "./dates.js";
import { FinanceService } from "./finance.js";
import { ShiftService } from "./shifts.js";

type Methods = { cash: number; card: number; bank_transfer: number; other: number };

export interface DayCloseShift {
  shiftId: string;
  userName: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  openingCashMinor: number;
  cashSalesMinor: number;
  cashInMinor: number;
  cashOutMinor: number;
  refundCashOutMinor: number;
  expectedCashMinor: number;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  note: string | null;
}

export interface DayCloseReport {
  date: string;
  from: string;
  to: string;
  generatedAt: string;
  salesCount: number;
  grossSalesMinor: number;
  discountsMinor: number;
  taxMinor: number;
  billedMinor: number;
  voidCount: number;
  voidedMinor: number;
  /** Sales from an earlier day that were voided during this one. They are taken off this day, not the day they were rung. */
  earlierSaleVoids: { count: number; amountMinor: number };
  refundCount: number;
  refundedMinor: number;
  /** Billed, less refunds made today, less earlier-day sales voided today. */
  netTakingsMinor: number;
  receivedByMethod: Methods;
  onAccountMinor: number;
  refundsByMethod: Methods;
  shifts: DayCloseShift[];
  cash: {
    openingMinor: number;
    salesMinor: number;
    inMinor: number;
    outMinor: number;
    expectedMinor: number;
    countedMinor: number | null;
    varianceMinor: number | null;
  };
  profit: { cogsMinor: number; grossProfitMinor: number; costMissing: boolean } | null;
  warnings: string[];
}

const zero = (): Methods => ({ cash: 0, card: 0, bank_transfer: 0, other: 0 });
const bucket = (m: string): keyof Methods => (m === "cash" || m === "card" || m === "bank_transfer" ? m : "other");

/**
 * The end-of-day figures for one business day, all computed here so a screen only lays them out.
 *
 * Rules (see docs/DEVELOPMENT.md): a sale belongs to the day it was rung; a sale voided later is taken off
 * the day it was voided (`earlierSaleVoids`), never off the old day; a refund belongs to the day it was made;
 * a shift belongs to the day it was opened. Money is whole minor units throughout.
 */
export class DayCloseService {
  private readonly shifts: ShiftService;
  private readonly finance: FinanceService;

  constructor(private readonly db: Db) {
    this.shifts = new ShiftService(db);
    this.finance = new FinanceService(db);
  }

  report(date: string, opts: { includeProfit?: boolean } = {}): DayCloseReport {
    assertDate("Date", date);
    const from = dayStartISO(date);
    const to = dayEndISO(date);
    const q = <T>(sql: string, ...args: unknown[]) => this.db.prepare(sql).all(...args) as T[];

    // Sales rung in the day and still standing when the day ended.
    const standing = `s.created_at >= ? AND s.created_at < ? AND (s.status = 'completed' OR (s.status = 'void' AND s.voided_at >= ?))`;
    const totals = q<{ n: number; sub: number; disc: number; tax: number; total: number; acct: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(s.subtotal_minor),0) AS sub, COALESCE(SUM(s.discount_minor),0) AS disc,
              COALESCE(SUM(s.tax_minor),0) AS tax, COALESCE(SUM(s.total_minor),0) AS total,
              COALESCE(SUM(s.on_account_minor),0) AS acct
         FROM sales s WHERE ${standing}`,
      from, to, to,
    )[0]!;

    const received = zero();
    for (const r of q<{ method: string; amount: number }>(
      `SELECT p.method AS method, SUM(p.amount_minor) AS amount FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE ${standing} GROUP BY p.method`,
      from, to, to,
    )) received[bucket(r.method)] += r.amount;
    const change = q<{ c: number }>(`SELECT COALESCE(SUM(s.change_minor),0) AS c FROM sales s WHERE ${standing}`, from, to, to)[0]!.c;
    received.cash -= change;

    // Sales voided in the day itself (rung and voided before the day ended) are not billed at all.
    const sameDay = q<{ n: number; total: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_minor),0) AS total FROM sales
        WHERE status = 'void' AND created_at >= ? AND created_at < ? AND voided_at < ?`,
      from, to, to,
    )[0]!;

    // Sales rung on an earlier day and voided during this one: money goes back today.
    const earlier = q<{ n: number; total: number; acct: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_minor),0) AS total, COALESCE(SUM(on_account_minor),0) AS acct FROM sales
        WHERE status = 'void' AND created_at < ? AND voided_at >= ? AND voided_at < ?`,
      from, from, to,
    )[0]!;
    for (const r of q<{ method: string; amount: number }>(
      `SELECT p.method AS method, SUM(p.amount_minor) AS amount FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.status = 'void' AND s.created_at < ? AND s.voided_at >= ? AND s.voided_at < ? GROUP BY p.method`,
      from, from, to,
    )) received[bucket(r.method)] -= r.amount;
    received.cash += q<{ c: number }>(
      `SELECT COALESCE(SUM(change_minor),0) AS c FROM sales WHERE status = 'void' AND created_at < ? AND voided_at >= ? AND voided_at < ?`,
      from, from, to,
    )[0]!.c;

    const refundsByMethod = zero();
    let refundCount = 0;
    let refundedMinor = 0;
    for (const r of q<{ method: string; n: number; amount: number }>(
      `SELECT method, COUNT(*) AS n, SUM(amount_minor) AS amount FROM refunds WHERE created_at >= ? AND created_at < ? GROUP BY method`,
      from, to,
    )) {
      refundsByMethod[bucket(r.method)] += r.amount;
      refundCount += r.n;
      refundedMinor += r.amount;
    }
    for (const k of Object.keys(refundsByMethod) as (keyof Methods)[]) received[k] -= refundsByMethod[k];

    // Shifts opened in the day. A closed shift's figures are frozen by ShiftService.
    const shiftRows = q<{ id: string }>(`SELECT id FROM shifts WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at, rowid`, from, to);
    const shifts: DayCloseShift[] = shiftRows.map(({ id }) => {
      const s = this.shifts.summary(id);
      return {
        shiftId: id,
        userName: s.shift.userName,
        status: s.shift.status,
        openedAt: s.shift.openedAt,
        closedAt: s.shift.closedAt,
        openingCashMinor: s.shift.openingCashMinor,
        cashSalesMinor: s.cashSalesMinor,
        cashInMinor: s.cashInMinor,
        cashOutMinor: s.cashOutMinor,
        refundCashOutMinor: s.refundCashOutMinor,
        expectedCashMinor: s.shift.status === "closed" ? (s.shift.expectedCashMinor as number) : s.expectedCashMinor,
        countedCashMinor: s.shift.countedCashMinor,
        varianceMinor: s.shift.varianceMinor,
        note: s.shift.note,
      };
    });
    const anyOpen = shifts.some((s) => s.status === "open");
    const sum = (f: (s: DayCloseShift) => number) => shifts.reduce((a, s) => a + f(s), 0);
    const expected = sum((s) => s.expectedCashMinor);
    const counted = shifts.length > 0 && !anyOpen ? sum((s) => s.countedCashMinor as number) : null;

    const billed = totals.total;
    const net = billed - refundedMinor - earlier.total;

    const warnings: string[] = [];
    if (shifts.length === 0) warnings.push("No shift was opened on this day, so there is no cash count to check.");
    for (const s of shifts) if (s.status === "open") warnings.push(`${s.userName}'s shift is still open. Close it before closing the day.`);
    const strayOpen = this.shifts.current();
    if (strayOpen && !shifts.some((s) => s.shiftId === strayOpen.id) && strayOpen.openedAt < to) {
      warnings.push(`${strayOpen.userName}'s shift from an earlier day is still open.`);
    }
    for (const s of shifts) {
      if (s.varianceMinor !== null && s.varianceMinor !== 0) {
        warnings.push(`${s.userName}'s drawer was ${s.varianceMinor < 0 ? "short" : "over"} when the shift closed.`);
      }
    }
    if (earlier.n > 0) warnings.push(`${saleWord(earlier.n)} from an earlier day ${earlier.n === 1 ? "was" : "were"} voided today and ${earlier.n === 1 ? "is" : "are"} taken off today, not the day ${earlier.n === 1 ? "it was" : "they were"} rung.`);

    let profit: DayCloseReport["profit"] = null;
    if (opts.includeProfit) {
      const pl = this.finance.profitAndLoss(date, date);
      const costMissing = pl.items.some((i) => i.costMissing);
      profit = { cogsMinor: pl.cogsMinor, grossProfitMinor: pl.grossProfitMinor, costMissing };
      if (costMissing) warnings.push("Some items sold today have no cost recorded, so profit is overstated.");
    }

    return {
      date,
      from,
      to,
      generatedAt: new Date().toISOString(),
      salesCount: totals.n,
      grossSalesMinor: totals.sub,
      discountsMinor: totals.disc,
      taxMinor: totals.tax,
      billedMinor: billed,
      voidCount: sameDay.n,
      voidedMinor: sameDay.total,
      earlierSaleVoids: { count: earlier.n, amountMinor: earlier.total },
      refundCount,
      refundedMinor,
      netTakingsMinor: net,
      receivedByMethod: received,
      onAccountMinor: totals.acct - earlier.acct,
      refundsByMethod,
      shifts,
      cash: {
        openingMinor: sum((s) => s.openingCashMinor),
        salesMinor: sum((s) => s.cashSalesMinor),
        inMinor: sum((s) => s.cashInMinor),
        outMinor: sum((s) => s.cashOutMinor),
        expectedMinor: expected,
        countedMinor: counted,
        varianceMinor: counted === null ? null : counted - expected,
      },
      profit,
      warnings,
    };
  }
}

function saleWord(n: number): string {
  return n === 1 ? "1 sale" : `${n} sales`;
}
