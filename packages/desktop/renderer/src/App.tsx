import { useEffect, useState } from "react";
import type { Permission } from "@tillbase/core";
import { api } from "./api";
import { Backups } from "./Backups";
import { Updates } from "./Updates";
import { Checkout } from "./Checkout";
import { useApp } from "./context";
import { Costs } from "./Costs";
import { Customers } from "./Customers";
import { Kitchen } from "./Kitchen";
import { Login, Setup } from "./Login";
import { Money } from "./Money";
import { Orders } from "./Orders";
import { Products } from "./Products";
import { Purchases } from "./Purchases";
import { Sales } from "./Sales";
import { Settings } from "./Settings";
import { ShiftScreen } from "./Shift";
import { ChangeOwnPin, Staff } from "./Staff";
import { Team } from "./Team";

const tabs: { id: string; label: string; needs: Permission }[] = [
  { id: "checkout", label: "Checkout", needs: "sell" },
  { id: "orders", label: "Orders", needs: "sell" },
  { id: "kitchen", label: "Kitchen", needs: "sell" },
  { id: "customers", label: "Customers", needs: "customers.use" },
  { id: "shift", label: "Shift", needs: "sell" },
  { id: "sales", label: "Sales", needs: "sell" },
  { id: "money", label: "Money", needs: "finance.view" },
  { id: "products", label: "Menu and stock", needs: "products.manage" },
  { id: "purchases", label: "Purchases", needs: "purchases.manage" },
  { id: "costs", label: "Running costs", needs: "expenses.manage" },
  { id: "team", label: "Team and wages", needs: "attendance.manage" },
  { id: "staff", label: "Staff", needs: "users.manage" },
  { id: "settings", label: "Settings", needs: "settings.manage" },
  { id: "backups", label: "Backups", needs: "settings.manage" },
  { id: "updates", label: "Updates", needs: "settings.manage" },
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
        {active === "orders" && <Orders onOpenShift={() => setTab("shift")} />}
        {active === "kitchen" && <Kitchen />}
        {active === "customers" && <Customers />}
        {active === "shift" && <ShiftScreen />}
        {active === "sales" && <Sales />}
        {active === "money" && <Money />}
        {active === "products" && <Products />}
        {active === "purchases" && <Purchases />}
        {active === "costs" && <Costs />}
        {active === "team" && <Team />}
        {active === "staff" && <Staff />}
        {active === "settings" && <Settings />}
        {active === "backups" && <Backups />}
        {active === "updates" && <Updates />}
      </main>
      {changingPin && <ChangeOwnPin onClose={() => setChangingPin(false)} />}
    </div>
  );
}
