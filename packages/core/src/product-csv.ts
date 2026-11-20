import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { detectDelimiter, formatCsv, parseCsv, type CsvCell } from "./csv.js";
import { fromMinor } from "./money.js";
import { InventoryService } from "./inventory.js";
import { ProductService, type Product, type ProductPatch } from "./products.js";

/**
 * Moving a product list in and out of Tillbase as a spreadsheet file.
 *
 * A shop switching from another till, or opening a supermarket, should not have
 * to type two thousand products by hand. This reads the CSV that Excel, LibreOffice
 * or the old system exports, and writes one back out for backup or for an accountant.
 *
 * Two rules run through the whole file:
 *   1. Nothing is written until the whole file has been read and checked, so the
 *      owner can see what will happen before it happens (`dryRun`).
 *   2. Stock stays a log of movements. An import never overwrites a stock number;
 *      it adds a movement with a reason, exactly like a stock count would.
 */

/** Column order used by `exportCsv` and `templateCsv`. */
export const PRODUCT_CSV_COLUMNS = [
  "name",
  "sku",
  "barcode",
  "category",
  "price",
  "cost",
  "tax_percent",
  "track_stock",
  "reorder_level",
  "opening_stock",
  "active",
] as const;

type Field =
  | "id"
  | "name"
  | "sku"
  | "barcode"
  | "category"
  | "price"
  | "cost"
  | "tax"
  | "trackStock"
  | "reorderLevel"
  | "openingStock"
  | "active";

interface ColumnSpec {
  field: Field;
  /** Money column already expressed in minor units (paisa, cents). */
  minor?: boolean;
  /** Tax column already expressed in basis points. */
  bp?: boolean;
  aliases: string[];
}

/**
 * Headings we accept, so a file from another system usually works untouched.
 * Matching ignores case, spacing, punctuation and anything in brackets.
 */
const COLUMN_SPECS: ColumnSpec[] = [
  { field: "id", aliases: ["id", "product_id", "uuid"] },
  { field: "name", aliases: ["name", "product", "product_name", "item", "item_name", "title", "description"] },
  { field: "sku", aliases: ["sku", "code", "item_code", "product_code", "article", "article_no"] },
  { field: "barcode", aliases: ["barcode", "bar_code", "ean", "upc", "gtin"] },
  { field: "category", aliases: ["category", "category_name", "group", "department"] },
  { field: "price", aliases: ["price", "sale_price", "selling_price", "retail_price", "unit_price", "mrp", "rate"] },
  { field: "price", minor: true, aliases: ["price_minor", "price_paisa", "price_cents"] },
  { field: "cost", aliases: ["cost", "cost_price", "purchase_price", "buy_price", "purchase_rate"] },
  { field: "cost", minor: true, aliases: ["cost_minor", "cost_paisa", "cost_cents"] },
  { field: "tax", aliases: ["tax_percent", "tax", "tax_rate", "tax_percentage", "gst", "gst_percent", "vat", "vat_percent", "sales_tax"] },
  { field: "tax", bp: true, aliases: ["tax_rate_bp", "tax_bp"] },
  { field: "trackStock", aliases: ["track_stock", "trackstock", "manage_stock", "stock_tracked", "track_inventory"] },
  { field: "reorderLevel", aliases: ["reorder_level", "reorder", "reorder_point", "min_stock", "minimum_stock", "low_stock"] },
  { field: "openingStock", aliases: ["opening_stock", "stock", "qty", "quantity", "stock_qty", "on_hand", "current_stock", "opening_qty"] },
  { field: "active", aliases: ["active", "is_active", "enabled", "status"] },
];

