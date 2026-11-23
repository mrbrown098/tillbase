/**
 * Sponsor banner: reads the public sponsor list (ads/manifest.json in the Tillbase repository), picks one
 * message that is allowed today, and hands the page a plain picture and text. Nothing from the shop is ever
 * sent: the only request is a plain GET of that one file, plus the sponsor's still picture if it has one.
 *
 * No third-party script is ever run. Anything that does not pass the checks below is dropped, and when
 * anything goes wrong (no internet, bad file, nothing to show) the answer is simply "no banner".
 */

export const MANIFEST_URL = "https://raw.githubusercontent.com/mrbrown098/tillbase/main/ads/manifest.json";

/** Same limits and list as ads/manifest.schema.json. */
export const AD_LIMITS = { manifestBytes: 64 * 1024, imageBytes: 102_400, imageMaxWidth: 600, imageMaxHeight: 100, textChars: 90 };
export const AD_CATEGORIES = ["pos-hardware", "payments", "packaging", "accounting", "food-supply", "business-software", "education"] as const;

export interface AdView {
  id: string;
  sponsor: string;
  text: string;
  /** A data: URL for the sponsor's still picture, or null for a text-only banner. */
  image: string | null;
}

interface Ad {
  id: string;
  sponsor: string;
  text: string;
  image?: string;
  url: string;
  category: string;
  start: string;
  end: string;
  weight: number;
}

type Fetcher = (url: string, init: { signal: AbortSignal; headers?: Record<string, string>; redirect?: "error" | "follow" }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface AdServiceOptions {
  fetch?: Fetcher;
  now?: () => Date;
  random?: () => number;
  manifestUrl?: string;
  /** Opens a link in the person's own browser. */
  openExternal: (url: string) => void | Promise<void>;
  /** The owner's switch (Settings). */
  enabled: () => boolean;
  /** How long a good answer is reused, in ms. */
  cacheMs?: number;
}

const isHttps = (u: unknown): u is string => {
  if (typeof u !== "string") return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};
const isDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

/** Keep only well-formed ads. A bad entry is skipped, never repaired. */
export function parseManifest(text: string): Ad[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const m = raw as { version?: unknown; slots?: { footer?: unknown } };
  if (!m || m.version !== 1 || !Array.isArray(m.slots?.footer)) return [];
  const ads: Ad[] = [];
  for (const a of m.slots.footer as Partial<Ad>[]) {
    if (!a || typeof a !== "object") continue;
    const ok =
      typeof a.id === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(a.id) &&
      typeof a.sponsor === "string" && a.sponsor.length >= 1 && a.sponsor.length <= 60 &&
      typeof a.text === "string" && a.text.length >= 1 && a.text.length <= AD_LIMITS.textChars &&
      isHttps(a.url) && (a.image === undefined || (isHttps(a.image) && !new URL(a.image).search)) &&
      typeof a.category === "string" && (AD_CATEGORIES as readonly string[]).includes(a.category) &&
      isDay(a.start) && isDay(a.end) && a.start <= a.end &&
      Number.isInteger(a.weight) && a.weight! >= 1 && a.weight! <= 10;
    // The text must be plain: no markup and no link in it.
    if (ok && !/[<>]|https?:|www\./i.test(a.text!)) ads.push(a as Ad);
  }
  // Unique ids only: the first one wins.
  const seen = new Set<string>();
  return ads.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

/** Width and height of a PNG or WebP file, or null if it is neither. Checks the real bytes, not the name. */
export function imageInfo(b: Uint8Array): { type: "png" | "webp"; width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const at = (i: number) => b[i] ?? 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 30 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8X") return { type: "webp", width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) };
    if (kind === "VP8L") {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return { type: "webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === "VP8 ") return { type: "webp", width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
  }
  return null;
}

export function createAdService(opts: AdServiceOptions) {
  const doFetch: Fetcher = opts.fetch ?? ((url, init) => fetch(url, init) as ReturnType<Fetcher>);
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? Math.random;
  const url = opts.manifestUrl ?? MANIFEST_URL;
  const cacheMs = opts.cacheMs ?? 6 * 60 * 60 * 1000;
  let ads: Ad[] = [];
  let loadedAt = 0;
  const images = new Map<string, string | null>();

  async function get(u: string, maxBytes: number): Promise<{ bytes: Uint8Array; type: string } | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await doFetch(u, { signal: ctl.signal, redirect: "error", headers: { "User-Agent": "Tillbase" } });
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > maxBytes) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > maxBytes) return null;
      return { bytes: buf, type: res.headers.get("content-type") ?? "" };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(): Promise<void> {
    const got = await get(url, AD_LIMITS.manifestBytes);
    // On failure keep whatever we had: a short outage must not blank the banner, and nothing breaks.
    if (got) {
      ads = parseManifest(new TextDecoder().decode(got.bytes));
      loadedAt = now().getTime();
      images.clear();
    }
  }

  async function imageFor(ad: Ad): Promise<string | null> {
    if (!ad.image) return null;
    if (images.has(ad.id)) return images.get(ad.id)!;
    let data: string | null = null;
    const got = await get(ad.image, AD_LIMITS.imageBytes);
    if (got) {
      const info = imageInfo(got.bytes);
      if (info && info.width <= AD_LIMITS.imageMaxWidth && info.height <= AD_LIMITS.imageMaxHeight && info.width > 0 && info.height > 0) {
        data = `data:image/${info.type};base64,${Buffer.from(got.bytes).toString("base64")}`;
      }
    }
    images.set(ad.id, data);
    return data;
  }

  function today(): string {
    const d = now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  return {
    /** The banner to show now, or null. Never throws and never waits on the network for long. */
    async current(): Promise<AdView | null> {
      if (!opts.enabled() || process.env.TILLBASE_NO_ADS === "1") return null;
      if (now().getTime() - loadedAt > cacheMs) await refresh();
      const day = today();
      const live = ads.filter((a) => a.start <= day && day <= a.end);
      if (live.length === 0) return null;
      const total = live.reduce((n, a) => n + a.weight, 0);
      let pick = random() * total;
      const chosen = live.find((a) => (pick -= a.weight) < 0) ?? live[live.length - 1];
      if (!chosen) return null;
      return { id: chosen.id, sponsor: chosen.sponsor, text: chosen.text, image: await imageFor(chosen) };
    },
    /** Opens the sponsor's page, but only for an ad this service itself showed. */
    async open(id: string): Promise<void> {
      const ad = ads.find((a) => a.id === id);
      if (ad && isHttps(ad.url)) await opts.openExternal(ad.url);
    },
  };
}
