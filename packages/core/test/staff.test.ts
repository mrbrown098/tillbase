import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  InventoryService,
  ProductService,
  SaleService,
  ShiftService,
  UserService,
  can,
  migrate,
  migrations,
  openDatabase,
  type Db,
} from "../src/index.js";

let db: Db;
let clock: number;
let users: UserService;
let shifts: ShiftService;
let sales: SaleService;
let products: ProductService;
let inventory: InventoryService;

beforeEach(() => {
  db = openDatabase(":memory:");
  clock = 1_000_000;
  users = new UserService(db, () => clock);
  shifts = new ShiftService(db);
  sales = new SaleService(db, "T1");
  products = new ProductService(db);
  inventory = new InventoryService(db);
});

describe("migrations", () => {
  it("upgrades a real v1 database with data in it, keeping every row", () => {
    // Create a database exactly as version 1 of the app left it.
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    old.exec(migrations[0]!.sql);
    old.pragma("user_version = 1");
    old.prepare(
      `INSERT INTO products (id, name, price_minor, cost_minor, tax_rate_bp, track_stock,
         reorder_level, active, created_at, updated_at) VALUES ('p1','Old',100,0,0,1,0,1,'t','t')`,
    ).run();
    old.prepare(
      `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor, tax_minor,
         total_minor, paid_minor, change_minor, created_at)
       VALUES ('s1','R-000001','completed',100,0,0,100,100,0,'2026-01-01T00:00:00Z')`,
    ).run();

    migrate(old);

    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
    const sale = new SaleService(old).get("s1");
    expect(sale?.totalMinor).toBe(100);
    expect(sale?.shiftId).toBeNull();
    expect(sale?.userId).toBeNull();
    expect(new ProductService(old).get("p1")?.name).toBe("Old");
    // New tables exist and work after the upgrade.
    expect(new UserService(old).count()).toBe(0);
    migrate(old); // running again is harmless
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
  });
});

describe("users and PINs", () => {
  it("creates users and logs in with the right PIN only", () => {
    const u = users.create({ name: "Ali", pin: "1234", role: "cashier" });
    expect(users.authenticate(u.id, "1234").name).toBe("Ali");
    expect(() => users.authenticate(u.id, "9999")).toThrow(/Wrong PIN/);
    expect(() => users.authenticate("nobody", "1234")).toThrow(/Wrong PIN/);
  });

  it("never stores the PIN in the database", () => {
    users.create({ name: "Ali", pin: "4821", role: "owner" });
    const row = db.prepare("SELECT * FROM users").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain("4821");
    expect(row.pin_hash).toHaveLength(64);
  });

  it("validates PIN format and names", () => {
    expect(() => users.create({ name: "A", pin: "12", role: "cashier" })).toThrow(/4 to 8 digits/);
    expect(() => users.create({ name: "A", pin: "12ab", role: "cashier" })).toThrow(/digits/);
    expect(() => users.create({ name: " ", pin: "1234", role: "cashier" })).toThrow(/Name/);
    users.create({ name: "Sara", pin: "1234", role: "cashier" });
    expect(() => users.create({ name: "sara", pin: "5678", role: "manager" })).toThrow(/already exists/);
  });

  it("locks an account after 5 wrong PINs, then unlocks after 30 seconds", () => {
    const u = users.create({ name: "Ali", pin: "1234", role: "cashier" });
    for (let i = 0; i < 5; i++) expect(() => users.authenticate(u.id, "0000")).toThrow(/Wrong PIN/);
    expect(() => users.authenticate(u.id, "1234")).toThrow(/Too many wrong PINs/);
    clock += 31_000;
    expect(users.authenticate(u.id, "1234").id).toBe(u.id);
  });

  it("rejects login for deactivated staff", () => {
    const owner = users.create({ name: "Boss", pin: "1111", role: "owner" });
    const u = users.create({ name: "Ali", pin: "1234", role: "cashier" });
    users.update(u.id, { active: false });
    expect(() => users.authenticate(u.id, "1234")).toThrow(/Wrong PIN/);
    expect(users.list().map((x) => x.id)).toEqual([owner.id]);
    expect(users.list({ includeInactive: true })).toHaveLength(2);
  });

  it("changes a PIN", () => {
    const u = users.create({ name: "Ali", pin: "1234", role: "cashier" });
    users.changePin(u.id, "7777");
    expect(() => users.authenticate(u.id, "1234")).toThrow();
    expect(users.authenticate(u.id, "7777").id).toBe(u.id);
  });

  it("always keeps at least one active owner", () => {
    const owner = users.create({ name: "Boss", pin: "1111", role: "owner" });
    expect(() => users.update(owner.id, { role: "manager" })).toThrow(/at least one active owner/);
    expect(() => users.update(owner.id, { active: false })).toThrow(/at least one active owner/);
    const second = users.create({ name: "Second", pin: "2222", role: "owner" });
    users.update(owner.id, { role: "manager" });
    expect(() => users.update(second.id, { active: false })).toThrow(/at least one active owner/);
  });
});

describe("permissions", () => {
  it("gives each role the right powers", () => {
    expect(can("cashier", "sell")).toBe(true);
    expect(can("cashier", "void")).toBe(false);
    expect(can("cashier", "discount")).toBe(false);
    expect(can("manager", "void")).toBe(true);
    expect(can("manager", "users.manage")).toBe(false);
    expect(can("owner", "users.manage")).toBe(true);
    expect(can("owner", "settings.manage")).toBe(true);
  });
});

