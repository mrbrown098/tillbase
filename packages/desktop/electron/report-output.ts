import { app, BrowserWindow, dialog, shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDF_FOOTER_TEMPLATE } from "@tillbase/core";
import { testPath } from "./files.js";

/**
 * Turns an A4 report page (built in the main process from the shop's own records) into a PDF.
 * The page is drawn in a hidden window with no scripting, no network and no access to anything else.
 * Electron draws the footer on every page: "Powered by Tillbase" and "Page x of y". It comes from the
 * report code, not from a setting.
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false, webSecurity: true, offscreen: false },
  });
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: PDF_FOOTER_TEMPLATE,
      margins: { top: 0.63, bottom: 0.71, left: 0.55, right: 0.55 }, // 16 mm, 18 mm, 14 mm (inches)
    });
  } finally {
    win.destroy();
  }
}

export function createReportOutput(getWindow: () => BrowserWindow | null) {
  return {
    /** Writes the PDF to a temporary file and opens it in the computer's PDF viewer, which can print it. */
    async open(name: string, html: string): Promise<void> {
      const pdf = await htmlToPdf(html);
      const forced = testPath("TILLBASE_TEST_REPORT_FOLDER", process.env, app.isPackaged);
      const folder = forced ?? join(app.getPath("temp"), "tillbase-reports");
      await mkdir(folder, { recursive: true });
      const file = join(folder, name);
      await writeFile(file, pdf);
      if (!forced) {
        const problem = await shell.openPath(file);
        if (problem) throw new Error(`The report was saved as ${file} but could not be opened: ${problem}`);
      }
    },
    /** Asks where to save the PDF. Null if cancelled. */
    async save(name: string, html: string): Promise<string | null> {
      const pdf = await htmlToPdf(html);
      const forced = testPath("TILLBASE_TEST_REPORT_FOLDER", process.env, app.isPackaged);
      let target: string | undefined;
      if (forced) {
        await mkdir(forced, { recursive: true });
        target = join(forced, name);
      } else {
        const win = getWindow();
        const options = { title: "Save report", defaultPath: join(app.getPath("documents"), name), filters: [{ name: "PDF", extensions: ["pdf"] }] };
        const r = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
        if (r.canceled || !r.filePath) return null;
        target = r.filePath;
      }
      await writeFile(target, pdf);
      return target;
    },
  };
}
