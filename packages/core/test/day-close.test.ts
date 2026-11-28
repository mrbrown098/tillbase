import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DayCloseService, ProductService, RefundService, SaleService, ShiftService, UserService, openDatabase, type Db,
} from "../src/index.js";

let db: Db;
let products: ProductService;
let sales: SaleService;
let shifts: ShiftService;
let refunds: RefundService;
let dayClose: DayCloseService;
let userId: string;
let tea: string;

const at = (day: number, h: number, m = 0) => vi.setSystemTime(new Date(2026, 2, day, h, m, 0, 0));
const D1 = "2026-03-10";
const D2 = "2026-03-11";
const cash = (n: number) => [{ method: "cash" as const, amountMinor: n }];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(10, 9);
  db = openDatabase(":memory:");
  products = new ProductService(db);
  sales = new SaleService(db, "T1");
  shifts = new ShiftService(db);
  refunds = new RefundService(db);
  dayClose = new DayCloseService(db);
  userId = new UserService(db).create({ name: "Boss", pin: "2468", role: "owner" }).id;
  tea = products.create({ name: "Tea", priceMinor: 10_000, taxRateBp: 1_000, trackStock: false }).id;
});
afterEach(() => vi.useRealTimers());

function sell(shiftId: string, payments: { method: "cash" | "card" | "bank_transfer"; amountMinor: number }[], qty = 1, discountMinor = 0) {
  return sales.checkout({ lines: [{ productId: tea, qty, discountMinor }], payments, shiftId, userId });
}

