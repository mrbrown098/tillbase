// Checks that the SQLite native module inside every unpacked build in packages/desktop/release was
// compiled for that build's operating system and CPU. This catches the classic installer bug (a
// Linux or wrong-CPU binary shipped inside a Windows or macOS app), including for builds that cannot
// be launched on the machine that made them, such as an Intel mac app built on an Apple Silicon runner.
// It reads only the file header. The smoke tests are the real proof that an app starts.
//
//   node scripts/verify-native.mjs [release-dir]
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const release = resolve(process.argv[2] ?? join(root, "packages", "desktop", "release"));

/** Expected platform and CPU for each electron-builder output folder name. */
const expectations = {
  "win-unpacked": { format: "pe", cpu: "x64" },
  "win-arm64-unpacked": { format: "pe", cpu: "arm64" },
  mac: { format: "macho", cpu: "x64" },
  "mac-arm64": { format: "macho", cpu: "arm64" },
  "linux-unpacked": { format: "elf", cpu: "x64" },
  "linux-arm64-unpacked": { format: "elf", cpu: "arm64" },
};

function header(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

function describe(file) {
  const b = header(file);
  if (b.readUInt32BE(0) === 0x7f454c46) {
    const machine = b.readUInt16LE(18);
    return { format: "elf", cpu: { 0x3e: "x64", 0xb7: "arm64" }[machine] ?? `machine-0x${machine.toString(16)}` };
  }
  if (b.readUInt16LE(0) === 0x5a4d) {
    const pe = b.readUInt32LE(0x3c);
    const machine = readMachine(file, pe + 4);
    return { format: "pe", cpu: { 0x8664: "x64", 0xaa64: "arm64" }[machine] ?? `machine-0x${machine.toString(16)}` };
  }
  if (b.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = b.readUInt32LE(4);
    return { format: "macho", cpu: { 0x01000007: "x64", 0x0100000c: "arm64" }[cpu] ?? `cputype-0x${cpu.toString(16)}` };
  }
  if (b.readUInt32BE(0) === 0xcafebabe) return { format: "macho", cpu: "universal" };
  return { format: "unknown", cpu: "unknown" };
}

function readMachine(file, offset) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(2);
    readSync(fd, buf, 0, 2, offset);
    return buf.readUInt16LE(0);
  } finally {
    closeSync(fd);
  }
}

function findNative(dir) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "better_sqlite3.node") hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

if (!existsSync(release)) {
  console.error(`release folder not found: ${release}`);
  process.exit(2);
}

let checked = 0;
let bad = 0;
for (const name of readdirSync(release)) {
  const want = expectations[name];
  const dir = join(release, name);
  if (!want || !statSync(dir).isDirectory()) continue;
  const files = findNative(dir);
  if (files.length === 0) {
    console.error(`FAIL ${name}: better_sqlite3.node not found`);
    bad++;
    continue;
  }
  for (const file of files) {
    const got = describe(file);
    const ok = got.format === want.format && got.cpu === want.cpu;
    const unpacked = file.includes("app.asar.unpacked");
    console.log(`${ok && unpacked ? "ok  " : "FAIL"} ${name}: ${got.format}/${got.cpu} (want ${want.format}/${want.cpu})${unpacked ? "" : " NOT in app.asar.unpacked"}`);
    checked++;
    if (!ok || !unpacked) bad++;
  }
}
if (checked === 0) {
  console.error("no unpacked builds found to check");
  process.exit(2);
}
process.exit(bad === 0 ? 0 : 1);
