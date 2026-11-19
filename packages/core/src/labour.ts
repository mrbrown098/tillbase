import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import {
  addDays,
  assertDate,
  daysInMonth,
  daysInclusive,
  endOfMonth,
  localDate,
} from "./dates.js";
import type { PayMethod } from "./purchases.js";

export type PayType = "monthly" | "daily" | "hourly";

export interface PayTerms {
  payType: PayType;
  /** Per month, per day or per hour depending on `payType`, in minor units. */
  payRateMinor: number;
  /** Minutes in one day after which overtime starts. 0 means no overtime. */
  overtimeAfterMinutes: number;
  /** Overtime pay as a multiple of the normal rate in basis points: 15000 = 1.5x. */
  overtimeMultiplierBp: number;
}

export interface Employee extends PayTerms {
  id: string;
  name: string;
  phone: string | null;
  title: string | null;
  active: boolean;
  createdAt: string;
}

export interface EmployeeInput extends Partial<PayTerms> {
  name: string;
  payType: PayType;
  payRateMinor: number;
  phone?: string | null;
  title?: string | null;
}

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  clockIn: string;
  clockOut: string | null;
  minutes: number | null;
  note: string | null;
}

export interface PayCalc {
  minutes: number;
  days: number;
  baseMinor: number;
  overtimeMinor: number;
}

export interface PayrollPreviewLine extends PayCalc {
  employeeId: string;
  name: string;
  payType: PayType;
  grossMinor: number;
  outstandingAdvanceMinor: number;
  /** Still clocked in, so their hours are incomplete. Payroll is blocked until they clock out. */
  stillClockedIn: boolean;
  /** A payslip already covers some of these dates. */
  alreadyPaid: boolean;
}

export interface PayslipLineInput {
  employeeId: string;
  bonusMinor?: number;
  deductionsMinor?: number;
  /** How much of the outstanding advance to take back from this pay. */
  recoverAdvanceMinor?: number;
}

export interface Payslip {
  id: string;
  runId: string;
  employeeId: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  minutes: number;
  days: number;
  baseMinor: number;
  overtimeMinor: number;
  bonusMinor: number;
  deductionsMinor: number;
  advancesMinor: number;
  /** Cash the employee takes home. */
  netMinor: number;
  /** What this person cost the business for the period (before advances are taken back). */
  costMinor: number;
  paidMinor: number;
  paidAt: string | null;
  method: PayMethod | null;
}

const MS_MIN = 60_000;

function monthlyBase(rate: number, start: string, end: string): number {
  let total = 0;
  let cur = start;
  while (cur <= end) {
    const [y, m] = cur.split("-").map(Number) as [number, number];
    const monthEnd = endOfMonth(cur);
    const segEnd = monthEnd < end ? monthEnd : end;
    total += (rate * daysInclusive(cur, segEnd)) / daysInMonth(y, m);
    cur = addDays(segEnd, 1);
  }
  return Math.round(total);
}

/**
 * Work out pay for a period from the finished attendance records in it.
 * A shift belongs to the day it started, so a night shift that ends after
 * midnight is not split. Records still open (no clock-out) are ignored.
 */
export function computePay(
  terms: PayTerms,
  records: { clockIn: string; clockOut: string | null }[],
  start: string,
  end: string,
): PayCalc {
  const perDay = new Map<string, number>();
  for (const r of records) {
    if (!r.clockOut) continue;
    const day = localDate(r.clockIn);
    if (day < start || day > end) continue;
    const mins = Math.floor((new Date(r.clockOut).getTime() - new Date(r.clockIn).getTime()) / MS_MIN);
    if (mins > 0) perDay.set(day, (perDay.get(day) ?? 0) + mins);
  }
  const minutes = [...perDay.values()].reduce((s, m) => s + m, 0);
  const days = perDay.size;

  const thr = terms.overtimeAfterMinutes;
  let regular = minutes;
  let overtime = 0;
  if (thr > 0) {
    regular = 0;
    for (const m of perDay.values()) {
      regular += Math.min(m, thr);
      overtime += Math.max(0, m - thr);
    }
  }
  const mult = terms.overtimeMultiplierBp / 10000;
  const rate = terms.payRateMinor;

  if (terms.payType === "hourly") {
    return {
      minutes,
      days,
      baseMinor: Math.round((regular / 60) * rate),
      overtimeMinor: thr > 0 ? Math.round((overtime / 60) * rate * mult) : 0,
    };
  }
  if (terms.payType === "daily") {
    const hourly = thr > 0 ? rate / (thr / 60) : 0;
    return {
      minutes,
      days,
      baseMinor: days * rate,
      overtimeMinor: thr > 0 ? Math.round((overtime / 60) * hourly * mult) : 0,
    };
  }
  const hourly = thr > 0 ? rate / 30 / (thr / 60) : 0;
  return {
    minutes,
    days,
    baseMinor: monthlyBase(rate, start, end),
    overtimeMinor: thr > 0 ? Math.round((overtime / 60) * hourly * mult) : 0,
  };
}

