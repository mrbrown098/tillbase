import { beforeEach, describe, expect, it } from "vitest";
import {
  ExpenseService,
  FinanceService,
  InventoryService,
  LabourService,
  ProductService,
  PurchaseService,
  RecipeService,
  SaleService,
  computePay,
  dates,
  openDatabase,
  type Db,
} from "../src/index.js";

let db: Db;
let products: ProductService;
let inventory: InventoryService;
let recipes: RecipeService;
let purchases: PurchaseService;
let sales: SaleService;
let expenses: ExpenseService;
let labour: LabourService;
let finance: FinanceService;

beforeEach(() => {
  db = openDatabase(":memory:");
  products = new ProductService(db);
  inventory = new InventoryService(db);
  recipes = new RecipeService(db);
  purchases = new PurchaseService(db);
  sales = new SaleService(db, "T1");
  expenses = new ExpenseService(db);
  labour = new LabourService(db);
  finance = new FinanceService(db);
});

/** Local date-time helper: at(2026, 11, 3, 9, 30) is 9:30 on 3 Nov in the shop's time zone. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const today = () => dates.localDate();

function ingredient(name: string, unit: string) {
  return products.create({ name, unit, kind: "ingredient", priceMinor: 0 });
}
function menuItem(name: string, price: number, taxRateBp = 0) {
  return products.create({ name, priceMinor: price, taxRateBp, trackStock: false });
}
function buy(productId: string, qty: number, costMinor: number, extra: { paid?: number; supplier?: string } = {}) {
  return purchases.record({
    items: [{ productId, qty, costMinor }],
    paidMinor: extra.paid ?? costMinor,
    supplier: extra.supplier,
  });
}
const card = (n: number) => [{ method: "card" as const, amountMinor: n }];

describe("average cost and purchases", () => {
  it("works out a weighted-average cost across purchases at different prices", () => {
    const chicken = ingredient("Chicken", "kg");
    buy(chicken.id, 10, 800_000); // 80,000 per kg
    expect(products.get(chicken.id)?.avgCost).toBe(80_000);
    buy(chicken.id, 10, 1_000_000); // 100,000 per kg
    expect(products.get(chicken.id)?.avgCost).toBe(90_000);
    expect(inventory.stockOf(chicken.id)).toBe(20);
  });

  it("weights the average by what is still in stock, not by everything ever bought", () => {
    const flour = ingredient("Flour", "kg");
    buy(flour.id, 10, 100_000); // 10,000 per kg
    inventory.adjust(flour.id, -8, "waste"); // 2 kg left
    buy(flour.id, 2, 40_000); // 20,000 per kg
    // 2 kg at 10,000 + 2 kg at 20,000 = 60,000 over 4 kg
    expect(products.get(flour.id)?.avgCost).toBe(15_000);
  });

  it("tracks what is owed to suppliers and lets it be paid down", () => {
    const oil = ingredient("Oil", "l");
    const p = buy(oil.id, 10, 300_000, { paid: 100_000, supplier: "Metro" });
    expect(p.outstandingMinor).toBe(200_000);
    buy(oil.id, 5, 150_000, { paid: 0, supplier: "Al Fatah" });
    expect(purchases.payables()).toEqual({
      totalMinor: 350_000,
      bySupplier: [
        { supplier: "Metro", outstandingMinor: 200_000 },
        { supplier: "Al Fatah", outstandingMinor: 150_000 },
      ],
    });
    expect(() => purchases.pay(p.id, 200_001)).toThrow(/more than is owed/);
    expect(purchases.pay(p.id, 200_000).outstandingMinor).toBe(0);
    expect(purchases.payables().totalMinor).toBe(150_000);
    expect(purchases.list({ onlyUnpaid: true })).toHaveLength(1);
  });

  it("validates purchases and saves nothing when one line is bad", () => {
    const a = ingredient("A", "kg");
    expect(() => purchases.record({ items: [] })).toThrow(/at least one item/);
    expect(() =>
      purchases.record({ items: [{ productId: a.id, qty: 0, costMinor: 100 }] }),
    ).toThrow(/greater than zero/);
    expect(() =>
      purchases.record({
        items: [
          { productId: a.id, qty: 1, costMinor: 100 },
          { productId: "missing", qty: 1, costMinor: 100 },
        ],
      }),
    ).toThrow(/Product not found/);
    expect(inventory.stockOf(a.id)).toBe(0);
    expect(purchases.list()).toHaveLength(0);
    expect(() => purchases.record({ items: [{ productId: a.id, qty: 1, costMinor: 100 }], paidMinor: 101 })).toThrow(/more than/);
  });
});

describe("recipes and selling", () => {
  function burgerShop() {
    const chicken = ingredient("Chicken", "kg");
    const bun = ingredient("Bun", "pcs");
    buy(chicken.id, 10, 800_000); // 80,000 / kg
    buy(bun.id, 100, 200_000); // 2,000 each
    const zinger = menuItem("Zinger Burger", 45_000);
    recipes.set(zinger.id, [
      { ingredientId: chicken.id, qty: 0.15 }, // 12,000
      { ingredientId: bun.id, qty: 1 }, // 2,000
    ]);
    return { chicken, bun, zinger };
  }

  it("works out the cost of a dish from its ingredients", () => {
    const { zinger } = burgerShop();
    const r = recipes.get(zinger.id);
    expect(r.costMinor).toBe(14_000);
    expect(r.lines.map((l) => [l.name, l.costMinor])).toEqual([["Bun", 2_000], ["Chicken", 12_000]]);
    expect(recipes.costs()).toEqual({ [zinger.id]: 14_000 });
  });

  it("selling a dish uses up its ingredients and records what they cost", () => {
    const { chicken, bun, zinger } = burgerShop();
    const sale = sales.checkout({ lines: [{ productId: zinger.id, qty: 2 }], payments: card(90_000) });
    expect(inventory.stockOf(chicken.id)).toBe(9.7);
    expect(inventory.stockOf(bun.id)).toBe(98);
    expect(sale.items[0]?.cogsMinor).toBe(28_000);
  });

  it("checks stock for the whole cart together, naming the ingredient that runs out", () => {
    const { chicken, zinger } = burgerShop();
    inventory.adjust(chicken.id, -9.8, "waste"); // 0.2 kg left, enough for one burger, not two
    expect(() =>
      sales.checkout({
        lines: [{ productId: zinger.id, qty: 1 }, { productId: zinger.id, qty: 1 }],
        payments: card(90_000),
      }),
    ).toThrow(/Not enough stock for Chicken \(have 0\.2 kg, need 0\.3 kg\)/);
    expect(inventory.stockOf(chicken.id)).toBe(0.2); // nothing was taken
  });

  it("does not let an ingredient be sold at the till", () => {
    const { chicken } = burgerShop();
    expect(() =>
      sales.checkout({ lines: [{ productId: chicken.id, qty: 1 }], payments: card(1) }),
    ).toThrow(/ingredient and cannot be sold/);
    expect(products.search("chic")).toHaveLength(0); // hidden from the till search
    expect(products.search("chic", 50, "ingredient")).toHaveLength(1);
  });

  it("reverses a void exactly, even after ingredient prices change", () => {
    const { chicken, bun, zinger } = burgerShop();
    const before = db.prepare("SELECT SUM(value_minor) AS v FROM stock_movements WHERE product_id = ?").get(chicken.id) as { v: number };
    const sale = sales.checkout({ lines: [{ productId: zinger.id, qty: 3 }], payments: card(135_000) });
    buy(chicken.id, 10, 2_000_000); // price shock: average cost changes before the void
    sales.voidSale(sale.id, "customer left");
    expect(inventory.stockOf(chicken.id)).toBe(20);
    expect(inventory.stockOf(bun.id)).toBe(100);
    // The sale's own movements net to zero in quantity and in value.
    const net = db
      .prepare("SELECT SUM(qty_delta) AS q, SUM(value_minor) AS v FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ?")
      .get(sale.id) as { q: number; v: number };
    expect(Math.abs(net.q)).toBeLessThan(1e-9);
    expect(net.v).toBe(0);
    expect(before.v).toBe(800_000);
  });

  it("selling a plain stocked product still works and records its cost", () => {
    const cola = products.create({ name: "Cola", priceMinor: 8_000, costMinor: 5_000 });
    inventory.adjust(cola.id, 10, "opening stock");
    const sale = sales.checkout({ lines: [{ productId: cola.id, qty: 4 }], payments: card(32_000) });
    expect(sale.items[0]?.cogsMinor).toBe(20_000);
    expect(inventory.stockOf(cola.id)).toBe(6);
  });

  it("validates recipes", () => {
    const { chicken, zinger } = burgerShop();
    const other = menuItem("Fries", 15_000);
    expect(() => recipes.set(chicken.id, [])).toThrow(/Only menu items/);
    expect(() => recipes.set(zinger.id, [{ ingredientId: other.id, qty: 1 }])).toThrow(/only use ingredients/);
    expect(() => recipes.set(zinger.id, [{ ingredientId: chicken.id, qty: 0 }])).toThrow(/greater than zero/);
    expect(() =>
      recipes.set(zinger.id, [{ ingredientId: chicken.id, qty: 1 }, { ingredientId: chicken.id, qty: 2 }]),
    ).toThrow(/twice/);
    expect(recipes.set(zinger.id, []).lines).toHaveLength(0); // clearing works
    expect(() => products.update(zinger.id, { kind: "ingredient" })).toThrow(/cannot change/);
  });

  it("values waste at average cost", () => {
    const { chicken } = burgerShop();
    inventory.adjust(chicken.id, -0.5, "waste");
    const row = db.prepare("SELECT value_minor AS v FROM stock_movements WHERE reason = 'waste'").get() as { v: number };
    expect(row.v).toBe(-40_000);
    expect(inventory.stockValue()).toBe(Math.round(9.5 * 80_000 + 100 * 2_000));
  });
});

describe("expenses", () => {
  it("comes with sensible categories and totals spending by category", () => {
    const cats = expenses.categories();
    expect(cats.length).toBe(12);
    const rent = cats.find((c) => c.name === "Rent")!;
    const power = cats.find((c) => c.name === "Electricity")!;
    expenses.add({ categoryId: rent.id, description: "November rent", amountMinor: 100_000, spentOn: "2026-11-01" });
    expenses.add({ categoryId: power.id, description: "K-Electric", amountMinor: 20_000, spentOn: "2026-11-10" });
    expenses.add({ categoryId: power.id, description: "Generator fuel", amountMinor: 5_000, spentOn: "2026-11-12" });
    expenses.add({ categoryId: rent.id, description: "October rent", amountMinor: 90_000, spentOn: "2026-10-01" });
    expect(expenses.totalsByCategory("2026-11-01", "2026-11-30").map((x) => [x.name, x.totalMinor])).toEqual([
      ["Rent", 100_000],
      ["Electricity", 25_000],
    ]);
    expect(expenses.list("2026-11-01", "2026-11-30")).toHaveLength(3);
  });

  it("cancelled entries stop counting but stay on record", () => {
    const cat = expenses.categories()[0]!;
    const e = expenses.add({ categoryId: cat.id, description: "typo", amountMinor: 999_999, spentOn: "2026-11-05" });
    expenses.void(e.id, "wrong amount");
    expect(expenses.totalsByCategory("2026-11-01", "2026-11-30")).toEqual([]);
    expect(expenses.list("2026-11-01", "2026-11-30")[0]?.voided).toBe(true);
    expect(() => expenses.void(e.id, "again")).toThrow(/already cancelled/);
  });

  it("validates input", () => {
    const cat = expenses.categories()[0]!;
    expect(() => expenses.add({ categoryId: cat.id, description: " ", amountMinor: 100 })).toThrow(/description/);
    expect(() => expenses.add({ categoryId: cat.id, description: "x", amountMinor: 0 })).toThrow(/positive/);
    expect(() => expenses.add({ categoryId: cat.id, description: "x", amountMinor: 100, spentOn: "2026-02-31" })).toThrow(/date/);
    expect(() => expenses.add({ categoryId: "nope", description: "x", amountMinor: 100 })).toThrow(/category/);
    expect(() => expenses.addCategory("rent")).toThrow(/already exists/);
    expect(expenses.addCategory("Staff meals").name).toBe("Staff meals");
  });
});

describe("pay calculation", () => {
  const hourly = { payType: "hourly" as const, payRateMinor: 10_000, overtimeAfterMinutes: 0, overtimeMultiplierBp: 15_000 };
  const shift = (d: number, h1: number, h2: number, m = 11) => ({ clockIn: at(2026, m, d, h1), clockOut: at(2026, m, d, h2) });

  it("hourly: pays for hours worked", () => {
    const calc = computePay(hourly, [shift(2, 9, 17), shift(3, 9, 13)], "2026-11-01", "2026-11-30");
    expect(calc).toEqual({ minutes: 720, days: 2, baseMinor: 120_000, overtimeMinor: 0 });
  });

  it("hourly: pays overtime at 1.5x after the daily threshold", () => {
    const t = { ...hourly, overtimeAfterMinutes: 480 };
    const calc = computePay(t, [shift(2, 9, 19)], "2026-11-01", "2026-11-30"); // 10 hours
    expect(calc.baseMinor).toBe(80_000); // 8h x 10,000
    expect(calc.overtimeMinor).toBe(30_000); // 2h x 10,000 x 1.5
  });

  it("daily: pays per day present, however many shifts that day", () => {
    const t = { payType: "daily" as const, payRateMinor: 50_000, overtimeAfterMinutes: 0, overtimeMultiplierBp: 15_000 };
    const calc = computePay(t, [shift(2, 9, 12), shift(2, 14, 18), shift(3, 9, 17), shift(5, 9, 17)], "2026-11-01", "2026-11-30");
    expect(calc.days).toBe(3);
    expect(calc.baseMinor).toBe(150_000);
  });

  it("monthly: a whole month pays the full salary, part of a month is prorated by days", () => {
    const t = { payType: "monthly" as const, payRateMinor: 3_000_000, overtimeAfterMinutes: 0, overtimeMultiplierBp: 15_000 };
    expect(computePay(t, [], "2026-11-01", "2026-11-30").baseMinor).toBe(3_000_000);
    expect(computePay(t, [], "2026-11-01", "2026-11-15").baseMinor).toBe(1_500_000);
    // 16 Nov to 15 Dec: 15/30 of November plus 15/31 of December
    expect(computePay(t, [], "2026-11-16", "2026-12-15").baseMinor).toBe(2_951_613);
    expect(computePay(t, [], "2026-02-01", "2026-02-28").baseMinor).toBe(3_000_000); // short month, still full
  });

  it("a night shift belongs to the day it started", () => {
    const night = [{ clockIn: at(2026, 11, 3, 22), clockOut: at(2026, 11, 4, 6) }];
    expect(computePay(hourly, night, "2026-11-03", "2026-11-03").minutes).toBe(480);
    expect(computePay(hourly, night, "2026-11-04", "2026-11-04").minutes).toBe(0);
  });

  it("ignores shifts still open and shifts outside the period", () => {
    const recs = [{ clockIn: at(2026, 11, 2, 9), clockOut: null }, shift(2, 9, 10, 10)];
    expect(computePay(hourly, recs, "2026-11-01", "2026-11-30").minutes).toBe(0);
  });
});

describe("attendance", () => {
  const ali = () => labour.createEmployee({ name: "Ali", payType: "hourly", payRateMinor: 10_000 });

  it("clocks in and out, and knows who is in", () => {
    const e = ali();
    labour.clockIn(e.id, at(2026, 11, 3, 9));
    expect(labour.whoIsIn().map((r) => r.employeeName)).toEqual(["Ali"]);
    expect(() => labour.clockIn(e.id, at(2026, 11, 3, 10))).toThrow(/already clocked in/);
    const r = labour.clockOut(e.id, at(2026, 11, 3, 17));
    expect(r.minutes).toBe(480);
    expect(labour.whoIsIn()).toHaveLength(0);
    expect(() => labour.clockOut(e.id)).toThrow(/not clocked in/);
  });

  it("rejects a clock-out before the clock-in and overlapping manual shifts", () => {
    const e = ali();
    labour.clockIn(e.id, at(2026, 11, 3, 9));
    expect(() => labour.clockOut(e.id, at(2026, 11, 3, 8))).toThrow(/after clock-in/);
    labour.clockOut(e.id, at(2026, 11, 3, 17));
    expect(() => labour.addShift(e.id, at(2026, 11, 3, 16), at(2026, 11, 3, 20))).toThrow(/overlaps/);
    expect(() => labour.addShift(e.id, at(2026, 11, 3, 12), at(2026, 11, 3, 11))).toThrow(/after clock-in/);
    labour.addShift(e.id, at(2026, 11, 4, 9), at(2026, 11, 4, 17), "forgot to clock in");
    expect(labour.attendance("2026-11-01", "2026-11-30", e.id)).toHaveLength(2);
  });

  it("does not clock in inactive staff", () => {
    const e = ali();
    labour.updateEmployee(e.id, { active: false });
    expect(() => labour.clockIn(e.id)).toThrow(/not active/);
  });
});

describe("payroll", () => {
  function team() {
    const ali = labour.createEmployee({ name: "Ali", payType: "hourly", payRateMinor: 10_000 });
    const sara = labour.createEmployee({ name: "Sara", payType: "monthly", payRateMinor: 3_000_000 });
    for (const d of [3, 4, 5]) labour.addShift(ali.id, at(2026, 11, d, 9), at(2026, 11, d, 17));
    return { ali, sara };
  }

  it("works out each person's pay with a bonus, a deduction and advance recovery", () => {
    const { ali, sara } = team();
    labour.giveAdvance(ali.id, 50_000, "2026-11-02", "eid shopping");
    const preview = labour.preview("2026-11-01", "2026-11-30");
    const a = preview.find((l) => l.employeeId === ali.id)!;
    expect(a).toMatchObject({ minutes: 1440, days: 3, grossMinor: 240_000, outstandingAdvanceMinor: 50_000 });

    const slips = labour.finalize({
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      lines: [{ employeeId: ali.id, bonusMinor: 10_000, deductionsMinor: 5_000, recoverAdvanceMinor: 30_000 }],
    });
    const aliSlip = slips.find((s) => s.employeeId === ali.id)!;
    const saraSlip = slips.find((s) => s.employeeId === sara.id)!;
    expect(aliSlip.netMinor).toBe(240_000 + 10_000 - 5_000 - 30_000); // 215,000 take-home
    expect(aliSlip.costMinor).toBe(245_000); // cost to the business, before advances
    expect(saraSlip.netMinor).toBe(3_000_000);
    expect(labour.outstandingAdvance(ali.id)).toBe(20_000);
  });

  it("will not pay the same dates twice", () => {
    team();
    labour.finalize({ periodStart: "2026-11-01", periodEnd: "2026-11-30" });
    expect(() => labour.finalize({ periodStart: "2026-11-15", periodEnd: "2026-12-15" })).toThrow(/already has a payslip/);
  });

  it("blocks payroll while someone with hours is still clocked in", () => {
    const { ali } = team();
    labour.clockIn(ali.id); // now, within November 2026
    expect(() => labour.finalize({ periodStart: "2026-11-01", periodEnd: "2026-11-30" })).toThrow(/still clocked in/);
    expect(labour.payslips()).toHaveLength(0); // nothing half-saved
  });

  it("refuses to take back more advance than is owed, or more than the pay", () => {
    const { ali } = team();
    labour.giveAdvance(ali.id, 20_000, "2026-11-02");
    expect(() =>
      labour.finalize({ periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: [{ employeeId: ali.id, recoverAdvanceMinor: 25_000 }] }),
    ).toThrow(/only has 20000 of advances/);
    expect(() =>
      labour.finalize({ periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: [{ employeeId: ali.id, deductionsMinor: 999_999 }] }),
    ).toThrow(/more than the pay/);
    expect(labour.outstandingAdvance(ali.id)).toBe(20_000); // untouched
  });

  it("recovers the oldest advance first", () => {
    const { ali } = team();
    labour.giveAdvance(ali.id, 10_000, "2026-10-01");
    labour.giveAdvance(ali.id, 10_000, "2026-11-01");
    labour.finalize({ periodStart: "2026-11-01", periodEnd: "2026-11-30", lines: [{ employeeId: ali.id, recoverAdvanceMinor: 12_000 }] });
    const rows = db.prepare("SELECT given_on AS d, recovered_minor AS r FROM advances ORDER BY given_on").all();
    expect(rows).toEqual([{ d: "2026-10-01", r: 10_000 }, { d: "2026-11-01", r: 2_000 }]);
  });

  it("locks paid days against edits and marks payslips paid once", () => {
    const { ali } = team();
    const slips = labour.finalize({ periodStart: "2026-11-01", periodEnd: "2026-11-30" });
    const rec = labour.attendance("2026-11-01", "2026-11-30", ali.id)[0]!;
    expect(() => labour.removeShift(rec.id)).toThrow(/already been paid/);
    const slip = slips.find((s) => s.employeeId === ali.id)!;
    expect(labour.pay(slip.id, "cash").paidAt).toBeTruthy();
    expect(() => labour.pay(slip.id)).toThrow(/already been paid/);
  });

  it("says there is nothing to pay for an empty period", () => {
    labour.createEmployee({ name: "Ali", payType: "hourly", payRateMinor: 10_000 });
    expect(() => labour.finalize({ periodStart: "2026-11-01", periodEnd: "2026-11-30" })).toThrow(/nothing to pay/);
  });

  it("estimates wages for days not yet through payroll, then switches to actual", () => {
    const e = labour.createEmployee({ name: "Ali", payType: "hourly", payRateMinor: 25_000 });
    const d = today();
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    labour.addShift(e.id, at(y, m, day, 9), at(y, m, day, 17));
    expect(labour.costBetween(d, d)).toEqual({ actualMinor: 0, estimatedMinor: 200_000 });
    labour.finalize({ periodStart: d, periodEnd: d });
    expect(labour.costBetween(d, d)).toEqual({ actualMinor: 200_000, estimatedMinor: 0 });
  });

  it("validates pay terms", () => {
    expect(() => labour.createEmployee({ name: "X", payType: "weekly" as never, payRateMinor: 1 })).toThrow(/monthly, daily or hourly/);
    expect(() => labour.createEmployee({ name: "X", payType: "daily", payRateMinor: -1 })).toThrow(/Pay rate/);
    expect(() => labour.createEmployee({ name: "X", payType: "daily", payRateMinor: 1, overtimeMultiplierBp: 5000 })).toThrow(/below 1x/);
    expect(() => labour.createEmployee({ name: " ", payType: "daily", payRateMinor: 1 })).toThrow(/Name/);
  });
});

describe("profit and loss: a burger shop's day, worked out by hand", () => {
  /**
   * Every expected number below is plain arithmetic from the setup.
   *   Net sales      600,000  (10 Zinger at 45,000 + 10 Fries at 15,000)
   *   Cost of goods  186,000  (10 x 16,000 + 10 x 2,600)
   *   Gross profit   414,000
   *   Wastage         40,000  (0.5 kg chicken at 80,000)
   *   Running costs  120,000  (rent 100,000 + electricity 20,000)
   *   Wages          200,000  (8 hours at 25,000)
   *   Net profit      54,000
   */
  function openForBusiness() {
    const chicken = ingredient("Chicken", "kg");
    const bun = ingredient("Bun", "pcs");
    const cheese = ingredient("Cheese slice", "pcs");
    const potato = ingredient("Potato", "kg");
    const oil = ingredient("Oil", "l");
    buy(chicken.id, 10, 800_000);
    buy(bun.id, 100, 200_000);
    buy(cheese.id, 50, 100_000);
    buy(potato.id, 20, 200_000);
    buy(oil.id, 10, 300_000, { paid: 100_000, supplier: "Metro" });

    const zinger = menuItem("Zinger Burger", 45_000);
    recipes.set(zinger.id, [
      { ingredientId: chicken.id, qty: 0.15 },
      { ingredientId: bun.id, qty: 1 },
      { ingredientId: cheese.id, qty: 1 },
    ]);
    const fries = menuItem("Fries", 15_000);
    recipes.set(fries.id, [
      { ingredientId: potato.id, qty: 0.2 },
      { ingredientId: oil.id, qty: 0.02 },
    ]);
    return { chicken, zinger, fries };
  }

  it("matches the hand calculation line by line", () => {
    const { chicken, zinger, fries } = openForBusiness();
    sales.checkout({ lines: [{ productId: zinger.id, qty: 6 }, { productId: fries.id, qty: 4 }], payments: card(330_000) });
    sales.checkout({ lines: [{ productId: zinger.id, qty: 4 }, { productId: fries.id, qty: 6 }], payments: card(270_000) });
    const mistake = sales.checkout({ lines: [{ productId: zinger.id, qty: 1 }], payments: card(45_000) });
    sales.voidSale(mistake.id, "wrong order"); // must not affect profit

    inventory.adjust(chicken.id, -0.5, "waste");

    const cats = expenses.categories();
    expenses.add({ categoryId: cats.find((c) => c.name === "Rent")!.id, description: "Rent", amountMinor: 100_000 });
    expenses.add({ categoryId: cats.find((c) => c.name === "Electricity")!.id, description: "Power", amountMinor: 20_000 });

    const staff = labour.createEmployee({ name: "Ali", payType: "hourly", payRateMinor: 25_000 });
    const [y, m, d] = today().split("-").map(Number) as [number, number, number];
    labour.addShift(staff.id, at(y, m, d, 9), at(y, m, d, 17));

    const pl = finance.profitAndLoss(today(), today());

    expect(pl.salesCount).toBe(2);
    expect(pl.voidCount).toBe(1);
    expect(pl.netSalesMinor).toBe(600_000);
    expect(pl.averageOrderMinor).toBe(300_000);
    expect(pl.cogsMinor).toBe(186_000);
    expect(pl.grossProfitMinor).toBe(414_000);
    expect(pl.grossMarginPct).toBe(69);
    expect(pl.wastageMinor).toBe(40_000);
    expect(pl.wastageByReason).toEqual([{ reason: "waste", costMinor: 40_000 }]);
    expect(pl.expensesMinor).toBe(120_000);
    expect(pl.expensesByCategory).toEqual([
      { name: "Rent", totalMinor: 100_000 },
      { name: "Electricity", totalMinor: 20_000 },
    ]);
    expect(pl.labourMinor).toBe(200_000);
    expect(pl.labourEstimatedMinor).toBe(200_000);
    expect(pl.netProfitMinor).toBe(54_000);
    expect(pl.netMarginPct).toBe(9);

    // Where each 100 of sales went. These add back up to all of it.
    expect(pl.breakdown.map((b) => [b.key, b.amountMinor, b.pctOfSales])).toEqual([
      ["cogs", 186_000, 31],
      ["wastage", 40_000, 6.7],
      ["labour", 200_000, 33.3],
      ["expenses", 120_000, 20],
      ["profit", 54_000, 9],
    ]);
    expect(pl.breakdown.reduce((s, b) => s + b.amountMinor, 0)).toBe(pl.netSalesMinor);

    expect(pl.breakEvenSalesMinor).toBe(521_739); // 360,000 of overheads at a 69% margin

    // Items, best profit first
    expect(pl.items.map((i) => [i.name, i.qty, i.salesMinor, i.profitMinor, i.marginPct])).toEqual([
      ["Zinger Burger", 10, 450_000, 290_000, 64.4],
      ["Fries", 10, 150_000, 124_000, 82.7],
    ]);

    // What the business owns and owes right now
    expect(pl.position.owedToSuppliersMinor).toBe(200_000);
    expect(pl.position.stockValueMinor).toBe(1_374_000);

    expect(pl.daily).toHaveLength(1);
    expect(pl.daily[0]).toMatchObject({ orders: 2, salesMinor: 600_000, cogsMinor: 186_000, grossProfitMinor: 414_000 });
    expect(pl.hourly.reduce((s, h) => s + h.orders, 0)).toBe(2);
    expect(pl.warnings).toEqual([
      "Some wages are estimated from attendance and salaries because payroll has not been run for those days yet.",
    ]);
  });

  it("shows a loss as a loss", () => {
    const { zinger } = openForBusiness();
    sales.checkout({ lines: [{ productId: zinger.id, qty: 1 }], payments: card(45_000) });
    const cats = expenses.categories();
    expenses.add({ categoryId: cats[0]!.id, description: "Rent", amountMinor: 100_000 });
    const pl = finance.profitAndLoss(today(), today());
    expect(pl.netProfitMinor).toBe(45_000 - 16_000 - 100_000);
    expect(pl.breakdown[4]?.label).toBe("Loss");
  });

  it("warns when profit cannot be trusted", () => {
    const cola = products.create({ name: "Cola", priceMinor: 8_000, trackStock: false }); // no cost anywhere
    sales.checkout({ lines: [{ productId: cola.id, qty: 2 }], payments: card(16_000) });
    const pl = finance.profitAndLoss(today(), today());
    expect(pl.items[0]?.costMissing).toBe(true);
    expect(pl.warnings.some((w) => /no cost set \(Cola\)/.test(w))).toBe(true);
    expect(pl.warnings.some((w) => /No running costs/.test(w))).toBe(true);
    expect(pl.warnings.some((w) => /No wages/.test(w))).toBe(true);
  });

  it("only counts the days asked for, and lays out every day in the range", () => {
    const { zinger } = openForBusiness();
    sales.checkout({ lines: [{ productId: zinger.id, qty: 1 }], payments: card(45_000) });
    const yesterday = dates.addDays(today(), -1);
    const past = finance.profitAndLoss(dates.addDays(today(), -7), yesterday);
    expect(past.netSalesMinor).toBe(0);
    expect(past.daily).toHaveLength(7);
    expect(past.breakdown.every((b) => b.pctOfSales === null || b.amountMinor === 0)).toBe(true);
    expect(past.breakEvenSalesMinor).toBeNull();
    expect(() => finance.profitAndLoss(today(), yesterday)).toThrow(/cannot be before/);
    expect(() => finance.profitAndLoss("nope", today())).toThrow(/date/);
  });

  it("uses saved payroll instead of an estimate once payroll has run", () => {
    const { zinger } = openForBusiness();
    sales.checkout({ lines: [{ productId: zinger.id, qty: 1 }], payments: card(45_000) });
    const staff = labour.createEmployee({ name: "Ali", payType: "hourly", payRateMinor: 25_000 });
    const [y, m, d] = today().split("-").map(Number) as [number, number, number];
    labour.addShift(staff.id, at(y, m, d, 9), at(y, m, d, 17));
    labour.finalize({ periodStart: today(), periodEnd: today(), lines: [{ employeeId: staff.id, deductionsMinor: 10_000 }] });
    const pl = finance.profitAndLoss(today(), today());
    expect(pl.labourActualMinor).toBe(190_000); // fines reduce what wages cost the business
    expect(pl.labourEstimatedMinor).toBe(0);
    expect(pl.warnings.some((w) => /estimated/.test(w))).toBe(false);
  });
});
