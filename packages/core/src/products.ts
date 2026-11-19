import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export type ProductKind = "product" | "ingredient";

export interface Product {
  id: string;
  /** "product" is sold at the till. "ingredient" is stock used by recipes. */
  kind: ProductKind;
  sku: string | null;
  barcode: string | null;
  name: string;
  /** Unit stock is counted in: pcs, kg, g, l, ml, pack... */
  unit: string;
  categoryId: string | null;
  priceMinor: number;
  /** Last cost entered by hand. The real cost used in reports is `avgCost`. */
  costMinor: number;
  /** Weighted-average cost of one unit, in minor units. Can be fractional. */
  avgCost: number;
  taxRateBp: number;
  trackStock: boolean;
  reorderLevel: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewProduct {
  name: string;
  priceMinor: number;
  kind?: ProductKind;
  unit?: string;
  sku?: string | null;
  barcode?: string | null;
  categoryId?: string | null;
  costMinor?: number;
  taxRateBp?: number;
  trackStock?: boolean;
  reorderLevel?: number;
}

export type ProductPatch = Partial<NewProduct> & { active?: boolean };

interface Row {
  id: string;
  kind: ProductKind;
  sku: string | null;
  barcode: string | null;
  name: string;
  unit: string;
  category_id: string | null;
  price_minor: number;
  cost_minor: number;
  avg_cost: number;
  tax_rate_bp: number;
  track_stock: number;
  reorder_level: number;
  active: number;
  created_at: string;
  updated_at: string;
}

function fromRow(r: Row): Product {
  return {
    id: r.id,
    kind: r.kind,
    sku: r.sku,
    barcode: r.barcode,
    name: r.name,
    unit: r.unit,
    categoryId: r.category_id,
    priceMinor: r.price_minor,
    costMinor: r.cost_minor,
    avgCost: r.avg_cost,
    taxRateBp: r.tax_rate_bp,
    trackStock: r.track_stock === 1,
    reorderLevel: r.reorder_level,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function assertMoney(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer (minor units)`);
  }
}

function blankToNull(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function cleanUnit(v: string | undefined, fallback: string): string {
  const t = v?.trim();
  return t ? t.slice(0, 12) : fallback;
}

export class ProductService {
  constructor(private readonly db: Db) {}

  create(input: NewProduct): Product {
    const name = input.name?.trim();
    if (!name) throw new Error("Product name is required");
    const kind = input.kind ?? "product";
    if (kind !== "product" && kind !== "ingredient") throw new Error("Unknown product kind");
    assertMoney("priceMinor", input.priceMinor);
    assertMoney("costMinor", input.costMinor ?? 0);
    assertMoney("taxRateBp", input.taxRateBp ?? 0);

    const now = new Date().toISOString();
    const id = randomUUID();
    const cost = input.costMinor ?? 0;
    try {
      this.db
        .prepare(
          `INSERT INTO products
             (id, kind, sku, barcode, name, unit, category_id, price_minor, cost_minor, avg_cost,
              tax_rate_bp, track_stock, reorder_level, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          kind,
          blankToNull(input.sku),
          blankToNull(input.barcode),
          name,
          cleanUnit(input.unit, "pcs"),
          input.categoryId ?? null,
          input.priceMinor,
          cost,
          cost,
          input.taxRateBp ?? 0,
          input.trackStock === false ? 0 : 1,
          input.reorderLevel ?? 0,
          now,
          now,
        );
    } catch (e) {
      throw translateUnique(e);
    }
    return this.mustGet(id);
  }

  update(id: string, patch: ProductPatch): Product {
    const current = this.mustGet(id);
    const next = {
      name: patch.name?.trim() ?? current.name,
      unit: cleanUnit(patch.unit, current.unit),
      sku: patch.sku === undefined ? current.sku : blankToNull(patch.sku),
      barcode:
        patch.barcode === undefined ? current.barcode : blankToNull(patch.barcode),
      categoryId:
        patch.categoryId === undefined ? current.categoryId : patch.categoryId,
      priceMinor: patch.priceMinor ?? current.priceMinor,
      costMinor: patch.costMinor ?? current.costMinor,
      taxRateBp: patch.taxRateBp ?? current.taxRateBp,
      trackStock: patch.trackStock ?? current.trackStock,
      reorderLevel: patch.reorderLevel ?? current.reorderLevel,
      active: patch.active ?? current.active,
    };
    if (patch.kind !== undefined && patch.kind !== current.kind) {
      throw new Error("An item cannot change between product and ingredient");
    }
    if (!next.name) throw new Error("Product name is required");
    assertMoney("priceMinor", next.priceMinor);
    assertMoney("costMinor", next.costMinor);
    assertMoney("taxRateBp", next.taxRateBp);

    // If the owner corrects the cost by hand, that becomes the working average too.
    const avgCost = patch.costMinor !== undefined && patch.costMinor !== current.costMinor
      ? next.costMinor
      : current.avgCost;

    try {
      this.db
        .prepare(
          `UPDATE products SET sku=?, barcode=?, name=?, unit=?, category_id=?, price_minor=?,
             cost_minor=?, avg_cost=?, tax_rate_bp=?, track_stock=?, reorder_level=?, active=?,
             updated_at=? WHERE id=?`,
        )
        .run(
          next.sku,
          next.barcode,
          next.name,
          next.unit,
          next.categoryId,
          next.priceMinor,
          next.costMinor,
          avgCost,
          next.taxRateBp,
          next.trackStock ? 1 : 0,
          next.reorderLevel,
          next.active ? 1 : 0,
          new Date().toISOString(),
          id,
        );
    } catch (e) {
      throw translateUnique(e);
    }
    return this.mustGet(id);
  }

  get(id: string): Product | undefined {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Exact barcode match among active products sold at the till. Used by the scanner. */
  findByBarcode(barcode: string): Product | undefined {
    const row = this.db
      .prepare("SELECT * FROM products WHERE barcode = ? AND active = 1 AND kind = 'product'")
      .get(barcode.trim()) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Search active items by name, SKU or barcode. Sellable products only unless a kind is given. */
  search(query: string, limit = 50, kind: ProductKind = "product"): Product[] {
    const like = `%${query.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM products
          WHERE active = 1 AND kind = ?
            AND (name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR barcode LIKE ? ESCAPE '\\')
          ORDER BY name LIMIT ?`,
      )
      .all(kind, like, like, like, limit) as Row[];
    return rows.map(fromRow);
  }

  list(opts: { includeInactive?: boolean; kind?: ProductKind } = {}): Product[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (!opts.includeInactive) where.push("active = 1");
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    const sql = `SELECT * FROM products ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY name`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(fromRow);
  }

  private mustGet(id: string): Product {
    const p = this.get(id);
    if (!p) throw new Error(`Product not found: ${id}`);
    return p;
  }
}

function translateUnique(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("UNIQUE") && msg.includes("barcode")) {
    return new Error("A product with this barcode already exists");
  }
  if (msg.includes("UNIQUE") && msg.includes("sku")) {
    return new Error("A product with this SKU already exists");
  }
  return e instanceof Error ? e : new Error(msg);
}
