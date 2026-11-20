import { app, BrowserWindow, ipcMain, shell } from "electron";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { backupDatabase, openDatabase } from "@tillbase/core";
import { channels, type IpcResult, type TillbaseApi } from "../shared/api.js";
import { createFileDialogs } from "./files.js";
import { createHandlers } from "./handlers.js";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

function databasePath(): string {
  // TILLBASE_DB lets you point the app at another file, e.g. for testing.
  const path = process.env.TILLBASE_DB ?? join(app.getPath("userData"), "tillbase.sqlite");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return path;
}

function registerIpc(api: TillbaseApi): void {
  for (const name of channels) {
    ipcMain.handle(name, async (_event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      try {
        const fn = api[name] as (...a: unknown[]) => Promise<unknown>;
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: "Tillbase",
    backgroundColor: "#f4f5f7",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Never let the app window navigate away or open new windows inside itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!devServerUrl || !url.startsWith(devServerUrl)) event.preventDefault();
  });

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(join(__dirname, "..", "dist", "index.html"));
  return win;
}

void app.whenReady().then(() => {
  const path = databasePath();
  const db = openDatabase(path);
  // Daily copies of the shop's data, kept next to it. Skipped for in-memory test databases.
  const backupDir = join(dirname(path), "backups");
  const backup = () => backupDatabase(db, backupDir);
  const quietBackup = () => {
    if (path !== ":memory:") backup().catch((e) => console.error("Backup failed:", e));
  };
  quietBackup();
  const files = createFileDialogs(() => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  registerIpc(createHandlers(db, "T1", Date.now, { backup, afterShiftClose: quietBackup, files }));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("before-quit", () => db.close());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
