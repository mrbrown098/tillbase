import { useEffect, useState } from "react";
import type { PrinterConfig } from "@tillbase/core";
import type { PrintResult } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";

/**
 * The receipt printer address, as a small block of its own. Mount it on the Settings screen (the owner's):
 *   <PrinterSettings />
 * It needs nothing from the screen around it. Saving, the test page and "Open cash drawer" are checked in the
 * main process (settings and drawer permissions), so showing it to a cashier would not give them any power.
 */
export function PrinterSettings() {
  const { toast, can } = useApp();
  const [cfg, setCfg] = useState<PrinterConfig | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [drawer, setDrawer] = useState(false);
  const [result, setResult] = useState<PrintResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getPrinter()
      .then((c) => {
        setCfg(c);
        setHost(c.host);
        setPort(String(c.port));
        setDrawer(c.openDrawer);
      })
      .catch((e: Error) => toast(e.message, "error"));
  }, [toast]);

  if (!cfg) return null;
  const canSave = can("settings.manage");
  const dirty = host.trim() !== cfg.host || Number(port) !== cfg.port || drawer !== cfg.openDrawer;

  const save = async (): Promise<boolean> => {
    try {
      const c = await api.setPrinter({ host, port: Number(port), openDrawer: drawer });
      setCfg(c);
      setHost(c.host);
      setPort(String(c.port));
      toast(c.host ? "Printer saved" : "Receipt printer removed: receipts use the print window");
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    }
  };

  const attempt = async (job: () => Promise<PrintResult>) => {
    setBusy(true);
    setResult(null);
    try {
      if (dirty && !(await save())) return;
      setResult(await job());
    } catch (e) {
      setResult({ status: "failed", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="printer-settings card" aria-labelledby="printer-heading">
      <h3 id="printer-heading">Receipt printer</h3>
      <p className="muted small">
        For a network (Ethernet or Wi-Fi) receipt printer. Print its self-test page to find its address. Leave the address empty to use this
        computer's normal print window. Paper size follows the receipt width above (32 = 58 mm, 48 = 80 mm).
      </p>
      <div className="row">
        <label>
          Printer address
          <input value={host} placeholder="192.168.1.50" disabled={!canSave} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label>
          Port
          <input value={port} inputMode="numeric" size={6} disabled={!canSave} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={drawer} disabled={!canSave} onChange={(e) => setDrawer(e.target.checked)} /> Open the cash drawer when a sale
        includes cash (the drawer plugs into the printer)
      </label>
      <div className="modal-actions left">
        <button className="btn btn-primary" disabled={!canSave || !dirty || busy} onClick={() => void save()}>
          Save printer
        </button>
        <button className="btn" disabled={!canSave || busy || !host.trim()} onClick={() => void attempt(() => api.printTestPage(drawer))}>
          Print a test page
        </button>
        <button className="btn" disabled={busy || !host.trim() || !can("cash.movement")} onClick={() => void attempt(() => api.openCashDrawer())}>
          Open cash drawer
        </button>
      </div>
      {result?.status === "printed" && <p role="status">Sent to the printer. If nothing came out, check the paper and the address.</p>}
      {result?.status === "failed" && (
        <p className="error" role="alert">
          {result.message}
        </p>
      )}
    </section>
  );
}
