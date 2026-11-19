import { useEffect, useState } from "react";
import type { Permission } from "@tillbase/core";
import { api } from "./api";
import { Checkout } from "./Checkout";
import { useApp } from "./context";
import { Login, Setup } from "./Login";
import { Products } from "./Products";
import { Sales } from "./Sales";
import { Settings } from "./Settings";
import { ShiftScreen } from "./Shift";
import { ChangeOwnPin, Staff } from "./Staff";

const tabs: { id: string; label: string; needs: Permission }[] = [
  { id: "checkout", label: "Checkout", needs: "sell" },
  { id: "shift", label: "Shift", needs: "sell" },
  { id: "sales", label: "Sales", needs: "sell" },
  { id: "products", label: "Products", needs: "products.manage" },
  { id: "staff", label: "Staff", needs: "users.manage" },
  { id: "settings", label: "Settings", needs: "settings.manage" },
];

/** Sign out after this long without a click or key press. */
const IDLE_MS = 5 * 60 * 1000;

export function App() {
  const { session } = useApp();
  if (session.needsSetup) return <Setup />;
  if (!session.user) return <Login />;
  return <Shell />;
}

function Shell() {
  const { session, setSession, settings, can, toast } = useApp();
  const [tab, setTab] = useState("checkout");
  const [changingPin, setChangingPin] = useState(false);

  // Lock the till when nobody has touched it for a while.
  useEffect(() => {
    let timer = setTimeout(lock, IDLE_MS);
    function lock() {
      void api.logout().then((s) => {
        setSession(s);
        toast("Signed out after 5 minutes without activity");
      });
    }
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, IDLE_MS);
    };
    window.addEventListener("mousedown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [setSession, toast]);

  const visible = tabs.filter((t) => can(t.needs));
  const active = visible.some((t) => t.id === tab) ? tab : "checkout";

  const signOut = async () => {
    setSession(await api.logout());
  };

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">{settings.storeName}</div>
        {visible.map((t) => (
          <button
            key={t.id}
            className={`nav${active === t.id ? " active" : ""}`}
            aria-current={active === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "shift" && (
              <span className={`dot-status ${session.shift ? "open" : "closed"}`} title={session.shift ? "Shift open" : "No shift open"} />
            )}
          </button>
        ))}
        <div className="rail-foot">
          <div className="who">
            <strong>{session.user?.name}</strong>
            <span>{session.user?.role}</span>
          </div>
          <button className="nav" onClick={() => setChangingPin(true)}>
            Change my PIN
          </button>
          <button className="nav" onClick={() => void signOut()}>
            Sign out
          </button>
          <span>Tillbase · MIT</span>
        </div>
      </nav>
      <main className="main">
        {active === "checkout" && <Checkout onOpenShift={() => setTab("shift")} />}
        {active === "shift" && <ShiftScreen />}
        {active === "sales" && <Sales />}
        {active === "products" && <Products />}
        {active === "staff" && <Staff />}
        {active === "settings" && <Settings />}
      </main>
      {changingPin && <ChangeOwnPin onClose={() => setChangingPin(false)} />}
    </div>
  );
}
