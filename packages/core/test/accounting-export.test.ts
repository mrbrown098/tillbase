import { beforeEach, describe, expect, it } from "vitest";
import {
  AccountingExportService,
  ExpenseService,
  LabourService,
  ProductService,
  PurchaseService,
  SaleService,
  dates,
  decimal,
  parseCsv,
  openDatabase,
  type Db,
} from "../src/index.js";

let db: Db;
let products: ProductService;
let sales: SaleService;
let expenses: ExpenseService;
let purchases: PurchaseService;
let labour: LabourService;
let exporter: AccountingExportService;

beforeEach(() => {
  db = openDatabase(":memory:");
  products = new ProductService(db);
  sales = new SaleService(db, "T1");
  expenses = new ExpenseService(db);
  purchases = new PurchaseService(db);
  labour = new LabourService(db);
  exporter = new AccountingExportService(db);
});

/** 9:30 on 3 Nov, in the shop's time zone. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0).toISOString();
/** Sales are created "now"; move one to the day the story needs. */
const moveSale = (id: string, iso: string) => db.prepare("UPDATE sales SET created_at = ? WHERE id = ?").run(iso, id);
const movePurchase = (id: string, iso: string) => db.prepare("UPDATE purchases SET created_at = ? WHERE id = ?").run(iso, id);
const pay = (n: number) => [{ method: "card" as const, amountMinor: n }];
const lines = (csv: string) => csv.replace(/^﻿/, "").trimEnd().split("\r\n");

/**
 * The story, in 100.00 = 10,000 minor units (so 100.00 is written 10_000):
 *
 *   Tea   price 100.00, cost 40.00, 10% tax      Cake  price 300.00, cost 120.00, no tax
 *
 *   1 Nov  sale A: 2 Tea                 sub 200.00, tax 20.00, total 220.00
 *          sale B: 1 Cake, 50.00 off     sub 300.00, disc 50.00, tax 0, total 250.00
 *   2 Nov  no sales
 *   3 Nov  sale C: 3 Tea, 10.00 off      sub 300.00, disc 10.00, net 290.00, tax 29.00, total 319.00
 *          sale D: 1 Tea, then voided    counts for nothing
 *   4 Nov  sale E: 1 Tea                 outside the range 1 to 3 Nov
 */
function story() {
  const tea = products.create({ name: "Tea", priceMinor: 10_000, costMinor: 4_000, taxRateBp: 1000, trackStock: false });
  const cake = products.create({ name: "Cake", priceMinor: 30_000, costMinor: 12_000, trackStock: false });
  const A = sales.checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: pay(22_000) });
  const B = sales.checkout({ lines: [{ productId: cake.id, qty: 1, discountMinor: 5_000 }], payments: pay(25_000) });
  const C = sales.checkout({ lines: [{ productId: tea.id, qty: 3, discountMinor: 1_000 }], payments: pay(31_900) });
  const D = sales.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: pay(11_000) });
  sales.voidSale(D.id, "wrong order");
  const E = sales.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: pay(11_000) });
  moveSale(A.id, at(2026, 11, 1, 10));
  moveSale(B.id, at(2026, 11, 1, 15));
  moveSale(C.id, at(2026, 11, 3, 11));
  moveSale(D.id, at(2026, 11, 3, 12));
  moveSale(E.id, at(2026, 11, 4, 9));
  return { tea, cake };
}

describe("decimal money", () => {
  it("writes minor units as plain decimals, with no float rounding", () => {
    expect(decimal(0)).toBe("0.00");
    expect(decimal(5)).toBe("0.05");
    expect(decimal(12_345)).toBe("123.45");
    expect(decimal(100_000_000_007)).toBe("1000000000.07");
    expect(decimal(-83_050)).toBe("-830.50");
    expect(decimal(-5)).toBe("-0.05");
  });
});

