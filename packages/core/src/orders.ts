import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { localDate } from "./dates.js";
import { tidy } from "./inventory.js";
import { SaleService, type PaymentInput, type Sale } from "./sales.js";

export const orderTypes = ["dine_in", "takeaway", "delivery"] as const;
export type OrderType = (typeof orderTypes)[number];
export const kitchenStatuses = ["new", "preparing", "ready", "served"] as const;
export type KitchenStatus = (typeof kitchenStatuses)[number];

export const orderTypeLabel: Record<OrderType, string> = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery",
};

export interface Modifier {
  id: string;
  name: string;
  /** Extra charged per unit of the dish, in minor units. 0 for things like "No onion". */
  priceMinor: number;
  /** Optional ingredient this add-on uses up, per unit of the dish. */
  ingredientId: string | null;
  ingredientQty: number;
  active: boolean;
}

export interface ModifierInput {
  name: string;
  priceMinor?: number;
  ingredientId?: string | null;
  ingredientQty?: number;
}

interface ModSnap {
  id: string;
  name: string;
  priceMinor: number;
  ingredientId: string | null;
  ingredientQty: number;
}

export interface OrderItem {
  id: string;
  productId: string;
  name: string;
  qty: number;
  /** Catalogue price of one, before add-ons. */
  unitPriceMinor: number;
  modifiers: { id: string; name: string; priceMinor: number }[];
  note: string | null;
  sent: boolean;
  /** qty x (price + add-ons), before tax. */
  lineMinor: number;
}

export interface Order {
  id: string;
  /** Short number called out to the customer. Starts at 1 each day. */
  token: number;
  type: OrderType;
  tableLabel: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  note: string | null;
  status: "open" | "paid" | "cancelled";
  kitchenStatus: KitchenStatus | null;
  createdAt: string;
  sentAt: string | null;
  saleId: string | null;
  cancelReason: string | null;
  /** What a delivery order charges on top of the food (minor units). Always 0 for other types. No tax is added to it. */
  deliveryFeeMinor: number;
  /** The order this bill was split from, if it was made by splitting a bill. */
  splitFrom: string | null;
  items: OrderItem[];
  /** The food only, before tax and without the delivery charge. Tax is worked out when the order is paid. */
  subtotalMinor: number;
}

export interface OrderInput {
  type: OrderType;
  tableLabel?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
  /** Delivery orders only: the delivery charge in minor units, a whole number, 0 or more. */
  deliveryFeeMinor?: number;
  note?: string | null;
  userId?: string;
}

export interface KitchenTicket {
  orderId: string;
  token: number;
  type: OrderType;
  tableLabel: string | null;
  note: string | null;
  /** Only what was newly sent, so the kitchen does not make things twice. */
  items: { name: string; qty: number; modifiers: string[]; note: string | null }[];
}

interface OrderRow {
  id: string;
  token: number;
  type: OrderType;
  table_label: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  note: string | null;
  status: "open" | "paid" | "cancelled";
  kitchen_status: KitchenStatus | null;
  created_at: string;
  sent_at: string | null;
  sale_id: string | null;
  cancel_reason: string | null;
  delivery_fee_minor: number;
  split_from: string | null;
}

const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/** A delivery charge is money: a whole number of minor units, 0 or more. */
function checkFee(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new Error("The delivery charge must be a whole amount, 0 or more");
  }
  return v;
}

/** Orders for fast-food and restaurants: tokens, held orders, add-ons and the kitchen. */
export class OrderService {
  private readonly sales: SaleService;

  constructor(
    private readonly db: Db,
    receiptPrefix = "R",
  ) {
    this.sales = new SaleService(db, receiptPrefix);
  }

  // ---- Add-ons ---------------------------------------------------------------