describe("shifts", () => {
  function setup() {
    const cashier = users.create({ name: "Ali", pin: "1234", role: "cashier" });
    const p = products.create({ name: "Tea", priceMinor: 500 });
    inventory.adjust(p.id, 100, "purchase");
    return { cashier, p };
  }

  it("allows only one open shift", () => {
    const { cashier } = setup();
    shifts.open(cashier.id, 10000);
    expect(() => shifts.open(cashier.id, 0)).toThrow(/already open/);
    expect(shifts.current()?.userName).toBe("Ali");
  });

  it("works out expected cash and the variance at close", () => {
    const { cashier, p } = setup();
    const shift = shifts.open(cashier.id, 10000); // 100.00 float
    // Cash sale 5.00 paid with 10.00 -> keeps 5.00
    sales.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 1000 }],
      shiftId: shift.id,
      userId: cashier.id,
    });
    // Card sale 10.00 -> not in the drawer
    sales.checkout({
      lines: [{ productId: p.id, qty: 2 }],
      payments: [{ method: "card", amountMinor: 1000 }],
      shiftId: shift.id,
      userId: cashier.id,
    });
    shifts.addCashMovement(shift.id, cashier.id, 2000, "float top-up");
    shifts.addCashMovement(shift.id, cashier.id, -300, "bought milk");

    const s = shifts.summary(shift.id);
    expect(s.salesCount).toBe(2);
    expect(s.salesTotalMinor).toBe(1500);
    expect(s.cashSalesMinor).toBe(500);
    expect(s.byMethod).toEqual({ cash: 500, card: 1000 });
    expect(s.cashInMinor).toBe(2000);
    expect(s.cashOutMinor).toBe(300);
    expect(s.expectedCashMinor).toBe(10000 + 500 + 2000 - 300);

    const closed = shifts.close(shift.id, 12100, "all good");
    expect(closed.shift.status).toBe("closed");
    expect(closed.shift.expectedCashMinor).toBe(12200);
    expect(closed.shift.varianceMinor).toBe(-100); // 1.00 short
    expect(shifts.current()).toBeUndefined();
    expect(() => shifts.close(shift.id, 0)).toThrow(/already closed/);
  });

  it("excludes voided sales from the shift's cash", () => {
    const { cashier, p } = setup();
    const shift = shifts.open(cashier.id, 0);
    const sale = sales.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 500 }],
      shiftId: shift.id,
    });
    expect(shifts.summary(shift.id).expectedCashMinor).toBe(500);
    sales.voidSale(sale.id, "mistake");
    expect(shifts.summary(shift.id).expectedCashMinor).toBe(0);
    expect(shifts.summary(shift.id).salesCount).toBe(0);
  });

  it("validates cash movements", () => {
    const { cashier } = setup();
    const shift = shifts.open(cashier.id, 1000);
    expect(() => shifts.addCashMovement(shift.id, cashier.id, 0, "x")).toThrow(/non-zero/);
    expect(() => shifts.addCashMovement(shift.id, cashier.id, 100, " ")).toThrow(/reason/);
    expect(() => shifts.addCashMovement(shift.id, cashier.id, -5000, "too much")).toThrow(/not that much/);
    shifts.close(shift.id, 1000);
    expect(() => shifts.addCashMovement(shift.id, cashier.id, 100, "late")).toThrow(/closed/);
  });

  it("rejects bad opening and counted amounts", () => {
    const { cashier } = setup();
    expect(() => shifts.open(cashier.id, -1)).toThrow(/Opening cash/);
    expect(() => shifts.open(cashier.id, 1.5)).toThrow(/Opening cash/);
    const shift = shifts.open(cashier.id, 0);
    expect(() => shifts.close(shift.id, -5)).toThrow(/Counted cash/);
  });

  it("lists recent shifts newest first", () => {
    const { cashier } = setup();
    const a = shifts.open(cashier.id, 0);
    shifts.close(a.id, 0);
    const b = shifts.open(cashier.id, 0);
    expect(shifts.recent().map((s) => s.id)).toEqual([b.id, a.id]);
  });
});

describe("PIN length for the sign-in screen", () => {
  it("remembers how many digits each PIN has, and updates it when the PIN changes", () => {
    const d = openDatabase(":memory:");
    const u = new UserService(d);
    const eight = u.create({ name: "Boss", pin: "12345678", role: "owner" });
    const four = u.create({ name: "Sara", pin: "4321", role: "cashier" });
    expect(eight.pinLength).toBe(8);
    expect(four.pinLength).toBe(4);
    u.changePin(four.id, "654321");
    expect(u.get(four.id)!.pinLength).toBe(6);
  });

  it("learns the length of an older account the first time it signs in", () => {
    const d = openDatabase(":memory:");
    const u = new UserService(d);
    const old = u.create({ name: "Old", pin: "123456", role: "manager" });
    d.prepare("UPDATE users SET pin_length = NULL WHERE id = ?").run(old.id);
    expect(u.get(old.id)!.pinLength).toBeNull();
    u.authenticate(old.id, "123456");
    expect(u.get(old.id)!.pinLength).toBe(6);
  });

  it("does not record anything for a wrong PIN", () => {
    const d = openDatabase(":memory:");
    const u = new UserService(d);
    const old = u.create({ name: "Old", pin: "123456", role: "manager" });
    d.prepare("UPDATE users SET pin_length = NULL WHERE id = ?").run(old.id);
    expect(() => u.authenticate(old.id, "99999")).toThrow("Wrong PIN");
    expect(u.get(old.id)!.pinLength).toBeNull();
  });
});
