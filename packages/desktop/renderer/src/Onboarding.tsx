import { useCallback, useEffect, useMemo, useState } from "react";
import {
  profiles as businessProfiles, businessTypes, countries, countryByCode, guessCountry, moduleLabel, optionalModules, retailKindLabel, retailKinds,
  type BusinessProfile, type BusinessType, type ModuleId, type RetailKind,
} from "@tillbase/core/business";
import type { OrderType } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { bpToPercent, percentToBp } from "./format";
import { TillbaseMark } from "./Logo";
import { PrinterSettings } from "./PrinterSettings";

/** Step numbers. They are saved, so an interrupted setup resumes where it stopped: never renumber them. */
const STEP = { splash: 0, welcome: 1, owner: 2, country: 3, type: 4, setup: 5, shop: 6, tax: 7, staff: 8, printer: 9, review: 10 } as const;
const TITLES: Record<number, string> = {
  [STEP.country]: "Country and currency",
  [STEP.type]: "What kind of business?",
  [STEP.setup]: "How you work",
  [STEP.shop]: "Your shop",
  [STEP.tax]: "Tax",
  [STEP.staff]: "Your team",
  [STEP.printer]: "Receipts and printer",
  [STEP.review]: "Review and open",
};
const FIRST_COUNTED = STEP.country;
const COUNTED = STEP.review - FIRST_COUNTED + 1;

const orderTypeLabels: Record<OrderType, { label: string; about: string }> = {
  dine_in: { label: "Dine-in", about: "Customers sit at tables; each order belongs to a table" },
  takeaway: { label: "Takeaway", about: "Customers take it away; every order gets a token number" },
  delivery: { label: "Delivery", about: "Delivered to an address, with an optional delivery charge" },
};

const commonCurrencies = ["PKR", "INR", "BDT", "LKR", "NPR", "AED", "SAR", "QAR", "OMR", "TRY", "EGP", "GBP", "EUR", "USD", "CAD", "AUD", "NZD", "ZAR", "NGN", "KES", "MYR", "SGD", "IDR", "PHP"];

/** Every time zone this computer knows (the browser engine's own list), with the current one first. */
function timeZoneChoices(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  const set = new Set(all);
  if (current) set.add(current);
  for (const c of countries) set.add(c.timezone);
  return [...set].sort();
}

const computerZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
})();