interface EmpRow {
  id: string;
  name: string;
  phone: string | null;
  title: string | null;
  pay_type: PayType;
  pay_rate_minor: number;
  overtime_after_minutes: number;
  overtime_multiplier_bp: number;
  active: number;
  created_at: string;
}

const toEmployee = (r: EmpRow): Employee => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  title: r.title,
  payType: r.pay_type,
  payRateMinor: r.pay_rate_minor,
  overtimeAfterMinutes: r.overtime_after_minutes,
  overtimeMultiplierBp: r.overtime_multiplier_bp,
  active: r.active === 1,
  createdAt: r.created_at,
});

const terms = (e: Employee): PayTerms => ({
  payType: e.payType,
  payRateMinor: e.payRateMinor,
  overtimeAfterMinutes: e.overtimeAfterMinutes,
  overtimeMultiplierBp: e.overtimeMultiplierBp,
});

function checkTerms(t: PayTerms): void {
  if (!["monthly", "daily", "hourly"].includes(t.payType)) throw new Error("Choose monthly, daily or hourly pay");
  if (!Number.isInteger(t.payRateMinor) || t.payRateMinor < 0) throw new Error("Pay rate must be a whole, non-negative amount");
  if (!Number.isInteger(t.overtimeAfterMinutes) || t.overtimeAfterMinutes < 0) throw new Error("Overtime threshold must be 0 or more minutes");
  if (!Number.isInteger(t.overtimeMultiplierBp) || t.overtimeMultiplierBp < 10000) throw new Error("Overtime multiplier cannot be below 1x");
}

const ATT_SELECT = `SELECT a.*, e.name AS employee_name FROM attendance a JOIN employees e ON e.id = a.employee_id`;

interface AttRow {
  id: string;
  employee_id: string;
  employee_name: string;
  clock_in: string;
  clock_out: string | null;
  note: string | null;
}

const toAttendance = (r: AttRow): AttendanceRecord => ({
  id: r.id,
  employeeId: r.employee_id,
  employeeName: r.employee_name,
  clockIn: r.clock_in,
  clockOut: r.clock_out,
  minutes: r.clock_out
    ? Math.max(0, Math.floor((new Date(r.clock_out).getTime() - new Date(r.clock_in).getTime()) / MS_MIN))
    : null,
  note: r.note,
});

/** Staff, their hours, advances and payroll. */
export class LabourService {
  constructor(private readonly db: Db) {}

  // ---- Employees ---------------------------------------------------------

  createEmployee(input: EmployeeInput): Employee {
    const name = input.name?.trim();
    if (!name) throw new Error("Name is required");
    const t: PayTerms = {
      payType: input.payType,
      payRateMinor: input.payRateMinor,
      overtimeAfterMinutes: input.overtimeAfterMinutes ?? 0,
      overtimeMultiplierBp: input.overtimeMultiplierBp ?? 15000,
    };
    checkTerms(t);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO employees (id, name, phone, title, pay_type, pay_rate_minor,
           overtime_after_minutes, overtime_multiplier_bp, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        name,
        input.phone?.trim() || null,
        input.title?.trim() || null,
        t.payType,
        t.payRateMinor,
        t.overtimeAfterMinutes,
        t.overtimeMultiplierBp,
        new Date().toISOString(),
      );
    return this.mustEmployee(id);
  }

