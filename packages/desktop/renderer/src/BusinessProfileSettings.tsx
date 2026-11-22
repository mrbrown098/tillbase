import { useEffect, useState } from "react";
import {
  profiles, businessTypes, moduleLabel, optionalModules, retailKindLabel, retailKinds,
  type BusinessType, type ModuleId, type RetailKind,
} from "@tillbase/core/business";
import type { OrderType } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { bpToPercent, percentToBp } from "./format";
import { PrinterSettings } from "./PrinterSettings";

const orderTypeName: Record<OrderType, string> = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };

/**
 * Settings: the business profile after setup. Change the kind of business, which parts of the menu show, the
 * contact details and tax defaults, or run the guided setup again. Hiding a part never deletes anything.
 */
export function BusinessProfileSettings() {
  const { profile, setProfile, toast } = useApp();
  const [type, setType] = useState<BusinessType | null>(null);
  const [subtype, setSubtype] = useState<RetailKind | null>(null);
  const [modules, setModules] = useState<ModuleId[]>([]);
  const [orderTypes, setOrderTypes] = useState<OrderType[]>([]);
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [taxOn, setTaxOn] = useState(false);
  const [taxName, setTaxName] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [taxNumber, setTaxNumber] = useState("");
  const [cutoff, setCutoff] = useState(0);
  const [error, setError] = useState("");
  const [confirmRestart, setConfirmRestart] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setType(profile.type);
    setSubtype(profile.subtype);
    setModules(profile.modules);
    setOrderTypes(profile.orderTypes);
    setAddress(profile.address);
    setPhone(profile.phone);
    setEmail(profile.email);
    setTaxOn(profile.tax.enabled);
    setTaxName(profile.tax.name);
    setTaxRate(profile.tax.defaultRateBp != null ? bpToPercent(profile.tax.defaultRateBp) : "");
    setTaxNumber(profile.taxNumber);
    setCutoff(profile.dayCutoffHour);
  }, [profile]);
  if (!profile) return null;

  const def = type ? profiles[type] : null;

  const save = async () => {
    setError("");
    try {
      let bp: number | null = null;
      if (taxOn) {
        bp = percentToBp(taxRate);
        if (taxRate.trim() === "" || bp === null) throw new Error("Type the tax rate you charge, for example 5 or 17.5. Tillbase does not choose one for you");
      }
      // Choosing a different type starts that type's menu parts, then the owner's own ticks are applied on top.
      let p = profile;
      if (type && type !== profile.type) p = await api.saveBusinessProfile({ type });
      const same = type === p.type;
      p = await api.saveBusinessProfile({
        ...(same && type && type !== profile.type ? {} : { modules, orderTypes }),
        subtype: type === "retail" ? subtype : null,
        address, phone, email, taxNumber, dayCutoffHour: cutoff,
        tax: { enabled: taxOn, name: taxOn ? taxName : "", defaultRateBp: taxOn ? bp : null },
      });
      setProfile(p);
      toast(type !== profile.type ? "Business type changed. Check the menu parts below." : "Saved");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restart = async () => {
    try {
      setProfile(await api.restartOnboarding());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="panel business-settings" aria-labelledby="biz-heading">
      <h2 id="biz-heading">Business profile</h2>
      <p className="muted small">
        This chooses which parts of Tillbase show in the menu and on Home. It never deletes anything, and every permission still applies.
        {profile.type === null && " Your business has not been set up with a profile, so everything is shown."}
      </p>
      <label className="field">
        Kind of business
        <select value={type ?? ""} onChange={(e) => setType((e.target.value || null) as BusinessType | null)}>
          <option value="">Not chosen (show everything)</option>
          {businessTypes.map((t) => (
            <option key={t} value={t}>
              {profiles[t].label}
            </option>
          ))}
        </select>
      </label>
      {type && type !== profile.type && <p className="onb-note">Saving starts the menu parts that suit {profiles[type].label}. You can then change them here.</p>}
      {def?.warning && <p className="onb-note warn">{def.warning}</p>}
      {type === "retail" && (
        <label className="field">
          Kind of shop
          <select value={subtype ?? ""} onChange={(e) => setSubtype((e.target.value || null) as RetailKind | null)}>
            <option value="">Not chosen</option>
            {retailKinds.map((k) => (
              <option key={k} value={k}>
                {retailKindLabel[k]}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="onb-set">
        <legend>Parts of Tillbase to show in the menu</legend>
        {optionalModules.map((m) => (
          <label key={m} className="check">
            <input type="checkbox" checked={modules.includes(m)} onChange={() => setModules((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]))} />
            <span>
              <strong>{moduleLabel[m].label}</strong> <span className="muted small">{moduleLabel[m].about}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="onb-set">
        <legend>Kinds of order offered on the Orders screen</legend>
        {(Object.keys(orderTypeName) as OrderType[]).map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={orderTypes.includes(t)} onChange={() => setOrderTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))} /> {orderTypeName[t]}
          </label>
        ))}
      </fieldset>
      {def && (
        <div className="onb-lists">
          <div>
            <h4>Works today</h4>
            <ul>{def.available.map((a) => <li key={a}>{a}</li>)}</ul>
          </div>
          {def.notYet.length > 0 && (
            <div>
              <h4>Not available yet</h4>
              <ul className="not-yet">{def.notYet.map((a) => <li key={a}>{a}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      <div className="form-grid">
        <label className="field span2">
          Address
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label className="field">
          Phone
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="field">
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Tax registration number (for your records)
          <input value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} />
        </label>
        <label className="field">
          Business day starts at
          <select value={cutoff} onChange={(e) => setCutoff(Number(e.target.value))}>
            <option value={0}>Midnight</option>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((h) => (
              <option key={h} value={h}>
                {h}:00 in the morning
              </option>
            ))}
          </select>
        </label>
      </div>
      {cutoff > 0 && <p className="onb-note"><span className="onb-badge">Saved, not used by reports yet</span> Reports and Home still count midnight to midnight.</p>}
      <label className="check">
        <input type="checkbox" checked={taxOn} onChange={(e) => setTaxOn(e.target.checked)} /> New items start with a tax rate I choose (Tillbase never picks one)
      </label>
      {taxOn && (
        <div className="form-grid">
          <label className="field">
            Name, e.g. “Sales tax”
            <input value={taxName} onChange={(e) => setTaxName(e.target.value)} />
          </label>
          <label className="field">
            Rate (%)
            <input inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
          </label>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions left">
        <button className="btn btn-primary" onClick={() => void save()}>
          Save business profile
        </button>
        {!confirmRestart ? (
          <button className="btn" onClick={() => setConfirmRestart(true)}>
            Run the setup guide again…
          </button>
        ) : (
          <>
            <span className="muted small">This only walks through the questions again. Your sales, products, staff and settings are kept.</span>
            <button className="btn btn-primary" onClick={() => void restart()}>
              Yes, run it again
            </button>
            <button className="btn" onClick={() => setConfirmRestart(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
      <PrinterSettings />
    </section>
  );
}
