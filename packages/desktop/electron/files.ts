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
 * TEST-ONLY file paths. Native file windows cannot be clicked by an automated test, so an end-to-end
 * test can start the app with these environment variables set to skip the window:
 *
 *   TILLBASE_TEST_CSV_OPEN=/path/in.csv    "Choose a file to import" reads this file
 *   TILLBASE_TEST_CSV_SAVE=/path/out.csv   "Export" and "Download template" write to this file
 *   TILLBASE_TEST_BACKUP_FOLDER=/path/dir  "Choose a second backup place" picks this folder
 *
 * Safe by design: environment variables belong to the main process, so the page (renderer) cannot
 * set or change them, and they are ignored completely in an installed (packaged) app. When they are
 * not set, nothing here changes and the normal system window is used. Every other check (file type,
 * size, readable) still runs on the supplied path, so the test exercises the real code.
 */
export function testPath(
  name: "TILLBASE_TEST_CSV_OPEN" | "TILLBASE_TEST_CSV_SAVE" | "TILLBASE_TEST_BACKUP_FOLDER",
  env: Record<string, string | undefined>,
  isPackaged: boolean,
): string | null {
  if (isPackaged) return null;
  const value = env[name];
  return value && value.trim() !== "" ? value : null;
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
    /** The folder picked as a second backup place (a USB drive or a synced folder), or null if cancelled. */
    async chooseBackupFolder(): Promise<string | null> {
      const forced = testPath("TILLBASE_TEST_BACKUP_FOLDER", process.env, app.isPackaged);
      if (forced) return forced;
      const options = {
        title: "Choose where to keep a second copy of your backups",
        buttonLabel: "Use this folder",
        properties: ["openDirectory" as const, "createDirectory" as const],
      };
      const win = getWindow();
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },

    async openCsv(): Promise<ProductCsvFile | null> {
      const options = {
        title: "Choose your product list",
        properties: ["openFile" as const],
        filters: [{ name: "Spreadsheet (CSV)", extensions: ["csv"] }],
      };
      const forced = testPath("TILLBASE_TEST_CSV_OPEN", process.env, app.isPackaged);
      let path: string | undefined;
      if (forced) {
        path = forced;
      } else {
        const win = getWindow();
        const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        if (picked.canceled) return null;
        path = picked.filePaths[0];
      }
      if (!path) return null;

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
      let filePath: string | undefined = testPath("TILLBASE_TEST_CSV_SAVE", process.env, app.isPackaged) ?? undefined;
      if (!filePath) {
        const win = getWindow();
        const chosen = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
        if (chosen.canceled || !chosen.filePath) return null;
        filePath = chosen.filePath;
      }
      const path = extname(filePath).toLowerCase() === ".csv" ? filePath : `${filePath}.csv`;
      try {
        await writeFile(path, text, "utf8");
      } catch {
        throw new Error("Tillbase could not save the file there. Please pick another folder.");
      }
      return path;
    },
  };
}
