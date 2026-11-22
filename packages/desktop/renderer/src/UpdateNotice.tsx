import { useEffect, useState } from "react";
import type { UpdateInfo } from "../../electron/updates";
import { api } from "./api";

const KEY = "tillbase.updateRemind";

/** "Remind me later" is remembered per version, for a day. Storage can be unavailable: then it just shows again. */
function remindedAlready(version: string): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { version: string; until: number } | null;
    return !!v && v.version === version && v.until > Date.now();
  } catch {
    return false;
  }
}

/**
 * Tells the owner a newer stable Tillbase exists. It never installs anything: "Update now" opens the official
 * download page, where the installer and its checksums are. It is only shown on the Home screen, so it can never
 * get in the way of a sale.
 */
export function UpdateNotice() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .checkForUpdate()
      .then((u) => live && u && !remindedAlready(u.version) && setInfo(u))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!info) return null;
  const later = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: info.version, until: Date.now() + 24 * 60 * 60 * 1000 }));
    } catch {
      /* storage unavailable: it will simply show again next time */
    }
    setInfo(null);
  };
  return (
    <section className="update-notice" role="status">
      <div>
        <strong>Tillbase {info.version} is available</strong>
        <span className="muted"> You have a free update waiting. Your data stays safe: the app takes a backup every day.</span>
        {open && info.notes && <pre className="update-notes">{info.notes}</pre>}
      </div>
      <div className="update-actions">
        {info.notes && (
          <button className="btn" onClick={() => setOpen(!open)}>
            {open ? "Hide notes" : "What is new"}
          </button>
        )}
        <button className="btn" onClick={later}>
          Remind me later
        </button>
        <button className="btn btn-primary" onClick={() => void api.openDownloadPage()}>
          Update now
        </button>
      </div>
    </section>
  );
}
