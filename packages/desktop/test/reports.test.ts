import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, PDF_FOOTER_TEMPLATE, TILLBASE_FOOTER } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import { channels, type TillbaseApi } from "../shared/api";

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const ascii = (s: string) => hex(Array.from(s, (c) => c.charCodeAt(0)));

let api: TillbaseApi;
let sent: Uint8Array[];
let opened: { name: string; html: string }[];
let saved: { name: string; html: string }[];

async function as(name: string, role: "owner" | "manager" | "cashier") {
  await api.logout();
  const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
  await api.login(owner.id, "1111");
  if (role === "owner") return;
  if (!(await api.loginUsers()).some((u) => u.name === name)) await api.createStaff({ name, pin: "2222", role });
  const u = (await api.loginUsers()).find((x) => x.name === name)!;
  await api.logout();
  await api.login(u.id, "2222");
}

async function sell() {
  const tea = await api.createProduct({ name: "Tea", priceMinor: 5_000, trackStock: false });
  if (!(await api.session()).shift) await api.openShift(10_000);
  return (await api.checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: [{ method: "cash", amountMinor: 10_000 }] })).sale;
}

beforeEach(async () => {
  sent = [];
  opened = [];
  saved = [];
  api = createHandlers(openDatabase(":memory:"), "T1", () => Date.now(), {
    printing: { send: async (_h, _p, bytes) => { sent.push(bytes); }, decodeLogo: () => null },
    reportOutput: {
      open: async (name, html) => { opened.push({ name, html }); },
      save: async (name, html) => { saved.push({ name, html }); return `/tmp/${name}`; },
    },
  });
  await api.setupOwner("Boss", "1111");
  await api.updateSettings({ storeName: "Bun & Co." });
});

describe("report permissions", () => {
  it("the new calls are wired through", () => {
    for (const n of ["reportCentre", "reportHtml", "printReport", "saveReportPdf"]) {
      expect(channels).toContain(n);
      expect(typeof (api as unknown as Record<string, unknown>)[n]).toBe("function");
    }
  });

  it("the owner can open the report centre and every report", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const r = await api.reportCentre(day, day);
    expect(r.pnl.salesCount).toBe(0);
    for (const kind of ["daily-sales", "monthly-sales", "profit-loss", "expenses", "stock", "product-performance", "staff-shifts"] as const) {
      expect(await api.reportHtml({ kind, from: day, to: day })).toContain(TILLBASE_FOOTER);
    }
  });

  it("managers and cashiers cannot see profit figures or any business report", async () => {
    const day = new Date().toISOString().slice(0, 10);
    for (const role of ["manager", "cashier"] as const) {
      await as(role === "manager" ? "Mo" : "Cy", role);
      await expect(api.reportCentre(day, day)).rejects.toThrow(/permission/);
      for (const kind of ["daily-sales", "profit-loss", "stock", "staff-shifts"] as const) {
        await expect(api.reportHtml({ kind, from: day, to: day })).rejects.toThrow(/permission/);
        await expect(api.printReport({ kind, from: day, to: day })).rejects.toThrow(/permission/);
        await expect(api.saveReportPdf({ kind, from: day, to: day })).rejects.toThrow(/permission/);
      }
    }
    expect(opened).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it("nobody signed out can read a report", async () => {
    await api.logout();
    await expect(api.reportCentre("2026-01-01", "2026-01-01")).rejects.toThrow(/sign in/i);
  });

  it("statements follow the screen they belong to: cashiers may print a customer's, only purchasers a supplier's", async () => {
    const c = await api.createCustomer({ name: "Ayesha Khan" });
    await as("Cy", "cashier");
    const html = await api.reportHtml({ kind: "customer-statement", from: "2026-01-01", to: "2026-12-31", customerId: c.id });
    expect(html).toContain("Ayesha Khan");
    await expect(api.reportHtml({ kind: "supplier-statement", from: "2026-01-01", to: "2026-12-31", supplier: "Metro" })).rejects.toThrow(/permission/);
    await as("Mo", "manager");
    expect(await api.reportHtml({ kind: "supplier-statement", from: "2026-01-01", to: "2026-12-31", supplier: "Metro" })).toContain("Metro");
  });

  it("asks for the customer or supplier a statement is for", async () => {
    await expect(api.reportHtml({ kind: "customer-statement", from: "2026-01-01", to: "2026-01-01" })).rejects.toThrow(/Choose a customer/);
    await expect(api.reportHtml({ kind: "supplier-statement", from: "2026-01-01", to: "2026-01-01" })).rejects.toThrow(/Choose a supplier/);
  });
});

describe("daily and monthly reports choose their own dates", () => {
  it("daily uses the 'to' day; monthly uses the whole month that day is in", async () => {
    const d = await api.reportHtml({ kind: "daily-sales", from: "2026-11-01", to: "2026-11-15" });
    expect(d).toContain("Nov 15, 2026");
    expect(d).not.toContain("Nov 1, 2026 to");
    const m = await api.reportHtml({ kind: "monthly-sales", from: "2026-11-15", to: "2026-11-15" });
    expect(m).toContain("Nov 1, 2026 to Nov 30, 2026");
  });

  it("a bad date is refused in plain words", async () => {
    await expect(api.reportHtml({ kind: "profit-loss", from: "tomorrow", to: "2026-01-01" })).rejects.toThrow(/date like/);
    await expect(api.reportHtml({ kind: "profit-loss", from: "2026-02-02", to: "2026-02-01" })).rejects.toThrow(/end date/);
  });
});

describe("printing and saving a report", () => {
  it("hands the output step an A4 page in PDF mode, named after the report, and the footer comes with the PDF template", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const name = await api.printReport({ kind: "stock", from: day, to: day });
    expect(name).toBe(`Stock_report_${day}.pdf`);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.html).toContain("size: A4");
    expect(opened[0]!.html).toContain("Bun &amp; Co.");
    expect(opened[0]!.html).not.toContain(TILLBASE_FOOTER); // drawn by the PDF step on every page instead
    expect(PDF_FOOTER_TEMPLATE).toContain(TILLBASE_FOOTER);
    expect(await api.saveReportPdf({ kind: "stock", from: day, to: day })).toBe(`/tmp/Stock_report_${day}.pdf`);
    expect(saved).toHaveLength(1);
  });

  it("file names are safe", async () => {
    const name = await api.printReport({ kind: "supplier-statement", from: "2026-01-01", to: "2026-01-31", supplier: "A/B: Foods?" });
    expect(name).toBe("Supplier_statement_A_B_Foods_2026-01-01_to_2026-01-31.pdf");
  });

  it("says so when the app cannot print reports", async () => {
    const bare = createHandlers(openDatabase(":memory:"), "T1", () => Date.now());
    await bare.setupOwner("Boss", "1111");
    await expect(bare.printReport({ kind: "stock", from: "2026-01-01", to: "2026-01-01" })).rejects.toThrow(/not available/);
  });
});

