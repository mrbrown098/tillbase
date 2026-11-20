import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, PRODUCT_CSV_COLUMNS, type Db } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { ProductCsvFile, TillbaseApi } from "../shared/api";

let db: Db;
let api: TillbaseApi;
let picked: ProductCsvFile | null;
let saved: { name: string; text: string }[];

/** Stand-ins for the native dialogs, which only exist inside Electron. */
const files = {
  openCsv: async () => picked,
  saveCsv: async (name: string, text: string) => {
    saved.push({ name, text });
    return `/home/shop/${name}`;
  },
};

beforeEach(() => {
  picked = null;
  saved = [];
  db = openDatabase(":memory:");
  api = createHandlers(db, "T1", () => 1_000_000, { files });
});

async function asOwner() {
  await api.setupOwner("Boss", "1111");
}

async function signInAs(name: string, role: "manager" | "cashier", pin: string) {
  await api.createStaff({ name, pin, role });
  const id = (await api.loginUsers()).find((u) => u.name === name)!.id;
  await api.logout();
  await api.login(id, pin);
}

/** Everything the CSV screen could change: products, their stock and categories. */
async function snapshot() {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return JSON.stringify({
    items: await api.listItems("all"),
    movements: count("stock_movements"),
    categories: count("categories"),
  });
}

const stockOf = async (sku: string) => (await api.listItems("all")).find((p) => p.sku === sku)?.stock;
const byName = async (name: string) => (await api.listItems("all")).find((p) => p.name === name);

/** A preview that precedes the import, as the screen always does. */
async function previewThenImport(text: string, options: Parameters<TillbaseApi["importProductCsv"]>[1] = {}) {
  await api.previewProductCsv(text, options);
  return api.importProductCsv(text, options);
}

describe("who may use the CSV screen", () => {
  const calls = (): [string, () => Promise<unknown>][] => [
    ["chooseProductCsv", () => api.chooseProductCsv()],
    ["productCsvTemplate", () => api.productCsvTemplate()],
    ["exportProductCsv", () => api.exportProductCsv()],
    ["saveCsvFile", () => api.saveCsvFile("menu.csv", "name,price\n")],
    ["previewProductCsv", () => api.previewProductCsv("name,price\nTea,10\n")],
    ["importProductCsv", () => api.importProductCsv("name,price\nTea,10\n")],
  ];

  it("needs a signed-in user for every method", async () => {
    for (const [name, call] of calls()) {
      await expect(call(), name).rejects.toThrow(/sign in/);
    }
  });

  it("turns a cashier away from every method, and nothing is saved or opened", async () => {
    await asOwner();
    await api.createProduct({ name: "Tea", priceMinor: 1000 });
    const before = await snapshot(); // taken as the owner: a cashier may not even list items
    await signInAs("Sana", "cashier", "2222");
    picked = { name: "x.csv", text: "name,price\nChai,5\n" };
    for (const [name, call] of calls()) {
      await expect(call(), name).rejects.toThrow(/do not have permission/);
    }
    expect(saved).toEqual([]);
    await api.logout();
    const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
    await api.login(owner.id, "1111");
    expect(await snapshot()).toBe(before);
  });

  it("lets a manager in, because managers already hold products.manage", async () => {
    await asOwner();
    await signInAs("Maha", "manager", "3333");
    expect((await api.session()).permissions).toContain("products.manage");
    expect(await api.productCsvTemplate()).toContain("name");
    expect((await api.previewProductCsv("name,price\nTea,10\n")).created).toBe(1);
  });
});

