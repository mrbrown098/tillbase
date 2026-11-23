import { ShopLogo } from "./Logo";
import { useEffect, useState } from "react";
import type { User } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";

type Person = Pick<User, "id" | "name" | "role" | "pinLength">;

const roleLabel = { owner: "Owner", manager: "Manager", cashier: "Cashier" } as const;

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

  // Show exactly as many boxes as this person's PIN has; until we know, show 4 and grow.
  const boxes = chosen?.pinLength ?? Math.max(4, pin.length);
  const maxDigits = chosen?.pinLength ?? 8;
  const press = (d: string) => {
    if (pin.length >= maxDigits) return;
    const next = pin + d;
    setPin(next);
    // A known length signs in by itself on the last digit.
    if (chosen?.pinLength && next.length === chosen.pinLength) void submit(next);
  };

  return (
    <div className="login">
      <div className="login-card">
        <ShopLogo size={64} />
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
            <div className="pin-dots" aria-label={`${pin.length} of ${boxes} digits entered`}>
              {Array.from({ length: boxes }, (_, i) => (
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
              disabled={pin.length < (chosen?.pinLength ?? 4) || busy}
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
