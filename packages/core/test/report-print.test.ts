import { describe, expect, it } from "vitest";
import {
  CustomerService, ProductService, SaleService, PDF_FOOTER_TEMPLATE, PurchaseOrderService, ReportCentreService, TILLBASE_FOOTER, buildReportHtml, formatKitchenTicket, formatReceipt,
  formatStatement, openDatabase, reportTitles, withTillbaseFooter, type ReportKind, type ReportShop,
} from "../src/index.js";
import { shop as buildShop } from "./report-fixture.js";

const shopInfo: ReportShop = { name: "Bun & Co. Grill", logo: "", currency: "PKR", locale: "en-PK", timeZone: "UTC" };
const NOW = "2026-11-22T12:00:00.000Z";
const count = (s: string, needle: string) => s.split(needle).length - 1;

function fixture() {
  const db = openDatabase(":memory:");
  buildShop(db);
  const centre = new ReportCentreService(db, () => Date.parse(NOW)).build("2026-11-10", "2026-11-11");
  const customers = new CustomerService(db);
  const ali = customers.create({ name: "Ali Raza", phone: "0300 1234567" });
  return { db, centre, customerStatement: customers.statement(ali.id), supplierStatement: new PurchaseOrderService(db).statement("Meat Co") };
}

describe("every A4 report", () => {
  const kinds = Object.keys(reportTitles) as ReportKind[];

  it.each(kinds)("%s: is a complete A4 page with the shop, title, dates and the Tillbase footer once", (kind) => {
    const f = fixture();
    const html = buildReportHtml({ kind, shop: shopInfo, generatedAt: NOW, centre: f.centre, customerStatement: f.customerStatement, supplierStatement: f.supplierStatement });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("size: A4");
    expect(html).toContain("Bun &amp; Co. Grill");
    expect(html).toContain(`<h1>${reportTitles[kind]}</h1>`);
    expect(html).toMatch(/Generated 22.Nov.2026/);
    expect(count(html, TILLBASE_FOOTER)).toBe(1);
    expect(html).not.toMatch(/<script/i);
    // header rows repeat on every page and rows are never split in half
    expect(html).toContain("thead { display: table-header-group; }");
    expect(html).toContain("break-inside: avoid");
  });

  it("shows the range the report was made for", () => {
    const f = fixture();
    const html = buildReportHtml({ kind: "profit-loss", shop: shopInfo, generatedAt: NOW, centre: f.centre });
    expect(html).toContain("10 Nov 2026 to 11 Nov 2026");
  });

  it("profit and loss shows each step of the calculation, with the figures worked out by hand", () => {
    const f = fixture();
    const html = buildReportHtml({ kind: "profit-loss", shop: shopInfo, generatedAt: NOW, centre: f.centre });
    // 10-11 Nov: sales 1,900.00; cost of goods 900.00; gross 1,000.00; rent 200.00; net 800.00
    for (const text of ["Rs&nbsp;1,900", "Cost of goods sold", "= Gross profit", "Rent", "= Net profit"]) {
      expect(html.replace(/Rs\s?/g, "Rs&nbsp;")).toContain(text);
    }
    expect(html).toContain("1,900");
    expect(html).toContain("1,000");
    expect(html).toContain("800");
    expect(html).toContain("1 item sold has no cost set (Cola)"); // missing costs are said out loud, on paper
  });

  it("marks an unknown cost instead of showing a made-up profit", () => {
    const f = fixture();
    const html = buildReportHtml({ kind: "product-performance", shop: shopInfo, generatedAt: NOW, centre: f.centre });
    expect(html).toContain("Cola (no cost set)");
    expect(html).toContain("unknown");
  });

  it("escapes everything that comes from the shop's data", () => {
    const f = fixture();
    const html = buildReportHtml({ kind: "daily-sales", shop: { ...shopInfo, name: `<script>alert(1)</script>"x"` }, generatedAt: NOW, centre: f.centre });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("only accepts a real picture data URL as the logo", () => {
    const f = fixture();
    const good = buildReportHtml({ kind: "stock", shop: { ...shopInfo, logo: "data:image/png;base64,iVBORw0KGgo=" }, generatedAt: NOW, centre: f.centre });
    expect(good).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="">');
    const bad = buildReportHtml({ kind: "stock", shop: { ...shopInfo, logo: `javascript:alert(1)"><script>` }, generatedAt: NOW, centre: f.centre });
    expect(bad).not.toContain("<img");
  });

  it("works for a brand-new shop with nothing in it", () => {
    const db = openDatabase(":memory:");
    const centre = new ReportCentreService(db, () => Date.parse(NOW)).build("2026-11-10", "2026-11-10");
    for (const kind of ["daily-sales", "monthly-sales", "profit-loss", "expenses", "stock", "product-performance", "staff-shifts"] as ReportKind[]) {
      const html = buildReportHtml({ kind, shop: shopInfo, generatedAt: NOW, centre });
      expect(count(html, TILLBASE_FOOTER)).toBe(1);
      expect(html).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it("PDF mode leaves the footer to the PDF step, which draws it with the page number on every page", () => {
    const f = fixture();
    const html = buildReportHtml({ kind: "stock", shop: shopInfo, generatedAt: NOW, centre: f.centre }, { forPdf: true });
    expect(count(html, TILLBASE_FOOTER)).toBe(0);
    expect(PDF_FOOTER_TEMPLATE).toContain(TILLBASE_FOOTER);
    expect(PDF_FOOTER_TEMPLATE).toContain("pageNumber");
    expect(PDF_FOOTER_TEMPLATE).toContain("totalPages");
  });

  it("refuses to build a report without its data", () => {
    expect(() => buildReportHtml({ kind: "stock", shop: shopInfo, generatedAt: NOW })).toThrow("figures");
    expect(() => buildReportHtml({ kind: "customer-statement", shop: shopInfo, generatedAt: NOW })).toThrow("customer statement");
  });
});

describe("the Tillbase footer on thermal prints", () => {
  const { sale } = (() => {
    const db = openDatabase(":memory:");
    const tea = new ProductService(db).create({ name: "Tea", priceMinor: 5_000, trackStock: false });
    return { sale: new SaleService(db, "T1").checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: [{ method: "cash", amountMinor: 10_000 }] }) };
  })();

  it.each([[32, "58 mm"], [48, "80 mm"]])("receipt at %i characters (%s) ends with the shop's message and then the Tillbase line", (width) => {
    const text = formatReceipt(sale, { storeName: "Bun Shop", currency: "PKR", locale: "en-PK", width: width as number, footer: "Come again soon" });
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe(TILLBASE_FOOTER);
    expect(lines.at(-2)).toBe("Come again soon");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(width);
  });

  it("the shop can have no message of its own and the Tillbase line is still there", () => {
    const text = formatReceipt(sale, { storeName: "Bun Shop", currency: "PKR", locale: "en-PK", width: 32, footer: "" });
    expect(text.split("\n").at(-1)).toBe(TILLBASE_FOOTER);
  });

  it("the footer is not part of the options: nothing a caller passes can remove it", () => {
    const opts = { storeName: "S", currency: "PKR", locale: "en-PK", width: 32, footer: "x", showCredit: false, credit: false, brand: false } as never;
    expect(formatReceipt(sale, opts).endsWith(TILLBASE_FOOTER)).toBe(true);
  });

  it("kitchen tickets end with the Tillbase line", () => {
    const text = formatKitchenTicket({ orderId: "o1", token: 7, type: "dine_in", tableLabel: "4", note: "No onions", items: [{ name: "Tea", qty: 2, modifiers: [], note: null }] }, { width: 32 });
    expect(text.split("\n").at(-1)).toBe(TILLBASE_FOOTER);
    expect(text).toContain("ORDER NOTE: No onions");
    expect(text).toContain("2 x Tea");
  });

  it("customer statements end with the shop's message, then the Tillbase line", () => {
    const db = openDatabase(":memory:");
    const customers = new CustomerService(db);
    const c = customers.create({ name: "Ali" });
    const text = formatStatement(customers.statement(c.id), { storeName: "Bun Shop", currency: "PKR", locale: "en-PK", width: 48, footer: "Thanks" });
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe(TILLBASE_FOOTER);
    expect(lines.at(-2)).toBe("Thanks");
  });

  it("withTillbaseFooter adds the line once and never twice", () => {
    expect(withTillbaseFooter("Hello\n")).toBe(`Hello\n${TILLBASE_FOOTER}`);
    expect(withTillbaseFooter(withTillbaseFooter("Hello"))).toBe(`Hello\n${TILLBASE_FOOTER}`);
  });
});
