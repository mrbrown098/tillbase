// Checks ads/manifest.json against the sponsor policy in ads/README.md.
//
//   node scripts/validate-ads.mjs                 check ads/manifest.json (downloads each image to measure it)
//   node scripts/validate-ads.mjs --offline       skip the image download (the other checks still run)
//   node scripts/validate-ads.mjs path/to/other.json
//
// It rejects: anything that is not https, unknown categories, missing or impossible dates, an end before
// the start, duplicate ids, a message over 90 characters, banned words, extra fields (so nothing can
// carry a tracker), images that are not PNG/WebP, animated, larger than 600x100 pixels or 100 KB, and
// image links with a query string (a classic tracking pixel).
//
// The categories and limits are read from ads/manifest.schema.json so they are written down only once.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const adsDir = resolve(root, "ads");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export const schema = readJson(resolve(adsDir, "manifest.schema.json"));
export const banned = readJson(resolve(adsDir, "banned-words.json")).words;

const adSchema = schema.$defs.ad;
const limits = schema["x-limits"];
export const categories = adSchema.properties.category.enum;
export const slotNames = Object.keys(schema.properties.slots.properties);
const textMax = adSchema.properties.text.maxLength;
const sponsorMax = adSchema.properties.sponsor.maxLength;
const weightMin = adSchema.properties.weight.minimum;
const weightMax = adSchema.properties.weight.maximum;
const allowedAdFields = Object.keys(adSchema.properties);
const requiredAdFields = adSchema.required;
const idPattern = new RegExp(adSchema.properties.id.pattern);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bannedPattern = new RegExp(`(?<![a-z0-9])(?:${banned.map((w) => escapeRegex(w.toLowerCase()).replace(/\s+/g, "\\s+")).join("|")})(?![a-z0-9])`, "i");

/** The first banned word or phrase in some text, or null. */
export function findBanned(text) {
  const m = bannedPattern.exec(String(text).normalize("NFKC").replace(/[_\-./]+/g, " "));
  return m ? m[0] : null;
}

/** True for a real calendar day written YYYY-MM-DD. */
export function isRealDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Problems with a link, as a list of sentences. */
export function checkUrl(value, label) {
  const problems = [];
  if (typeof value !== "string" || value.trim() === "") return [`${label} is missing`];
  let u;
  try {
    u = new URL(value);
  } catch {
    return [`${label} is not a valid address: ${value}`];
  }
  if (u.protocol !== "https:") problems.push(`${label} must start with https:// (got ${u.protocol}//)`);
  if (u.username || u.password) problems.push(`${label} must not contain a user name or password`);
  if (value.length > 300) problems.push(`${label} is longer than 300 characters`);
  const host = u.hostname;
  if (!host.includes(".") || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) {
    problems.push(`${label} must use a real website name, not an IP address or a local name (${host})`);
  }
  return problems;
}

// ---- Image headers ------------------------------------------------------------------------------------

/** Width, height and whether it moves, read from the first bytes of a PNG or WebP file. */
export function readImageInfo(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const animated = b.includes(Buffer.from("acTL")); // APNG animation control chunk
    return { type: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20), animated };
  }
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    const animated = b.includes(Buffer.from("ANIM")) || (kind === "VP8X" && (b[20] & 0x02) !== 0);
    if (kind === "VP8X") return { type: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), animated };
    if (kind === "VP8 ") return { type: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, animated };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated };
    }
  }
  return null;
}

/** Problems with an image file's bytes. */
export function checkImageBytes(bytes, label) {
  const problems = [];
  if (bytes.length > limits.imageMaxBytes) problems.push(`${label} is larger than ${limits.imageMaxBytes / 1024} KB`);
  const info = readImageInfo(bytes);
  if (!info) return [...problems, `${label} is not a PNG or WebP picture`];
  if (info.animated) problems.push(`${label} is animated; only still pictures are allowed`);
  if (info.width > limits.imageMaxWidth || info.height > limits.imageMaxHeight) {
    problems.push(`${label} is ${info.width}x${info.height}; the most allowed is ${limits.imageMaxWidth}x${limits.imageMaxHeight}`);
  }
  if (info.width < 1 || info.height < 1) problems.push(`${label} has no size`);
  return problems;
}

