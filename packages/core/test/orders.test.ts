import { beforeEach, describe, expect, it } from "vitest";
import {
  FinanceService, InventoryService, OrderService, ProductService, PurchaseService, RecipeService,
  SaleService, dates, formatReceipt, openDatabase, type Db,
} from "../src/index.js";

let db: Db;
let orders: OrderService;
let products: ProductService;
let purchases: PurchaseService;
let inventory: InventoryService;
let recipes: RecipeService;
let sales: SaleService;

beforeEach(() => {
  db = openDatabase(":memory:");
  orders = new OrderService(db, "T1");
  products = new ProductService(db);
  purchases = new PurchaseService(db);
  inventory = new InventoryService(db);
  recipes = new RecipeService(db);
  sales = new SaleService(db, "T1");
});

/** A zinger burger (chicken 0.15kg at 80,000/kg + a bun at 2,000 = 14,000 cost), price 45,000. */
function shop() {
  const chicken = products.create({ name: "Chicken", kind: "ingredient", unit: "kg", priceMinor: 0 });
  const bun = products.create({ name: "Bun", kind: "ingredient", unit: "pcs", priceMinor: 0 });
  const cheese = products.create({ name: "Cheese slice", kind: "ingredient", unit: "pcs", priceMinor: 0 });
  purchases.record({ items: [{ productId: chicken.id, qty: 10, costMinor: 800_000 }], paidMinor: 800_000 });
  purchases.record({ items: [{ productId: bun.id, qty: 100, costMinor: 200_000 }], paidMinor: 200_000 });
  purchases.record({ items: [{ productId: cheese.id, qty: 50, costMinor: 100_000 }], paidMinor: 100_000 }); // 2,000 each
  const zinger = products.create({ name: "Zinger", priceMinor: 45_000, trackStock: false });
  recipes.set(zinger.id, [{ ingredientId: chicken.id, qty: 0.15 }, { ingredientId: bun.id, qty: 1 }]);
  const cola = products.create({ name: "Cola", priceMinor: 8_000, costMinor: 5_000 });
  inventory.adjust(cola.id, 20, "opening stock");
  const extraCheese = orders.addModifier({ name: "Extra cheese", priceMinor: 5_000, ingredientId: cheese.id, ingredientQty: 1 });
  const noOnion = orders.addModifier({ name: "No onion" });
  return { chicken, bun, cheese, zinger, cola, extraCheese, noOnion };
}
const cash = (n: number) => [{ method: "cash" as const, amountMinor: n }];

describe("tokens and order types", () => {
  it("numbers orders 1, 2, 3 each day", () => {
    const a = orders.create({ type: "takeaway" });
    const b = orders.create({ type: "takeaway" });
    expect([a.token, b.token]).toEqual([1, 2]);
    // A new day starts again at 1
    db.prepare("UPDATE orders SET token_date = '2020-01-01'").run();
    expect(orders.create({ type: "delivery", deliveryAddress: "House 5" }).token).toBe(1);
  });

  it("keeps table and delivery details only for the types that use them", () => {
    const dine = orders.create({ type: "dine_in", tableLabel: " 5 ", deliveryAddress: "ignored" });
    expect(dine).toMatchObject({ tableLabel: "5", deliveryAddress: null });
    const del = orders.create({ type: "delivery", tableLabel: "9", deliveryAddress: "House 5", customerPhone: "0300" });
    expect(del).toMatchObject({ tableLabel: null, deliveryAddress: "House 5", customerPhone: "0300" });
    expect(orders.update(del.id, { type: "takeaway" })).toMatchObject({ type: "takeaway", deliveryAddress: null });
    expect(() => orders.create({ type: "pickup" as never })).toThrow(/dine-in, takeaway or delivery/);
  });

  it("does not seat two open orders at the same table, but frees it when paid", () => {
    const { zinger } = shop();
    const a = orders.create({ type: "dine_in", tableLabel: "5" });
    expect(() => orders.create({ type: "dine_in", tableLabel: "5" })).toThrow(/Table 5 already has an open order/);
    orders.create({ type: "takeaway", tableLabel: "5" }); // takeaway is not a table
    orders.addItem(a.id, { productId: zinger.id, qty: 1 });
    orders.pay(a.id, { payments: cash(45_000) });
    expect(orders.create({ type: "dine_in", tableLabel: "5" }).tableLabel).toBe("5");
  });
});

