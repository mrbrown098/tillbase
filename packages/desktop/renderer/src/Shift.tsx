import { useCallback, useEffect, useState } from "react";
import type { Shift } from "@tillbase/core";
import type { ShiftSummaryView } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { formatDateTime, minorToInput, parseMoney } from "./format";
import { Modal } from "./Modal";

export function ShiftScreen() {
  const { session, setSession, can, money, toast } = useApp();
  const [summary, setSummary] = useState<ShiftSummaryView | null>(null);
  const [history, setHistory] = useState<Shift[]>([]);
  const [movement, setMovement] = useState<"in" | "out" | null>(null);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<ShiftSummaryView | null>(null);
  const [float, setFloat] = useState("0.00");

  const load = useCallback(async () => {
    try {
      if (session.shift) setSummary(await api.shiftSummary());
      else setSummary(null);
      if (can("shifts.manage_all")) setHistory(await api.recentShifts());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [session.shift, can, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async () => {
    const minor = parseMoney(float);
    if (minor === null) return toast("Enter the starting cash, e.g. 100.00", "error");
    try {
      setSession(await api.openShift(minor));
      toast("Shift opened");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Shift</h1>
      </div>

      {!session.shift ? (
        <section className="panel narrow-panel">
          <h2>Open a shift</h2>
          <p className="muted">
            Count the cash in the drawer and enter it as the starting float. You cannot sell until a
            shift is open.
          </p>
          <label className="field">
            Starting cash in the drawer
            <input
              autoFocus
              inputMode="decimal"
              value={float}
              onChange={(e) => setFloat(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void open()}
            />
          </label>
          <button className="btn btn-primary btn-lg" onClick={() => void open()}>
            Open shift
          </button>
        </section>
      ) : (
        summary && (
          <>
            <p className="muted">
              Opened by <strong>{summary.shift.userName}</strong> at{" "}
              {formatDateTime(summary.shift.openedAt)} with a float of{" "}
              {money(summary.shift.openingCashMinor)}.
            </p>
            <div className="stats">
              <Stat label="Sales" value={String(summary.salesCount)} />
              <Stat label="Sales total" value={money(summary.salesTotalMinor)} />
              <Stat label="Cash sales" value={money(summary.byMethod.cash ?? 0)} />
              <Stat label="Card sales" value={money(summary.byMethod.card ?? 0)} />
              <Stat label="Cash in" value={money(summary.cashInMinor)} />
              <Stat label="Cash out" value={money(summary.cashOutMinor)} />
              {summary.expectedCashMinor !== null && (
                <Stat label="Expected in drawer" value={money(summary.expectedCashMinor)} />
              )}
            </div>
            {summary.expectedCashMinor === null && (
              <p className="muted">
                The expected amount is hidden until you close, so you count what is really there.
              </p>
            )}

            <div className="row actions-row">
              {can("cash.movement") && (
                <>
                  <button className="btn" onClick={() => setMovement("in")}>
                    Cash in
                  </button>
                  <button className="btn" onClick={() => setMovement("out")}>
                    Cash out
                  </button>
                </>
              )}
              <button className="btn btn-primary" onClick={() => setClosing(true)}>
                Count and close shift
              </button>
            </div>

            {summary.movements.length > 0 && (
              <>
                <h2 className="section">Cash in and out</h2>
                <table className="table">
                  <tbody>
                    {summary.movements.map((m) => (
                      <tr key={m.id}>
                        <td>{formatDateTime(m.createdAt)}</td>
                        <td>{m.reason}</td>
                        <td className="num">{m.amountMinor > 0 ? "+" : "−"}{money(Math.abs(m.amountMinor))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )
      )}

      {can("shifts.manage_all") && history.length > 0 && (
        <>
          <h2 className="section">Recent shifts</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Opened</th>
                <th>Cashier</th>
                <th className="num">Float</th>
                <th className="num">Expected</th>
                <th className="num">Counted</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => (
                <tr key={s.id}>
                  <td>{formatDateTime(s.openedAt)}</td>
                  <td>{s.userName}</td>
                  <td className="num">{money(s.openingCashMinor)}</td>
                  <td className="num">{s.expectedCashMinor === null ? "—" : money(s.expectedCashMinor)}</td>
                  <td className="num">{s.countedCashMinor === null ? "open" : money(s.countedCashMinor)}</td>
                  <td className={`num${s.varianceMinor ? " low" : ""}`}>
                    {s.varianceMinor === null ? "—" : variance(s.varianceMinor, money)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {movement && (
        <MovementForm
          direction={movement}
          onClose={() => setMovement(null)}
          onDone={() => {
            setMovement(null);
            void load();
          }}
        />
      )}
      {closing && (
        <CloseForm
          onClose={() => setClosing(false)}
          onClosed={async (result) => {
            setClosing(false);
            setClosed(result);
            setSession(await api.session());
          }}
        />
      )}
      {closed && (
        <Modal title="Shift closed" onClose={() => setClosed(null)}>
          <dl className="recap">
            <div>
              <dt>Expected in drawer</dt>
              <dd>{money(closed.expectedCashMinor ?? 0)}</dd>
            </div>
            <div>
              <dt>Counted</dt>
              <dd>{money(closed.shift.countedCashMinor ?? 0)}</dd>
            </div>
            <div className="grand">
              <dt>Difference</dt>
              <dd className={closed.shift.varianceMinor ? "bad" : ""}>
                {variance(closed.shift.varianceMinor ?? 0, money)}
              </dd>
            </div>
          </dl>
          <div className="modal-actions">
            <button className="btn btn-primary" autoFocus onClick={() => setClosed(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function variance(minor: number, money: (m: number) => string): string {
  if (minor === 0) return "Exact";
  return minor < 0 ? `${money(-minor)} short` : `${money(minor)} over`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function MovementForm({
  direction,
  onClose,
  onDone,
}: {
  direction: "in" | "out";
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useApp();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const save = async () => {
    const minor = parseMoney(amount);
    if (minor === null || minor === 0) return setError("Enter an amount, e.g. 20.00");
    if (!reason.trim()) return setError("A reason is required");
    try {
      await api.cashMovement(direction === "in" ? minor : -minor, reason);
      toast(direction === "in" ? "Cash added" : "Cash removed");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={direction === "in" ? "Cash in" : "Cash out"} onClose={onClose}>
      <label className="field">
        Amount
        <input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="field">
        Reason
        <input
          value={reason}
          placeholder={direction === "in" ? "e.g. extra change from the safe" : "e.g. bought milk, supplier paid"}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
        />
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

function CloseForm({
  onClose,
  onClosed,
}: {
  onClose: () => void;
  onClosed: (summary: ShiftSummaryView) => void | Promise<void>;
}) {
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const save = async () => {
    const minor = parseMoney(counted);
    if (minor === null) return setError("Enter the cash you counted, e.g. 1250.00");
    try {
      await onClosed(await api.closeShift(minor, note));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Count and close shift" onClose={onClose}>
      <p className="muted">Count all the cash in the drawer, including the starting float.</p>
      <label className="field">
        Cash counted
        <input
          autoFocus
          inputMode="decimal"
          value={counted}
          placeholder={minorToInput(0)}
          onChange={(e) => setCounted(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
        />
      </label>
      <label className="field">
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} />
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
          Close shift
        </button>
      </div>
    </Modal>
  );
}
