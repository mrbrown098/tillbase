import { useEffect, useState } from "react";
import type { Permission } from "@tillbase/core";
import { api } from "./api";
import { Backups } from "./Backups";
import { Checkout } from "./Checkout";
import { useApp } from "./context";
import { Costs } from "./Costs";
import { Customers } from "./Customers";
import { Home } from "./Home";
import { ShopLogo } from "./Logo";
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

interface Tab {
  id: string;
  label: string;
  needs: Permission;
  /** 24x24 outline icon path(s). */
  icon: string;
}

const groups: { title: string; tabs: Tab[] }[] = [
  {
    title: "",
    tabs: [{ id: "home", label: "Home", needs: "sell", icon: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" }],
  },
  {
    title: "Sell",
    tabs: [
      { id: "checkout", label: "Checkout", needs: "sell", icon: "M3 4h2l2.4 10.5h10.2L20 7H6M9 19.5h.01M17 19.5h.01" },
      { id: "orders", label: "Orders", needs: "sell", icon: "M7 3h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2-3 2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6" },
      { id: "kitchen", label: "Kitchen", needs: "sell", icon: "M6 14a4 4 0 1 1 1-7.9A5 5 0 0 1 17 7a4 4 0 0 1 1 7.9V20H6v-6zM6 17h12" },
      { id: "customers", label: "Customers", needs: "customers.use", icon: "M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 19v-1a3 3 0 0 0-2-2.8" },
    ],
  },
  {
    title: "Shop",
    tabs: [
      { id: "shift", label: "Shift", needs: "sell", icon: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" },
      { id: "sales", label: "Sales", needs: "sell", icon: "M4 19V5M4 19h16M8 15l3-4 3 2 4-6" },
    ],
  },
  {
    title: "Manage",
    tabs: [
      { id: "products", label: "Menu and stock", needs: "products.manage", icon: "M4 7l8-4 8 4-8 4-8-4zM4 7v10l8 4 8-4V7M12 11v10" },
      { id: "purchases", label: "Purchases", needs: "purchases.manage", icon: "M5 8h14l-1 12H6L5 8zM9 8a3 3 0 0 1 6 0" },
      { id: "costs", label: "Running costs", needs: "expenses.manage", icon: "M3 7h18v12H3zM3 11h18M7 15h3" },
    ],
  },
  {
    title: "Business",
    tabs: [
      { id: "money", label: "Money", needs: "finance.view", icon: "M12 3v18M16 7.5C15 6.5 13.7 6 12 6c-2 0-3.5 1-3.5 2.5S10 11 12 11.5s3.5 1 3.5 2.5S14 17 12 17c-1.7 0-3-.5-4-1.5" },
      { id: "team", label: "Team and wages", needs: "attendance.manage", icon: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19a5 5 0 0 1 10 0M16 8h5M16 12h5M16 16h3" },
      { id: "staff", label: "Staff", needs: "users.manage", icon: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z" },
    ],
  },
  {
    title: "System",
    tabs: [
      { id: "settings", label: "Settings", needs: "settings.manage", icon: "M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" },
      { id: "backups", label: "Backups", needs: "settings.manage", icon: "M12 3v12M7 10l5 5 5-5M4 19h16" },
    ],
  },
];

function Icon({ d }: { d: string }) {
  return (
    <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

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
  // Owners and managers start on Home; cashiers go straight to the till.
  const firstTab = can("reports.view") ? "home" : "checkout";
  const [tab, setTab] = useState(firstTab);
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

  const shown = groups
    .map((g) => ({ ...g, tabs: g.tabs.filter((t) => can(t.needs)) }))
    .filter((g) => g.tabs.length > 0);
  const active = shown.some((g) => g.tabs.some((t) => t.id === tab)) ? tab : firstTab;

  const signOut = async () => {
    setSession(await api.logout());
  };

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <ShopLogo size={36} />
          <div className="brand-text">
            <strong>{settings.storeName}</strong>
            <span className={`shift-chip ${session.shift ? "open" : "closed"}`}>
              {session.shift ? "Shift open" : "No shift open"}
            </span>
          </div>
        </div>
        <div className="rail-scroll">
          {shown.map((g) => (
            <div className="nav-group" key={g.title || "top"}>
              {g.title && <div className="nav-title">{g.title}</div>}
              {g.tabs.map((t) => (
                <button
                  key={t.id}
                  className={`nav${active === t.id ? " active" : ""}`}
                  aria-current={active === t.id ? "page" : undefined}
                  onClick={() => setTab(t.id)}
                >
                  <Icon d={t.icon} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="rail-foot">
          <div className="who">
            <span className="avatar sm" aria-hidden="true">
              {session.user?.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{session.user?.name}</strong>
              <span>{session.user?.role}</span>
            </div>
          </div>
          <div className="foot-actions">
            <button className="nav small" onClick={() => setChangingPin(true)}>
              Change PIN
            </button>
            <button className="nav small" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
          <span className="credit">Tillbase · free and open source</span>
        </div>
      </nav>
      <main className="main">
        {active === "home" && <Home go={setTab} />}
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
      </main>
      {changingPin && <ChangeOwnPin onClose={() => setChangingPin(false)} />}
    </div>
  );
}
