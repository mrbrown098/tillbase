/**
 * "Is there a newer Tillbase?" Asks GitHub for the latest published (not draft, not pre-release) release of
 * this project and compares it with the installed version. It only tells the person; it never downloads or
 * installs anything, and it never sends anything about the shop. Offline, rate-limited or odd answers all
 * mean "nothing to report".
 */

export const RELEASES_API = "https://api.github.com/repos/mrbrown098/tillbase/releases/latest";
export const RELEASES_PAGE = "https://github.com/mrbrown098/tillbase/releases";

export interface UpdateInfo {
  version: string;
  name: string;
  /** Release notes, shortened. Plain text. */
  notes: string;
  /** The release's own page on github.com/mrbrown098/tillbase. */
  url: string;
  publishedAt: string | null;
}

/** 1 if a is newer than b, -1 if older, 0 if the same. Ignores a leading "v". Pre-release parts are not newer. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => v.replace(/^v/i, "").split("-")[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface UpdateCheckOptions {
  currentVersion: string;
  fetch?: Fetcher;
  now?: () => number;
  /** Reuse a good answer this long. */
  cacheMs?: number;
  openExternal: (url: string) => void | Promise<void>;
}

export function createUpdateChecker(opts: UpdateCheckOptions) {
  const doFetch: Fetcher = opts.fetch ?? ((u, i) => fetch(u, i) as ReturnType<Fetcher>);
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 6 * 60 * 60 * 1000;
  let last: { at: number; value: UpdateInfo | null } | null = null;
  let blockedUntil = 0;

  async function check(force = false): Promise<UpdateInfo | null> {
    if (process.env.TILLBASE_NO_UPDATE_CHECK === "1") return null;
    if (!force && last && now() - last.at < cacheMs) return last.value;
    if (now() < blockedUntil) return last?.value ?? null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const res = await doFetch(RELEASES_API, { signal: ctl.signal, headers: { Accept: "application/vnd.github+json", "User-Agent": "Tillbase" } });
      if (res.status === 403 || res.status === 429) {
        blockedUntil = now() + 60 * 60 * 1000; // rate limited: try again in an hour
        return last?.value ?? null;
      }
      if (!res.ok) return last?.value ?? null;
      const r = (await res.json()) as { tag_name?: unknown; name?: unknown; body?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown };
      let value: UpdateInfo | null = null;
      const tag = typeof r.tag_name === "string" ? r.tag_name : "";
      const url = typeof r.html_url === "string" ? r.html_url : "";
      if (r.draft !== true && r.prerelease !== true && /^v?\d+\.\d+\.\d+$/.test(tag) && url.startsWith(RELEASES_PAGE) && compareVersions(tag, opts.currentVersion) > 0) {
        const notes = typeof r.body === "string" ? r.body.replace(/\r/g, "").trim() : "";
        value = {
          version: tag.replace(/^v/i, ""),
          name: typeof r.name === "string" && r.name ? r.name : `Tillbase ${tag}`,
          notes: notes.length > 1500 ? notes.slice(0, 1500).trimEnd() + "..." : notes,
          url,
          publishedAt: typeof r.published_at === "string" ? r.published_at : null,
        };
      }
      last = { at: now(), value };
      return value;
    } catch {
      return last?.value ?? null; // offline or too slow: nothing to report
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    check,
    /** Opens the official releases page (or this release's page) in the person's browser. */
    async openDownload(): Promise<void> {
      const target = last?.value?.url ?? RELEASES_PAGE;
      if (target.startsWith(RELEASES_PAGE)) await opts.openExternal(target);
    },
  };
}
