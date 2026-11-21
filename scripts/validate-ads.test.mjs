// Tests for scripts/validate-ads.mjs.   node --test scripts/validate-ads.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { categories, checkImageBytes, findBanned, isRealDate, readImageInfo, validateManifest } from "./validate-ads.mjs";

const TODAY = "2026-11-21";
const good = () => ({
  id: "acme-pos-2026-q4",
  sponsor: "Acme POS Hardware",
  text: "Receipt printers and barcode scanners for small shops.",
  url: "https://acme-pos.example.com/tillbase",
  category: "pos-hardware",
  start: "2026-12-01",
  end: "2027-02-28",
  weight: 5,
});
const manifest = (...ads) => ({ version: 1, updated: TODAY, slots: { footer: ads } });
const check = (m, fetchFn = null) => validateManifest(m, { today: TODAY, fetchFn });
const errorsOf = async (ad, fetchFn = null) => (await check(manifest(ad), fetchFn)).errors;
const has = (errors, part) => assert.ok(errors.some((e) => e.includes(part)), `expected an error containing "${part}", got:\n${errors.join("\n")}`);

// ---- Tiny picture builders ------------------------------------------------------------------------
function png(w, h, { animated = false, pad = 0 } = {}) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr];
  if (animated) parts.push(Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("acTL"), Buffer.alloc(12)]));
  if (pad) parts.push(Buffer.alloc(pad));
  return Buffer.concat(parts);
}
function webpX(w, h, { animated = false } = {}) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b[20] = animated ? 0x02 : 0;
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const fakeFetch = (bytes, { status = 200, length } = {}) => async () => ({
  ok: status === 200,
  status,
  headers: { get: (n) => (n.toLowerCase() === "content-length" && length !== undefined ? String(length) : null) },
  body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new Uint8Array(bytes) })), cancel: async () => {} }; } },
});

