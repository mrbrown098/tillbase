// End-to-end smoke test for the Tillbase desktop app, using Playwright's Electron support.
//
//   node scripts/smoke.mjs --dev                      launch the freshly built app from packages/desktop
//   node scripts/smoke.mjs --exe /path/to/Tillbase    launch an installed or unpacked app binary
//
// Options:
//   --shots <dir>     where to save screenshots (default: smoke-output)
//   --default-data    do not set TILLBASE_DB; check that the database is created in the app's normal
//                     per-user data folder (only meaningful for an installed app)
//   --expect-packaged fail unless the app reports app.isPackaged === true
//
// What it checks: the first-run "Welcome to Tillbase" screen appears, the owner can be created, the
// main window then shows the Home tab, and the app logged no errors (renderer or main process).
// On Linux it passes --no-sandbox, which CI containers and root shells need; this is a property of the
// test environment, not of the installer.
import { mkdirSync, mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dev = flag("--dev");
const exe = value("--exe");
const defaultData = flag("--default-data");
const expectPackaged = flag("--expect-packaged");
const shots = resolve(value("--shots") ?? "smoke-output");
if (!dev && !exe) {
  console.error("Usage: node scripts/smoke.mjs (--dev | --exe <path>) [--shots <dir>] [--default-data] [--expect-packaged]");
  process.exit(2);
}
if (exe && !existsSync(exe)) {
  console.error(`Executable not found: ${exe}`);
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

const tempDir = mkdtempSync(join(tmpdir(), "tillbase-smoke-"));
const tempDb = join(tempDir, "tillbase.sqlite");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // would make Electron behave like plain Node
delete env.VITE_DEV_SERVER_URL;
if (defaultData) delete env.TILLBASE_DB;
else env.TILLBASE_DB = tempDb;

const launchArgs = dev ? ["."] : [];
if (process.platform === "linux") launchArgs.push("--no-sandbox", "--disable-gpu");

const problems = [];
const note = (msg) => console.log(`[smoke] ${msg}`);
const fail = (msg) => {
  problems.push(msg);
  console.error(`[smoke] FAIL: ${msg}`);
};

let app;
let page;
try {
  note(dev ? "launching the built app from packages/desktop" : `launching ${exe}`);
  app = await electron.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: launchArgs,
    cwd: dev ? join(root, "packages", "desktop") : undefined,
    env,
    timeout: 60_000,
  });

  app.on("console", (msg) => {
    if (msg.type() === "error") fail(`main process console.error: ${msg.text()}`);
  });

  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on("console", (msg) => {
    if (msg.type() === "error") fail(`renderer console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => fail(`renderer uncaught error: ${err.message}`));
  page.on("crash", () => fail("renderer crashed"));

  const info = await app.evaluate(({ app: a }) => ({
    packaged: a.isPackaged,
    name: a.getName(),
    userData: a.getPath("userData"),
    version: a.getVersion(),
    electron: process.versions.electron,
  }));
  note(`app "${info.name}" ${info.version}, Electron ${info.electron}, packaged=${info.packaged}`);
  note(`userData folder: ${info.userData}`);
  if (expectPackaged && !info.packaged) fail("expected a packaged app but app.isPackaged is false");

  // 1. First run: the Tillbase splash, then the welcome screen of the guided setup.
  await page.getByRole("button", { name: /Tillbase\. Press to continue/ }).click();
  await page.getByRole("heading", { name: "Welcome to Tillbase" }).waitFor();
  note("first-run welcome screen is showing");
  await page.screenshot({ path: join(shots, "1-setup.png") });

  // 2. Create the owner account, then skip the optional questions.
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabel("Your name", { exact: true }).fill("Smoke Owner");
  await page.getByLabel("PIN (4 to 8 digits)", { exact: true }).fill("2468");
  await page.getByLabel("Repeat PIN", { exact: true }).fill("2468");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Skip the rest of setup" }).click();

  // 3. Main window with the Home tab selected (owners start on Home).
  const current = page.locator('nav[aria-label="Main"] button[aria-current="page"]');
  await current.waitFor();
  const label = (await current.innerText()).trim();
  if (label !== "Home") fail(`expected the Home tab to be selected, found "${label}"`);
  else note("main window is showing the Home tab");
  await page.getByText("My Shop").first().waitFor(); // the default name, since the smoke test skips the setup questions

  // Give late errors (failed data loads, etc.) a moment to show up.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, "2-checkout.png") });

  // 4. Where did the database go?
  const dbPath = defaultData ? join(info.userData, "tillbase.sqlite") : tempDb;
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) fail(`database file was not created at ${dbPath}`);
  else note(`database file created at ${dbPath}`);
  if (defaultData && expectPackaged && basename(info.userData) !== "Tillbase") {
    fail(`app data folder should be named "Tillbase", but is "${basename(info.userData)}"`);
  }
} catch (e) {
  fail(`smoke test did not complete: ${e instanceof Error ? e.message : String(e)}`);
  try {
    if (page) await page.screenshot({ path: join(shots, "failure.png") });
  } catch {
    // The window may already be gone.
  }
} finally {
  try {
    await app?.close();
  } catch {
    // Already closed.
  }
  if (!defaultData) rmSync(tempDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\n[smoke] ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\n[smoke] PASSED");
