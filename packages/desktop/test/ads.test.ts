import { describe, expect, it } from "vitest";
import { createAdService, imageInfo, parseManifest } from "../electron/ads";

const ad = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  sponsor: "Acme POS",
  text: "Receipt printers for small shops",
  url: "https://acme.example/pos",
  category: "pos-hardware",
  start: "2026-01-01",
  end: "2026-12-31",
  weight: 5,
  ...over,
});
const manifest = (ads: unknown[]) => JSON.stringify({ version: 1, updated: "2026-11-01", slots: { footer: ads } });

/** A tiny PNG header with the given size (only the bytes the checker reads). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}

function fakeFetch(files: Record<string, { body: string | Uint8Array; status?: number }>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const f = files[url];
    if (!f) throw new Error("offline");
    const bytes = typeof f.body === "string" ? new TextEncoder().encode(f.body) : f.body;
    return {
      ok: (f.status ?? 200) < 400,
      status: f.status ?? 200,
      headers: { get: () => null },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };
  return { fetch, calls };
}

const URL_ = "https://example.test/manifest.json";
const make = (files: Parameters<typeof fakeFetch>[0], extra: Partial<Parameters<typeof createAdService>[0]> = {}) => {
  const f = fakeFetch(files);
  const opened: string[] = [];
  const svc = createAdService({
    fetch: f.fetch,
    manifestUrl: URL_,
    now: () => new Date(2026, 10, 22),
    random: () => 0,
    openExternal: (u) => void opened.push(u),
    enabled: () => true,
    ...extra,
  });
  return { svc, opened, ...f };
};

describe("parseManifest", () => {
  it("accepts a valid ad", () => {
    expect(parseManifest(manifest([ad()]))).toHaveLength(1);
  });
  it("drops non-https links, bad categories, bad dates, links inside the text, and duplicate ids", () => {
    const list = parseManifest(
      manifest([
        ad({ id: "http", url: "http://acme.example" }),
        ad({ id: "cat", category: "gambling" }),
        ad({ id: "date", start: "2026-12-31", end: "2026-01-01" }),
        ad({ id: "link", text: "visit https://x.example now" }),
        ad({ id: "markup", text: "<b>hi</b>" }),
        ad({ id: "long", text: "x".repeat(91) }),
        ad({ id: "w", weight: 11 }),
        ad({ id: "ok" }),
        ad({ id: "ok", sponsor: "Copy" }),
      ]),
    );
    expect(list.map((a) => a.id)).toEqual(["ok"]);
  });
  it("returns nothing for garbage or a wrong version", () => {
    expect(parseManifest("not json")).toEqual([]);
    expect(parseManifest(JSON.stringify({ version: 2, slots: { footer: [ad()] } }))).toEqual([]);
  });
});

describe("imageInfo", () => {
  it("reads PNG size from the real bytes", () => {
    expect(imageInfo(png(300, 50))).toEqual({ type: "png", width: 300, height: 50 });
  });
  it("rejects other formats", () => {
    expect(imageInfo(new Uint8Array(60))).toBeNull();
  });
});

describe("ad service", () => {
  it("shows a live ad and opens only its own https link", async () => {
    const { svc, opened } = make({ [URL_]: { body: manifest([ad()]) } });
    const v = await svc.current();
    expect(v).toMatchObject({ id: "a1", sponsor: "Acme POS", image: null });
    await svc.open("a1");
    await svc.open("something-else");
    expect(opened).toEqual(["https://acme.example/pos"]);
  });
  it("skips ads outside their dates", async () => {
    const { svc } = make({ [URL_]: { body: manifest([ad({ start: "2027-01-01", end: "2027-02-01" })]) } });
    expect(await svc.current()).toBeNull();
  });
  it("shows nothing when the owner turned sponsors off, and does not even fetch", async () => {
    const { svc, calls } = make({ [URL_]: { body: manifest([ad()]) } }, { enabled: () => false });
    expect(await svc.current()).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("shows nothing offline", async () => {
    const { svc } = make({});
    expect(await svc.current()).toBeNull();
  });
  it("keeps the last good list during a short outage", async () => {
    let up = true;
    const good = fakeFetch({ [URL_]: { body: manifest([ad()]) } });
    let t = 0;
    const svc = createAdService({
      fetch: ((u: string, i: never) => (up ? good.fetch(u) : Promise.reject(new Error("offline")))) as never,
      manifestUrl: URL_,
      now: () => new Date(2026, 10, 22, 0, 0, t++ * 3600),
      openExternal: () => undefined,
      enabled: () => true,
      cacheMs: 1,
    });
    expect(await svc.current()).not.toBeNull();
    up = false;
    expect(await svc.current()).not.toBeNull();
  });
  it("rejects a manifest bigger than the limit", async () => {
    const { svc } = make({ [URL_]: { body: manifest([ad()]) + " ".repeat(70 * 1024) } });
    expect(await svc.current()).toBeNull();
  });
  it("includes a picture only when it is a small PNG, and drops oversized or wrong-type ones", async () => {
    const img = "https://acme.example/b.png";
    const ok = make({ [URL_]: { body: manifest([ad({ image: img })]) }, [img]: { body: png(468, 60) } });
    expect((await ok.svc.current())?.image).toMatch(/^data:image\/png;base64,/);
    const big = make({ [URL_]: { body: manifest([ad({ image: img })]) }, [img]: { body: png(1200, 400) } });
    expect((await big.svc.current())?.image).toBeNull();
    const wrong = make({ [URL_]: { body: manifest([ad({ image: img })]) }, [img]: { body: "<svg></svg>" } });
    expect((await wrong.svc.current())?.image).toBeNull();
  });
});
