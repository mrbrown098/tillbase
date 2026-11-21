import { useCallback, useEffect, useState } from "react";
import type { BackupEntry, BackupStatus } from "@tillbase/core";
import { api } from "./api";
import { useApp } from "./context";
import { Modal } from "./Modal";

const size = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
const dayOf = (name: string) => name.replace(/^tillbase-/, "").replace(/\.sqlite$/, "");
const where = (b: BackupEntry) => (b.where === "second" ? "Second place" : "This computer");

/** Owner only: where backups are kept, back up now, and restore. */
export function Backups() {
  const { toast } = useApp();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<BackupEntry | null>(null);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.backupStatus());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      await load();
    }
  };

  const backupNow = () =>
    run(async () => {
      await api.backupNow();
      const after = await api.backupStatus();
      if (after.warning) toast("Saved on this computer, but not in your second place", "error");
      else toast(after.secondFolder ? "Backup saved in both places" : "Backup saved", "ok");
    });
  const choose = () =>
    run(async () => {
      const next = await api.chooseBackupFolder();
      if (next) toast("Second backup place saved", "ok");
    });
  const stop = () =>
    run(async () => {
      await api.clearBackupFolder();
    });

  const confirmRestore = async () => {
    if (!restoring) return;
    const target = restoring;
    setBusy(true);
    try {
      setRestarting(true);
      await api.restoreBackup(target.name, target.where);
      // Normally the app restarts before this line is reached.
    } catch (e) {
      setRestarting(false);
      setRestoring(null);
      toast((e as Error).message, "error");
      setBusy(false);
      await load();
    }
  };

  if (restarting) {
    return (
      <div className="page">
        <h1>Restoring your backup</h1>
        <p className="muted">Tillbase is restarting with the restored data. This takes a few seconds.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Backups</h1>
        <div className="presets">
          <button className="btn btn-primary" disabled={busy} onClick={() => void backupNow()}>Back up now</button>
        </div>
      </div>
      <p className="muted">
        Tillbase saves a copy of your shop's data every day and after every closed shift. Keep a second copy somewhere else,
        such as a USB drive or a Dropbox or Google Drive folder, so a lost or broken computer does not lose your sales.
      </p>

      {status?.warning && (
        <div className="warn-box" role="alert">
          <p><strong>Your second copy is not working.</strong></p>
          <p>{status.warning}</p>
        </div>
      )}

      <div className="panel" style={{ margin: "12px 0" }}>
        <h2>Second place</h2>
        {status?.secondFolder ? (
          <p>Every backup is also copied to <strong>{status.secondFolder}</strong>.</p>
        ) : (
          <p>No second place chosen yet. Backups are only on this computer.</p>
        )}
        <div className="presets">
          <button className="btn" disabled={busy} onClick={() => void choose()}>
            {status?.secondFolder ? "Choose another folder" : "Choose a folder"}
          </button>
          {status?.secondFolder && <button className="btn btn-ghost" disabled={busy} onClick={() => void stop()}>Stop copying there</button>}
        </div>
        <p className="muted">Selling is never held up by this: if the folder or drive is missing, Tillbase keeps selling and shows a warning here.</p>
      </div>

      <h2>Saved backups</h2>
      <table className="table">
        <thead>
          <tr><th>Day</th><th>Kept</th><th className="num">Size</th><th aria-label="Actions" /></tr>
        </thead>
        <tbody>
          {(status?.backups ?? []).map((b) => (
            <tr key={`${b.where}-${b.name}`}>
              <td>{dayOf(b.name)}</td>
              <td>{where(b)}</td>
              <td className="num">{size(b.sizeBytes)}</td>
              <td><button className="btn" disabled={busy} onClick={() => setRestoring(b)}>Restore…</button></td>
            </tr>
          ))}
          {status && status.backups.length === 0 && (
            <tr><td colSpan={4} className="muted">No backups yet. Press "Back up now".</td></tr>
          )}
        </tbody>
      </table>
      {status && <p className="muted">Your shop's data lives in: {status.dataFolder}</p>}

      {restoring && (
        <Modal title="Restore this backup?" onClose={() => !busy && setRestoring(null)}>
          <p>
            Tillbase will go back to how your shop was on <strong>{dayOf(restoring.name)}</strong> ({where(restoring).toLowerCase()}).
            Anything sold or changed after that day will be missing.
          </p>
          <p>
            Your current data is not thrown away: it is kept next to it in a file ending in <code>.before-restore</code>.
            Tillbase will restart and you will need to sign in again.
          </p>
          <div className="modal-actions">
            <button className="btn" disabled={busy} onClick={() => setRestoring(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void confirmRestore()}>Restore and restart</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
