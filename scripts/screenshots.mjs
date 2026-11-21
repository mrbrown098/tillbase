// Takes the README screenshots from the real app, running on a demo shop.
//
//   npm run screenshots
//
// What it does: builds a demo database (scripts/demo-db.mjs), launches the built app on it with
// Playwright's Electron support, signs in as the owner through the real PIN screen, visits Checkout,
// Orders, Kitchen, Money and Menu, and saves a PNG of each into docs/screenshots/.
// On Linux without a display it re-runs itself under xvfb-run. The screenshots are real: nothing is
// drawn or edited. If a screen does not show what it should, the script fails instead of saving it.
//
// Needs the app built, and SQLite prepared for Electron; `npm run screenshots` does both:
//   npm run build -w @tillbase/core && npm run rebuild -w @tillbase/desktop && npm run build -w @tillbase/desktop
// Afterwards run `npm run rebuild:node` before running the unit tests again.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const outDir = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(root, "docs", "screenshots"));

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.TILLBASE_UNDER_XVFB) {
  const r = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, TILLBASE_UNDER_XVFB: "1" },
  });
  if (r.error) {
    console.error("No display and xvfb-run was not found. Install it (for example: sudo apt-get install xvfb) and try again.");
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

const require = createRequire(join(root, "packages", "desktop", "package.json"));
const electronBinary = require("electron");
const { _electron: electron } = await import("playwright-core");
const { OWNER_NAME, OWNER_PIN } = await import(new URL("./demo-db.mjs", import.meta.url).href);

const log = (m) => console.log(`[screenshots] ${m}`);
const tmp = mkdtempSync(join(tmpdir(), "tillbase-shots-"));
const dbFile = join(tmp, "demo.sqlite");
mkdirSync(outDir, { recursive: true });

// 1. The demo shop. Run with Electron's own Node so it uses the same SQLite build as the app.
log("creating the demo shop");
const seed = spawnSync(electronBinary, [join(root, "scripts", "demo-db.mjs"), dbFile], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  encoding: "utf8",
});
process.stdout.write(seed.stdout ?? "");
if (seed.status !== 0) {
  process.stderr.write(seed.stderr ?? "");
  console.error(
    /NODE_MODULE_VERSION|was compiled against/.test(seed.stderr ?? "")
      ? "SQLite is built for Node, not Electron. Run: npm run rebuild -w @tillbase/desktop"
      : "Could not create the demo shop.",
  );
  process.exit(1);
}

// 2. The app.
const env = { ...process.env, TILLBASE_DB: dbFile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const launchArgs = ["."];
if (process.platform === "linux") launchArgs.push("--no-sandbox", "--disable-gpu");

const problems = [];
const app = await electron.launch({ args: launchArgs, cwd: join(root, "packages", "desktop"), env, timeout: 60_000 });
let failed = false;
let page;
try {
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1440, 900);
    w.center();
  });
  page.setDefaultTimeout(20_000);
  page.on("console", (m) => m.type() === "error" && problems.push(`console error: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));

  // Sign in the way a person would: pick a name, tap the PIN.
  await page.getByRole("button", { name: new RegExp(OWNER_NAME) }).click();
  for (const digit of OWNER_PIN) await page.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  const nav = page.locator('nav[aria-label="Main"]');
  await nav.waitFor();

  const open = async (label) => {
    await nav.getByRole("button", { name: label, exact: false }).first().click();
    await page.waitForTimeout(700);
  };
  const shot = async (name) => {
    await page.waitForTimeout(500);
    const file = join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    log(`saved ${name}.png (${Math.round(statSync(file).size / 1024)} KB)`);
  };
  const need = async (locator, what) => {
    try {
      await locator.first().waitFor({ timeout: 8000 });
    } catch {
      throw new Error(`the screen does not show ${what}, so the screenshot was not saved`);
    }
  };

  // Checkout, with a sale in progress.
  await open("Checkout");
  await need(page.locator(".tile-name", { hasText: "Zinger Burger" }), "the menu tiles");
  const tile = (name) => page.locator(".tiles button", { hasText: name }).first();
  await tile("Zinger Burger").click();
  await tile("Zinger Burger").click();
  await tile("Cheese Fries").click();
  await tile("Cola 345 ml").click();
  await tile("Milk Shake").click();
  await need(page.getByLabel("Current sale").getByText("Cheese Fries"), "the cart");
  await shot("checkout");

  // Orders: the open orders of the evening.
  await open("Orders");
  await need(page.getByRole("tab", { name: /Table 5/ }), "the open orders");
  await page.getByRole("tab", { name: /Table 5/ }).click();
  await need(page.getByLabel("Current order").getByText("Cheese Fries"), "the selected order");
  await shot("orders");

  // Kitchen board.
  await open("Kitchen");
  await need(page.locator("section.kcol"), "the kitchen board");
  await shot("kitchen");

  // Money: profit and loss for the month.
  await open("Money");
  await page.getByRole("button", { name: "This month" }).click();
  await need(page.getByText(/profit/i), "profit");
  await page.waitForTimeout(900);
  await shot("money");

  // Menu and stock.
  await open("Menu and stock");
  await need(page.locator("table.table tbody tr"), "the menu table");
  await shot("menu");
} catch (e) {
  failed = true;
  console.error(`[screenshots] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  await page?.screenshot({ path: join(tmpdir(), "tillbase-screenshots-failure.png") }).catch(() => {});
  console.error(`[screenshots] a picture of the failing screen is at ${join(tmpdir(), "tillbase-screenshots-failure.png")}`);
} finally {
  await app.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length > 0) {
  failed = true;
  console.error("[screenshots] the app logged errors while running:");
  for (const p of problems) console.error(`  - ${p}`);
}
process.exit(failed ? 1 : 0);
