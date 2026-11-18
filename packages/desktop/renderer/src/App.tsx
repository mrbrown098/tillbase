import { useState } from "react";
import { Checkout } from "./Checkout";
import { useApp } from "./context";
import { Products } from "./Products";
import { Sales } from "./Sales";
import { Settings } from "./Settings";

const tabs = [
  { id: "checkout", label: "Checkout" },
  { id: "products", label: "Products" },
  { id: "sales", label: "Sales" },
  { id: "settings", label: "Settings" },
] as const;

type TabId = (typeof tabs)[number]["id"];

export function App() {
  const { settings } = useApp();
  const [tab, setTab] = useState<TabId>("checkout");

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">{settings.storeName}</div>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`nav${tab === t.id ? " active" : ""}`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="rail-foot">Tillbase · MIT</div>
      </nav>
      <main className="main">
        {tab === "checkout" && <Checkout />}
        {tab === "products" && <Products />}
        {tab === "sales" && <Sales />}
        {tab === "settings" && <Settings />}
      </main>
    </div>
  );
}
