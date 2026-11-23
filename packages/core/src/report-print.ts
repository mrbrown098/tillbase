import { TILLBASE_FOOTER } from "./branding.js";
import { barChart, chartColors, esc, hBarChart, lineChart } from "./charts.js";
import type { Statement } from "./customers.js";
import { formatMoney } from "./money.js";
import type { SupplierStatement } from "./purchase-orders.js";
import type { ReportCentre } from "./report-centre.js";

export type ReportKind =
  | "daily-sales"
  | "monthly-sales"
  | "profit-loss"
  | "expenses"
  | "stock"
  | "product-performance"
  | "staff-shifts"
  | "customer-statement"
  | "supplier-statement";

export const reportTitles: Record<ReportKind, string> = {
  "daily-sales": "Daily sales report",
  "monthly-sales": "Monthly sales report",
  "profit-loss": "Profit and loss",
  expenses: "Expense report",
  stock: "Stock report",
  "product-performance": "Product performance",
  "staff-shifts": "Staff and shift report",
  "customer-statement": "Customer statement",
  "supplier-statement": "Supplier statement",
};

export interface ReportShop {
  name: string;
  /** The shop's logo as a data: URL, or "". */
  logo: string;
  currency: string;
  locale: string;
  /** The business time zone for printed times; empty means this machine's. */
  timeZone?: string;
}

export interface ReportDocInput {
  kind: ReportKind;
  shop: ReportShop;
  /** Required for every kind except the two statements. */
  centre?: ReportCentre;
  customerStatement?: Statement;
  supplierStatement?: SupplierStatement;
  /** ISO time shown as "Generated". */
  generatedAt: string;
}

