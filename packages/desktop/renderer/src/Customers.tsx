import { useCallback, useEffect, useState } from "react";
import type { Customer, CustomerHistory, LedgerEntry, LoyaltyConfig } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { formatDateTime, minorToInput, parseMoney } from "./format";
import { Modal } from "./Modal";

const reasonLabel: Record<LedgerEntry["reason"], string> = {
  earn: "Earned on a sale",
  redeem: "Used on a sale",
  spend: "Spent on a sale",
  topup: "Wallet top-up",
  adjust: "Manager correction",
  void_earn: "Points taken back (sale voided)",
  void_redeem: "Points returned (sale voided)",
  void_spend: "Wallet money returned (sale voided)",
};

type Dialog = "new" | "edit" | "points" | "wallet" | "topup" | "rates" | null;

/** Customers: find them, see what they bought, and look after their points and wallet. */
export function Customers() {
  const { money, toast, can } = useApp();
  const manage = can("customers.manage");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<Customer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [history, setHistory] = useState<CustomerHistory | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const loadList = useCallback(() => {
    api.searchCustomers(query).then(setList).catch((e: Error) => toast(e.message, "error"));
  }, [query, toast]);

  useEffect(() => {
    const t = setTimeout(loadList, 150);
    return () => clearTimeout(t);
  }, [loadList]);

  useEffect(() => {
    api.getLoyalty().then(setConfig).catch(() => undefined);
  }, [dialog]);

  const loadOne = useCallback(
    async (id: string) => {
      try {
        const c = await api.getCustomer(id);
        setSelected(c);
        if (manage) {
          const [h, l] = await Promise.all([api.customerHistory(id), api.customerLedger(id)]);
          setHistory(h);
          setLedger(l);
        }
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },
    [manage, toast],
  );

  useEffect(() => {
    if (selectedId) void loadOne(selectedId);
    else {
      setSelected(null);
      setHistory(null);
      setLedger([]);
    }
  }, [selectedId, loadOne]);

  const changed = async (c: Customer) => {
    setDialog(null);
    setSelectedId(c.id);
    await loadOne(c.id);
    loadList();
  };

  return (
    <div className="page customers-page">
      <div className="page-head">
        <h1>Customers</h1>
        <div className="page-actions">
          {manage && config && (
            <button className="btn" onClick={() => setDialog("rates")}>
              Points settings
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setDialog("new")}>
            + New customer
          </button>
        </div>
      </div>

      <div className="customers-grid">
        <section className="panel customers-list">
          <input
            className="scan"
            placeholder="Phone or name"
            aria-label="Search customers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {list.length === 0 ? (
            <p className="empty">{query.trim() ? `Nobody found for “${query.trim()}”.` : "No customers yet. Add the first one with “New customer”."}</p>
          ) : (
            <ul className="customer-results" aria-label="Customers">
              {list.map((c) => (
                <li key={c.id}>
                  <button className={`customer-result${c.id === selectedId ? " on" : ""}`} aria-pressed={c.id === selectedId} onClick={() => setSelectedId(c.id)}>
                    <span className="customer-name">{c.name}</span>
                    <span className="muted small">{c.phone ?? "No phone"}</span>
                    <span className="customer-points">{c.points} pts</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="customers-detail" aria-label="Customer details">
          {!selected ? (
            <p className="empty">Choose a customer to see their points, wallet and past orders.</p>
          ) : (
            <>
              <div className="panel">
                <div className="customer-title">
                  <div>
                    <h2>{selected.name}</h2>
                    <p className="muted">
                      {[selected.phone, selected.address].filter(Boolean).join(" · ") || "No phone or address saved"}
                    </p>
                    {selected.notes && <p className="small">Note: {selected.notes}</p>}
                  </div>
                  {manage && (
                    <button className="btn" onClick={() => setDialog("edit")}>
                      Edit
                    </button>
                  )}
                </div>
                <div className="stats">
                  <div className="stat">
                    <span className="stat-label">Points</span>
                    <span className="stat-value">{selected.points}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Wallet</span>
                    <span className="stat-value">{money(selected.walletMinor)}</span>
                  </div>
                  {history && (
                    <>
                      <div className="stat">
                        <span className="stat-label">Visits</span>
                        <span className="stat-value">{history.visitCount}</span>
                      </div>
                      {history.totalSpentMinor !== null && (
                        <div className="stat">
                          <span className="stat-label">Total spent</span>
                          <span className="stat-value">{money(history.totalSpentMinor)}</span>
                        </div>
                      )}
                      <div className="stat">
                        <span className="stat-label">Last visit</span>
                        <span className="stat-value stat-small">{history.lastVisit ? formatDateTime(history.lastVisit) : "Never"}</span>
                      </div>
                    </>
                  )}
                </div>
                {manage && (
                  <div className="customer-actions">
                    <button className="btn" onClick={() => setDialog("topup")}>
                      Top up wallet
                    </button>
                    <button className="btn" onClick={() => setDialog("points")}>
                      Adjust points
                    </button>
                    <button className="btn" onClick={() => setDialog("wallet")}>
                      Correct wallet
                    </button>
                  </div>
                )}
              </div>

              {!manage && <p className="muted small">Past orders and corrections are shown to managers.</p>}

              {history && (
                <div className="panel">
                  <h2>Past orders</h2>
                  {history.visits.length === 0 ? (
                    <p className="empty">No orders yet.</p>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Receipt</th>
                          <th>When</th>
                          <th>Items</th>
                          <th className="num">Points</th>
                          <th className="num">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.visits.map((v) => (
                          <tr key={v.saleId} className={v.status === "void" ? "row-void" : undefined}>
                            <td>
                              {v.receiptNo}
                              {v.status === "void" && <span className="badge">voided</span>}
                            </td>
                            <td>{formatDateTime(v.createdAt)}</td>
                            <td className="cell-items">{v.items}</td>
                            <td className="num">{pointsCell(v.pointsEarned, v.pointsRedeemed)}</td>
                            <td className="num">{money(v.totalMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {manage && (
                <div className="panel">
                  <h2>Points and wallet history</h2>
                  {ledger.length === 0 ? (
                    <p className="empty">Nothing yet.</p>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>What happened</th>
                          <th className="num">Points</th>
                          <th className="num">Wallet</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledger.map((l) => (
                          <tr key={l.id}>
                            <td>{formatDateTime(l.createdAt)}</td>
                            <td>
                              {reasonLabel[l.reason]}
                              {l.receiptNo && <span className="muted small"> · {l.receiptNo}</span>}
                              {l.note && <span className="muted small"> · {l.note}</span>}
                            </td>
                            <td className="num">{l.account === "points" ? signed(l.delta) : ""}</td>
                            <td className="num">{l.account === "wallet" ? signedMoney(l.delta, money) : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {dialog === "new" && <CustomerForm title="New customer" onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog === "edit" && selected && <CustomerForm title="Edit customer" customer={selected} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog === "points" && selected && <AdjustPoints customer={selected} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog === "wallet" && selected && <AdjustWallet customer={selected} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog === "topup" && selected && <TopUp customer={selected} onClose={() => setDialog(null)} onSaved={changed} />}
      {dialog === "rates" && config && <Rates config={config} onClose={() => setDialog(null)} />}
    </div>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const signedMoney = (n: number, money: (m: number) => string) => (n > 0 ? `+${money(n)}` : `−${money(-n)}`);

function pointsCell(earned: number, used: number): string {
  const parts: string[] = [];
  if (used > 0) parts.push(`−${used}`);
  if (earned > 0) parts.push(`+${earned}`);
  return parts.join(" ") || "–";
}

type Done = (c: Customer) => void | Promise<void>;

function CustomerForm({ title, customer, onClose, onSaved }: { title: string; customer?: Customer; onClose: () => void; onSaved: Done }) {
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [address, setAddress] = useState(customer?.address ?? "");
  const [notes, setNotes] = useState(customer?.notes ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const input = { name, phone, address, notes };
      await onSaved(customer ? await api.updateCustomer(customer.id, input) : await api.createCustomer(input));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <label className="field">
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Phone
        <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
      <label className="field">
        Address (optional)
        <input value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      <label className="field">
        Notes (optional)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          {customer ? "Save" : "Add customer"}
        </button>
      </div>
    </Modal>
  );
}

function AdjustPoints({ customer, onClose, onSaved }: { customer: Customer; onClose: () => void; onSaved: Done }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isInteger(n) || n === 0) return setError("Enter a whole number of points, like 10 or -5");
    try {
      await onSaved(await api.adjustCustomerPoints(customer.id, n, note));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Adjust points · ${customer.name}`} onClose={onClose}>
      <p className="muted">Now {customer.points} point{customer.points === 1 ? "" : "s"}. Use a minus sign to take points away.</p>
      <label className="field">
        Points to add or remove
        <input autoFocus inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="field">
        Reason
        <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function AdjustWallet({ customer, onClose, onSaved }: { customer: Customer; onClose: () => void; onSaved: Done }) {
  const { money } = useApp();
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    const negative = text.trim().startsWith("-");
    const amount = parseMoney(text.trim().replace(/^[-+]/, ""));
    if (amount === null || amount === 0) return setError("Enter an amount like 50 or -20.50");
    try {
      await onSaved(await api.adjustCustomerWallet(customer.id, negative ? -amount : amount, note));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Correct wallet · ${customer.name}`} onClose={onClose}>
      <p className="muted">Wallet now {money(customer.walletMinor)}. This is for fixing mistakes. For money handed over, use “Top up wallet”.</p>
      <label className="field">
        Amount to add or remove
        <input autoFocus inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="-20.00" />
      </label>
      <label className="field">
        Reason
        <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function TopUp({ customer, onClose, onSaved }: { customer: Customer; onClose: () => void; onSaved: Done }) {
  const { money } = useApp();
  const [text, setText] = useState("");
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const amount = parseMoney(text);
  const save = async () => {
    if (busy) return;
    if (amount === null || amount <= 0) return setError("Enter the amount received, like 100 or 250.50");
    setBusy(true);
    try {
      await onSaved(await api.topUpWallet(customer.id, amount, method));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Top up wallet · ${customer.name}`} onClose={onClose}>
      <p className="muted">Wallet now {money(customer.walletMinor)}.</p>
      <div className="methods" role="group" aria-label="How they paid">
        {(["cash", "card"] as const).map((m) => (
          <button key={m} className={`btn btn-lg${method === m ? " btn-primary" : ""}`} aria-pressed={method === m} onClick={() => setMethod(m)}>
            {m === "cash" ? "Cash" : "Card"}
          </button>
        ))}
      </div>
      <label className="field">
        Amount received
        <input autoFocus inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} placeholder={minorToInput(0)} />
      </label>
      {method === "cash" && <p className="muted small">Cash goes into the drawer, so a shift must be open.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          Add {amount ? money(amount) : ""} to wallet
        </button>
      </div>
    </Modal>
  );
}

function Rates({ config, onClose }: { config: LoyaltyConfig; onClose: () => void }) {
  const { toast } = useApp();
  const [spend, setSpend] = useState(minorToInput(config.spendPerPointMinor));
  const [value, setValue] = useState(minorToInput(config.pointValueMinor));
  const [error, setError] = useState("");
  const save = async () => {
    const s = parseMoney(spend);
    const v = parseMoney(value);
    if (s === null) return setError("Spend for one point must be an amount like 100");
    if (v === null) return setError("Value of one point must be an amount like 1");
    try {
      await api.setLoyalty({ spendPerPointMinor: s, pointValueMinor: v });
      toast("Points settings saved");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Points settings" onClose={onClose}>
      <label className="field">
        Spend that earns 1 point (0 turns earning off)
        <input autoFocus inputMode="decimal" value={spend} onChange={(e) => setSpend(e.target.value)} />
      </label>
      <label className="field">
        Discount one point is worth (0 turns using points off)
        <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </label>
      <p className="muted small">Points are earned on the food and drinks after any discount, before tax. Delivery charges earn nothing and cannot be paid with points.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}