describe("sales by day", () => {
  it("matches the hand calculation, day by day, with tax and a total", () => {
    story();
    const f = exporter.salesByDay("2026-11-01", "2026-11-03");
    expect(f.name).toBe("tillbase-sales-by-day-2026-11-01-to-2026-11-03.csv");
    expect(lines(f.csv)).toEqual([
      "Date,Orders,Sales before discounts,Discounts,Net sales (before tax),Tax collected,Total received",
      // 1 Nov: A 200.00 + B 300.00 = 500.00; discounts 50.00; net 450.00; tax 20.00; received 220.00 + 250.00 = 470.00
      "2026-11-01,2,500.00,50.00,450.00,20.00,470.00",
      "2026-11-02,0,0.00,0.00,0.00,0.00,0.00",
      // 3 Nov: C only (the voided D is ignored): 300.00 - 10.00 = 290.00, tax 29.00, received 319.00
      "2026-11-03,1,300.00,10.00,290.00,29.00,319.00",
      // 500 + 300 = 800; 50 + 10 = 60; net 740; tax 20 + 29 = 49; received 470 + 319 = 789
      "Total,3,800.00,60.00,740.00,49.00,789.00",
    ]);
  });

  it("starts with a byte-order mark and uses CRLF line ends so Excel opens it correctly", () => {
    story();
    const { csv } = exporter.salesByDay("2026-11-01", "2026-11-03");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.replace(/\r\n/g, "").includes("\n")).toBe(false);
    // And it reads back with the project's own CSV reader.
    expect(parseCsv(csv)[1]).toEqual(["2026-11-01", "2", "500.00", "50.00", "450.00", "20.00", "470.00"]);
  });

  it("gives a clean empty report for a range with no sales", () => {
    story();
    expect(lines(exporter.salesByDay("2026-10-01", "2026-10-02").csv)).toEqual([
      "Date,Orders,Sales before discounts,Discounts,Net sales (before tax),Tax collected,Total received",
      "2026-10-01,0,0.00,0.00,0.00,0.00,0.00",
      "2026-10-02,0,0.00,0.00,0.00,0.00,0.00",
      "Total,0,0.00,0.00,0.00,0.00,0.00",
    ]);
  });
});

describe("expenses by category", () => {
  it("adds up each category, leaves out cancelled and out-of-range entries, biggest first", () => {
    const cats = expenses.categories();
    const rent = cats.find((c) => c.name === "Rent")!.id;
    const power = cats.find((c) => c.name === "Electricity")!.id;
    expenses.add({ categoryId: rent, description: "Rent", amountMinor: 100_000, spentOn: "2026-11-01" });
    expenses.add({ categoryId: power, description: "Power", amountMinor: 20_000, spentOn: "2026-11-02" });
    expenses.add({ categoryId: power, description: "Top-up", amountMinor: 5_050, spentOn: "2026-11-03" });
    const mistake = expenses.add({ categoryId: power, description: "Typo", amountMinor: 99_999, spentOn: "2026-11-02" });
    expenses.void(mistake.id, "typed twice");
    expenses.add({ categoryId: rent, description: "Last month", amountMinor: 50_000, spentOn: "2026-10-31" });

    expect(lines(exporter.expensesByCategory("2026-11-01", "2026-11-03").csv)).toEqual([
      "Category,Entries,Amount",
      "Rent,1,1000.00",
      "Electricity,2,250.50", // 200.00 + 50.50
      "Total,3,1250.50",
    ]);
  });
});

describe("purchases", () => {
  it("lists each purchase with what was paid and what is still owed, and totals them", () => {
    const flour = products.create({ name: "Flour", kind: "ingredient", unit: "kg", priceMinor: 0 });
    const sugar = products.create({ name: "Sugar", kind: "ingredient", unit: "kg", priceMinor: 0 });
    const p1 = purchases.record({
      supplier: "Metro",
      reference: "INV-1",
      items: [
        { productId: flour.id, qty: 10, costMinor: 50_000 },
        { productId: sugar.id, qty: 5, costMinor: 30_000 },
      ],
      paidMinor: 50_000,
    });
    const p2 = purchases.record({
      supplier: "=SUM(1+1)", // text typed by staff must never run as a formula
      items: [{ productId: flour.id, qty: 1, costMinor: 12_345 }],
      paidMinor: 12_345,
    });
    const p3 = purchases.record({ supplier: "Later", items: [{ productId: flour.id, qty: 1, costMinor: 99_900 }], paidMinor: 0 });
    movePurchase(p1.id, at(2026, 11, 1));
    movePurchase(p2.id, at(2026, 11, 3, 10));
    movePurchase(p3.id, at(2026, 11, 5));

    expect(lines(exporter.purchases("2026-11-01", "2026-11-03").csv)).toEqual([
      "Date,Supplier,Reference,Note,Items,Total,Paid,Outstanding",
      "2026-11-01,Metro,INV-1,,2,800.00,500.00,300.00", // 500.00 + 300.00 bought, 500.00 paid
      "2026-11-03,'=SUM(1+1),,,1,123.45,123.45,0.00",
      "Total,,,,3,923.45,623.45,300.00", // 800 + 123.45; paid 500 + 123.45; owed 300
    ]);
  });
});

