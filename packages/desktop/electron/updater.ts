/**
 * Automatic updates from GitHub Releases.
 *
 * The rules, in the order the owner cares about them:
 *  1. Updating never gets in the way of selling. Checking and downloading run in the background, and
 *     nothing here waits on the network before the app is usable.
 *  2. The app never restarts by itself while a shift is open. Every sale belongs to an open shift, so
 *     "a shift is open" covers "a sale is in progress". If an update is ready and a shift is open, the
 *     question is asked the next time the app starts with no shift open, and the update is also
 *     installed when the app is closed normally.
 *  3. The owner can switch it off (Updates tab). Off means no network traffic for updates at all.
 *  4. Be honest about what cannot update itself:
 *       - Windows installer and Linux AppImage: update themselves (electron-updater).
 *       - Linux .deb: cannot update itself; the app only tells you a new version exists.
 *       - macOS: Tillbase is not signed with an Apple certificate yet, and macOS refuses to swap an
 *         unsigned app for a new one. So on macOS the app only tells you a new version exists and
 *         links to the download page. Change MAC_CAN_SELF_UPDATE when the release is signed and notarized.
 *
 * Everything that decides something lives in createUpdater(), which only talks to small interfaces so
 * it can be tested with a fake feed. startUpdater() connects it to Electron and electron-updater.
 */
import { app, BrowserWindow, dialog } from "electron";
import { ShiftService, type Db } from "@tillbase/core";

/** There is no Apple signing certificate yet, so macOS builds cannot replace themselves. */
export const MAC_CAN_SELF_UPDATE = false;

export const RELEASES_URL = "https://github.com/mrbrown098/tillbase/releases/latest";
const LATEST_RELEASE_API = "https://api.github.com/repos/mrbrown098/tillbase/releases/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
const SETTING_KEY = "autoUpdate"; // "off" switches updates off; anything else (or nothing) means on

export type UpdateStatus =
  | "off" //          switched off by the owner
  | "idle" //         on, nothing new
  | "checking"
  | "downloading"
  | "ready" //        downloaded, waiting for a restart
  | "available" //    newer version exists but this build cannot install it itself
  | "error"
  | "unavailable"; // development builds

export interface UpdateState {
  enabled: boolean;
  /** "automatic": downloads and installs itself. "manual": only tells you, and links to the download. */
  mode: "automatic" | "manual";
  status: UpdateStatus;
  currentVersion: string;
  newVersion?: string;
  percent?: number;
  lastChecked?: number;
  /** Plain-language sentence for the screen. */
  message: string;
  downloadUrl?: string;
  /** A shift is open, so a restart would be refused right now. */
  busy: boolean;
}

/** The part of electron-updater's `autoUpdater` this module uses (a fake in tests). */
export interface FeedUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterOptions {
  currentVersion: string;
  mode: "automatic" | "manual" | "unavailable";
  /** Required for mode "automatic". */
  feed?: FeedUpdater;
  /** Required for mode "manual": the newest published version and where to get it, or null if none. */
  checkManually?: () => Promise<{ version: string; url: string } | null>;
  isEnabled: () => boolean;
  setEnabled: (on: boolean) => void;
  /** True while a shift is open. */
  isBusy: () => boolean;
  now?: () => number;
  /** Runs `fn` every `ms`; returns a function that stops it. */
  every?: (fn: () => void, ms: number) => () => void;
  /** Runs `fn` once after `ms`. */
  later?: (fn: () => void, ms: number) => void;
  startDelayMs?: number;
  /** Asks the person whether to restart now. Only ever called when no shift is open. */
  askToRestart?: (version: string) => void;
  log?: (message: string) => void;
}

