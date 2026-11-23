import { beforeEach, describe, expect, it } from "vitest";
import { CustomerService, ProductService, PurchaseService, ReportCentreService, SaleService, dates, openDatabase, presetRange, type Db } from "../src/index.js";
import { shop as buildShop } from "./report-fixture.js";

let db: Db;
let products: ProductService;
let purchases: PurchaseService;
let sales: SaleService;
let report: ReportCentreService;

beforeEach(() => {
  db = openDatabase(":memory:");
  products = new ProductService(db);
  purchases = new PurchaseService(db);
  sales = new SaleService(db, "T1");
  report = new ReportCentreService(db, () => Date.UTC(2026, 10, 22, 12, 0, 0));
});

const card = (n: number) => [{ method: "card" as const, amountMinor: n }];

describe("date presets", () => {
  // Sunday 22 Nov 2026
  it("works out today, yesterday, this week (Monday to today) and this month", () => {
    expect(presetRange("today", "2026-11-22")).toEqual({ from: "2026-11-22", to: "2026-11-22" });
    expect(presetRange("yesterday", "2026-11-22")).toEqual({ from: "2026-11-21", to: "2026-11-21" });
    expect(presetRange("this_week", "2026-11-22")).toEqual({ from: "2026-11-16", to: "2026-11-22" }); // Sunday: week began Monday 16th
    expect(presetRange("this_week", "2026-11-16")).toEqual({ from: "2026-11-16", to: "2026-11-16" }); // Monday: just today
    expect(presetRange("this_month", "2026-11-22")).toEqual({ from: "2026-11-01", to: "2026-11-22" });
  });
  it("crosses month and year ends correctly", () => {
    expect(presetRange("yesterday", "2027-01-01")).toEqual({ from: "2026-12-31", to: "2026-12-31" });
    expect(presetRange("this_week", "2027-01-02")).toEqual({ from: "2026-12-28", to: "2027-01-02" });
    expect(presetRange("yesterday", "2028-03-01")).toEqual({ from: "2028-02-29", to: "2028-02-29" }); // leap year
  });
  it("refuses a bad date", () => {
    expect(() => presetRange("today", "22/11/2026")).toThrow("date like");
  });
});

describe("sales, cost of goods and profit, against figures worked out by hand", () => {
  it("one day: 10 November", () => {
    buildShop(db);
    const r = report.build("2026-11-10", "2026-11-10");
    expect(r.pnl.salesCount).toBe(2); // the voided sale and the sale at midnight are not in it
    expect(r.pnl.voidCount).toBe(1);
    expect(r.pnl.netSalesMinor).toBe(150_000); // 1,200.00 + 300.00
    expect(r.pnl.cogsMinor).toBe(70_000); // 2 x 300.00 + 1 x 100.00
    expect(r.pnl.grossProfitMinor).toBe(80_000);
    expect(r.pnl.expensesMinor).toBe(20_000);
    expect(r.pnl.netProfitMinor).toBe(60_000); // 800.00 gross - 200.00 rent (no wages or wastage)
    expect(r.pnl.averageOrderMinor).toBe(75_000);
  });

  it("the day boundary is local midnight: 23:59 belongs to the 10th, 00:00 to the 11th", () => {
    buildShop(db);
    expect(report.build("2026-11-10", "2026-11-10").pnl.netSalesMinor).toBe(150_000); // includes 23:59, excludes 00:00
    const eleventh = report.build("2026-11-11", "2026-11-11");
    expect(eleventh.pnl.salesCount).toBe(1);
    expect(eleventh.pnl.netSalesMinor).toBe(40_000);
    expect(eleventh.pnl.cogsMinor).toBe(20_000);
    const both = report.build("2026-11-10", "2026-11-11");
    expect(both.pnl.netSalesMinor).toBe(190_000);
    expect(both.pnl.cogsMinor).toBe(90_000);
    expect(both.pnl.grossProfitMinor).toBe(100_000);
    expect(both.pnl.daily.map((d) => [d.date, d.salesMinor, d.grossProfitMinor])).toEqual([["2026-11-10", 150_000, 80_000], ["2026-11-11", 40_000, 20_000]]);
  });

  it("splits money received by method, with change taken off cash, and the voided sale left out", () => {
    buildShop(db);
    const r = report.build("2026-11-10", "2026-11-11");
    expect(r.paymentMethods).toEqual([
      { method: "cash", amountMinor: 120_000 }, // 1,500.00 handed over - 300.00 change
      { method: "card", amountMinor: 70_000 }, // 300.00 + 400.00 (the voided 500.00 is not counted)
    ]);
    expect(r.onAccountMinor).toBe(0);
  });

  it("flags the item with no cost instead of hiding it", () => {
    buildShop(db);
    const r = report.build("2026-11-10", "2026-11-10");
    expect(r.topProducts.find((p) => p.name === "Cola")?.costMissing).toBe(true);
    expect(r.notes.some((n) => n.includes("no cost set (Cola)"))).toBe(true);
    expect(r.topProducts.find((p) => p.name === "Burger")?.costMissing).toBe(false);
  });
});

