// Runs the report centre and A4 printing in the real app, on a generated DEMO shop (scripts/demo-db.mjs),
// and checks what the screen shows against the SQLite file.
//
//   node scripts/e2e-reports.mjs [--shots dir]
//
// It signs in as the owner, opens Reports, compares the headline sales figure on screen with a SQL total
// from the database, looks at every section, previews and saves every A4 report as a PDF, and (when
// poppler's pdftotext/pdfinfo are installed) checks that every page of every PDF carries "Powered by
// Tillbase" and a page number. Also checks that a cashier cannot open the Reports tab. Fails on any page error.
//
// The screenshots it saves are of the demo shop, not of a real business.
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

const log = (m) => console.log(`[e2e reports] ${m}`);
const tmp = mkdtempSync(join(tmpdir(), "tillbase-reports-e2e-"));
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


const pdfDir = join(tmp, "pdf");
const env = { ...process.env, TILLBASE_DB: dbFile, TILLBASE_TEST_REPORT_FOLDER: pdfDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const launchArgs = ["."];
if (process.platform === "linux") launchArgs.push("--no-sandbox", "--disable-gpu");

const has = (cmd) => spawnSync(cmd, ["-v"], { encoding: "utf8" }).error === undefined || spawnSync(cmd, ["-h"], { encoding: "utf8" }).error === undefined;
const havePoppler = has("pdftotext") && has("pdfinfo");

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

  // ---- a cashier must not see Reports ----------------------------------------------------------------------
  const signIn = async (name, pin) => {
    await page.getByRole("button", { name: new RegExp(name) }).click();
    for (const digit of pin) await page.getByRole("button", { name: digit, exact: true }).click();
    // the PIN pad signs in by itself after the last digit; if this version has a button, press it
    await page.locator('nav[aria-label="Main"]').waitFor({ timeout: 4000 }).catch(() => page.getByRole("button", { name: "Sign in" }).click());
    await page.locator('nav[aria-label="Main"]').waitFor();
  };
  await signIn(CASHIER_NAME, CASHIER_PIN);
  assert.equal(await page.locator('nav[aria-label="Main"]').getByRole("button", { name: "Money" }).count(), 0, "a cashier has no Money tab");
  log("cashier cannot see the Reports tab");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(OWNER_NAME) }).waitFor();

  await signIn(OWNER_NAME, OWNER_PIN);
  const nav = page.locator('nav[aria-label="Main"]');
  await nav.getByRole("button", { name: "Money" }).click();
  await page.getByRole("heading", { name: "Reports" }).waitFor();

  // ---- the headline figure on screen equals the database -----------------------------------------------------
  await page.getByRole("button", { name: "This month" }).click();
  const [from, to] = [await page.locator(`input[aria-label="From"]`).inputValue(), await page.locator(`input[aria-label="To"]`).inputValue()];
  const lo = new Date(`${from}T00:00:00`).toISOString();
  const hi = new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString();
  const dbNet = Number(one(`SELECT COALESCE(SUM(subtotal_minor - discount_minor),0) FROM sales WHERE status='completed' AND created_at >= '${lo}' AND created_at < '${hi}'`));
  const dbCount = Number(one(`SELECT COUNT(*) FROM sales WHERE status='completed' AND created_at >= '${lo}' AND created_at < '${hi}'`));
  const salesCard = page.locator(".stats .panel", { hasText: "Sales (before tax)" });
  await salesCard.waitFor();
  const shown = await salesCard.innerText();
  const digits = (shown.split("\n")[1] ?? "").replace(/[^0-9.]/g, "");
  log(`this month (${from} to ${to}): screen shows "${shown.split("\n")[1]}", ${dbCount} orders in the database, database total ${dbNet / 100}`);
  assert.equal(Math.round(Number(digits) * 100), dbNet, "sales on screen equal the database total");
  assert.match(shown, new RegExp(`${dbCount} orders`), "order count on screen equals the database count");
  await shot("1-overview");

  for (const [tab, shotName] of [["Profit and loss", "2-profit-loss"], ["Products", "3-products"], ["Stock", "4-stock"], ["Suppliers and customers", "5-suppliers-customers"], ["Staff and shifts", "6-staff-shifts"]]) {
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForTimeout(250);
    await shot(shotName);
  }
  await page.getByRole("tab", { name: "Profit and loss" }).click();
  await page.getByText("= Gross profit").waitFor();
  await page.getByRole("tab", { name: "Overview" }).click();

  // ---- every A4 report: preview, save as PDF, check the pages ---------------------------------------------------
  await page.getByRole("button", { name: /Print or save a report/ }).click();
  const dlg = page.getByRole("dialog", { name: "Print or save a report" });
  const frame = page.frameLocator('iframe[title="Report preview"]');
  const kinds = [
    ["Daily sales report", "Daily sales report"], ["Monthly sales report", "Monthly sales report"], ["Profit and loss", "Profit and loss"],
    ["Expense report", "Expense report"], ["Stock report", "Stock report"], ["Product performance", "Product performance"], ["Staff and shift report", "Staff and shift report"],
  ];
  const made = [];
  for (const [label, title] of kinds) {
    await dlg.getByLabel("Report", { exact: false }).first().selectOption({ label });
    await frame.getByRole("heading", { level: 1, name: title }).waitFor();
    await frame.getByText("Powered by Tillbase").waitFor();
    if (label === "Monthly sales report") await shot("7-preview-monthly");
    if (label === "Profit and loss") await shot("8-preview-profit-loss");
    await dlg.getByRole("button", { name: "Save as PDF…" }).click();
    await page.getByText(/^Saved /).last().waitFor();
    made.push(title);
  }
  // statements
  await dlg.locator("select").first().selectOption({ label: "Customer statement" });
  const customer = dlg.locator("select").nth(1);
  const optionCount = await customer.locator("option").count();
  if (optionCount > 1) {
    await customer.selectOption({ index: 1 });
    await frame.getByRole("heading", { level: 1, name: "Customer statement" }).waitFor();
    await frame.getByText("Powered by Tillbase").waitFor();
    await dlg.getByRole("button", { name: "Save as PDF…" }).click();
    made.push("Customer statement");
    await shot("9-preview-customer-statement");
  } else log("no customer owes money in the demo shop; customer statement not previewed in the app");
  await dlg.locator("select").first().selectOption({ label: "Supplier statement" });
  const supplier = dlg.locator("select").nth(1);
  if ((await supplier.locator("option").count()) > 1) {
    await supplier.selectOption({ index: 1 });
    await frame.getByRole("heading", { level: 1, name: "Supplier statement" }).waitFor();
    await dlg.getByRole("button", { name: "Save as PDF…" }).click();
    made.push("Supplier statement");
  } else log("the demo shop has no supplier names; supplier statement not previewed in the app");
  await page.waitForTimeout(500);

  const files = readdirSync(pdfDir).filter((f) => f.endsWith(".pdf"));
  assert.ok(files.length >= made.length, `a PDF was written for each report (${files.length} files for ${made.length} reports)`);
  log(`wrote ${files.length} PDFs: ${files.join(", ")}`);
  for (const f of files) {
    const bytes = readFileSync(join(pdfDir, f));
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-", `${f} is a PDF`);
    if (!havePoppler) continue;
    const pages = Number(/Pages:\s+(\d+)/.exec(spawnSync("pdfinfo", [join(pdfDir, f)], { encoding: "utf8" }).stdout)?.[1]);
    const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(spawnSync("pdfinfo", [join(pdfDir, f)], { encoding: "utf8" }).stdout);
    assert.ok(Math.abs(Number(size[1]) - 595) < 3 && Math.abs(Number(size[2]) - 842) < 3, `${f} is A4 (${size[1]} x ${size[2]} pt)`);
    const text = spawnSync("pdftotext", ["-layout", join(pdfDir, f), "-"], { encoding: "utf8" }).stdout;
    const footers = text.split("Powered by Tillbase").length - 1;
    assert.equal(footers, pages, `${f}: "Powered by Tillbase" on each of its ${pages} page(s) (found ${footers})`);
    for (let n = 1; n <= pages; n++) assert.ok(text.includes(`Page ${n} of ${pages}`), `${f}: has "Page ${n} of ${pages}"`);
    log(`${f}: ${pages} page(s), A4, footer and page number on every page`);
  }
  if (!havePoppler) log("pdftotext/pdfinfo not installed: PDF page footers were NOT checked in this run");
  if (shots) for (const f of files) copyFileSync(join(pdfDir, f), join(shots, f));

  assert.deepEqual(problems, [], "the app logged no errors");
  console.log("PASSED: report centre and A4 reports work in the real app.");
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
  if (problems.length) console.error(`page problems:\n  ${problems.join("\n  ")}`);
  try {
    await page?.screenshot({ path: join(shots ?? tmp, "e2e-reports-failure.png") });
    console.error(`screenshot of the failure: ${join(shots ?? tmp, "e2e-reports-failure.png")}`);
  } catch {
    /* no window */
  }
} finally {
  await app.close().catch(() => undefined);
  if (!failed) rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