/** Newer than? Compares dotted numbers, e.g. 0.10.0 > 0.9.2. Pre-release suffixes sort before the release. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  return (a.pre ?? "") > (b.pre ?? "");
}

export function createUpdater(o: UpdaterOptions) {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const every = o.every ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); });
  const later = o.later ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); });
  const mode = o.mode === "unavailable" ? "manual" : o.mode;

  let status: UpdateStatus = "idle";
  let newVersion: string | undefined;
  let percent: number | undefined;
  let lastChecked: number | undefined;
  let error: string | undefined;
  let downloadUrl: string | undefined;
  let started = false;
  let stopTimer: (() => void) | undefined;

  const applyInstallOnQuit = () => {
    // Off means off: not even on quit.
    if (o.feed) o.feed.autoInstallOnAppQuit = o.isEnabled();
  };

  if (o.feed) {
    o.feed.autoDownload = true;
    applyInstallOnQuit();
    o.feed.on("checking-for-update", () => { status = "checking"; });
    o.feed.on("update-available", (info: { version: string }) => {
      newVersion = info.version;
      percent = 0;
      status = "downloading";
    });
    o.feed.on("update-not-available", () => {
      status = "idle";
      newVersion = undefined;
      lastChecked = now();
    });
    o.feed.on("download-progress", (p: { percent: number }) => {
      status = "downloading";
      percent = Math.round(p.percent);
    });
    o.feed.on("update-downloaded", (info: { version: string }) => {
      newVersion = info.version;
      percent = 100;
      status = "ready";
      lastChecked = now();
      log(`Update ${info.version} is downloaded.`);
      // Never interrupt a shift. Otherwise ask: this also fires at the start of the next run, when
      // an update downloaded earlier is still waiting.
      if (!o.isBusy()) o.askToRestart?.(info.version);
    });
    o.feed.on("error", (e: unknown) => {
      status = "error";
      error = e instanceof Error ? e.message : String(e);
      lastChecked = now();
      log(`Update check failed: ${error}`);
    });
  }

  function message(): string {
    const enabled = o.isEnabled();
    if (o.mode === "unavailable") return "Updates only work in the installed app, not in a development run.";
    if (!enabled) return "Automatic updates are switched off. Nothing is checked or downloaded.";
    switch (status) {
      case "checking": return "Looking for a new version…";
      case "downloading": return `Downloading version ${newVersion ?? ""} in the background (${percent ?? 0}%). You can keep selling.`;
      case "ready":
        return o.isBusy()
          ? `Version ${newVersion} is ready. It will not restart while a shift is open. Close the shift and restart, or it installs when you close the app.`
          : `Version ${newVersion} is ready. Restart to install it. It also installs when you close the app.`;
      case "available": return `Version ${newVersion} is available. This build cannot install updates itself; download it from the releases page.`;
      case "error": return `Could not check for updates (${error}). It will try again later. Selling is not affected.`;
      default: return mode === "manual"
        ? "You have the newest version we could find. This build only tells you about new versions; it cannot install them itself."
        : "You have the newest version.";
    }
  }

  const state = (): UpdateState => ({
    enabled: o.isEnabled(),
    mode,
    status: o.mode === "unavailable" ? "unavailable" : !o.isEnabled() ? "off" : status,
    currentVersion: o.currentVersion,
    newVersion,
    percent,
    lastChecked,
    message: message(),
    downloadUrl,
    busy: o.isBusy(),
  });

  /** Looks for an update. Never throws and never blocks anything but its own promise. */
  async function check(): Promise<UpdateState> {
    if (o.mode === "unavailable" || !o.isEnabled()) return state();
    if (status === "checking" || status === "downloading") return state();
    status = "checking";
    error = undefined;
    try {
      if (mode === "automatic" && o.feed) {
        await o.feed.checkForUpdates(); // the feed's events move the status on
        if (status === "checking") status = "idle";
        lastChecked = now();
      } else if (o.checkManually) {
        const found = await o.checkManually();
        lastChecked = now();
        if (found && isNewer(found.version, o.currentVersion)) {
          newVersion = found.version;
          downloadUrl = found.url;
          status = "available";
        } else {
          newVersion = undefined;
          status = "idle";
        }
      }
    } catch (e) {
      status = "error";
      error = e instanceof Error ? e.message : String(e);
      lastChecked = now();
      log(`Update check failed: ${error}`);
    }
    return state();
  }

  return {
    state,
    check,
    /** Check shortly after start, then once a day. Does nothing when switched off. */
    start() {
      if (started) return;
      started = true;
      const run = () => void check();
      later(run, o.startDelayMs ?? 15_000);
      stopTimer = every(run, DAY_MS);
    },
    stop() {
      stopTimer?.();
      started = false;
    },
    /** The owner switches updates on or off. */
    setEnabled(on: boolean): UpdateState {
      o.setEnabled(on);
      applyInstallOnQuit();
      if (on) void check();
      return state();
    },
    /** Restart into the downloaded version. Refused while a shift is open. */
    install(): void {
      if (mode !== "automatic" || !o.feed) throw new Error("This build cannot install updates itself. Download the new version instead.");
      if (!o.isEnabled()) throw new Error("Automatic updates are switched off");
      if (status !== "ready") throw new Error("No update has been downloaded yet");
      if (o.isBusy()) throw new Error("A shift is open. Close the shift first; the update waits.");
      o.feed.quitAndInstall(false, true);
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;

/** The newest published release, from GitHub. Used where electron-updater cannot install (macOS, .deb). */
async function latestRelease(): Promise<{ version: string; url: string } | null> {
  const res = await fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Tillbase" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean };
  if (!body.tag_name || body.draft) return null;
  return { version: body.tag_name.replace(/^v/, ""), url: body.html_url ?? RELEASES_URL };
}

function readEnabled(db: Db): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTING_KEY) as { value: string } | undefined;
  return row?.value !== "off";
}