describe("building an order", () => {
  it("prices items with their add-ons and keeps held orders open", () => {
    const { zinger, extraCheese, noOnion } = shop();
    const o = orders.create({ type: "takeaway" });
    const withMods = orders.addItem(o.id, { productId: zinger.id, qty: 2, modifierIds: [extraCheese.id, noOnion.id], note: "well done" });
    expect(withMods.items[0]).toMatchObject({ name: "Zinger", qty: 2, lineMinor: 100_000, note: "well done", sent: false });
    expect(withMods.items[0]!.modifiers.map((m) => m.name)).toEqual(["Extra cheese", "No onion"]);
    expect(withMods.subtotalMinor).toBe(100_000); // 2 x (45,000 + 5,000)
    expect(orders.open().map((x) => x.id)).toEqual([o.id]);
  });

  it("will not take ingredients, inactive items or unknown add-ons", () => {
    const { chicken, zinger } = shop();
    const o = orders.create({ type: "takeaway" });
    expect(() => orders.addItem(o.id, { productId: chicken.id, qty: 1 })).toThrow(/ingredient and cannot be sold/);
    expect(() => orders.addItem(o.id, { productId: zinger.id, qty: 0 })).toThrow(/greater than zero/);
    expect(() => orders.addItem(o.id, { productId: zinger.id, qty: 1, modifierIds: ["nope"] })).toThrow(/not available/);
    products.update(zinger.id, { active: false });
    expect(() => orders.addItem(o.id, { productId: zinger.id, qty: 1 })).toThrow(/not active/);
  });

  it("validates add-ons", () => {
    const { chicken, bun } = shop();
    expect(() => orders.addModifier({ name: "extra cheese" })).toThrow(/already exists/);
    expect(() => orders.addModifier({ name: " " })).toThrow(/name is required/);
    expect(() => orders.addModifier({ name: "X", priceMinor: -1 })).toThrow(/0 or more/);
    expect(() => orders.addModifier({ name: "X", ingredientId: chicken.id })).toThrow(/how much/);
    const zinger = products.create({ name: "Z2", priceMinor: 1 });
    expect(() => orders.addModifier({ name: "Y", ingredientId: zinger.id, ingredientQty: 1 })).toThrow(/only use an ingredient/);
    const m = orders.addModifier({ name: "Extra bun", priceMinor: 3_000, ingredientId: bun.id, ingredientQty: 1 });
    expect(orders.updateModifier(m.id, { active: false }).active).toBe(false);
    expect(orders.modifiers().some((x) => x.id === m.id)).toBe(false);
  });
});

describe("the kitchen", () => {
  it("sends only what is new, and tracks progress to served", () => {
    const { zinger, cola, noOnion } = shop();
    const o = orders.create({ type: "dine_in", tableLabel: "3", note: "birthday" });
    orders.addItem(o.id, { productId: zinger.id, qty: 2, modifierIds: [noOnion.id] });
    const t1 = orders.sendToKitchen(o.id);
    expect(t1).toMatchObject({ token: 1, tableLabel: "3", note: "birthday" });
    expect(t1.items).toEqual([{ name: "Zinger", qty: 2, modifiers: ["No onion"], note: null }]);
    expect(() => orders.sendToKitchen(o.id)).toThrow(/Nothing new/);

    orders.addItem(o.id, { productId: cola.id, qty: 2 });
    expect(orders.sendToKitchen(o.id).items.map((i) => i.name)).toEqual(["Cola"]); // not the burgers again

    expect(orders.kitchen()).toHaveLength(1);
    expect(orders.kitchen()[0]!.kitchenStatus).toBe("new");
    orders.setKitchenStatus(o.id, "preparing");
    orders.setKitchenStatus(o.id, "ready");
    expect(orders.kitchen()[0]!.kitchenStatus).toBe("ready");
    orders.setKitchenStatus(o.id, "served");
    expect(orders.kitchen()).toHaveLength(0);

    // Adding something after serving puts the order back in the queue
    orders.addItem(o.id, { productId: cola.id, qty: 1 });
    orders.sendToKitchen(o.id);
    expect(orders.kitchen()).toHaveLength(1);
  });

  it("guards items already in the kitchen and orders not yet sent", () => {
    const { zinger } = shop();
    const o = orders.create({ type: "takeaway" });
    expect(() => orders.setKitchenStatus(o.id, "ready")).toThrow(/not been sent/);
    const withItem = orders.addItem(o.id, { productId: zinger.id, qty: 1 });
    orders.sendToKitchen(o.id);
    const id = withItem.items[0]!.id;
    expect(() => orders.setItemQty(id, 3)).toThrow(/already gone to the kitchen/);
    expect(() => orders.removeItem(id)).toThrow(/already gone to the kitchen/);
    expect(orders.setItemQty(id, 3, { allowSent: true }).items[0]!.qty).toBe(3);
    expect(orders.removeItem(id, { allowSent: true }).items).toHaveLength(0);
    expect(() => orders.setKitchenStatus(o.id, "boiling" as never)).toThrow(/Unknown/);
  });

  it("a cancelled order disappears from the kitchen", () => {
    const { zinger } = shop();
    const o = orders.create({ type: "takeaway" });
    orders.addItem(o.id, { productId: zinger.id, qty: 1 });
    orders.sendToKitchen(o.id);
    expect(() => orders.cancel(o.id, " ")).toThrow(/reason/);
    orders.cancel(o.id, "customer left");
    expect(orders.kitchen()).toHaveLength(0);
    expect(orders.open()).toHaveLength(0);
    expect(() => orders.addItem(o.id, { productId: zinger.id, qty: 1 })).toThrow(/cancelled/);
  });
});

