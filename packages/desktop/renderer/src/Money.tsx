import { useCallback, useEffect, useMemo, useState } from "react";
import type { Debtor, ReportCentre, ReportKind } from "@tillbase/core";
import { barChart, chartColors, hBarChart, lineChart } from "@tillbase/core/charts";
import { presetRange, type RangePreset } from "@tillbase/core/report-range";
import type { ReportRequest } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { formatDateTime, isoDay } from "./format";
import { Modal } from "./Modal";
import "./reports.css";

const presetLabels: Record<RangePreset, string> = { today: "Today", yesterday: "Yesterday", this_week: "This week", this_month: "This month" };
type Section = "overview" | "profit" | "products" | "stock" | "partners" | "staff";
const sections: { id: Section; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "profit", label: "Profit and loss" },
  { id: "products", label: "Products" },
  { id: "stock", label: "Stock" },
  { id: "partners", label: "Suppliers and customers" },
  { id: "staff", label: "Staff and shifts" },
];
const printable: { kind: ReportKind; label: string }[] = [
  { kind: "daily-sales", label: "Daily sales report" },
  { kind: "monthly-sales", label: "Monthly sales report" },
  { kind: "profit-loss", label: "Profit and loss" },
  { kind: "expenses", label: "Expense report" },
  { kind: "stock", label: "Stock report" },
  { kind: "product-performance", label: "Product performance" },
  { kind: "staff-shifts", label: "Staff and shift report" },
  { kind: "customer-statement", label: "Customer statement" },
  { kind: "supplier-statement", label: "Supplier statement" },
];

