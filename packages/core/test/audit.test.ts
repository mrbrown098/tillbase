import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditService, FinanceService, InventoryService, ProductService, RefundService, SaleService, ShiftService, UserService,
  backupDatabase, can, flushPendingAudit, listBackups, migrate, openDatabase, queueAuditAfterRestore, restoreFromBackup, type Db,
} from "../src/index.js";
import Database from "better-sqlite3";
import { migrations } from "../src/index.js";

let db: Db;
let audit: AuditService;
beforeEach(() => {
  db = openDatabase(":memory:");
  audit = new AuditService(db);
});

describe("the audit trail", () => {
  it("only the owner may read it", () => {
    expect(can("owner", "audit.view")).toBe(true);
    expect(can("manager", "audit.view")).toBe(false);
    expect(can("cashier", "audit.view")).toBe(false);
  });

  it("refuses UPDATE and DELETE, however they are written", () => {
    audit.record({ action: "sale.void", entity: "sale", entityId: "s1", summary: "Voided R-1" });
    expect(() => db.prepare("UPDATE audit_log SET summary = 'nothing happened'").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("UPDATE audit_log SET user_name = 'someone else' WHERE seq = 1").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM audit_log").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM audit_log WHERE seq = 1").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("INSERT OR REPLACE INTO audit_log (seq, at, action, entity, summary) VALUES (1, 't', 'x', 'x', 'overwritten')").run()).toThrow();
    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0]!.summary).toBe("Voided R-1");
  });

  it("closes the same gap on the customer ledger", () => {
    db.prepare("INSERT INTO customers (id, name, phone, created_at) VALUES ('c1', 'A', '0300 1234567', 't')").run();
    db.prepare("INSERT INTO customer_ledger (id, customer_id, account, delta, reason, created_at) VALUES ('l1', 'c1', 'wallet', 500, 'topup', 't')").run();
    expect(() => db.prepare("INSERT OR REPLACE INTO customer_ledger (id, customer_id, account, delta, reason, created_at) VALUES ('l1', 'c1', 'wallet', 999999, 'topup', 't')").run()).toThrow(/cannot be changed/);
    expect(db.prepare("SELECT delta FROM customer_ledger WHERE id = 'l1'").get()).toEqual({ delta: 500 });
  });

  it("numbers entries without ever reusing a number", () => {
    const a = audit.record({ action: "a.b", entity: "x", summary: "one" });
    const b = audit.record({ action: "a.b", entity: "x", summary: "two" });
    expect(b).toBe(a + 1);
    expect(audit.list().map((e) => e.seq)).toEqual([b, a]);
  });

  it("hides PINs and other secrets wherever they are, but not harmless words that contain them", () => {
    audit.record({
      action: "user.update",
      entity: "user",
      summary: "Changed Ali",
      detail: { pin: "1234", newPin: "9999", nested: { pin_hash: "abc", shippingNote: "fast", list: [{ apiKey: "k" }] }, name: "Ali", spinach: 3 },
    });
    const d = audit.list()[0]!.detail as Record<string, unknown>;
    expect(JSON.stringify(d)).not.toMatch(/1234|9999|abc/);
    expect(d).toMatchObject({ pin: "[hidden]", newPin: "[hidden]", name: "Ali", spinach: 3 });
    expect(d.nested).toMatchObject({ pin_hash: "[hidden]", shippingNote: "fast" });
  });

  it("keeps a too-long detail from becoming a way to fill the disk", () => {
    audit.record({ action: "x.y", entity: "x", summary: "big", detail: { lines: Array.from({ length: 50 }, (_, i) => ({ i, text: "z".repeat(290) })) } });
    expect(audit.list()[0]!.detail).toEqual({ truncated: true, note: "Details were too long to keep" });
  });

  it("filters by day, action and person, and pages backwards", () => {
    const ins = db.prepare("INSERT INTO audit_log (at, user_id, user_name, action, entity, summary) VALUES (?, ?, ?, ?, 'x', 's')");
    // Local noon on three days, so the business-day boundaries are far from the test times in any time zone.
    const at = (day: string) => new Date(`${day}T12:00:00`).toISOString();
    ins.run(at("2026-03-01"), "u1", "Ali", "sale.void");
    ins.run(at("2026-03-02"), "u2", "Mona", "sale.refund");
    ins.run(at("2026-03-02"), "u1", "Ali", "sale.refund");
    ins.run(at("2026-03-03"), "u1", "Ali", "login.failed");
    expect(audit.list({ from: "2026-03-02", to: "2026-03-02" })).toHaveLength(2);
    expect(audit.list({ from: "2026-03-02" })).toHaveLength(3);
    expect(audit.list({ to: "2026-03-01" })).toHaveLength(1);
    expect(audit.list({ action: "sale.refund" })).toHaveLength(2);
    expect(audit.list({ userId: "u1" })).toHaveLength(3);
    const page1 = audit.list({ limit: 2 });
    expect(page1.map((e) => e.seq)).toEqual([4, 3]);
    expect(audit.list({ limit: 2, beforeSeq: page1[1]!.seq }).map((e) => e.seq)).toEqual([2, 1]);
    expect(() => audit.list({ from: "03/01/2026" })).toThrow();
    expect(audit.list({ limit: 99999 })).toHaveLength(4);
  });

  it("needs an action, an entity and a summary", () => {
    expect(() => audit.record({ action: "", entity: "x", summary: "s" })).toThrow(/needs an action/);
    expect(() => audit.record({ action: "a", entity: "x", summary: " " })).toThrow(/needs an action/);
  });

  it("upgrades from a v6 database with its data untouched", () => {
    const old = new Database(":memory:");
    for (const m of migrations.slice(0, 6)) old.exec(m.sql);
    old.pragma("user_version = 6");
    old.prepare("INSERT INTO products (id, name, kind, unit, price_minor, tax_rate_bp, track_stock, avg_cost, active, created_at, updated_at) VALUES ('p1', 'Tea', 'product', 'each', 5000, 0, 0, 0, 1, 't', 't')").run();
    const before = old.prepare("SELECT id, name, price_minor FROM products").all();
    migrate(old);
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.at(-1)!.version);
    expect(old.prepare("SELECT id, name, price_minor FROM products").all()).toEqual(before);
    expect(old.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
    expect(() => old.prepare("INSERT INTO audit_log (at, action, entity, summary) VALUES ('t', 'a', 'b', 'c')").run()).not.toThrow();
    expect(() => old.prepare("DELETE FROM audit_log").run()).toThrow(/cannot be changed/);
  });
});

