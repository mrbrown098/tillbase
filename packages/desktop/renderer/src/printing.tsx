import { useCallback, useState } from "react";
import type { PrintResult } from "../../shared/api";
import { useApp } from "./context";

interface Notice {
  message: string;
  again: () => void;
}

/**
 * Printing to the receipt printer from a screen. A sale is already finished when this runs, so trouble with the
 * printer only ever shows a message with "Print again": it never stops or undoes anything.
 *
 * `run(job)`: tries the printer. If no receipt printer is set up it opens the system print window instead (for a
 * button the person pressed), or does nothing (for the automatic print after a sale).
 */
export function usePrinting() {
  const { toast } = useApp();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (job: () => Promise<PrintResult>, opts: { auto?: boolean } = {}): Promise<void> => {
      setBusy(true);
      setNotice(null);
      const again = () => void run(job, opts);
      try {
        const r = await job();
        if (r.status === "printed") {
          if (!opts.auto) toast("Sent to the printer"); // the paper coming out is the answer for an automatic print
        }
        else if (r.status === "no_printer") {
          if (!opts.auto) window.print();
        } else setNotice({ message: r.message, again });
      } catch (e) {
        setNotice({ message: (e as Error).message || "Printing did not work.", again });
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const useSystemWindow = useCallback(() => {
    setNotice(null);
    window.print();
  }, []);

  return { notice, busy, run, dismiss: () => setNotice(null), useSystemWindow };
}

/** The message shown when the printer could not be used. The sale itself is fine. */
export function PrintNotice({
  notice,
  busy,
  onSystem,
  onDismiss,
}: {
  notice: Notice | null;
  busy: boolean;
  onSystem: () => void;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  return (
    <div className="print-notice" role="alert">
      <p>
        <strong>The receipt did not print.</strong> {notice.message}
      </p>
      <p className="muted small">The sale is saved. You can try again, or print from this computer's print window.</p>
      <div className="print-notice-actions">
        <button className="btn btn-primary" disabled={busy} onClick={notice.again}>
          Print again
        </button>
        <button className="btn" disabled={busy} onClick={onSystem}>
          Use the print window
        </button>
        <button className="btn" onClick={onDismiss}>
          Skip printing
        </button>
      </div>
    </div>
  );
}