describe("day-close report", () => {
  it("adds up a plain day by method, with change, discount, tax and a counted drawer", () => {
    const sh = shifts.open(userId, 50_000).id;
    at(10, 10);
    sell(sh, cash(12_000)); // 100.00 + 10.00 tax = 110.00, change 10.00
    sell(sh, [{ method: "card", amountMinor: 11_000 }]);
    sell(sh, [{ method: "bank_transfer", amountMinor: 9_900 }], 1, 1_000); // 90.00 + 9.00 tax = 99.00
    at(10, 22);
    shifts.close(sh, 60_500);
    const r = dayClose.report(D1);

    expect(r).toMatchObject({
      date: D1, salesCount: 3, grossSalesMinor: 30_000, discountsMinor: 1_000, taxMinor: 2_900, billedMinor: 31_900,
      voidCount: 0, refundCount: 0, refundedMinor: 0, netTakingsMinor: 31_900, onAccountMinor: 0,
      receivedByMethod: { cash: 11_000, card: 11_000, bank_transfer: 9_900, other: 0 },
      earlierSaleVoids: { count: 0, amountMinor: 0 },
      profit: null,
    });
    expect(r.cash).toEqual({ openingMinor: 50_000, salesMinor: 11_000, inMinor: 0, outMinor: 0, expectedMinor: 61_000, countedMinor: 60_500, varianceMinor: -500 });
    expect(r.shifts).toHaveLength(1);
    expect(r.shifts[0]).toMatchObject({ status: "closed", userName: "Boss", countedCashMinor: 60_500 });
    expect(r.warnings.join(" ")).toMatch(/drawer was short/);
    // the money received by method adds up to what was billed
    const received = Object.values(r.receivedByMethod).reduce((a, b) => a + b, 0);
    expect(received + r.onAccountMinor).toBe(r.billedMinor - r.refundedMinor);
  });

  it("does not count a sale voided the same day, and reports it as a void", () => {
    const sh = shifts.open(userId, 0).id;
    at(10, 10);
    sell(sh, cash(11_000));
    const bad = sell(sh, cash(11_000));
    at(10, 11);
    sales.voidSale(bad.id, "rung twice");
    const r = dayClose.report(D1);
    expect(r).toMatchObject({ salesCount: 1, billedMinor: 11_000, voidCount: 1, voidedMinor: 11_000, netTakingsMinor: 11_000 });
  });

  it("takes refunds off the day they were made, by method, and shows the cash that left the drawer", () => {
    const sh = shifts.open(userId, 50_000).id;
    at(10, 10);
    const s = sell(sh, cash(22_000), 2);
    at(10, 12);
    refunds.refund({ saleId: s.id, lines: [{ saleItemId: s.items[0]!.id, qty: 1 }], reason: "cold", restock: false, method: "cash" }, { userId, userName: "Boss", shiftId: sh });
    const r = dayClose.report(D1);
    expect(r).toMatchObject({ billedMinor: 22_000, refundCount: 1, refundedMinor: 11_000, netTakingsMinor: 11_000 });
    expect(r.refundsByMethod).toEqual({ cash: 11_000, card: 0, bank_transfer: 0, other: 0 });
    expect(r.receivedByMethod.cash).toBe(11_000);
    expect(r.shifts[0]!.refundCashOutMinor).toBe(11_000);
    expect(r.receivedByMethod.cash).toBe(r.cash.salesMinor - r.shifts[0]!.refundCashOutMinor);
    expect(r.cash.expectedMinor).toBe(50_000 + 11_000);
  });

  it("keeps a closed day as it was when one of its sales is voided on a later day", () => {
    const sh1 = shifts.open(userId, 0).id;
    at(10, 10);
    sell(sh1, cash(11_000));
    const late = sell(sh1, cash(11_000));
    at(10, 20);
    shifts.close(sh1, 22_000);
    const before = { ...dayClose.report(D1), generatedAt: "" };

    // next day: a new shift, the old sale is voided and the cash is handed back from today's drawer
    at(11, 9);
    const sh2 = shifts.open(userId, 30_000).id;
    sell(sh2, cash(11_000));
    at(11, 10);
    sales.voidSale(late.id, "customer returned it");
    shifts.addCashMovement(sh2, userId, -11_000, "Void of an earlier sale", { type: "void", id: late.id });

    const after = { ...dayClose.report(D1), generatedAt: "" };
    expect(after).toEqual(before);
    expect(after.billedMinor).toBe(22_000);
    expect(after.cash.varianceMinor).toBe(0);

    const r2 = dayClose.report(D2);
    expect(r2).toMatchObject({
      salesCount: 1, billedMinor: 11_000, voidCount: 0,
      earlierSaleVoids: { count: 1, amountMinor: 11_000 }, netTakingsMinor: 0,
    });
    expect(r2.receivedByMethod.cash).toBe(0);
    expect(r2.shifts[0]!.refundCashOutMinor).toBe(11_000);
    expect(r2.cash.expectedMinor).toBe(30_000 + 11_000 - 11_000);
    expect(r2.warnings.join(" ")).toMatch(/1 sale from an earlier day was voided today/);
    expect(r2.warnings.join(" ")).toMatch(/still open/);
  });

  it("warns about an open shift and gives no counted total until every shift is closed", () => {
    const sh = shifts.open(userId, 10_000).id;
    at(10, 10);
    sell(sh, cash(11_000));
    const r = dayClose.report(D1);
    expect(r.cash.countedMinor).toBeNull();
    expect(r.cash.varianceMinor).toBeNull();
    expect(r.shifts[0]!.countedCashMinor).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/Boss's shift is still open/);
  });

  it("says so when no shift was opened, and a day with no sales is all zeros", () => {
    const r = dayClose.report(D1);
    expect(r).toMatchObject({ salesCount: 0, billedMinor: 0, netTakingsMinor: 0, shifts: [] });
    expect(r.cash).toMatchObject({ openingMinor: 0, expectedMinor: 0, countedMinor: null });
    expect(r.warnings.join(" ")).toMatch(/No shift was opened/);
  });

  it("includes profit only when asked for, and warns when costs are missing", () => {
    const sh = shifts.open(userId, 0).id;
    at(10, 10);
    sell(sh, cash(11_000));
    expect(dayClose.report(D1).profit).toBeNull();
    const withProfit = dayClose.report(D1, { includeProfit: true });
    expect(withProfit.profit).toMatchObject({ cogsMinor: 0, grossProfitMinor: 10_000, costMissing: true });
    expect(withProfit.warnings.join(" ")).toMatch(/no cost recorded/);
  });

  it("keeps every figure a whole number and rejects bad dates", () => {
    const sh = shifts.open(userId, 0).id;
    at(10, 10);
    sell(sh, cash(11_000), 1, 333);
    const r = dayClose.report(D1, { includeProfit: true });
    for (const v of [r.grossSalesMinor, r.discountsMinor, r.taxMinor, r.billedMinor, r.netTakingsMinor, ...Object.values(r.receivedByMethod)]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(() => dayClose.report("10/03/2026")).toThrow();
    expect(() => dayClose.report("2026-02-30")).toThrow();
  });
});