describe("restore drill", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-restore-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("backup, change things, restore: every total is the same as at backup time, the trail is intact, and the restore is noted", async () => {
    const path = join(dir, "shop.sqlite");
    let live = openDatabase(path);
    const users = new UserService(live);
    const owner = users.create({ name: "Boss", pin: "2468", role: "owner" });
    const products = new ProductService(live);
    const tea = products.create({ name: "Tea", priceMinor: 5_000 }).id;
    new InventoryService(live).adjust(tea, 50, "purchase");
    const shift = new ShiftService(live).open(owner.id, 10_000).id;
    const sales = new SaleService(live, "T1");
    const s1 = sales.checkout({ lines: [{ productId: tea, qty: 4 }], payments: [{ method: "cash", amountMinor: 20_000 }], shiftId: shift, userId: owner.id });
    sales.checkout({ lines: [{ productId: tea, qty: 2 }], payments: [{ method: "bank_transfer", amountMinor: 10_000, reference: "TX1" }], shiftId: shift, userId: owner.id });
    new RefundService(live).refund({ saleId: s1.id, lines: [{ saleItemId: s1.items[0]!.id, qty: 1 }], reason: "cold", restock: true, method: "cash" }, { userId: owner.id, userName: "Boss", shiftId: shift });
    new AuditService(live).record({ userId: owner.id, userName: "Boss", action: "sale.refund", entity: "refund", summary: "before the backup" });

    const totals = (d: Db) => {
      const today = new Date().toISOString().slice(0, 10);
      const pl = new FinanceService(d).profitAndLoss(today, today);
      return {
        sales: d.prepare("SELECT COUNT(*) AS n, SUM(total_minor) AS t FROM sales").get(),
        payments: d.prepare("SELECT method, SUM(amount_minor) AS a FROM payments GROUP BY method ORDER BY method").all(),
        refunds: d.prepare("SELECT COUNT(*) AS n, SUM(amount_minor) AS a FROM refunds").get(),
        stock: d.prepare("SELECT SUM(qty_delta) AS q, SUM(value_minor) AS v FROM stock_movements").get(),
        shift: new ShiftService(d).summary(shift),
        pl: { net: pl.netSalesMinor, cogs: pl.cogsMinor, profit: pl.grossProfitMinor },
        audit: d.prepare("SELECT COUNT(*) AS n FROM audit_log").get(),
      };
    };
    const atBackup = totals(live);
    const file = await backupDatabase(live, join(dir, "backups"));

    // life goes on after the backup: another sale and another audit entry
    sales.checkout({ lines: [{ productId: tea, qty: 5 }], payments: [{ method: "cash", amountMinor: 25_000 }], shiftId: shift, userId: owner.id });
    new AuditService(live).record({ action: "sale.void", entity: "sale", summary: "after the backup" });
    expect(totals(live)).not.toEqual(atBackup);

    const result = restoreFromBackup({ dbPath: path, backupFile: file, closeLive: () => live.close() });
    expect(readdirSync(dir).some((f) => f.includes("before-restore"))).toBe(true);
    expect(result).toBeTruthy();
    queueAuditAfterRestore(path, { userId: owner.id, userName: "Boss", action: "backup.restore", entity: "backup", entityId: "x", summary: "Restored data from backup x" });

    live = openDatabase(path);
    expect(flushPendingAudit(live, path)).toBe(true);
    expect(flushPendingAudit(live, path)).toBe(false); // written once

    const restored = totals(live);
    expect({ ...restored, audit: undefined }).toEqual({ ...atBackup, audit: undefined });
    const trail = new AuditService(live).list().map((e) => e.summary);
    expect(trail).toContain("before the backup");
    expect(trail).not.toContain("after the backup");
    expect(trail[0]).toBe("Restored data from backup x"); // newest first
    expect((restored.audit as { n: number }).n).toBe((atBackup.audit as { n: number }).n + 1);
    // the restored file still refuses edits to the trail
    expect(() => live.prepare("DELETE FROM audit_log").run()).toThrow(/cannot be changed/);
    expect(listBackups(join(dir, "backups"))).toHaveLength(1);
    live.close();
  });

  it("a damaged parked note never stops the shop opening", () => {
    const path = join(dir, "shop2.sqlite");
    const d = openDatabase(path);
    writeFileSync(`${path}.audit-pending.json`, "{not json");
    expect(flushPendingAudit(d, path)).toBe(false);
    expect(new AuditService(d).list()).toHaveLength(0);
    d.close();
  });
});