describe("template and export", () => {
  it("gives a template whose heading row is the documented columns and which imports cleanly", async () => {
    await asOwner();
    const template = await api.productCsvTemplate();
    // Starts with a byte-order mark so Excel reads it as UTF-8.
    expect(template.charCodeAt(0)).toBe(0xfeff);
    expect(template.slice(1).split("\r\n")[0]).toBe(PRODUCT_CSV_COLUMNS.join(","));

    const r = await api.previewProductCsv(template);
    // Two worked examples in the template: Milk 1L and Cooking Oil 1L.
    expect([r.created, r.updated, r.failed]).toEqual([2, 0, 0]);
  });

  it("exports menu items only, retired ones included, and the export imports back as updates", async () => {
    await asOwner();
    await api.createProduct({ name: "Burger", priceMinor: 45_050, sku: "B1", taxRateBp: 1800 }, 12);
    const old = await api.createProduct({ name: "Old Shake", priceMinor: 20_000, sku: "S0" });
    await api.updateProduct(old.id, { active: false });
    await api.createProduct({ name: "Onion", kind: "ingredient", unit: "kg", priceMinor: 0, sku: "ONION" }, 5);

    const csv = await api.exportProductCsv();
    expect(csv).toContain("Burger");
    expect(csv).toContain("Old Shake"); // retired items are kept so the file is a full copy
    expect(csv).not.toContain("Onion"); // ingredients are not part of the file
    expect(csv).toContain("450.50"); // 45,050 minor units written as 450.50, never a float
    expect(csv).toContain("18"); // 1800 basis points written as 18 percent

    const back = await api.previewProductCsv(csv);
    expect([back.created, back.updated, back.failed]).toEqual([0, 2, 0]);
  });

  it("saves through the file hook with a safe .csv name", async () => {
    await asOwner();
    expect(await api.saveCsvFile("tillbase-menu-2026-11-20.csv", "name,price\n")).toBe(
      "/home/shop/tillbase-menu-2026-11-20.csv",
    );
    await api.saveCsvFile("../../etc/passwd", "name,price\n");
    await api.saveCsvFile("", "name,price\n");
    expect(saved.map((s) => s.name)).toEqual(["tillbase-menu-2026-11-20.csv", ".._.._etc_passwd.csv", "tillbase.csv"]);
    expect(saved.every((s) => !/[\\/]/.test(s.name))).toBe(true);
  });

  it("returns the picked file, or null when the person cancels the dialog", async () => {
    await asOwner();
    picked = { name: "menu.csv", text: "name,price\nTea,10\n" };
    expect(await api.chooseProductCsv()).toEqual(picked);
    picked = null;
    expect(await api.chooseProductCsv()).toBeNull();
  });

  it("says plainly when file dialogs are not available", async () => {
    const bare = createHandlers(openDatabase(":memory:"));
    await bare.setupOwner("Boss", "1111");
    await expect(bare.chooseProductCsv()).rejects.toThrow(/not available/);
    await expect(bare.saveCsvFile("a.csv", "x")).rejects.toThrow(/not available/);
  });
});

describe("previewing", () => {
  const text = [
    "name,sku,price,cost,opening_stock,category",
    "Milk 1L,M1,260.00,210.00,99,Dairy",
    "Fries,F1,150.50,60.25,40,Sides",
    "",
  ].join("\n");

  beforeEach(async () => {
    await asOwner();
    await api.createProduct({ name: "Milk 1L", sku: "M1", priceMinor: 25_000, costMinor: 20_000 }, 24);
  });

  it("changes nothing at all, and reports what would happen row by row", async () => {
    const before = await snapshot();
    const r = await api.previewProductCsv(text);
    expect(await snapshot()).toBe(before);

    expect(r.dryRun).toBe(true);
    expect(r.nothingWritten).toBe(true);
    expect([r.created, r.updated, r.skipped, r.failed]).toEqual([1, 1, 0, 0]);
    // Row numbers count the heading as row 1.
    expect(r.rows.map((x) => [x.row, x.action, x.name])).toEqual([
      [2, "updated", "Milk 1L"],
      [3, "created", "Fries"],
    ]);
    // Only the new item gets a stock entry; the existing item's stock is left alone by default.
    expect(r.stockAdjustments).toBe(1);
    expect(await stockOf("M1")).toBe(24);
    expect(await byName("Fries")).toBeUndefined();
  });

  it("shows the effect of each choice", async () => {
    const onlyNew = await api.previewProductCsv(text, { updateExisting: false });
    expect([onlyNew.created, onlyNew.updated, onlyNew.skipped]).toEqual([1, 0, 1]);

    // Milk is at 24 and the file says 99: fixing stock would add 75, plus 40 for the new Fries.
    const fix = await api.previewProductCsv(text, { fixStock: true });
    expect(fix.stockAdjustments).toBe(2);
    expect(await stockOf("M1")).toBe(24);
  });

  it("refuses a file that is far too big, kindly", async () => {
    await expect(api.previewProductCsv("name,price\n" + "x".repeat(5_000_001))).rejects.toThrow(/too big/);
  });
});

