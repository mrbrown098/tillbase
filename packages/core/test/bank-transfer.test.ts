import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  InventoryService, ProductService, SaleService, ShiftService, UserService, migrate, migrations, openDatabase, type Db,
} from "../src/index.js";

describe("upgrading from v6 to v10", () => {
  function v6Database(): Database.Database {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    for (const m of migrations.slice(0, 6)) old.exec(m.sql);
    old.pragma("user_version = 6");
    old.prepare("INSERT INTO products (id, name, kind, unit, price_minor, tax_rate_bp, track_stock, avg_cost, active, created_at, updated_at) VALUES ('p1', 'Tea', 'product', 'each', 5000, 0, 0, 0, 1, 't', 't')").run();
    old.prepare("INSERT INTO customers (id, name, phone, created_at) VALUES ('c1', 'Old Customer', '0300', 't')").run();
    const sale = old.prepare(
      `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor, cashier, created_at, customer_id)
       VALUES (?, ?, 'completed', ?, 0, 0, ?, ?, ?, 'Ali', ?, ?)`,
    );
    sale.run("s1", "R-000001", 10_000, 10_000, 12_000, 2_000, "2026-01-01T09:00:00Z", null);
    sale.run("s2", "R-000002", 5_000, 5_000, 5_000, 0, "2026-01-01T10:00:00Z", "c1");
    old.prepare("INSERT INTO sale_items (id, sale_id, product_id, name, qty, unit_price_minor, discount_minor, tax_rate_bp, tax_minor, total_minor, cogs_minor) VALUES ('i1', 's1', 'p1', 'Tea', 2, 5000, 0, 0, 0, 10000, 0)").run();
    old.prepare("INSERT INTO sale_items (id, sale_id, product_id, name, qty, unit_price_minor, discount_minor, tax_rate_bp, tax_minor, total_minor, cogs_minor) VALUES ('i2', 's2', 'p1', 'Tea', 1, 5000, 0, 0, 0, 5000, 0)").run();
    const pay = old.prepare("INSERT INTO payments (id, sale_id, method, amount_minor, label) VALUES (?, ?, ?, ?, ?)");
    pay.run("pay1", "s1", "cash", 12_000, null);
    pay.run("pay2", "s2", "other", 2_000, "wallet");
    pay.run("pay3", "s2", "card", 3_000, null);
    const led = old.prepare("INSERT INTO customer_ledger (id, customer_id, account, delta, reason, sale_id, note, created_at) VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)");
    led.run("l1", "wallet", 5_000, "topup", null, "cash", "2026-01-01T08:00:00Z");
    led.run("l2", "wallet", -2_000, "spend", "s2", null, "2026-01-01T10:00:00Z");
    led.run("l3", "points", 5, "earn", "s2", null, "2026-01-01T10:00:00Z");
    return old;
  }

  it("keeps every payment, sale and ledger row, and allows bank transfers afterwards", () => {
    const old = v6Database();
    const before = old.prepare("SELECT id, sale_id, method, amount_minor, label FROM payments ORDER BY rowid").all();
    const sales = old.prepare("SELECT * FROM sales ORDER BY rowid").all();
    const ledger = old.prepare("SELECT * FROM customer_ledger ORDER BY rowid").all();

    migrate(old);

    expect(old.pragma("user_version", { simple: true })).toBe(migrations.at(-1)!.version);
    expect(old.prepare("SELECT id, sale_id, method, amount_minor, label FROM payments ORDER BY rowid").all()).toEqual(before);
    expect(old.prepare("SELECT reference FROM payments WHERE reference IS NOT NULL").all()).toEqual([]);
    // every old sale row is unchanged (compared on the columns it had before), with the new column empty
    const cols = Object.keys((sales as Record<string, unknown>[])[0]!);
    expect(old.prepare(`SELECT ${cols.join(", ")} FROM sales ORDER BY rowid`).all()).toEqual(sales);
    expect(old.prepare("SELECT request_id FROM sales").all()).toEqual([{ request_id: null }, { request_id: null }]);
    const lcols = Object.keys((ledger as Record<string, unknown>[])[0]!);
    expect(old.prepare(`SELECT ${lcols.join(", ")} FROM customer_ledger ORDER BY rowid`).all()).toEqual(ledger);
    expect(old.pragma("foreign_key_check")).toEqual([]);
    expect(old.pragma("integrity_check", { simple: true })).toBe("ok");
    // the index on payments came back, and the ledger rules still hold
    expect(old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_payments_sale'").all()).toHaveLength(1);
    expect(() => old.prepare("DELETE FROM customer_ledger").run()).toThrow(/cannot be changed/);

    // an old sale still reads correctly, and a new sale can take a bank transfer
    const svc = new SaleService(old, "T1");
    expect(svc.get("s2")!.payments.map((p) => [p.method, p.amountMinor, p.label, p.reference])).toEqual([
      ["other", 2_000, "wallet", null],
      ["card", 3_000, null, null],
    ]);
    const fresh = svc.checkout({ lines: [{ productId: "p1", qty: 1 }], payments: [{ method: "bank_transfer", amountMinor: 5_000, reference: "TX-9" }], allowNegativeStock: true });
    expect(fresh.payments).toEqual([expect.objectContaining({ method: "bank_transfer", amountMinor: 5_000, label: "Bank transfer", reference: "TX-9" })]);
    expect(() => old.prepare("INSERT INTO payments (id, sale_id, method, amount_minor) VALUES ('x', 's1', 'cheque', 1)").run()).toThrow(/CHECK/);

    migrate(old); // harmless the second time
    expect(old.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 4 });
  });
});

