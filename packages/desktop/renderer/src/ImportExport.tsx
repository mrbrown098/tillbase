import { useMemo, useState } from "react";
import type { ProductCsvFile, ProductCsvOptions, ProductCsvReport } from "../../shared/api";
import { api } from "./api";
import { useApp } from "./context";
import { stockLogText } from "./csv-text";
import { Modal } from "./Modal";

type Step = "start" | "preview" | "done";

/** The most rows drawn at once, so a very long file does not freeze the screen. */
const rowLimit = 300;

const actionText = {
  created: "Will be added",
  updated: "Will be updated",
  skipped: "Left as it is",
  failed: "Problem: not imported",
} as const;

const doneText = {
  created: "Added",
  updated: "Updated",
  skipped: "Left as it is",
  failed: "Problem: not imported",
} as const;

function today(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Bring menu items in from a spreadsheet, or save them out to one.
 * Flow: choose a file, look over the preview, confirm, read the result.
 * Nothing is saved until the person has seen the preview and pressed Import,
 * and the app itself refuses an import that was not previewed first.
 */
export function ImportExport({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { toast } = useApp();
  const [step, setStep] = useState<Step>("start");
  const [file, setFile] = useState<ProductCsvFile | null>(null);
  const [options, setOptions] = useState<Required<ProductCsvOptions>>({
    updateExisting: true,
    fixStock: false,
    skipBadRows: false,
  });
  const [report, setReport] = useState<ProductCsvReport | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const preview = async (f: ProductCsvFile, o: Required<ProductCsvOptions>) => {
    const r = await api.previewProductCsv(f.text, o);
    setReport(r);
    setOnlyProblems(r.failed > 0);
    setStep("preview");
  };

  const choose = () =>
    run(async () => {
      setSaved("");
      const f = await api.chooseProductCsv();
      if (!f) return; // they closed the file window: nothing to do
      setFile(f);
      await preview(f, options);
    });

  /** Changing a choice that affects the plan shows a fresh preview, so what you see is what will happen. */
  const change = (patch: Partial<Required<ProductCsvOptions>>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    if (file && ("updateExisting" in patch || "fixStock" in patch)) void run(() => preview(file, next));
  };

  const confirm = () =>
    run(async () => {
      if (!file) return;
      const r = await api.importProductCsv(file.text, options);
      setReport(r);
      setStep("done");
      if (!r.nothingWritten) {
        onChanged();
        toast("Your menu has been updated");
      }
    });

  const save = (suggestedName: string, getText: () => Promise<string>, doneMessage: string) =>
    run(async () => {
      setSaved("");
      const path = await api.saveCsvFile(suggestedName, await getText());
      if (path) setSaved(`${doneMessage} ${path}`);
    });

  const startOver = () => {
    setStep("start");
    setFile(null);
    setReport(null);
    setError("");
    setSaved("");
  };

  return (
    <Modal title="Import or export menu items" onClose={onClose} wide>
      <div className="csv-screen">
        {step === "start" && (
          <>
            <p>
              Bring your menu in from a spreadsheet, or save a copy of it. You will see exactly what will change before
              anything is saved.
            </p>
            <p className="muted small">
              Only <strong>menu items</strong> are included. Ingredients, recipes and add-ons are not part of this file, so
              they are not exported and an import never changes them.
            </p>
            <div className="csv-actions">
              <button className="btn btn-primary" onClick={() => void choose()} disabled={busy}>
                Choose a file to import…
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void save("tillbase-menu-template.csv", () => api.productCsvTemplate(), "Template saved to")
                }
              >
                Download template
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void save(`tillbase-menu-${today()}.csv`, () => api.exportProductCsv(), "Your menu was saved to")
                }
              >
                Export my menu
              </button>
            </div>
            <p className="muted small">
              New to this? Download the template, fill it in with Excel or Google Sheets, save it as CSV, then choose it here.
              Only the name and the price are needed for each new item. A blank cell means "leave this as it is", never "erase it".
            </p>
            {saved && (
              <p className="csv-ok" role="status">
                {saved}
              </p>
            )}
          </>
        )}

        {step === "preview" && report && file && (
          <Preview
            report={report}
            file={file}
            options={options}
            onlyProblems={onlyProblems}
            setOnlyProblems={setOnlyProblems}
            busy={busy}
            change={change}
            choose={() => void choose()}
          />
        )}

        {step === "done" && report && <Done report={report} fixStock={options.fixStock} />}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          {step === "start" && (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
          {step === "preview" && report && (
            <>
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void confirm()}
                disabled={busy || report.created + report.updated === 0 || (report.failed > 0 && !options.skipBadRows)}
              >
                {report.created + report.updated === 0
                  ? "Nothing to import"
                  : `Import ${plural(report.created + report.updated, "item", "items")}`}
              </button>
            </>
          )}
          {step === "done" && (
            <>
              <button className="btn" onClick={startOver}>
                Import another file
              </button>
              <button className="btn btn-primary" onClick={onClose}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Preview({
  report,
  file,
  options,
  onlyProblems,
  setOnlyProblems,
  busy,
  change,
  choose,
}: {
  report: ProductCsvReport;
  file: ProductCsvFile;
  options: Required<ProductCsvOptions>;
  onlyProblems: boolean;
  setOnlyProblems: (v: boolean) => void;
  busy: boolean;
  change: (patch: Partial<Required<ProductCsvOptions>>) => void;
  choose: () => void;
}) {
  const { problemsByRow, fileNotes } = useMemo(() => groupIssues(report), [report]);
  const shown = report.rows.filter((r) => !onlyProblems || r.action === "failed");
  const nothingToDo = report.created + report.updated === 0;

  return (
    <>
      <p>
        <strong>{file.name}</strong>{" "}
        <button className="btn btn-ghost" onClick={choose} disabled={busy}>
          Choose a different file
        </button>
      </p>
      <p className="muted small">This is a preview. Nothing has been saved yet.</p>

      <div className="stats csv-stats" aria-live="polite">
        <div className="stat">
          <span className="stat-label">Will be added</span>
          <span className="stat-value">{report.created}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Will be updated</span>
          <span className="stat-value">{report.updated}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Left as they are</span>
          <span className="stat-value">{report.skipped}</span>
        </div>
        <div className={`stat${report.failed > 0 ? " csv-stat-bad" : ""}`}>
          <span className="stat-label">Rows with a problem</span>
          <span className="stat-value">{report.failed}</span>
        </div>
      </div>
      {report.stockAdjustments > 0 && (
        <p className="muted small">
          {stockLogText(report.stockAdjustments, options.fixStock, false)}
        </p>
      )}

      {fileNotes.length > 0 && (
        <ul className="csv-notes">
          {fileNotes.map((n, i) => (
            <li key={i} className={n.severity === "error" ? "csv-note-error" : "csv-note-warn"}>
              <strong>{n.severity === "error" ? "Problem:" : "Note:"}</strong> {n.text}
            </li>
          ))}
        </ul>
      )}

      {report.failed > 0 && (
        <div className="banner csv-banner" role="alert">
          <span>
            {plural(report.failed, "row has", "rows have")} a problem and will not be imported. Rows are numbered like in
            your spreadsheet, where row 1 is the heading row.
          </span>
        </div>
      )}

      {report.rows.length > 0 && (
        <>
          {report.failed > 0 && (
            <label className="check">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              Show only the rows with a problem
            </label>
          )}
          <div className="csv-scroll">
            <table className="table csv-table">
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Item</th>
                  <th>What will happen</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, rowLimit).map((r) => {
                  const problems = problemsByRow.get(r.row) ?? [];
                  return (
                    <tr key={r.row} className={r.action === "failed" ? "csv-row-failed" : ""}>
                      <td className="num">{r.row}</td>
                      <td>{r.name}</td>
                      <td>
                        {r.action === "failed" && <span aria-hidden="true">⚠ </span>}
                        {actionText[r.action]}
                      </td>
                      <td>
                        {r.note && r.action !== "failed" && <div className="muted">{r.note}</div>}
                        {problems.map((p, i) => (
                          <div key={i} className={p.severity === "error" ? "csv-note-error" : "csv-note-warn"}>
                            {p.text}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {shown.length > rowLimit && (
            <p className="muted small">
              Showing the first {rowLimit} of {shown.length} rows. The numbers above cover the whole file.
            </p>
          )}
        </>
      )}
      {report.rows.length === 0 && <p className="empty">There are no items in this file.</p>}

      <fieldset className="csv-options" disabled={busy}>
        <legend>Choices</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={options.updateExisting}
            onChange={(e) => change({ updateExisting: e.target.checked })}
          />
          Update items I already have (matched by SKU, then barcode, then name)
        </label>
        <label className="check">
          <input type="checkbox" checked={options.fixStock} onChange={(e) => change({ fixStock: e.target.checked })} />
          Also correct the stock of items I already have to match the file
        </label>
        <p className="muted small csv-hint">
          Left off, stock for items you already have is not touched, so importing a new price list will never undo a day of
          selling. Turned on, the difference is added to the stock log as a stock count.
        </p>
        {report.failed > 0 && (
          <label className="check">
            <input type="checkbox" checked={options.skipBadRows} onChange={(e) => change({ skipBadRows: e.target.checked })} />
            Skip the rows with a problem and import the rest
          </label>
        )}
      </fieldset>

      {report.failed > 0 && !options.skipBadRows && (
        <p className="muted small">
          Nothing will be imported until every problem is fixed. Fix the marked rows in your spreadsheet and choose the file
          again, or tick the box above to import the good rows only.
        </p>
      )}
      {nothingToDo && report.failed === 0 && report.rows.length > 0 && (
        <p className="muted small">Everything in this file is already in Tillbase, so there is nothing to import.</p>
      )}
    </>
  );
}

function Done({ report, fixStock }: { report: ProductCsvReport; fixStock: boolean }) {
  const { problemsByRow, fileNotes } = useMemo(() => groupIssues(report), [report]);
  const failedRows = report.rows.filter((r) => r.action === "failed");

  if (report.nothingWritten) {
    return (
      <>
        <div className="banner csv-banner" role="alert">
          <span>Nothing was saved. Your menu has not changed.</span>
        </div>
        <ul className="csv-notes">
          {fileNotes
            // The core's own "nothing was saved" line talks about an `onError` setting, which means
            // nothing to shop staff. The banner above already says it in plain words.
            .filter((n) => n.severity === "error" && !n.text.includes("onError"))
            .map((n, i) => (
              <li key={i} className="csv-note-error">
                {n.text}
              </li>
            ))}
        </ul>
        {failedRows.length > 0 && (
          <ul className="csv-notes">
            {failedRows.map((r) => (
              <li key={r.row} className="csv-note-error">
                Row {r.row} ({r.name}): {(problemsByRow.get(r.row) ?? []).map((p) => p.text).join("; ") || "problem"}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <>
      <p className="csv-ok" role="status">
        Done. Your menu has been updated.
      </p>
      <div className="stats csv-stats">
        <div className="stat">
          <span className="stat-label">{doneText.created}</span>
          <span className="stat-value">{report.created}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{doneText.updated}</span>
          <span className="stat-value">{report.updated}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{doneText.skipped}</span>
          <span className="stat-value">{report.skipped}</span>
        </div>
        <div className={`stat${report.failed > 0 ? " csv-stat-bad" : ""}`}>
          <span className="stat-label">{doneText.failed}</span>
          <span className="stat-value">{report.failed}</span>
        </div>
      </div>
      {report.stockAdjustments > 0 && (
        <p className="muted small">
          {stockLogText(report.stockAdjustments, fixStock, true)}
        </p>
      )}
      {failedRows.length > 0 && (
        <>
          <p>These rows were not imported. Fix them in your spreadsheet and import the file again.</p>
          <ul className="csv-notes">
            {failedRows.map((r) => (
              <li key={r.row} className="csv-note-error">
                Row {r.row} ({r.name}): {(problemsByRow.get(r.row) ?? []).map((p) => p.text).join("; ") || "problem"}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

interface Note {
  severity: "error" | "warning";
  text: string;
}

/** Split the issues into those about one row and those about the file as a whole (heading row, empty file). */
function groupIssues(report: ProductCsvReport): { problemsByRow: Map<number, Note[]>; fileNotes: Note[] } {
  const rowNumbers = new Set(report.rows.map((r) => r.row));
  const problemsByRow = new Map<number, Note[]>();
  const fileNotes: Note[] = [];
  for (const issue of report.issues) {
    const text = issue.column
      ? issue.row === 1
        ? `Heading "${issue.column}": ${issue.message}`
        : `${issue.column}: ${issue.message}`
      : issue.message;
    const note: Note = { severity: issue.severity, text };
    if (rowNumbers.has(issue.row)) {
      const list = problemsByRow.get(issue.row) ?? [];
      list.push(note);
      problemsByRow.set(issue.row, list);
    } else {
      fileNotes.push(issue.row === 1 || issue.row === 0 ? note : { ...note, text: `Row ${issue.row}: ${text}` });
    }
  }
  return { problemsByRow, fileNotes };
}
