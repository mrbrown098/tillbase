import { app, dialog, type BrowserWindow } from "electron";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ProductCsvFile } from "../shared/api.js";

/** Same limit the handlers enforce on the text. Checked here first so a huge file is never read into memory. */
const maxBytes = 5_000_000;

/**
 * Turn the bytes of a spreadsheet into text. Excel's "CSV UTF-8" and most other tools write UTF-8;
 * the plain "CSV" choice in older Excel writes Windows-1252, so fall back to that rather than show garbage.
 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * Native open and save dialogs for CSV files. This is the only place that touches the disk for
 * the CSV screen: the page asks, the person chooses a file in the system dialog, and the main
 * process reads or writes it. The page never gets a path to read from or write to.
 *
 * `dialog.*` is looked up at call time (not destructured) so an end-to-end test can stub it.
 */
export function createFileDialogs(getWindow: () => BrowserWindow | null) {
  return {
    async openCsv(): Promise<ProductCsvFile | null> {
      const options = {
        title: "Choose your product list",
        properties: ["openFile" as const],
        filters: [{ name: "Spreadsheet (CSV)", extensions: ["csv"] }],
      };
      const win = getWindow();
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      const path = picked.filePaths[0];
      if (picked.canceled || !path) return null;

      if (extname(path).toLowerCase() !== ".csv") {
        throw new Error("Please choose a .csv file. In Excel, use Save As and pick CSV.");
      }
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        throw new Error("Tillbase could not open that file. Is it still there?");
      }
      if (size > maxBytes) {
        throw new Error("That file is too big to import at once (over 5 MB). Please split it into smaller files.");
      }
      try {
        return { name: basename(path), text: decodeCsv(await readFile(path)) };
      } catch {
        throw new Error("Tillbase could not read that file. Is it open in another program?");
      }
    },

    /** Returns where the file was saved, or null if the person cancelled. */
    async saveCsv(suggestedName: string, text: string): Promise<string | null> {
      const options = {
        title: "Save as",
        defaultPath: join(app.getPath("documents"), suggestedName),
        filters: [{ name: "Spreadsheet (CSV)", extensions: ["csv"] }],
      };
      const win = getWindow();
      const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (chosen.canceled || !chosen.filePath) return null;
      const path = extname(chosen.filePath).toLowerCase() === ".csv" ? chosen.filePath : `${chosen.filePath}.csv`;
      try {
        await writeFile(path, text, "utf8");
      } catch {
        throw new Error("Tillbase could not save the file there. Please pick another folder.");
      }
      return path;
    },
  };
}