describe("paying an order", () => {
  it("makes a normal sale with add-on prices, costs and stock all following", () => {
    const { zinger, chicken, bun, cheese, extraCheese, noOnion } = shop();
    const o = orders.create({ type: "dine_in", tableLabel: "7" });
    orders.addItem(o.id, { productId: zinger.id, qty: 2, modifierIds: [extraCheese.id, noOnion.id] });
    const sale = orders.pay(o.id, { payments: cash(100_000) });

    expect(sale.totalMinor).toBe(100_000); // 2 x 50,000
    expect(sale.orderLabel).toBe("Token 1 · Dine-in · Table 7");
    expect(sale.items[0]!.name).toBe("Zinger (Extra cheese, No onion)");
    // Cost: 2 x (12,000 chicken + 2,000 bun) + 2 x 2,000 cheese
    expect(sale.items[0]!.cogsMinor).toBe(32_000);
    expect(inventory.stockOf(chicken.id)).toBe(9.7);
    expect(inventory.stockOf(bun.id)).toBe(98);
    expect(inventory.stockOf(cheese.id)).toBe(48);
    expect(orders.get(o.id)).toMatchObject({ status: "paid", saleId: sale.id });
    expect(orders.open()).toHaveLength(0);
    expect(() => orders.pay(o.id, { payments: cash(1) })).toThrow(/already been paid/);
    expect(formatReceipt(sale, { storeName: "Barn", currency: "PKR", locale: "en-PK", width: 40, footer: "" })).toContain("Token 1 · Dine-in · Table 7");
  });

  it("voiding the sale puts everything back, add-on ingredients included", () => {
    const { zinger, chicken, bun, cheese, extraCheese } = shop();
    const o = orders.create({ type: "takeaway" });
    orders.addItem(o.id, { productId: zinger.id, qty: 3, modifierIds: [extraCheese.id] });
    const sale = orders.pay(o.id, { payments: cash(150_000) });
    sales.voidSale(sale.id, "wrong order");
    expect(inventory.stockOf(chicken.id)).toBe(10);
    expect(inventory.stockOf(bun.id)).toBe(100);
    expect(inventory.stockOf(cheese.id)).toBe(50);
    const net = db.prepare("SELECT SUM(value_minor) AS v FROM stock_movements WHERE ref_id = ?").get(sale.id) as { v: number };
    expect(net.v).toBe(0);
  });

  it("saves nothing when stock runs out, including the add-on ingredient", () => {
    const { zinger, cheese, extraCheese } = shop();
    inventory.adjust(cheese.id, -49, "waste"); // 1 slice left
    const o = orders.create({ type: "takeaway" });
    orders.addItem(o.id, { productId: zinger.id, qty: 2, modifierIds: [extraCheese.id] });
    expect(() => orders.pay(o.id, { payments: cash(100_000) })).toThrow(/Not enough stock for Cheese slice/);
    expect(orders.get(o.id)!.status).toBe("open");
    expect(sales.recent()).toHaveLength(0);
    expect(inventory.stockOf(cheese.id)).toBe(1);
  });

  it("refuses an empty order and short payment without changing anything", () => {
    const { zinger } = shop();
    const o = orders.create({ type: "takeaway" });
    expect(() => orders.pay(o.id, { payments: cash(1) })).toThrow(/no items/);
    orders.addItem(o.id, { productId: zinger.id, qty: 1 });
    expect(() => orders.pay(o.id, { payments: cash(100) })).toThrow();
    expect(orders.get(o.id)!.status).toBe("open");
  });

  it("flows into profit and loss", () => {
    const { zinger, extraCheese } = shop();
    const o = orders.create({ type: "takeaway" });
    orders.addItem(o.id, { productId: zinger.id, qty: 2, modifierIds: [extraCheese.id] });
    orders.pay(o.id, { payments: cash(100_000) });
    const pl = new FinanceService(db).profitAndLoss(dates.localDate(), dates.localDate());
    expect(pl.netSalesMinor).toBe(100_000);
    expect(pl.cogsMinor).toBe(32_000);
    expect(pl.items[0]!.name).toBe("Zinger (Extra cheese)");
  });
});

describe("upgrading", () => {
  it("adds the order tables to a database from the previous version", () => {
    const old = openDatabase(":memory:");
    old.exec("DROP TABLE order_items; DROP TABLE orders; DROP TABLE modifiers;");
    old.pragma("user_version = 3");
    old.prepare("INSERT INTO products (id, name, price_minor, created_at, updated_at) VALUES ('p', 'Tea', 100, 'x', 'x')").run();
    // Re-running migrate on it must add the new tables and keep the data
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return import("../src/migrations.js").then(({ migrate }) => {
      migrate(old);
      expect(old.pragma("user_version", { simple: true })).toBe(4);
      expect(old.prepare("SELECT name FROM products").all()).toEqual([{ name: "Tea" }]);
      expect(new OrderService(old).create({ type: "takeaway" }).token).toBe(1);
    });
  });
});
