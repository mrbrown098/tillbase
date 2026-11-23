import { describe, expect, it } from "vitest";
import { RELEASES_PAGE, compareVersions, createUpdateChecker } from "../electron/updates";

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: "v0.6.0",
  name: "Tillbase 0.6.0",
  body: "Fixes\r\n- PIN boxes",
  html_url: `${RELEASES_PAGE}/tag/v0.6.0`,
  draft: false,
  prerelease: false,
  published_at: "2026-11-22T00:00:00Z",
  ...over,
});
const reply = (status: number, body: unknown = release()) => async () => ({ ok: status < 400, status, json: async () => body });

function make(fetch: (...a: never[]) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>, time = { t: 0 }) {
  const opened: string[] = [];
  const u = createUpdateChecker({ currentVersion: "0.5.0", fetch: fetch as never, now: () => time.t, openExternal: (x) => void opened.push(x) });
  return { u, opened, time };
}

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.4.9", "0.5.0")).toBe(-1);
  });
});

describe("update checker", () => {
  it("reports a newer stable release", async () => {
    const { u } = make(reply(200));
    expect(await u.check()).toMatchObject({ version: "0.6.0", notes: "Fixes\n- PIN boxes" });
  });
  it("ignores the same or an older version", async () => {
    expect(await make(reply(200, release({ tag_name: "v0.5.0" }))).u.check()).toBeNull();
  });
  it("ignores drafts, pre-releases, odd tags and foreign links", async () => {
    for (const over of [{ draft: true }, { prerelease: true }, { tag_name: "v0.7.0-beta.1" }, { html_url: "https://evil.example/x" }]) {
      expect(await make(reply(200, release(over))).u.check()).toBeNull();
    }
  });
  it("backs off for an hour after a rate limit, then tries again", async () => {
    let calls = 0;
    const time = { t: 0 };
    const { u } = make(async () => {
      calls++;
      return { ok: false, status: 403, json: async () => ({}) };
    }, time);
    await u.check(true);
    await u.check(true);
    expect(calls).toBe(1);
    time.t = 61 * 60 * 1000;
    await u.check(true);
    expect(calls).toBe(2);
  });
  it("returns null when offline, and the last answer if it had one", async () => {
    expect(await make(async () => Promise.reject(new Error("offline"))).u.check()).toBeNull();
    let up = true;
    const time = { t: 0 };
    const { u } = make((async () => (up ? { ok: true, status: 200, json: async () => release() } : Promise.reject(new Error("offline")))) as never, time);
    expect(await u.check()).not.toBeNull();
    up = false;
    time.t = 7 * 60 * 60 * 1000;
    expect(await u.check()).not.toBeNull();
  });
  it("opens only the official releases page", async () => {
    const { u, opened } = make(reply(200));
    await u.check();
    await u.openDownload();
    expect(opened).toEqual([`${RELEASES_PAGE}/tag/v0.6.0`]);
  });
});
