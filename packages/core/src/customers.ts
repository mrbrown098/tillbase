import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

/**
 * Customers, loyalty points and a prepaid wallet.
 *
 * Points and wallet money are kept in an append-only ledger. A balance on the customer row is only ever
 * changed by database triggers that add up ledger rows, so nobody (and no bug) can edit a balance
 * directly. A mistake is fixed by adding a correcting row, which keeps the whole history.
 */

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  points: number;
  /** Prepaid money the customer can spend (minor units). */
  walletMinor: number;
  createdAt: string;
}

/** The few fields the till needs about a customer. */
export interface CustomerSummary {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  points: number;
  walletMinor: number;
}

export interface CustomerInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
}

export type LedgerAccount = "points" | "wallet";
export type LedgerReason = "earn" | "redeem" | "spend" | "topup" | "adjust" | "void_earn" | "void_redeem" | "void_spend";

export interface LedgerEntry {
  id: string;
  customerId: string;
  account: LedgerAccount;
  delta: number;
  reason: LedgerReason;
  saleId: string | null;
  receiptNo: string | null;
  userId: string | null;
  note: string | null;
  createdAt: string;
}

export interface CustomerVisit {
  saleId: string;
  receiptNo: string;
  createdAt: string;
  status: "completed" | "void";
  totalMinor: number;
  pointsEarned: number;
  pointsRedeemed: number;
  items: string;
}

export interface CustomerHistory {
  customer: Customer;
  /** Most recent first. */
  visits: CustomerVisit[];
  /** Number of completed (not voided) sales. */
  visitCount: number;
  /** What they have spent on completed sales. `null` when the person asking may not see money totals. */
  totalSpentMinor: number | null;
  lastVisit: string | null;
}

export interface LoyaltyConfig {
  /** Net spend (minor units) that earns one point. 0 turns earning off. Default 10000 = 1 point per 100.00. */
  spendPerPointMinor: number;
  /** What one point is worth when used as a discount (minor units). 0 turns redeeming off. Default 100 = 1.00. */
  pointValueMinor: number;
}

export const defaultLoyalty: LoyaltyConfig = { spendPerPointMinor: 10000, pointValueMinor: 100 };

const KEY_SPEND = "loyalty.spend_per_point_minor";
const KEY_VALUE = "loyalty.point_value_minor";

/** Read the loyalty rates. Missing or damaged values fall back to the defaults. */
export function loyaltyConfig(db: Db): LoyaltyConfig {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN (?, ?)").all(KEY_SPEND, KEY_VALUE) as {
    key: string;
    value: string;
  }[];
  const get = (key: string, fallback: number) => {
    const raw = rows.find((r) => r.key === key)?.value;
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    spendPerPointMinor: get(KEY_SPEND, defaultLoyalty.spendPerPointMinor),
    pointValueMinor: get(KEY_VALUE, defaultLoyalty.pointValueMinor),
  };
}

/** Points earned by spending `netMinor` (whole points only; the leftover earns nothing). */
export function pointsFor(netMinor: number, cfg: LoyaltyConfig): number {
  if (cfg.spendPerPointMinor <= 0 || netMinor <= 0) return 0;
  return Math.floor(netMinor / cfg.spendPerPointMinor);
}

interface NewEntry {
  customerId: string;
  account: LedgerAccount;
  delta: number;
  reason: LedgerReason;
  saleId?: string | null;
  userId?: string | null;
  note?: string | null;
}

