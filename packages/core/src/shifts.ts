import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export interface Shift {
  id: string;
  userId: string;
  userName: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  openingCashMinor: number;
  countedCashMinor: number | null;
  expectedCashMinor: number | null;
  /** counted minus expected. Negative means the drawer is short. */
  varianceMinor: number | null;
  note: string | null;
}

export interface ShiftSummary {
  shift: Shift;
  salesCount: number;
  salesTotalMinor: number;
  byMethod: Record<string, number>;
  /** Cash that stayed in the drawer from sales (cash paid minus change given). */
  cashSalesMinor: number;
  cashInMinor: number;
  cashOutMinor: number;
  /** Part of `cashOutMinor` that was handed back to customers for refunds and voided sales. */
  refundCashOutMinor: number;
  /** Opening float + cash sales + cash in - cash out. */
  expectedCashMinor: number;
  movements: { id: string; amountMinor: number; reason: string; createdAt: string }[];
}

interface Row {
  id: string;
  user_id: string;
  user_name: string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  opening_cash_minor: number;
  counted_cash_minor: number | null;
  expected_cash_minor: number | null;
  variance_minor: number | null;
  note: string | null;
}

const SELECT = `SELECT s.*, u.name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id`;

function toShift(r: Row): Shift {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    status: r.status,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    openingCashMinor: r.opening_cash_minor,
    countedCashMinor: r.counted_cash_minor,
    expectedCashMinor: r.expected_cash_minor,
    varianceMinor: r.variance_minor,
    note: r.note,
  };
}

function assertMoney(label: string, v: number, allowZero = true): void {
  if (!Number.isInteger(v) || v < 0 || (!allowZero && v === 0)) {
    throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} whole amount`);
  }
}

/** A cashier's shift: starting float, cash in and out, and a counted close. */
export class ShiftService {
  constructor(private readonly db: Db) {}

  current(): Shift | undefined {
    const r = this.db.prepare(`${SELECT} WHERE s.status = 'open'`).get() as Row | undefined;
    return r ? toShift(r) : undefined;
  }

  get(id: string): Shift | undefined {
    const r = this.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    return r ? toShift(r) : undefined;
  }

  recent(limit = 30): Shift[] {
    return (
      this.db.prepare(`${SELECT} ORDER BY s.opened_at DESC, s.rowid DESC LIMIT ?`).all(limit) as Row[]
    ).map(toShift);
  }

  open(userId: string, openingCashMinor: number): Shift {
    assertMoney("Opening cash", openingCashMinor);
    const existing = this.current();
    if (existing) throw new Error(`A shift is already open (${existing.userName})`);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO shifts (id, user_id, opened_at, opening_cash_minor, status)
         VALUES (?, ?, ?, ?, 'open')`,
      )
      .run(id, userId, new Date().toISOString(), openingCashMinor);
    return this.mustGet(id);
  }

  /** Cash put into (positive) or taken out of (negative) the drawer outside of sales. */
  addCashMovement(shiftId: string, userId: string, amountMinor: number, reason: string, ref?: { type: "refund" | "void"; id: string }): void {
    if (!Number.isInteger(amountMinor) || amountMinor === 0) {
      throw new Error("Amount must be a non-zero whole amount");
    }
    if (!reason.trim()) throw new Error("A reason is required");
    const shift = this.mustGet(shiftId);
    if (shift.status !== "open") throw new Error("That shift is already closed");
    if (amountMinor < 0 && -amountMinor > this.summary(shiftId).expectedCashMinor) {
      throw new Error("There is not that much cash in the drawer");
    }
    this.db
      .prepare(
        `INSERT INTO cash_movements (id, shift_id, user_id, amount_minor, reason, created_at, ref_type, ref_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), shiftId, userId, amountMinor, reason.trim(), new Date().toISOString(), ref?.type ?? null, ref?.id ?? null);
  }

  summary(shiftId: string): ShiftSummary {
    const shift = this.mustGet(shiftId);

    // A closed shift keeps the figures it closed with. A sale of that shift voided later is still counted
    // here; the cash handed back for it is recorded in the shift that was open at the time.
    const closedAt = shift.status === "closed" ? shift.closedAt : null;
    const counted = `(s.status = 'completed' OR (s.status = 'void' AND ? IS NOT NULL AND s.voided_at >= ?))`;
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_minor), 0) AS total,
                COALESCE(SUM(change_minor), 0) AS change
           FROM sales s WHERE s.shift_id = ? AND ${counted}`,
      )
      .get(shiftId, closedAt, closedAt) as { n: number; total: number; change: number };

    const byMethod: Record<string, number> = {};
    const rows = this.db
      .prepare(
        `SELECT p.method AS method, SUM(p.amount_minor) AS amount
           FROM payments p JOIN sales s ON s.id = p.sale_id
          WHERE s.shift_id = ? AND ${counted} GROUP BY p.method`,
      )
      .all(shiftId, closedAt, closedAt) as { method: string; amount: number }[];
    for (const r of rows) byMethod[r.method] = r.amount;
    // Change is handed back from the drawer, so cash kept = cash paid - change.
    const cashSales = (byMethod.cash ?? 0) - totals.change;
    if (byMethod.cash !== undefined) byMethod.cash = cashSales;

    const movements = (
      this.db
        .prepare(
          `SELECT id, amount_minor AS amountMinor, reason, created_at AS createdAt, ref_type AS refType
             FROM cash_movements WHERE shift_id = ? ORDER BY created_at, rowid`,
        )
        .all(shiftId) as { id: string; amountMinor: number; reason: string; createdAt: string; refType: string | null }[]
    );
    const refundOut = movements.filter((m) => m.amountMinor < 0 && m.refType !== null).reduce((s, m) => s - m.amountMinor, 0);
    const cashIn = movements.filter((m) => m.amountMinor > 0).reduce((s, m) => s + m.amountMinor, 0);
    const cashOut = movements.filter((m) => m.amountMinor < 0).reduce((s, m) => s - m.amountMinor, 0);

    return {
      shift,
      salesCount: totals.n,
      salesTotalMinor: totals.total,
      byMethod,
      cashSalesMinor: cashSales,
      cashInMinor: cashIn,
      cashOutMinor: cashOut,
      refundCashOutMinor: refundOut,
      expectedCashMinor: shift.openingCashMinor + cashSales + cashIn - cashOut,
      movements: movements.map(({ refType: _t, ...m }) => m),
    };
  }

  /** Close the shift against the cash actually counted. Cannot be reopened. */
  close(shiftId: string, countedCashMinor: number, note?: string): ShiftSummary {
    assertMoney("Counted cash", countedCashMinor);
    this.db.transaction(() => {
      const shift = this.mustGet(shiftId);
      if (shift.status !== "open") throw new Error("That shift is already closed");
      const expected = this.summary(shiftId).expectedCashMinor;
      this.db
        .prepare(
          `UPDATE shifts SET status = 'closed', closed_at = ?, counted_cash_minor = ?,
             expected_cash_minor = ?, variance_minor = ?, note = ? WHERE id = ?`,
        )
        .run(
          new Date().toISOString(),
          countedCashMinor,
          expected,
          countedCashMinor - expected,
          note?.trim() || null,
          shiftId,
        );
    })();
    return this.summary(shiftId);
  }

  private mustGet(id: string): Shift {
    const s = this.get(id);
    if (!s) throw new Error("Shift not found");
    return s;
  }
}