/** "Sale Price (PKR)" and "item code" both become plain lookup keys. */
export function normalizeHeading(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

interface MappedColumn {
  index: number;
  spec: ColumnSpec;
}

const TRUE_WORDS = new Set(["1", "true", "yes", "y", "on", "active", "enabled"]);
const FALSE_WORDS = new Set(["0", "false", "no", "n", "off", "inactive", "disabled"]);

/** Read a yes/no column. Blank is handled by the caller, not here. */
export function parseCsvBoolean(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  throw new Error(`expected yes or no, got "${raw.trim()}"`);
}

/**
 * Read a money amount as minor units. Accepts what people actually type in a
 * spreadsheet: "250", "250.50", "1,250.00", "Rs 1,250", "₨ 250.5".
 *
 * The decimal point is a dot unless `decimalComma` is set, which is the default
 * for semicolon-separated files (the format Excel writes in much of Europe).
 */
export function parseAmountToMinor(raw: string, opts: { decimalComma?: boolean } = {}): number {
  let s = raw.replace(/[^\d.,+-]/g, "");
  if (!s) throw new Error("expected an amount");
  if (opts.decimalComma) s = s.replace(/\./g, "").replace(/,/g, ".");
  else s = s.replace(/,/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) throw new Error("must not be negative");
  if ((s.match(/\./g) ?? []).length > 1) throw new Error(`"${raw.trim()}" is not a number`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`"${raw.trim()}" is not a number`);
  return Math.round(n * 100);
}

/** Read a tax percentage ("18", "18%", "18.5") as basis points (1800, 1850). */
export function parsePercentToBp(raw: string): number {
  const s = raw.replace(/[%\s]/g, "").replace(/,/g, ".");
  const n = Number(s);
  if (!Number.isFinite(n) || s === "") throw new Error(`"${raw.trim()}" is not a tax rate`);
  if (n < 0 || n > 100) throw new Error("tax rate must be between 0 and 100 percent");
  return Math.round(n * 100);
}

/** Stock can be fractional (kg, litres). Tidy float noise the same way the engine does. */
function parseQty(raw: string, decimalComma: boolean): number {
  let s = raw.replace(/[^\d.,+-]/g, "");
  if (decimalComma) s = s.replace(/\./g, "").replace(/,/g, ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (s === "" || !Number.isFinite(n)) throw new Error(`"${raw.trim()}" is not a quantity`);
  return round6(n);
}

/** Keep six decimal places, so 0.1 + 0.2 style float noise never reaches the log. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** One thing wrong with the file. `row` 0 means the whole file, 1 means the header. */
export interface ImportIssue {
  row: number;
  column?: string;
  severity: "error" | "warning";
  message: string;
}

export type ImportAction = "created" | "updated" | "skipped" | "failed";

export interface ImportRowResult {
  /** Row number in the file, counting the header as row 1. */
  row: number;
  action: ImportAction;
  name: string;
  productId?: string;
  note?: string;
}

export interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Stock movements written (or that would be written on a dry run). */
  stockAdjustments: number;
  rows: ImportRowResult[];
  issues: ImportIssue[];
  /** True when nothing was written. */
  get nothingWritten(): boolean;
}

/** What to do with the stock column on rows that match an existing product. */
export type StockMode = "ignore" | "set";

export interface ProductImportOptions {
  /** Check the file and report the plan without writing anything. */
  dryRun?: boolean;
  /** Field separator. Guessed from the header when omitted. */
  delimiter?: string;
  /** Treat a comma as the decimal separator. Defaults to true for `;` files. */
  decimalComma?: boolean;
  /** Update products that already exist. Default true. */
  updateExisting?: boolean;
  /** Fall back to matching by exact name when there is no id, SKU or barcode. Default true. */
  matchOnName?: boolean;
  /**
   * "abort" saves nothing if any row has an error (default).
   * "skip" saves the good rows and reports the bad ones.
   */
  onError?: "abort" | "skip";
  /**
   * "ignore" leaves existing stock alone (default, and the safe choice).
   * "set" adds a "stock count" movement so stock matches the file.
   */
  stockMode?: StockMode;
}

export interface ProductExportOptions {
  includeInactive?: boolean;
  /** Include the internal id column so a re-import updates rather than duplicates. */
  includeIds?: boolean;
  /** Include the current stock column. Default true. */
  includeStock?: boolean;
  delimiter?: string;
  bom?: boolean;
  escapeFormulas?: boolean;
}

interface RowValues {
  id?: string;
  name?: string;
  sku?: string;
  barcode?: string;
  category?: string;
  priceMinor?: number;
  costMinor?: number;
  taxRateBp?: number;
  trackStock?: boolean;
  reorderLevel?: number;
  openingStock?: number;
  active?: boolean;
}

interface Planned {
  row: number;
  action: "created" | "updated" | "skipped";
  name: string;
  values: RowValues;
  existing?: Product;
  note?: string;
}

export class ProductCsvService {
  private readonly products: ProductService;
  private readonly inventory: InventoryService;

  constructor(private readonly db: Db) {
    this.products = new ProductService(db);
    this.inventory = new InventoryService(db);
  }

  /** A header row plus two examples, to hand to someone filling in their list. */
  templateCsv(opts: { delimiter?: string; bom?: boolean } = {}): string {
    return formatCsv(
      [
        [...PRODUCT_CSV_COLUMNS],
        ["Milk 1L", "MILK-1", "6001234500017", "Dairy", "250.00", "200.00", "0", "yes", "12", "24", "yes"],
        ["Cooking Oil 1L", "OIL-1", "6001234500024", "Grocery", "650.00", "580.00", "18", "yes", "6", "30", "yes"],
      ],
      opts,
    );
  }

  /** Every product as CSV, with money as plain decimals and stock as it stands now. */
  exportCsv(opts: ProductExportOptions = {}): string {
    const includeStock = opts.includeStock !== false;
    const columns: string[] = opts.includeIds ? ["id", ...PRODUCT_CSV_COLUMNS] : [...PRODUCT_CSV_COLUMNS];
    if (!includeStock) columns.splice(columns.indexOf("opening_stock"), 1);

    const categories = new Map(
      (this.db.prepare("SELECT id, name FROM categories").all() as { id: string; name: string }[]).map(
        (c) => [c.id, c.name],
      ),
    );
    const stock = includeStock ? this.inventory.stockLevels() : {};
    // Menu items only: ingredients are bought and counted, not sold, and are not part of this file.
    const list = this.products.list({ includeInactive: opts.includeInactive ?? false, kind: "product" });

    const rows: CsvCell[][] = [columns];
    for (const p of list) {
      const cells: Record<string, CsvCell> = {
        id: p.id,
        name: p.name,
        sku: p.sku ?? "",
        barcode: p.barcode ?? "",
        category: p.categoryId ? categories.get(p.categoryId) ?? "" : "",
        price: fromMinor(p.priceMinor).toFixed(2),
        cost: fromMinor(p.costMinor).toFixed(2),
        tax_percent: String(p.taxRateBp / 100),
        track_stock: p.trackStock ? "yes" : "no",
        reorder_level: String(p.reorderLevel),
        opening_stock: p.trackStock ? String(stock[p.id] ?? 0) : "",
        active: p.active ? "yes" : "no",
      };
      rows.push(columns.map((c) => cells[c] ?? ""));
    }
    return formatCsv(rows, {
      delimiter: opts.delimiter,
      bom: opts.bom,
      escapeFormulas: opts.escapeFormulas,
    });
  }

  /**
   * Read a product list. With `dryRun` nothing is written and the result says
   * what would happen; otherwise the whole import runs in one transaction.
   */
  importCsv(text: string, opts: ProductImportOptions = {}): ImportResult {
    const dryRun = opts.dryRun ?? false;
    const updateExisting = opts.updateExisting ?? true;
    const matchOnName = opts.matchOnName ?? true;
    const onError = opts.onError ?? "abort";
    const stockMode = opts.stockMode ?? "ignore";

    const delimiter = opts.delimiter ?? detectDelimiter(text);
    const decimalComma = opts.decimalComma ?? delimiter === ";";
    const grid = parseCsv(text, { delimiter });

    const issues: ImportIssue[] = [];
    const results: ImportRowResult[] = [];
    const plan: Planned[] = [];

    if (grid.length === 0) {
      issues.push({ row: 0, severity: "error", message: "The file is empty" });
      return finish(true, 0);
    }

    const header = grid[0]!;
    const mapped: MappedColumn[] = [];
    const seen = new Set<Field>();
    header.forEach((raw, index) => {
      const key = normalizeHeading(raw);
      const spec = COLUMN_SPECS.find((s) => s.aliases.includes(key));
      if (!spec) {
        if (key) {
          issues.push({
            row: 1,
            column: raw.trim(),
            severity: "warning",
            message: "Unknown column, ignored",
          });
        }
        return;
      }
      if (seen.has(spec.field)) {
        issues.push({
          row: 1,
          column: raw.trim(),
          severity: "warning",
          message: `Duplicate column for "${spec.field}", the first one is used`,
        });
        return;
      }
      seen.add(spec.field);
      mapped.push({ index, spec });
    });

    if (mapped.length === 0) {
      issues.push({
        row: 1,
        severity: "error",
        message: `No recognised columns. Expected headings such as ${PRODUCT_CSV_COLUMNS.slice(0, 5).join(", ")}`,
      });
      return finish(true, 0);
    }
    if (!seen.has("name") && !seen.has("sku") && !seen.has("barcode") && !seen.has("id")) {
      issues.push({
        row: 1,
        severity: "error",
        message: "The file needs a name, sku, barcode or id column so products can be identified",
      });
      return finish(true, 0);
    }

    const targets = new Map<string, number>();
    for (let r = 1; r < grid.length; r++) {
      const cells = grid[r]!;
      const rowNo = r + 1;
      const values: RowValues = {};
      let rowFailed = false;

      for (const { index, spec } of mapped) {
        const raw = (cells[index] ?? "").trim();
        if (raw === "") continue; // blank means "leave this alone"
        try {
          switch (spec.field) {
            case "id":
              values.id = raw;
              break;
            case "name":
              values.name = raw;
              break;
            case "sku":
              values.sku = raw;
              break;
            case "barcode":
              values.barcode = raw;
              break;
            case "category":
              values.category = raw;
              break;
            case "price":
              values.priceMinor = spec.minor
                ? wholeMinor(raw, "price")
                : parseAmountToMinor(raw, { decimalComma });
              break;
            case "cost":
              values.costMinor = spec.minor
                ? wholeMinor(raw, "cost")
                : parseAmountToMinor(raw, { decimalComma });
              break;
            case "tax":
              values.taxRateBp = spec.bp ? wholeMinor(raw, "tax rate") : parsePercentToBp(raw);
              break;
            case "trackStock":
              values.trackStock = parseCsvBoolean(raw);
              break;
            case "active":
              values.active = parseCsvBoolean(raw);
              break;
            case "reorderLevel": {
              const n = parseQty(raw, decimalComma);
              if (n < 0) throw new Error("reorder level must not be negative");
              values.reorderLevel = n;
              break;
            }
            case "openingStock":
              values.openingStock = parseQty(raw, decimalComma);
              break;
          }
        } catch (e) {
          rowFailed = true;
          issues.push({
            row: rowNo,
            column: header[index]?.trim(),
            severity: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const label = values.name ?? values.sku ?? values.barcode ?? values.id ?? "(unnamed)";
      if (rowFailed) {
        results.push({ row: rowNo, action: "failed", name: label });
        continue;
      }

      // Find the product this row is about, if it already exists. An id from our
      // own export is a hint: restoring into a new database has different ids, so
      // fall back to SKU, barcode and name rather than refusing the file.
      // Only menu items are matched: an id, SKU, barcode or name that belongs to an ingredient
      // must never let a menu-item file change that ingredient.
      const byId = values.id ? this.products.get(values.id) : undefined;
      let existing = byId?.kind === "product" ? byId : undefined;
      const idMissed = values.id !== undefined && !existing;
      if (!existing) existing = this.findExisting(values, matchOnName);
      if (idMissed) {
        issues.push({
          row: rowNo,
          column: "id",
          severity: "warning",
          message: existing
            ? `No product with id ${values.id}; matched "${existing.name}" by sku, barcode or name`
            : `No product with id ${values.id}; this row will be added as a new product`,
        });
      }

      if (!existing) {
        // SKUs and barcodes are unique across menu items and ingredients. Say so now, in the
        // preview, rather than failing only when the import writes.
        const clash = this.ingredientClash(values);
        if (clash) {
          issues.push({ row: rowNo, column: clash.column, severity: "error", message: clash.message });
          results.push({ row: rowNo, action: "failed", name: label });
          continue;
        }
      }

      if (!existing && values.name === undefined) {
        issues.push({ row: rowNo, column: "name", severity: "error", message: "A new product needs a name" });
        results.push({ row: rowNo, action: "failed", name: label });
        continue;
      }
      if (!existing && values.priceMinor === undefined) {
        issues.push({
          row: rowNo,
          column: "price",
          severity: "error",
          message: "A new product needs a price",
        });
        results.push({ row: rowNo, action: "failed", name: label });
        continue;
      }

      const key = existing
        ? `id:${existing.id}`
        : `new:${(values.sku ?? values.barcode ?? values.name ?? "").toLowerCase()}`;
      const firstRow = targets.get(key);
      if (firstRow !== undefined) {
        issues.push({
          row: rowNo,
          severity: "error",
          message: `Same product as row ${firstRow}; merge the two rows into one`,
        });
        results.push({ row: rowNo, action: "failed", name: label });
        continue;
      }
      targets.set(key, rowNo);

      const name = values.name ?? existing?.name ?? label;
      if (existing && !updateExisting) {
        plan.push({ row: rowNo, action: "skipped", name, values, existing, note: "already exists" });
        continue;
      }
      plan.push({ row: rowNo, action: existing ? "updated" : "created", name, values, existing });
    }

    const predictedAdjustments = (): number =>
      plan.filter((p) => p.action !== "skipped" && this.stockDeltaFor(p, stockMode) !== 0).length;

    const hasErrors = issues.some((i) => i.severity === "error");
    if (dryRun || (onError === "abort" && hasErrors)) {
      if (!dryRun) {
        issues.push({
          row: 0,
          severity: "error",
          message: 'Nothing was saved because some rows have errors. Fix them, or import with onError: "skip".',
        });
      }
      for (const item of plan) {
        results.push({
          row: item.row,
          action: dryRun ? item.action : "skipped",
          name: item.name,
          productId: item.existing?.id,
          note: dryRun ? item.note : "not applied",
        });
      }
      return finish(true, dryRun ? predictedAdjustments() : 0);
    }

    // Write. Each row is a savepoint so "skip" can drop one bad row and keep the rest.
    let adjustments = 0;
    const applyRow = this.db.transaction((item: Planned): string => {
      const delta = this.stockDeltaFor(item, stockMode); // measure before writing
      const productId = this.applyOne(item, stockMode);
      if (delta !== 0) adjustments++;
      return productId;
    });
    let aborted = false;
    const applyAll = this.db.transaction((): void => {
      for (const item of plan) {
        if (item.action === "skipped") {
          results.push({
            row: item.row,
            action: "skipped",
            name: item.name,
            productId: item.existing?.id,
            note: item.note,
          });
          continue;
        }
        try {
          const productId = applyRow(item);
          results.push({ row: item.row, action: item.action, name: item.name, productId });
        } catch (e) {
          issues.push({
            row: item.row,
            severity: "error",
            message: e instanceof Error ? e.message : String(e),
          });
          results.push({ row: item.row, action: "failed", name: item.name });
          if (onError === "abort") {
            aborted = true;
            throw e;
          }
        }
      }
    });

    try {
      applyAll();
    } catch {
      if (!aborted) throw new Error("Import failed");
    }

    if (aborted) {
      // The transaction rolled back, so nothing in `results` actually happened.
      const failedRows = new Set(results.filter((r) => r.action === "failed").map((r) => r.row));
      const parseFailures = results.filter((r) => r.action === "failed" && !plan.some((p) => p.row === r.row));
      results.length = 0;
      issues.push({ row: 0, severity: "error", message: "Nothing was saved: the import was rolled back" });
      for (const r of parseFailures) results.push(r);
      for (const item of plan) {
        results.push({
          row: item.row,
          action: failedRows.has(item.row) ? "failed" : "skipped",
          name: item.name,
          note: failedRows.has(item.row) ? undefined : "not applied",
        });
      }
      return finish(true, 0);
    }

    return finish(false, adjustments);

    /** Build the report. `nothingWritten` is true for dry runs and rollbacks. */
    function finish(nothingWritten: boolean, stockAdjustments: number): ImportResult {
      const sorted = [...results].sort((a, b) => a.row - b.row);
      const count = (a: ImportAction): number => sorted.filter((r) => r.action === a).length;
      return {
        dryRun,
        created: count("created"),
        updated: count("updated"),
        skipped: count("skipped"),
        failed: count("failed"),
        stockAdjustments,
        rows: sorted,
        issues,
        get nothingWritten() {
          return nothingWritten;
        },
      };
    }
  }

  /**
   * The stock movement a row would cause, or 0 for none. Used both to preview
   * the plan and to count what was written, so the two can never disagree.
   */
  private stockDeltaFor(item: Planned, stockMode: StockMode): number {
    const target = item.values.openingStock;
    if (target === undefined) return 0;
    const tracks = item.values.trackStock ?? item.existing?.trackStock ?? true;
    if (!tracks) return 0;
    if (!item.existing) return target;
    if (stockMode !== "set") return 0;
    return round6(target - this.inventory.stockOf(item.existing.id));
  }

  /** Match on SKU, then barcode, then exact name. Inactive products count too. */
  private findExisting(v: RowValues, matchOnName: boolean): Product | undefined {
    const lookups: [string, string][] = [];
    if (v.sku) lookups.push(["sku", v.sku]);
    if (v.barcode) lookups.push(["barcode", v.barcode]);
    if (matchOnName && v.name) lookups.push(["name", v.name]);
    for (const [column, value] of lookups) {
      const row = this.db
        .prepare(
          `SELECT id FROM products WHERE ${column} = ? COLLATE NOCASE AND kind = 'product' ORDER BY created_at LIMIT 1`,
        )
        .get(value) as { id: string } | undefined;
      if (row) return this.products.get(row.id);
    }
    return undefined;
  }

  /** An ingredient already using the SKU or barcode a new menu item asks for, if any. */
  private ingredientClash(v: RowValues): { column: string; message: string } | undefined {
    for (const [column, value] of [["sku", v.sku], ["barcode", v.barcode]] as const) {
      if (!value) continue;
      const row = this.db
        .prepare(`SELECT name FROM products WHERE ${column} = ? AND kind = 'ingredient' LIMIT 1`)
        .get(value) as { name: string } | undefined;
      if (row) {
        return {
          column,
          message: `The ${column === "sku" ? "SKU" : "barcode"} ${value} is already used by the ingredient "${row.name}"`,
        };
      }
    }
    return undefined;
  }

  /** Categories are referenced by id, but people write names. Create on first use. */
  private categoryId(name: string): string {
    const found = this.db
      .prepare("SELECT id FROM categories WHERE name = ? COLLATE NOCASE")
      .get(name) as { id: string } | undefined;
    if (found) return found.id;
    const id = randomUUID();
    this.db.prepare("INSERT INTO categories (id, name) VALUES (?, ?)").run(id, name);
    return id;
  }

  private applyOne(item: Planned, stockMode: StockMode): string {
    const v = item.values;
    let productId: string;

    if (item.existing) {
      productId = item.existing.id;
      const patch: ProductPatch = {};
      if (v.name !== undefined) patch.name = v.name;
      if (v.sku !== undefined) patch.sku = v.sku;
      if (v.barcode !== undefined) patch.barcode = v.barcode;
      if (v.category !== undefined) patch.categoryId = this.categoryId(v.category);
      if (v.priceMinor !== undefined) patch.priceMinor = v.priceMinor;
      if (v.costMinor !== undefined) patch.costMinor = v.costMinor;
      if (v.taxRateBp !== undefined) patch.taxRateBp = v.taxRateBp;
      if (v.trackStock !== undefined) patch.trackStock = v.trackStock;
      if (v.reorderLevel !== undefined) patch.reorderLevel = v.reorderLevel;
      if (v.active !== undefined) patch.active = v.active;
      if (Object.keys(patch).length > 0) this.products.update(productId, patch);
    } else {
      const created = this.products.create({
        name: v.name!,
        priceMinor: v.priceMinor!,
        sku: v.sku ?? null,
        barcode: v.barcode ?? null,
        categoryId: v.category ? this.categoryId(v.category) : null,
        costMinor: v.costMinor ?? 0,
        taxRateBp: v.taxRateBp ?? 0,
        trackStock: v.trackStock ?? true,
        reorderLevel: v.reorderLevel ?? 0,
      });
      productId = created.id;
      if (v.active === false) this.products.update(productId, { active: false });
    }

    const delta = this.stockDeltaFor(item, stockMode);
    if (delta !== 0) {
      this.inventory.adjust(productId, delta, item.existing ? "stock count" : "opening stock", {
        type: "csv-import",
        id: productId,
      });
    }
    return productId;
  }
}

function wholeMinor(raw: string, label: string): number {
  const n = Number(raw.replace(/[,\s]/g, ""));
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative whole number of minor units`);
  }
  return n;
}