// ---- The real file ------------------------------------------------------------------------------------
test("the manifest in the repository is valid and has no sponsors yet", async () => {
  const file = resolve(fileURLToPath(import.meta.url), "..", "..", "ads", "manifest.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(await validateManifest(m, { fetchFn: null }), { errors: [], warnings: [] });
  assert.deepEqual(m.slots.footer, []);
});

test("a good ad passes", async () => {
  assert.deepEqual(await check(manifest(good())), { errors: [], warnings: [] });
});

test("every allowed category passes, and the seven from the brief are exactly the list", async () => {
  assert.deepEqual([...categories].sort(), ["accounting", "business-software", "education", "food-supply", "packaging", "payments", "pos-hardware"]);
  for (const category of categories) assert.deepEqual(await errorsOf({ ...good(), category }), []);
});

// ---- Rejections ---------------------------------------------------------------------------------------
test("rejects non-https links, for the sponsor link and the image", async () => {
  has(await errorsOf({ ...good(), url: "http://acme-pos.example.com/" }), "must start with https://");
  has(await errorsOf({ ...good(), url: "javascript:alert(1)" }), "https://");
  has(await errorsOf({ ...good(), url: "ftp://acme.example.com/x" }), "https://");
  has(await errorsOf({ ...good(), image: "http://acme.example.com/banner.png" }), "must start with https://");
});

test("rejects links that are not a real website", async () => {
  has(await errorsOf({ ...good(), url: "https://192.168.0.1/x" }), "real website name");
  has(await errorsOf({ ...good(), url: "https://localhost/x" }), "real website name");
  has(await errorsOf({ ...good(), url: "https://user:pw@acme.example.com/" }), "user name or password");
});

test("rejects unknown categories", async () => {
  has(await errorsOf({ ...good(), category: "gambling" }), "is not allowed");
  has(await errorsOf({ ...good(), category: "Payments" }), "is not allowed");
});

test("rejects missing fields and missing or impossible dates", async () => {
  for (const f of ["id", "sponsor", "text", "url", "category", "start", "end", "weight"]) {
    const ad = good();
    delete ad[f];
    has(await errorsOf(ad), `"${f}" is missing`);
  }
  has(await errorsOf({ ...good(), start: "2026-02-30" }), "real date");
  has(await errorsOf({ ...good(), end: "next month" }), "real date");
  has(await errorsOf({ ...good(), start: "2026-13-01" }), "real date");
  has(await errorsOf({ ...good(), start: "2027-03-01", end: "2027-02-01" }), "before");
});

test("rejects bad weights, ids, long text, markup and links inside the text", async () => {
  for (const weight of [0, 11, 2.5, "5", -1]) has(await errorsOf({ ...good(), weight }), '"weight"');
  has(await errorsOf({ ...good(), id: "Has Spaces" }), '"id"');
  has(await errorsOf({ ...good(), text: "x".repeat(91) }), "91 characters");
  assert.deepEqual(await errorsOf({ ...good(), text: "x".repeat(90) }), []);
  has(await errorsOf({ ...good(), text: "Buy <b>now</b>" }), "plain text");
  has(await errorsOf({ ...good(), text: "Visit https://acme.example.com today" }), "must not contain a link");
});

test("rejects duplicate ids, unknown fields (no hidden trackers) and unknown slots", async () => {
  has((await check(manifest(good(), good()))).errors, "used twice");
  has(await errorsOf({ ...good(), pixel: "https://t.example.com/1.gif" }), 'unknown field "pixel"');
  const m = manifest();
  m.slots.header = [];
  has((await check(m)).errors, 'Unknown slot "header"');
  has((await check({ version: 2, updated: TODAY, slots: {} })).errors, '"version" must be 1');
  has((await check({ version: 1, updated: "2099-01-01", slots: {} })).errors, "future");
});

test("rejects banned words in the sponsor, text, id and link", async () => {
  for (const text of ["Online casino bonus", "Cold beer delivered", "Fast payday loans", "Buy Bitcoin today", "Your computer is infected", "Click here to win", "Premium tobacco", "Sports betting odds"]) {
    has(await errorsOf({ ...good(), text }), "not allowed");
  }
  has(await errorsOf({ ...good(), sponsor: "Lucky Casino Ltd" }), '"sponsor" contains');
  has(await errorsOf({ ...good(), url: "https://best-vape-shop.example.com/" }), '"url" contains');
  has(await errorsOf({ ...good(), url: "https://acme.example.com/crypto/deals" }), '"url" contains');
  has(await errorsOf({ ...good(), id: "wine-promo" }), '"id" contains');
});

test("banned words match whole words only, so honest words are not blocked", () => {
  assert.equal(findBanned("Alphabet accounting software"), null);
  assert.equal(findBanned("Beverage cartons and cups"), null);
  assert.equal(findBanned("Swinebrook farm fresh chicken"), null);
  assert.equal(findBanned("Kitchen supplies"), null);
  assert.equal(findBanned("BEER crates"), "BEER");
  assert.equal(findBanned("Get rich   quick"), "Get rich   quick");
});

test("expired ads give a warning, not an error", async () => {
  const r = await check(manifest({ ...good(), start: "2026-01-01", end: "2026-02-01" }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
});

test("date helper", () => {
  assert.equal(isRealDate("2028-02-29"), true);
  assert.equal(isRealDate("2027-02-29"), false);
  assert.equal(isRealDate("2027-2-1"), false);
});

// ---- Images --------------------------------------------------------------------------------------------
test("reads the size of PNG and WebP pictures", () => {
  assert.deepEqual(readImageInfo(png(600, 100)), { type: "png", width: 600, height: 100, animated: false });
  assert.deepEqual(readImageInfo(webpX(468, 60)), { type: "webp", width: 468, height: 60, animated: false });
  assert.equal(readImageInfo(Buffer.from("GIF89a....................................")), null);
});

test("accepts a 600x100 picture under 100 KB, rejects bigger, heavier, moving or wrong-type pictures", async () => {
  const url = "https://cdn.acme.example.com/banner.png";
  assert.deepEqual(await errorsOf({ ...good(), image: url }, fakeFetch(png(600, 100))), []);
  assert.deepEqual(await errorsOf({ ...good(), image: "https://cdn.acme.example.com/b.webp" }, fakeFetch(webpX(600, 100))), []);
  has(await errorsOf({ ...good(), image: url }, fakeFetch(png(601, 100))), "601x100");
  has(await errorsOf({ ...good(), image: url }, fakeFetch(png(600, 101))), "600x101");
  has(await errorsOf({ ...good(), image: url }, fakeFetch(png(300, 50, { pad: 102_401 }))), "larger than 100 KB");
  has(await errorsOf({ ...good(), image: url }, fakeFetch(Buffer.alloc(10), { length: 500_000 })), "larger than 100 KB");
  has(await errorsOf({ ...good(), image: url }, fakeFetch(png(300, 50, { animated: true }))), "animated");
  has(await errorsOf({ ...good(), image: "https://cdn.acme.example.com/b.webp" }, fakeFetch(webpX(300, 50, { animated: true }))), "animated");
  has(await errorsOf({ ...good(), image: url }, fakeFetch(Buffer.from("GIF89a" + "x".repeat(60)))), "not a PNG or WebP");
  has(await errorsOf({ ...good(), image: url }, fakeFetch(Buffer.alloc(0), { status: 404 })), "HTTP 404");
});

test("rejects tracking-pixel style image links and other file types", async () => {
  has(await errorsOf({ ...good(), image: "https://t.acme.example.com/banner.png?user=123" }), "? or # part");
  has(await errorsOf({ ...good(), image: "https://acme.example.com/banner.gif" }), ".png or .webp");
  has(await errorsOf({ ...good(), image: "https://acme.example.com/banner.svg" }), ".png or .webp");
});

test("checkImageBytes catches a file over 100 KB even when it is a valid picture", () => {
  assert.ok(checkImageBytes(png(10, 10, { pad: 105_000 }), "image").some((e) => e.includes("100 KB")));
});