describe("the Tillbase footer on every thermal print", () => {
  it.each([[32, "58 mm"], [48, "80 mm"]])("receipt at %i characters (%s)", async (width) => {
    await api.setPrinter({ host: "10.0.0.9" });
    await api.updateSettings({ receiptWidth: width, receiptFooter: "Come again, friend!" });
    const sale = await sell();
    expect((await api.printReceipt(sale.id)).status).toBe("printed");
    const h = hex(sent[0]!);
    expect(h).toContain(ascii("Come again, friend!")); // the shop's own message is kept
    expect(h).toContain(ascii(TILLBASE_FOOTER));
    expect(h.indexOf(ascii("Come again, friend!"))).toBeLessThan(h.indexOf(ascii(TILLBASE_FOOTER)));
    expect(h.endsWith("1b 64 04 1d 56 42 00")).toBe(true);
  });

  it("kitchen ticket, customer statement and test page", async () => {
    await api.setPrinter({ host: "10.0.0.9" });
    const tea = await api.createProduct({ name: "Tea", priceMinor: 5_000, trackStock: false });
    await api.openShift(0);
    const o = await api.createOrder({ type: "dine_in", tableLabel: "4" });
    await api.addOrderItem(o.id, { productId: tea.id, qty: 1 });
    await api.printKitchenTicket(await api.sendToKitchen(o.id));
    const c = await api.createCustomer({ name: "Ayesha Khan" });
    await api.printStatement(c.id);
    await api.printTestPage();
    expect(sent).toHaveLength(3);
    for (const bytes of sent) expect(hex(bytes)).toContain(ascii(TILLBASE_FOOTER));
  });

  it("the on-screen receipt text (used when there is no printer) has it too", async () => {
    const sale = await sell();
    for (const width of [32, 48]) {
      await api.updateSettings({ receiptWidth: width });
      expect((await api.receiptText(sale.id)).endsWith(TILLBASE_FOOTER)).toBe(true);
    }
  });
});

describe("the footer cannot be switched off or edited", () => {
  it("there is no setting for it, and an old 'showCredit' value from an older screen changes nothing", async () => {
    expect("showCredit" in (await api.getSettings())).toBe(false);
    await api.updateSettings({ showCredit: false } as never);
    await api.setPrinter({ host: "10.0.0.9" });
    const sale = await sell();
    await api.printReceipt(sale.id);
    expect(hex(sent[0]!)).toContain(ascii(TILLBASE_FOOTER));
  });

  it("the shop's own message is editable and separate; clearing it keeps the Tillbase line", async () => {
    await api.updateSettings({ receiptFooter: "" });
    const sale = await sell();
    expect(await api.receiptText(sale.id)).toMatch(new RegExp(`${TILLBASE_FOOTER}$`));
    await api.updateSettings({ receiptFooter: "Powered by someone else" });
    expect((await api.getSettings()).receiptFooter).toBe("Powered by someone else");
    expect((await api.receiptText(sale.id)).endsWith(TILLBASE_FOOTER)).toBe(true);
  });

  it("a printer that is off never undoes the sale", async () => {
    const down = createHandlers(openDatabase(":memory:"), "T1", () => Date.now(), { printing: { send: async () => { throw new Error("connect ECONNREFUSED"); }, decodeLogo: () => null } });
    await down.setupOwner("Boss", "1111");
    await down.setPrinter({ host: "10.0.0.9" });
    const tea = await down.createProduct({ name: "Tea", priceMinor: 5_000, trackStock: false });
    await down.openShift(0);
    const sale = (await down.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }] })).sale;
    expect((await down.printReceipt(sale.id)).status).not.toBe("printed");
    expect((await down.salesSummary("2000-01-01", "2100-01-01")).salesCount).toBe(1);
  });
});
