import { useEffect, useState } from "react";
import type { User } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";

type Person = Pick<User, "id" | "name" | "role">;

const roleLabel = { owner: "Owner", manager: "Manager", cashier: "Cashier" } as const;

/** First run: create the owner account. */
export function Setup() {
  const { settings, setSession, setSettings, toast } = useApp();
  const [shop, setShop] = useState(settings.storeName === "My Shop" ? "" : settings.storeName);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    if (!name.trim()) return setError("Enter your name");
    if (!/^\d{4,8}$/.test(pin)) return setError("PIN must be 4 to 8 digits");
    if (pin !== again) return setError("The two PINs do not match");
    try {
      if (shop.trim()) {
        // The owner is created first so settings can be saved with their permission.
        const session = await api.setupOwner(name, pin);
        setSettings(await api.updateSettings({ storeName: shop }));
        setSession(session);
      } else {
        setSession(await api.setupOwner(name, pin));
      }
      toast("Welcome to Tillbase");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <h1>Welcome to Tillbase</h1>
        <p className="muted">Set up the owner account. You can add cashiers and managers afterwards.</p>
        <label className="field">
          Shop name
          <input value={shop} onChange={(e) => setShop(e.target.value)} placeholder="e.g. Corner Shop" />
        </label>
        <label className="field">
          Your name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="form-grid">
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
          <label className="field">
            Repeat PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={again}
              onChange={(e) => setAgain(e.target.value.replace(/\D/g, "").slice(0, 8))}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg block" onClick={() => void submit()}>
          Create owner account
        </button>
      </div>
    </div>
  );
}

/** Pick your name, enter your PIN. */
export function Login() {
  const { settings, setSession } = useApp();
  const [people, setPeople] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<Person | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.loginUsers().then(setPeople).catch((e: Error) => setError(e.message));
  }, []);

  const submit = async (value = pin) => {
    if (!chosen || busy) return;
    setBusy(true);
    setError("");
    try {
      setSession(await api.login(chosen.id, value));
    } catch (e) {
      setError((e as Error).message);
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  const press = (d: string) => setPin((p) => (p.length < 8 ? p + d : p));

  return (
    <div className="login">
      <div className="login-card">
        <h1>{settings.storeName}</h1>
        {!chosen ? (
          <>
            <p className="muted">Who is working?</p>
            <div className="people">
              {people.map((p) => (
                <button key={p.id} className="person" onClick={() => setChosen(p)}>
                  <span className="avatar" aria-hidden="true">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{p.name}</span>
                  <span className="muted small">{roleLabel[p.role]}</span>
                </button>
              ))}
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          <div
            tabIndex={-1}
            ref={(el) => el?.focus()}
            onKeyDown={(e) => {
              if (/^\d$/.test(e.key)) press(e.key);
              else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
              else if (e.key === "Enter") void submit();
              else if (e.key === "Escape") {
                setChosen(null);
                setPin("");
                setError("");
              }
            }}
          >
            <p>
              Hello, <strong>{chosen.name}</strong>
            </p>
            <div className="pin-dots" aria-label={`${pin.length} digits entered`}>
              {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
                <span key={i} className={i < pin.length ? "dot on" : "dot"} />
              ))}
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="pad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} className="btn btn-lg" onClick={() => press(d)}>
                  {d}
                </button>
              ))}
              <button
                className="btn btn-lg"
                onClick={() => {
                  setChosen(null);
                  setPin("");
                  setError("");
                }}
              >
                Back
              </button>
              <button className="btn btn-lg" onClick={() => press("0")}>
                0
              </button>
              <button className="btn btn-lg" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete">
                ⌫
              </button>
            </div>
            <button
              className="btn btn-primary btn-lg block"
              disabled={pin.length < 4 || busy}
              onClick={() => void submit()}
            >
              Sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
