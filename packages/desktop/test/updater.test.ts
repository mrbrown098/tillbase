import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createUpdater, isNewer, type FeedUpdater } from "../electron/updater";

/** A stand-in for electron-updater's autoUpdater whose "feed" we control. */
class FakeFeed extends EventEmitter implements FeedUpdater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs: unknown[][] = [];
  /** What the fake feed publishes; null means nothing newer. */
  published: string | null = null;
  fail: Error | null = null;
  async checkForUpdates() {
    this.checks++;
    this.emit("checking-for-update");
    if (this.fail) {
      this.emit("error", this.fail);
      throw this.fail;
    }
    if (!this.published) {
      this.emit("update-not-available", {});
      return null;
    }
    this.emit("update-available", { version: this.published });
    this.emit("download-progress", { percent: 42.4 });
    this.emit("update-downloaded", { version: this.published });
    return {};
  }
  quitAndInstall(...args: unknown[]) {
    this.installs.push(args);
  }
}

function setup(opts: { busy?: boolean; enabled?: boolean; version?: string } = {}) {
  const feed = new FakeFeed();
  const flags = { busy: opts.busy ?? false, enabled: opts.enabled ?? true };
  const asked: string[] = [];
  const timers: { fn: () => void; ms: number; kind: "once" | "every" }[] = [];
  const u = createUpdater({
    currentVersion: opts.version ?? "0.5.0",
    mode: "automatic",
    feed,
    isEnabled: () => flags.enabled,
    setEnabled: (on) => { flags.enabled = on; },
    isBusy: () => flags.busy,
    askToRestart: (v) => asked.push(v),
    now: () => 1_000,
    later: (fn, ms) => timers.push({ fn, ms, kind: "once" }),
    every: (fn, ms) => { timers.push({ fn, ms, kind: "every" }); return () => undefined; },
  });
  return { u, feed, flags, asked, timers };
}

