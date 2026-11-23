import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { BusinessProfile, Permission, ShopSettings } from "@tillbase/core";
import { formatMoney } from "@tillbase/core/money";
import { setBusinessCalendar } from "@tillbase/core/dates";
import type { SessionInfo } from "../../shared/api";
import { api } from "./api";

interface Toast {
  id: number;
  kind: "ok" | "error";
  text: string;
}

interface AppContextValue {
  settings: ShopSettings;
  setSettings: (s: ShopSettings) => void;
  session: SessionInfo;
  setSession: (s: SessionInfo) => void;
  /** The business profile (what kind of business, which parts of the menu show). Null until the signed-in user's profile has loaded. */
  profile: BusinessProfile | null;
  setProfile: (p: BusinessProfile) => void;
  /** Whether the signed-in user may do something. The main process enforces this too. */
  can: (permission: Permission) => boolean;
  money: (minor: number) => string;
  toast: (text: string, kind?: "ok" | "error") => void;
}

const defaults: ShopSettings = {
  storeName: "Tillbase",
  currency: "USD",
  locale: "en-US",
  receiptFooter: "Thank you!",
  receiptWidth: 32,
  businessLogo: "",
  showSponsors: true,
};

const signedOut: SessionInfo = { needsSetup: false, user: null, permissions: [], shift: null };

const Ctx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}

/** The renderer's date helpers follow the same time zone and day cut-off as the reports (not a React hook). */
function applyCalendar(p: BusinessProfile): void {
  setBusinessCalendar({ timeZone: p.timezone, cutoffHour: p.dayCutoffHour });
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ShopSettings>(defaults);
  const [session, setSession] = useState<SessionInfo>(signedOut);
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [ready, setReady] = useState(false);
  // Until the business profile is in, "today" would be worked out on the wrong clock.
  const [calendarSet, setCalendarSet] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    Promise.all([api.getSettings(), api.session()])
      .then(([s, sess]) => {
        setSettings(s);
        setSession(sess);
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  // The profile is read once someone is signed in (the menu and Home follow it).
  const userId = session.user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      setProfile(null);
      setCalendarSet(true);
      return;
    }
    setCalendarSet(false);
    api
      .getBusinessProfile()
      .then((p) => {
        applyCalendar(p);
        setProfile(p);
      })
      .catch(() => undefined)
      .finally(() => setCalendarSet(true));
  }, [userId]);

  const saveProfile = useCallback((p: BusinessProfile) => {
    applyCalendar(p);
    setProfile(p);
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

  const can = useCallback(
    (permission: Permission) => session.permissions.includes(permission),
    [session.permissions],
  );

  if (!ready || !calendarSet) return null;

  return (
    <Ctx.Provider value={{ settings, setSettings, session, setSession, profile, setProfile: saveProfile, can, money, toast }}>
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
