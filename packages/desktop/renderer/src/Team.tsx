import { useCallback, useEffect, useState } from "react";
import type { Employee, Payslip, PayrollPreviewLine } from "@tillbase/core";
import type { RosterEntry } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { isoDay, minorToInput, parseMoney, periods } from "./format";
import { Modal } from "./Modal";

const payLabel = { monthly: "per month", daily: "per day", hourly: "per hour" } as const;
const hm = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function Team() {
  const { can } = useApp();
  const [tab, setTab] = useState<"attendance" | "people" | "payroll">("attendance");
  return (
    <div className="page">
      <div className="page-head">
        <h1>Team and wages</h1>
        <div className="seg">
          <button className={tab === "attendance" ? "on" : ""} onClick={() => setTab("attendance")}>Attendance</button>
          {can("labour.manage") && <button className={tab === "people" ? "on" : ""} onClick={() => setTab("people")}>Employees</button>}
          {can("labour.manage") && <button className={tab === "payroll" ? "on" : ""} onClick={() => setTab("payroll")}>Payroll</button>}
        </div>
      </div>
      {tab === "attendance" && <Attendance />}
      {tab === "people" && <People />}
      {tab === "payroll" && <Payroll />}
    </div>
  );
}

function Attendance() {
  const { toast } = useApp();
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [today, setToday] = useState<Awaited<ReturnType<typeof api.attendance>>>([]);
  const load = useCallback(async () => {
    try {
      setRoster(await api.roster());
      setToday(await api.attendance(isoDay(), isoDay()));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (e: RosterEntry) => {
    try {
      if (e.clockedIn) await api.clockOut(e.id);
      else await api.clockIn(e.id);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <>
      <p className="muted">Tap to clock people in and out. Their hours become wages in your profit figures.</p>
      <table className="table">
        <thead><tr><th>Name</th><th>Status</th><th aria-label="Action" /></tr></thead>
        <tbody>
          {roster.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.clockedIn ? <span className="good">In since {clock(r.since!)}</span> : <span className="muted">Out</span>}</td>
              <td className="actions"><button className={`btn ${r.clockedIn ? "" : "btn-primary"}`} onClick={() => void act(r)}>{r.clockedIn ? "Clock out" : "Clock in"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {roster.length === 0 && <p className="empty">No employees yet. The owner adds them under Employees.</p>}
      {today.length > 0 && (
        <section className="panel">
          <h2>Today</h2>
          <ul className="legend">
            {today.map((a) => (
              <li key={a.id}>
                <span>{a.employeeName}</span>
                <span>{clock(a.clockIn)} – {a.clockOut ? clock(a.clockOut) : "now"} {a.minutes !== null && <span className="muted">· {hm(a.minutes)}</span>}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function People() {
  const { money, toast, session } = useApp();
  const [list, setList] = useState<Employee[]>([]);
  const [editing, setEditing] = useState<Employee | "new" | null>(null);
  const [advance, setAdvance] = useState<Employee | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await api.listEmployees(true));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <div className="row"><button className="btn btn-primary" onClick={() => setEditing("new")}>Add employee</button></div>
      <table className="table">
        <thead><tr><th>Name</th><th>Role</th><th className="num">Pay</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {list.map((e) => (
            <tr key={e.id} className={e.active ? "" : "inactive"}>
              <td>{e.name}{!e.active && <span className="badge">left</span>}</td>
              <td>{e.title ?? "—"}</td>
              <td className="num">{money(e.payRateMinor)} {payLabel[e.payType]}</td>
              <td className="actions">
                <button className="btn" onClick={() => setAdvance(e)}>Advance</button>
                <button className="btn" onClick={() => setEditing(e)}>Edit</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <EmployeeForm employee={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {advance && <AdvanceForm employee={advance} hasShift={!!session.shift} onClose={() => setAdvance(null)} />}
    </>
  );
}

function EmployeeForm({ employee, onClose, onSaved }: { employee: Employee | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [name, setName] = useState(employee?.name ?? "");
  const [title, setTitle] = useState(employee?.title ?? "");
  const [phone, setPhone] = useState(employee?.phone ?? "");
  const [payType, setPayType] = useState(employee?.payType ?? "monthly");
  const [rate, setRate] = useState(employee ? minorToInput(employee.payRateMinor) : "");
  const [otHours, setOtHours] = useState(employee ? String(employee.overtimeAfterMinutes / 60) : "0");
  const [otMult, setOtMult] = useState(employee ? String(employee.overtimeMultiplierBp / 10000) : "1.5");
  const [active, setActive] = useState(employee?.active ?? true);
  const [error, setError] = useState("");
  const save = async () => {
    const payRateMinor = parseMoney(rate);
    const h = Number(otHours);
    const m = Number(otMult);
    if (payRateMinor === null) return setError("Enter the pay rate, e.g. 30000");
    if (!(h >= 0) || !(m >= 1)) return setError("Overtime hours must be 0 or more and the multiplier at least 1");
    const fields = { name, title: title || null, phone: phone || null, payType, payRateMinor, overtimeAfterMinutes: Math.round(h * 60), overtimeMultiplierBp: Math.round(m * 10000) };
    try {
      if (employee) await api.updateEmployee(employee.id, { ...fields, active });
      else await api.createEmployee(fields);
      toast("Saved");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={employee ? "Edit employee" : "Add employee"} onClose={onClose} wide>
      <div className="form-grid">
        <label className="field span2">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Job title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        <label className="field">Paid
          <select value={payType} onChange={(e) => setPayType(e.target.value as typeof payType)}>
            <option value="monthly">A monthly salary</option><option value="daily">A daily wage</option><option value="hourly">By the hour</option>
          </select>
        </label>
        <label className="field">Rate ({payLabel[payType]})<input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
        {payType !== "monthly" && (
          <>
            <label className="field">Overtime after (hours a day, 0 = none)<input inputMode="decimal" value={otHours} onChange={(e) => setOtHours(e.target.value)} /></label>
            <label className="field">Overtime pays (× normal rate)<input inputMode="decimal" value={otMult} onChange={(e) => setOtMult(e.target.value)} /></label>
          </>
        )}
        {employee && <label className="check span2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Still works here</label>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

function AdvanceForm({ employee, hasShift, onClose }: { employee: Employee; hasShift: boolean; onClose: () => void }) {
  const { toast } = useApp();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    const a = parseMoney(amount);
    if (a === null || a <= 0) return setError("Enter an amount");
    try {
      await api.giveAdvance(employee.id, a, note || undefined, drawer);
      toast("Advance recorded. It will be offered for recovery at the next payroll");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Advance for ${employee.name}`} onClose={onClose}>
      <label className="field">Amount<input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="field">Note<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={drawer} disabled={!hasShift} onChange={(e) => setDrawer(e.target.checked)} />Took the cash from the till drawer{!hasShift && " (open a shift first)"}</label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()}>Give advance</button>
      </div>
    </Modal>
  );
}

function Payroll() {
  const { money, toast, session } = useApp();
  const [range, setRange] = useState(periods.lastMonth());
  const [preview, setPreview] = useState<PayrollPreviewLine[]>([]);
  const [adj, setAdj] = useState<Record<string, { bonus: string; ded: string; rec: string }>>({});
  const [slips, setSlips] = useState<Payslip[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setPreview(await api.payrollPreview(range.from, range.to));
      setSlips(await api.payslips());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [range]);
  useEffect(() => {
    void load();
  }, [load]);

  const val = (id: string, k: "bonus" | "ded" | "rec") => adj[id]?.[k] ?? "";
  const setVal = (id: string, k: "bonus" | "ded" | "rec", v: string) =>
    setAdj({ ...adj, [id]: { bonus: val(id, "bonus"), ded: val(id, "ded"), rec: val(id, "rec"), [k]: v } });
  const num = (t: string) => (t.trim() === "" ? 0 : (parseMoney(t) ?? NaN));

  const lines = preview.filter((p) => p.grossMinor > 0 && !p.alreadyPaid);
  const net = (p: PayrollPreviewLine) => p.grossMinor + num(val(p.employeeId, "bonus")) - num(val(p.employeeId, "ded")) - num(val(p.employeeId, "rec"));

  const run = async () => {
    const out = lines.map((p) => ({
      employeeId: p.employeeId,
      bonusMinor: num(val(p.employeeId, "bonus")),
      deductionsMinor: num(val(p.employeeId, "ded")),
      recoverAdvanceMinor: num(val(p.employeeId, "rec")),
    }));
    if (out.some((l) => Number.isNaN(l.bonusMinor + l.deductionsMinor + l.recoverAdvanceMinor))) return setError("Check the amounts you typed");
    try {
      await api.runPayroll(range.from, range.to, out);
      toast("Payroll saved. Now pay each person below");
      setAdj({});
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pay = async (s: Payslip, drawer: boolean) => {
    try {
      await api.payPayslip(s.id, "cash", drawer);
      toast(`${s.employeeName} paid`);
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <>
      <div className="presets">
        <button className="btn" onClick={() => setRange(periods.lastMonth())}>Last month</button>
        <button className="btn" onClick={() => setRange(periods.month())}>This month</button>
        <button className="btn" onClick={() => setRange(periods.week())}>Last 7 days</button>
        <input type="date" value={range.from} aria-label="From" onChange={(e) => setRange({ ...range, from: e.target.value })} />
        <input type="date" value={range.to} aria-label="To" onChange={(e) => setRange({ ...range, to: e.target.value })} />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <table className="table">
        <thead>
          <tr><th>Name</th><th className="num">Worked</th><th className="num">Earned</th><th className="num">Bonus</th><th className="num">Deduct</th><th className="num">Take back advance</th><th className="num">Take home</th></tr>
        </thead>
        <tbody>
          {preview.map((p) => (
            <tr key={p.employeeId} className={p.alreadyPaid ? "inactive" : ""}>
              <td>{p.name}{p.stillClockedIn && <span className="badge badge-warn">still clocked in</span>}{p.alreadyPaid && <span className="badge">already paid</span>}</td>
              <td className="num">{p.payType === "monthly" ? "salary" : `${p.days} days · ${hm(p.minutes)}`}</td>
              <td className="num">{money(p.grossMinor)}</td>
              {p.grossMinor > 0 && !p.alreadyPaid ? (
                <>
                  <td className="num"><input className="qty-input" inputMode="decimal" value={val(p.employeeId, "bonus")} onChange={(e) => setVal(p.employeeId, "bonus", e.target.value)} /></td>
                  <td className="num"><input className="qty-input" inputMode="decimal" value={val(p.employeeId, "ded")} onChange={(e) => setVal(p.employeeId, "ded", e.target.value)} /></td>
                  <td className="num">
                    <input className="qty-input" inputMode="decimal" value={val(p.employeeId, "rec")} onChange={(e) => setVal(p.employeeId, "rec", e.target.value)} placeholder={p.outstandingAdvanceMinor ? minorToInput(p.outstandingAdvanceMinor) : "0"} />
                    {p.outstandingAdvanceMinor > 0 && <div className="muted">owes {money(p.outstandingAdvanceMinor)}</div>}
                  </td>
                  <td className="num"><strong className={net(p) < 0 ? "bad-text" : ""}>{Number.isNaN(net(p)) ? "?" : money(net(p))}</strong></td>
                </>
              ) : (<td colSpan={4} />)}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={lines.length === 0} onClick={() => void run()}>Save payroll for these dates</button>
      </div>

      <section className="panel">
        <h2>Payslips</h2>
        <table className="table">
          <thead><tr><th>Period</th><th>Name</th><th className="num">Take home</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {slips.map((s) => (
              <tr key={s.id}>
                <td>{s.periodStart} to {s.periodEnd}</td>
                <td>{s.employeeName}</td>
                <td className="num">{money(s.netMinor)}</td>
                <td className="actions">
                  {s.paidAt ? <span className="good">Paid</span> : (
                    <>
                      <button className="btn" onClick={() => void pay(s, false)}>Mark paid</button>
                      <button className="btn" disabled={!session.shift} title={session.shift ? "" : "Open a shift first"} onClick={() => void pay(s, true)}>Pay from drawer</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {slips.length === 0 && <p className="empty">No payslips yet.</p>}
      </section>
    </>
  );
}
