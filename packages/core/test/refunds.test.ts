import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CustomerService, FinanceService, InventoryService, ProductService, RecipeService, RefundService, SaleService, ShiftService,
  UserService, can, migrate, migrations, openDatabase, type Db,
} from "../src/index.js";

let db: Db;
let products: ProductService;
let inventory: InventoryService;
let sales: SaleService;
let shifts: ShiftService;
let refunds: RefundService;
let userId: string;
let shiftId: string;
const ctx = () => ({ userId, userName: "Boss", shiftId });
const stock = (id: string) => (db.prepare("SELECT COALESCE(SUM(qty_delta), 0) AS q FROM stock_movements WHERE product_id = ?").get(id) as { q: number }).q;
const stockValue = (id: string) => (db.prepare("SELECT COALESCE(SUM(value_minor), 0) AS v FROM stock_movements WHERE product_id = ?").get(id) as { v: number }).v;
const cashIn = (n: number) => [{ method: "cash" as const, amountMinor: n }];

beforeEach(() => {
  db = openDatabase(":memory:");
  products = new ProductService(db);
  inventory = new InventoryService(db);
  sales = new SaleService(db, "T1");
  shifts = new ShiftService(db);
  refunds = new RefundService(db);
  userId = new UserService(db).create({ name: "Boss", pin: "2468", role: "owner" }).id;
  shiftId = shifts.open(userId, 100_000).id;
});

function sell(lines: { productId: string; qty: number }[], pay: number, extra: Record<string, unknown> = {}) {
  return sales.checkout({ lines, payments: cashIn(pay), shiftId, userId, ...extra });
}

describe("refund amounts", () => {
  it("splits a taxed line in parts that add up to the line to the last unit of money", () => {
    const wrap = products.create({ name: "Wrap", priceMinor: 3_333, taxRateBp: 1_000, trackStock: false }).id;
    // 3 x 33.33 = 99.99, tax 10% = 10.00 (999.9 rounds to 1000), line total 109.99
    const s = sell([{ productId: wrap, qty: 3 }], 11_000);
    const item = s.items[0]!;
    expect(item).toMatchObject({ totalMinor: 10_999, taxMinor: 1_000 });
    const a = refunds.refund({ saleId: s.id, lines: [{ saleItemId: item.id, qty: 1 }], reason: "cold", restock: false, method: "card" }, ctx());
    const b = refunds.refund({ saleId: s.id, lines: [{ saleItemId: item.id, qty: 1 }], reason: "cold", restock: false, method: "card" }, ctx());
    const c = refunds.refund({ saleId: s.id, lines: [{ saleItemId: item.id, qty: 1 }], reason: "cold", restock: false, method: "card" }, ctx());
    // by hand: 10999/3 = 3666.33 -> 3666; two thirds 7332.67 -> 7333, so 3667; the rest 10999 - 7333 = 3666
    expect([a.amountMinor, b.amountMinor, c.amountMinor]).toEqual([3_666, 3_667, 3_666]);
    // tax: 333.33 -> 333; 666.67 -> 667 so 334; the rest 1000 - 667 = 333
    expect([a.taxMinor, b.taxMinor, c.taxMinor]).toEqual([333, 334, 333]);
    expect(a.amountMinor + b.amountMinor + c.amountMinor).toBe(10_999);
    expect(() => refunds.refund({ saleId: s.id, lines: [{ saleItemId: item.id, qty: 1 }], reason: "again", restock: false, method: "card" }, ctx())).toThrow(/already been refunded/);
  });

  it("refuses more than is left, unknown lines, repeats in one request, missing reasons and bad methods", () => {
    const tea = products.create({ name: "Tea", priceMinor: 5_000, trackStock: false }).id;
    const other = sell([{ productId: tea, qty: 1 }], 5_000);
    const s = sell([{ productId: tea, qty: 2 }], 10_000);
    const id = s.items[0]!.id;
    const go = (over: object) => refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "r", restock: false, method: "card", ...over }, ctx());
    expect(() => go({ lines: [{ saleItemId: id, qty: 3 }] })).toThrow(/Only 2 of Tea is left/);
    expect(() => go({ lines: [{ saleItemId: other.items[0]!.id, qty: 1 }] })).toThrow(/not on this sale/);
    expect(() => go({ lines: [{ saleItemId: id, qty: 1 }, { saleItemId: id, qty: 1 }] })).toThrow(/only be listed once/);
    expect(() => go({ lines: [{ saleItemId: id, qty: 0 }] })).toThrow(/more than zero/);
    expect(() => go({ lines: [] })).toThrow(/at least one item/);
    expect(() => go({ reason: "   " })).toThrow(/reason is required/);
    expect(() => go({ method: "cheque" })).toThrow(/how the money is handed back/);
    expect(() => go({ reference: "x".repeat(81) })).toThrow(/at most 80/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM refunds").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'refund'").get()).toEqual({ n: 0 });
  });

  it("a repeated request id refunds once", () => {
    const tea = products.create({ name: "Tea", priceMinor: 5_000, trackStock: false }).id;
    const s = sell([{ productId: tea, qty: 2 }], 10_000);
    const input = { saleId: s.id, lines: [{ saleItemId: s.items[0]!.id, qty: 1 }], reason: "r", restock: false, method: "card" as const, requestId: "refund-req-001" };
    const a = refunds.refund(input, ctx());
    const b = refunds.refund(input, ctx());
    expect(b.id).toBe(a.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM refunds").get()).toEqual({ n: 1 });
  });

  it("refunds cannot be edited or deleted", () => {
    const tea = products.create({ name: "Tea", priceMinor: 5_000, trackStock: false }).id;
    const s = sell([{ productId: tea, qty: 1 }], 5_000);
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: s.items[0]!.id, qty: 1 }], reason: "r", restock: false, method: "card" }, ctx());
    expect(() => db.prepare("UPDATE refunds SET amount_minor = 1").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM refunds").run()).toThrow(/cannot be removed/);
    expect(() => db.prepare("UPDATE refund_items SET qty = 1").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM refund_items").run()).toThrow(/cannot be removed/);
  });
});

