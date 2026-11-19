import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

export interface RecipeLine {
  ingredientId: string;
  name: string;
  unit: string;
  qty: number;
  /** Cost of this quantity at the ingredient's current average cost, in minor units. */
  costMinor: number;
}

export interface Recipe {
  productId: string;
  lines: RecipeLine[];
  /** Total ingredient cost of making one unit. */
  costMinor: number;
}

/**
 * A recipe says what one unit of a menu item is made of. Selling the item
 * then uses up those ingredients, and the sale records what they cost.
 */
export class RecipeService {
  constructor(private readonly db: Db) {}

  get(productId: string): Recipe {
    const rows = this.db
      .prepare(
        `SELECT ri.ingredient_id AS ingredientId, i.name AS name, i.unit AS unit,
                ri.qty AS qty, ri.qty * i.avg_cost AS cost
           FROM recipe_items ri JOIN products i ON i.id = ri.ingredient_id
          WHERE ri.product_id = ? ORDER BY i.name`,
      )
      .all(productId) as { ingredientId: string; name: string; unit: string; qty: number; cost: number }[];
    const lines = rows.map((r) => ({
      ingredientId: r.ingredientId,
      name: r.name,
      unit: r.unit,
      qty: r.qty,
      costMinor: Math.round(r.cost),
    }));
    const total = rows.reduce((s, r) => s + r.cost, 0);
    return { productId, lines, costMinor: Math.round(total) };
  }

  /** Recipe cost per unit for every menu item that has a recipe, in one query. */
  costs(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT ri.product_id AS id, SUM(ri.qty * i.avg_cost) AS cost
           FROM recipe_items ri JOIN products i ON i.id = ri.ingredient_id
          GROUP BY ri.product_id`,
      )
      .all() as { id: string; cost: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.id] = Math.round(r.cost);
    return out;
  }

  /** Replace the whole recipe. An empty list removes it. */
  set(productId: string, lines: { ingredientId: string; qty: number }[]): Recipe {
    const product = this.db
      .prepare("SELECT kind FROM products WHERE id = ?")
      .get(productId) as { kind: string } | undefined;
    if (!product) throw new Error("Product not found");
    if (product.kind !== "product") throw new Error("Only menu items can have a recipe");

    const seen = new Set<string>();
    for (const l of lines) {
      if (!(l.qty > 0) || !Number.isFinite(l.qty)) {
        throw new Error("Each ingredient quantity must be greater than zero");
      }
      if (seen.has(l.ingredientId)) throw new Error("An ingredient is listed twice");
      seen.add(l.ingredientId);
      const ing = this.db
        .prepare("SELECT kind FROM products WHERE id = ?")
        .get(l.ingredientId) as { kind: string } | undefined;
      if (!ing) throw new Error("Ingredient not found");
      if (ing.kind !== "ingredient") throw new Error("Recipes can only use ingredients");
    }

    this.db.transaction(() => {
      this.db.prepare("DELETE FROM recipe_items WHERE product_id = ?").run(productId);
      const ins = this.db.prepare(
        "INSERT INTO recipe_items (id, product_id, ingredient_id, qty) VALUES (?, ?, ?, ?)",
      );
      for (const l of lines) ins.run(randomUUID(), productId, l.ingredientId, l.qty);
    })();
    return this.get(productId);
  }
}
