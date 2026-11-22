import { useCallback, useEffect, useState } from "react";
import type { PurchaseOrder, PurchaseOrderStatus, SupplierStatement } from "@tillbase/core";
import type { ProductWithStock } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { formatDateTime, minorToInput, parseMoney, parseQty } from "./format";
import { Modal } from "./Modal";

const progressText: Record<PurchaseOrder["progress"], string> = {
  waiting: "Waiting for delivery",
  partly_received: "Partly received",
  received: "Received",
  cancelled: "Cancelled",
};

/** Orders sent to suppliers: place one, receive it in one or several deliveries, cancel it, and see what you owe a supplier. */
export function PurchaseOrders() {
  const { money, toast, session } = useApp();
  const [filter, setFilter] = useState<PurchaseOrderStatus | "all">("open");
  const [list, setList] = useState<PurchaseOrder[]>([]);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
  const [cancelling, setCancelling] = useState<PurchaseOrder | null>(null);
  const [statementFor, setStatementFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.listPurchaseOrders(filter === "all" ? undefined : filter));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [filter, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const onOrder = list.filter((o) => o.status === "open").reduce((s, o) => s + o.onOrderMinor, 0);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Supplier orders</h1>
        <div className="presets">
          <button className="btn" onClick={() => setStatementFor("")}>Supplier statement</button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>New order</button>
        </div>
      </div>
      <p className="muted">
        An order is a promise to buy. Nothing is added to your stock or owed to the supplier until the goods arrive and you press
        <strong> Receive</strong>.
      </p>
      <div className="presets" role="tablist" aria-label="Which orders">
        {(["open", "received", "cancelled", "all"] as const).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`btn${filter === f ? " btn-primary" : ""}`} onClick={() => setFilter(f)}>
            {f === "open" ? "Waiting" : f === "received" ? "Received" : f === "cancelled" ? "Cancelled" : "All"}
          </button>
        ))}
      </div>
      {(filter === "open" || filter === "all") && onOrder > 0 && (
        <div className="stats">
          <div className="panel">
            <div className="stat-label">Still expected from suppliers</div>
            <div className="stat-value">{money(onOrder)}</div>
          </div>
        </div>
      )}
      <table className="table">
        <thead>
          <tr><th>Order</th><th>Supplier</th><th>Items</th><th className="num">Ordered</th><th>Status</th><th aria-label="Actions" /></tr>
        </thead>
        <tbody>
          {list.map((o) => (
            <tr key={o.id}>
              <td>{o.code}<div className="muted">{formatDateTime(o.createdAt)}</div></td>
              <td><button className="link" onClick={() => setStatementFor(o.supplier)}>{o.supplier}</button></td>
              <td>
                {o.lines.map((l) => (
                  <div key={l.id}>
                    {l.name}: {l.qtyReceived} of {l.qtyOrdered} {l.unit}
                  </div>
                ))}
              </td>
              <td className="num">{money(o.orderedTotalMinor)}</td>
              <td>
                {progressText[o.progress]}
                {o.cancelReason && <div className="muted">{o.cancelReason}</div>}
              </td>
              <td className="actions">
                {o.status === "open" && <button className="btn btn-primary" onClick={() => setReceiving(o)}>Receive</button>}
                {o.status === "open" && <button className="btn" onClick={() => setCancelling(o)}>Cancel</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p className="empty">{filter === "open" ? "No orders waiting for delivery." : "Nothing here yet."}</p>}

      {creating && <OrderForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void load(); }} />}
      {receiving && (
        <ReceiveForm order={receiving} hasShift={!!session.shift} onClose={() => setReceiving(null)} onSaved={() => { setReceiving(null); void load(); }} />
      )}
      {cancelling && <CancelForm order={cancelling} onClose={() => setCancelling(null)} onSaved={() => { setCancelling(null); void load(); }} />}
      {statementFor !== null && <Statement initial={statementFor} onClose={() => setStatementFor(null)} />}
    </div>
  );
}

function OrderForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast, money } = useApp();
  const [items, setItems] = useState<ProductWithStock[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([{ productId: "", qty: "", price: "" }]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listItems("all").then((l) => setItems(l.filter((i) => i.active && i.trackStock))).catch(() => undefined);
    api.supplierNames().then(setSuppliers).catch(() => undefined);
  }, []);

  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + Math.round((parseQty(l.qty) ?? 0) * (parseMoney(l.price) ?? 0)), 0);

  const save = async () => {
    if (!supplier.trim()) return setError("Enter the supplier's name");
    const out: { productId: string; qty: number; unitCostMinor: number }[] = [];
    for (const l of lines) {
      if (!l.productId && !l.qty && !l.price) continue;
      const qty = parseQty(l.qty);
      const unitCostMinor = parseMoney(l.price);
      if (!l.productId || qty === null || qty <= 0 || unitCostMinor === null) return setError("Each line needs an item, a quantity and the price of one unit");
      out.push({ productId: l.productId, qty, unitCostMinor });
    }
    try {
      const o = await api.createPurchaseOrder({ supplier, note, lines: out });
      toast(`${o.code} created`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="New supplier order" onClose={onClose} wide>
      <label className="field">Supplier
        <input list="supplier-names" value={supplier} onChange={(e) => setSupplier(e.target.value)} autoFocus />
        <datalist id="supplier-names">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
      </label>
      <table className="table">
        <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Price of one unit</th><th /></tr></thead>
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
                <td className="num"><input className="qty-input" inputMode="decimal" value={l.price} onChange={(e) => set(i, { price: e.target.value })} /></td>
                <td>{lines.length > 1 && <button className="btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="btn" onClick={() => setLines([...lines, { productId: "", qty: "", price: "" }])}>Add another item</button>
      <label className="field">Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <p className="muted">Order total at these prices: <strong>{money(total)}</strong></p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()}>Create order</button>
      </div>
    </Modal>
  );
}

function ReceiveForm({ order, hasShift, onClose, onSaved }: { order: PurchaseOrder; hasShift: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast, money } = useApp();
  const open = order.lines.filter((l) => l.qtyRemaining > 0);
  const [rows, setRows] = useState(open.map((l) => ({ lineId: l.id, qty: String(l.qtyRemaining), cost: "" })));
  const [invoice, setInvoice] = useState("");
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState<"cash" | "card" | "other">("cash");
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");

  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const costOf = (i: number) => {
    const l = open[i]!;
    const typed = rows[i]!.cost.trim() === "" ? null : parseMoney(rows[i]!.cost);
    return typed ?? Math.round((parseQty(rows[i]!.qty) ?? 0) * l.unitCostMinor);
  };
  const total = rows.reduce((s, r, i) => ((parseQty(r.qty) ?? 0) > 0 ? s + costOf(i) : s), 0);

  const save = async () => {
    const lines: { lineId: string; qty: number; costMinor?: number }[] = [];
    for (const [i, r] of rows.entries()) {
      const qty = r.qty.trim() === "" ? 0 : parseQty(r.qty);
      if (qty === null || qty < 0) return setError("Quantities must be numbers");
      if (qty === 0) continue;
      const costText = r.cost.trim();
      const cost = costText === "" ? undefined : parseMoney(costText);
      if (cost === null) return setError("Enter what the supplier charged as a number, or leave it empty to use the agreed price");
      lines.push({ lineId: open[i]!.id, qty, ...(cost === undefined ? {} : { costMinor: cost }) });
    }
    if (lines.length === 0) return setError("Enter how much of at least one item arrived");
    const paidMinor = paid.trim() === "" ? 0 : parseMoney(paid);
    if (paidMinor === null) return setError("Enter the amount paid now as a number (empty means nothing)");
    try {
      const after = await api.receivePurchaseOrder(order.id, { lines, paidMinor, method, invoiceRef: invoice }, drawer);
      toast(after.status === "received" ? `${after.code} received in full. Stock updated.` : `Delivery booked on ${after.code}. Stock updated.`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`Receive ${order.code} from ${order.supplier}`} onClose={onClose} wide>
      <p className="muted">Enter what arrived today. You can receive the rest later. Stock goes up as soon as you save.</p>
      <table className="table">
        <thead><tr><th>Item</th><th className="num">Still expected</th><th className="num">Arrived now</th><th className="num">Supplier charged (optional)</th></tr></thead>
        <tbody>
          {open.map((l, i) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td className="num">{l.qtyRemaining} {l.unit}</td>
              <td className="num"><input className="qty-input" inputMode="decimal" aria-label={`${l.name} arrived`} value={rows[i]!.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
              <td className="num"><input className="qty-input" inputMode="decimal" aria-label={`${l.name} charged`} value={rows[i]!.cost} onChange={(e) => set(i, { cost: e.target.value })} placeholder={minorToInput(Math.round((parseQty(rows[i]!.qty) ?? 0) * l.unitCostMinor))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>This delivery is worth <strong>{money(total)}</strong>.</p>
      <div className="form-grid">
        <label className="field">Supplier's invoice number (optional)<input value={invoice} onChange={(e) => setInvoice(e.target.value)} /></label>
        <label className="field">Paid now (empty = nothing yet)<input inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} placeholder="0.00" /></label>
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
        <button className="btn btn-primary" onClick={() => void save()}>Save delivery</button>
      </div>
    </Modal>
  );
}

function CancelForm({ order, onClose, onSaved }: { order: PurchaseOrder; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const partly = order.progress === "partly_received";
  const save = async () => {
    try {
      await api.cancelPurchaseOrder(order.id, reason);
      toast(`${order.code} cancelled`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Cancel ${order.code}?`} onClose={onClose}>
      <p>
        {partly
          ? "Part of this order has already arrived. That stays in your stock and in what you owe. Only the part still to come is cancelled."
          : "Nothing has arrived yet, so your stock and what you owe are not affected."}
      </p>
      <label className="field">Why? (optional)<input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Keep the order</button>
        <button className="btn btn-danger" onClick={() => void save()}>Cancel the order</button>
      </div>
    </Modal>
  );
}

function Statement({ initial, onClose }: { initial: string; onClose: () => void }) {
  const { money, toast } = useApp();
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [supplier, setSupplier] = useState(initial);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<SupplierStatement | null>(null);

  useEffect(() => {
    api.supplierNames().then((n) => {
      setSuppliers(n);
      setSupplier((s) => s || n[0] || "");
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!supplier) return setData(null);
    api.supplierStatement(supplier, from || undefined, to || undefined).then(setData).catch((e: Error) => toast(e.message, "error"));
  }, [supplier, from, to, toast]);

  return (
    <Modal title="Supplier statement" onClose={onClose} wide>
      <div className="form-grid">
        <label className="field">Supplier
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            {suppliers.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="field">From (optional)<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">To (optional)<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {suppliers.length === 0 && <p className="empty">No suppliers yet. They appear once you record a purchase or place an order.</p>}
      {data && (
        <>
          <table className="table">
            <thead><tr><th>Date</th><th>What</th><th className="num">Bought</th><th className="num">Paid</th><th className="num">You owe</th></tr></thead>
            <tbody>
              {from && (
                <tr><td colSpan={4}>Owed before {from}</td><td className="num">{money(data.openingBalanceMinor)}</td></tr>
              )}
              {data.entries.map((e, i) => (
                <tr key={i}>
                  <td>{formatDateTime(e.at)}</td>
                  <td>{e.description}</td>
                  <td className="num">{e.debitMinor ? money(e.debitMinor) : ""}</td>
                  <td className="num">{e.creditMinor ? money(e.creditMinor) : ""}</td>
                  <td className="num">{money(e.balanceMinor)}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={2}>Total</th>
                <th className="num">{money(data.totalPurchasedMinor)}</th>
                <th className="num">{money(data.totalPaidMinor)}</th>
                <th className="num">{money(data.closingBalanceMinor)}</th>
              </tr>
            </tbody>
          </table>
          {data.entries.length === 0 && <p className="empty">Nothing bought from {data.supplier} in this period.</p>}
          {data.onOrder.length > 0 && (
            <p className="muted">
              On order, not delivered yet (not owed): {data.onOrder.map((o) => `${o.code} ${money(o.remainingMinor)}`).join(", ")}.
            </p>
          )}
        </>
      )}
      <div className="modal-actions"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