  updateEmployee(id: string, patch: Partial<EmployeeInput> & { active?: boolean }): Employee {
    const cur = this.mustEmployee(id);
    const next = {
      name: patch.name?.trim() ?? cur.name,
      phone: patch.phone === undefined ? cur.phone : patch.phone?.trim() || null,
      title: patch.title === undefined ? cur.title : patch.title?.trim() || null,
      active: patch.active ?? cur.active,
      terms: {
        payType: patch.payType ?? cur.payType,
        payRateMinor: patch.payRateMinor ?? cur.payRateMinor,
        overtimeAfterMinutes: patch.overtimeAfterMinutes ?? cur.overtimeAfterMinutes,
        overtimeMultiplierBp: patch.overtimeMultiplierBp ?? cur.overtimeMultiplierBp,
      } satisfies PayTerms,
    };
    if (!next.name) throw new Error("Name is required");
    checkTerms(next.terms);
    if (!next.active && cur.active && this.isClockedIn(id)) {
      throw new Error("Clock this person out before making them inactive");
    }
    this.db
      .prepare(
        `UPDATE employees SET name=?, phone=?, title=?, pay_type=?, pay_rate_minor=?,
           overtime_after_minutes=?, overtime_multiplier_bp=?, active=? WHERE id=?`,
      )
      .run(
        next.name,
        next.phone,
        next.title,
        next.terms.payType,
        next.terms.payRateMinor,
        next.terms.overtimeAfterMinutes,
        next.terms.overtimeMultiplierBp,
        next.active ? 1 : 0,
        id,
      );
    return this.mustEmployee(id);
  }

  employees(opts: { includeInactive?: boolean } = {}): Employee[] {
    const sql = `SELECT * FROM employees ${opts.includeInactive ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`;
    return (this.db.prepare(sql).all() as EmpRow[]).map(toEmployee);
  }

  getEmployee(id: string): Employee | undefined {
    const r = this.db.prepare("SELECT * FROM employees WHERE id = ?").get(id) as EmpRow | undefined;
    return r ? toEmployee(r) : undefined;
  }

  // ---- Attendance --------------------------------------------------------

  clockIn(employeeId: string, at: string = new Date().toISOString()): AttendanceRecord {
    const e = this.mustEmployee(employeeId);
    if (!e.active) throw new Error(`${e.name} is not active`);
    this.assertInstant(at);
    if (this.isClockedIn(employeeId)) throw new Error(`${e.name} is already clocked in`);
    const id = randomUUID();
    this.assertNoOverlap(employeeId, at, null);
    this.db
      .prepare("INSERT INTO attendance (id, employee_id, clock_in) VALUES (?, ?, ?)")
      .run(id, employeeId, at);
    return this.mustAttendance(id);
  }

  clockOut(employeeId: string, at: string = new Date().toISOString()): AttendanceRecord {
    const e = this.mustEmployee(employeeId);
    this.assertInstant(at);
    const open = this.db
      .prepare("SELECT id, clock_in FROM attendance WHERE employee_id = ? AND clock_out IS NULL")
      .get(employeeId) as { id: string; clock_in: string } | undefined;
    if (!open) throw new Error(`${e.name} is not clocked in`);
    if (new Date(at).getTime() <= new Date(open.clock_in).getTime()) {
      throw new Error("Clock-out must be after clock-in");
    }
    this.db.prepare("UPDATE attendance SET clock_out = ? WHERE id = ?").run(at, open.id);
    return this.mustAttendance(open.id);
  }

  /** Add a finished shift by hand, for example when someone forgot to clock in. */
  addShift(employeeId: string, clockIn: string, clockOut: string, note?: string): AttendanceRecord {
    this.mustEmployee(employeeId);
    this.assertInstant(clockIn);
    this.assertInstant(clockOut);
    if (new Date(clockOut).getTime() <= new Date(clockIn).getTime()) {
      throw new Error("Clock-out must be after clock-in");
    }
    this.assertNoOverlap(employeeId, clockIn, clockOut);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO attendance (id, employee_id, clock_in, clock_out, note) VALUES (?, ?, ?, ?, ?)")
      .run(id, employeeId, clockIn, clockOut, note?.trim() || null);
    return this.mustAttendance(id);
  }