describe("refunds and stock", () => {
  let burger: string;
  let bun: string;
  let patty: string;
  let sauce: string;
  beforeEach(() => {
    bun = products.create({ name: "Bun", kind: "ingredient", unit: "each", priceMinor: 0, costMinor: 3_000 }).id;
    patty = products.create({ name: "Patty", kind: "ingredient", unit: "each", priceMinor: 0, costMinor: 7_000 }).id;
    sauce = products.create({ name: "Sauce", kind: "ingredient", unit: "l", priceMinor: 0, costMinor: 3_333 }).id;
    for (const id of [bun, patty, sauce]) inventory.adjust(id, 10, "purchase");
    burger = products.create({ name: "Burger", priceMinor: 25_000, trackStock: false }).id;
    new RecipeService(db).set(burger, [{ ingredientId: bun, qty: 1 }, { ingredientId: patty, qty: 1 }, { ingredientId: sauce, qty: 0.1 }]);
  });

  it("puts back exactly what the line used, in quantity and in cost, over several refunds", () => {
    const before = { bun: stockValue(bun), patty: stockValue(patty), sauce: stockValue(sauce) };
    const s = sell([{ productId: burger, qty: 3 }], 75_000);
    expect([stock(bun), stock(patty)]).toEqual([7, 7]);
    expect(stock(sauce)).toBeCloseTo(9.7, 9);
    // by hand: cost per burger = 3000 + 7000 + 0.1 x 3333 (333.3) ; 3 burgers use sauce 0.3 -> 999.9 rounds to 1000
    expect(s.items[0]!.cogsMinor).toBe(31_000);
    const id = s.items[0]!.id;
    const r1 = refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "wrong order", restock: true, method: "cash" }, ctx());
    expect([stock(bun), stock(patty)]).toEqual([8, 8]);
    expect(r1.restock).toBe(true);
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "wrong order", restock: true, method: "cash" }, ctx());
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "wrong order", restock: true, method: "cash" }, ctx());
    // everything is back: quantities and the value of the stock are what they were before the sale
    expect([stock(bun), stock(patty)]).toEqual([10, 10]);
    expect(stock(sauce)).toBeCloseTo(10, 9);
    expect({ bun: stockValue(bun), patty: stockValue(patty), sauce: stockValue(sauce) }).toEqual(before);
    // the cost of goods sold taken back equals the sale's cost, to the last unit
    const back = db.prepare("SELECT SUM(cogs_minor) AS c FROM refunds").get() as { c: number };
    expect(back.c).toBe(s.items[0]!.cogsMinor);
    expect(refunds.forSale(s.id).reduce((a, r) => a + r.amountMinor, 0)).toBe(75_000);
  });

  it("without restocking the stock stays used up and no cost comes back", () => {
    const s = sell([{ productId: burger, qty: 2 }], 50_000);
    const r = refunds.refund({ saleId: s.id, lines: [{ saleItemId: s.items[0]!.id, qty: 1 }], reason: "dropped", restock: false, method: "cash" }, ctx());
    expect(stock(bun)).toBe(8);
    expect(r.lines[0]!.restocked).toBe(false);
    expect(db.prepare("SELECT cogs_minor AS c FROM refunds").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reason = 'refund'").get()).toEqual({ n: 0 });
  });

  it("a part restocked and a part not still add up when the rest is restocked", () => {
    const s = sell([{ productId: burger, qty: 2 }], 50_000);
    const id = s.items[0]!.id;
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "dropped", restock: false, method: "card" }, ctx());
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "sealed, unopened", restock: true, method: "card" }, ctx());
    expect(stock(bun)).toBe(9); // one burger's worth back, the dropped one stays lost
    expect(stock(patty)).toBe(9);
  });

  it("a voided sale cannot be refunded, and a sale with a refund cannot be voided", () => {
    const a = sell([{ productId: burger, qty: 1 }], 25_000);
    sales.voidSale(a.id, "mistake");
    expect(() => refunds.refund({ saleId: a.id, lines: [{ saleItemId: a.items[0]!.id, qty: 1 }], reason: "r", restock: true, method: "cash" }, ctx())).toThrow(/voided/);
    const b = sell([{ productId: burger, qty: 2 }], 50_000);
    refunds.refund({ saleId: b.id, lines: [{ saleItemId: b.items[0]!.id, qty: 1 }], reason: "r", restock: true, method: "cash" }, ctx());
    expect(() => sales.voidSale(b.id, "oops")).toThrow(/already been refunded/);
    expect(refunds.refundable(b.id).lines[0]).toMatchObject({ qty: 2, refundedQty: 1, remainingQty: 1, remainingMinor: 25_000 });
  });
});