/** The footer for a PDF made with Electron's printToPDF: it is drawn on every page together with the page number. */
export const PDF_FOOTER_TEMPLATE = `<div style="width:100%;font-size:7px;color:#555;text-align:center;font-family:Arial,sans-serif"><span>${TILLBASE_FOOTER}</span> &nbsp;·&nbsp; Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;

const CSS = `
@page { size: A4; margin: 16mm 14mm 18mm 14mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 10pt/1.4 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #111827; margin: 0; }
.head { display: flex; align-items: center; gap: 12px; border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 10px; }
.head img { max-height: 16mm; max-width: 40mm; object-fit: contain; }
.head .shop { font-size: 13pt; font-weight: 700; }
.head .meta { margin-left: auto; text-align: right; color: #4b5563; font-size: 8.5pt; }
h1 { font-size: 17pt; margin: 4px 0 2px; }
.range { color: #374151; margin: 0 0 10px; }
h2 { font-size: 11.5pt; margin: 16px 0 6px; break-after: avoid; page-break-after: avoid; border-bottom: 1px solid #d1d5db; padding-bottom: 2px; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
th, td { padding: 3px 6px; text-align: left; vertical-align: top; border-bottom: 1px solid #e5e7eb; font-size: 9pt; overflow-wrap: anywhere; }
th { background: #f3f4f6; font-weight: 600; border-bottom: 1px solid #9ca3af; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
.num { text-align: right; white-space: nowrap; }
tr.total td { font-weight: 700; border-top: 1.5px solid #111827; border-bottom: none; }
tr.sub td { color: #4b5563; padding-left: 18px; }
.neg { color: #b91c1c; }
.kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 6px 0 4px; }
.kv div { border: 1px solid #d1d5db; border-radius: 4px; padding: 5px 8px; break-inside: avoid; }
.kv b { display: block; font-size: 13pt; }
.kv span { color: #4b5563; font-size: 8pt; }
.chart { break-inside: avoid; page-break-inside: avoid; margin: 4px 0 8px; }
.chart svg { width: 100%; height: auto; display: block; }
.chart .cap { font-size: 8.5pt; color: #4b5563; margin-bottom: 2px; }
.note { border: 1px solid #b45309; background: #fffbeb; border-radius: 4px; padding: 5px 9px; margin: 8px 0; font-size: 8.5pt; break-inside: avoid; }
.note p { margin: 2px 0; }
.empty { color: #6b7280; font-style: italic; margin: 4px 0 8px; }
table.page, table.page > tbody, table.page > tfoot, table.page > tbody > tr, table.page > tfoot > tr { width: 100%; margin: 0; border: 0; break-inside: auto; page-break-inside: auto; }
table.page > tbody > tr > td, table.page > tfoot > tr > td { padding: 0; border: 0; font-size: inherit; }
table.page > tfoot { display: table-footer-group; }
.tb-footer { text-align: center; font-size: 7.5pt; color: #555; padding-top: 6px; }
@media screen { body { padding: 10mm; background: #fff; } }
`;

const num = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** A complete HTML page for one report, laid out for A4. Charts are inline SVG so they print as drawn. */
export function buildReportHtml(input: ReportDocInput, opts: { forPdf?: boolean } = {}): string {
  const { shop } = input;
  const money = (m: number) => formatMoney(m, shop.currency, shop.locale);
  const day = (d: string) => {
    const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString(shop.locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  };
  const stamp = (iso: string) => new Date(iso).toLocaleString(shop.locale, { dateStyle: "medium", timeStyle: "short", timeZone: shop.timeZone || undefined });
  /** A business date (YYYY-MM-DD) as "10 Nov", the same in every time zone. */
  const dayOf = (d: string) => {
    const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString(shop.locale, { day: "numeric", month: "short", timeZone: "UTC" });
  };
  const pctText = (p: number | null) => (p === null ? "—" : `${p}%`);

  const td = (v: string, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${v}</td>`;
  const table = (heads: { t: string; num?: boolean }[], rows: string[][], total?: string[]) =>
    `<table><thead><tr>${heads.map((h) => `<th${h.num ? ' class="num"' : ""}>${esc(h.t)}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c, i) => td(c, heads[i]?.num ? "num" : "")).join("")}</tr>`)
      .join("")}${total ? `<tr class="total">${total.map((c, i) => td(c, heads[i]?.num ? "num" : "")).join("")}</tr>` : ""}</tbody></table>`;
  const kv = (items: [string, string][]) => `<div class="kv">${items.map(([l, v]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>`;
  const section = (title: string, body: string) => `<h2>${esc(title)}</h2>${body}`;
  const chart = (cap: string, svg: string) => `<div class="chart"><div class="cap">${esc(cap)}</div>${svg}</div>`;
  const empty = (text: string) => `<p class="empty">${esc(text)}</p>`;
  const notes = (list: string[]) => (list.length ? `<div class="note"><strong>Read this before relying on these figures</strong>${list.map((n) => `<p>${esc(n)}</p>`).join("")}</div>` : "");

  const c = input.centre;
  const need = (): ReportCentre => {
    if (!c) throw new Error("This report needs the report figures");
    return c;
  };
  let range = "";
  let body = "";

  const salesSummary = (r: ReportCentre) =>
    kv([
      ["Sales before tax", money(r.pnl.netSalesMinor)],
      ["Orders", String(r.pnl.salesCount)],
      ["Average order", money(r.pnl.averageOrderMinor)],
      ["Discounts given", money(r.pnl.discountsMinor)],
      ["Tax collected (not income)", money(r.pnl.taxCollectedMinor)],
      ["Voided sales", String(r.pnl.voidCount)],
    ]);
  const methods = (r: ReportCentre) => {
    const rows = r.paymentMethods.map((m) => ({ label: m.method, value: m.amountMinor, display: money(m.amountMinor) }));
    if (r.onAccountMinor > 0) rows.push({ label: "On account (Khata)", value: r.onAccountMinor, display: money(r.onAccountMinor) });
    if (rows.length === 0) return empty("No payments in this period.");
    return (
      chart("Sales by payment method (cash is after change given; account sales are not money received yet)", hBarChart({ rows, title: "Sales by payment method" })) +
      table([{ t: "Method" }, { t: "Amount", num: true }], rows.map((m) => [esc(m.label), esc(m.display)]))
    );
  };
  const topItems = (r: ReportCentre, withProfit: boolean) =>
    r.topProducts.length === 0
      ? empty("No items sold in this period.")
      : table(
          withProfit ? [{ t: "Item" }, { t: "Sold", num: true }, { t: "Sales", num: true }, { t: "Cost", num: true }, { t: "Profit", num: true }] : [{ t: "Item" }, { t: "Sold", num: true }, { t: "Sales", num: true }],
          r.topProducts.map((p) => {
            const name = esc(p.name) + (p.costMissing ? " (no cost set)" : "");
            return withProfit ? [name, esc(num(p.qty)), esc(money(p.salesMinor)), esc(p.costMissing ? "unknown" : money(p.cogsMinor)), esc(money(p.profitMinor))] : [name, esc(num(p.qty)), esc(money(p.salesMinor))];
          }),
        );
  const dailyTable = (r: ReportCentre) =>
    table(
      [{ t: "Date" }, { t: "Orders", num: true }, { t: "Sales", num: true }, { t: "Cost of goods", num: true }, { t: "Gross profit", num: true }],
      r.pnl.daily.map((d) => [esc(day(d.date)), String(d.orders), esc(money(d.salesMinor)), esc(money(d.cogsMinor)), esc(money(d.grossProfitMinor))]),
      ["Total", String(r.pnl.salesCount), esc(money(r.pnl.netSalesMinor)), esc(money(r.pnl.cogsMinor)), esc(money(r.pnl.grossProfitMinor))],
    );

  switch (input.kind) {
    case "daily-sales": {
      const r = need();
      range = day(r.from);
      body =
        salesSummary(r) +
        section("Payments", methods(r)) +
        section("Sales by hour", r.pnl.hourly.length ? chart("Sales before tax in each hour of the day", barChart({ labels: r.pnl.hourly.map((h) => `${h.hour}:00`), series: [{ name: "Sales", values: r.pnl.hourly.map((h) => h.salesMinor), color: chartColors.sales }], title: "Sales by hour", minor: true, unit: shop.currency })) : empty("No sales today.")) +
        section("Items sold", topItems(r, false)) +
        section("Shifts", shiftTable(r)) +
        notes(r.notes.filter((n) => !n.startsWith("Profit over time") && !n.startsWith("Stock value, supplier")));
      break;
    }
    case "monthly-sales": {
      const r = need();
      range = `${day(r.from)} to ${day(r.to)}`;
      body =
        salesSummary(r) +
        section("Sales and gross profit by day", chart("Sales and gross profit (sales minus cost of goods) for each day", lineChart({ labels: r.pnl.daily.map((d) => dayOf(d.date)), series: [{ name: "Sales", values: r.pnl.daily.map((d) => d.salesMinor), color: chartColors.sales }, { name: "Gross profit", values: r.pnl.daily.map((d) => d.grossProfitMinor), color: chartColors.profit }], title: "Sales and gross profit by day", minor: true, unit: shop.currency })) + dailyTable(r)) +
        section("Payments", methods(r)) +
        section("Best sellers", topItems(r, false)) +
        notes(r.notes.filter((n) => !n.startsWith("Stock value, supplier")));
      break;
    }
    case "profit-loss": {
      const r = need();
      const p = r.pnl;
      range = `${day(r.from)} to ${day(r.to)}`;
      const sub = (label: string, amount: number, note = "") => `<tr class="sub">${td(esc(label) + (note ? ` <em>(${esc(note)})</em>` : ""))}${td(esc(money(amount)), "num")}</tr>`;
      const line = (label: string, amount: number, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}>${td(esc(label))}${td(esc(money(amount)), "num" + (amount < 0 ? " neg" : ""))}</tr>`;
      body =
        kv([["Sales before tax", money(p.netSalesMinor)], ["Gross profit", money(p.grossProfitMinor)], [p.netProfitMinor >= 0 ? "Net profit" : "Net loss", money(p.netProfitMinor)], ["Gross margin", pctText(p.grossMarginPct)], ["Net margin", pctText(p.netMarginPct)], ["Break-even sales", p.breakEvenSalesMinor === null ? "—" : money(p.breakEvenSalesMinor)]]) +
        section(
          "How the profit is worked out",
          `<table><thead><tr><th>Line</th><th class="num">Amount</th></tr></thead><tbody>` +
            line("Sales before tax (after discounts)", p.netSalesMinor) +
            line("less Cost of goods sold (ingredients and stock used)", -p.cogsMinor) +
            line("= Gross profit", p.grossProfitMinor, "total") +
            line("less Wastage and losses", -p.wastageMinor) +
            p.wastageByReason.map((w) => sub(w.reason, w.costMinor)).join("") +
            line("less Running costs", -p.expensesMinor) +
            p.expensesByCategory.map((e) => sub(e.name, e.totalMinor)).join("") +
            line("less Wages", -p.labourMinor) +
            (p.labourMinor > 0 ? sub("Paid through payroll", p.labourActualMinor) + sub("Estimated, payroll not run yet", p.labourEstimatedMinor, "estimate") : "") +
            line(p.netProfitMinor >= 0 ? "= Net profit" : "= Net loss", p.netProfitMinor, "total") +
            `</tbody></table><p class="range">Sales tax collected (${esc(money(p.taxCollectedMinor))}) belongs to the government and is not part of these figures.</p>`,
        ) +
        section("Where each part of the sales money went", chart("Cost of goods, wastage, wages, running costs and profit, as amounts", hBarChart({ rows: p.breakdown.map((b) => ({ label: b.label, value: b.amountMinor, display: `${money(b.amountMinor)}${b.pctOfSales === null ? "" : ` · ${b.pctOfSales}%`}` })), title: "Where the sales money went" }))) +
        section("Sales and gross profit by day", chart("Gross profit does not include running costs or wages", lineChart({ labels: p.daily.map((d) => dayOf(d.date)), series: [{ name: "Sales", values: p.daily.map((d) => d.salesMinor), color: chartColors.sales }, { name: "Gross profit", values: p.daily.map((d) => d.grossProfitMinor), color: chartColors.profit }], title: "Sales and gross profit by day", minor: true, unit: shop.currency }))) +
        notes(r.notes.filter((n) => !n.startsWith("Stock value, supplier")));
      break;
    }
    case "expenses": {
      const r = need();
      const p = r.pnl;
      range = `${day(r.from)} to ${day(r.to)}`;
      body =
        kv([["Running costs", money(p.expensesMinor)], ["Share of sales", pctText(p.netSalesMinor > 0 ? Math.round((p.expensesMinor / p.netSalesMinor) * 1000) / 10 : null)], ["Entries", String(r.expenseLines.length)]]) +
        section("By category", p.expensesByCategory.length === 0 ? empty("No running costs recorded in this period.") : chart("Running costs by category", hBarChart({ rows: p.expensesByCategory.map((e) => ({ label: e.name, value: e.totalMinor, display: money(e.totalMinor) })), title: "Expenses by category", color: chartColors.cost })) + table([{ t: "Category" }, { t: "Total", num: true }, { t: "Share", num: true }], p.expensesByCategory.map((e) => [esc(e.name), esc(money(e.totalMinor)), esc(pctText(Math.round((e.totalMinor / p.expensesMinor) * 1000) / 10))]), ["Total", esc(money(p.expensesMinor)), "100%"])) +
        section("Every entry", r.expenseLines.length === 0 ? empty("Nothing recorded.") : table([{ t: "Date" }, { t: "Category" }, { t: "What" }, { t: "Amount", num: true }], r.expenseLines.map((e) => [esc(day(e.date)), esc(e.category), esc(e.description), esc(money(e.amountMinor))]))) +
        (p.wastageMinor > 0 ? section("Wastage and losses (stock written off)", table([{ t: "Reason" }, { t: "Cost", num: true }], p.wastageByReason.map((w) => [esc(w.reason), esc(money(w.costMinor))]), ["Total", esc(money(p.wastageMinor))])) : "") +
        section("Wages", table([{ t: "" }, { t: "Amount", num: true }], [["Paid through payroll", esc(money(p.labourActualMinor))], ["Estimated (payroll not run yet)", esc(money(p.labourEstimatedMinor))]], ["Total wages", esc(money(p.labourMinor))])) +
        notes(r.notes.filter((n) => /running costs|wages|estimate/i.test(n)));
      break;
    }
    case "stock": {
      const r = need();
      range = `As of ${stamp(r.generatedAt)}`;
      const byValue = [...r.stock.lines].sort((a, b) => b.valueMinor - a.valueMinor).slice(0, 10);
      body =
        kv([["Stock value (at cost)", money(r.stock.valueMinor)], ["Items tracked", String(r.stock.lines.length)], ["At or below reorder level", String(r.stock.low.length)]]) +
        section("Most money tied up in stock", byValue.length ? chart("Top 10 items by value at cost", hBarChart({ rows: byValue.map((l) => ({ label: l.name, value: l.valueMinor, display: money(l.valueMinor) })), title: "Stock value by item", color: chartColors.cost })) : empty("No stock is tracked yet.")) +
        section("Running low", r.stock.low.length === 0 ? empty("Nothing is at or below its reorder level.") : table([{ t: "Item" }, { t: "In stock", num: true }, { t: "Reorder at", num: true }], r.stock.low.map((l) => [esc(l.name), esc(`${num(l.stock)} ${l.unit}`), esc(num(l.reorderLevel))]))) +
        section("All stock", r.stock.lines.length === 0 ? empty("No stock is tracked yet.") : table([{ t: "Item" }, { t: "In stock", num: true }, { t: "Average cost", num: true }, { t: "Value", num: true }, { t: "Note" }], r.stock.lines.map((l) => [esc(l.name), esc(`${num(l.stock)} ${l.unit}`), esc(l.costMissing ? "unknown" : money(l.avgCostMinor)), esc(money(l.valueMinor)), esc(l.low ? "Low" : l.costMissing ? "No cost" : "")]), ["Total", "", "", esc(money(r.stock.valueMinor)), ""])) +
        notes(r.notes.filter((n) => /stock|cost/i.test(n) && !n.startsWith("Profit over time")));
      break;
    }
    case "product-performance": {
      const r = need();
      range = `${day(r.from)} to ${day(r.to)}`;
      const margin = (p: { salesMinor: number; profitMinor: number }) => (p.salesMinor > 0 ? `${Math.round((p.profitMinor / p.salesMinor) * 1000) / 10}%` : "—");
      body =
        section("Best sellers by sales", r.topProducts.length === 0 ? empty("No items sold in this period.") : chart("Sales before tax", hBarChart({ rows: r.topProducts.map((p) => ({ label: p.name, value: p.salesMinor, display: money(p.salesMinor) })), title: "Best-selling products" })) + table([{ t: "Item" }, { t: "Sold", num: true }, { t: "Sales", num: true }, { t: "Cost", num: true }, { t: "Profit", num: true }, { t: "Margin", num: true }], r.topProducts.map((p) => [esc(p.name) + (p.costMissing ? " (no cost set)" : ""), esc(num(p.qty)), esc(money(p.salesMinor)), esc(p.costMissing ? "unknown" : money(p.cogsMinor)), esc(money(p.profitMinor)), esc(p.costMissing ? "—" : margin(p))]))) +
        section("Slow movers (fewest sold in this period)", r.slowProducts.length === 0 ? empty("No menu items yet.") : table([{ t: "Item" }, { t: "Sold", num: true }, { t: "In stock", num: true }, { t: "Last sold" }], r.slowProducts.map((p) => [esc(p.name), esc(num(p.qtySold)), esc(num(p.stock)), esc(p.lastSoldAt ? stamp(p.lastSoldAt) : "Never")]))) +
        notes(r.notes.filter((n) => /no cost set|overstated/i.test(n)));
      break;
    }
    case "staff-shifts": {
      const r = need();
      range = `${day(r.from)} to ${day(r.to)}`;
      body =
        section("Sales by person", r.staff.length === 0 ? empty("No sales in this period.") : table([{ t: "Name" }, { t: "Sales", num: true }, { t: "Total", num: true }, { t: "Average", num: true }, { t: "Voided", num: true }], r.staff.map((s) => [esc(s.name), String(s.salesCount), esc(money(s.salesMinor)), esc(money(s.averageSaleMinor)), String(s.voidCount)]))) +
        section("Shifts", shiftTable(r));
      break;
    }
    case "customer-statement": {
      const st = input.customerStatement;
      if (!st) throw new Error("This report needs a customer statement");
      range = `${st.customer.name}${st.customer.phone ? ` · ${st.customer.phone}` : ""}`;
      const label = (k: string, method: string | null, receipt: string | null) => (k === "sale" ? `Sale ${receipt ?? ""}` : k === "repayment" ? `Paid back${method ? ` (${method})` : ""}` : k === "writeoff" ? "Written off" : `Sale voided ${receipt ?? ""}`).trim();
      body =
        kv([["Owes now", money(st.owedMinor)], ["Credit limit", st.customer.creditLimitMinor === null ? "None" : money(st.customer.creditLimitMinor)], ["Entries", String(st.rows.length)]]) +
        section("Account", st.rows.length === 0 ? empty("Nothing on account yet.") : table([{ t: "Date" }, { t: "What" }, { t: "Amount", num: true }, { t: "Owed after", num: true }], st.rows.map((r) => [esc(stamp(r.at)), esc(label(r.kind, r.method, r.receiptNo) + (r.note ? ` · ${r.note}` : "")), esc((r.deltaMinor > 0 ? "+" : "-") + money(Math.abs(r.deltaMinor))), esc(money(r.balanceMinor))]), ["Owes now", "", "", esc(money(st.owedMinor))]));
      break;
    }
    case "supplier-statement": {
      const st = input.supplierStatement;
      if (!st) throw new Error("This report needs a supplier statement");
      range = `${st.supplier}${st.from || st.to ? ` · ${st.from ? day(st.from) : "start"} to ${st.to ? day(st.to) : "today"}` : ""}`;
      body =
        kv([["Owed at the start", money(st.openingBalanceMinor)], ["Bought", money(st.totalPurchasedMinor)], ["Paid", money(st.totalPaidMinor)], ["Owed at the end", money(st.closingBalanceMinor)], ["On order, not delivered", money(st.onOrderTotalMinor)]]) +
        section("Account", table([{ t: "Date" }, { t: "What" }, { t: "Bought", num: true }, { t: "Paid", num: true }, { t: "Owed after", num: true }], [["", "Owed at the start", "", "", esc(money(st.openingBalanceMinor))], ...st.entries.map((e) => [esc(stamp(e.at)), esc(e.description), e.debitMinor ? esc(money(e.debitMinor)) : "", e.creditMinor ? esc(money(e.creditMinor)) : "", esc(money(e.balanceMinor))])], ["Owed at the end", "", esc(money(st.totalPurchasedMinor)), esc(money(st.totalPaidMinor)), esc(money(st.closingBalanceMinor))])) +
        (st.onOrder.length ? section("Ordered, not delivered yet (not owed)", table([{ t: "Order" }, { t: "Placed" }, { t: "Still to come", num: true }], st.onOrder.map((o) => [esc(o.code), esc(stamp(o.createdAt)), esc(money(o.remainingMinor))]))) : "");
      break;
    }
  }

  function shiftTable(r: ReportCentre): string {
    if (r.shifts.length === 0) return empty("No shifts in this period.");
    return table(
      [{ t: "Cashier" }, { t: "Opened" }, { t: "Closed" }, { t: "Sales", num: true }, { t: "Total", num: true }, { t: "Cash difference", num: true }],
      r.shifts.map((s) => [esc(s.cashier), esc(stamp(s.openedAt)), esc(s.closedAt ? stamp(s.closedAt) : "Still open"), String(s.salesCount), esc(money(s.salesMinor)), s.varianceMinor === null ? "—" : `<span class="${s.varianceMinor < 0 ? "neg" : ""}">${esc(money(s.varianceMinor))}</span>`]),
    );
  }

  const logo = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(shop.logo) ? `<img src="${shop.logo}" alt="">` : "";
  const title = reportTitles[input.kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - ${esc(shop.name)}</title><style>${CSS}</style></head><body>
<table class="page"><tbody><tr><td>
<div class="head">${logo}<div class="shop">${esc(shop.name)}</div><div class="meta">Generated ${esc(stamp(input.generatedAt))}</div></div>
<h1>${esc(title)}</h1><p class="range">${esc(range)}</p>
${body}
</td></tr></tbody>${opts.forPdf ? "" : `<tfoot><tr><td><div class="tb-footer">${TILLBASE_FOOTER}</div></td></tr></tfoot>`}</table>
</body></html>`;
}