/** Add one row to the ledger. The only way a balance changes. Callers run it inside their own transaction. */
export function postLedger(db: Db, e: NewEntry): void {
  if (!Number.isInteger(e.delta) || e.delta === 0) throw new Error("A ledger entry must be a whole number that is not zero");
  db.prepare(
    `INSERT INTO customer_ledger (id, customer_id, account, delta, reason, sale_id, user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), e.customerId, e.account, e.delta, e.reason, e.saleId ?? null, e.userId ?? null, e.note ?? null, new Date().toISOString());
}

/** Undo what a sale did to its customer: every ledger row of the sale gets an equal and opposite row. */
export function reverseSaleLedger(db: Db, saleId: string, userId?: string | null): void {
  const rows = db
    .prepare(
      `SELECT customer_id AS customerId, account, delta, reason FROM customer_ledger
        WHERE sale_id = ? AND reason IN ('earn', 'redeem', 'spend') ORDER BY rowid`,
    )
    .all(saleId) as { customerId: string; account: LedgerAccount; delta: number; reason: "earn" | "redeem" | "spend" }[];
  for (const r of rows) {
    postLedger(db, {
      customerId: r.customerId,
      account: r.account,
      delta: -r.delta,
      reason: `void_${r.reason}`,
      saleId,
      userId,
      note: "Sale voided",
    });
  }
}

/** Keep only digits and a leading +, so "0300-123 4567" and "03001234567" are the same number. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

const summaryColumns = "id, name, phone, address, points, wallet_minor AS walletMinor";

export class CustomerService {
  constructor(private readonly db: Db) {}

  create(input: CustomerInput): Customer {
    const name = input.name?.trim();
    if (!name) throw new Error("Please enter the customer's name");
    const phone = this.checkPhone(input.phone);
    if (phone) this.assertPhoneFree(phone);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO customers (id, name, phone, address, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, phone, clean(input.address), clean(input.notes), new Date().toISOString());
    return this.mustGet(id);
  }

  update(id: string, patch: Partial<CustomerInput>): Customer {
    const c = this.mustGet(id);
    const name = patch.name === undefined ? c.name : patch.name.trim();
    if (!name) throw new Error("Please enter the customer's name");
    const phone = patch.phone === undefined ? c.phone : this.checkPhone(patch.phone);
    if (phone && phone !== c.phone) this.assertPhoneFree(phone, id);
    this.db
      .prepare("UPDATE customers SET name = ?, phone = ?, address = ?, notes = ? WHERE id = ?")
      .run(
        name,
        phone,
        patch.address === undefined ? c.address : clean(patch.address),
        patch.notes === undefined ? c.notes : clean(patch.notes),
        id,
      );
    return this.mustGet(id);
  }

  get(id: string): Customer | undefined {
    const r = this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toCustomer(r) : undefined;
  }

  summary(id: string): CustomerSummary | null {
    return (this.db.prepare(`SELECT ${summaryColumns} FROM customers WHERE id = ?`).get(id) as CustomerSummary | undefined) ?? null;
  }

  /**
   * Find customers by part of a name or part of a phone number. A phone search ignores spaces and
   * dashes. An empty search lists the most recently added customers.
   */
  search(query: string, limit = 20): Customer[] {
    const q = (query ?? "").trim();
    const cap = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
    if (!q) {
      return (this.db.prepare("SELECT * FROM customers ORDER BY created_at DESC, rowid DESC LIMIT ?").all(cap) as Record<string, unknown>[]).map(toCustomer);
    }
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const digits = q.replace(/\D/g, "");
    const rows = this.db
      .prepare(
        `SELECT * FROM customers
          WHERE name LIKE ? ESCAPE '\\'
             OR (? <> '' AND REPLACE(COALESCE(phone, ''), '+', '') LIKE ?)
          ORDER BY CASE WHEN phone = ? THEN 0 ELSE 1 END, name COLLATE NOCASE
          LIMIT ?`,
      )
      .all(like, digits, `%${digits}%`, normalizePhone(q), cap) as Record<string, unknown>[];
    return rows.map(toCustomer);
  }

  /** Orders and spend for one customer. `canSeeSpend` is false for anyone but the owner. */
  history(id: string, canSeeSpend: boolean): CustomerHistory {
    const customer = this.mustGet(id);
    const visits = (
      this.db
        .prepare(
          `SELECT s.id, s.receipt_no AS receiptNo, s.created_at AS createdAt, s.status, s.total_minor AS totalMinor,
                  s.points_earned AS pointsEarned, s.points_redeemed AS pointsRedeemed,
                  COALESCE((SELECT GROUP_CONCAT(name, ', ') FROM (SELECT name FROM sale_items WHERE sale_id = s.id ORDER BY rowid)), '') AS items
             FROM sales s WHERE s.customer_id = ? ORDER BY s.created_at DESC, s.rowid DESC`,
        )
        .all(id) as (Omit<CustomerVisit, "saleId"> & { id: string })[]
    ).map(({ id: saleId, ...rest }): CustomerVisit => ({ saleId, ...rest }));
    const done = visits.filter((v) => v.status === "completed");
    return {
      customer,
      visits,
      visitCount: done.length,
      totalSpentMinor: canSeeSpend ? done.reduce((s, v) => s + v.totalMinor, 0) : null,
      lastVisit: done[0]?.createdAt ?? null,
    };
  }

  /** Every points or wallet entry for a customer, newest first. */
  ledger(id: string, limit = 100): LedgerEntry[] {
    this.mustGet(id);
    const rows = this.db
      .prepare(
        `SELECT l.id, l.customer_id AS customerId, l.account, l.delta, l.reason, l.sale_id AS saleId,
                s.receipt_no AS receiptNo, l.user_id AS userId, l.note, l.created_at AS createdAt
           FROM customer_ledger l LEFT JOIN sales s ON s.id = l.sale_id
          WHERE l.customer_id = ? ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`,
      )
      .all(id, Math.min(Math.max(Math.trunc(limit) || 100, 1), 1000));
    return rows as LedgerEntry[];
  }

  config(): LoyaltyConfig {
    return loyaltyConfig(this.db);
  }

  setConfig(cfg: LoyaltyConfig): LoyaltyConfig {
    for (const [label, v] of [
      ["Spend that earns a point", cfg.spendPerPointMinor],
      ["Value of one point", cfg.pointValueMinor],
    ] as const) {
      if (!Number.isInteger(v) || v < 0) throw new Error(`${label} must be an amount of 0 or more`);
    }
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.transaction(() => {
      put.run(KEY_SPEND, String(cfg.spendPerPointMinor));
      put.run(KEY_VALUE, String(cfg.pointValueMinor));
    })();
    return this.config();
  }

  /**
   * What `points` is worth as a discount, after checking the customer has them and the discount is not
   * more than `eligibleMinor` (the part of the bill points may pay for). Throws plain messages.
   */
  redeemValue(customerId: string, points: number, eligibleMinor: number): number {
    if (!Number.isInteger(points) || points < 0) throw new Error("Points to use must be a whole number of 0 or more");
    if (points === 0) return 0;
    const cfg = this.config();
    if (cfg.pointValueMinor <= 0) throw new Error("Points cannot be used as a discount right now");
    const c = this.mustGet(customerId);
    if (points > c.points) throw new Error(`${c.name} has ${c.points} point${c.points === 1 ? "" : "s"}, not ${points}`);
    const value = points * cfg.pointValueMinor;
    if (value > eligibleMinor) {
      const most = Math.floor(eligibleMinor / cfg.pointValueMinor);
      throw new Error(`Points can only pay for the items on the bill. The most that can be used here is ${most}`);
    }
    return value;
  }

  /** Manager correction to points: positive adds, negative takes away. Needs a reason. */
  adjustPoints(id: string, delta: number, note: string, userId?: string | null): Customer {
    const c = this.mustGet(id);
    if (!Number.isInteger(delta) || delta === 0) throw new Error("Enter a whole number of points, other than 0");
    if (!note?.trim()) throw new Error("Please give a reason for the change");
    if (c.points + delta < 0) throw new Error(`${c.name} only has ${c.points} point${c.points === 1 ? "" : "s"}`);
    postLedger(this.db, { customerId: id, account: "points", delta, reason: "adjust", userId, note: note.trim() });
    return this.mustGet(id);
  }

  /** Put prepaid money in a customer's wallet. The money itself is taken by the caller (cash drawer or card). */
  topUp(id: string, amountMinor: number, note?: string | null, userId?: string | null): Customer {
    this.mustGet(id);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("Top-up must be an amount above 0");
    postLedger(this.db, { customerId: id, account: "wallet", delta: amountMinor, reason: "topup", userId, note: clean(note) });
    return this.mustGet(id);
  }

  /** Manager correction to wallet money (e.g. a refund or a mistake). Needs a reason; cannot go below 0. */
  adjustWallet(id: string, deltaMinor: number, note: string, userId?: string | null): Customer {
    const c = this.mustGet(id);
    if (!Number.isInteger(deltaMinor) || deltaMinor === 0) throw new Error("Enter an amount, other than 0");
    if (!note?.trim()) throw new Error("Please give a reason for the change");
    if (c.walletMinor + deltaMinor < 0) throw new Error("The wallet does not have that much in it");
    postLedger(this.db, { customerId: id, account: "wallet", delta: deltaMinor, reason: "adjust", userId, note: note.trim() });
    return this.mustGet(id);
  }

  private checkPhone(raw: string | null | undefined): string | null {
    const trimmed = clean(raw);
    if (!trimmed) return null;
    const phone = normalizePhone(trimmed);
    if (!phone || phone.replace(/\D/g, "").length < 5) throw new Error("That phone number looks too short");
    if (/[^\d\s+()\-.]/.test(trimmed)) throw new Error("A phone number can only have digits, spaces, + and -");
    return phone;
  }

  private assertPhoneFree(phone: string, exceptId?: string): void {
    const hit = this.db.prepare("SELECT id, name FROM customers WHERE phone = ?").get(phone) as { id: string; name: string } | undefined;
    if (hit && hit.id !== exceptId) throw new Error(`That phone number already belongs to ${hit.name}`);
  }

  private mustGet(id: string): Customer {
    const c = this.get(id);
    if (!c) throw new Error("Customer not found");
    return c;
  }
}

function toCustomer(r: Record<string, unknown>): Customer {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: (r.phone as string | null) ?? null,
    address: (r.address as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    points: r.points as number,
    walletMinor: r.wallet_minor as number,
    createdAt: r.created_at as string,
  };
}
