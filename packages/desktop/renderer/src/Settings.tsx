import { useRef, useState } from "react";
import { api } from "./api";
import { useApp } from "./context";

export function Settings() {
  const { settings, setSettings, toast } = useApp();
  const [storeName, setStoreName] = useState(settings.storeName);
  const [currency, setCurrency] = useState(settings.currency);
  const [locale, setLocale] = useState(settings.locale);
  const [footer, setFooter] = useState(settings.receiptFooter);
  const [width, setWidth] = useState(String(settings.receiptWidth));
  const [error, setError] = useState("");
  const [credit, setCredit] = useState(settings.showCredit);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    setError("");
    try {
      const next = await api.updateSettings({
        storeName,
        currency,
        locale,
        receiptFooter: footer,
        receiptWidth: Number(width),
        showCredit: credit,
      });
      setSettings(next);
      toast("Settings saved");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Read a picture the owner chose and keep it as a small data: URL. */
  const chooseLogo = (file: File | undefined) => {
    setError("");
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError("Choose a PNG, JPEG or WebP picture");
    if (file.size > 200_000) return setError("That picture is too big. Use one under 200 KB");
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setSettings(await api.updateSettings({ businessLogo: String(reader.result) }));
        toast("Logo saved");
      } catch (e) {
        setError((e as Error).message);
      }
    };
    reader.readAsDataURL(file);
  };
  const removeLogo = async () => {
    setSettings(await api.updateSettings({ businessLogo: "" }));
    toast("Logo removed");
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="form-grid">
        <label className="field span2">
          Store name (printed on receipts)
          <input value={storeName} onChange={(e) => setStoreName(e.target.value)} />
        </label>
        <label className="field">
          Currency code
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
        </label>
        <label className="field">
          Number format (locale)
          <input value={locale} onChange={(e) => setLocale(e.target.value)} />
        </label>
        <label className="field">
          Receipt width (characters)
          <select value={width} onChange={(e) => setWidth(e.target.value)}>
            <option value="32">32 — 58mm printer</option>
            <option value="48">48 — 80mm printer</option>
          </select>
        </label>
        <div className="field span2">
          Shop logo (shown in the app and on receipts)
          <div className="logo-row">
            <div className="logo-preview">
              {settings.businessLogo ? <img src={settings.businessLogo} alt="Your shop logo" /> : <span className="muted small">No logo</span>}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { chooseLogo(e.target.files?.[0]); e.target.value = ""; }} />
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              {settings.businessLogo ? "Change logo" : "Upload logo"}
            </button>
            {settings.businessLogo && (
              <button type="button" className="btn" onClick={() => void removeLogo()}>
                Remove
              </button>
            )}
            <span className="muted small">PNG, JPEG or WebP, under 200 KB. Black and white logos print best.</span>
          </div>
        </div>
        <label className="field span2">
          Receipt footer
          <input value={footer} onChange={(e) => setFooter(e.target.value)} />
        </label>
        <label className="check span2">
          <input type="checkbox" checked={credit} onChange={(e) => setCredit(e.target.checked)} />
          Print "Powered by Tillbase" and the copyright line under the footer
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions left">
        <button className="btn btn-primary" onClick={() => void save()}>
          Save settings
        </button>
      </div>
      <p className="muted">
        Prices are stored with two decimal places. Currencies without decimals are not supported yet.
      </p>
    </div>
  );
}