describe("bank transfer", () => {
  let db: Db;
  let sales: SaleService;
  let shifts: ShiftService;
  let tea: string;
  let shiftId: string;
  let userId: string;
  beforeEach(() => {
    db = openDatabase(":memory:");
    sales = new SaleService(db, "T1");
    shifts = new ShiftService(db);
    tea = new ProductService(db).create({ name: "Tea", priceMinor: 5_000, trackStock: false }).id;
    userId = new UserService(db).create({ name: "Owner", role: "owner", pin: "2468" }).id;
    shiftId = shifts.open(userId, 10_000).id;
  });

  it("is a payment, but never cash in the drawer, and is named on the receipt line", () => {
    const s = sales.checkout({ lines: [{ productId: tea, qty: 2 }], payments: [{ method: "bank_transfer", amountMinor: 10_000, reference: "  HBL 4471  " }], shiftId, userId });
    expect(s.paidMinor).toBe(10_000);
    expect(s.payments[0]).toMatchObject({ method: "bank_transfer", label: "Bank transfer", reference: "HBL 4471" });
    const sum = shifts.summary(shiftId);
    expect(sum.byMethod).toEqual({ bank_transfer: 10_000 });
    expect(sum.cashSalesMinor).toBe(0);
    expect(sum.expectedCashMinor).toBe(10_000); // only the opening float
  });

  it("cannot give change, and a long reference is refused", () => {
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "bank_transfer", amountMinor: 6_000 }] })).toThrow(/Change can only be given from a cash payment/);
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "bank_transfer", amountMinor: 5_000, reference: "x".repeat(81) }] })).toThrow(/at most 80/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sales").get()).toEqual({ n: 0 });
  });

  it("mixes with cash: change comes from the cash part only", () => {
    const s = sales.checkout({ lines: [{ productId: tea, qty: 3 }], payments: [{ method: "bank_transfer", amountMinor: 10_000 }, { method: "cash", amountMinor: 10_000 }], shiftId, userId });
    expect(s).toMatchObject({ totalMinor: 15_000, paidMinor: 20_000, changeMinor: 5_000 });
    const sum = shifts.summary(shiftId);
    expect(sum.byMethod).toEqual({ bank_transfer: 10_000, cash: 5_000 });
    expect(sum.expectedCashMinor).toBe(15_000);
  });
});

