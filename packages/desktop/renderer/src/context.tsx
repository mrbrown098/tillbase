import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { ShopSettings } from "@tillbase/core";
import { formatMoney } from "@tillbase/core/money";
import { api } from "./api";

interface Toast {
  id: number;
  kind: "ok" | "error";
  text: string;
}

interface AppContextValue {
  settings: ShopSettings;
  setSettings: (s: ShopSettings) => void;
  money: (minor: number) => string;
  toast: (text: string, kind?: "ok" | "error") => void;
}

const defaults: ShopSettings = {
  storeName: "Tillbase",
  currency: "USD",
  locale: "en-US",
  receiptFooter: "Thank you!",
  receiptWidth: 32,
};

const Ctx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ShopSettings>(defaults);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setSettings(s))
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  const toast = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }].slice(-3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 2500);
  }, []);

  const money = useCallback(
    (minor: number) => formatMoney(minor, settings.currency, settings.locale),
    [settings.currency, settings.locale],
  );

  if (!ready) return null;

  return (
    <Ctx.Provider value={{ settings, setSettings, money, toast }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
