import { afterEach, describe, expect, it } from "vitest";
import {
  ExpenseService,
  FinanceService,
  ProductService,
  ReportCentreService,
  SaleService,
  ReportService,
  dates,
  formatReceipt,
  openDatabase,
  presetRange,
  type Db,
} from "../src/index.js";

const PK = { timeZone: "Asia/Karachi", cutoffHour: 0 }; // UTC+5, no daylight saving
const NY = { timeZone: "America/New_York", cutoffHour: 0 };

afterEach(() => dates.setBusinessCalendar({ timeZone: "", cutoffHour: 0 }));

describe("a business day in the shop's time zone", () => {
  it("starts at local midnight in Karachi, not UTC midnight", () => {
    dates.setBusinessCalendar(PK);
    expect(dates.dayStartISO("2026-11-23")).toBe("2026-11-22T19:00:00.000Z");
    expect(dates.dayEndISO("2026-11-23")).toBe("2026-11-23T19:00:00.000Z");
    expect(dates.localDate("2026-11-22T18:59:59.999Z")).toBe("2026-11-22"); // 23:59:59.999 in Karachi
    expect(dates.localDate("2026-11-22T19:00:00.000Z")).toBe("2026-11-23"); // exactly midnight
  });
  it("gives a different day to the same instant in different zones", () => {
    const t = "2026-11-23T02:30:00.000Z";
    dates.setBusinessCalendar(PK);
    expect(dates.localDate(t)).toBe("2026-11-23"); // 07:30
    dates.setBusinessCalendar(NY);
    expect(dates.localDate(t)).toBe("2026-11-22"); // 21:30 the evening before
    dates.setBusinessCalendar({ timeZone: "Pacific/Auckland", cutoffHour: 0 });
    expect(dates.localDate(t)).toBe("2026-11-23"); // 15:30
  });
  it("handles half-hour and 45-minute offsets", () => {
    dates.setBusinessCalendar({ timeZone: "Asia/Kolkata", cutoffHour: 0 });
    expect(dates.dayStartISO("2026-11-23")).toBe("2026-11-22T18:30:00.000Z");
    dates.setBusinessCalendar({ timeZone: "Asia/Kathmandu", cutoffHour: 0 });
    expect(dates.dayStartISO("2026-11-23")).toBe("2026-11-22T18:15:00.000Z");
  });
  it("falls back to the machine's zone when none (or an unknown one) is set", () => {
    dates.setBusinessCalendar({ timeZone: "Mars/Olympus", cutoffHour: 99 });
    expect(dates.getBusinessCalendar()).toEqual({ timeZone: "", cutoffHour: 0 });
    expect(dates.dayStartISO("2026-11-23")).toBe(new Date(2026, 10, 23).toISOString());
  });
});