describe("sales that cannot be part-refunded", () => {
  it("explains why for khata, points and wallet sales, and changes nothing", () => {
    const customers = new CustomerService(db);
    const tea = products.create({ name: "Tea", priceMinor: 10_000, trackStock: false }).id;
    const c = customers.create({ name: "Ayesha", phone: "0300 1234567" }).id;
    customers.adjustPoints(c, 50, "gift");
    customers.topUp(c, 20_000, "cash", userId);
    const account = sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [], customerId: c, onAccountMinor: 10_000, shiftId, userId });
    expect(refunds.refundable(account.id)).toMatchObject({ allowed: false, blockedReason: expect.stringMatching(/customer's account/) });
    expect(() => refunds.refund({ saleId: account.id, lines: [{ saleItemId: account.items[0]!.id, qty: 1 }], reason: "r", restock: false, method: "cash" }, ctx())).toThrow(/customer's account/);
    const wallet = sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [], customerId: c, walletMinor: 10_000, shiftId, userId });
    expect(refunds.refundable(wallet.id).blockedReason).toMatch(/wallet/);
    const points = sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: cashIn(10_000), customerId: c, redeemPoints: 5, shiftId, userId });
    expect(refunds.refundable(points.id).blockedReason).toMatch(/loyalty points/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM refunds").get()).toEqual({ n: 0 });
  });

  it("takes back the same share of earned points as of the bill, never more than the customer has", () => {
    const customers = new CustomerService(db);
    const tea = products.create({ name: "Tea", priceMinor: 10_000, trackStock: false }).id;
    const c = customers.create({ name: "Bilal", phone: "0301 1234567" }).id;
    // default loyalty: 1 point per 100.00 spent. 4 teas = 400.00 -> 4 points
    const s = sales.checkout({ lines: [{ productId: tea, qty: 4 }], payments: cashIn(40_000), customerId: c, shiftId, userId });
    expect(s.pointsEarned).toBe(4);
    const id = s.items[0]!.id;
    const a = refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 2 }], reason: "r", restock: false, method: "cash" }, ctx());
    expect(customers.get(c)!.points).toBe(2); // half the bill back, half the points
    expect(db.prepare("SELECT points_reversed AS p FROM refunds WHERE id = ?").get(a.id)).toEqual({ p: 2 });
    // the customer spends one point elsewhere, then the rest of the sale is refunded: only what they still have comes back
    customers.adjustPoints(c, -1, "used elsewhere");
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 2 }], reason: "r", restock: false, method: "cash" }, ctx());
    expect(customers.get(c)!.points).toBe(0);
  });
});

