import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dates, openDatabase, type Db } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { TillbaseApi } from "../shared/api";

let db: Db;
let api: TillbaseApi;

const build = () => createHandlers(db, "T1", () => Date.now(), { reportOutput: { open: async () => {}, save: async (n) => `/tmp/${n}` } });

beforeEach(async () => {
  db = openDatabase(":memory:");
  api = build();
  await api.setupOwner("Boss", "1111");
  const tea = await api.createProduct({ name: "Tea", priceMinor: 5_000, trackStock: false });
  await api.openShift(10_000);
  const { sale } = await api.checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: [{ method: "cash", amountMinor: 10_000 }] });
  // 22 Nov 2026, 22:59 UTC = 03:59 in Karachi on the 23rd.
  db.prepare("UPDATE sales SET created_at = '2026-11-22T22:59:00.000Z' WHERE id = ?").run(sale.id);
});
afterEach(() => dates.setBusinessCalendar({ timeZone: "", cutoffHour: 0 }));

const count = async (from: string, to: string) => (await api.profitAndLoss(from, to)).salesCount;

describe("the business profile's time zone and cut-off reach the reports", () => {
  it("applies a saved time zone straight away", async () => {
    await api.saveBusinessProfile({ timezone: "Asia/Karachi", dayCutoffHour: 0 });
    expect(await count("2026-11-23", "2026-11-23")).toBe(1);
    expect(await count("2026-11-22", "2026-11-22")).toBe(0);
    await api.saveBusinessProfile({ timezone: "America/New_York" }); // 17:59 on the 22nd there
    expect(await count("2026-11-22", "2026-11-22")).toBe(1);
    expect(await count("2026-11-23", "2026-11-23")).toBe(0);
  });

  it("moves 03:59 into the day before once the cut-off is 4", async () => {
    await api.saveBusinessProfile({ timezone: "Asia/Karachi", dayCutoffHour: 4 });
    expect(await count("2026-11-22", "2026-11-22")).toBe(1);
    expect(await count("2026-11-23", "2026-11-23")).toBe(0);
    expect((await api.reportCentre("2026-11-22", "2026-11-22")).pnl.salesCount).toBe(1);
    const s = await api.salesSummary(dates.dayStartISO("2026-11-22"), dates.dayEndISO("2026-11-22"));
    expect(s.salesCount).toBe(1);
    expect(s.totalMinor).toBe(10_000);
  });

  it("reads the saved profile when the app starts again on the same data", async () => {
    await api.saveBusinessProfile({ timezone: "Asia/Karachi", dayCutoffHour: 4 });
    dates.setBusinessCalendar({ timeZone: "", cutoffHour: 0 }); // a new process starts with the defaults
    const again = build();
    const owner = (await again.loginUsers()).find((u) => u.role === "owner")!;
    await again.login(owner.id, "1111");
    expect((await again.profitAndLoss("2026-11-22", "2026-11-22")).salesCount).toBe(1);
  });

  it("puts the business time zone on printed reports", async () => {
    await api.saveBusinessProfile({ timezone: "Asia/Karachi", dayCutoffHour: 0 });
    const html = await api.reportHtml({ kind: "daily-sales", from: "2026-11-23", to: "2026-11-23" });
    expect(html).toContain("Nov 23, 2026</p>");
  });

  it("leaves the stored sale time alone", async () => {
    await api.saveBusinessProfile({ timezone: "Pacific/Auckland", dayCutoffHour: 6 });
    expect((db.prepare("SELECT created_at AS t FROM sales").get() as { t: string }).t).toBe("2026-11-22T22:59:00.000Z");
  });
});
