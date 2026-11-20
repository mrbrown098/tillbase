import { useCallback, useEffect, useState } from "react";
import type { ProfitAndLoss } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { periodLabels, periods } from "./format";

const colors: Record<string, string> = {
  cogs: "#f59e0b",
  wastage: "#ef4444",
  labour: "#8b5cf6",
  expenses: "#0ea5e9",
  profit: "#16a34a",
};

export function Money() {
  const { money, toast } = useApp();
  const [preset, setPreset] = useState<keyof typeof periods | "custom">("today");
  const [range, setRange] = useState(periods.today());
  const [pl, setPl] = useState<ProfitAndLoss | null>(null);

  const load = useCallback(async () => {
    try {
      setPl(await api.profitAndLoss(range.from, range.to));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [range, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = (p: keyof typeof periods) => {
    setPreset(p);
    setRange(periods[p]());
  };

  const profit = pl?.netProfitMinor ?? 0;
  const maxDay = Math.max(1, ...(pl?.daily.map((d) => d.salesMinor) ?? [1]));
  const maxHour = Math.max(1, ...(pl?.hourly.map((h) => h.salesMinor) ?? [1]));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Money: are we making a profit?</h1>
        <div className="presets">
          {(Object.keys(periods) as (keyof typeof periods)[]).map((p) => (
            <button key={p} className={`btn${preset === p ? " on" : ""}`} onClick={() => pick(p)}>
              {periodLabels[p]}
            </button>
          ))}
          <input type="date" value={range.from} max={range.to} aria-label="From" onChange={(e) => { setPreset("custom"); setRange({ ...range, from: e.target.value }); }} />
          <input type="date" value={range.to} min={range.from} aria-label="To" onChange={(e) => { setPreset("custom"); setRange({ ...range, to: e.target.value }); }} />
        </div>
      </div>

      {!pl ? null : (
        <>
          <div className="stats">
            <div className="panel">
              <div className="stat-label">Sales (before tax)</div>
              <div className="stat-value">{money(pl.netSalesMinor)}</div>
              <span className="muted">{pl.salesCount} orders · avg {money(pl.averageOrderMinor)}</span>
            </div>
            <div className="panel">
              <div className="stat-label">{profit >= 0 ? "Profit" : "Loss"}</div>
              <div className={`stat-value ${profit >= 0 ? "good" : "bad-text"}`}>{money(Math.abs(profit))}</div>
              <span className="muted">{pl.netMarginPct === null ? "No sales yet" : `${pl.netMarginPct}% of sales`}</span>
            </div>
            <div className="panel">
              <div className="stat-label">Gross profit</div>
              <div className="stat-value">{money(pl.grossProfitMinor)}</div>
              <span className="muted">{pl.grossMarginPct === null ? "—" : `${pl.grossMarginPct}% after ingredients`}</span>
            </div>
            <div className="panel">
              <div className="stat-label">Break-even sales</div>
              <div className="stat-value">{pl.breakEvenSalesMinor === null ? "—" : money(pl.breakEvenSalesMinor)}</div>
              <span className="muted">needed to cover every cost</span>
            </div>
          </div>

          {pl.warnings.length > 0 && (
            <div className="warn-box" role="note">
              <strong>Check before you trust these numbers</strong>
              {pl.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}

          <div className="cols">
            <section className="panel">
              <h2>Where your sales money went</h2>
              {pl.netSalesMinor === 0 ? (
                <p className="empty">No sales in this period.</p>
              ) : (
                <>
                  <div className="bar" role="img" aria-label="Share of sales by cost">
                    {pl.breakdown
                      .filter((b) => b.amountMinor > 0)
                      .map((b) => (
                        <span key={b.key} style={{ width: `${Math.min(100, ((b.pctOfSales ?? 0) < 0 ? 0 : b.pctOfSales ?? 0))}%`, background: colors[b.key] }} title={b.label} />
                      ))}
                  </div>
                  <ul className="legend">
                    {pl.breakdown.map((b) => (
                      <li key={b.key}>
                        <span><i style={{ background: colors[b.key] }} />{b.label}</span>
                        <span>
                          {money(b.amountMinor)} {b.pctOfSales !== null && <span className="muted">· {b.pctOfSales}%</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="panel">
              <h2>Running costs</h2>
              {pl.expensesByCategory.length === 0 && <p className="empty">Nothing recorded.</p>}
              <ul className="legend">
                {pl.expensesByCategory.map((c) => (
                  <li key={c.name}><span>{c.name}</span><span>{money(c.totalMinor)}</span></li>
                ))}
              </ul>
              {pl.wastageByReason.length > 0 && (
                <>
                  <h2>Wastage and losses</h2>
                  <ul className="legend">
                    {pl.wastageByReason.map((w) => (
                      <li key={w.reason}><span>{w.reason}</span><span>{money(w.costMinor)}</span></li>
                    ))}
                  </ul>
                </>
              )}
              <h2>Wages</h2>
              <ul className="legend">
                <li><span>Paid through payroll</span><span>{money(pl.labourActualMinor)}</span></li>
                <li><span>Estimated (payroll not run yet)</span><span>{money(pl.labourEstimatedMinor)}</span></li>
              </ul>
            </section>
          </div>

          <section className="panel">
            <h2>What sells, and what it earns</h2>
            <table className="table">
              <thead>
                <tr><th>Item</th><th className="num">Sold</th><th className="num">Sales</th><th className="num">Profit</th><th className="num">Margin</th></tr>
              </thead>
              <tbody>
                {pl.items.map((i) => (
                  <tr key={i.productId}>
                    <td>{i.name}{i.costMissing && <span className="badge badge-warn">no cost</span>}</td>
                    <td className="num">{i.qty}</td>
                    <td className="num">{money(i.salesMinor)}</td>
                    <td className={`num ${i.profitMinor < 0 ? "bad-text" : ""}`}>{money(i.profitMinor)}</td>
                    <td className="num">{i.marginPct === null ? "—" : `${i.marginPct}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pl.items.length === 0 && <p className="empty">No items sold in this period.</p>}
          </section>

          <div className="cols">
            {pl.daily.length > 1 && (
              <section className="panel">
                <h2>Sales by day</h2>
                <div className="chart" role="img" aria-label="Sales by day">
                  {pl.daily.map((d) => (
                    <div key={d.date} style={{ height: `${(d.salesMinor / maxDay) * 100}%` }} title={`${d.date}: ${money(d.salesMinor)}`} />
                  ))}
                </div>
                <div className="chart-labels"><span>{pl.from}</span><span>{pl.to}</span></div>
              </section>
            )}
            {pl.hourly.length > 0 && (
              <section className="panel">
                <h2>Busy hours</h2>
                <div className="chart" role="img" aria-label="Sales by hour">
                  {pl.hourly.map((h) => (
                    <div key={h.hour} style={{ height: `${(h.salesMinor / maxHour) * 100}%` }} title={`${h.hour}:00 · ${h.orders} orders · ${money(h.salesMinor)}`} />
                  ))}
                </div>
                <div className="chart-labels"><span>{pl.hourly[0]!.hour}:00</span><span>{pl.hourly[pl.hourly.length - 1]!.hour}:00</span></div>
              </section>
            )}
            <section className="panel">
              <h2>Where the business stands now</h2>
              <ul className="legend">
                <li><span>Stock on shelves (at cost)</span><span>{money(pl.position.stockValueMinor)}</span></li>
                <li><span>Owed to suppliers</span><span>{money(pl.position.owedToSuppliersMinor)}</span></li>
                <li><span>Advances staff still owe</span><span>{money(pl.position.advancesOutstandingMinor)}</span></li>
                <li><span>Sales tax collected (not your income)</span><span>{money(pl.taxCollectedMinor)}</span></li>
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