describe("refunds, the drawer and closed shifts", () => {
  let tea: string;
  beforeEach(() => {
    tea = products.create({ name: "Tea", priceMinor: 10_000, trackStock: false }).id;
  });

  it("a cash refund leaves the open drawer as a visible movement; a card refund does not", () => {
    const s = sell([{ productId: tea, qty: 3 }], 30_000);
    const id = s.items[0]!.id;
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "cold tea", restock: false, method: "cash" }, ctx());
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "cold tea", restock: false, method: "card", reference: "slip 55" }, ctx());
    const sum = shifts.summary(shiftId);
    // float 100000 + cash sales 30000 - cash refund 10000 (the card refund is not drawer money)
    expect(sum.expectedCashMinor).toBe(120_000);
    expect(sum.cashOutMinor).toBe(10_000);
    expect(sum.refundCashOutMinor).toBe(10_000);
    expect(sum.movements).toEqual([expect.objectContaining({ amountMinor: -10_000, reason: expect.stringContaining("cold tea") })]);
    expect(db.prepare("SELECT ref_type AS t FROM cash_movements").get()).toEqual({ t: "refund" });
  });

  it("refuses a cash refund the drawer cannot cover, and records nothing", () => {
    const other = new UserService(db).create({ name: "Night", pin: "1357", role: "manager" }).id;
    const s = sell([{ productId: tea, qty: 1 }], 10_000);
    shifts.close(shiftId, 110_000);
    const night = shifts.open(other, 2_000).id; // a small float
    expect(() => refunds.refund({ saleId: s.id, lines: [{ saleItemId: s.items[0]!.id, qty: 1 }], reason: "r", restock: false, method: "cash" }, { userId: other, userName: "Night", shiftId: night })).toThrow(/not enough cash in the drawer/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM refunds").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM cash_movements").get()).toEqual({ n: 0 });
  });

  it("after a shift is closed its figures never change; the refund lands in the shift open now", () => {
    const other = new UserService(db).create({ name: "Night", pin: "1357", role: "manager" }).id;
    const s = sell([{ productId: tea, qty: 3 }], 30_000);
    const closed = shifts.close(shiftId, 130_000);
    const frozen = JSON.stringify(shifts.summary(shiftId));
    expect(closed).toMatchObject({ expectedCashMinor: 130_000 });
    const night = shifts.open(other, 50_000).id;

    const r = refunds.refund({ saleId: s.id, lines: [{ saleItemId: s.items[0]!.id, qty: 2 }], reason: "customer returned", restock: false, method: "cash" }, { userId: other, userName: "Night", shiftId: night });
    expect(r.shiftId).toBe(night);
    expect(JSON.stringify(shifts.summary(shiftId))).toBe(frozen);
    expect(db.prepare("SELECT expected_cash_minor AS e, counted_cash_minor AS c, variance_minor AS v FROM shifts WHERE id = ?").get(shiftId)).toEqual({ e: 130_000, c: 130_000, v: 0 });
    const tonight = shifts.summary(night);
    expect(tonight).toMatchObject({ cashOutMinor: 20_000, refundCashOutMinor: 20_000, expectedCashMinor: 30_000 });
    expect(tonight.movements[0]!.reason).toContain("customer returned");
  });

  it("voiding a sale after its shift closed leaves that shift's figures alone", () => {
    const s = sell([{ productId: tea, qty: 2 }], 20_000);
    shifts.close(shiftId, 120_000);
    const frozen = JSON.stringify(shifts.summary(shiftId));
    sales.voidSale(s.id, "rang up twice");
    expect(JSON.stringify(shifts.summary(shiftId))).toBe(frozen);
  });

  it("voiding inside the same open shift still takes the sale out of it", () => {
    const s = sell([{ productId: tea, qty: 2 }], 20_000);
    expect(shifts.summary(shiftId).expectedCashMinor).toBe(120_000);
    sales.voidSale(s.id, "mistake");
    expect(shifts.summary(shiftId)).toMatchObject({ salesCount: 0, expectedCashMinor: 100_000 });
  });
});