describe("importing", () => {
  const text = [
    "name,sku,price,cost,opening_stock,category",
    "Milk 1L,M1,260.00,210.00,99,Dairy",
    "Fries,F1,150.50,60.25,40,Sides",
    "",
  ].join("\n");

  beforeEach(async () => {
    await asOwner();
    await api.createProduct({ name: "Milk 1L", sku: "M1", priceMinor: 25_000, costMinor: 20_000 }, 24);
  });

  it("creates new items and updates existing ones, in whole minor units", async () => {
    const r = await previewThenImport(text);
    expect([r.dryRun, r.nothingWritten, r.created, r.updated, r.failed]).toEqual([false, false, 1, 1, 0]);

    const milk = (await byName("Milk 1L"))!;
    // 260.00 -> 26,000 and 210.00 -> 21,000. Stock stays at 24: the file's 99 is ignored for existing items.
    expect([milk.priceMinor, milk.costMinor, milk.stock]).toEqual([26_000, 21_000, 24]);
    const fries = (await byName("Fries"))!;
    // 150.50 -> 15,050 and 60.25 -> 6,025. New item: opening stock of 40.
    expect([fries.priceMinor, fries.costMinor, fries.stock, fries.kind]).toEqual([15_050, 6_025, 40, "product"]);
    expect(Number.isInteger(fries.priceMinor) && Number.isInteger(fries.costMinor)).toBe(true);
    // Categories named in the file are created and used.
    const cats = db
      .prepare("SELECT c.name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.sku IN ('M1','F1') ORDER BY c.name")
      .all() as { name: string }[];
    expect(cats.map((c) => c.name)).toEqual(["Dairy", "Sides"]);
    expect(r.stockAdjustments).toBe(1);
  });

  it("corrects existing stock through the log when asked, never by overwriting", async () => {
    await previewThenImport("sku,opening_stock\nM1,30\n", { fixStock: true });
    // 30 on the shelf minus 24 recorded is +6, written as a stock count movement. A blank price leaves the price alone.
    expect(await stockOf("M1")).toBe(30);
    expect((await byName("Milk 1L"))!.priceMinor).toBe(25_000);
    const reasons = db
      .prepare("SELECT reason, qty_delta FROM stock_movements ORDER BY rowid")
      .all() as { reason: string; qty_delta: number }[];
    expect(reasons.map((m) => [m.reason, m.qty_delta])).toEqual([["opening stock", 24], ["stock count", 6]]);
  });

  it("will not import a file that was not previewed", async () => {
    const before = await snapshot();
    await expect(api.importProductCsv(text)).rejects.toThrow(/preview/);
    expect(await snapshot()).toBe(before);
  });

  it("will not import a different file, or different choices, than the one previewed", async () => {
    const before = await snapshot();
    await api.previewProductCsv(text);
    await expect(api.importProductCsv(text + "Extra,E1,5.00\n")).rejects.toThrow(/preview/);
    await expect(api.importProductCsv(text, { fixStock: true })).rejects.toThrow(/preview/);
    await expect(api.importProductCsv(text, { updateExisting: false })).rejects.toThrow(/preview/);
    expect(await snapshot()).toBe(before);
    // The original preview still stands for the file it was for.
    expect((await api.importProductCsv(text)).created).toBe(1);
  });

  it("needs a fresh preview for every import, so a double click cannot import twice", async () => {
    await previewThenImport(text);
    const after = await snapshot();
    await expect(api.importProductCsv(text)).rejects.toThrow(/preview/);
    expect(await snapshot()).toBe(after);
  });

  it("leaves ingredients alone, even when a row shares their name", async () => {
    const onion = await api.createProduct({ name: "Onion", kind: "ingredient", unit: "kg", priceMinor: 0, costMinor: 12_000 }, 5);
    await previewThenImport("name,price\nOnion,10.00\n");
    const stillOnion = (await api.listItems("ingredient")).find((p) => p.id === onion.id)!;
    expect([stillOnion.priceMinor, stillOnion.costMinor, stillOnion.stock]).toEqual([0, 12_000, 5]);
    // The row became a separate menu item.
    expect((await api.listItems("product")).some((p) => p.name === "Onion")).toBe(true);
  });
});