  /** Delete a wrong entry. Not allowed once a payslip covers that day. */
  removeShift(id: string): void {
    const rec = this.mustAttendance(id);
    if (this.coveredByPayslip(rec.employeeId, localDate(rec.clockIn))) {
      throw new Error("This day has already been paid, so the entry cannot be changed");
    }
    this.db.prepare("DELETE FROM attendance WHERE id = ?").run(id);
  }

  isClockedIn(employeeId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM attendance WHERE employee_id = ? AND clock_out IS NULL")
      .get(employeeId);
  }

  /** People clocked in right now. */
  whoIsIn(): AttendanceRecord[] {
    return (
      this.db.prepare(`${ATT_SELECT} WHERE a.clock_out IS NULL ORDER BY a.clock_in`).all() as AttRow[]
    ).map(toAttendance);
  }

  attendance(from: string, to: string, employeeId?: string): AttendanceRecord[] {
    assertDate("From", from);
    assertDate("To", to);
    const rows = this.db
      .prepare(`${ATT_SELECT} ${employeeId ? "WHERE a.employee_id = ?" : ""} ORDER BY a.clock_in DESC`)
      .all(...(employeeId ? [employeeId] : [])) as AttRow[];
    return rows
      .map(toAttendance)
      .filter((r) => {
        const d = localDate(r.clockIn);
        return d >= from && d <= to;
      });
  }

  // ---- Advances ----------------------------------------------------------