describe("refunds in profit and loss", () => {
  it("takes refunded sales and tax off the day, and the cost only when the goods were restocked", () => {
    const bun = products.create({ name: "Bun", kind: "ingredient", unit: "each", priceMinor: 0, costMinor: 4_000 }).id;
    inventory.adjust(bun, 20, "purchase");
    const burger = products.create({ name: "Burger", priceMinor: 11_000, taxRateBp: 1_000 }).id;
    new RecipeService(db).set(burger, [{ ingredientId: bun, qty: 1 }]);
    // 4 burgers: sales 44,000 + tax 4,400; cost 16,000
    const s = sell([{ productId: burger, qty: 4 }], 48_400);
    const id = s.items[0]!.id;
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "a", restock: true, method: "cash" }, ctx());
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: id, qty: 1 }], reason: "b", restock: false, method: "cash" }, ctx());
    const today = new Date().toISOString().slice(0, 10);
    const pl = new FinanceService(db).profitAndLoss(today, today);
    // two burgers refunded: revenue 44,000 - 22,000 = 22,000; tax 4,400 - 2,200 = 2,200
    // cost: 16,000 less the one restocked burger (4,000) = 12,000; the dropped one stays a cost
    expect(pl).toMatchObject({ salesCount: 1, refundCount: 2, refundsMinor: 22_000, netSalesMinor: 22_000, taxCollectedMinor: 2_200, cogsMinor: 12_000, grossProfitMinor: 10_000 });
    expect(pl.items[0]).toMatchObject({ name: "Burger", qty: 2, salesMinor: 22_000, cogsMinor: 12_000 });
  });
});

describe("permission", () => {
  it("managers and owners may refund; cashiers may not", () => {
    expect(can("manager", "refund")).toBe(true);
    expect(can("owner", "refund")).toBe(true);
    expect(can("cashier", "refund")).toBe(false);
  });
});

describe("upgrading from v6 to v11", () => {
  it("keeps every old row; old sales refund without restocking, and simple ones can restock too", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    for (const m of migrations.slice(0, 6)) old.exec(m.sql);
    old.pragma("user_version = 6");
    old.prepare("INSERT INTO users (id, name, role, pin_salt, pin_hash, active, created_at) VALUES ('u1', 'Boss', 'owner', 's', 'x', 1, 't')").run();
    old.prepare("INSERT INTO products (id, name, kind, unit, price_minor, tax_rate_bp, track_stock, avg_cost, active, created_at, updated_at) VALUES ('p1', 'Tea', 'product', 'each', 5000, 0, 1, 2000, 1, 't', 't')").run();
    old.prepare("INSERT INTO stock_movements (id, product_id, qty_delta, reason, created_at, value_minor) VALUES ('m0', 'p1', 10, 'purchase', 't', 20000)").run();
    old.prepare(
      `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor, created_at)
       VALUES ('s1', 'R-000001', 'completed', 10000, 0, 0, 10000, 10000, 0, '2026-01-01T09:00:00Z')`,
    ).run();
    old.prepare("INSERT INTO sale_items (id, sale_id, product_id, name, qty, unit_price_minor, discount_minor, tax_rate_bp, tax_minor, total_minor, cogs_minor) VALUES ('i1', 's1', 'p1', 'Tea', 2, 5000, 0, 0, 0, 10000, 4000)").run();
    old.prepare("INSERT INTO payments (id, sale_id, method, amount_minor) VALUES ('pay1', 's1', 'cash', 10000)").run();
    old.prepare("INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor) VALUES ('m1', 'p1', -2, 'sale', 'sale', 's1', '2026-01-01T09:00:00Z', -4000)").run();

    migrate(old);
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.at(-1)!.version);
    expect(old.pragma("foreign_key_check")).toEqual([]);
    expect(old.prepare("SELECT items_linked FROM sales").get()).toEqual({ items_linked: 0 });
    expect(old.prepare("SELECT qty_delta, value_minor FROM stock_movements WHERE id = 'm1'").get()).toEqual({ qty_delta: -2, value_minor: -4000 });

    const svc = new RefundService(old);
    const sh = new ShiftService(old).open("u1", 50_000).id;
    const r = svc.refund({ saleId: "s1", lines: [{ saleItemId: "i1", qty: 1 }], reason: "old sale", restock: true, method: "cash" }, { userId: "u1", userName: "Boss", shiftId: sh });
    expect(r.amountMinor).toBe(5_000);
    // the old movement is found by product and put back in proportion: one of two units, half the cost
    expect(old.prepare("SELECT qty_delta, value_minor, ref_type FROM stock_movements WHERE reason = 'refund'").all()).toEqual([{ qty_delta: 1, value_minor: 2_000, ref_type: "refund" }]);
    expect(old.prepare("SELECT cogs_minor FROM refunds").get()).toEqual({ cogs_minor: 2_000 });
    migrate(old);
    expect(old.prepare("SELECT COUNT(*) AS n FROM refunds").get()).toEqual({ n: 1 });
  });
});
