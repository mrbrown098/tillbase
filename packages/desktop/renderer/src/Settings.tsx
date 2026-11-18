import { useState } from "react";
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

  const save = async () => {
    setError("");
    try {
      const next = await api.updateSettings({
        storeName,
        currency,
        locale,
        receiptFooter: footer,
        receiptWidth: Number(width),
      });
      setSettings(next);
      toast("Settings saved");
    } catch (e) {
      setError((e as Error).message);
    }
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
        <label className="field span2">
          Receipt footer
          <input value={footer} onChange={(e) => setFooter(e.target.value)} />
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