/** Charts are made by core/charts as escaped SVG text, the same drawing the A4 prints use. */
function Chart({ svg, caption }: { svg: string; caption?: string }) {
  return (
    <div className="chart-card">
      {caption && <p className="cap">{caption}</p>}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

export function Money() {
  const { money, toast, settings } = useApp();
  const [preset, setPreset] = useState<RangePreset | "custom">("today");
  const [range, setRange] = useState(() => presetRange("today", isoDay()));
  const [section, setSection] = useState<Section>("overview");
  const [data, setData] = useState<ReportCentre | null>(null);
  const [failed, setFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.reportCentre(range.from, range.to));
      setFailed(false);
    } catch (e) {
      setFailed(true);
      toast((e as Error).message, "error");
    }
  }, [range, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const pick = (p: RangePreset) => {
    setPreset(p);
    setRange(presetRange(p, isoDay()));
  };

  const exportForAccountant = async () => {
    setExporting(true);
    try {
      const saved = await api.exportAccounting(range.from, range.to);
      if (saved) toast(`Saved ${saved.names.length} files in ${saved.folder}`, "ok");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setExporting(false);
    }
  };

  const unit = settings.currency;
  const p = data?.pnl;
  const profit = p?.netProfitMinor ?? 0;
  const charts = useMemo(() => {
    if (!data) return null;
    const labels = data.pnl.daily.map((d) => shortDay(d.date));
    return {
      trend: lineChart({ labels, series: [{ name: "Sales", values: data.pnl.daily.map((d) => d.salesMinor), color: chartColors.sales }, { name: "Gross profit", values: data.pnl.daily.map((d) => d.grossProfitMinor), color: chartColors.profit }], title: "Sales and gross profit by day", minor: true, unit }),
      hours: barChart({ labels: data.pnl.hourly.map((h) => `${h.hour}:00`), series: [{ name: "Sales", values: data.pnl.hourly.map((h) => h.salesMinor), color: chartColors.sales }], title: "Sales by hour", minor: true, unit }),
      methods: hBarChart({ rows: [...data.paymentMethods.map((m) => ({ label: m.method, value: m.amountMinor, display: money(m.amountMinor) })), ...(data.onAccountMinor > 0 ? [{ label: "On account (Khata)", value: data.onAccountMinor, display: money(data.onAccountMinor) }] : [])], title: "Sales by payment method" }),
      expenses: hBarChart({ rows: data.pnl.expensesByCategory.map((e) => ({ label: e.name, value: e.totalMinor, display: money(e.totalMinor) })), title: "Expenses by category", color: chartColors.cost }),
      top: hBarChart({ rows: data.topProducts.slice(0, 8).map((t) => ({ label: t.name, value: t.salesMinor, display: money(t.salesMinor) })), title: "Best-selling products" }),
      stock: hBarChart({ rows: [...data.stock.lines].sort((a, b) => b.valueMinor - a.valueMinor).slice(0, 8).map((l) => ({ label: l.name, value: l.valueMinor, display: money(l.valueMinor) })), title: "Stock value by item", color: chartColors.cost }),
      breakdown: hBarChart({ rows: data.pnl.breakdown.map((b) => ({ label: b.label, value: b.amountMinor, display: `${money(b.amountMinor)}${b.pctOfSales === null ? "" : ` · ${b.pctOfSales}%`}` })), title: "Where the sales money went" }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, unit]);

  const num = (n: number) => String(Math.round(n * 1000) / 1000);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Reports</h1>
        <div className="presets">
          {(Object.keys(presetLabels) as RangePreset[]).map((k) => (
            <button key={k} className={`btn${preset === k ? " on" : ""}`} onClick={() => pick(k)}>
              {presetLabels[k]}
            </button>
          ))}
          <input type="date" value={range.from} max={range.to} aria-label="From" onChange={(e) => { setPreset("custom"); setRange({ ...range, from: e.target.value }); }} />
          <input type="date" value={range.to} min={range.from} aria-label="To" onChange={(e) => { setPreset("custom"); setRange({ ...range, to: e.target.value }); }} />
          <button className="btn btn-primary" onClick={() => setPrintOpen(true)}>Print or save a report…</button>
        </div>
      </div>

      <div className="report-tabs" role="tablist" aria-label="Report sections">
        {sections.map((s) => (
          <button key={s.id} role="tab" aria-selected={section === s.id} className={`btn${section === s.id ? " on" : ""}`} onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      {failed && !data && <p className="empty">The report could not be loaded.</p>}
      {data && p && charts && (
        <>
          <p className="muted">
            {data.from === data.to ? data.from : `${data.from} to ${data.to}`} · figures come from your recorded sales, purchases, expenses and stock only.
          </p>
          {data.notes.length > 0 && (
            <div className="warn-box" role="note">
              <strong>Check before you trust these numbers</strong>
              {data.notes.map((w) => <p key={w}>{w}</p>)}
            </div>
          )}

          {section === "overview" && (
            <>
              <div className="stats">
                <div className="panel"><div className="stat-label">Sales (before tax)</div><div className="stat-value">{money(p.netSalesMinor)}</div><span className="muted">{p.salesCount} orders · avg {money(p.averageOrderMinor)}</span></div>
                <div className="panel"><div className="stat-label">Gross profit</div><div className="stat-value">{money(p.grossProfitMinor)}</div><span className="muted">{p.grossMarginPct === null ? "—" : `${p.grossMarginPct}% after cost of goods`}</span></div>
                <div className="panel"><div className="stat-label">{profit >= 0 ? "Net profit" : "Net loss"}</div><div className={`stat-value ${profit >= 0 ? "good" : "bad-text"}`}>{money(Math.abs(profit))}</div><span className="muted">{p.netMarginPct === null ? "No sales yet" : `${p.netMarginPct}% of sales`}</span></div>
                <div className="panel"><div className="stat-label">Cost of goods sold</div><div className="stat-value">{money(p.cogsMinor)}</div><span className="muted">{data.notes.some((n) => n.includes("no cost")) ? "some costs missing, see above" : "from recorded costs"}</span></div>
              </div>
              <div className="report-grid">
                <section className="panel"><h2>Sales and gross profit over time</h2><Chart svg={charts.trend} caption="Per day. Gross profit is sales minus the cost of what was sold." /></section>
                <section className="panel"><h2>Busy hours</h2><Chart svg={charts.hours} caption="Sales before tax in each hour." /></section>
                <section className="panel"><h2>Sales by payment method</h2><Chart svg={charts.methods} caption="Cash is after change. Account (Khata) sales are not money received yet." /></section>
                <section className="panel"><h2>Expenses by category</h2><Chart svg={charts.expenses} /></section>
                <section className="panel"><h2>Best-selling products</h2><Chart svg={charts.top} caption="By sales before tax." /></section>
                <section className="panel"><h2>Stock on shelves</h2><Chart svg={charts.stock} caption={`Value at cost now: ${money(data.stock.valueMinor)}. ${data.stock.low.length} item(s) at or below the reorder level.`} /></section>
              </div>
            </>
          )}

          {section === "profit" && (
            <>
              <section className="panel">
                <h2>How the profit is worked out</h2>
                <table className="table calc-table">
                  <tbody>
                    <tr><td>Sales before tax (after discounts)</td><td className="num">{money(p.netSalesMinor)}</td></tr>
                    <tr><td>less Cost of goods sold</td><td className="num">−{money(p.cogsMinor)}</td></tr>
                    <tr className="total"><td>= Gross profit</td><td className="num">{money(p.grossProfitMinor)}</td></tr>
                    <tr><td>less Wastage and losses</td><td className="num">−{money(p.wastageMinor)}</td></tr>
                    {p.wastageByReason.map((w) => <tr className="sub" key={w.reason}><td>{w.reason}</td><td className="num">{money(w.costMinor)}</td></tr>)}
                    <tr><td>less Running costs</td><td className="num">−{money(p.expensesMinor)}</td></tr>
                    {p.expensesByCategory.map((c) => <tr className="sub" key={c.name}><td>{c.name}</td><td className="num">{money(c.totalMinor)}</td></tr>)}
                    <tr><td>less Wages</td><td className="num">−{money(p.labourMinor)}</td></tr>
                    {p.labourMinor > 0 && <tr className="sub"><td>Paid through payroll</td><td className="num">{money(p.labourActualMinor)}</td></tr>}
                    {p.labourEstimatedMinor > 0 && <tr className="sub"><td className="est">Estimated (payroll not run yet)</td><td className="num est">{money(p.labourEstimatedMinor)}</td></tr>}
                    <tr className="total"><td>= {profit >= 0 ? "Net profit" : "Net loss"}</td><td className="num">{money(p.netProfitMinor)}</td></tr>
                  </tbody>
                </table>
                <p className="muted">Sales tax collected ({money(p.taxCollectedMinor)}) belongs to the government and is not part of these figures. Break-even sales: {p.breakEvenSalesMinor === null ? "—" : money(p.breakEvenSalesMinor)}.</p>
              </section>
              <div className="report-grid">
                <section className="panel"><h2>Where the sales money went</h2><Chart svg={charts.breakdown} /></section>
                <section className="panel">
                  <h2>Export for your accountant</h2>
                  <p className="muted">Spreadsheet files for {range.from} to {range.to}: sales by day with tax, running costs, purchases, payroll, and profit and loss. They open in Excel.</p>
                  <button className="btn btn-primary" disabled={exporting} onClick={() => void exportForAccountant()}>{exporting ? "Saving..." : "Save the files..."}</button>
                </section>
              </div>
            </>
          )}

          {section === "products" && (
            <>
              <section className="panel">
                <h2>Best sellers</h2>
                {data.topProducts.length === 0 ? <p className="empty">No items sold in this period.</p> : (
                  <table className="table"><thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Sales</th><th className="num">Cost</th><th className="num">Profit</th></tr></thead>
                    <tbody>{data.topProducts.map((t) => (
                      <tr key={t.productId}><td>{t.name}{t.costMissing && <span className="badge badge-warn">no cost</span>}</td><td className="num">{num(t.qty)}</td><td className="num">{money(t.salesMinor)}</td><td className="num">{t.costMissing ? "unknown" : money(t.cogsMinor)}</td><td className="num">{money(t.profitMinor)}</td></tr>
                    ))}</tbody></table>
                )}
              </section>
              <section className="panel">
                <h2>Slow movers</h2>
                <p className="muted">The menu items that sold least in this period, including ones that did not sell at all.</p>
                {data.slowProducts.length === 0 ? <p className="empty">No menu items yet.</p> : (
                  <table className="table"><thead><tr><th>Item</th><th className="num">Sold</th><th className="num">In stock</th><th>Last sold</th></tr></thead>
                    <tbody>{data.slowProducts.map((s) => (
                      <tr key={s.productId}><td>{s.name}</td><td className="num">{num(s.qtySold)}</td><td className="num">{num(s.stock)} {s.unit}</td><td>{s.lastSoldAt ? formatDateTime(s.lastSoldAt) : "Never"}</td></tr>
                    ))}</tbody></table>
                )}
              </section>
            </>
          )}

          {section === "stock" && (
            <>
              <div className="stats">
                <div className="panel"><div className="stat-label">Stock value (at cost)</div><div className="stat-value">{money(data.stock.valueMinor)}</div><span className="muted">right now</span></div>
                <div className="panel"><div className="stat-label">Items tracked</div><div className="stat-value">{data.stock.lines.length}</div></div>
                <div className="panel"><div className="stat-label">Running low</div><div className="stat-value">{data.stock.low.length}</div><span className="muted">at or below reorder level</span></div>
              </div>
              <section className="panel">
                <h2>All stock</h2>
                {data.stock.lines.length === 0 ? <p className="empty">No stock is tracked yet.</p> : (
                  <table className="table"><thead><tr><th>Item</th><th className="num">In stock</th><th className="num">Average cost</th><th className="num">Value</th><th>Note</th></tr></thead>
                    <tbody>{data.stock.lines.map((l) => (
                      <tr key={l.productId}><td>{l.name}</td><td className="num">{num(l.stock)} {l.unit}</td><td className="num">{l.costMissing ? "unknown" : money(l.avgCostMinor)}</td><td className="num">{money(l.valueMinor)}</td><td>{l.low ? <span className="badge badge-warn">low</span> : l.costMissing ? <span className="badge badge-warn">no cost</span> : ""}</td></tr>
                    ))}</tbody></table>
                )}
              </section>
            </>
          )}

          {section === "partners" && (
            <div className="report-grid">
              <section className="panel">
                <h2>Suppliers</h2>
                <p className="muted">Bought in this period: {money(data.suppliers.boughtMinor)}, paid {money(data.suppliers.paidMinor)}. Owed now: {money(data.suppliers.owedNowMinor)}.</p>
                {data.suppliers.lines.length === 0 ? <p className="empty">No suppliers yet.</p> : (
                  <table className="table"><thead><tr><th>Supplier</th><th className="num">Purchases</th><th className="num">Bought</th><th className="num">Owed now</th></tr></thead>
                    <tbody>{data.suppliers.lines.map((s) => <tr key={s.supplier}><td>{s.supplier}</td><td className="num">{s.purchases}</td><td className="num">{money(s.boughtMinor)}</td><td className="num">{money(s.owedNowMinor)}</td></tr>)}</tbody></table>
                )}
              </section>
              <section className="panel">
                <h2>Customers and Khata</h2>
                <p className="muted">Owed to you now: {money(data.customers.owedTotalMinor)}. In this period: {money(data.customers.creditSalesMinor)} put on account, {money(data.customers.repaidMinor)} paid back.</p>
                {data.customers.owing.length === 0 ? <p className="empty">Nobody owes you anything.</p> : (
                  <table className="table"><thead><tr><th>Customer</th><th className="num">Owes</th></tr></thead>
                    <tbody>{data.customers.owing.map((d: Debtor) => <tr key={d.id}><td>{d.name}</td><td className="num">{money(d.owedMinor)}</td></tr>)}</tbody></table>
                )}
              </section>
            </div>
          )}

          {section === "staff" && (
            <>
              <section className="panel">
                <h2>Sales by person</h2>
                {data.staff.length === 0 ? <p className="empty">No sales in this period.</p> : (
                  <table className="table"><thead><tr><th>Name</th><th className="num">Sales</th><th className="num">Total</th><th className="num">Average</th><th className="num">Voided</th></tr></thead>
                    <tbody>{data.staff.map((s) => <tr key={s.userId}><td>{s.name}</td><td className="num">{s.salesCount}</td><td className="num">{money(s.salesMinor)}</td><td className="num">{money(s.averageSaleMinor)}</td><td className="num">{s.voidCount}</td></tr>)}</tbody></table>
                )}
              </section>
              <section className="panel">
                <h2>Shifts</h2>
                {data.shifts.length === 0 ? <p className="empty">No shifts in this period.</p> : (
                  <table className="table"><thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th className="num">Sales</th><th className="num">Total</th><th className="num">Cash difference</th></tr></thead>
                    <tbody>{data.shifts.map((s) => (
                      <tr key={s.shiftId}><td>{s.cashier}</td><td>{formatDateTime(s.openedAt)}</td><td>{s.closedAt ? formatDateTime(s.closedAt) : "Still open"}</td><td className="num">{s.salesCount}</td><td className="num">{money(s.salesMinor)}</td><td className={`num ${(s.varianceMinor ?? 0) < 0 ? "bad-text" : ""}`}>{s.varianceMinor === null ? "—" : money(s.varianceMinor)}</td></tr>
                    ))}</tbody></table>
                )}
              </section>
            </>
          )}
        </>
      )}

      {printOpen && <PrintDialog range={range} onClose={() => setPrintOpen(false)} />}
    </div>
  );
}

/** Choose a report, see it as it will print on A4, then print it (through the computer's PDF viewer) or save the PDF. */
function PrintDialog({ range, onClose }: { range: { from: string; to: string }; onClose: () => void }) {
  const { toast } = useApp();
  const [kind, setKind] = useState<ReportKind>("daily-sales");
  const [customers, setCustomers] = useState<Debtor[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [supplier, setSupplier] = useState("");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.owingCustomers().then(setCustomers).catch(() => undefined);
    api.supplierNames().then(setSuppliers).catch(() => undefined);
  }, []);

  const request: ReportRequest = { kind, from: range.from, to: range.to, customerId: customerId || undefined, supplier: supplier || undefined };
  const ready = kind === "customer-statement" ? !!customerId : kind === "supplier-statement" ? !!supplier : true;

  useEffect(() => {
    if (!ready) { setHtml(""); return; }
    let live = true;
    api.reportHtml({ kind, from: range.from, to: range.to, customerId: customerId || undefined, supplier: supplier || undefined })
      .then((h) => live && setHtml(h))
      .catch((e: Error) => { if (live) { setHtml(""); toast(e.message, "error"); } });
    return () => { live = false; };
  }, [kind, range.from, range.to, customerId, supplier, ready, toast]);

  const act = async (what: "print" | "save") => {
    setBusy(true);
    try {
      if (what === "print") {
        const name = await api.printReport(request);
        toast(`${name} is open in your PDF viewer. Print it from there.`, "ok");
      } else {
        const where = await api.saveReportPdf(request);
        if (where) toast(`Saved ${where}`, "ok");
      }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Print or save a report" onClose={onClose} wide>
      <div className="print-bar">
        <label>
          Report{" "}
          <select value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
            {printable.map((r) => <option key={r.kind} value={r.kind}>{r.label}</option>)}
          </select>
        </label>
        {kind === "customer-statement" && (
          <label>Customer{" "}
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Choose…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        {kind === "supplier-statement" && (
          <label>Supplier{" "}
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">Choose…</option>
              {suppliers.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
        <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void act("print")}>Print…</button>
        <button className="btn" disabled={busy || !ready} onClick={() => void act("save")}>Save as PDF…</button>
      </div>
      <p className="muted">
        {kind === "daily-sales" ? `For ${range.to}.` : kind === "monthly-sales" ? `For the whole month of ${range.to}.` : kind === "stock" ? "Stock as it is now." : `For ${range.from} to ${range.to}.`}{" "}
        Printing opens the A4 PDF in your computer's PDF viewer. Customer statements list customers who owe money.
      </p>
      {html ? <iframe className="preview-frame" title="Report preview" sandbox="" srcDoc={html} /> : <p className="empty">{ready ? "Loading…" : "Choose who the statement is for."}</p>}
    </Modal>
  );
}