describe("duplicate-posting guard", () => {
  let db: Db;
  let sales: SaleService;
  let wings: string;
  const stock = () => (db.prepare("SELECT COALESCE(SUM(qty_delta), 0) AS q FROM stock_movements WHERE product_id = ?").get(wings) as { q: number }).q;
  beforeEach(() => {
    db = openDatabase(":memory:");
    sales = new SaleService(db, "T1");
    const products = new ProductService(db);
    wings = products.create({ name: "Wings", priceMinor: 30_000 }).id;
    new InventoryService(db).adjust(wings, 10, "purchase");
  });
  const cart = (requestId?: string) => ({ lines: [{ productId: wings, qty: 1 }], payments: [{ method: "cash" as const, amountMinor: 30_000 }], requestId });

  it("a repeated request saves one sale, one stock movement and one receipt number", () => {
    const first = sales.checkout(cart("req-0001-aaaa"));
    const second = sales.checkout(cart("req-0001-aaaa"));
    const third = sales.checkout(cart("  req-0001-aaaa  "));
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sales").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 1 });
    expect(stock()).toBe(9);
    expect(db.prepare("SELECT value FROM counters WHERE name = 'receipt'").get()).toEqual({ value: 1 });
    // the next real sale takes the next receipt number
    expect(sales.checkout(cart("req-0002-bbbb")).receiptNo).toBe("T1-000002");
    expect(stock()).toBe(8);
  });

  it("a repeat of the request still works after the stock has run out (nothing is checked again)", () => {
    const only = new ProductService(db).create({ name: "Last one", priceMinor: 100 }).id;
    new InventoryService(db).adjust(only, 1, "purchase");
    const input = { lines: [{ productId: only, qty: 1 }], payments: [{ method: "cash" as const, amountMinor: 100 }], requestId: "req-last-0001" };
    const a = sales.checkout(input);
    expect(sales.checkout(input).id).toBe(a.id);
    expect(() => sales.checkout({ ...input, requestId: "req-last-0002" })).toThrow(/Not enough stock/);
  });

  it("sales without a request id are never treated as repeats", () => {
    sales.checkout(cart());
    sales.checkout(cart());
    expect(db.prepare("SELECT COUNT(*) AS n FROM sales").get()).toEqual({ n: 2 });
  });

  it("refuses a request id that is too short or too long", () => {
    expect(() => sales.checkout(cart("short"))).toThrow(/8 to 100/);
    expect(() => sales.checkout(cart("x".repeat(101)))).toThrow(/8 to 100/);
  });

  it("the database itself refuses a second sale with the same request id", () => {
    const a = sales.checkout(cart("req-db-0001"));
    expect(() =>
      db.prepare(
        `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor, created_at, request_id)
         VALUES ('dup', 'T1-999999', 'completed', 1, 0, 0, 1, 1, 0, 't', 'req-db-0001')`,
      ).run(),
    ).toThrow(/UNIQUE/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sales WHERE id = ?").get(a.id)).toEqual({ n: 1 });
  });

  it("two connections to the same file cannot both post the same request", () => {
    // Two app windows or processes share the file; SQLite lets one writer in at a time and the unique index decides.
    const dir = mkdtempSync(join(tmpdir(), "tillbase-dup-"));
    const path = join(dir, "dup.sqlite");
    const a = openDatabase(path);
    const b = openDatabase(path);
    const pid = new ProductService(a).create({ name: "Rice", priceMinor: 100 }).id;
    new InventoryService(a).adjust(pid, 5, "purchase");
    const input = { lines: [{ productId: pid, qty: 1 }], payments: [{ method: "cash" as const, amountMinor: 100 }], requestId: "req-two-conn-1" };
    const s1 = new SaleService(a, "T1").checkout(input);
    const s2 = new SaleService(b, "T1").checkout(input);
    expect(s2.id).toBe(s1.id);
    expect(a.prepare("SELECT COUNT(*) AS n FROM sales").get()).toEqual({ n: 1 });
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