describe("products and stock", () => {
  it("ranks best sellers by sales and slow movers by quantity sold, including items that never sold", () => {
    buildShop(db);
    const r = report.build("2026-11-10", "2026-11-11");
    expect(r.topProducts.map((p) => [p.name, p.qty, p.salesMinor, p.profitMinor])).toEqual([
      ["Burger", 2, 100_000, 40_000], // 1,000.00 sales - 600.00 cost
      ["Fries", 3, 60_000, 30_000], // 600.00 - 300.00
      ["Cola", 3, 30_000, 30_000], // no cost known
    ]);
    expect(r.slowProducts.map((p) => [p.name, p.qtySold])).toEqual([["Pie", 0], ["Burger", 2], ["Cola", 3], ["Fries", 3]]);
    expect(r.slowProducts[0]).toMatchObject({ name: "Pie", lastSoldAt: null, stock: 5 });
  });

  it("values stock at average cost and lists what is at or below its reorder level", () => {
    buildShop(db);
    const r = report.build("2026-11-10", "2026-11-10");
    // Burger 10 - 2 sold (the voided one went back) = 8 x 300.00 = 2,400.00; Fries 17 x 100.00 = 1,700.00; Pie 5 x 100.00 = 500.00
    expect(r.stock.valueMinor).toBe(460_000);
    expect(r.stock.lines.map((l) => [l.name, l.stock, l.valueMinor, l.low])).toEqual([
      ["Burger", 8, 240_000, true], ["Fries", 17, 170_000, false], ["Pie", 5, 50_000, false],
    ]);
    expect(r.stock.low.map((l) => l.name)).toEqual(["Burger"]);
  });

  it("says when stock has no cost", () => {
    const p = products.create({ name: "Mystery", priceMinor: 100, trackStock: true });
    new ProductService(db);
    db.prepare("INSERT INTO stock_movements (id, product_id, qty_delta, reason, created_at, value_minor) VALUES ('m1', ?, 4, 'count', ?, 0)").run(p.id, new Date().toISOString());
    const r = report.build(dates.localDate(), dates.localDate());
    expect(r.stock.costMissingCount).toBe(1);
    expect(r.notes.some((n) => n.includes("no cost"))).toBe(true);
  });
});

describe("suppliers", () => {
  it("shows purchases in the range and what is owed now", () => {
    buildShop(db);
    const r = report.build("2026-11-10", "2026-11-10");
    expect(r.suppliers.lines).toEqual([
      { supplier: "Meat Co", purchases: 2, boughtMinor: 500_000, paidMinor: 300_000, owedNowMinor: 200_000 },
      { supplier: "Bakery", purchases: 1, boughtMinor: 50_000, paidMinor: 0, owedNowMinor: 50_000 },
    ]);
    expect(r.suppliers).toMatchObject({ boughtMinor: 550_000, paidMinor: 300_000, owedNowMinor: 250_000 });
  });

  it("still lists what is owed when nothing was bought in the range", () => {
    buildShop(db);
    const r = report.build("2026-12-01", "2026-12-01");
    expect(r.suppliers.lines.map((l) => [l.supplier, l.purchases, l.boughtMinor, l.owedNowMinor])).toEqual([["Meat Co", 0, 0, 200_000], ["Bakery", 0, 0, 50_000]]);
  });
});

