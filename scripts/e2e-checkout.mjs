// Takes payments at the till in the real app on a generated DEMO shop (scripts/demo-db.mjs) and checks the
// saved payments in the SQLite file: a single bank transfer with a reference, a split of cash and bank
// transfer, the plain-words messages, and that every payment button is large enough to tap.
//
//   node scripts/e2e-checkout.mjs [--shots dir]
//
// Needs the app built and SQLite prepared for Electron:
//   npm run build -w @tillbase/core && npm run rebuild -w @tillbase/desktop && npm run build -w @tillbase/desktop
// On Linux without a display it re-runs itself under xvfb-run.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const shots = args.includes("--shots") ? resolve(args[args.indexOf("--shots") + 1]) : null;

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
const sqlitePath = require.resolve("better-sqlite3");
const { _electron: electron } = await import("playwright-core");
const { OWNER_NAME, OWNER_PIN, CASHIER_NAME, CASHIER_PIN } = await import(new URL("./demo-db.mjs", import.meta.url).href);

const log = (m) => console.log(`[e2e checkout] ${m}`);
const tmp = mkdtempSync(join(tmpdir(), "tillbase-checkout-e2e-"));
const dbFile = join(tmp, "demo.sqlite");
if (shots) mkdirSync(shots, { recursive: true });

