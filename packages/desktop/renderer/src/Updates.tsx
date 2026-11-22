import { useCallback, useEffect, useState } from "react";
import type { UpdateInfo } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";

/** Owner only: which version this is, whether it updates itself, and a switch to turn that off. */
export function Updates() {
  const { toast } = useApp();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api.updateState());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);

  // Look again every few seconds while something is happening, otherwise every half minute.
  useEffect(() => {
    void load();
    const fast = info?.status === "checking" || info?.status === "downloading";
    const t = setInterval(() => void load(), fast ? 2000 : 30_000);
    return () => clearInterval(t);
  }, [load, info?.status]);

  const run = async (work: () => Promise<UpdateInfo | void>) => {
    setBusy(true);
    try {
      const next = await work();
      if (next) setInfo(next);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="page"><h1>Updates</h1></div>;
  const dev = info.status === "unavailable";

  return (
    <div className="page">
      <div className="page-head">
        <h1>Updates</h1>
        <div className="presets">
          <button className="btn btn-primary" disabled={busy || dev || !info.enabled} onClick={() => void run(() => api.updateCheck())}>
            Check now
          </button>
        </div>
      </div>
      <p className="muted">
        Tillbase looks for a new version when it starts and once a day, and downloads it in the background. You can keep selling while it
        does. It never restarts while a shift is open.
      </p>

      <div className="panel" style={{ margin: "12px 0" }}>
        <div className="stat-label">You have version {info.currentVersion}</div>
        <p role="status" data-testid="update-message">{info.message}</p>
        {info.status === "downloading" && <progress max={100} value={info.percent ?? 0} aria-label="Download progress" />}
        {info.status === "ready" && (
          <button className="btn btn-primary" disabled={busy || info.busy} onClick={() => void run(async () => { await api.updateInstall(); })}>
            Restart and update
          </button>
        )}
        {info.status === "available" && info.downloadUrl && (
          <p>
            Download it from <code>{info.downloadUrl}</code> and install it over this one. Your data is kept.
          </p>
        )}
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={info.enabled}
          disabled={busy || dev}
          onChange={(e) => void run(() => api.updateSetEnabled(e.target.checked))}
        />{" "}
        Check for updates automatically
      </label>
      <p className="muted">
        Switched off means nothing is checked or downloaded and nothing is installed when you close the app. You can still download new
        versions yourself from the releases page.
      </p>
      {info.mode === "manual" && !dev && (
        <p className="muted">
          This build cannot install updates by itself (macOS builds are not signed yet, and the Linux .deb has no updater). It tells you when a
          new version exists.
        </p>
      )}
    </div>
  );
}