function writeEnabled(db: Db, on: boolean): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    SETTING_KEY,
    on ? "on" : "off",
  );
}

/** Connects the updater to Electron. One import and one call from main.ts. */
export function startUpdater(db: Db): Updater {
  const shifts = new ShiftService(db);
  // A development run may point at a test feed (a folder served over HTTP with latest.yml in it).
  // Packaged builds ignore this, so nobody can redirect a shop's updates through an environment variable.
  const testFeed = !app.isPackaged ? process.env.TILLBASE_UPDATE_FEED : undefined;
  const selfUpdating =
    !!testFeed ||
    (app.isPackaged && (process.platform === "win32" || (process.platform === "linux" && !!process.env.APPIMAGE) || (process.platform === "darwin" && MAC_CAN_SELF_UPDATE)));
  const mode = selfUpdating ? "automatic" : app.isPackaged ? "manual" : "unavailable";

  let updater: Updater;
  const askToRestart = (version: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      type: "question" as const,
      buttons: ["Restart now", "Later"],
      defaultId: 1,
      cancelId: 1,
      title: "Update ready",
      message: `Tillbase ${version} is ready to install.`,
      detail: "Restart now to finish updating. If you choose Later, it installs the next time you close Tillbase.",
    };
    void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then((r) => {
      if (r.response === 0) {
        try { updater.install(); } catch (e) { console.error(e instanceof Error ? e.message : e); }
      }
    });
  };

  // Loaded only when needed, and its checking happens off the main path.
  let feed: FeedUpdater | undefined;
  if (mode === "automatic") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
    autoUpdater.autoRunAppAfterInstall = true;
    if (testFeed) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: "generic", url: testFeed });
    }
    feed = autoUpdater as unknown as FeedUpdater;
  }

  updater = createUpdater({
    currentVersion: app.getVersion(),
    mode,
    feed,
    checkManually: latestRelease,
    isEnabled: () => readEnabled(db),
    setEnabled: (on) => writeEnabled(db, on),
    isBusy: () => !!shifts.current(),
    askToRestart,
    startDelayMs: testFeed ? 1_000 : 15_000,
    log: (m) => console.log(`[updates] ${m}`),
  });
  updater.start();
  return updater;
}