describe("the business-day cut-off", () => {
  it("moves the start of the day to the cut-off hour, inclusive, and the end exclusive", () => {
    dates.setBusinessCalendar({ ...PK, cutoffHour: 4 });
    expect(dates.dayStartISO("2026-11-23")).toBe("2026-11-22T23:00:00.000Z"); // 04:00 in Karachi
    expect(dates.dayEndISO("2026-11-23")).toBe("2026-11-23T23:00:00.000Z");
    expect(dates.localDate("2026-11-22T22:59:59.999Z")).toBe("2026-11-22"); // 03:59:59.999 still the day before
    expect(dates.localDate("2026-11-22T23:00:00.000Z")).toBe("2026-11-23"); // 04:00:00.000 the new day
    expect(dates.localDate("2026-11-23T20:00:00.000Z")).toBe("2026-11-23"); // 01:00 next morning is still the 23rd
  });
  it("is the same instant for one day's end and the next day's start", () => {
    dates.setBusinessCalendar({ ...PK, cutoffHour: 5 });
    for (const d of ["2026-02-28", "2026-12-31", "2028-02-28"]) {
      expect(dates.dayEndISO(d)).toBe(dates.dayStartISO(dates.addDays(d, 1)));
    }
  });
  it("gives every instant to exactly one day, across daylight-saving changes, for every cut-off", () => {
    for (const cutoffHour of [0, 1, 2, 3, 4, 8]) {
      for (const timeZone of ["America/New_York", "Australia/Sydney", "Europe/London", "Asia/Karachi"]) {
        dates.setBusinessCalendar({ timeZone, cutoffHour });
        for (let t = Date.UTC(2026, 2, 1); t < Date.UTC(2026, 3, 5); t += 30 * 60_000) { // March: spring clocks in the US/UK, autumn in Sydney
          const d = dates.localDate(t);
          expect(new Date(t).toISOString() >= dates.dayStartISO(d), `${timeZone} ${cutoffHour} ${new Date(t).toISOString()} before start of ${d}`).toBe(true);
          expect(new Date(t).toISOString() < dates.dayEndISO(d), `${timeZone} ${cutoffHour} ${new Date(t).toISOString()} after end of ${d}`).toBe(true);
        }
        for (let t = Date.UTC(2026, 9, 20); t < Date.UTC(2026, 10, 10); t += 30 * 60_000) { // autumn clocks in the US/UK, spring in Sydney
          const d = dates.localDate(t);
          expect(new Date(t).toISOString() >= dates.dayStartISO(d)).toBe(true);
          expect(new Date(t).toISOString() < dates.dayEndISO(d)).toBe(true);
        }
      }
    }
  });
});

describe("daylight saving", () => {
  it("makes the spring-forward day 23 hours and the fall-back day 25 (New York)", () => {
    dates.setBusinessCalendar(NY);
    expect(dates.dayStartISO("2026-03-08")).toBe("2026-03-08T05:00:00.000Z"); // midnight EST
    expect(dates.dayEndISO("2026-03-08")).toBe("2026-03-09T04:00:00.000Z"); // midnight EDT: 23 hours later
    expect(dates.dayStartISO("2026-11-01")).toBe("2026-11-01T04:00:00.000Z"); // midnight EDT
    expect(dates.dayEndISO("2026-11-01")).toBe("2026-11-02T05:00:00.000Z"); // midnight EST: 25 hours later
  });
  it("makes the spring-forward day 23 hours south of the equator too (Sydney, 4 Oct 2026)", () => {
    dates.setBusinessCalendar({ timeZone: "Australia/Sydney", cutoffHour: 0 });
    expect(dates.dayStartISO("2026-10-04")).toBe("2026-10-03T14:00:00.000Z");
    expect(dates.dayEndISO("2026-10-04")).toBe("2026-10-04T13:00:00.000Z");
  });
  it("puts a cut-off that falls in the skipped hour at the first real instant after it", () => {
    dates.setBusinessCalendar({ ...NY, cutoffHour: 2 }); // 02:00 does not exist on 8 Mar 2026
    expect(dates.dayStartISO("2026-03-08")).toBe("2026-03-08T07:00:00.000Z"); // 03:00 EDT
    expect(dates.localDate("2026-03-08T06:59:59.999Z")).toBe("2026-03-07"); // 01:59:59 EST
    expect(dates.localDate("2026-03-08T07:00:00.000Z")).toBe("2026-03-08");
  });
  it("starts a cut-off in the repeated hour at its first occurrence", () => {
    dates.setBusinessCalendar({ ...NY, cutoffHour: 1 }); // 01:00 happens twice on 1 Nov 2026
    expect(dates.dayStartISO("2026-11-01")).toBe("2026-11-01T05:00:00.000Z"); // the first 01:00 (EDT)
    expect(dates.localDate("2026-11-01T05:59:00.000Z")).toBe("2026-11-01");
    expect(dates.localDate("2026-11-01T06:30:00.000Z")).toBe("2026-11-01"); // the second 01:30 (EST) is the same day
  });
});

