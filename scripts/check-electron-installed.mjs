// Fails if `npm ci` left Electron without its binary.
//
// Why: npm 11.2x blocks dependency install scripts unless they are approved, and Electron downloads
// its program in an install script. Without it `npm ci` still "succeeds", but `npm run app` then
// fails with "Electron failed to install correctly". This check makes that visible right away.
//
//   node scripts/check-electron-installed.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const electron = join(root, "node_modules", "electron");
const dist = join(electron, "dist");
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  console.error("Electron's install script did not run. Check `allowScripts` in package.json and the npm version (npm --version).");
  process.exit(1);
};

if (!existsSync(dist)) fail(`${dist.replace(root, ".")} is missing`);
const files = readdirSync(dist);
if (files.length === 0) fail(`${dist.replace(root, ".")} is empty`);
const pathTxt = join(electron, "path.txt");
if (!existsSync(pathTxt)) fail("node_modules/electron/path.txt is missing");
const binary = join(dist, readFileSync(pathTxt, "utf8").trim());
if (!existsSync(binary)) fail(`the Electron program named in path.txt is missing: ${binary.replace(root, ".")}`);
console.log(`OK: Electron binary present (${binary.replace(root, ".")}), ${files.length} files in node_modules/electron/dist.`);