  giveAdvance(employeeId: string, amountMinor: number, givenOn: string = localDate(), note?: string): void {
    this.mustEmployee(employeeId);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("Amount must be a positive whole amount");
    assertDate("Date", givenOn);
    this.db
      .prepare(
        "INSERT INTO advances (id, employee_id, amount_minor, given_on, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), employeeId, amountMinor, givenOn, note?.trim() || null, new Date().toISOString());
  }

  outstandingAdvance(employeeId: string): number {
    return (
      this.db
        .prepare("SELECT COALESCE(SUM(amount_minor - recovered_minor), 0) AS n FROM advances WHERE employee_id = ?")
        .get(employeeId) as { n: number }
    ).n;
  }

  /** Total advances not yet taken back from pay, across everyone. */
  totalOutstandingAdvances(): number {
    return (
      this.db.prepare("SELECT COALESCE(SUM(amount_minor - recovered_minor), 0) AS n FROM advances").get() as { n: number }
    ).n;
  }

  // ---- Payroll -----------------------------------------------------------

  /** What each person has earned for the period. Nothing is saved. */
  preview(start: string, end: string): PayrollPreviewLine[] {
    this.assertPeriod(start, end);
    const lines: PayrollPreviewLine[] = [];
    for (const e of this.employees({ includeInactive: true })) {
      const recs = this.rawRecords(e.id);
      const calc = computePay(terms(e), recs, start, end);
      const hasWork = calc.minutes > 0;
      if (!e.active && !hasWork) continue;
      lines.push({
        employeeId: e.id,
        name: e.name,
        payType: e.payType,
        ...calc,
        grossMinor: calc.baseMinor + calc.overtimeMinor,
        outstandingAdvanceMinor: this.outstandingAdvance(e.id),
        stillClockedIn: this.isClockedIn(e.id),
        alreadyPaid: this.coversPeriod(e.id, start, end),
      });
    }
    return lines;
  }

  /**
   * Save payroll for a period: one payslip per person with earnings. Bonuses,
   * deductions and advance recovery are per person. Everything succeeds or nothing does.
   */
  finalize(input: {
    periodStart: string;
    periodEnd: string;
    userId?: string;
    lines?: PayslipLineInput[];
  }): Payslip[] {
    const { periodStart: start, periodEnd: end } = input;
    this.assertPeriod(start, end);
    const adj = new Map((input.lines ?? []).map((l) => [l.employeeId, l]));
    const preview = this.preview(start, end);

    const runId = randomUUID();
    const created: string[] = [];
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO payroll_runs (id, period_start, period_end, user_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, start, end, input.userId ?? null, new Date().toISOString());

      for (const line of preview) {
        const a = adj.get(line.employeeId);
        const bonus = a?.bonusMinor ?? 0;
        const deductions = a?.deductionsMinor ?? 0;
        const recover = a?.recoverAdvanceMinor ?? 0;
        for (const [label, v] of [["Bonus", bonus], ["Deductions", deductions], ["Advance recovery", recover]] as const) {
          if (!Number.isInteger(v) || v < 0) throw new Error(`${label} must be a whole, non-negative amount`);
        }
        const earns = line.grossMinor > 0 || bonus > 0;
        if (!earns) continue;
        if (line.alreadyPaid) {
          throw new Error(`${line.name} already has a payslip covering some of these dates`);
        }
        if (line.stillClockedIn) {
          throw new Error(`${line.name} is still clocked in. Clock them out before running payroll`);
        }
        if (recover > line.outstandingAdvanceMinor) {
          throw new Error(`${line.name} only has ${line.outstandingAdvanceMinor} of advances to recover`);
        }
        const gross = line.grossMinor + bonus;
        const net = gross - deductions - recover;
        if (net < 0) throw new Error(`${line.name}: deductions and advance recovery are more than the pay`);

        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO payslips (id, run_id, employee_id, period_start, period_end, minutes, days,
               base_minor, overtime_minor, bonus_minor, deductions_minor, advances_minor, net_minor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, runId, line.employeeId, start, end, line.minutes, line.days, line.baseMinor,
            line.overtimeMinor, bonus, deductions, recover, net);
        created.push(id);
        this.recoverAdvances(line.employeeId, recover);
      }
      if (created.length === 0) throw new Error("There is nothing to pay for this period");
    })();
    return created.map((id) => this.mustPayslip(id));
  }

  /** Mark a payslip as paid. */
  pay(payslipId: string, method: PayMethod = "cash"): Payslip {
    const p = this.mustPayslip(payslipId);
    if (p.paidAt) throw new Error("This payslip has already been paid");
    this.db
      .prepare("UPDATE payslips SET paid_minor = net_minor, paid_at = ?, method = ? WHERE id = ?")
      .run(new Date().toISOString(), method, payslipId);
    return this.mustPayslip(payslipId);
  }

  payslips(opts: { from?: string; to?: string; employeeId?: string } = {}): Payslip[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.from) { where.push("p.period_end >= ?"); args.push(opts.from); }
    if (opts.to) { where.push("p.period_end <= ?"); args.push(opts.to); }
    if (opts.employeeId) { where.push("p.employee_id = ?"); args.push(opts.employeeId); }
    const rows = this.db
      .prepare(
        `SELECT p.id FROM payslips p ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY p.period_end DESC, p.rowid DESC`,
      )
      .all(...args) as { id: string }[];
    return rows.map((r) => this.mustPayslip(r.id));
  }

  /**
   * Labour cost for a date range. `actual` comes from saved payslips (attributed to the
   * period they end in). `estimated` covers days no payslip covers yet, so a month that
   * has not been through payroll still shows its wage bill. Inactive staff are not estimated.
   */
  costBetween(from: string, to: string): { actualMinor: number; estimatedMinor: number } {
    assertDate("From", from);
    assertDate("To", to);
    const actual = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(base_minor + overtime_minor + bonus_minor - deductions_minor), 0) AS n
             FROM payslips WHERE period_end >= ? AND period_end <= ?`,
        )
        .get(from, to) as { n: number }
    ).n;

    let estimated = 0;
    for (const e of this.employees()) {
      const covered = (
        this.db
          .prepare("SELECT MAX(period_end) AS d FROM payslips WHERE employee_id = ?")
          .get(e.id) as { d: string | null }
      ).d;
      let start = from;
      if (covered && addDays(covered, 1) > start) start = addDays(covered, 1);
      const hired = localDate(e.createdAt);
      if (hired > start) start = hired;
      if (start > to) continue;
      const calc = computePay(terms(e), this.rawRecords(e.id), start, to);
      estimated += calc.baseMinor + calc.overtimeMinor;
    }
    return { actualMinor: actual, estimatedMinor: estimated };
  }

  // ---- internals ---------------------------------------------------------

  private rawRecords(employeeId: string): { clockIn: string; clockOut: string | null }[] {
    return (
      this.db
        .prepare("SELECT clock_in AS clockIn, clock_out AS clockOut FROM attendance WHERE employee_id = ?")
        .all(employeeId) as { clockIn: string; clockOut: string | null }[]
    );
  }

  private recoverAdvances(employeeId: string, amount: number): void {
    let left = amount;
    const rows = this.db
      .prepare(
        `SELECT id, amount_minor - recovered_minor AS open FROM advances
          WHERE employee_id = ? AND recovered_minor < amount_minor ORDER BY given_on, rowid`,
      )
      .all(employeeId) as { id: string; open: number }[];
    for (const r of rows) {
      if (left <= 0) break;
      const take = Math.min(left, r.open);
      this.db.prepare("UPDATE advances SET recovered_minor = recovered_minor + ? WHERE id = ?").run(take, r.id);
      left -= take;
    }
  }

  private coversPeriod(employeeId: string, start: string, end: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM payslips WHERE employee_id = ? AND period_start <= ? AND period_end >= ?")
      .get(employeeId, end, start);
  }

  private coveredByPayslip(employeeId: string, day: string): boolean {
    return this.coversPeriod(employeeId, day, day);
  }

  private assertPeriod(start: string, end: string): void {
    assertDate("Start date", start);
    assertDate("End date", end);
    if (end < start) throw new Error("The end date cannot be before the start date");
  }

  private assertInstant(at: string): void {
    if (Number.isNaN(new Date(at).getTime())) throw new Error("That date and time is not valid");
  }

  private assertNoOverlap(employeeId: string, from: string, to: string | null): void {
    const rows = this.rawRecords(employeeId);
    const a0 = new Date(from).getTime();
    const a1 = to ? new Date(to).getTime() : a0;
    for (const r of rows) {
      const b0 = new Date(r.clockIn).getTime();
      const b1 = r.clockOut ? new Date(r.clockOut).getTime() : Infinity;
      if (a0 < b1 && (to ? a1 > b0 : a0 >= b0)) {
        throw new Error("That overlaps another recorded shift for this person");
      }
    }
  }

  private mustEmployee(id: string): Employee {
    const e = this.getEmployee(id);
    if (!e) throw new Error("Employee not found");
    return e;
  }

  private mustAttendance(id: string): AttendanceRecord {
    const r = this.db.prepare(`${ATT_SELECT} WHERE a.id = ?`).get(id) as AttRow | undefined;
    if (!r) throw new Error("Attendance record not found");
    return toAttendance(r);
  }

  private mustPayslip(id: string): Payslip {
    const r = this.db
      .prepare(`SELECT p.*, e.name AS employee_name FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`)
      .get(id) as
      | {
          id: string; run_id: string; employee_id: string; employee_name: string; period_start: string;
          period_end: string; minutes: number; days: number; base_minor: number; overtime_minor: number;
          bonus_minor: number; deductions_minor: number; advances_minor: number; net_minor: number;
          paid_minor: number; paid_at: string | null; method: PayMethod | null;
        }
      | undefined;
    if (!r) throw new Error("Payslip not found");
    return {
      id: r.id,
      runId: r.run_id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      minutes: r.minutes,
      days: r.days,
      baseMinor: r.base_minor,
      overtimeMinor: r.overtime_minor,
      bonusMinor: r.bonus_minor,
      deductionsMinor: r.deductions_minor,
      advancesMinor: r.advances_minor,
      netMinor: r.net_minor,
      costMinor: r.base_minor + r.overtime_minor + r.bonus_minor - r.deductions_minor,
      paidMinor: r.paid_minor,
      paidAt: r.paid_at,
      method: r.method,
    };
  }
}
