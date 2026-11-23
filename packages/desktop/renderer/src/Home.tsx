import { useEffect, useState } from "react";
import { homeShortcuts, isModuleShown, productsLabelFor } from "@tillbase/core/business";
import type { LowStockItem, Payables, ProfitAndLoss, Sale, SalesSummary } from "@tillbase/core";
import { api } from "./api";
import { AdBanner } from "./AdBanner";
import { useApp } from "./context";
import { UpdateNotice } from "./UpdateNotice";
import { isoDay, todayRange } from "./format";

interface Props {
  go: (tab: string) => void;
}

interface Data {
  summary: SalesSummary | null;
  open: number;
  low: LowStockItem[];
  recent: Sale[];
  pl: ProfitAndLoss | null;
  payables: Payables | null;
}

/** The first screen: how today is going, what needs attention, and the quick ways in. */
export function Home({ go }: Props) {
  const { session, settings, profile, can, money } = useApp();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const { from, to } = todayRange();
    const none = <T,>(): Promise<T | null> => Promise.resolve(null);
    Promise.all([
      can("reports.view") ? api.salesSummary(from, to) : none<SalesSummary>(),
      api.openOrders().then((o) => o.length),
      can("stock.adjust") ? api.lowStock() : Promise.resolve([] as LowStockItem[]),
      api.recentSales(6),
      can("finance.view") ? api.profitAndLoss(isoDay(), isoDay()) : none<ProfitAndLoss>(),
      can("purchases.manage") ? api.payables() : none<Payables>(),
    ])
      .then(([summary, open, low, recent, pl, payables]) => {
        if (live) setD({ summary, open, low, recent, pl, payables });
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [can]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const today = new Date().toLocaleDateString(settings.locale, { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="page home">
      <div className="page-head">
        <div>
          <h1>
            {greeting}, {session.user?.name}
          </h1>
          <p className="muted">
            {today} · {session.shift ? "Shift is open" : "No shift open yet"}
          </p>
        </div>
        {!session.shift && (
          <button className="btn btn-primary" onClick={() => go("shift")}>
            Open a shift
          </button>
        )}
      </div>

      <UpdateNotice />

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="quick">
        {(profile ? homeShortcuts(profile) : (["checkout", "orders", "kitchen", "customers"] as const)).map((id, i) => {
          const primary = i === 0 ? " primary" : "";
          if (id === "checkout")
            return (
              <button key={id} className={`quick-btn${primary}`} onClick={() => go("checkout")}>
                <strong>New sale</strong>
                <span>Scan or tap items</span>
              </button>
            );
          if (id === "orders")
            return (
              <button key={id} className={`quick-btn${primary}`} onClick={() => go("orders")}>
                <strong>Orders</strong>
                <span>{d ? `${d.open} open` : "Tables, takeaway, delivery"}</span>
              </button>
            );
          if (id === "kitchen")
            return (
              <button key={id} className={`quick-btn${primary}`} onClick={() => go("kitchen")}>
                <strong>Kitchen</strong>
                <span>See what is cooking</span>
              </button>
            );
          if (id === "customers")
            return can("customers.use") ? (
              <button key={id} className={`quick-btn${primary}`} onClick={() => go("customers")}>
                <strong>Customers</strong>
                <span>Points, credit, history</span>
              </button>
            ) : null;
          if (id === "products")
            return can("products.manage") ? (
              <button key={id} className={`quick-btn${primary}`} onClick={() => go("products")}>
                <strong>{profile ? productsLabelFor(profile) : "Menu and stock"}</strong>
                <span>Add items, check stock</span>
              </button>
            ) : null;
          if (id === "purchases")
            return can("purchases.manage") ? (
              <button key={id} className={`quick-btn${primary}`} onClick={() => go("purchases")}>
                <strong>Purchases</strong>
                <span>Stock you buy, what you owe</span>
              </button>
            ) : null;
          return null;
        })}
      </div>

      <div className="stats">
        {d?.summary && (
          <div className="stat">
            <div className="stat-label">Sales today</div>
            <div className="stat-value">{money(d.summary.totalMinor)}</div>
            <span className="muted">{d.summary.salesCount} sales</span>
          </div>
        )}
        {d?.pl && (
          <div className="stat">
            <div className="stat-label">{d.pl.netProfitMinor >= 0 ? "Profit today" : "Loss today"}</div>
            <div className={`stat-value ${d.pl.netProfitMinor >= 0 ? "good" : "bad-text"}`}>
              {money(Math.abs(d.pl.netProfitMinor))}
            </div>
            <span className="muted">after food cost, wages and running costs</span>
          </div>
        )}
        {d && (!profile || isModuleShown(profile, "orders")) && (
          <div className="stat">
            <div className="stat-label">Open orders</div>
            <div className="stat-value">{d.open}</div>
            <span className="muted">not paid yet</span>
          </div>
        )}
        {d?.payables && d.payables.totalMinor > 0 && (
          <div className="stat">
            <div className="stat-label">You owe suppliers</div>
            <div className="stat-value">{money(d.payables.totalMinor)}</div>
            <span className="muted">{d.payables.bySupplier.length} supplier(s)</span>
          </div>
        )}
      </div>

      <div className="home-grid">
        <section className="panel">
          <h2>Latest sales</h2>
          {!d || d.recent.length === 0 ? (
            <p className="empty">Nothing sold yet today.</p>
          ) : (
            <table className="table">
              <tbody>
                {d.recent.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.receiptNo}</td>
                    <td className="muted">{s.orderLabel ?? new Date(s.createdAt).toLocaleTimeString(settings.locale, { hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="num">{s.status === "void" ? <span className="muted">void</span> : money(s.totalMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>Needs attention</h2>
          {d && d.low.length === 0 ? (
            <p className="empty">Nothing to worry about right now.</p>
          ) : (
            <ul className="attention">
              {d?.low.slice(0, 6).map((l) => (
                <li key={l.productId}>
                  <span>
                    <strong>{l.name}</strong> is running low
                  </span>
                  <span className="muted">
                    {l.stock} {l.unit} left
                  </span>
                </li>
              ))}
              {d && d.low.length > 6 && <li className="muted">and {d.low.length - 6} more in Menu and stock</li>}
            </ul>
          )}
        </section>
      </div>
      <AdBanner />
    </div>
  );
}