/** First run, and "set up again": the guided setup. Answers are saved step by step so closing the app never loses them. */
export function Onboarding() {
  const { session, profile, setProfile, setSession, settings, setSettings, toast } = useApp();
  const resuming = !session.needsSetup;
  const [step, setStep] = useState<number>(resuming ? Math.max(STEP.country, profile?.step ?? STEP.country) : STEP.splash);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // ---- answers ----
  const [ownerName, setOwnerName] = useState(session.user?.name ?? "");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");

  const guessed = useMemo(() => guessCountry(computerZone, typeof navigator !== "undefined" ? navigator.language : undefined), []);
  const startCountry = profile?.country || guessed?.code || "";
  const startCurrency = profile?.country ? settings.currency : (countryByCode(startCountry)?.currency ?? settings.currency);
  const [country, setCountry] = useState<string>(startCountry);
  const [otherCountry, setOtherCountry] = useState(false);
  const [currency, setCurrency] = useState(startCurrency);
  const [locale, setLocale] = useState(profile?.country ? settings.locale : (countryByCode(startCountry)?.locale ?? settings.locale));
  const [timezone, setTimezone] = useState(profile?.timezone || countryByCode(startCountry)?.timezone || computerZone);
  const [cutoff, setCutoff] = useState(profile?.dayCutoffHour ?? 0);

  const [type, setType] = useState<BusinessType | null>(profile?.type ?? null);
  const [subtype, setSubtype] = useState<RetailKind | null>(profile?.subtype ?? null);
  const [modules, setModules] = useState<ModuleId[]>(profile?.modules ?? [...optionalModules]);
  const [orderTypes, setOrderTypes] = useState<OrderType[]>(profile?.orderTypes ?? ["dine_in", "takeaway", "delivery"]);

  const [shop, setShop] = useState(settings.storeName === "My Shop" ? "" : settings.storeName);
  const [address, setAddress] = useState(profile?.address ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");

  const [taxOn, setTaxOn] = useState(profile?.tax.enabled ?? false);
  const [taxName, setTaxName] = useState(profile?.tax.name ?? "");
  const [taxRate, setTaxRate] = useState(profile?.tax.defaultRateBp != null ? bpToPercent(profile.tax.defaultRateBp) : "");
  const [taxNumber, setTaxNumber] = useState(profile?.taxNumber ?? "");

  const [width, setWidth] = useState(settings.receiptWidth > 32 ? 48 : 32);
  const [footer, setFooter] = useState(settings.receiptFooter);
  const [footerContact, setFooterContact] = useState(false);

  const [people, setPeople] = useState<{ id: string; name: string; role: string }[]>([]);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<"manager" | "cashier">("cashier");
  const [newPin, setNewPin] = useState("");

  const loadPeople = useCallback(() => {
    if (!session.user) return;
    api.loginUsers().then((u) => setPeople(u.filter((x) => x.role !== "owner"))).catch(() => undefined);
  }, [session.user]);
  useEffect(() => {
    if (step === STEP.staff || step === STEP.review) loadPeople();
  }, [step, loadPeople]);

  // The splash shows for a moment, and any click or key skips it.
  useEffect(() => {
    if (step !== STEP.splash) return;
    const t = setTimeout(() => setStep(STEP.welcome), 1800);
    return () => clearTimeout(t);
  }, [step]);

  const def = type ? businessProfiles[type] : null;
  const zones = useMemo(() => timeZoneChoices(timezone), [timezone]);

  const remember = async (patch: Parameters<typeof api.saveBusinessProfile>[0]) => {
    const p = await api.saveBusinessProfile(patch);
    setProfile(p);
    return p;
  };

  /** Run one step's save, then move on. A problem is shown in plain words and the person stays on the step. */
  const go = async (to: number, save?: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      if (save) await save();
      setStep(to);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickCountry = (code: string) => {
    if (code === "other") {
      setOtherCountry(true);
      setCountry("");
      return;
    }
    setOtherCountry(false);
    setCountry(code);
    const c = countryByCode(code);
    if (c) {
      setCurrency(c.currency);
      setLocale(c.locale);
      setTimezone(c.timezone);
    }
  };

  const finish = async (skipped = false) => {
    setError("");
    setBusy(true);
    try {
      const p = await api.finishOnboarding();
      setProfile(p);
      toast(skipped ? "Setup skipped. You can run it again from Settings." : "Welcome to Tillbase");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const skip = (
    <button className="btn btn-ghost small" disabled={busy} onClick={() => void finish(true)}>
      Skip the rest of setup
    </button>
  );

  // ---------------------------------------------------------------- Splash and welcome
  if (step === STEP.splash) {
    return (
      <div className="onb-splash" role="button" tabIndex={0} aria-label="Tillbase. Press to continue" onClick={() => setStep(STEP.welcome)} onKeyDown={() => setStep(STEP.welcome)} ref={(el) => el?.focus()}>
        <div className="onb-splash-mark">
          <TillbaseMark size={120} />
        </div>
        <h1>Tillbase</h1>
        <p>Free point of sale for shops and restaurants</p>
      </div>
    );
  }

  if (step === STEP.welcome) {
    return (
      <div className="login">
        <div className="login-card onb-card">
          <TillbaseMark size={64} />
          <h1>Welcome to Tillbase</h1>
          <p className="muted">Let's get your business ready. It takes about five minutes, and you can skip the optional parts.</p>
          <ul className="onb-points">
            <li>Free, with no subscription and no account to sign up for.</li>
            <li>Works without internet. Your sales stay on this computer.</li>
            <li>You choose a secure PIN for the owner, and nothing is sent anywhere.</li>
          </ul>
          <button className="btn btn-primary btn-lg block" autoFocus onClick={() => setStep(STEP.owner)}>
            Get started
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- Owner account
  if (step === STEP.owner) {
    const create = () =>
      go(STEP.country, async () => {
        if (!ownerName.trim()) throw new Error("Enter your name");
        if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN must be 4 to 8 digits");
        if (pin !== pin2) throw new Error("The two PINs do not match");
        const s = await api.beginOnboarding(ownerName.trim(), pin);
        const p = await api.getBusinessProfile();
        setProfile(p);
        setSession(s);
        setPin("");
        setPin2("");
      });
    return (
      <div className="login">
        <div className="login-card onb-card">
          <TillbaseMark size={48} />
          <h1>Create the owner account</h1>
          <p className="muted">The owner can see everything. You can add managers and cashiers later. Choose a PIN you will remember, and keep it private.</p>
          <label className="field">
            Your name
            <input autoFocus value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <div className="form-grid">
            <label className="field">
              PIN (4 to 8 digits)
              <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} />
            </label>
            <label className="field">
              Repeat PIN
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin2}
                onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 8))}
                onKeyDown={(e) => e.key === "Enter" && void create()}
              />
            </label>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="onb-nav">
            <button className="btn" disabled={busy} onClick={() => setStep(STEP.welcome)}>
              Back
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
              Create account
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- The numbered steps
  const toggleModule = (m: ModuleId) => setModules((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  const toggleOrderType = (t: OrderType) => setOrderTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  let body: React.ReactNode = null;
  let next: { label: string; onClick: () => void } | null = null;
  let back: number | null = step > STEP.country ? step - 1 : null;
  let optional = false;

  if (step === STEP.country) {
    const known = countryByCode(country);
    const computerDiffers = timezone && computerZone && timezone !== computerZone;
    body = (
      <>
        <p className="muted">This sets how money and dates are written. You can change any of it later in Settings.</p>
        <label className="field">
          Country
          <select value={otherCountry ? "other" : country} onChange={(e) => pickCountry(e.target.value)}>
            <option value="" disabled>
              Choose your country…
            </option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
            <option value="other">My country is not listed</option>
          </select>
        </label>
        {known && !profile?.country && guessed?.code === known.code && <p className="muted small">We guessed this from your computer's settings. Change it if it is wrong.</p>}
        <div className="form-grid">
          <label className="field">
            Currency (3 letters)
            <input list="onb-currencies" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
            <datalist id="onb-currencies">
              {commonCurrencies.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="field">
            Time zone
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
        </div>
        {known && <p className="muted small">Suggested for {known.name}: {known.currency}. You can use a different currency.</p>}
        {computerDiffers && (
          <p className="onb-note">
            This computer is set to <strong>{computerZone}</strong>. Tillbase uses the computer's clock and time zone for sales and reports, so change the time zone in your computer's own settings too.
          </p>
        )}
        <label className="field">
          Does your business trade after midnight?
          <select value={cutoff} onChange={(e) => setCutoff(Number(e.target.value))}>
            <option value={0}>No, my day runs midnight to midnight</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((h) => (
              <option key={h} value={h}>
                Yes, my business day starts at {h}:00 in the morning
              </option>
            ))}
          </select>
        </label>
        {cutoff > 0 && (
          <p className="onb-note">
            Reports, Home and the accountant export will count a sale made before {cutoff}:00 as the day before. Past sales keep their exact time.
          </p>
        )}
      </>
    );
    next = {
      label: "Next",
      onClick: () =>
        void go(STEP.type, async () => {
          if (!otherCountry && !country) throw new Error("Choose your country, or pick “My country is not listed”");
          if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a 3-letter code such as PKR or USD");
          const s = await api.updateSettings({ currency, locale });
          setSettings(s);
          await remember({ country: otherCountry ? "" : country, timezone, dayCutoffHour: cutoff, step: STEP.type });
        }),
    };
  }

  if (step === STEP.type) {
    body = (
      <>
        <p className="muted">This chooses which parts of Tillbase you see first. Nothing is locked: you can change it any time in Settings.</p>
        <div className="onb-types" role="radiogroup" aria-label="Business type">
          {businessTypes.map((t) => {
            const d = businessProfiles[t];
            return (
              <button key={t} role="radio" aria-checked={type === t} className={`onb-type${type === t ? " on" : ""}`} onClick={() => setType(t)}>
                <strong>{d.label}</strong>
                <span>{d.tagline}</span>
                {t === "pharmacy" && <em className="onb-badge warn">Starting point only</em>}
              </button>
            );
          })}
        </div>
      </>
    );
    next = {
      label: "Next",
      onClick: () =>
        void go(STEP.setup, async () => {
          if (!type) throw new Error("Choose the kind of business you run");
          const p = await remember({ type, step: STEP.setup });
          setSubtype(p.subtype);
          setModules(p.modules);
          setOrderTypes(p.orderTypes);
        }),
    };
  }

  if (step === STEP.setup && def && type) {
    body = (
      <>
        <h3 className="onb-h3">{def.label}</h3>
        {def.warning && (
          <p className="onb-note warn" role="note">
            {def.warning}
          </p>
        )}
        {type === "retail" && (
          <fieldset className="onb-set">
            <legend>What kind of shop is it?</legend>
            {retailKinds.map((k) => (
              <label key={k} className="check">
                <input type="radio" name="retail-kind" checked={subtype === k} onChange={() => setSubtype(k)} /> {retailKindLabel[k]}
              </label>
            ))}
          </fieldset>
        )}
        {(type === "restaurant" || type === "fastfood" || type === "custom") && (
          <fieldset className="onb-set">
            <legend>Which kinds of order do you take?</legend>
            {(Object.keys(orderTypeLabels) as OrderType[]).map((t) => (
              <label key={t} className="check">
                <input type="checkbox" checked={orderTypes.includes(t)} onChange={() => toggleOrderType(t)} />
                <span>
                  <strong>{orderTypeLabels[t].label}</strong> <span className="muted small">{orderTypeLabels[t].about}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <fieldset className="onb-set">
          <legend>Parts of Tillbase to show in the menu</legend>
          <p className="muted small">Hidden parts are only hidden, never deleted. You can turn them on later in Settings.</p>
          {optionalModules.map((m) => (
            <label key={m} className="check">
              <input type="checkbox" checked={modules.includes(m)} onChange={() => toggleModule(m)} />
              <span>
                <strong>{moduleLabel[m].label}</strong> <span className="muted small">{moduleLabel[m].about}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="onb-lists">
          <div>
            <h4>Works today</h4>
            <ul>
              {def.available.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
          {def.notYet.length > 0 && (
            <div>
              <h4>Not available yet</h4>
              <ul className="not-yet">
                {def.notYet.map((a) => (
                  <li key={a}>
                    {a} <span className="onb-badge">Not available yet</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </>
    );
    next = {
      label: "Next",
      onClick: () =>
        void go(STEP.shop, async () => {
          if (type === "retail" && !subtype) throw new Error("Choose grocery, general or clothing store");
          if ((type === "restaurant" || type === "fastfood" || type === "custom") && orderTypes.length === 0) throw new Error("Choose at least one kind of order");
          await remember({ subtype: type === "retail" ? subtype : null, modules, orderTypes, step: STEP.shop });
        }),
    };
  }

  if (step === STEP.shop) {
    body = (
      <>
        <p className="muted">Your shop's name shows on the sign-in screen and on receipts. The rest is for your own records and is saved on this computer.</p>
        <label className="field">
          Shop name
          <input autoFocus value={shop} onChange={(e) => setShop(e.target.value)} placeholder="e.g. Corner Shop" />
        </label>
        <label className="field">
          Address (optional)
          <textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <div className="form-grid">
          <label className="field">
            Phone (optional)
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label className="field">
            Email (optional)
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
      </>
    );
    next = {
      label: "Next",
      onClick: () =>
        void go(STEP.tax, async () => {
          if (!shop.trim()) throw new Error("Enter your shop's name");
          setSettings(await api.updateSettings({ storeName: shop }));
          await remember({ address, phone, email, step: STEP.tax });
        }),
    };
  }

  if (step === STEP.tax) {
    body = (
      <>
        <p className="onb-note">
          Tax rules are different in every country and for every kind of business, and Tillbase does not know yours. It does not choose a rate for you, and it is not approved by or connected to any tax authority. Ask your accountant or tax office if you are not sure.
        </p>
        <div className="onb-types" role="radiogroup" aria-label="Tax">
          <button role="radio" aria-checked={!taxOn} className={`onb-type${!taxOn ? " on" : ""}`} onClick={() => setTaxOn(false)}>
            <strong>I do not add tax at the till</strong>
            <span>Prices are final. You can still add tax to individual items later.</span>
          </button>
          <button role="radio" aria-checked={taxOn} className={`onb-type${taxOn ? " on" : ""}`} onClick={() => setTaxOn(true)}>
            <strong>I add tax to my sales</strong>
            <span>You type the rate yourself. New items start with it, and you can change any item.</span>
          </button>
        </div>
        {taxOn && (
          <>
            <div className="form-grid">
              <label className="field">
                Name on receipts, e.g. “Sales tax”
                <input value={taxName} onChange={(e) => setTaxName(e.target.value)} />
              </label>
              <label className="field">
                Rate you charge (%)
                <input inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="type your rate" />
              </label>
            </div>
            <p className="muted small">Prices you enter are before tax. Tax is added on top at checkout.</p>
          </>
        )}
        <label className="field">
          Your tax registration number (optional, kept for your own records)
          <input value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} />
        </label>
      </>
    );
    next = {
      label: "Next",
      onClick: () =>
        void go(STEP.staff, async () => {
          let bp: number | null = null;
          if (taxOn) {
            bp = percentToBp(taxRate);
            if (taxRate.trim() === "" || bp === null) throw new Error("Type the tax rate you charge, for example 5 or 17.5. Tillbase does not choose one for you");
          }
          await remember({ taxNumber, tax: { enabled: taxOn, name: taxOn ? taxName : "", defaultRateBp: taxOn ? bp : null }, step: STEP.staff });
        }),
    };
  }

  if (step === STEP.staff) {
    optional = true;
    const add = async () => {
      setError("");
      try {
        if (!newName.trim()) throw new Error("Enter their name");
        if (!/^\d{4,8}$/.test(newPin)) throw new Error("Their PIN must be 4 to 8 digits");
        await api.createStaff({ name: newName.trim(), pin: newPin, role: newRole });
        setNewName("");
        setNewPin("");
        loadPeople();
        toast("Added");
      } catch (e) {
        setError((e as Error).message);
      }
    };
    body = (
      <>
        <p className="muted">Optional. Add the people who will use the till. Each person signs in with their own PIN. You can add or change people later in Staff.</p>
        {people.length > 0 && (
          <ul className="onb-people" aria-label="People added">
            {people.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong> <span className="muted">{p.role === "manager" ? "Manager" : "Cashier"}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="form-grid">
          <label className="field">
            Name
            <input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <label className="field">
            Role
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as "manager" | "cashier")}>
              <option value="cashier">Cashier (sells, takes payments)</option>
              <option value="manager">Manager (also stock, reports, discounts)</option>
            </select>
          </label>
          <label className="field">
            PIN (4 to 8 digits)
            <input type="password" inputMode="numeric" autoComplete="off" value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 8))} />
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <button className="btn" onClick={() => void add()}>
              Add this person
            </button>
          </div>
        </div>
      </>
    );
    next = { label: people.length || newName ? "Next" : "Skip for now", onClick: () => void go(STEP.printer, () => remember({ step: STEP.printer }).then(() => undefined)) };
  }

  if (step === STEP.printer) {
    optional = true;
    body = (
      <>
        <p className="muted">Optional. Receipts work without a printer address: Tillbase uses your computer's normal print window. You can add your logo later in Settings.</p>
        <fieldset className="onb-set">
          <legend>Paper width</legend>
          <label className="check">
            <input type="radio" name="width" checked={width === 32} onChange={() => setWidth(32)} /> 58 mm paper (32 characters a line)
          </label>
          <label className="check">
            <input type="radio" name="width" checked={width === 48} onChange={() => setWidth(48)} /> 80 mm paper (48 characters a line)
          </label>
        </fieldset>
        <label className="field">
          Receipt footer
          <textarea rows={2} value={footer} onChange={(e) => setFooter(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={footerContact} onChange={(e) => setFooterContact(e.target.checked)} /> Add my address and phone to the footer
        </label>
        <PrinterSettings />
      </>
    );
    next = {
      label: "Next",
      onClick: () =>
        void go(STEP.review, async () => {
          let text = footer.trim();
          if (footerContact) {
            for (const line of [address.trim(), phone.trim() ? `Phone: ${phone.trim()}` : ""]) if (line && !text.includes(line)) text += `\n${line}`;
          }
          setSettings(await api.updateSettings({ receiptWidth: width, receiptFooter: text }));
          if (footerContact) setFooter(text);
          await remember({ step: STEP.review });
        }),
    };
  }

  if (step === STEP.review) {
    const c = countryByCode(country);
    const rows: [string, string, number][] = [
      ["Owner", session.user?.name ?? ownerName, -1],
      ["Country", `${c?.name ?? "Other"} · ${currency} · ${timezone || "this computer's time zone"}${cutoff ? ` · new day starts at ${cutoff}:00` : ""}`, STEP.country],
      ["Business", `${def?.label ?? "Not chosen"}${subtype ? ` (${retailKindLabel[subtype]})` : ""}`, STEP.type],
      ["Menu shows", ["Home", "Checkout", "Shift", "Sales", def?.productsLabel ?? "Menu and stock", ...modules.map((m) => moduleLabel[m].label)].join(", "), STEP.setup],
      ...(modules.includes("orders") ? ([["Orders", orderTypes.map((t) => orderTypeLabels[t].label).join(", "), STEP.setup]] as [string, string, number][]) : []),
      ["Shop", [shop, address, phone, email].filter(Boolean).join(" · "), STEP.shop],
      ["Tax", taxOn ? `${taxName || "Tax"}: new items start at ${taxRate}%. You can change each item.` : "No tax added at the till", STEP.tax],
      ["Team", people.length ? people.map((p) => p.name).join(", ") : "Just the owner for now", STEP.staff],
      ["Receipts", `${width === 32 ? "58" : "80"} mm paper`, STEP.printer],
    ];
    body = (
      <>
        <p className="muted">Check everything, then open Tillbase. You can change any of this later in Settings.</p>
        {def?.warning && (
          <p className="onb-note warn" role="note">
            {def.warning}
          </p>
        )}
        <dl className="onb-review">
          {rows.map(([k, v, to]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
              {to >= 0 && (
                <button className="btn btn-ghost small" onClick={() => setStep(to)} aria-label={`Change ${k}`}>
                  Change
                </button>
              )}
            </div>
          ))}
        </dl>
      </>
    );
    next = { label: "Open Tillbase", onClick: () => void finish() };
  }

  const n = step - FIRST_COUNTED + 1;
  return (
    <div className="login">
      <div className="login-card onb-card onb-wide">
        <div className="onb-head">
          <TillbaseMark size={36} />
          <div>
            <p className="muted small">
              Step {n} of {COUNTED}
              {optional ? " · optional" : ""}
            </p>
            <h1>{TITLES[step]}</h1>
          </div>
        </div>
        <div className="onb-bar" role="progressbar" aria-valuemin={1} aria-valuemax={COUNTED} aria-valuenow={n} aria-label="Setup progress">
          <span style={{ width: `${(n / COUNTED) * 100}%` }} />
        </div>
        <div className="onb-body">{body}</div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="onb-nav">
          <div>
            {back !== null && (
              <button className="btn" disabled={busy} onClick={() => setStep(back!)}>
                Back
              </button>
            )}
          </div>
          <div className="onb-right">
            {step < STEP.review && skip}
            {next && (
              <button className="btn btn-primary" disabled={busy} onClick={next.onClick}>
                {next.label}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
