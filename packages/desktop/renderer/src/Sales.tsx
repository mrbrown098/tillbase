import { useCallback, useEffect, useState } from "react";
import type { Sale, SalesSummary } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { formatDateTime, todayRange } from "./format";
import { Modal, ReceiptView, PrintArea } from "./Modal";

export function Sales() {
  const { money, toast, can } = useApp();
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [viewing, setViewing] = useState<{ sale: Sale; text: string } | null>(null);
  const [voiding, setVoiding] = useState<Sale | null>(null);

  const load = useCallback(async () => {
    try {
      const { from, to } = todayRange();
      const [s, r] = await Promise.all([
        can("reports.view") ? api.salesSummary(from, to) : Promise.resolve(null),
        api.recentSales(50),
      ]);
      setSummary(s);
      setSales(r);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast, can]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (sale: Sale) => {
    try {
      setViewing({ sale, text: await api.receiptText(sale.id) });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Sales</h1>
        <button className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {summary && (
        <div className="stats">
          <Stat label="Today's sales" value={money(summary.totalMinor)} />
          <Stat label="Transactions" value={String(summary.salesCount)} />
          <Stat label="Cash kept" value={money(summary.byMethod.cash ?? 0)} />
          <Stat label="Card" value={money(summary.byMethod.card ?? 0)} />
          <Stat label="Tax collected" value={money(summary.taxMinor)} />
          <Stat label="Voided" value={String(summary.voidCount)} />
        </div>
      )}

      {summary && summary.topProducts.length > 0 && (
        <section className="panel">
          <h2>Top products today</h2>
          <ol className="top">
            {summary.topProducts.map((p) => (
              <li key={p.name}>
                <span>{p.name}</span>
                <span className="muted">
                  {p.qty} sold · {money(p.totalMinor)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <h2 className="section">Recent sales</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Time</th>
            <th>Items</th>
            <th className="num">Total</th>
            <th>Status</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <tr key={s.id} className={s.status === "void" ? "inactive" : ""}>
              <td className="mono">{s.receiptNo}</td>
              <td>{formatDateTime(s.createdAt)}</td>
              <td>{s.items.reduce((n, i) => n + i.qty, 0)}</td>
              <td className="num">{money(s.totalMinor)}</td>
              <td>{s.status === "void" ? <span className="badge badge-warn">void</span> : "Completed"}</td>
              <td className="actions">
                <button className="btn" onClick={() => void open(s)}>
                  Receipt
                </button>
                {s.status === "completed" && can("void") && (
                  <button className="btn" onClick={() => setVoiding(s)}>
                    Void
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sales.length === 0 && <p className="empty">No sales yet.</p>}

      {viewing && (
        <Modal title={`Receipt · ${viewing.sale.receiptNo}`} onClose={() => setViewing(null)}>
          <ReceiptView text={viewing.text} />
          <div className="modal-actions">
            <button className="btn" onClick={() => window.print()}>
              Print
            </button>
            <button className="btn btn-primary" onClick={() => setViewing(null)}>
              Close
            </button>
          </div>
          <PrintArea text={viewing.text} />
        </Modal>
      )}

      {voiding && (
        <VoidForm
          sale={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => {
            setVoiding(null);
            toast("Sale voided and stock restored");
            void load();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function VoidForm({
  sale,
  onClose,
  onDone,
}: {
  sale: Sale;
  onClose: () => void;
  onDone: () => void;
}) {
  const { money } = useApp();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const confirm = async () => {
    if (!reason.trim()) return setError("A reason is required");
    try {
      await api.voidSale(sale.id, reason);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`Void ${sale.receiptNo}?`} onClose={onClose}>
      <p>
        This cancels the {money(sale.totalMinor)} sale and puts its items back in stock. It cannot be
        undone. Remember to refund the customer.
      </p>
      <label className="field">
        Reason
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void confirm();
          }}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Keep sale
        </button>
        <button className="btn btn-danger" onClick={() => void confirm()}>
          Void sale
        </button>
      </div>
    </Modal>
  );
}