describe("customers and Khata", () => {
  it("adds up what customers owe, and credit sales and repayments in the range", () => {
    const customers = new CustomerService(db);
    const burger = products.create({ name: "Burger", priceMinor: 50_000, trackStock: false });
    const ali = customers.create({ name: "Ali" });
    const sara = customers.create({ name: "Sana" });
    sales.checkout({ lines: [{ productId: burger.id, qty: 1 }], payments: [], onAccountMinor: 50_000, customerId: ali.id });
    sales.checkout({ lines: [{ productId: burger.id, qty: 2 }], payments: card(40_000), onAccountMinor: 60_000, customerId: sara.id });
    customers.repay(ali.id, 20_000, "cash");
    const today = dates.localDate();
    const r = report.build(today, today);
    expect(r.customers.owing.map((d) => [d.name, d.owedMinor])).toEqual([["Sana", 60_000], ["Ali", 30_000]]);
    expect(r.customers.owedTotalMinor).toBe(90_000);
    expect(r.customers.creditSalesMinor).toBe(110_000);
    expect(r.customers.repaidMinor).toBe(20_000);
    expect(r.onAccountMinor).toBe(110_000);
    expect(r.paymentMethods).toEqual([{ method: "card", amountMinor: 40_000 }]); // account sales are not money received
    expect(r.pnl.netSalesMinor).toBe(150_000); // but they are income
    expect(report.build("2026-01-01", "2026-01-02").customers).toMatchObject({ creditSalesMinor: 0, repaidMinor: 0, owedTotalMinor: 90_000 });
  });
});

describe("staff and shifts", () => {
  it("counts each person's sales and voids, and reports the shift with its cash difference", () => {
    const { shift } = buildShop(db);
    const r = report.build("2026-11-10", "2026-11-11");
    expect(r.staff).toEqual([
      { userId: expect.any(String), name: "Sara", salesCount: 2, salesMinor: 150_000, voidCount: 1, averageSaleMinor: 75_000 },
      { userId: expect.any(String), name: "Maryam", salesCount: 1, salesMinor: 40_000, voidCount: 0, averageSaleMinor: 40_000 },
    ]);
    expect(r.shifts).toHaveLength(1);
    expect(r.shifts[0]).toMatchObject({ shiftId: shift.id, cashier: "Sara", salesCount: 2, salesMinor: 150_000, openingCashMinor: 50_000, countedCashMinor: 168_000 });
    expect(r.shifts[0]!.varianceMinor).toBe(-2_000); // counted 1,680.00 against 1,700.00 expected
  });
});

describe("empty and bad input", () => {
  it("gives zeros and empty lists for a brand new shop, without inventing anything", () => {
    const today = dates.localDate();
    const r = report.build(today, today);
    expect(r.pnl).toMatchObject({ salesCount: 0, netSalesMinor: 0, cogsMinor: 0, grossProfitMinor: 0, netProfitMinor: 0, averageOrderMinor: 0 });
    expect(r.pnl.grossMarginPct).toBeNull();
    expect(r.paymentMethods).toEqual([]);
    expect([r.topProducts, r.slowProducts, r.stock.lines, r.suppliers.lines, r.customers.owing, r.staff, r.shifts].every((l) => l.length === 0)).toBe(true);
    expect([r.stock.valueMinor, r.suppliers.owedNowMinor, r.customers.owedTotalMinor]).toEqual([0, 0, 0]);
    expect(r.pnl.daily).toEqual([{ date: today, orders: 0, salesMinor: 0, cogsMinor: 0, grossProfitMinor: 0 }]);
  });
  it("refuses a range that ends before it starts or a bad date", () => {
    expect(() => report.build("2026-11-10", "2026-11-09")).toThrow("end date");
    expect(() => report.build("nope", "2026-11-09")).toThrow("date like");
  });
  it("stamps when it was made", () => {
    expect(report.build("2026-11-10", "2026-11-10").generatedAt).toBe("2026-11-22T12:00:00.000Z");
  });
});
