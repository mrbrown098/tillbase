// Runs the supplier-orders screen in the real app, on a demo shop, and checks the database afterwards.
//
//   node scripts/e2e-purchase-orders.mjs [--shots dir]
//
// It signs in as the owner, places an order, receives it in two deliveries, looks at the supplier
// statement, and cancels a second order. After each step it reads the SQLite file directly and checks
// the numbers: ordering must not move stock or what is owed; each delivery must (through the purchasing
// service, so a purchase and stock movements exist). Fails on any page error.
//
// Needs the app built and SQLite prepared for Electron:
//   npm run build -w @tillbase/core && npm run rebuild -w @tillbase/desktop && npm run build -w @tillbase/desktop
// On Linux without a display it re-runs itself under xvfb-run.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const { OWNER_NAME, OWNER_PIN } = await import(new URL("./demo-db.mjs", import.meta.url).href);

const log = (m) => console.log(`[e2e purchase orders] ${m}`);
const tmp = mkdtempSync(join(tmpdir(), "tillbase-po-e2e-"));
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

const item = sql("SELECT id, name, unit FROM products WHERE kind = 'ingredient' AND is_system = 0 ORDER BY name LIMIT 1")[0];
assert.ok(item, "the demo shop has an ingredient");
const stock = () => Number(one(`SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements WHERE product_id = '${item.id}'`));
const owed = () => Number(one("SELECT COALESCE(SUM(total_minor - paid_minor),0) FROM purchases"));
const purchaseCount = () => Number(one("SELECT COUNT(*) FROM purchases"));

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
  const shot = async (name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));

  await page.getByRole("button", { name: new RegExp(OWNER_NAME) }).click();
  for (const digit of OWNER_PIN) await page.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  const nav = page.locator('nav[aria-label="Main"]');
  await nav.waitFor();
  await nav.getByRole("button", { name: "Supplier orders" }).click();
  await page.getByRole("heading", { name: "Supplier orders" }).waitFor();

  const stock0 = stock();
  const owed0 = owed();
  const purchases0 = purchaseCount();
  log(`before: ${item.name} stock ${stock0} ${item.unit}, owed to suppliers ${owed0}, purchases ${purchases0}`);

  // ---- 1. Place an order for 10 at 80.00 ---------------------------------------------------------------
  await page.getByRole("button", { name: "New order" }).click();
  let dlg = page.getByRole("dialog", { name: "New supplier order" });
  await dlg.getByLabel("Supplier", { exact: true }).fill("E2E Traders");
  await dlg.locator("select").first().selectOption({ label: `${item.name} (${item.unit})` });
  const inputs = dlg.locator("input.qty-input");
  await inputs.nth(0).fill("10");
  await inputs.nth(1).fill("80.00");
  await dlg.getByText("Order total at these prices").waitFor();
  await shot("1-new-order");
  await dlg.getByRole("button", { name: "Create order" }).click();
  await page.getByText("PO-0001 created").waitFor();
  await page.getByRole("row", { name: /PO-0001/ }).waitFor();
  assert.equal(Number(one("SELECT COUNT(*) FROM purchase_orders")), 1, "one order saved");
  assert.equal(stock(), stock0, "ordering must not change stock");
  assert.equal(owed(), owed0, "ordering must not change what is owed");
  assert.equal(purchaseCount(), purchases0, "ordering must not create a purchase");
  log("order placed; stock and money unchanged");

  // ---- 2. First delivery: 6 arrive, 200.00 paid by card -------------------------------------------------
  await page.getByRole("row", { name: /PO-0001/ }).getByRole("button", { name: "Receive" }).click();
  dlg = page.getByRole("dialog", { name: /Receive PO-0001/ });
  await dlg.getByLabel(`${item.name} arrived`).fill("6");
  await dlg.getByLabel("Paid now (empty = nothing yet)").fill("200.00");
  await dlg.getByLabel("Paid by").selectOption("card");
  await dlg.getByLabel("Supplier's invoice number (optional)").fill("INV-1");
  await shot("2-receive");
  await dlg.getByRole("button", { name: "Save delivery" }).click();
  await page.getByText("Delivery booked on PO-0001").waitFor();
  await page.getByRole("row", { name: /PO-0001/ }).getByText("Partly received").waitFor();
  assert.equal(stock(), stock0 + 6, "stock rose by the 6 delivered");
  assert.equal(purchaseCount(), purchases0 + 1, "the delivery is a normal purchase");
  assert.deepEqual(sql("SELECT supplier, reference, note, total_minor AS total, paid_minor AS paid FROM purchases WHERE reference = 'PO-0001'"), [
    { supplier: "E2E Traders", reference: "PO-0001", note: "Invoice INV-1", total: 48_000, paid: 20_000 },
  ]);
  assert.equal(
    Number(one(`SELECT COUNT(*) FROM stock_movements WHERE product_id = '${item.id}' AND reason = 'purchase' AND ref_type = 'purchase' AND qty_delta = 6 AND value_minor = 48000`)),
    1,
    "a purchase stock movement at the delivery's value exists",
  );
  assert.equal(owed(), owed0 + 28_000, "480.00 bought, 200.00 paid: 280.00 owed");
  log("first delivery booked through the purchasing service");

  // ---- 3. Second delivery: the remaining 4 ------------------------------------------------------------
  await page.getByRole("row", { name: /PO-0001/ }).getByRole("button", { name: "Receive" }).click();
  dlg = page.getByRole("dialog", { name: /Receive PO-0001/ });
  assert.equal(await dlg.getByLabel(`${item.name} arrived`).inputValue(), "4", "the form offers what is still expected");
  await dlg.getByRole("button", { name: "Save delivery" }).click();
  await page.getByText("PO-0001 received in full").waitFor();
  assert.equal(stock(), stock0 + 10);
  assert.equal(owed(), owed0 + 28_000 + 32_000);
  assert.equal(one("SELECT status FROM purchase_orders WHERE number = 1"), "received");
  assert.equal(await page.getByRole("row", { name: /PO-0001/ }).count(), 0, "a received order leaves the Waiting list");
  log("second delivery booked; order closed");

  // ---- 4. Statement -------------------------------------------------------------------------------------
  await page.getByRole("button", { name: "Supplier statement" }).click();
  dlg = page.getByRole("dialog", { name: "Supplier statement" });
  await dlg.locator("select").first().selectOption("E2E Traders");
  await dlg.getByText(/Payment \(card\)/).waitFor();
  assert.equal(await dlg.getByRole("cell", { name: /^Purchase PO-0001/ }).count(), 2, "both deliveries are on the statement");
  assert.equal(await dlg.getByText(/Payment \(card\)/).count(), 1, "the card payment is on the statement");
  await shot("3-statement");
  await dlg.getByRole("button", { name: "Close", exact: true }).last().click();

  // ---- 5. Cancel a second order ---------------------------------------------------------------------------
  await page.getByRole("button", { name: "New order" }).click();
  dlg = page.getByRole("dialog", { name: "New supplier order" });
  await dlg.getByLabel("Supplier", { exact: true }).fill("E2E Traders");
  await dlg.locator("select").first().selectOption({ label: `${item.name} (${item.unit})` });
  await dlg.locator("input.qty-input").nth(0).fill("3");
  await dlg.locator("input.qty-input").nth(1).fill("10.00");
  await dlg.getByRole("button", { name: "Create order" }).click();
  await page.getByText("PO-0002 created").waitFor();
  await page.getByRole("row", { name: /PO-0002/ }).getByRole("button", { name: "Cancel" }).click();
  dlg = page.getByRole("dialog", { name: /Cancel PO-0002/ });
  await dlg.getByLabel("Why? (optional)").fill("Changed my mind");
  await dlg.getByRole("button", { name: "Cancel the order" }).click();
  await page.getByText("PO-0002 cancelled").waitFor();
  assert.deepEqual(sql("SELECT status, cancel_reason AS reason FROM purchase_orders WHERE number = 2"), [{ status: "cancelled", reason: "Changed my mind" }]);
  assert.equal(stock(), stock0 + 10, "cancelling changes nothing in stock");
  assert.equal(owed(), owed0 + 60_000, "cancelling changes nothing in what is owed");
  log("second order cancelled");

  assert.deepEqual(problems, [], "the app logged no errors");
  console.log("PASSED: supplier orders work in the real app.");
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
  if (problems.length) console.error(`page problems:\n  ${problems.join("\n  ")}`);
  try {
    await page?.screenshot({ path: join(shots ?? tmp, "e2e-purchase-orders-failure.png") });
    console.error(`screenshot of the failure: ${join(shots ?? tmp, "e2e-purchase-orders-failure.png")}`);
  } catch {
    /* no window */
  }
} finally {
  await app.close().catch(() => undefined);
  if (!failed) rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