describe("payroll", () => {
  function runAli() {
    const ali = labour.createEmployee({ name: "Ali", payType: "hourly", payRateMinor: 10_000 });
    for (const d of [3, 4, 5]) labour.addShift(ali.id, at(2026, 11, d, 9), at(2026, 11, d, 17));
    labour.giveAdvance(ali.id, 50_000, "2026-11-02", "eid shopping");
    return {
      ali,
      slip: labour.finalize({
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
        lines: [{ employeeId: ali.id, bonusMinor: 10_000, deductionsMinor: 5_000, recoverAdvanceMinor: 30_000 }],
      })[0]!,
    };
  }

  it("shows each payslip with hours, pay, deductions and what was taken back for advances", () => {
    runAli();
    expect(lines(exporter.payroll("2026-11-01", "2026-11-30").csv)).toEqual([
      "Employee,Period start,Period end,Days,Hours,Basic pay,Overtime,Bonus,Deductions,Advances taken back,Net pay,Cost to business,Paid,Paid on,How paid",
      // 3 days x 8 h = 24 h at 100.00 = 2400.00; +100.00 bonus -50.00 deductions -300.00 advance = 2150.00 take-home;
      // cost to the business is 2400 + 100 - 50 = 2450.00
      "Ali,2026-11-01,2026-11-30,3,24.00,2400.00,0.00,100.00,50.00,300.00,2150.00,2450.00,0.00,,",
      "Total,,,3,24.00,2400.00,0.00,100.00,50.00,300.00,2150.00,2450.00,0.00,,",
    ]);
  });

  it("shows when and how a payslip was paid", () => {
    const { slip } = runAli();
    labour.pay(slip.id, "cash");
    const rows = lines(exporter.payroll("2026-11-01", "2026-11-30").csv);
    expect(rows[1]).toBe(`Ali,2026-11-01,2026-11-30,3,24.00,2400.00,0.00,100.00,50.00,300.00,2150.00,2450.00,2150.00,${dates.localDate()},cash`);
  });

  it("includes a payslip only if its pay period ends inside the range", () => {
    runAli();
    expect(lines(exporter.payroll("2026-11-01", "2026-11-29").csv)).toHaveLength(2); // header + Total only
  });
});

describe("profit and loss", () => {
  it("agrees with the hand calculation and with the other files", () => {
    story();
    const cats = expenses.categories();
    expenses.add({ categoryId: cats.find((c) => c.name === "Rent")!.id, description: "Rent", amountMinor: 100_000, spentOn: "2026-11-01" });
    expenses.add({ categoryId: cats.find((c) => c.name === "Electricity")!.id, description: "Power", amountMinor: 25_050, spentOn: "2026-11-03" });

    const f = exporter.profitAndLoss("2026-11-01", "2026-11-03");
    expect(lines(f.csv)).toEqual([
      "Section,Line,Amount",
      'Income,"Net sales (before tax, after discounts)",740.00', // 450.00 + 290.00
      // Goods sold: 5 Tea x 40.00 (2 on 1 Nov, 3 on 3 Nov) + 1 Cake x 120.00 = 320.00
      "Cost of sales,Ingredients and goods sold,320.00",
      ",Gross profit,420.00",
      "Expenses,Wastage and losses,0.00",
      "Expenses,Rent,1000.00",
      "Expenses,Electricity,250.50",
      "Expenses,Wages (payroll run plus estimate for days not yet run),0.00",
      // 420.00 - 1250.50 = -830.50
      ",Net loss,-830.50",
      'Memo,"Sales tax collected (owed to the government, not income)",49.00',
      "Memo,Discounts given,60.00",
      'Memo,"Wages estimated, not yet through payroll",0.00',
      'Note,"No wages are recorded for this period, so profit is overstated.",',
    ]);
  });
});

describe("the whole set", () => {
  it("returns the five files, each opening with a byte-order mark", () => {
    story();
    const files = exporter.all("2026-11-01", "2026-11-03");
    expect(files.map((f) => f.kind)).toEqual(["sales-by-day", "expenses-by-category", "purchases", "payroll", "profit-and-loss"]);
    expect(new Set(files.map((f) => f.name)).size).toBe(5);
    for (const f of files) expect(f.csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("totals agree between files", () => {
    story();
    const sales = lines(exporter.salesByDay("2026-11-01", "2026-11-03").csv).at(-1)!.split(",");
    const pl = lines(exporter.profitAndLoss("2026-11-01", "2026-11-03").csv);
    expect(pl[1]).toContain(sales[4]!); // net sales in both
  });

  it("rejects bad dates and backwards ranges", () => {
    expect(() => exporter.all("nope", "2026-11-03")).toThrow(/date/);
    expect(() => exporter.all("2026-11-03", "2026-11-01")).toThrow(/cannot be before/);
  });
});