describe("rows with problems", () => {
  const bad = [
    "name,sku,price,opening_stock",
    "Burger,B1,450.00,10",
    "Cola,C1,abc,5",
    "Shake,S1,300.00,2",
    "",
  ].join("\n");

  beforeEach(async () => {
    await asOwner();
  });

  it("reports the bad row, with its row number, column and a reason, in the preview", async () => {
    const r = await api.previewProductCsv(bad);
    expect([r.created, r.updated, r.failed]).toEqual([2, 0, 1]);
    const failed = r.rows.filter((x) => x.action === "failed");
    expect(failed.map((x) => [x.row, x.name])).toEqual([[3, "Cola"]]);
    const issue = r.issues.find((i) => i.row === 3)!;
    expect(issue.severity).toBe("error");
    expect(issue.column).toBe("price");
    expect(issue.message.length).toBeGreaterThan(0);
  });

  it("saves nothing by default when one row is bad, and says so", async () => {
    const r = await previewThenImport(bad);
    expect(r.nothingWritten).toBe(true);
    expect(r.created).toBe(0);
    expect(r.failed).toBeGreaterThan(0);
    expect(r.issues.some((i) => i.row === 3 && i.severity === "error")).toBe(true);
    expect(await api.listItems("all")).toHaveLength(0);
  });

  it("imports the good rows and reports the bad one when asked to skip", async () => {
    const r = await previewThenImport(bad, { skipBadRows: true });
    expect(r.nothingWritten).toBe(false);
    expect([r.created, r.failed]).toEqual([2, 1]);
    expect((await api.listItems("all")).map((p) => p.name).sort()).toEqual(["Burger", "Shake"]);
    expect(await stockOf("B1")).toBe(10);
    expect(await byName("Cola")).toBeUndefined();
  });

  it("reports a missing price on a new item and two rows for one item", async () => {
    const r = await api.previewProductCsv("name,sku,price\nTea,T1,\nCake,K1,50\nCake again,K1,60\n");
    expect(r.failed).toBe(2);
    expect(r.issues.find((i) => i.row === 2)!.message).toMatch(/needs a price/);
    expect(r.issues.find((i) => i.row === 4)!.message).toMatch(/Same product as row 3/);
  });

  it("reports a file it cannot understand as a problem with the whole file", async () => {
    const r = await api.previewProductCsv("colour,shape\nred,round\n");
    expect(r.rows).toEqual([]);
    expect(r.issues.some((i) => i.severity === "error")).toBe(true);
    const empty = await api.previewProductCsv("");
    expect(empty.issues[0]).toMatchObject({ row: 0, severity: "error" });
  });

  it("reports an ingredient's SKU clash in the preview", async () => {
    await api.createProduct({ name: "Onion", kind: "ingredient", unit: "kg", priceMinor: 0, sku: "ONION" });
    const r = await api.previewProductCsv("name,sku,price\nOnion Rings,ONION,50.00\n");
    expect(r.failed).toBe(1);
    expect(r.issues[0]!.message).toMatch(/already used by the ingredient "Onion"/);
  });
});
