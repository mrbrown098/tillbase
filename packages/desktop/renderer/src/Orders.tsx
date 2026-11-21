import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { taxFor } from "@tillbase/core/money";
import type { Customer, LoyaltyConfig, Modifier, Order, OrderType, PaymentInput } from "@tillbase/core";
import type { ProductWithStock } from "../../shared/api";
import { api } from "./api";
import { CustomerBar, PayModal } from "./Checkout";
import { useApp } from "./context";
import { CustomerPicker } from "./CustomerPicker";
import { pointsEarned, type BillLine } from "./loyalty";
import { minorToInput, parseMoney } from "./format";
import { Modal, ReceiptView } from "./Modal";

const typeLabel: Record<OrderType, string> = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
const orderTitle = (o: Order) => `#${o.token} · ${typeLabel[o.type]}${o.tableLabel ? ` · Table ${o.tableLabel}` : ""}`;

export function Orders({ onOpenShift }: { onOpenShift: () => void }) {
  const { money, toast, session } = useApp();
  const [orders, setOrders] = useState<Order[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductWithStock[]>([]);
  const [mods, setMods] = useState<Modifier[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState<ProductWithStock | null>(null);
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [done, setDone] = useState<{ receipt: string; change: number; no: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(
    async (select?: string | null) => {
      try {
        const list = await api.openOrders();
        setOrders(list);
        setActiveId((cur) => {
          const want = select === undefined ? cur : select;
          return want && list.some((o) => o.id === want) ? want : (list[0]?.id ?? null);
        });
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },
    [toast],
  );

  useEffect(() => {
    void reload();
    api.listProducts().then(setProducts).catch((e: Error) => toast(e.message, "error"));
    api.modifiers().then(setMods).catch(() => undefined);
    api.getLoyalty().then(setConfig).catch(() => undefined);
  }, [reload, toast]);

  const active = orders.find((o) => o.id === activeId) ?? null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => p.active && (!q || p.name.toLowerCase().includes(q))).slice(0, 80);
  }, [products, query]);
  const taxOf = useMemo(() => new Map(products.map((p) => [p.id, p.taxRateBp])), [products]);

  const totals = useMemo(() => {
    let sub = 0;
    let tax = 0;
    for (const i of active?.items ?? []) {
      sub += i.lineMinor;
      tax += taxFor(i.lineMinor, taxOf.get(i.productId) ?? 0);
    }
    // The delivery charge is added at payment as its own untaxed line.
    const fee = active?.type === "delivery" ? active.deliveryFeeMinor : 0;
    return { sub, tax, fee, total: sub + tax + fee };
  }, [active, taxOf]);

  const billLines = useMemo<BillLine[]>(
    () => (active?.items ?? []).map((i) => ({ netMinor: i.lineMinor, taxRateBp: taxOf.get(i.productId) ?? 0 })),
    [active, taxOf],
  );

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      toast((e as Error).message, "error");
      return undefined;
    }
  };

  const addProduct = async (p: ProductWithStock, modifierIds: string[] = [], note = "", qty = 1) => {
    if (!active) return toast("Start an order first", "error");
    const o = await run(() => api.addOrderItem(active.id, { productId: p.id, qty, modifierIds, note: note || null }));
    if (o) await reload(o.id);
    searchRef.current?.focus();
  };

  const tapProduct = (p: ProductWithStock) => {
    if (!active) return toast("Start a new order first", "error");
    if (mods.length > 0) setPicking(p);
    else void addProduct(p);
  };

  const send = async () => {
    if (!active) return;
    const t = await run(() => api.sendToKitchen(active.id));
    if (!t) return;
    await reload(active.id);
    toast("Sent to the kitchen");
    const lines = t.items.map((i) => `${i.qty} x ${i.name}${i.modifiers.length ? `\n    + ${i.modifiers.join(", ")}` : ""}${i.note ? `\n    NOTE: ${i.note}` : ""}`);
    setTicket(
      [`KITCHEN  #${t.token}`, `${typeLabel[t.type]}${t.tableLabel ? `  Table ${t.tableLabel}` : ""}`, "-".repeat(28), ...lines, ...(t.note ? ["-".repeat(28), `ORDER NOTE: ${t.note}`] : [])].join("\n"),
    );
  };

  const finish = async (payments: PaymentInput[], loyalty: { redeemPoints: number; walletMinor: number }) => {
    if (!active) return;
    const r = await run(() => api.payOrder(active.id, payments, active.customerId ? loyalty : undefined));
    if (!r) return;
    setPaying(false);
    setDone({ receipt: r.receipt, change: r.sale.changeMinor, no: r.sale.receiptNo });
    await reload(null);
  };

  const unsent = active?.items.some((i) => !i.sent) ?? false;
  // A bill can be split when there is more than one thing on it to hand over (the original keeps at least one).
  const canSplit = !!active && (active.items.length > 1 || (active.items[0]?.qty ?? 0) >= 2);

  return (
    <div className="orders">
      <header className="order-tabs">
        <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!session.shift}>
          + New order
        </button>
        {!session.shift && (
          <button className="btn" onClick={onOpenShift}>
            Open a shift to take orders
          </button>
        )}
        <div className="chips" role="tablist" aria-label="Open orders">
          {orders.map((o) => (
            <button
              key={o.id}
              role="tab"
              aria-selected={o.id === activeId}
              className={`chip${o.id === activeId ? " on" : ""}${o.kitchenStatus === "ready" ? " ready" : ""}`}
              onClick={() => setActiveId(o.id)}
            >
              {orderTitle(o)}
              {o.kitchenStatus && <span className="chip-sub">{o.kitchenStatus}</span>}
            </button>
          ))}
          {orders.length === 0 && <span className="muted">No open orders</span>}
        </div>
      </header>

      <div className="order-body">
        <section className="catalog">
          <input
            ref={searchRef}
            className="scan"
            placeholder="Search the menu"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the menu"
          />
          <div className="tiles">
            {shown.map((p) => (
              <button key={p.id} className="tile" onClick={() => tapProduct(p)} disabled={!active}>
                <span className="tile-name">{p.name}</span>
                <span className="tile-price">{money(p.priceMinor)}</span>
              </button>
            ))}
          </div>
          {shown.length === 0 && <p className="empty">No menu items found.</p>}
        </section>

        <aside className="cart" aria-label="Current order">
          {!active ? (
            <p className="empty">Tap “New order” to start. Choose dine-in, takeaway or delivery.</p>
          ) : (
            <>
              <div className="order-head">
                <h2>{orderTitle(active)}</h2>
                <button className="btn btn-ghost" onClick={() => setEditing(true)}>
                  Details
                </button>
              </div>
              <CustomerBar
                customer={active.customer}
                earnHint={active.customer && config ? pointsEarned(totals.sub, config.spendPerPointMinor) : 0}
                onChoose={() => setChoosing(true)}
                onClear={() => void run(() => api.updateOrder(active.id, { customerId: null })).then((o) => o && reload(o.id))}
              />
              {(active.customerName || active.customerPhone || active.deliveryAddress || active.note) && (
                <p className="muted small">
                  {[active.customerName, active.customerPhone, active.deliveryAddress, active.note && `Note: ${active.note}`].filter(Boolean).join(" · ")}
                </p>
              )}
              <div className="cart-lines">
                {active.items.length === 0 && <p className="empty">Tap menu items to add them.</p>}
                {active.items.map((i) => (
                  <div className="cart-line" key={i.id}>
                    <div className="cart-line-top">
                      <span className="cart-name">
                        {i.name}
                        {i.sent && <span className="badge">in kitchen</span>}
                      </span>
                      <span className="cart-total">{money(i.lineMinor)}</span>
                    </div>
                    {(i.modifiers.length > 0 || i.note) && (
                      <div className="muted small">
                        {i.modifiers.map((m) => `+ ${m.name}${m.priceMinor ? ` (${money(m.priceMinor)})` : ""}`).join(", ")}
                        {i.note && ` · ${i.note}`}
                      </div>
                    )}
                    <div className="cart-line-bottom">
                      <div className="stepper">
                        <button className="btn" aria-label={`Decrease ${i.name}`} onClick={() => void run(() => (i.qty <= 1 ? api.removeOrderItem(i.id) : api.setOrderItemQty(i.id, i.qty - 1))).then((o) => o && reload(o.id))}>
                          −
                        </button>
                        <span className="qty">{i.qty}</span>
                        <button className="btn" aria-label={`Increase ${i.name}`} onClick={() => void run(() => api.setOrderItemQty(i.id, i.qty + 1)).then((o) => o && reload(o.id))}>
                          +
                        </button>
                      </div>
                      <button className="btn btn-ghost" aria-label={`Remove ${i.name}`} onClick={() => void run(() => api.removeOrderItem(i.id)).then((o) => o && reload(o.id))}>
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <dl className="totals">
                <div><dt>Subtotal</dt><dd>{money(totals.sub)}</dd></div>
                {totals.tax > 0 && <div><dt>Tax</dt><dd>{money(totals.tax)}</dd></div>}
                {totals.fee > 0 && <div><dt>Delivery</dt><dd>{money(totals.fee)}</dd></div>}
                <div className="grand"><dt>Total</dt><dd>{money(totals.total)}</dd></div>
              </dl>
              <div className="cart-actions">
                <button className="btn btn-danger" onClick={() => setCancelling(true)}>Cancel order</button>
                <button className="btn" disabled={!unsent} onClick={() => void send()}>Send to kitchen</button>
                <button className="btn" disabled={!canSplit} title={canSplit ? "Move some items to a separate bill" : "Needs at least two items or two of one item"} onClick={() => setSplitting(true)}>Split bill</button>
                <button className="btn btn-primary btn-lg" disabled={active.items.length === 0 || !session.shift} onClick={() => setPaying(true)}>
                  Pay {active.items.length ? money(totals.total) : ""}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>

      {creating && (
        <OrderDetails
          title="New order"
          onClose={() => setCreating(false)}
          onSave={async (v) => {
            const o = await api.createOrder(v);
            setCreating(false);
            await reload(o.id);
            searchRef.current?.focus();
          }}
        />
      )}
      {editing && active && (
        <OrderDetails
          title={`Order #${active.token} details`}
          order={active}
          onClose={() => setEditing(false)}
          onSave={async (v) => {
            await api.updateOrder(active.id, v);
            setEditing(false);
            await reload(active.id);
          }}
        />
      )}
      {picking && (
        <Picker
          product={picking}
          mods={mods}
          onClose={() => setPicking(null)}
          onAdd={(ids, note, qty) => {
            const p = picking;
            setPicking(null);
            void addProduct(p, ids, note, qty);
          }}
        />
      )}
      {splitting && active && (
        <SplitModal
          order={active}
          onClose={() => setSplitting(false)}
          onSplit={async (picks) => {
            const r = await api.splitOrder(active.id, picks);
            setSplitting(false);
            await reload(r.created.id);
            toast(`Bill split. You are now on #${r.created.token}`);
          }}
        />
      )}
      {choosing && active && (
        <CustomerPicker
          onClose={() => setChoosing(false)}
          onPick={(c) => {
            setChoosing(false);
            void run(() => api.updateOrder(active.id, { customerId: c.id })).then((o) => o && reload(o.id));
          }}
        />
      )}
      {paying && active && (
        <PayModal
          lines={billLines}
          extraMinor={totals.fee}
          customer={active.customer}
          config={config}
          onClose={() => setPaying(false)}
          onConfirm={finish}
        />
      )}
      {cancelling && active && (
        <CancelModal
          order={active}
          onClose={() => setCancelling(false)}
          onCancelled={async () => {
            setCancelling(false);
            await reload(null);
          }}
        />
      )}
      {ticket && (
        <Modal title="Kitchen ticket" onClose={() => setTicket(null)}>
          <ReceiptView text={ticket} />
          <div className="modal-actions">
            <button className="btn" onClick={() => window.print()}>Print ticket</button>
            <button className="btn btn-primary" autoFocus onClick={() => setTicket(null)}>Done</button>
          </div>
          <pre id="print-area">{ticket}</pre>
        </Modal>
      )}
      {done && (
        <Modal title={`Paid · ${done.no}`} onClose={() => setDone(null)}>
          {done.change > 0 && <p className="change-due">Change due: <strong>{money(done.change)}</strong></p>}
          <ReceiptView text={done.receipt} />
          <div className="modal-actions">
            <button className="btn" onClick={() => window.print()}>Print receipt</button>
            <button className="btn btn-primary" autoFocus onClick={() => setDone(null)}>Next order</button>
          </div>
          <pre id="print-area">{done.receipt}</pre>
        </Modal>
      )}
    </div>
  );
}

function OrderDetails({
  title,
  order,
  onClose,
  onSave,
}: {
  title: string;
  order?: Order;
  onClose: () => void;
  onSave: (v: { type: OrderType; tableLabel: string; customerName: string; customerPhone: string; deliveryAddress: string; deliveryFeeMinor: number; note: string; customerId: string | null }) => Promise<void>;
}) {
  const [type, setType] = useState<OrderType>(order?.type ?? "takeaway");
  const [tableLabel, setTable] = useState(order?.tableLabel ?? "");
  const [customerName, setName] = useState(order?.customerName ?? "");
  const [customerPhone, setPhone] = useState(order?.customerPhone ?? "");
  const [deliveryAddress, setAddress] = useState(order?.deliveryAddress ?? "");
  const [fee, setFee] = useState(order && order.deliveryFeeMinor > 0 ? minorToInput(order.deliveryFeeMinor) : "");
  const [note, setNote] = useState(order?.note ?? "");
  const [error, setError] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(order?.customerId ?? null);
  const [picking, setPicking] = useState(false);
  const usePicked = (c: Customer) => {
    setCustomerId(c.id);
    setName(c.name);
    setPhone(c.phone ?? "");
    if (c.address) setAddress(c.address);
    setPicking(false);
  };
  const save = async () => {
    if (type === "delivery" && (!deliveryAddress.trim() || !customerPhone.trim())) {
      return setError("Delivery needs a phone number and an address");
    }
    // Blank means no charge. Anything else must be an amount like 150 or 150.50.
    const deliveryFeeMinor = type === "delivery" && fee.trim() !== "" ? parseMoney(fee) : 0;
    if (deliveryFeeMinor === null) return setError("Delivery charge must be an amount like 150 or 150.50");
    try {
      await onSave({ type, tableLabel, customerName, customerPhone, deliveryAddress, deliveryFeeMinor, note, customerId });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (picking) return <CustomerPicker onClose={() => setPicking(false)} onPick={usePicked} />;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="methods" role="group" aria-label="Order type">
        {(Object.keys(typeLabel) as OrderType[]).map((t) => (
          <button key={t} className={`btn btn-lg${type === t ? " btn-primary" : ""}`} aria-pressed={type === t} onClick={() => setType(t)}>
            {typeLabel[t]}
          </button>
        ))}
      </div>
      {type === "dine_in" && (
        <label className="field">Table<input autoFocus value={tableLabel} onChange={(e) => setTable(e.target.value)} placeholder="e.g. 5" /></label>
      )}
      <div className="customer-field">
        {customerId ? (
          <>
            <span>Saved customer attached</span>
            <button className="btn btn-ghost" onClick={() => setCustomerId(null)}>Detach</button>
          </>
        ) : (
          <button className="btn" onClick={() => setPicking(true)}>Find a customer by phone</button>
        )}
      </div>
      {type !== "dine_in" && (
        <label className="field">Customer name (optional)<input value={customerName} onChange={(e) => setName(e.target.value)} /></label>
      )}
      {type === "delivery" && (
        <>
          <label className="field">Phone<input value={customerPhone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label className="field">Address<input value={deliveryAddress} onChange={(e) => setAddress(e.target.value)} /></label>
          <label className="field">Delivery charge (optional)<input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0.00" /></label>
        </>
      )}
      <label className="field">Note for the kitchen (optional)<input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()}>{order ? "Save" : "Start order"}</button>
      </div>
    </Modal>
  );
}

/** Choose what moves to a separate bill. Whole units only; the bill you are on always keeps something. */
function SplitModal({
  order,
  onClose,
  onSplit,
}: {
  order: Order;
  onClose: () => void;
  onSplit: (picks: { itemId: string; qty: number }[]) => Promise<void>;
}) {
  const { money } = useApp();
  const [moving, setMoving] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const picks = order.items.filter((i) => (moving[i.id] ?? 0) > 0).map((i) => ({ itemId: i.id, qty: moving[i.id]! }));
  const movedMinor = order.items.reduce((s, i) => s + Math.round(((moving[i.id] ?? 0) / i.qty) * i.lineMinor), 0);
  const keepsSomething = order.items.some((i) => (moving[i.id] ?? 0) < i.qty);
  const set = (id: string, qty: number) => {
    setError("");
    setMoving((m) => ({ ...m, [id]: qty }));
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSplit(picks);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Split bill #${order.token}`} onClose={onClose}>
      <p className="muted small">Choose what goes on the new bill. The rest stays here. Food already in the kitchen is not cooked again.</p>
      <ul className="split-items" aria-label="Items to move">
        {order.items.map((i) => {
          const n = moving[i.id] ?? 0;
          const whole = Number.isInteger(i.qty);
          return (
            <li key={i.id}>
              <div className="split-item-name">
                <span>{i.qty} × {i.name}</span>
                {(i.modifiers.length > 0 || i.note) && (
                  <span className="muted small">{[...i.modifiers.map((m) => `+ ${m.name}`), i.note].filter(Boolean).join(" · ")}</span>
                )}
              </div>
              <span className="muted">{money(i.lineMinor)}</span>
              {whole ? (
                <div className="stepper">
                  <button className="btn" aria-label={`Move fewer ${i.name}`} disabled={n <= 0} onClick={() => set(i.id, n - 1)}>−</button>
                  <span className="qty" aria-label={`${i.name} to move`}>{n}</span>
                  <button className="btn" aria-label={`Move more ${i.name}`} disabled={n >= i.qty} onClick={() => set(i.id, n + 1)}>+</button>
                </div>
              ) : (
                <label className="check">
                  <input type="checkbox" checked={n > 0} onChange={(e) => set(i.id, e.target.checked ? i.qty : 0)} />
                  Move all
                </label>
              )}
            </li>
          );
        })}
      </ul>
      <dl className="split-summary split-two">
        <div><dt>New bill</dt><dd>{money(movedMinor)}</dd></div>
        <div><dt>Stays on #{order.token}</dt><dd>{money(order.subtotalMinor - movedMinor)}</dd></div>
      </dl>
      {picks.length > 0 && !keepsSomething && (
        <p className="form-error" role="alert">This bill must keep at least one item. To pay for everything, just pay the bill.</p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-lg" disabled={picks.length === 0 || !keepsSomething || busy} onClick={() => void create()}>
          Create new bill
        </button>
      </div>
    </Modal>
  );
}

function Picker({
  product,
  mods,
  onClose,
  onAdd,
}: {
  product: ProductWithStock;
  mods: Modifier[];
  onClose: () => void;
  onAdd: (modifierIds: string[], note: string, qty: number) => void;
}) {
  const { money } = useApp();
  const [chosen, setChosen] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [qty, setQty] = useState(1);
  const extra = mods.filter((m) => chosen.includes(m.id)).reduce((s, m) => s + m.priceMinor, 0);
  return (
    <Modal title={product.name} onClose={onClose}>
      <div className="mods">
        {mods.map((m) => (
          <label key={m.id} className="check">
            <input type="checkbox" checked={chosen.includes(m.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, m.id] : chosen.filter((x) => x !== m.id))} />
            {m.name}{m.priceMinor > 0 && <span className="muted"> +{money(m.priceMinor)}</span>}
          </label>
        ))}
      </div>
      <label className="field">Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. well done" /></label>
      <div className="stepper">
        <button className="btn" aria-label="Fewer" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
        <span className="qty">{qty}</span>
        <button className="btn" aria-label="More" onClick={() => setQty(qty + 1)}>+</button>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-lg" autoFocus onClick={() => onAdd(chosen, note, qty)}>
          Add {qty} · {money((product.priceMinor + extra) * qty)}
        </button>
      </div>
    </Modal>
  );
}

function CancelModal({ order, onClose, onCancelled }: { order: Order; onClose: () => void; onCancelled: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const inKitchen = order.items.some((i) => i.sent);
  const save = async () => {
    try {
      await api.cancelOrder(order.id, reason);
      await onCancelled();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Cancel order #${order.token}`} onClose={onClose}>
      {inKitchen && <p className="warn-box">Food for this order has already gone to the kitchen. Only a manager can cancel it.</p>}
      <label className="field">Reason<input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Back</button>
        <button className="btn btn-danger" onClick={() => void save()}>Cancel order</button>
      </div>
    </Modal>
  );
}