async function downloadImage(url, fetchFn) {
  const res = await fetchFn(url, { redirect: "error", headers: { accept: "image/png,image/webp" } });
  if (!res.ok) throw new Error(`could not be downloaded (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > limits.imageMaxBytes) return { tooBig: true, bytes: Buffer.alloc(0) };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(Buffer.from(value));
    if (total > limits.imageMaxBytes) {
      await reader.cancel();
      return { tooBig: true, bytes: Buffer.concat(chunks) };
    }
  }
  return { tooBig: false, bytes: Buffer.concat(chunks) };
}

// ---- The manifest --------------------------------------------------------------------------------------

/**
 * Check a parsed manifest. Returns { errors, warnings } (lists of sentences that name the ad).
 * options.today: "YYYY-MM-DD" (default: today, UTC)
 * options.fetchFn: fetch to use for images, or null to skip downloading them
 */
export async function validateManifest(manifest, options = {}) {
  const errors = [];
  const warnings = [];
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const fetchFn = options.fetchFn === undefined ? globalThis.fetch : options.fetchFn;
  const err = (m) => errors.push(m);

  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { errors: ["The manifest must be a JSON object."], warnings };
  }
  for (const key of Object.keys(manifest)) if (!["version", "updated", "slots"].includes(key)) err(`Unknown top-level field "${key}".`);
  if (manifest.version !== 1) err(`"version" must be 1 (got ${JSON.stringify(manifest.version)}).`);
  if (!isRealDate(manifest.updated)) err(`"updated" must be a real date written YYYY-MM-DD (got ${JSON.stringify(manifest.updated)}).`);
  else if (manifest.updated > today) err(`"updated" is in the future (${manifest.updated}).`);
  if (manifest.slots === null || typeof manifest.slots !== "object" || Array.isArray(manifest.slots)) {
    err(`"slots" must be an object.`);
    return { errors, warnings };
  }
  for (const key of Object.keys(manifest.slots)) if (!slotNames.includes(key)) err(`Unknown slot "${key}". Known slots: ${slotNames.join(", ")}.`);

  const seen = new Set();
  for (const slot of slotNames) {
    const list = manifest.slots[slot];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      err(`Slot "${slot}" must be a list.`);
      continue;
    }
    for (const [i, ad] of list.entries()) {
      const name = `${slot}[${i}]${ad && typeof ad.id === "string" ? ` (${ad.id})` : ""}`;
      const bad = (m) => err(`${name}: ${m}`);
      if (ad === null || typeof ad !== "object" || Array.isArray(ad)) {
        bad("must be an object");
        continue;
      }
      for (const f of Object.keys(ad)) if (!allowedAdFields.includes(f)) bad(`unknown field "${f}" (extra fields are not allowed)`);
      for (const f of requiredAdFields) if (ad[f] === undefined || ad[f] === null || ad[f] === "") bad(`"${f}" is missing`);

      if (typeof ad.id === "string") {
        if (!idPattern.test(ad.id)) bad(`"id" must be lower-case letters, digits and dashes, 2 to 40 characters`);
        if (seen.has(ad.id)) bad(`"id" is used twice`);
        seen.add(ad.id);
      }
      if (typeof ad.sponsor === "string" && ad.sponsor.length > sponsorMax) bad(`"sponsor" is longer than ${sponsorMax} characters`);
      if (ad.sponsor !== undefined && typeof ad.sponsor !== "string") bad(`"sponsor" must be text`);
      if (ad.text !== undefined) {
        if (typeof ad.text !== "string") bad(`"text" must be text`);
        else {
          if ([...ad.text].length > textMax) bad(`"text" is ${[...ad.text].length} characters; the most allowed is ${textMax}`);
          if (/[<>]/.test(ad.text) || /[\u0000-\u001f\u007f]/.test(ad.text)) bad(`"text" must be plain text (no < >, no line breaks)`);
          if (/https?:\/\/|www\./i.test(ad.text)) bad(`"text" must not contain a link; the link goes in "url"`);
        }
      }
      if (ad.url !== undefined) for (const p of checkUrl(ad.url, '"url"')) bad(p);
      if (ad.category !== undefined && !categories.includes(ad.category)) {
        bad(`"category" ${JSON.stringify(ad.category)} is not allowed. Allowed: ${categories.join(", ")}`);
      }
      const startOk = isRealDate(ad.start);
      const endOk = isRealDate(ad.end);
      if (ad.start !== undefined && !startOk) bad(`"start" must be a real date written YYYY-MM-DD (got ${JSON.stringify(ad.start)})`);
      if (ad.end !== undefined && !endOk) bad(`"end" must be a real date written YYYY-MM-DD (got ${JSON.stringify(ad.end)})`);
      if (startOk && endOk) {
        if (ad.end < ad.start) bad(`"end" (${ad.end}) is before "start" (${ad.start})`);
        else if (ad.end < today) warnings.push(`${name}: ended on ${ad.end}; remove it when you next edit this file.`);
      }
      if (ad.weight !== undefined && (!Number.isInteger(ad.weight) || ad.weight < weightMin || ad.weight > weightMax)) {
        bad(`"weight" must be a whole number from ${weightMin} to ${weightMax}`);
      }

      for (const field of ["id", "sponsor", "text", "url", "image"]) {
        if (typeof ad[field] !== "string") continue;
        let value = ad[field];
        if (field === "url" || field === "image") {
          try {
            const u = new URL(value);
            value = `${u.hostname} ${decodeURIComponent(u.pathname)}`;
          } catch {
            continue;
          }
        }
        const hit = findBanned(value);
        if (hit) bad(`"${field}" contains "${hit}", which is not allowed (see ads/README.md)`);
      }

      if (ad.image !== undefined) {
        const label = `"image"`;
        const urlProblems = checkUrl(ad.image, label);
        for (const p of urlProblems) bad(p);
        if (urlProblems.length === 0) {
          const u = new URL(ad.image);
          if (u.search || u.hash) bad(`${label} must not have a ? or # part (that is how tracking pixels are made)`);
          if (!/\.(png|webp)$/i.test(u.pathname)) bad(`${label} must be a .png or .webp file`);
          if (fetchFn) {
            try {
              const got = await downloadImage(ad.image, fetchFn);
              if (got.tooBig) bad(`${label} is larger than ${limits.imageMaxBytes / 1024} KB`);
              else for (const p of checkImageBytes(got.bytes, label)) bad(p);
            } catch (e) {
              bad(`${label} ${e instanceof Error ? e.message : "could not be checked"}`);
            }
          }
        }
      }
    }
  }
  return { errors, warnings };
}

// ---- Command line --------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const file = resolve(args.find((a) => !a.startsWith("--")) ?? resolve(adsDir, "manifest.json"));
  let manifest;
  try {
    manifest = readJson(file);
  } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
  const { errors, warnings } = await validateManifest(manifest, { fetchFn: offline ? null : globalThis.fetch });
  for (const w of warnings) console.warn(`warning: ${w}`);
  const count = Object.values(manifest?.slots ?? {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  if (errors.length > 0) {
    console.error(`${errors.length} problem(s) in ${file.replace(root, ".")}:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`OK: ${file.replace(root, ".")} has ${count} sponsor${count === 1 ? "" : "s"}${offline ? " (images not downloaded)" : ""}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
