import { useCallback, useEffect, useState } from "react";
import type { Role, User } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { Modal } from "./Modal";

const roleLabel: Record<Role, string> = { owner: "Owner", manager: "Manager", cashier: "Cashier" };

export function Staff() {
  const { session, toast } = useApp();
  const [staff, setStaff] = useState<User[]>([]);
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);

  const load = useCallback(async () => {
    try {
      setStaff(await api.listStaff());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Staff</h1>
        <button className="btn btn-primary" onClick={() => setEditing("new")}>
          Add staff member
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {staff.map((u) => (
            <tr key={u.id} className={u.active ? "" : "inactive"}>
              <td>
                {u.name}
                {u.id === session.user?.id && <span className="badge">you</span>}
                {!u.active && <span className="badge">inactive</span>}
              </td>
              <td>{roleLabel[u.role]}</td>
              <td className="actions">
                <button className="btn" onClick={() => setResetting(u)}>
                  Reset PIN
                </button>
                <button className="btn" onClick={() => setEditing(u)}>
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="panel">
        <h2>What each role can do</h2>
        <ul className="roles">
          <li>
            <strong>Cashier</strong>: sell, take payment, open and close their own shift, reprint receipts.
          </li>
          <li>
            <strong>Manager</strong>: everything a cashier can, plus discounts, voids, cash in and out, products, stock, reports and all shifts.
          </li>
          <li>
            <strong>Owner</strong>: everything, plus staff and settings.
          </li>
        </ul>
      </section>

      {editing && (
        <StaffForm
          user={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {resetting && <ResetPin user={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

function StaffForm({
  user,
  onClose,
  onSaved,
}: {
  user: User | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState(user?.name ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "cashier");
  const [active, setActive] = useState(user?.active ?? true);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  const save = async () => {
    try {
      if (user) {
        await api.updateStaff(user.id, { name, role, active });
      } else {
        await api.createStaff({ name, pin, role });
      }
      toast(user ? "Staff member updated" : "Staff member added");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={user ? "Edit staff member" : "Add staff member"} onClose={onClose}>
      <label className="field">
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="cashier">Cashier</option>
          <option value="manager">Manager</option>
          <option value="owner">Owner</option>
        </select>
      </label>
      {!user && (
        <label className="field">
          PIN (4 to 8 digits)
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          />
        </label>
      )}
      {user && (
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active (can sign in)
        </label>
      )}
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

function ResetPin({ user, onClose }: { user: User; onClose: () => void }) {
  const { toast } = useApp();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  const save = async () => {
    try {
      await api.resetPin(user.id, pin);
      toast(`PIN changed for ${user.name}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`Reset PIN · ${user.name}`} onClose={onClose}>
      <label className="field">
        New PIN (4 to 8 digits)
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
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
          Change PIN
        </button>
      </div>
    </Modal>
  );
}

/** Anyone can change their own PIN, but must know the current one. */
export function ChangeOwnPin({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");

  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 8);

  const save = async () => {
    if (next !== again) return setError("The two new PINs do not match");
    try {
      await api.changeOwnPin(current, next);
      toast("Your PIN was changed");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Change my PIN" onClose={onClose}>
      <label className="field">
        Current PIN
        <input autoFocus type="password" inputMode="numeric" autoComplete="off" value={current} onChange={(e) => setCurrent(digits(e.target.value))} />
      </label>
      <label className="field">
        New PIN (4 to 8 digits)
        <input type="password" inputMode="numeric" autoComplete="off" value={next} onChange={(e) => setNext(digits(e.target.value))} />
      </label>
      <label className="field">
        Repeat new PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={again}
          onChange={(e) => setAgain(digits(e.target.value))}
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
          Change PIN
        </button>
      </div>
    </Modal>
  );
}