describe("calendar arithmetic does not depend on the machine's zone", () => {
  it("adds days, counts days and finds weeks across month, year and leap days", () => {
    expect(dates.addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(dates.addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dates.addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(dates.daysInclusive("2026-03-01", "2026-03-31")).toBe(31);
    expect(dates.eachDate("2026-03-07", "2026-03-09")).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    expect(dates.isDate("2026-02-29")).toBe(false);
    expect(dates.isDate("2028-02-29")).toBe(true);
    expect(presetRange("this_week", "2026-11-22")).toEqual({ from: "2026-11-16", to: "2026-11-22" });
  });
  it("shows the shop's clock on a receipt, not the machine's", () => {
    dates.setBusinessCalendar(PK);
    expect(dates.wallClock("2026-11-22T19:30:00.000Z")).toEqual({ date: "2026-11-23", hour: 0, minute: 30, stamp: "2026-11-23 00:30" });
    dates.setBusinessCalendar({ ...PK, cutoffHour: 4 });
    // The wall clock ignores the cut-off: a customer sees 00:30, even though the business day is still the 22nd.
    expect(dates.wallClock("2026-11-22T19:30:00.000Z").stamp).toBe("2026-11-23 00:30");
    expect(dates.localDate("2026-11-22T19:30:00.000Z")).toBe("2026-11-22");
  });
});

describe("reports follow the calendar", () => {
  let db: Db;
  const setup = () => {
    db = openDatabase(":memory:");
    const products = new ProductService(db);
    const sales = new SaleService(db, "T1");
    const item = products.create({ name: "Tea", priceMinor: 10_000, costMinor: 4_000, trackStock: false });
    const sell = (iso: string, qty: number) => {
      const s = sales.checkout({ lines: [{ productId: item.id, qty }], payments: [{ method: "cash", amountMinor: qty * 10_000 }] });
      db.prepare("UPDATE sales SET created_at = ? WHERE id = ?").run(iso, s.id);
    };
    // Karachi is UTC+5. Local times: 22 Nov 23:30, 23 Nov 00:00, 23 Nov 03:59, 23 Nov 04:00, 23 Nov 23:59, 24 Nov 00:00.
    sell("2026-11-22T18:30:00.000Z", 1); // 22 Nov 23:30
    sell("2026-11-22T19:00:00.000Z", 2); // 23 Nov 00:00:00
    sell("2026-11-22T22:59:00.000Z", 3); // 23 Nov 03:59
    sell("2026-11-22T23:00:00.000Z", 4); // 23 Nov 04:00:00
    sell("2026-11-23T18:59:00.000Z", 5); // 23 Nov 23:59
    sell("2026-11-23T19:00:00.000Z", 6); // 24 Nov 00:00:00
    return { sales };
  };

  it("counts midnight-to-midnight in the shop's zone with no cut-off", () => {
    setup();
    dates.setBusinessCalendar(PK);
    const pl = new FinanceService(db).profitAndLoss("2026-11-23", "2026-11-23");
    expect(pl.salesCount).toBe(4); // 00:00, 03:59, 04:00 and 23:59 -- not 23:30 the night before, not 00:00 the next night
    expect(pl.netSalesMinor).toBe((2 + 3 + 4 + 5) * 10_000);
    expect(pl.cogsMinor).toBe((2 + 3 + 4 + 5) * 4_000);
    expect(pl.daily).toEqual([expect.objectContaining({ date: "2026-11-23", orders: 4, salesMinor: 140_000 })]);
  });
  it("with a 4 a.m. cut-off, the early hours belong to the day before", () => {
    setup();
    dates.setBusinessCalendar({ ...PK, cutoffHour: 4 });
    const fin = new FinanceService(db);
    const d22 = fin.profitAndLoss("2026-11-22", "2026-11-22");
    const d23 = fin.profitAndLoss("2026-11-23", "2026-11-23");
    expect(d22.salesCount).toBe(3); // 23:30, 00:00 and 03:59
    expect(d22.netSalesMinor).toBe((1 + 2 + 3) * 10_000);
    expect(d23.salesCount).toBe(3); // 04:00, 23:59 and 00:00 on the 24th (before 04:00)
    expect(d23.netSalesMinor).toBe((4 + 5 + 6) * 10_000);
    // Two days together equal the sum of the days, and nothing is counted twice or lost.
    const both = fin.profitAndLoss("2026-11-22", "2026-11-23");
    expect(both.netSalesMinor).toBe(d22.netSalesMinor + d23.netSalesMinor);
    expect(both.salesCount).toBe(6);
    expect(both.daily.map((d) => [d.date, d.orders])).toEqual([["2026-11-22", 3], ["2026-11-23", 3]]);
  });
  it("the report centre and the sales summary use the same boundaries as the profit and loss", () => {
    setup();
    dates.setBusinessCalendar({ ...PK, cutoffHour: 4 });
    const centre = new ReportCentreService(db).build("2026-11-23", "2026-11-23");
    expect(centre.pnl.salesCount).toBe(3);
    expect(centre.pnl.netSalesMinor).toBe(150_000);
    expect(centre.paymentMethods.find((m) => m.method === "cash")?.amountMinor).toBe(150_000);
    const summary = new ReportService(db).salesSummary(dates.dayStartISO("2026-11-23"), dates.dayEndISO("2026-11-23"));
    expect(summary.salesCount).toBe(3);
    expect(summary.totalMinor).toBe(150_000);
  });
  it("the busiest-hour chart uses the shop's clock", () => {
    setup();
    dates.setBusinessCalendar(PK);
    const pl = new FinanceService(db).profitAndLoss("2026-11-23", "2026-11-23");
    const byHour = Object.fromEntries(pl.hourly.map((h) => [h.hour, h.orders]));
    expect(byHour[0]).toBe(1);
    expect(byHour[3]).toBe(1);
    expect(byHour[4]).toBe(1);
    expect(byHour[23]).toBe(1);
  });
  it("files an expense under the business date it is entered on, and reports it on that date only", () => {
    setup();
    dates.setBusinessCalendar({ ...PK, cutoffHour: 4 });
    const exp = new ExpenseService(db);
    const cat = exp.addCategory("Misc");
    exp.add({ categoryId: cat.id, description: "Ice", amountMinor: 5_000, spentOn: "2026-11-22" });
    exp.add({ categoryId: cat.id, description: "Gas", amountMinor: 7_000, spentOn: "2026-11-23" });
    const fin = new FinanceService(db);
    expect(fin.profitAndLoss("2026-11-22", "2026-11-22").expensesMinor).toBe(5_000);
    expect(fin.profitAndLoss("2026-11-23", "2026-11-23").expensesMinor).toBe(7_000);
    expect(fin.profitAndLoss("2026-11-22", "2026-11-23").expensesMinor).toBe(12_000);
  });
  it("a sale keeps its exact stored time whatever the calendar says", () => {
    const { sales } = setup();
    const before = db.prepare("SELECT id, created_at FROM sales ORDER BY created_at").all();
    dates.setBusinessCalendar({ ...PK, cutoffHour: 6 });
    new FinanceService(db).profitAndLoss("2026-11-20", "2026-11-26");
    expect(db.prepare("SELECT id, created_at FROM sales ORDER BY created_at").all()).toEqual(before);
    expect(sales).toBeDefined();
  });
  it("prints the time on a receipt on the shop's clock", () => {
    const { sales } = setup();
    dates.setBusinessCalendar(PK);
    const id = (db.prepare("SELECT id FROM sales ORDER BY created_at LIMIT 1").get() as { id: string }).id;
    const text = formatReceipt(sales.get(id)!, { storeName: "T", currency: "PKR", locale: "en-PK", width: 48 });
    expect(text).toContain("Date:    2026-11-22 23:30");
  });
});
