import { beforeEach, describe, expect, it } from "vitest";
import {
  InventoryService,
  ProductService,
  ProductCsvService,
  SaleService,
  detectDelimiter,
  formatCsv,
  openDatabase,
  parseCsv,
  type Db,
} from "../src/index.js";
import {
  normalizeHeading,
  parseAmountToMinor,
  parseCsvBoolean,
  parsePercentToBp,
} from "../src/product-csv.js";

let db: Db;
let products: ProductService;
let inventory: InventoryService;
let catalog: ProductCsvService;

beforeEach(() => {
  db = openDatabase(":memory:");
  products = new ProductService(db);
  inventory = new InventoryService(db);
  catalog = new ProductCsvService(db);
});

const errors = (r: { issues: { severity: string; message: string }[] }) =>
  r.issues.filter((i) => i.severity === "error").map((i) => i.message);

describe("csv reader", () => {
  it("reads plain rows and drops blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps commas, quotes and line breaks inside quoted fields", () => {
    const text = 'name,note\n"Cola, 500ml","He said ""hi"""\n"Bread","line one\nline two"\n';
    expect(parseCsv(text)).toEqual([
      ["name", "note"],
      ["Cola, 500ml", 'He said "hi"'],
      ["Bread", "line one\nline two"],
    ]);
  });

  it("accepts CRLF, LF and lone CR line endings", () => {
    const expected = [
      ["a", "b"],
      ["1", "2"],
    ];
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual(expected);
    expect(parseCsv("a,b\n1,2\n")).toEqual(expected);
    expect(parseCsv("a,b\r1,2\r")).toEqual(expected);
  });

  it("ignores a UTF-8 byte-order mark from Excel", () => {
    expect(parseCsv("\uFEFFname,price\nMilk,250\n")).toEqual([
      ["name", "price"],
      ["Milk", "250"],
    ]);
  });

  it("guesses semicolon, tab and pipe separators", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3")).toBe("|");
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("onlyonecolumn")).toBe(",");
  });

  it("does not count separators inside quoted headings", () => {
    expect(detectDelimiter('"a;b";"c;d"\n1;2')).toBe(";");
    expect(detectDelimiter('"Name; full",price\nx,1')).toBe(",");
  });

  it("keeps empty cells and does not trim them", () => {
    expect(parseCsv("a,b,c\n1,,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
    expect(parseCsv("a,b\n x , y \n")).toEqual([
      ["a", "b"],
      [" x ", " y "],
    ]);
  });

  it("refuses a file with a quoted field that is never closed", () => {
    expect(() => parseCsv('a,b\n"oops,2\n')).toThrow(/never closed/);
  });

  it("returns nothing for empty text", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\uFEFF")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });
});

describe("csv writer", () => {
  it("quotes only what needs quoting and ends lines with CRLF", () => {
    expect(formatCsv([["a", "b"], ["x,y", 'say "hi"']])).toBe('a,b\r\n"x,y","say ""hi"""\r\n');
  });

  it("writes empty values for null and undefined", () => {
    expect(formatCsv([["a", "b", "c"], [1, null, undefined]])).toBe("a,b,c\r\n1,,\r\n");
  });

  it("adds a byte-order mark only when asked", () => {
    expect(formatCsv([["a"]], { bom: true })).toBe("\uFEFFa\r\n");
    expect(formatCsv([["a"]])).toBe("a\r\n");
  });

  it("escapes spreadsheet formulas only when asked, and never plain numbers", () => {
    const rows = [["name"], ["=1+1"], ["-5"], ["+923001234567"]];
    expect(formatCsv(rows)).toBe("name\r\n=1+1\r\n-5\r\n+923001234567\r\n");
    expect(formatCsv(rows, { escapeFormulas: true })).toBe(
      "name\r\n'=1+1\r\n-5\r\n'+923001234567\r\n",
    );
  });

  it("survives a round trip of awkward product names", () => {
    const nasty = [
      ["name", "note"],
      ['Cola, 500ml "cold"', "line one\nline two"],
      ["  padded  ", "tab\there"],
      ["Urdu دودھ", ""],
      ["semi;colon", "pipe|char"],
    ];
    for (const delimiter of [",", ";", "\t"]) {
      expect(parseCsv(formatCsv(nasty, { delimiter, bom: true }), { delimiter })).toEqual(nasty);
    }
  });

  it("rejects a delimiter that would break the format", () => {
    expect(() => formatCsv([["a"]], { delimiter: "" })).toThrow(/single character/);
    expect(() => formatCsv([["a"]], { delimiter: '"' })).toThrow(/single character/);
    expect(() => parseCsv("a,b", { delimiter: "\n" })).toThrow(/single character/);
  });
});

describe("reading the values people type", () => {
  it("reads amounts with separators and currency symbols", () => {
    expect(parseAmountToMinor("250")).toBe(25000);
    expect(parseAmountToMinor("250.50")).toBe(25050);
    expect(parseAmountToMinor("1,250.00")).toBe(125000);
    expect(parseAmountToMinor("Rs 1,250")).toBe(125000);
    expect(parseAmountToMinor("₨ 250.5")).toBe(25050);
    expect(parseAmountToMinor("PKR 99.99")).toBe(9999);
    expect(parseAmountToMinor("0")).toBe(0);
  });

  it("rounds to the nearest minor unit instead of storing floats", () => {
    expect(parseAmountToMinor("10.005")).toBe(1001);
    expect(parseAmountToMinor("0.014")).toBe(1);
  });

  it("reads a decimal comma when the file uses one", () => {
    expect(parseAmountToMinor("1.250,50", { decimalComma: true })).toBe(125050);
    expect(parseAmountToMinor("250,50", { decimalComma: true })).toBe(25050);
  });

  it("refuses nonsense and negative money", () => {
    expect(() => parseAmountToMinor("")).toThrow(/amount/);
    expect(() => parseAmountToMinor("free")).toThrow(/amount/);
    expect(() => parseAmountToMinor("-5")).toThrow(/negative/);
    expect(() => parseAmountToMinor("1.2.3")).toThrow(/not a number/);
  });

  it("reads tax as a percentage and stores basis points", () => {
    expect(parsePercentToBp("18")).toBe(1800);
    expect(parsePercentToBp("18%")).toBe(1800);
    expect(parsePercentToBp("18.5")).toBe(1850);
    expect(parsePercentToBp("0")).toBe(0);
    expect(() => parsePercentToBp("101")).toThrow(/between 0 and 100/);
    expect(() => parsePercentToBp("-1")).toThrow(/between 0 and 100/);
    expect(() => parsePercentToBp("lots")).toThrow(/not a tax rate/);
  });

  it("reads the many ways of writing yes and no", () => {
    for (const yes of ["yes", "Y", "true", "1", "on", "ACTIVE"]) expect(parseCsvBoolean(yes)).toBe(true);
    for (const no of ["no", "N", "false", "0", "off", "inactive"]) expect(parseCsvBoolean(no)).toBe(false);
    expect(() => parseCsvBoolean("maybe")).toThrow(/expected yes or no/);
  });

  it("normalises headings from other systems", () => {
    expect(normalizeHeading("Sale Price (PKR)")).toBe("sale_price");
    expect(normalizeHeading("  Item Code ")).toBe("item_code");
    expect(normalizeHeading("GST %")).toBe("gst");
    expect(normalizeHeading("Track Stock?")).toBe("track_stock");
  });
});

describe("importing a product list", () => {
  const basic = "name,sku,barcode,category,price,cost,tax_percent,track_stock,reorder_level,opening_stock\n" +
    "Milk 1L,MILK-1,6001,Dairy,250.00,200.00,0,yes,12,24\n" +
    "Cooking Oil,OIL-1,6002,Grocery,650.00,580.00,18,yes,6,30\n";

  it("creates products, categories and opening stock in one go", () => {
    const r = catalog.importCsv(basic);
    expect(r.created).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.nothingWritten).toBe(false);
    expect(r.stockAdjustments).toBe(2);

    const milk = products.findByBarcode("6001")!;
    expect(milk.name).toBe("Milk 1L");
    expect(milk.sku).toBe("MILK-1");
    expect(milk.priceMinor).toBe(25000);
    expect(milk.costMinor).toBe(20000);
    expect(milk.taxRateBp).toBe(0);
    expect(milk.reorderLevel).toBe(12);
    expect(milk.trackStock).toBe(true);
    expect(inventory.stockOf(milk.id)).toBe(24);
    expect(products.findByBarcode("6002")!.taxRateBp).toBe(1800);

    const categories = db.prepare("SELECT name FROM categories ORDER BY name").all();
    expect(categories).toEqual([{ name: "Dairy" }, { name: "Grocery" }]);

    const move = db
      .prepare("SELECT reason, ref_type FROM stock_movements WHERE product_id = ?")
      .get(milk.id) as { reason: string; ref_type: string };
    expect(move.reason).toBe("opening stock");
    expect(move.ref_type).toBe("csv-import");
  });

  it("writes nothing on a dry run but reports the same plan", () => {
    const preview = catalog.importCsv(basic, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.created).toBe(2);
    expect(preview.stockAdjustments).toBe(2);
    expect(preview.nothingWritten).toBe(true);
    expect(products.list()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_movements").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM categories").get()).toEqual({ n: 0 });

    const real = catalog.importCsv(basic);
    expect(real.created).toBe(preview.created);
    expect(real.stockAdjustments).toBe(preview.stockAdjustments);
  });

  it("accepts headings from another till without renaming them", () => {
    const r = catalog.importCsv(
      "Item Name,Item Code,Barcode,Sale Price (PKR),Cost Price,GST %,Qty,Reorder Level\n" +
        "Sugar 1kg,SUG-1,7001,180.00,150.00,18%,40,5\n",
    );
    expect(r.created).toBe(1);
    const p = products.findByBarcode("7001")!;
    expect(p.name).toBe("Sugar 1kg");
    expect(p.priceMinor).toBe(18000);
    expect(p.costMinor).toBe(15000);
    expect(p.taxRateBp).toBe(1800);
    expect(inventory.stockOf(p.id)).toBe(40);
  });

  it("reads a semicolon file with decimal commas", () => {
    const r = catalog.importCsv("name;price;cost;opening_stock\nBiscuits;1.250,50;900,25;12\n");
    expect(r.created).toBe(1);
    const p = products.list()[0]!;
    expect(p.priceMinor).toBe(125050);
    expect(p.costMinor).toBe(90025);
    expect(inventory.stockOf(p.id)).toBe(12);
  });

  it("accepts minor-unit columns for callers that already speak paisa", () => {
    const r = catalog.importCsv("name,price_minor,cost_minor,tax_rate_bp\nTea,25000,20000,1800\n");
    expect(r.created).toBe(1);
    const p = products.list()[0]!;
    expect(p.priceMinor).toBe(25000);
    expect(p.costMinor).toBe(20000);
    expect(p.taxRateBp).toBe(1800);
  });

  it("ignores unknown columns with a warning, not a failure", () => {
    const r = catalog.importCsv("name,price,supplier_phone\nMilk,250,03001234567\n");
    expect(r.created).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.issues).toEqual([
      { row: 1, column: "supplier_phone", severity: "warning", message: "Unknown column, ignored" },
    ]);
  });

  it("treats a blank cell as leave-it-alone, never as erase", () => {
    catalog.importCsv(basic);
    const before = products.findByBarcode("6001")!;
    const r = catalog.importCsv("sku,price,barcode,cost\nMILK-1,275.00,,\n");
    expect(r.updated).toBe(1);
    const after = products.get(before.id)!;
    expect(after.priceMinor).toBe(27500);
    expect(after.barcode).toBe("6001");
    expect(after.costMinor).toBe(20000);
    expect(after.name).toBe("Milk 1L");
    expect(after.categoryId).toBe(before.categoryId);
  });

  it("matches an existing product by sku, barcode, name or id", () => {
    catalog.importCsv(basic);
    const milk = products.findByBarcode("6001")!;
    for (const header of ["sku", "barcode", "name", "id"]) {
      const key = header === "sku" ? "MILK-1" : header === "barcode" ? "6001" : header === "name" ? "Milk 1L" : milk.id;
      const r = catalog.importCsv(`${header},price\n${key},300.00\n`);
      expect(r.updated, header).toBe(1);
      expect(r.created, header).toBe(0);
      expect(products.get(milk.id)!.priceMinor, header).toBe(30000);
    }
    expect(products.list()).toHaveLength(2);
  });

  it("can be told not to match on name", () => {
    catalog.importCsv(basic);
    const r = catalog.importCsv("name,price\nMilk 1L,300.00\n", { matchOnName: false });
    expect(r.created).toBe(1);
    expect(products.list()).toHaveLength(3);
  });

  it("leaves existing products alone when updates are switched off", () => {
    catalog.importCsv(basic);
    const r = catalog.importCsv("sku,name,price\nMILK-1,,999.00\nNEW-1,New Thing,100.00\n", {
      updateExisting: false,
    });
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(1);
    expect(r.rows.find((x) => x.action === "skipped")!.note).toBe("already exists");
    expect(products.findByBarcode("6001")!.priceMinor).toBe(25000);
  });

  it("falls back to sku and name when an id belongs to another database", () => {
    catalog.importCsv(basic);
    const milk = products.findByBarcode("6001")!;
    const r = catalog.importCsv(`id,sku,price\nstale-id,MILK-1,300.00\n`);
    expect(r.updated).toBe(1);
    expect(r.failed).toBe(0);
    expect(products.get(milk.id)!.priceMinor).toBe(30000);
    expect(r.issues[0]!.severity).toBe("warning");
    expect(r.issues[0]!.message).toMatch(/matched "Milk 1L"/);

    const added = catalog.importCsv("id,name,price\nstale-id,Brand New,250\n");
    expect(added.created).toBe(1);
    expect(added.issues[0]!.message).toMatch(/added as a new product/);
  });

  it("needs a name and a price for anything new", () => {
    const r = catalog.importCsv("sku,price\nONLY-SKU,250\n", { onError: "skip" });
    expect(errors(r)).toContain("A new product needs a name");
    const r2 = catalog.importCsv("name\nNo Price\n");
    expect(errors(r2)).toContain("A new product needs a price");
    expect(products.list()).toHaveLength(0);
  });

  it("saves nothing when one row is bad and the mode is abort", () => {
    const r = catalog.importCsv(
      "name,price,opening_stock\nGood,250,10\nBad,not-a-price,5\nAlso Good,300,4\n",
    );
    expect(r.created).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.nothingWritten).toBe(true);
    expect(r.stockAdjustments).toBe(0);
    expect(products.list()).toHaveLength(0);
    expect(errors(r).some((m) => /Nothing was saved/.test(m))).toBe(true);
    expect(r.rows.find((x) => x.name === "Bad")!.action).toBe("failed");
  });

  it("keeps the good rows when the mode is skip", () => {
    const r = catalog.importCsv(
      "name,price,opening_stock\nGood,250,10\nBad,not-a-price,5\nAlso Good,300,4\n",
      { onError: "skip" },
    );
    expect(r.created).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.nothingWritten).toBe(false);
    expect(products.list().map((p) => p.name)).toEqual(["Also Good", "Good"]);
    const bad = r.rows.find((x) => x.name === "Bad")!;
    expect(bad.action).toBe("failed");
    expect(bad.row).toBe(3);
  });

  it("catches two rows in the file that point at the same product", () => {
    const r = catalog.importCsv("sku,name,price,opening_stock\nS1,First,250,10\nS1,Second,300,20\n");
    expect(r.failed).toBe(1);
    expect(errors(r).some((m) => /Same product as row 2/.test(m))).toBe(true);
    expect(products.list()).toHaveLength(0);
  });

  it("rolls back a barcode clash that only shows up while writing", () => {
    const file = "name,sku,barcode,price\nFirst,S1,9999,250\nSecond,S2,9999,300\n";
    const abort = catalog.importCsv(file);
    expect(abort.created).toBe(0);
    expect(abort.nothingWritten).toBe(true);
    expect(products.list()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_movements").get()).toEqual({ n: 0 });
    expect(errors(abort).some((m) => /barcode already exists/.test(m))).toBe(true);

    const skip = catalog.importCsv(file, { onError: "skip" });
    expect(skip.created).toBe(1);
    expect(skip.failed).toBe(1);
    expect(products.list().map((p) => p.name)).toEqual(["First"]);
  });

  it("refuses a file it cannot understand at all", () => {
    expect(errors(catalog.importCsv(""))).toContain("The file is empty");
    expect(errors(catalog.importCsv("foo,bar\n1,2\n"))[0]).toMatch(/No recognised columns/);
    expect(errors(catalog.importCsv("price,cost\n250,200\n"))[0]).toMatch(/needs a name, sku, barcode or id/);
  });

  it("accepts a header-only file as nothing to do", () => {
    const r = catalog.importCsv("name,price\n");
    expect(r.created).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.issues).toEqual([]);
  });

  it("rejects a negative reorder level", () => {
    const r = catalog.importCsv("name,price,reorder_level\nMilk,250,-3\n");
    expect(r.failed).toBe(1);
    expect(errors(r)).toContain("reorder level must not be negative");
  });

  it("can deactivate and stop tracking stock from the file", () => {
    const r = catalog.importCsv(
      "name,price,track_stock,active,opening_stock\nOld Line,250,no,no,50\n",
    );
    expect(r.created).toBe(1);
    expect(r.stockAdjustments).toBe(0);
    const p = products.list({ includeInactive: true })[0]!;
    expect(p.active).toBe(false);
    expect(p.trackStock).toBe(false);
    expect(inventory.stockOf(p.id)).toBe(0);
  });
});

