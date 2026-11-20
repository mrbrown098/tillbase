import { useCallback, useEffect, useState } from "react";
import type { Expense, ExpenseCategory } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { isoDay, parseMoney, periods } from "./format";
import { Modal } from "./Modal";

export function Costs() {
  const { money, toast, session } = useApp();
  const [range, setRange] = useState(periods.month());
  const [list, setList] = useState<Expense[]>([]);
  const [cats, setCats] = useState<ExpenseCategory[]>([]);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<Expense | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.listExpenses(range.from, range.to));
      setCats(await api.expenseCategories());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [range, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const total = list.filter((e) => !e.voided).reduce((s, e) => s + e.amountMinor, 0);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Running costs</h1>
        <div className="presets">
          <button className="btn" onClick={() => setRange(periods.month())}>This month</button>
          <button className="btn" onClick={() => setRange(periods.lastMonth())}>Last month</button>
          <input type="date" value={range.from} aria-label="From" onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <input type="date" value={range.to} aria-label="To" onChange={(e) => setRange({ ...range, to: e.target.value })} />
          <button className="btn btn-primary" onClick={() => setAdding(true)}>Add a cost</button>
        </div>
      </div>
      <p className="muted">Rent, electricity, gas, packaging, repairs: everything you pay besides ingredients and wages. Total in this period: <strong>{money(total)}</strong></p>
      <table className="table">
        <thead><tr><th>Date</th><th>Category</th><th>What for</th><th className="num">Amount</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {list.map((e) => (
            <tr key={e.id} className={e.voided ? "inactive" : ""}>
              <td>{e.spentOn}</td>
              <td>{e.category}</td>
              <td>{e.description}{e.voided && <span className="badge">cancelled: {e.voidReason}</span>}</td>
              <td className="num">{money(e.amountMinor)}</td>
              <td className="actions">{!e.voided && <button className="btn" onClick={() => setVoiding(e)}>Cancel</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p className="empty">No costs recorded in this period.</p>}
      {adding && <CostForm cats={cats} hasShift={!!session.shift} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void load(); }} />}
      {voiding && <VoidForm expense={voiding} onClose={() => setVoiding(null)} onSaved={() => { setVoiding(null); void load(); }} />}
    </div>
  );
}

function CostForm({ cats, hasShift, onClose, onSaved }: { cats: ExpenseCategory[]; hasShift: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [categoryId, setCategoryId] = useState(cats[0]?.id ?? "");
  const [newCat, setNewCat] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(isoDay());
  const [method, setMethod] = useState<"cash" | "card" | "other">("cash");
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    const amountMinor = parseMoney(amount);
    if (amountMinor === null || amountMinor <= 0) return setError("Enter the amount, e.g. 2500");
    try {
      let cid = categoryId;
      if (newCat.trim()) cid = (await api.addExpenseCategory(newCat)).id;
      await api.addExpense({ categoryId: cid, description, amountMinor, spentOn: date, method }, drawer);
      toast("Cost recorded");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Add a cost" onClose={onClose}>
      <label className="field">Category
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="field">…or a new category<input value={newCat} onChange={(e) => setNewCat(e.target.value)} /></label>
      <label className="field">What for<input autoFocus value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="field">Amount<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field">Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label className="field">Paid by
        <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="cash">Cash</option><option value="card">Card / bank</option><option value="other">Other</option>
        </select>
      </label>
      {method === "cash" && (
        <label className="check"><input type="checkbox" checked={drawer} disabled={!hasShift} onChange={(e) => setDrawer(e.target.checked)} />Took the cash from the till drawer{!hasShift && " (open a shift first)"}</label>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

function VoidForm({ expense, onClose, onSaved }: { expense: Expense; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await api.voidExpense(expense.id, reason);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Cancel this cost" onClose={onClose}>
      <p className="muted">{expense.description}. It stays on record but stops counting.</p>
      <label className="field">Reason<input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Back</button>
        <button className="btn btn-danger" onClick={() => void save()}>Cancel cost</button>
      </div>
    </Modal>
  );
}
