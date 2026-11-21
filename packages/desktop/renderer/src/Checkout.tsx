import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { taxFor } from "@tillbase/core/money";
import type { Customer, LoyaltyConfig, PaymentInput, PaymentMethod } from "@tillbase/core";
import type { ProductWithStock } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { CustomerPicker } from "./CustomerPicker";
import { maxPoints, planPayment, pointsEarned, type BillLine } from "./loyalty";
import { minorToInput, parseMoney } from "./format";
import { Modal, ReceiptView } from "./Modal";
import { methodLabel, summarizePayments } from "./payments";

interface Line {
  product: ProductWithStock;
  qty: number;
  discountMinor: number;
}

function lineTotals(l: Line) {
  const gross = Math.round(l.qty * l.product.priceMinor);
  const net = Math.max(0, gross - l.discountMinor);
  const tax = taxFor(net, l.product.taxRateBp);
  return { gross, net, tax, total: net + tax };
}

export function Checkout({ onOpenShift }: { onOpenShift: () => void }) {
  const { money, toast, session, can } = useApp();
  const shiftOpen = session.shift !== null;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductWithStock[]>([]);
  const [cart, setCart] = useState<Line[]>([]);
  const [paying, setPaying] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [done, setDone] = useState<{ receipt: string; change: number; no: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refocus = useCallback(() => setTimeout(() => inputRef.current?.focus(), 0), []);

  // Live search (and the default product grid when the box is empty).
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .searchProducts(query)
        .then((r) => !cancelled && setResults(r.slice(0, 60)))
        .catch((e: Error) => toast(e.message, "error"));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, toast, done]);

  useEffect(() => {
    api.getLoyalty().then(setConfig).catch(() => undefined);
  }, []);

  const billLines = useMemo<BillLine[]>(
    () => cart.map((l) => ({ netMinor: lineTotals(l).net, taxRateBp: l.product.taxRateBp })),
    [cart],
  );

  const totals = useMemo(() => {
    let subtotal = 0;
    let discount = 0;
    let tax = 0;
    for (const l of cart) {
      const t = lineTotals(l);
      subtotal += t.gross;
      discount += l.discountMinor;
      tax += t.tax;
    }
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  }, [cart]);

  // The latest cart, readable from event handlers without stale closures.
  const cartRef = useRef<Line[]>(cart);
  cartRef.current = cart;

  const add = useCallback(
    (p: ProductWithStock, qty = 1) => {
      const inCart = cartRef.current.find((l) => l.product.id === p.id)?.qty ?? 0;
      if (p.trackStock && inCart + qty > p.stock) {
        toast(`Only ${p.stock} of ${p.name} in stock`, "error");
        return;
      }
      setCart((cur) => {
        const i = cur.findIndex((l) => l.product.id === p.id);
        const existing = i >= 0 ? cur[i] : undefined;
        if (existing) {
          const copy = [...cur];
          copy[i] = { ...existing, qty: existing.qty + qty };
          return copy;
        }
        return [...cur, { product: p, qty, discountMinor: 0 }];
      });
    },
    [toast],
  );

  const onEnter = async () => {
    const text = query.trim();
    if (!text) return;
    try {
      const byCode = await api.findByBarcode(text);
      if (byCode) {
        add(byCode);
        setQuery("");
      } else if (results.length === 1 && results[0]) {
        add(results[0]);
        setQuery("");
      } else if (results.length === 0) {
        toast(`No product found for "${text}"`, "error");
      }
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const setQty = (id: string, qty: number) => {
    const line = cart.find((l) => l.product.id === id);
    if (!line) return;
    if (qty > 0 && line.product.trackStock && qty > line.product.stock) {
      toast(`Only ${line.product.stock} of ${line.product.name} in stock`, "error");
      return;
    }
    setCart((cur) =>
      cur.flatMap((l) => (l.product.id !== id ? [l] : qty <= 0 ? [] : [{ ...l, qty }])),
    );
  };

  const setDiscount = (id: string, text: string) => {
    const minor = text.trim() === "" ? 0 : parseMoney(text);
    if (minor === null) return;
    setCart((cur) =>
      cur.map((l) => {
        if (l.product.id !== id) return l;
        const gross = Math.round(l.qty * l.product.priceMinor);
        return { ...l, discountMinor: Math.min(minor, gross) };
      }),
    );
  };

  const finish = async (payments: PaymentInput[], loyalty: { redeemPoints: number; walletMinor: number }) => {
    try {
      const { sale, receipt } = await api.checkout({
        lines: cart.map((l) => ({
          productId: l.product.id,
          qty: l.qty,
          discountMinor: l.discountMinor,
        })),
        payments,
        ...(customer ? { customerId: customer.id, redeemPoints: loyalty.redeemPoints, walletMinor: loyalty.walletMinor } : {}),
      });
      setCart([]);
      setCustomer(null);
      setPaying(false);
      setQuery("");
      setDone({ receipt, change: sale.changeMinor, no: sale.receiptNo });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="checkout">
      <section className="catalog">
        {!shiftOpen && (
          <div className="banner" role="alert">
            <span>No shift is open, so you cannot sell yet.</span>
            <button className="btn btn-primary" onClick={onOpenShift}>
              Open a shift
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          className="scan"
          autoFocus
          placeholder="Scan barcode or type a product name, then press Enter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onEnter();
          }}
          aria-label="Scan barcode or search products"
        />
        {results.length === 0 ? (
          <p className="empty">
            {query ? "No matching products." : "No products yet. Add some on the Products screen."}
          </p>
        ) : (
          <div className="tiles">
            {results.map((p) => {
              const out = p.trackStock && p.stock <= 0;
              return (
                <button
                  key={p.id}
                  className={`tile${out ? " tile-out" : ""}`}
                  onClick={() => {
                    add(p);
                    refocus();
                  }}
                >
                  <span className="tile-name">{p.name}</span>
                  <span className="tile-price">{money(p.priceMinor)}</span>
                  <span className="tile-stock">
                    {p.trackStock ? (out ? "Out of stock" : `${p.stock} in stock`) : "Service"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <aside className="cart" aria-label="Current sale">
        <h2>Current sale</h2>
        <CustomerBar
          customer={customer}
          earnHint={customer && config ? pointsEarned(totals.subtotal - totals.discount, config.spendPerPointMinor) : 0}
          onChoose={() => setChoosing(true)}
          onClear={() => setCustomer(null)}
        />
        <div className="cart-lines">
          {cart.length === 0 && <p className="empty">Scan or tap a product to begin.</p>}
          {cart.map((l) => {
            const t = lineTotals(l);
            return (
              <div className="cart-line" key={l.product.id}>
                <div className="cart-line-top">
                  <span className="cart-name">{l.product.name}</span>
                  <span className="cart-total">{money(t.total)}</span>
                </div>
                <div className="cart-line-bottom">
                  <div className="stepper">
                    <button
                      className="btn"
                      aria-label={`Decrease ${l.product.name}`}
                      onClick={() => setQty(l.product.id, l.qty - 1)}
                    >
                      −
                    </button>
                    <span className="qty">{l.qty}</span>
                    <button
                      className="btn"
                      aria-label={`Increase ${l.product.name}`}
                      onClick={() => setQty(l.product.id, l.qty + 1)}
                    >
                      +
                    </button>
                  </div>
                  <span className="muted">× {money(l.product.priceMinor)}</span>
                  {can("discount") && (
                    <label className="disc">
                      Disc
                      <input
                        inputMode="decimal"
                        defaultValue={l.discountMinor ? minorToInput(l.discountMinor) : ""}
                        placeholder="0.00"
                        onBlur={(e) => setDiscount(l.product.id, e.target.value)}
                        aria-label={`Discount for ${l.product.name}`}
                      />
                    </label>
                  )}
                  <button
                    className="btn btn-ghost"
                    aria-label={`Remove ${l.product.name}`}
                    onClick={() => setQty(l.product.id, 0)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <dl className="totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{money(totals.subtotal)}</dd>
          </div>
          {totals.discount > 0 && (
            <div>
              <dt>Discount</dt>
              <dd>−{money(totals.discount)}</dd>
            </div>
          )}
          {totals.tax > 0 && (
            <div>
              <dt>Tax</dt>
              <dd>{money(totals.tax)}</dd>
            </div>
          )}
          <div className="grand">
            <dt>Total</dt>
            <dd>{money(totals.total)}</dd>
          </div>
        </dl>

        <div className="cart-actions">
          <button
            className="btn"
            disabled={cart.length === 0}
            onClick={() => {
              setCart([]);
              refocus();
            }}
          >
            Clear
          </button>
          <button
            className="btn btn-primary btn-lg"
            disabled={cart.length === 0 || !shiftOpen}
            onClick={() => setPaying(true)}
          >
            Pay {cart.length > 0 ? money(totals.total) : ""}
          </button>
        </div>
      </aside>

      {choosing && (
        <CustomerPicker
          onClose={() => {
            setChoosing(false);
            refocus();
          }}
          onPick={(c) => {
            setCustomer(c);
            setChoosing(false);
            refocus();
          }}
        />
      )}

      {paying && (
        <PayModal
          lines={billLines}
          extraMinor={0}
          customer={customer}
          config={config}
          onClose={() => {
            setPaying(false);
            refocus();
          }}
          onConfirm={finish}
        />
      )}

      {done && (
        <Modal
          title={`Sale complete · ${done.no}`}
          onClose={() => {
            setDone(null);
            refocus();
          }}
        >
          {done.change > 0 && (
            <p className="change-due">
              Change due: <strong>{money(done.change)}</strong>
            </p>
          )}
          <ReceiptView text={done.receipt} />
          <div className="modal-actions">
            <button className="btn" onClick={() => window.print()}>
              Print receipt
            </button>
            <button
              className="btn btn-primary"
              autoFocus
              onClick={() => {
                setDone(null);
                refocus();
              }}
            >
              New sale
            </button>
          </div>
          <pre id="print-area">{done.receipt}</pre>
        </Modal>
      )}
    </div>
  );
}

/**
 * Take payment. The common case stays fast: one method, exact cash or card is a single tap
 * (the amount is already filled in, and Enter completes). "Split payment" opens the longer view,
 * where cash, card and other can be added one by one until nothing remains.
 */
function PayInner({
  total,
  header,
  blocked,
  onClose,
  onConfirm,
}: {
  total: number;
  header: ReactNode;
  /** True while something above (such as the points entered) is wrong, so the sale cannot be completed. */
  blocked: boolean;
  onClose: () => void;
  onConfirm: (payments: PaymentInput[]) => Promise<void>;
}) {
  const { money } = useApp();
  const [split, setSplit] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [text, setText] = useState(minorToInput(total));
  const [added, setAdded] = useState<PaymentInput[]>([]);
  const [busy, setBusy] = useState(false);

  // Using points or the wallet changes what is left to pay: start the amounts again from the new figure.
  const lastTotal = useRef(total);
  useEffect(() => {
    if (lastTotal.current === total) return;
    lastTotal.current = total;
    setText(minorToInput(total));
    setAdded([]);
    setSplit(false);
    setMethod("cash");
  }, [total]);

  // ---- one payment ----
  const tendered = method === "cash" ? parseMoney(text) : total;
  const short = tendered !== null && tendered < total;
  const valid = tendered !== null && !short;
  const change = valid && method === "cash" ? tendered - total : 0;

  const quick = useMemo(() => {
    const steps = [5, 10, 20, 50, 100, 500, 1000, 5000].map((n) => n * 100);
    const above = steps.filter((s) => s >= total);
    const next = above.slice(0, 3);
    return [total, ...next.filter((n) => n !== total)];
  }, [total]);

  // ---- several payments ----
  const summary = summarizePayments(total, added);
  const amount = parseMoney(text);
  const canAdd = amount !== null && amount > 0 && summary.remainingMinor > 0;

  const send = async (payments: PaymentInput[]) => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm(payments);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (blocked) return;
    if (split) {
      if (summary.ok) await send(added);
      return;
    }
    if (total === 0) {
      await send([]);
      return;
    }
    if (!valid || tendered === null) return;
    await send([{ method, amountMinor: tendered }]);
  };

  const startSplit = () => {
    setSplit(true);
    setMethod("cash");
    setText(minorToInput(total));
  };
  const backToOne = () => {
    setSplit(false);
    setAdded([]);
    setMethod("cash");
    setText(minorToInput(total));
  };
  const addPayment = () => {
    if (!canAdd || amount === null) return;
    const next = [...added, { method, amountMinor: amount }];
    setAdded(next);
    const left = summarizePayments(total, next).remainingMinor;
    setText(left > 0 ? minorToInput(left) : "");
  };
  const removePayment = (index: number) => {
    const next = added.filter((_, i) => i !== index);
    setAdded(next);
    const left = summarizePayments(total, next).remainingMinor;
    setText(left > 0 ? minorToInput(left) : "");
  };

  const methodButtons = (
    <div className="methods" role="group" aria-label="Payment method">
      {(["cash", "card", "other"] as const).map((m) => (
        <button
          key={m}
          className={`btn btn-lg${method === m ? " btn-primary" : ""}`}
          aria-pressed={method === m}
          onClick={() => {
            setMethod(m);
            if (split && m !== method) setText(summary.remainingMinor > 0 ? minorToInput(summary.remainingMinor) : "");
          }}
        >
          {methodLabel[m]}
        </button>
      ))}
    </div>
  );

  if (split) {
    return (
      <Modal title={`Split payment · ${money(total)}`} onClose={onClose}>
        {header}
        <dl className="split-summary">
          <div>
            <dt>Total</dt>
            <dd>{money(total)}</dd>
          </div>
          <div>
            <dt>Paid so far</dt>
            <dd>{money(summary.paidMinor)}</dd>
          </div>
          <div className={summary.problem ? "split-problem" : summary.remainingMinor > 0 ? "split-remaining" : "split-covered"}>
            <dt>Remaining</dt>
            <dd>{money(summary.remainingMinor)}</dd>
          </div>
        </dl>

        {added.length > 0 && (
          <ul className="split-list" aria-label="Payments added">
            {added.map((p, i) => (
              <li key={i}>
                <span>{methodLabel[p.method]}</span>
                <strong>{money(p.amountMinor)}</strong>
                <button className="btn btn-ghost" aria-label={`Remove ${methodLabel[p.method]} payment of ${money(p.amountMinor)}`} onClick={() => removePayment(i)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {summary.remainingMinor > 0 && (
          <>
            {methodButtons}
            <label className="field">
              Amount
              <input
                autoFocus
                inputMode="decimal"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPayment();
                }}
              />
            </label>
            <div className="quick">
              <button className="btn" disabled={!canAdd} onClick={addPayment}>
                Add {methodLabel[method].toLowerCase()} payment
              </button>
            </div>
          </>
        )}

        <p className={`pay-status${summary.problem ? " bad" : ""}`} role={summary.problem ? "alert" : undefined}>
          {summary.problem ??
            (summary.remainingMinor > 0
              ? amount === null && text.trim() !== ""
                ? "Enter a valid amount"
                : `Still to pay: ${money(summary.remainingMinor)}`
              : summary.changeMinor > 0
                ? `Covered. Change due: ${money(summary.changeMinor)}`
                : "Covered. Ready to complete.")}
        </p>

        <div className="modal-actions">
          <button className="btn" onClick={backToOne}>
            Single payment
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-lg" disabled={!summary.ok || busy || blocked} onClick={() => void submit()}>
            Complete sale
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Take payment · ${money(total)}`} onClose={onClose}>
      {header}
      {total === 0 ? (
        <p className="pay-status">Nothing left to pay. Points and wallet cover the whole bill.</p>
      ) : (
        methodButtons
      )}

      {total === 0 ? null : method === "cash" ? (
        <>
          <label className="field">
            Amount received
            <input
              autoFocus
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </label>
          <div className="quick">
            {quick.map((q) => (
              <button key={q} className="btn" onClick={() => setText(minorToInput(q))}>
                {q === total ? "Exact" : money(q)}
              </button>
            ))}
          </div>
          <p className={`pay-status${short || tendered === null ? " bad" : ""}`}>
            {tendered === null
              ? "Enter a valid amount"
              : short
                ? `Short by ${money(total - tendered)}`
                : `Change due: ${money(change)}`}
          </p>
        </>
      ) : (
        <p className="muted">
          {method === "card"
            ? `Charge ${money(total)} on the card terminal, then confirm.`
            : `Record ${money(total)} as paid by another method, then confirm.`}
        </p>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {total > 0 && (
          <button className="btn" onClick={startSplit}>
            Split payment
          </button>
        )}
        <button className="btn btn-primary btn-lg" disabled={(total > 0 && !valid) || busy || blocked} onClick={() => void submit()}>
          {total === 0 || method === "cash" ? "Complete sale" : method === "card" ? "Card approved — complete sale" : "Complete sale"}
        </button>
      </div>
    </Modal>
  );
}

/** The customer on the current sale: who they are, what they have, and what this sale will earn. */
export function CustomerBar({
  customer,
  earnHint,
  onChoose,
  onClear,
}: {
  customer: Customer | { name: string; phone: string | null; points: number; walletMinor: number } | null;
  earnHint: number;
  onChoose: () => void;
  onClear: () => void;
}) {
  const { money } = useApp();
  if (!customer) {
    return (
      <button className="btn customer-add" onClick={onChoose}>
        + Add customer
      </button>
    );
  }
  return (
    <div className="customer-chip" aria-label="Customer on this sale">
      <div>
        <strong>{customer.name}</strong>
        <span className="muted small">
          {customer.points} point{customer.points === 1 ? "" : "s"}
          {customer.walletMinor > 0 ? ` · wallet ${money(customer.walletMinor)}` : ""}
          {earnHint > 0 ? ` · earns ${earnHint}` : ""}
        </span>
      </div>
      <button className="btn btn-ghost" aria-label={`Remove customer ${customer.name}`} onClick={onClear}>
        ✕
      </button>
    </div>
  );
}

/**
 * Take payment for a bill. If a customer is on the sale, they can use points as a discount and
 * spend their wallet first; the person then pays only what is left.
 */
export function PayModal({
  lines,
  extraMinor,
  customer,
  config,
  onClose,
  onConfirm,
}: {
  lines: BillLine[];
  /** Untaxed charges that points cannot reduce, such as a delivery fee. */
  extraMinor: number;
  customer: Customer | { name: string; points: number; walletMinor: number } | null;
  config: LoyaltyConfig | null;
  onClose: () => void;
  onConfirm: (payments: PaymentInput[], loyalty: { redeemPoints: number; walletMinor: number }) => Promise<void>;
}) {
  const { money } = useApp();
  const value = config?.pointValueMinor ?? 0;
  const items = lines.reduce((s, l) => s + l.netMinor, 0);
  const most = customer ? maxPoints(customer.points, items, value) : 0;
  const [pointsText, setPointsText] = useState("");
  const [useWallet, setUseWallet] = useState(false);

  const typed = pointsText.trim() === "" ? 0 : Number(pointsText);
  const pointsValid = Number.isInteger(typed) && typed >= 0 && typed <= most;
  const redeem = pointsValid ? typed : 0;
  const plan = planPayment({
    lines,
    extraMinor,
    redeemPoints: redeem,
    pointValueMinor: value,
    useWallet,
    walletBalanceMinor: customer?.walletMinor ?? 0,
  });

  const pointsProblem = pointsValid
    ? null
    : !Number.isInteger(typed) || typed < 0
      ? "Enter a whole number of points"
      : customer && typed > customer.points
        ? `${customer.name} only has ${customer.points} point${customer.points === 1 ? "" : "s"}`
        : `Points can only pay for the items. The most here is ${most}`;

  const showLoyalty = !!customer && (most > 0 || customer.walletMinor > 0);
  const header = showLoyalty && customer && (
    <div className="loyalty-box" aria-label="Points and wallet">
      <p>
        <strong>{customer.name}</strong>
        <span className="muted small">
          {" "}· {customer.points} point{customer.points === 1 ? "" : "s"}
          {customer.walletMinor > 0 ? ` · wallet ${money(customer.walletMinor)}` : ""}
        </span>
      </p>
      {most > 0 && (
        <div className="loyalty-row">
          <label className="field">
            Points to use (up to {most}, {money(value)} each)
            <input
              inputMode="numeric"
              value={pointsText}
              placeholder="0"
              onChange={(e) => setPointsText(e.target.value)}
              aria-invalid={!pointsValid}
            />
          </label>
          <button className="btn" onClick={() => setPointsText(String(most))}>
            Use {most}
          </button>
        </div>
      )}
      {pointsProblem && (
        <p className="form-error" role="alert">
          {pointsProblem}
        </p>
      )}
      {customer.walletMinor > 0 && (
        <label className="check">
          <input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
          Use wallet ({money(Math.min(customer.walletMinor, plan.payableMinor))} of {money(customer.walletMinor)})
        </label>
      )}
      {(plan.discountMinor > 0 || plan.walletMinor > 0) && (
        <p className="muted small">
          {plan.discountMinor > 0 && `Points take ${money(plan.discountMinor)} off. `}
          {plan.walletMinor > 0 && `Wallet pays ${money(plan.walletMinor)}. `}
          Bill {money(plan.payableMinor)}, still to pay {money(plan.dueMinor)}.
        </p>
      )}
    </div>
  );

  return (
    <PayInner
      total={plan.dueMinor}
      header={header}
      blocked={!pointsValid}
      onClose={onClose}
      onConfirm={async (payments) => {
        await onConfirm(payments, { redeemPoints: redeem, walletMinor: plan.walletMinor });
      }}
    />
  );
}