/** Run SQL against the shop's file using Electron's own Node, so it is the same SQLite build as the app. */
function sql(query) {
  const r = spawnSync(
    electronBinary,
    ["-e", `const D=require(process.env.SQLITE);const d=new D(process.env.DBFILE,{readonly:true});console.log(JSON.stringify(d.prepare(process.env.SQL).all()));`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SQLITE: sqlitePath, DBFILE: dbFile, SQL: query }, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`database query failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
const one = (query) => Object.values(sql(query)[0] ?? {})[0];

const seed = spawnSync(electronBinary, [join(root, "scripts", "demo-db.mjs"), dbFile], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  encoding: "utf8",
});
if (seed.status !== 0) {
  process.stderr.write(seed.stderr ?? "");
  console.error(
    /NODE_MODULE_VERSION|was compiled against/.test(seed.stderr ?? "")
      ? "SQLite is built for Node, not Electron. Run: npm run rebuild -w @tillbase/desktop"
      : "Could not create the demo shop.",
  );
  process.exit(1);
}


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
    w.setSize(1440, 1000);
    w.center();
  });
  page.setDefaultTimeout(30_000);
  page.on("console", (m) => m.type() === "error" && problems.push(`console error: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  const shot = async (name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));

  const signIn = async (name, pin) => {
    await page.getByRole("button", { name: new RegExp(name) }).click();
    for (const digit of pin) await page.getByRole("button", { name: digit, exact: true }).click();
    await page.locator('nav[aria-label="Main"]').waitFor({ timeout: 4000 }).catch(() => page.getByRole("button", { name: "Sign in" }).click());
    await page.locator('nav[aria-label="Main"]').waitFor();
  };
  await signIn(OWNER_NAME, OWNER_PIN);
  await page.locator('nav[aria-label="Main"]').getByRole("button", { name: "Checkout" }).click();
  if (await page.getByRole("button", { name: "Open a shift" }).count()) {
    await page.getByRole("button", { name: "Open a shift" }).click();
    await page.getByRole("dialog").locator("input").first().fill("100");
    await page.getByRole("dialog").getByRole("button", { name: /Open shift/ }).click();
  }
  const salesBefore = Number(one("SELECT COUNT(*) FROM sales"));

  const addFirstProduct = async () => {
    await page.locator(".tile:not(.tile-out)").first().click();
    await page.getByRole("button", { name: /^Pay / }).click();
    await page.getByRole("dialog").waitFor();
  };
  const lastSale = () => sql("SELECT id, total_minor FROM sales ORDER BY created_at DESC, rowid DESC LIMIT 1")[0];
  const paymentsOf = (id) => sql(`SELECT method, amount_minor, reference FROM payments WHERE sale_id='${id}' ORDER BY rowid`);

  // ---- one bank transfer with a reference -----------------------------------------------------------------------
  await addFirstProduct();
  const dlg = page.getByRole("dialog");
  const methods = dlg.getByRole("group", { name: "Payment method" });
  assert.deepEqual(await methods.getByRole("button").allInnerTexts(), ["Cash", "Card", "Bank transfer", "Other"]);
  for (const b of await methods.getByRole("button").all()) {
    const box = await b.boundingBox();
    assert.ok(box && box.height >= 56 && box.width >= 100, `payment button is large enough to tap (${box?.width}x${box?.height})`);
  }
  assert.equal(await dlg.getByLabel("Reference (optional)").count(), 0, "no reference box for cash");
  await methods.getByRole("button", { name: "Bank transfer" }).click();
  await dlg.getByText(/has reached the shop's account/).waitFor();
  await dlg.getByLabel("Reference (optional)").fill("  TX-4471 Meezan  ");
  await shot("1-bank-transfer");
  await dlg.getByRole("button", { name: "Transfer received — complete sale" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" }).catch(() => undefined);
  let sale = lastSale();
  assert.equal(Number(one("SELECT COUNT(*) FROM sales")), salesBefore + 1, "one sale was saved");
  assert.deepEqual(paymentsOf(sale.id), [{ method: "bank_transfer", amount_minor: sale.total_minor, reference: "TX-4471 Meezan" }]);
  log("bank transfer with a reference saved correctly");
  await shot("2-receipt-after-transfer");
  await page.keyboard.press("Escape");
  const done = page.getByRole("button", { name: /New sale|Done|Close/ }).first();
  if (await done.count()) await done.click().catch(() => undefined);

  // ---- split: cash first, the rest by bank transfer ---------------------------------------------------------------
  await page.locator(".tile:not(.tile-out)").first().waitFor();
  await addFirstProduct();
  await dlg.getByRole("button", { name: "Split payment" }).click();
  const total = sale.total_minor;
  const part = Math.max(100, Math.floor(total / 2 / 100) * 100);
  await dlg.getByLabel("Amount").fill(String(part / 100));
  await dlg.getByRole("button", { name: "Add cash payment" }).click();
  await dlg.getByText(/Still to pay/).waitFor();
  await dlg.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Bank transfer" }).click();
  await dlg.getByLabel("Reference (optional)").fill("RAAST 9920");
  await shot("3-split-bank-transfer");
  await dlg.getByRole("button", { name: "Add bank transfer payment" }).click();
  await dlg.getByText(/ref RAAST 9920/).waitFor();
  await dlg.getByText(/Covered/).waitFor();
  await shot("4-split-covered");
  await dlg.getByRole("button", { name: "Complete sale" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" }).catch(() => undefined);
  sale = lastSale();
  const rows = paymentsOf(sale.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].method, "cash");
  assert.equal(rows[1].method, "bank_transfer");
  assert.equal(rows[1].reference, "RAAST 9920");
  assert.equal(rows[0].amount_minor + rows[1].amount_minor, sale.total_minor, "the two payments add up to the bill");
  log("split cash + bank transfer saved correctly");
  assert.equal(Number(one("SELECT COUNT(*) FROM sales")), salesBefore + 2, "two sales in all, none doubled");

  // ---- the smallest window the app allows (it will not shrink below about 1024 px) ----------------------------------------------------------------
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(360, 800));
  await page.waitForTimeout(300);
  await page.locator(".tile:not(.tile-out)").first().click().catch(() => undefined);
  await page.getByRole("button", { name: /^Pay / }).click().catch(() => undefined);
  const narrow = page.getByRole("dialog");
  if (await narrow.count()) {
    await narrow.getByRole("button", { name: "Bank transfer" }).click();
    await shot("5-smallest-window");
    const overflow = await narrow.evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(overflow <= 1, `the pay dialog does not scroll sideways in the smallest window (${overflow}px)`);
  }
  assert.deepEqual(problems, [], "no page errors");
  log("PASSED");
} catch (e) {
  failed = true;
  console.error(e);
  if (page) await page.screenshot({ path: join(shots ?? tmp, "failure.png") }).catch(() => undefined);
} finally {
  await app.close().catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
}
if (failed || problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log("PASSED: bank transfer and split payments work in the real app.");