  modifiers(opts: { includeInactive?: boolean } = {}): Modifier[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM modifiers ${opts.includeInactive ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(toModifier);
  }

  addModifier(input: ModifierInput): Modifier {
    const v = this.validateModifier(input);
    const id = randomUUID();
    try {
      this.db
        .prepare(
          "INSERT INTO modifiers (id, name, price_minor, ingredient_id, ingredient_qty) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, v.name, v.priceMinor, v.ingredientId, v.ingredientQty);
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) throw new Error("That add-on already exists");
      throw e;
    }
    return toModifier(this.db.prepare("SELECT * FROM modifiers WHERE id = ?").get(id) as Record<string, unknown>);
  }

  updateModifier(id: string, patch: Partial<ModifierInput> & { active?: boolean }): Modifier {
    const cur = this.db.prepare("SELECT * FROM modifiers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!cur) throw new Error("Add-on not found");
    const m = toModifier(cur);
    const v = this.validateModifier({
      name: patch.name ?? m.name,
      priceMinor: patch.priceMinor ?? m.priceMinor,
      ingredientId: patch.ingredientId === undefined ? m.ingredientId : patch.ingredientId,
      ingredientQty: patch.ingredientQty ?? m.ingredientQty,
    });
    this.db
      .prepare("UPDATE modifiers SET name = ?, price_minor = ?, ingredient_id = ?, ingredient_qty = ?, active = ? WHERE id = ?")
      .run(v.name, v.priceMinor, v.ingredientId, v.ingredientQty, (patch.active ?? m.active) ? 1 : 0, id);
    return toModifier(this.db.prepare("SELECT * FROM modifiers WHERE id = ?").get(id) as Record<string, unknown>);
  }

  private validateModifier(input: ModifierInput) {
    const name = input.name?.trim();
    if (!name) throw new Error("Add-on name is required");
    const priceMinor = input.priceMinor ?? 0;
    if (!Number.isInteger(priceMinor) || priceMinor < 0) throw new Error("Add-on price must be a whole amount, 0 or more");
    const ingredientId = input.ingredientId ?? null;
    const ingredientQty = ingredientId ? (input.ingredientQty ?? 0) : 0;
    if (ingredientId) {
      const ing = this.db.prepare("SELECT kind FROM products WHERE id = ?").get(ingredientId) as { kind: string } | undefined;
      if (!ing || ing.kind !== "ingredient") throw new Error("An add-on can only use an ingredient");
      if (!(ingredientQty > 0)) throw new Error("Say how much of the ingredient the add-on uses");
    }
    return { name, priceMinor, ingredientId, ingredientQty };
  }

  // ---- Orders ----------------------------------------------------------------

  create(input: OrderInput): Order {
    const type = this.checkType(input.type);
    const table = clean(input.tableLabel);
    if (type === "dine_in" && table) this.assertTableFree(table);
    const fee = input.deliveryFeeMinor === undefined ? 0 : checkFee(input.deliveryFeeMinor);
    if (fee > 0 && type !== "delivery") throw new Error("Only delivery orders have a delivery charge");
    const id = randomUUID();
    this.db.transaction(() => {
      const date = localDate();
      const token =
        (this.db.prepare("SELECT COALESCE(MAX(token), 0) AS t FROM orders WHERE token_date = ?").get(date) as { t: number }).t + 1;
      this.db
        .prepare(
          `INSERT INTO orders (id, token_date, token, type, table_label, customer_name, customer_phone,
             delivery_address, note, user_id, created_at, delivery_fee_minor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, date, token, type,
          type === "dine_in" ? table : null,
          clean(input.customerName), clean(input.customerPhone),
          type === "delivery" ? clean(input.deliveryAddress) : null,
          clean(input.note), input.userId ?? null, new Date().toISOString(), fee,
        );
    })();
    return this.mustGet(id);
  }

  /** Change an open order's type, table or customer details. */
  update(orderId: string, patch: Partial<Omit<OrderInput, "userId">>): Order {
    const o = this.mustOpen(orderId);
    const type = patch.type ? this.checkType(patch.type) : o.type;
    const table = patch.tableLabel === undefined ? o.tableLabel : clean(patch.tableLabel);
    if (type === "dine_in" && table) this.assertTableFree(table, orderId);
    const wantedFee = patch.deliveryFeeMinor === undefined ? o.deliveryFeeMinor : checkFee(patch.deliveryFeeMinor);
    if (patch.deliveryFeeMinor !== undefined && wantedFee > 0 && type !== "delivery") {
      throw new Error("Only delivery orders have a delivery charge");
    }
    // Changing a delivery order into something else drops its delivery charge, like its address.
    const fee = type === "delivery" ? wantedFee : 0;
    const pick = <T>(p: T | undefined, cur: T) => (p === undefined ? cur : p);
    this.db
      .prepare(
        `UPDATE orders SET type = ?, table_label = ?, customer_name = ?, customer_phone = ?,
           delivery_address = ?, note = ?, delivery_fee_minor = ? WHERE id = ?`,
      )
      .run(
        type,
        type === "dine_in" ? table : null,
        clean(pick(patch.customerName, o.customerName)),
        clean(pick(patch.customerPhone, o.customerPhone)),
        type === "delivery" ? clean(pick(patch.deliveryAddress, o.deliveryAddress)) : null,
        clean(pick(patch.note, o.note)),
        fee,
        orderId,
      );
    return this.mustGet(orderId);
  }

  addItem(orderId: string, input: { productId: string; qty: number; modifierIds?: string[]; note?: string | null }): Order {
    this.mustOpen(orderId);
    if (!(input.qty > 0) || !Number.isFinite(input.qty)) throw new Error("Quantity must be greater than zero");
    const p = this.db.prepare("SELECT kind, active, name, is_system FROM products WHERE id = ?").get(input.productId) as
      | { kind: string; active: number; name: string; is_system: number }
      | undefined;
    if (!p || p.is_system) throw new Error("Product not found");
    if (p.kind !== "product") throw new Error(`${p.name} is an ingredient and cannot be sold`);
    if (!p.active) throw new Error(`${p.name} is not active`);

    const snaps: ModSnap[] = [];
    for (const mid of [...new Set(input.modifierIds ?? [])]) {
      const m = this.db.prepare("SELECT * FROM modifiers WHERE id = ?").get(mid) as Record<string, unknown> | undefined;
      if (!m || !m.active) throw new Error("That add-on is not available");
      const mod = toModifier(m);
      snaps.push({ id: mod.id, name: mod.name, priceMinor: mod.priceMinor, ingredientId: mod.ingredientId, ingredientQty: mod.ingredientQty });
    }
    this.db
      .prepare("INSERT INTO order_items (id, order_id, product_id, qty, note, modifiers) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), orderId, input.productId, input.qty, clean(input.note), JSON.stringify(snaps));
    return this.mustGet(orderId);
  }

  /** Change a quantity. Items already sent to the kitchen need `allowSent`. */
  setItemQty(itemId: string, qty: number, opts: { allowSent?: boolean } = {}): Order {
    if (!(qty > 0) || !Number.isFinite(qty)) throw new Error("Quantity must be greater than zero");
    const it = this.mustItem(itemId, opts.allowSent);
    this.db.prepare("UPDATE order_items SET qty = ? WHERE id = ?").run(qty, itemId);
    return this.mustGet(it.order_id);
  }

  removeItem(itemId: string, opts: { allowSent?: boolean } = {}): Order {
    const it = this.mustItem(itemId, opts.allowSent);
    this.db.prepare("DELETE FROM order_items WHERE id = ?").run(itemId);
    return this.mustGet(it.order_id);
  }

  /** Send everything not yet sent to the kitchen. Returns the ticket to print or show. */
  sendToKitchen(orderId: string): KitchenTicket {
    const o = this.mustOpen(orderId);
    const fresh = o.items.filter((i) => !i.sent);
    if (fresh.length === 0) throw new Error("Nothing new to send to the kitchen");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const mark = this.db.prepare("UPDATE order_items SET sent_at = ? WHERE id = ?");
      for (const i of fresh) mark.run(now, i.id);
      // New items put a finished order back in the queue.
      this.db
        .prepare("UPDATE orders SET sent_at = COALESCE(sent_at, ?), kitchen_status = 'new' WHERE id = ?")
        .run(now, orderId);
    })();
    return {
      orderId,
      token: o.token,
      type: o.type,
      tableLabel: o.tableLabel,
      note: o.note,
      items: fresh.map((i) => ({ name: i.name, qty: i.qty, modifiers: i.modifiers.map((m) => m.name), note: i.note })),
    };
  }

  setKitchenStatus(orderId: string, status: KitchenStatus): Order {
    if (!kitchenStatuses.includes(status)) throw new Error("Unknown kitchen status");
    const o = this.mustGet(orderId);
    if (o.status === "cancelled") throw new Error("That order was cancelled");
    if (!o.sentAt) throw new Error("That order has not been sent to the kitchen");
    this.db.prepare("UPDATE orders SET kitchen_status = ? WHERE id = ?").run(status, orderId);
    return this.mustGet(orderId);
  }

  /** What the kitchen still has to make or hand over, oldest first. */
  kitchen(): Order[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM orders WHERE status <> 'cancelled' AND kitchen_status IS NOT NULL
            AND kitchen_status <> 'served' ORDER BY sent_at, rowid`,
      )
      .all() as { id: string }[];
    return rows.map((r) => {
      const o = this.mustGet(r.id);
      return { ...o, items: o.items.filter((i) => i.sent) };
    });
  }

  /** Orders waiting to be paid, oldest first. */
  open(): Order[] {
    return (
      this.db.prepare("SELECT id FROM orders WHERE status = 'open' ORDER BY created_at, rowid").all() as { id: string }[]
    ).map((r) => this.mustGet(r.id));
  }

  get(orderId: string): Order | undefined {
    const r = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
    return r ? this.build(r) : undefined;
  }

  /** Cancel an open order. Whatever was already sent to the kitchen is not recovered. */
  cancel(orderId: string, reason: string): Order {
    if (!reason?.trim()) throw new Error("A reason is required");
    this.mustOpen(orderId);
    this.db
      .prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?")
      .run(reason.trim(), orderId);
    return this.mustGet(orderId);
  }

  /** Take payment for an open order. Uses the normal checkout, so stock, cost and profit all follow. */
  pay(
    orderId: string,
    input: { payments: PaymentInput[]; shiftId?: string; userId?: string; cashier?: string; allowNegativeStock?: boolean },
  ): Sale {
    return this.db.transaction((): Sale => {
      const o = this.mustOpen(orderId);
      if (o.items.length === 0) throw new Error("The order has no items");

      // The delivery charge is the last line of the sale, with no tax, so the receipt, the totals
      // and the Money screen all count it as income. It uses a hidden product the app makes for itself.
      const fee = o.type === "delivery" ? o.deliveryFeeMinor : 0;
      const sale = this.sales.checkout({
        lines: [
          ...o.items.map((i) => ({
            productId: i.productId,
            qty: i.qty,
            unitPriceMinor: i.unitPriceMinor + i.modifiers.reduce((s, m) => s + m.priceMinor, 0),
          })),
          ...(fee > 0 ? [{ productId: this.deliveryFeeProductId(), qty: 1, unitPriceMinor: fee }] : []),
        ],
        payments: input.payments,
        cashier: input.cashier,
        shiftId: input.shiftId,
        userId: input.userId,
        allowNegativeStock: input.allowNegativeStock,
      });

      // Label each sale line with its add-ons, and use up add-on ingredients.
      const saleItems = this.db
        .prepare("SELECT id, name FROM sale_items WHERE sale_id = ? ORDER BY rowid")
        .all(sale.id) as { id: string; name: string }[];
      if (saleItems.length !== o.items.length + (fee > 0 ? 1 : 0)) throw new Error("Order lines did not match the sale");
      const full = this.db.prepare("SELECT id, product_id AS pid, modifiers FROM order_items WHERE order_id = ? ORDER BY rowid").all(orderId) as {
        id: string; pid: string; modifiers: string;
      }[];
      const rename = this.db.prepare("UPDATE sale_items SET name = ?, cogs_minor = cogs_minor + ? WHERE id = ?");
      const getIng = this.db.prepare("SELECT name, unit, track_stock AS track, avg_cost AS avg FROM products WHERE id = ?");
      const haveQ = this.db.prepare("SELECT COALESCE(SUM(qty_delta), 0) AS q FROM stock_movements WHERE product_id = ?");
      const move = this.db.prepare(
        `INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor)
         VALUES (?, ?, ?, 'sale', 'sale', ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      const needs = new Map<string, number>();
      o.items.forEach((it, idx) => {
        const mods = JSON.parse(full[idx]!.modifiers) as ModSnap[];
        let extraCogs = 0;
        for (const m of mods) {
          if (!m.ingredientId || !(m.ingredientQty > 0)) continue;
          const q = m.ingredientQty * it.qty;
          const ing = getIng.get(m.ingredientId) as { name: string; unit: string; track: number; avg: number };
          const cost = Math.round(q * ing.avg);
          extraCogs += cost;
          needs.set(m.ingredientId, (needs.get(m.ingredientId) ?? 0) + q);
          move.run(randomUUID(), m.ingredientId, -q, sale.id, now, -cost);
        }
        const label = it.modifiers.length ? `${saleItems[idx]!.name} (${it.modifiers.map((m) => m.name).join(", ")})` : saleItems[idx]!.name;
        rename.run(label, extraCogs, saleItems[idx]!.id);
      });
      if (!input.allowNegativeStock) {
        for (const [id, need] of needs) {
          const ing = getIng.get(id) as { name: string; unit: string; track: number };
          if (!ing.track) continue;
          const have = tidy((haveQ.get(id) as { q: number }).q);
          if (have < 0) {
            throw new Error(`Not enough stock for ${ing.name} (have ${tidy(have + need)} ${ing.unit}, need ${tidy(need)} ${ing.unit})`);
          }
        }
      }

      this.db.prepare("UPDATE orders SET status = 'paid', sale_id = ? WHERE id = ?").run(sale.id, orderId);
      // Paying a dine-in order that never went to the kitchen needs no kitchen status.
      return this.sales.get(sale.id)!;
    })();
  }

  // ---- Splitting a bill ------------------------------------------------------

  /**
   * Move some items (or part of a line's quantity) to a NEW open order with its own token, the same
   * table and the same type, so a group can pay separately. Nothing is added, removed or repriced:
   * the two bills together hold exactly what the original did.
   *
   * - The original must keep at least one item.
   * - Moving part of a line takes whole units (1 of 3), so line totals add up to the cent.
   * - Anything already sent to the kitchen stays marked as sent on both bills, so it is not cooked twice.
   * - A delivery charge stays on the original bill.
   */
  splitItems(
    orderId: string,
    picks: { itemId: string; qty: number }[],
    opts: { userId?: string } = {},
  ): { original: Order; created: Order } {
    return this.db.transaction((): { original: Order; created: Order } => {
      const o = this.mustOpen(orderId);
      if (!Array.isArray(picks) || picks.length === 0) throw new Error("Choose at least one item to move to the new bill");

      const byId = new Map(o.items.map((i) => [i.id, i]));
      const seen = new Set<string>();
      const plan: { item: OrderItem; qty: number; whole: boolean }[] = [];
      for (const pick of picks) {
        const item = byId.get(pick.itemId);
        if (!item) throw new Error("One of the chosen items is not on this order");
        if (seen.has(pick.itemId)) throw new Error(`${item.name} was chosen twice`);
        seen.add(pick.itemId);
        if (typeof pick.qty !== "number" || !(pick.qty > 0) || !Number.isFinite(pick.qty)) {
          throw new Error("Quantity must be greater than zero");
        }
        if (pick.qty > item.qty + 1e-9) {
          throw new Error(`There are only ${tidy(item.qty)} ${item.name} on this bill`);
        }
        const whole = Math.abs(pick.qty - item.qty) < 1e-9;
        if (!whole && !Number.isInteger(pick.qty)) {
          throw new Error(`Only whole quantities can be moved off a line (for example 1 of 3 ${item.name})`);
        }
        plan.push({ item, qty: whole ? item.qty : pick.qty, whole });
      }
      const movedWhole = new Set(plan.filter((p) => p.whole).map((p) => p.item.id));
      if (o.items.every((i) => movedWhole.has(i.id))) {
        throw new Error("The original bill must keep at least one item. To pay for everything, just pay the bill");
      }

      const newId = randomUUID();
      const now = new Date().toISOString();
      const date = localDate();
      const token =
        (this.db.prepare("SELECT COALESCE(MAX(token), 0) AS t FROM orders WHERE token_date = ?").get(date) as { t: number }).t + 1;
      const userId = opts.userId ?? (this.db.prepare("SELECT user_id FROM orders WHERE id = ?").get(orderId) as { user_id: string | null }).user_id;
      this.db
        .prepare(
          `INSERT INTO orders (id, token_date, token, type, table_label, customer_name, customer_phone,
             delivery_address, note, user_id, created_at, split_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(newId, date, token, o.type, o.tableLabel, o.customerName, o.customerPhone, o.deliveryAddress, userId, now, orderId);

      const raw = this.db.prepare("SELECT note, modifiers, sent_at FROM order_items WHERE id = ?");
      for (const { item, qty, whole } of plan) {
        if (whole) {
          this.db.prepare("UPDATE order_items SET order_id = ? WHERE id = ?").run(newId, item.id);
        } else {
          const r = raw.get(item.id) as { note: string | null; modifiers: string; sent_at: string | null };
          this.db.prepare("UPDATE order_items SET qty = ? WHERE id = ?").run(tidy(item.qty - qty), item.id);
          this.db
            .prepare("INSERT INTO order_items (id, order_id, product_id, qty, note, modifiers, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(randomUUID(), newId, item.productId, qty, r.note, r.modifiers, r.sent_at);
        }
      }

      // Kitchen: each bill shows on the board only if it holds something that was sent.
      const newHasSent = plan.some((p) => p.item.sent);
      if (newHasSent) {
        this.db
          .prepare("UPDATE orders SET sent_at = ?, kitchen_status = ? WHERE id = ?")
          .run(o.sentAt ?? now, o.kitchenStatus ?? "new", newId);
      }
      const originalKeepsSent = o.items.some((i) => i.sent && !movedWhole.has(i.id));
      if (!originalKeepsSent && o.sentAt) {
        this.db.prepare("UPDATE orders SET sent_at = NULL, kitchen_status = NULL WHERE id = ?").run(orderId);
      }

      return { original: this.mustGet(orderId), created: this.mustGet(newId) };
    })();
  }

  // ---- internals -------------------------------------------------------------

  private checkType(t: string): OrderType {
    if (!orderTypes.includes(t as OrderType)) throw new Error("Choose dine-in, takeaway or delivery");
    return t as OrderType;
  }

  /** The hidden product the delivery charge is sold as. Made the first time it is needed. */
  private deliveryFeeProductId(): string {
    const found = this.db.prepare("SELECT id FROM products WHERE is_system = 1 AND name = 'Delivery fee'").get() as
      | { id: string }
      | undefined;
    if (found) return found.id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO products (id, name, price_minor, cost_minor, tax_rate_bp, track_stock, reorder_level, active,
           created_at, updated_at, kind, unit, avg_cost, is_system)
         VALUES (?, 'Delivery fee', 0, 0, 0, 0, 0, 1, ?, ?, 'product', 'pcs', 0, 1)`,
      )
      .run(id, now, now);
    return id;
  }

  /** The first bill a split chain started from (the order itself if it was never split). */
  private rootOf(orderId: string): string {
    let cur = orderId;
    for (let i = 0; i < 100; i++) {
      const r = this.db.prepare("SELECT split_from FROM orders WHERE id = ?").get(cur) as { split_from: string | null } | undefined;
      if (!r?.split_from) return cur;
      cur = r.split_from;
    }
    return cur;
  }

  /**
   * One open dine-in order per table, except that bills split from the same order share their table.
   * Without that, editing either bill after a split would be refused.
   */
  private assertTableFree(label: string, exceptOrderId?: string) {
    const others = this.db
      .prepare(
        "SELECT id FROM orders WHERE status = 'open' AND type = 'dine_in' AND table_label = ? COLLATE NOCASE AND id <> ?",
      )
      .all(label, exceptOrderId ?? "") as { id: string }[];
    const family = exceptOrderId ? this.rootOf(exceptOrderId) : null;
    if (others.some((r) => family === null || this.rootOf(r.id) !== family)) {
      throw new Error(`Table ${label} already has an open order`);
    }
  }

  private mustGet(id: string): Order {
    const o = this.get(id);
    if (!o) throw new Error("Order not found");
    return o;
  }

  private mustOpen(id: string): Order {
    const o = this.mustGet(id);
    if (o.status !== "open") throw new Error(o.status === "paid" ? "That order has already been paid" : "That order was cancelled");
    return o;
  }

  private mustItem(itemId: string, allowSent?: boolean) {
    const it = this.db.prepare("SELECT order_id, sent_at FROM order_items WHERE id = ?").get(itemId) as
      | { order_id: string; sent_at: string | null }
      | undefined;
    if (!it) throw new Error("Order item not found");
    this.mustOpen(it.order_id);
    if (it.sent_at && !allowSent) throw new Error("That item has already gone to the kitchen");
    return it;
  }

  private build(r: OrderRow): Order {
    const rows = this.db
      .prepare(
        `SELECT oi.id, oi.product_id AS pid, p.name, p.price_minor AS price, oi.qty, oi.note, oi.modifiers, oi.sent_at
           FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ? ORDER BY oi.rowid`,
      )
      .all(r.id) as { id: string; pid: string; name: string; price: number; qty: number; note: string | null; modifiers: string; sent_at: string | null }[];
    const items: OrderItem[] = rows.map((x) => {
      const mods = (JSON.parse(x.modifiers) as ModSnap[]).map((m) => ({ id: m.id, name: m.name, priceMinor: m.priceMinor }));
      const unit = x.price + mods.reduce((s, m) => s + m.priceMinor, 0);
      return {
        id: x.id, productId: x.pid, name: x.name, qty: x.qty, unitPriceMinor: x.price,
        modifiers: mods, note: x.note, sent: x.sent_at !== null, lineMinor: Math.round(unit * x.qty),
      };
    });
    return {
      id: r.id, token: r.token, type: r.type, tableLabel: r.table_label, customerName: r.customer_name,
      customerPhone: r.customer_phone, deliveryAddress: r.delivery_address, note: r.note, status: r.status,
      kitchenStatus: r.kitchen_status, createdAt: r.created_at, sentAt: r.sent_at, saleId: r.sale_id,
      cancelReason: r.cancel_reason, deliveryFeeMinor: r.delivery_fee_minor, splitFrom: r.split_from,
      items, subtotalMinor: items.reduce((s, i) => s + i.lineMinor, 0),
    };
  }
}

function toModifier(r: Record<string, unknown>): Modifier {
  return {
    id: r.id as string,
    name: r.name as string,
    priceMinor: r.price_minor as number,
    ingredientId: (r.ingredient_id as string | null) ?? null,
    ingredientQty: r.ingredient_qty as number,
    active: r.active === 1,
  };
}
