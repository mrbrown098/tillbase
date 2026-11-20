import { useCallback, useEffect, useState } from "react";
import type { Payables, Purchase } from "@tillbase/core";
import type { ProductWithStock } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { formatDateTime, parseMoney, parseQty } from "./format";
import { Modal } from "./Modal";

export function Purchases() {
  const { money, toast, session } = useApp();
  const [list, setList] = useState<Purchase[]>([]);
  const [owed, setOwed] = useState<Payables>({ totalMinor: 0, bySupplier: [] });
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<Purchase | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.listPurchases());
      setOwed(await api.payables());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Purchases</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          Record a purchase
        </button>
      </div>
      <div className="stats">
        <div className="panel">
          <div className="stat-label">Owed to suppliers</div>
          <div className="stat-value">{money(owed.totalMinor)}</div>
          {owed.bySupplier.map((s) => (
            <div key={s.supplier} className="muted">{s.supplier}: {money(s.outstandingMinor)}</div>
          ))}
        </div>
      </div>
      <table className="table">
        <thead>
          <tr><th>Date</th><th>Supplier</th><th>Items</th><th className="num">Total</th><th className="num">Owed</th><th aria-label="Actions" /></tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id}>
              <td>{formatDateTime(p.createdAt)}</td>
              <td>{p.supplier ?? "—"}</td>
              <td>{p.items.map((i) => `${i.name} ${i.qty}${i.unit}`).join(", ")}</td>
              <td className="num">{money(p.totalMinor)}</td>
              <td className="num">{p.outstandingMinor > 0 ? <span className="bad-text">{money(p.outstandingMinor)}</span> : "Paid"}</td>
              <td className="actions">
                {p.outstandingMinor > 0 && <button className="btn" onClick={() => setPaying(p)}>Pay</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p className="empty">No purchases yet. Record what you buy so your costs are real.</p>}
      {adding && <PurchaseForm hasShift={!!session.shift} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void load(); }} />}
      {paying && <PayForm purchase={paying} hasShift={!!session.shift} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); void load(); }} />}
    </div>
  );
}

function PurchaseForm({ hasShift, onClose, onSaved }: { hasShift: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [items, setItems] = useState<ProductWithStock[]>([]);
  const [supplier, setSupplier] = useState("");
  const [lines, setLines] = useState<{ productId: string; qty: string; cost: string }[]>([{ productId: "", qty: "", cost: "" }]);
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState<"cash" | "card" | "other">("cash");
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listItems("all").then((l) => setItems(l.filter((i) => i.active && i.trackStock))).catch(() => undefined);
  }, []);

  const total = lines.reduce((s, l) => s + (parseMoney(l.cost) ?? 0), 0);
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    const out: { productId: string; qty: number; costMinor: number }[] = [];
    for (const l of lines) {
      if (!l.productId && !l.qty && !l.cost) continue;
      const qty = parseQty(l.qty);
      const costMinor = parseMoney(l.cost);
      if (!l.productId || qty === null || qty <= 0 || costMinor === null) return setError("Each line needs an item, a quantity and the total price paid for it");
      out.push({ productId: l.productId, qty, costMinor });
    }
    const paidMinor = paid.trim() === "" ? total : parseMoney(paid);
    if (paidMinor === null) return setError("Enter the amount paid now (0 if nothing)");
    try {
      await api.recordPurchase({ supplier, items: out, paidMinor, method }, drawer);
      toast("Purchase recorded and stock updated");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Record a purchase" onClose={onClose} wide>
      <label className="field">Supplier (optional)<input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></label>
      <table className="table">
        <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Total price paid</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => {
            const it = items.find((x) => x.id === l.productId);
            return (
              <tr key={i}>
                <td>
                  <select value={l.productId} onChange={(e) => set(i, { productId: e.target.value })}>
                    <option value="">Choose…</option>
                    {items.map((x) => <option key={x.id} value={x.id}>{x.name}{x.kind === "ingredient" ? ` (${x.unit})` : ""}</option>)}
                  </select>
                </td>
                <td className="num"><input className="qty-input" inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /> {it?.unit}</td>
                <td className="num"><input className="qty-input" inputMode="decimal" value={l.cost} onChange={(e) => set(i, { cost: e.target.value })} /></td>
                <td>{lines.length > 1 && <button className="btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="btn" onClick={() => setLines([...lines, { productId: "", qty: "", cost: "" }])}>Add another item</button>
      <div className="form-grid">
        <label className="field">Paid now (empty = all)<input inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} placeholder={(total / 100).toFixed(2)} /></label>
        <label className="field">Paid by
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="cash">Cash</option><option value="card">Card / bank</option><option value="other">Other</option>
          </select>
        </label>
        {method === "cash" && (
          <label className="check span2">
            <input type="checkbox" checked={drawer} disabled={!hasShift} onChange={(e) => setDrawer(e.target.checked)} />
            Took the cash from the till drawer{!hasShift && " (open a shift first)"}
          </label>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()}>Save purchase</button>
      </div>
    </Modal>
  );
}

function PayForm({ purchase, hasShift, onClose, onSaved }: { purchase: Purchase; hasShift: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast, money } = useApp();
  const [amount, setAmount] = useState((purchase.outstandingMinor / 100).toFixed(2));
  const [method, setMethod] = useState<"cash" | "card" | "other">("cash");
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const a = parseMoney(amount);
    if (a === null || a <= 0) return setError("Enter an amount");
    try {
      await api.payPurchase(purchase.id, a, method, drawer);
      toast("Payment recorded");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Pay ${purchase.supplier ?? "supplier"}`} onClose={onClose}>
      <p className="muted">{money(purchase.outstandingMinor)} is still owed on this purchase.</p>
      <label className="field">Amount<input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field">Paid by
        <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="cash">Cash</option><option value="card">Card / bank</option><option value="other">Other</option>
        </select>
      </label>
      {method === "cash" && (
        <label className="check"><input type="checkbox" checked={drawer} disabled={!hasShift} onChange={(e) => setDrawer(e.target.checked)} />Took the cash from the till drawer</label>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()}>Record payment</button>
      </div>
    </Modal>
  );
}
