// Gets the SQLite native module ready for Electron.
//
// 1. Download the prebuilt binary for this Electron version (fast, needs no compiler).
// 2. Only if that fails, compile from source with @electron/rebuild (needs Python and a C++ toolchain).
//
// Works the same on Windows, macOS and Linux.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const sqliteDir = dirname(require.resolve("better-sqlite3/package.json"));
const fromSqlite = createRequire(join(sqliteDir, "package.json"));

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "inherit", cwd: sqliteDir, ...opts }).status === 0;
}

console.log(`Preparing SQLite for Electron ${electronVersion} (${process.platform}-${process.arch})...`);

let ok = false;
try {
  const prebuild = fromSqlite.resolve("prebuild-install/bin.js");
  ok = run(process.execPath, [prebuild, "--runtime=electron", `--target=${electronVersion}`, "--force"]);
} catch {
  ok = false;
}

if (ok) {
  console.log("Done: using the prebuilt SQLite binary.");
  process.exit(0);
}

console.warn("\nNo prebuilt binary could be downloaded. Compiling from source instead.");
console.warn("This needs Python 3 and a C++ build toolchain (Windows: 'Desktop development with C++' from Visual Studio Build Tools).\n");
const rebuild = join(dirname(require.resolve("@electron/rebuild/package.json")), "lib", "cli.js");
if (!run(process.execPath, [rebuild, "-f", "-w", "better-sqlite3", "-m", join(sqliteDir, "..", "..")], { cwd: process.cwd() })) {
  console.error("\nCould not prepare SQLite for Electron. See docs/TROUBLESHOOTING.md.");
  process.exit(1);
}
