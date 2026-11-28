import { describe, expect, it } from "vitest";
import { withTillbaseFooter, TILLBASE_FOOTER } from "../src/branding.js";
import { barChart, hBarChart, lineChart, safeColor } from "../src/charts.js";
import { addDays, daysInclusive, localDate } from "../src/dates.js";
import { presetRange } from "../src/report-range.js";

describe("chart colours cannot break out of the SVG", () => {
  const evil = '#fff" onload="alert(1)';
  it("accepts hex colours and replaces anything else", () => {
    expect(safeColor("#1d4ed8")).toBe("#1d4ed8");
    expect(safeColor("#abc")).toBe("#abc");
    expect(safeColor(evil)).not.toContain("onload");
    expect(safeColor("red")).not.toBe("red");
    expect(safeColor("url(#x)")).not.toContain("url");
  });
  it("never writes an unsafe colour into any chart", () => {
    const series = [{ name: "Sales", values: [100, 200], color: evil }];
    const svgs = [
      barChart({ labels: ["a", "b"], series, title: "t" }),
      lineChart({ labels: ["a", "b"], series, title: "t" }),
      hBarChart({ rows: [{ label: "x", value: 5, display: "5" }], title: "t", color: evil }),
    ];
    for (const svg of svgs) expect(svg).not.toMatch(/onload|alert\(/);
  });
});

describe("the Tillbase footer helper", () => {
  it("adds the credit once and trims trailing blanks", () => {
    expect(withTillbaseFooter("Thanks\n\n  ")).toBe(`Thanks\n${TILLBASE_FOOTER}`);
    expect(withTillbaseFooter(`Thanks\n${TILLBASE_FOOTER}`)).toBe(`Thanks\n${TILLBASE_FOOTER}`);
  });
  it("is fast on a very long run of spaces (no catastrophic backtracking)", () => {
    const t = Date.now();
    withTillbaseFooter("x" + " ".repeat(200_000) + "y");
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("report date ranges are whole calendar days, whatever the time zone or clock changes", () => {
  it("steps one calendar day at a time across a spring-forward and fall-back week", () => {
    // These dates are daylight-saving changes in the USA (2026-03-08, 2026-11-01), Europe (2026-03-29, 2026-10-25)
    // and Australia (2026-04-05, 2026-10-04). In a time zone without them the steps are still one day.
    for (const start of ["2026-03-06", "2026-03-27", "2026-04-03", "2026-10-02", "2026-10-23", "2026-10-30"]) {
      let d = start;
      for (let i = 1; i <= 6; i++) {
        const next = addDays(d, 1);
        expect(daysInclusive(d, next)).toBe(2);
        expect(addDays(next, -1)).toBe(d);
        d = next;
      }
    }
  });
  it("counts days inclusively across a clock change", () => {
    expect(daysInclusive("2026-03-01", "2026-03-31")).toBe(31);
    expect(daysInclusive("2026-10-01", "2026-10-31")).toBe(31);
    expect(daysInclusive("2026-12-31", "2027-01-01")).toBe(2);
  });
  it("presets are whole days and the week starts on Monday", () => {
    expect(presetRange("this_week", "2026-03-08")).toEqual({ from: "2026-03-02", to: "2026-03-08" }); // a Sunday
    expect(presetRange("this_week", "2026-03-09")).toEqual({ from: "2026-03-09", to: "2026-03-09" }); // a Monday
    expect(presetRange("yesterday", "2026-03-09")).toEqual({ from: "2026-03-08", to: "2026-03-08" });
    expect(presetRange("this_month", "2026-11-23")).toEqual({ from: "2026-11-01", to: "2026-11-23" });
  });
  it("localDate follows the calendar, not 24-hour blocks", () => {
    expect(localDate(new Date(2026, 2, 8, 23, 30))).toBe("2026-03-08");
    expect(localDate(new Date(2026, 2, 9, 0, 30))).toBe("2026-03-09");
  });
});