describe("isNewer", () => {
  it("compares numbers, not text", () => {
    expect(isNewer("0.10.0", "0.9.2")).toBe(true);
    expect(isNewer("0.5.0", "0.5.0")).toBe(false);
    expect(isNewer("0.4.9", "0.5.0")).toBe(false);
    expect(isNewer("v1.0.0", "0.99.99")).toBe(true);
  });
  it("puts a pre-release before its release", () => {
    expect(isNewer("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(isNewer("1.0.0-beta.1", "1.0.0")).toBe(false);
  });
});

describe("updater schedule", () => {
  it("checks shortly after start and then every 24 hours, and only starts once", () => {
    const { u, timers } = setup();
    u.start();
    u.start();
    expect(timers.map((t) => [t.kind, t.ms])).toEqual([["once", 15_000], ["every", 86_400_000]]);
  });

  it("does not wait for the network before returning from start()", () => {
    const { u, feed } = setup();
    u.start();
    expect(feed.checks).toBe(0); // nothing ran inline
  });
});

describe("downloading", () => {
  it("downloads in the background and reports progress, then ready", async () => {
    const { u, feed } = setup();
    feed.published = "0.6.0";
    const state = await u.check();
    expect(feed.autoDownload).toBe(true);
    expect(state.status).toBe("ready");
    expect(state.newVersion).toBe("0.6.0");
    expect(state.percent).toBe(100);
  });

  it("says so when there is nothing newer", async () => {
    const { u } = setup();
    const state = await u.check();
    expect(state.status).toBe("idle");
    expect(state.lastChecked).toBe(1_000);
    expect(state.message).toBe("You have the newest version.");
  });

  it("an error is reported but never thrown, and the next check can succeed", async () => {
    const { u, feed } = setup();
    feed.fail = new Error("getaddrinfo ENOTFOUND github.com");
    const bad = await u.check();
    expect(bad.status).toBe("error");
    expect(bad.message).toContain("ENOTFOUND");
    expect(bad.message).toContain("Selling is not affected");
    feed.fail = null;
    feed.published = "0.6.0";
    expect((await u.check()).status).toBe("ready");
  });
});

describe("never restarts during a shift", () => {
  it("asks to restart when an update is ready and no shift is open", async () => {
    const { u, feed, asked } = setup();
    feed.published = "0.6.0";
    await u.check();
    expect(asked).toEqual(["0.6.0"]);
  });

  it("does not ask while a shift is open, and install() is refused", async () => {
    const { u, feed, asked } = setup({ busy: true });
    feed.published = "0.6.0";
    const state = await u.check();
    expect(state.status).toBe("ready");
    expect(state.busy).toBe(true);
    expect(state.message).toContain("will not restart while a shift is open");
    expect(asked).toEqual([]);
    expect(() => u.install()).toThrow(/shift is open/);
    expect(feed.installs).toEqual([]);
  });

  it("asks on the next start: the same downloaded update is announced again once the shift is closed", async () => {
    const { u, feed, flags, asked } = setup({ busy: true });
    feed.published = "0.6.0";
    await u.check();
    expect(asked).toEqual([]);
    flags.busy = false; // next start, shift closed
    // electron-updater announces a cached, already-downloaded update again on the next check
    const again = setup({ busy: false });
    again.feed.published = "0.6.0";
    await again.u.check();
    expect(again.asked).toEqual(["0.6.0"]);
    expect(u.state().busy).toBe(false);
  });

  it("installs when asked and no shift is open", async () => {
    const { u, feed } = setup();
    feed.published = "0.6.0";
    await u.check();
    u.install();
    expect(feed.installs).toEqual([[false, true]]);
  });

  it("refuses to install before anything is downloaded", () => {
    const { u } = setup();
    expect(() => u.install()).toThrow(/No update has been downloaded/);
  });
});

describe("the owner can switch it off", () => {
  it("off means no checks, no download, and no install on quit", async () => {
    const { u, feed, flags } = setup();
    expect(feed.autoInstallOnAppQuit).toBe(true);
    const off = u.setEnabled(false);
    expect(flags.enabled).toBe(false);
    expect(off.status).toBe("off");
    expect(feed.autoInstallOnAppQuit).toBe(false);
    feed.published = "0.6.0";
    await u.check();
    expect(feed.checks).toBe(0);
  });

  it("switching it on checks straight away", async () => {
    const { u, feed, flags } = setup({ enabled: false });
    feed.published = "0.6.0";
    u.setEnabled(true);
    await vi.waitFor(() => expect(feed.checks).toBe(1));
    expect(flags.enabled).toBe(true);
    expect(feed.autoInstallOnAppQuit).toBe(true);
  });

  it("install() is refused while off", async () => {
    const { u, feed } = setup();
    feed.published = "0.6.0";
    await u.check();
    u.setEnabled(false);
    expect(() => u.install()).toThrow(/switched off/);
  });
});

describe("builds that cannot update themselves (macOS unsigned, Linux .deb)", () => {
  const manual = (latest: { version: string; url: string } | null, version = "0.5.0") =>
    createUpdater({
      currentVersion: version,
      mode: "manual",
      checkManually: async () => latest,
      isEnabled: () => true,
      setEnabled: () => undefined,
      isBusy: () => false,
      now: () => 5,
    });

  it("only reports a newer version with a link, and refuses to install", async () => {
    const u = manual({ version: "0.6.0", url: "https://example.test/r" });
    const s = await u.check();
    expect(s.mode).toBe("manual");
    expect(s.status).toBe("available");
    expect(s.downloadUrl).toBe("https://example.test/r");
    expect(s.message).toContain("cannot install updates itself");
    expect(() => u.install()).toThrow(/cannot install updates itself/);
  });

  it("an older or equal published version is not an update", async () => {
    expect((await manual({ version: "0.5.0", url: "x" }).check()).status).toBe("idle");
    expect((await manual({ version: "0.4.0", url: "x" }).check()).status).toBe("idle");
    expect((await manual(null).check()).status).toBe("idle");
  });

  it("development runs report that updates do not apply", async () => {
    const u = createUpdater({ currentVersion: "0.5.0", mode: "unavailable", isEnabled: () => true, setEnabled: () => undefined, isBusy: () => false });
    expect((await u.check()).status).toBe("unavailable");
  });
});
