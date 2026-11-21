// Runs electron-builder for the desktop app with the exact installed Electron version.
//
// electron-builder cannot work out the Electron version when package.json says "^33.0.0" and the
// package is installed at the workspace root, so this passes the installed version explicitly.
// Every argument is forwarded to electron-builder:
//
//   npm run dist -w @tillbase/desktop -- --win        (Windows NSIS installer, x64)
//   npm run dist -w @tillbase/desktop -- --mac        (macOS dmg, x64 + arm64)
//   npm run dist -w @tillbase/desktop -- --linux      (AppImage + deb, x64)
//
// Add --publish never when running locally. Output goes to packages/desktop/release/.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const desktop = join(root, "packages", "desktop");
const require = createRequire(join(desktop, "package.json"));

const electronVersion = require("electron/package.json").version;
const builderCli = join(dirname(require.resolve("electron-builder/package.json")), "cli.js");

const forwarded = process.argv.slice(2);
if (!forwarded.includes("--publish")) forwarded.push("--publish", "never");

console.log(`Building installers with Electron ${electronVersion} (${process.platform}-${process.arch})`);
const result = spawnSync(process.execPath, [builderCli, `-c.electronVersion=${electronVersion}`, ...forwarded], {
  cwd: desktop,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