describe("imported stock stays an auditable log", () => {
  beforeEach(() => {
    catalog.importCsv("name,sku,price,opening_stock\nMilk,M1,250,24\n");
  });

  it("ignores the stock column on existing products by default", () => {
    const milk = products.list()[0]!;
    const r = catalog.importCsv("sku,price,opening_stock\nM1,275,100\n");
    expect(r.updated).toBe(1);
    expect(r.stockAdjustments).toBe(0);
    expect(inventory.stockOf(milk.id)).toBe(24);
    expect(products.get(milk.id)!.priceMinor).toBe(27500);
  });

  it("adds a counted difference, never an overwrite, in set mode", () => {
    const milk = products.list()[0]!;
    const r = catalog.importCsv("sku,opening_stock\nM1,30\n", { stockMode: "set" });
    expect(r.stockAdjustments).toBe(1);
    expect(inventory.stockOf(milk.id)).toBe(30);

    const moves = db
      .prepare("SELECT qty_delta, reason FROM stock_movements WHERE product_id = ? ORDER BY rowid")
      .all(milk.id);
    expect(moves).toEqual([
      { qty_delta: 24, reason: "opening stock" },
      { qty_delta: 6, reason: "stock count" },
    ]);
  });

  it("counts stock down as well as up", () => {
    const milk = products.list()[0]!;
    catalog.importCsv("sku,opening_stock\nM1,20\n", { stockMode: "set" });
    expect(inventory.stockOf(milk.id)).toBe(20);
    const last = db
      .prepare("SELECT qty_delta FROM stock_movements WHERE product_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(milk.id) as { qty_delta: number };
    expect(last.qty_delta).toBe(-4);
  });

  it("writes no movement when the count already matches", () => {
    const r = catalog.importCsv("sku,opening_stock\nM1,24\n", { stockMode: "set" });
    expect(r.stockAdjustments).toBe(0);
  });

  it("handles fractional stock without float dust", () => {
    catalog.importCsv("name,sku,price,opening_stock\nCheese,CH1,1200,0.3\n");
    const cheese = products.findByBarcode("nope") ?? products.list().find((p) => p.sku === "CH1")!;
    catalog.importCsv("sku,opening_stock\nCH1,0.5\n", { stockMode: "set" });
    expect(inventory.stockOf(cheese.id)).toBe(0.5);
  });
});

describe("exporting the catalogue", () => {
  it("writes money as decimals and stock as it stands", () => {
    catalog.importCsv(
      "name,sku,barcode,category,price,cost,tax_percent,reorder_level,opening_stock\n" +
        "Milk 1L,M1,6001,Dairy,250.00,200.00,18,12,24\n",
    );
    const lines = catalog.exportCsv().trim().split("\r\n");
    expect(lines[0]).toBe(
      "name,sku,barcode,category,price,cost,tax_percent,track_stock,reorder_level,opening_stock,active",
    );
    expect(lines[1]).toBe("Milk 1L,M1,6001,Dairy,250.00,200.00,18,yes,12,24,yes");
  });

  it("leaves out inactive products unless asked", () => {
    catalog.importCsv("name,price,active\nLive,250,yes\nRetired,300,no\n");
    expect(catalog.exportCsv()).not.toContain("Retired");
    expect(catalog.exportCsv({ includeInactive: true })).toContain("Retired");
  });

  it("can leave out the stock and id columns", () => {
    catalog.importCsv("name,price\nMilk,250\n");
    expect(catalog.exportCsv({ includeStock: false }).split("\r\n")[0]).not.toContain("opening_stock");
    expect(catalog.exportCsv({ includeIds: true }).split("\r\n")[0]!.startsWith("id,name")).toBe(true);
  });

  it("offers a template that imports cleanly", () => {
    const template = catalog.templateCsv();
    expect(template.split("\r\n")[0]).toBe(
      "name,sku,barcode,category,price,cost,tax_percent,track_stock,reorder_level,opening_stock,active",
    );
    const r = catalog.importCsv(template);
    expect(r.created).toBe(2);
    expect(r.failed).toBe(0);
  });

  it("round-trips a whole catalogue into a fresh database", () => {
    catalog.importCsv(
      "name,sku,barcode,category,price,cost,tax_percent,track_stock,reorder_level,opening_stock,active\n" +
        'Milk 1L,M1,6001,Dairy,250.00,200.00,0,yes,12,24,yes\n' +
        '"Cola, 500ml",C1,6002,Drinks,120.50,90.25,18,yes,6,48,yes\n' +
        'Bread "brown",B1,6003,Bakery,150.00,110.00,0,no,0,,yes\n' +
        "Old Sweet,O1,6004,Sweets,50.00,30.00,5,yes,2,7,no\n",
    );
    const csv = catalog.exportCsv({ includeInactive: true, includeIds: true, bom: true });

    const fresh = openDatabase(":memory:");
    const r = new ProductCsvService(fresh).importCsv(csv);
    expect(r.created).toBe(4);
    expect(r.failed).toBe(0);

    const before = products.list({ includeInactive: true });
    const after = new ProductService(fresh).list({ includeInactive: true });
    const shape = (p: (typeof before)[number]) => ({
      name: p.name,
      sku: p.sku,
      barcode: p.barcode,
      priceMinor: p.priceMinor,
      costMinor: p.costMinor,
      taxRateBp: p.taxRateBp,
      trackStock: p.trackStock,
      reorderLevel: p.reorderLevel,
      active: p.active,
    });
    expect(after.map(shape)).toEqual(before.map(shape));

    const freshInventory = new InventoryService(fresh);
    for (const p of before) {
      const twin = after.find((x) => x.name === p.name)!;
      expect(freshInventory.stockOf(twin.id), p.name).toBe(inventory.stockOf(p.id));
    }
    const names = (fresh.prepare("SELECT name FROM categories ORDER BY name").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(names).toEqual(["Bakery", "Dairy", "Drinks", "Sweets"]);
    fresh.close();
  });

  it("re-imports its own export as updates, not duplicates", () => {
    catalog.importCsv("name,sku,price,opening_stock\nMilk,M1,250,24\nBread,B1,150,10\n");
    const csv = catalog.exportCsv({ includeIds: true });
    const r = catalog.importCsv(csv, { stockMode: "set" });
    expect(r.updated).toBe(2);
    expect(r.created).toBe(0);
    expect(r.stockAdjustments).toBe(0);
    expect(products.list()).toHaveLength(2);
    expect(inventory.stockOf(products.list()[0]!.id)).toBeGreaterThan(0);
  });

  it("exports Urdu names correctly with a byte-order mark", () => {
    catalog.importCsv("name,price\nدودھ 1 لیٹر,250\n");
    const csv = catalog.exportCsv({ bom: true });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("دودھ 1 لیٹر");
    expect(catalog.importCsv(csv).updated).toBe(1);
  });
});

describe("a shop day that starts with an import", () => {
  it("imports a price list, sells from it, and exports the new stock level", () => {
    const preview = catalog.importCsv(
      "Item Name,SKU,Barcode,Sale Price (PKR),GST %,Qty\n" +
        "Milk 1L,M1,6001,250.00,0,24\n" +
        "Cooking Oil,O1,6002,650.00,18,30\n",
      { dryRun: true },
    );
    expect(preview.created).toBe(2);
    expect(products.list()).toHaveLength(0);

    catalog.importCsv(
      "Item Name,SKU,Barcode,Sale Price (PKR),GST %,Qty\n" +
        "Milk 1L,M1,6001,250.00,0,24\n" +
        "Cooking Oil,O1,6002,650.00,18,30\n",
    );

    const sales = new SaleService(db, "T1");
    const milk = products.findByBarcode("6001")!;
    const oil = products.findByBarcode("6002")!;
    const sale = sales.checkout({
      lines: [
        { productId: milk.id, qty: 2 },
        { productId: oil.id, qty: 1 },
      ],
      payments: [{ method: "cash", amountMinor: 200000 }],
      cashier: "Ali",
    });
    // 2 x 250.00 = 500.00 net, plus 18% on 650.00 = 117.00, plus 650.00 net.
    expect(sale.totalMinor).toBe(50000 + 65000 + 11700);
    expect(inventory.stockOf(milk.id)).toBe(22);
    expect(inventory.stockOf(oil.id)).toBe(29);

    const rows = parseCsv(catalog.exportCsv());
    const milkRow = rows.find((r) => r[1] === "M1")!;
    expect(milkRow[9]).toBe("22");

    // A later stock count from the owner's spreadsheet corrects the shelf.
    const counted = catalog.importCsv("SKU,Qty\nM1,20\n", { stockMode: "set" });
    expect(counted.stockAdjustments).toBe(1);
    expect(inventory.stockOf(milk.id)).toBe(20);
    const reasons = db
      .prepare("SELECT reason FROM stock_movements WHERE product_id = ? ORDER BY rowid")
      .all(milk.id) as { reason: string }[];
    expect(reasons.map((r) => r.reason)).toEqual(["opening stock", "sale", "stock count"]);
  });
});
