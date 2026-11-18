import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { taxFor } from "@tillbase/core/money";
import type { PaymentMethod } from "@tillbase/core";
import type { ProductWithStock } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { minorToInput, parseMoney } from "./format";
import { Modal, ReceiptView } from "./Modal";

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

export function Checkout() {
  const { money, toast } = useApp();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductWithStock[]>([]);
  const [cart, setCart] = useState<Line[]>([]);
  const [paying, setPaying] = useState(false);
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

  const finish = async (method: PaymentMethod, tendered: number) => {
    try {
      const { sale, receipt } = await api.checkout({
        lines: cart.map((l) => ({
          productId: l.product.id,
          qty: l.qty,
          discountMinor: l.discountMinor,
        })),
        payments: [{ method, amountMinor: tendered }],
      });
      setCart([]);
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
            disabled={cart.length === 0}
            onClick={() => setPaying(true)}
          >
            Pay {cart.length > 0 ? money(totals.total) : ""}
          </button>
        </div>
      </aside>

      {paying && (
        <PayModal
          total={totals.total}
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

function PayModal({
  total,
  onClose,
  onConfirm,
}: {
  total: number;
  onClose: () => void;
  onConfirm: (method: PaymentMethod, tendered: number) => Promise<void>;
}) {
  const { money } = useApp();
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [text, setText] = useState(minorToInput(total));
  const [busy, setBusy] = useState(false);

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

  const submit = async () => {
    if (!valid || tendered === null || busy) return;
    setBusy(true);
    try {
      await onConfirm(method, tendered);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Take payment · ${money(total)}`} onClose={onClose}>
      <div className="methods" role="group" aria-label="Payment method">
        {(["cash", "card"] as const).map((m) => (
          <button
            key={m}
            className={`btn btn-lg${method === m ? " btn-primary" : ""}`}
            aria-pressed={method === m}
            onClick={() => setMethod(m)}
          >
            {m === "cash" ? "Cash" : "Card"}
          </button>
        ))}
      </div>

      {method === "cash" ? (
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
        <p className="muted">Charge {money(total)} on the card terminal, then confirm.</p>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary btn-lg" disabled={!valid || busy} onClick={() => void submit()}>
          {method === "cash" ? "Complete sale" : "Card approved — complete sale"}
        </button>
      </div>
    </Modal>
  );
}
