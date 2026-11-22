import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FinanceService, InventoryService, OrderService, ProductCsvService, ProductService, PurchaseService, RecipeService,
  ReportService, SaleService, dates, formatReceipt, migrate, migrations, openDatabase, type Db,
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

/** A database exactly as an older version of the app left it: the real migrations up to `version`, nothing more. */
function databaseAtVersion(version: number) {
  const old = new Database(":memory:");
  old.pragma("foreign_keys = ON");
  for (const m of migrations.slice(0, version)) old.exec(m.sql);
  old.pragma(`user_version = ${version}`);
  return old;
}

describe("upgrading", () => {
  it("adds the order tables to a real v3 database and keeps its data", () => {
    const old = databaseAtVersion(3);
    old.prepare("INSERT INTO products (id, name, price_minor, created_at, updated_at) VALUES ('p', 'Tea', 100, 'x', 'x')").run();
    migrate(old);
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
    expect(old.prepare("SELECT name FROM products").all()).toEqual([{ name: "Tea" }]);
    expect(new OrderService(old).create({ type: "takeaway" }).token).toBe(1);
  });

  it("upgrades a real v4 database with orders in it to v5, keeping every row", () => {
    const old = databaseAtVersion(4);
    old.prepare("INSERT INTO products (id, name, price_minor, created_at, updated_at) VALUES ('burger', 'Burger', 45000, 't', 't')").run();
    old.prepare(
      `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor, created_at)
       VALUES ('s1', 'R-000001', 'completed', 45000, 0, 0, 45000, 45000, 0, '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO orders (id, token_date, token, type, table_label, delivery_address, status, sale_id, created_at)
       VALUES ('paid', '2026-01-01', 1, 'delivery', NULL, 'House 5', 'paid', 's1', '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare(
      `INSERT INTO orders (id, token_date, token, type, table_label, status, created_at)
       VALUES ('held', '2026-01-01', 2, 'dine_in', '7', 'open', '2026-01-01T00:01:00Z')`,
    ).run();
    old.prepare("INSERT INTO order_items (id, order_id, product_id, qty) VALUES ('i1', 'held', 'burger', 2)").run();

    migrate(old);

    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
    // Old rows are intact and the new columns start at their neutral values.
    const held = new OrderService(old).get("held")!;
    expect(held).toMatchObject({ token: 2, tableLabel: "7", status: "open", deliveryFeeMinor: 0, splitFrom: null, subtotalMinor: 90_000 });
    expect(new OrderService(old).get("paid")).toMatchObject({ status: "paid", saleId: "s1", deliveryFeeMinor: 0 });
    expect(new SaleService(old).get("s1")?.totalMinor).toBe(45_000);
    expect(old.prepare("SELECT is_system FROM products WHERE id = 'burger'").get()).toEqual({ is_system: 0 });
    expect(new ProductService(old).list().map((p) => p.name)).toEqual(["Burger"]);
    // The new features work on the upgraded database, and running the upgrade again is harmless.
    const svc = new OrderService(old);
    const fee = svc.create({ type: "delivery", deliveryAddress: "House 9", deliveryFeeMinor: 15_000 });
    expect(fee.deliveryFeeMinor).toBe(15_000);
    expect(svc.splitItems("held", [{ itemId: "i1", qty: 1 }]).created.items[0]!.qty).toBe(1);
    migrate(old);
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
  });
});

describe("delivery fee", () => {
  const delivery = (fee?: number) => orders.create({ type: "delivery", deliveryAddress: "House 5", ...(fee === undefined ? {} : { deliveryFeeMinor: fee }) });
  const pl = () => new FinanceService(db).profitAndLoss(dates.localDate(), dates.localDate());

  it("becomes an untaxed line on the sale, so the receipt and totals include it", () => {
    const { zinger } = shop();
    const o = delivery(15_000);
    orders.addItem(o.id, { productId: zinger.id, qty: 2 });
    expect(orders.get(o.id)).toMatchObject({ deliveryFeeMinor: 15_000, subtotalMinor: 90_000 }); // food only: 2 x 45,000
    // Total to pay: 90,000 food + 15,000 delivery = 105,000. No tax on either.
    const sale = orders.pay(o.id, { payments: cash(105_000) });
    expect(sale.totalMinor).toBe(105_000);
    expect(sale.subtotalMinor).toBe(105_000);
    expect(sale.taxMinor).toBe(0);
    expect(sale.items.map((i) => [i.name, i.qty, i.unitPriceMinor, i.taxMinor, i.totalMinor, i.cogsMinor])).toEqual([
      ["Zinger", 2, 45_000, 0, 90_000, 28_000], // cost 2 x 14,000
      ["Delivery fee", 1, 15_000, 0, 15_000, 0],
    ]);
    expect(formatReceipt(sale, { storeName: "Shop" })).toContain("Delivery fee");
  });

  it("is income in profit and loss, and never raises the 'item has no cost' warning", () => {
    const { zinger } = shop();
    const o = delivery(15_000);
    orders.addItem(o.id, { productId: zinger.id, qty: 2 });
    orders.pay(o.id, { payments: cash(105_000) });
    const r = pl();
    // Net sales 90,000 + 15,000 = 105,000. Cost of goods: 2 x 14,000 = 28,000. Gross profit 77,000.
    expect(r.netSalesMinor).toBe(105_000);
    expect(r.cogsMinor).toBe(28_000);
    expect(r.grossProfitMinor).toBe(77_000);
    const feeLine = r.items.find((i) => i.name === "Delivery fee")!;
    expect(feeLine).toMatchObject({ salesMinor: 15_000, cogsMinor: 0, costMissing: false });
    expect(r.warnings.filter((w) => /no cost/.test(w))).toEqual([]);
    // A real item with no cost still raises it, so the exclusion is only for the fee.
    const free = products.create({ name: "Mystery", priceMinor: 1_000, trackStock: false });
    const o2 = orders.create({ type: "takeaway" });
    orders.addItem(o2.id, { productId: free.id, qty: 1 });
    orders.pay(o2.id, { payments: cash(1_000) });
    const r2 = pl();
    expect(r2.warnings.some((w) => /Mystery/.test(w) && !/Delivery/.test(w))).toBe(true);
  });

  it("adds no tax of its own: tax comes only from the food", () => {
    // Food 10,000 with 10% tax = 1,000 tax. Delivery 3,000, untaxed. Total 10,000 + 1,000 + 3,000 = 14,000.
    const meal = products.create({ name: "Taxed meal", priceMinor: 10_000, taxRateBp: 1000, trackStock: false });
    const o = delivery(3_000);
    orders.addItem(o.id, { productId: meal.id, qty: 1 });
    const sale = orders.pay(o.id, { payments: cash(14_000) });
    expect(sale.taxMinor).toBe(1_000);
    expect(sale.totalMinor).toBe(14_000);
    const r = pl();
    expect(r.netSalesMinor).toBe(13_000); // 10,000 + 3,000, before tax
    expect(r.taxCollectedMinor).toBe(1_000);
  });

  it("is refused if the payment does not cover the food and the delivery charge", () => {
    const { zinger } = shop();
    const o = delivery(15_000);
    orders.addItem(o.id, { productId: zinger.id, qty: 1 });
    expect(() => orders.pay(o.id, { payments: cash(45_000) })).toThrow(/short by 150.00/);
    expect(orders.get(o.id)!.status).toBe("open");
  });

  it("adds no line when the charge is 0, and can be changed while the order is open", () => {
    const { zinger } = shop();
    const o = delivery();
    orders.addItem(o.id, { productId: zinger.id, qty: 1 });
    expect(orders.update(o.id, { deliveryFeeMinor: 20_000 }).deliveryFeeMinor).toBe(20_000);
    expect(orders.update(o.id, { deliveryFeeMinor: 0 }).deliveryFeeMinor).toBe(0);
    const sale = orders.pay(o.id, { payments: cash(45_000) });
    expect(sale.items).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM products WHERE is_system = 1").get()).toEqual({ n: 0 }); // never even created
  });

  it("must be a whole amount of 0 or more, and only delivery orders have one", () => {
    expect(() => delivery(-1)).toThrow(/whole amount, 0 or more/);
    expect(() => delivery(10.5)).toThrow(/whole amount, 0 or more/);
    expect(() => delivery(Number.NaN)).toThrow(/whole amount, 0 or more/);
    expect(() => orders.create({ type: "takeaway", deliveryFeeMinor: 500 })).toThrow(/Only delivery orders/);
    const o = delivery(500);
    expect(() => orders.update(o.id, { deliveryFeeMinor: -5 })).toThrow(/whole amount/);
    expect(() => orders.update(o.id, { type: "takeaway", deliveryFeeMinor: 500 })).toThrow(/Only delivery orders/);
    // Turning a delivery order into takeaway drops the charge, like the address.
    expect(orders.update(o.id, { type: "takeaway" })).toMatchObject({ type: "takeaway", deliveryFeeMinor: 0 });
  });

  it("is reversed with the sale when the sale is voided, exactly as before", () => {
    const { zinger, chicken, bun } = shop();
    const o = delivery(15_000);
    orders.addItem(o.id, { productId: zinger.id, qty: 2 });
    const sale = orders.pay(o.id, { payments: cash(105_000) });
    expect(inventory.stockOf(chicken.id)).toBe(9.7); // 10 kg - 2 x 0.15
    expect(pl().netSalesMinor).toBe(105_000);
    sales.voidSale(sale.id, "customer refused");
    expect(sales.get(sale.id)!.status).toBe("void");
    expect(inventory.stockOf(chicken.id)).toBe(10);
    expect(inventory.stockOf(bun.id)).toBe(100);
    const r = pl();
    expect(r.netSalesMinor).toBe(0);
    expect(r.cogsMinor).toBe(0);
    expect(r.voidCount).toBe(1);
  });

  it("stays out of every list: menu, search, barcode, stock, low stock, CSV export and import, top products", () => {
    const { zinger } = shop();
    const o = delivery(15_000);
    orders.addItem(o.id, { productId: zinger.id, qty: 1 });
    orders.pay(o.id, { payments: cash(60_000) });
    const fee = db.prepare("SELECT * FROM products WHERE is_system = 1").get() as { id: string; name: string; track_stock: number; tax_rate_bp: number };
    expect(fee).toMatchObject({ name: "Delivery fee", track_stock: 0, tax_rate_bp: 0 });

    expect(products.list().map((p) => p.name)).not.toContain("Delivery fee");
    expect(products.list({ includeInactive: true }).map((p) => p.name)).not.toContain("Delivery fee");
    expect(products.list({ kind: "product" }).map((p) => p.name)).not.toContain("Delivery fee");
    expect(products.search("Delivery")).toEqual([]);
    expect(products.search("")).not.toContainEqual(expect.objectContaining({ name: "Delivery fee" }));
    db.prepare("UPDATE products SET barcode = '999' WHERE id = ?").run(fee.id);
    expect(products.findByBarcode("999")).toBeUndefined();
    db.prepare("UPDATE products SET barcode = NULL WHERE id = ?").run(fee.id);
    expect(inventory.lowStock().map((l) => l.name)).not.toContain("Delivery fee");
    db.prepare("UPDATE products SET track_stock = 1, reorder_level = 5 WHERE id = ?").run(fee.id); // even if it were tracked
    expect(inventory.lowStock().map((l) => l.name)).not.toContain("Delivery fee");
    db.prepare("UPDATE products SET track_stock = 0, reorder_level = 0 WHERE id = ?").run(fee.id);

    const csv = new ProductCsvService(db);
    expect(csv.exportCsv({ includeInactive: true })).not.toContain("Delivery fee");
    // A spreadsheet row with the same name must make its own new item and leave the hidden one alone.
    const result = csv.importCsv("name,price\nDelivery fee,1.00\n");
    expect([result.created, result.updated]).toEqual([1, 0]);
    expect(db.prepare("SELECT price_minor, is_system FROM products WHERE id = ?").get(fee.id)).toEqual({ price_minor: 0, is_system: 1 });
    expect(products.list().filter((p) => p.name === "Delivery fee")).toHaveLength(1);

    // Best sellers list real dishes only, but the fee still counts in the day's takings: 45,000 + 15,000 = 60,000.
    const day = new ReportService(db).salesSummary(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    expect(day.topProducts.map((t) => t.name)).toEqual(["Zinger"]);
    expect(day.totalMinor).toBe(60_000);
  });

  it("cannot be added to an order as if it were a menu item", () => {
    const { zinger } = shop();
    const o = delivery(15_000);
    orders.addItem(o.id, { productId: zinger.id, qty: 1 });
    orders.pay(o.id, { payments: cash(60_000) });
    const feeId = (db.prepare("SELECT id FROM products WHERE is_system = 1").get() as { id: string }).id;
    const o2 = orders.create({ type: "takeaway" });
    expect(() => orders.addItem(o2.id, { productId: feeId, qty: 1 })).toThrow(/Product not found/);
  });

  it("is made once and reused by later delivery orders", () => {
    const { zinger } = shop();
    for (let n = 0; n < 2; n++) {
      const o = delivery(10_000);
      orders.addItem(o.id, { productId: zinger.id, qty: 1 });
      orders.pay(o.id, { payments: cash(55_000) });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM products WHERE is_system = 1").get()).toEqual({ n: 1 });
    // Two deliveries: income 2 x (45,000 + 10,000) = 110,000.
    expect(pl().netSalesMinor).toBe(110_000);
  });
});

describe("splitting a bill", () => {
  /**
   * Table 5. Prices: Zinger 45,000, Cola 8,000, Extra cheese +5,000.
   *   A: Zinger x3                    = 135,000
   *   B: Cola x2                      =  16,000
   *   C: Zinger x1 + Extra cheese     =  50,000  (note "well done")
   * Whole bill: 135,000 + 16,000 + 50,000 = 201,000.
   */
  function table5() {
    const s = shop();
    const o = orders.create({ type: "dine_in", tableLabel: "5" });
    orders.addItem(o.id, { productId: s.zinger.id, qty: 3 });
    orders.addItem(o.id, { productId: s.cola.id, qty: 2 });
    const full = orders.addItem(o.id, { productId: s.zinger.id, qty: 1, modifierIds: [s.extraCheese.id], note: "well done" });
    const [a, b, c] = full.items;
    expect(full.subtotalMinor).toBe(201_000);
    return { ...s, o, a: a!, b: b!, c: c! };
  }

  it("moves part of a line and a whole line to a new bill with its own token, same table and type", () => {
    const { o, a, b } = table5();
    // Move 1 of the 3 Zingers (45,000) and both Colas (16,000): new bill 61,000, original keeps 140,000.
    const { original, created } = orders.splitItems(o.id, [{ itemId: a.id, qty: 1 }, { itemId: b.id, qty: 2 }]);
    expect(original.subtotalMinor).toBe(140_000); // Zinger x2 = 90,000 + Zinger with cheese 50,000
    expect(created.subtotalMinor).toBe(61_000);
    expect(original.subtotalMinor + created.subtotalMinor).toBe(201_000); // nothing gained or lost
    expect(created).toMatchObject({ token: 2, type: "dine_in", tableLabel: "5", status: "open", splitFrom: o.id });
    expect(original.token).toBe(1);
    expect(original.items.map((i) => [i.name, i.qty])).toEqual([["Zinger", 2], ["Zinger", 1]]);
    expect(created.items.map((i) => [i.name, i.qty])).toEqual([["Cola", 2], ["Zinger", 1]]);
    expect(orders.open().map((x) => x.token)).toEqual([1, 2]);
  });

  it("keeps add-ons and notes on the moved units, and prices stay the same", () => {
    const { o, c } = table5();
    // Move the Zinger with extra cheese (50,000) in full; the original keeps Zinger x3 and the Colas.
    const { original, created } = orders.splitItems(o.id, [{ itemId: c.id, qty: 1 }]);
    expect(created.items).toHaveLength(1);
    expect(created.items[0]).toMatchObject({ name: "Zinger", qty: 1, note: "well done", lineMinor: 50_000 });
    expect(created.items[0]!.modifiers.map((m) => m.name)).toEqual(["Extra cheese"]);
    expect(original.subtotalMinor).toBe(151_000); // 135,000 + 16,000
  });

  it("copies a moved part-line with its add-ons (1 of 2 Zingers with extra cheese)", () => {
    const { zinger, extraCheese } = shop();
    const o = orders.create({ type: "takeaway" });
    const line = orders.addItem(o.id, { productId: zinger.id, qty: 2, modifierIds: [extraCheese.id], note: "spicy" }).items[0]!;
    // Each is 45,000 + 5,000 = 50,000, so the line is 100,000. Move 1: 50,000 each side.
    const { original, created } = orders.splitItems(o.id, [{ itemId: line.id, qty: 1 }]);
    expect(original.items[0]).toMatchObject({ qty: 1, lineMinor: 50_000, note: "spicy" });
    expect(created.items[0]).toMatchObject({ qty: 1, lineMinor: 50_000, note: "spicy" });
    expect(created.items[0]!.modifiers.map((m) => m.name)).toEqual(["Extra cheese"]);
    expect(created.tableLabel).toBeNull();
  });

  it("keeps whole-unit totals exact even when the rest of the line is fractional", () => {
    // 2.5 kg at 333 = 832.5, which rounds to 833. Move 1 kg: 333. The remaining 1.5 kg = 499.5, rounds to 500.
    // 333 + 500 = 833, so the two bills add up to the original.
    const rice = products.create({ name: "Loose rice", priceMinor: 333, trackStock: false });
    const o = orders.create({ type: "takeaway" });
    const line = orders.addItem(o.id, { productId: rice.id, qty: 2.5 }).items[0]!;
    expect(orders.get(o.id)!.subtotalMinor).toBe(833);
    const { original, created } = orders.splitItems(o.id, [{ itemId: line.id, qty: 1 }]);
    expect(created.subtotalMinor).toBe(333);
    expect(original.subtotalMinor).toBe(500);
    expect(original.subtotalMinor + created.subtotalMinor).toBe(833);
  });

  it("leaves everything already sent to the kitchen marked as sent on both bills", () => {
    const { o, a, b } = table5();
    orders.sendToKitchen(o.id);
    const { original, created } = orders.splitItems(o.id, [{ itemId: a.id, qty: 1 }, { itemId: b.id, qty: 2 }]);
    expect([...original.items, ...created.items].every((i) => i.sent)).toBe(true);
    // Nothing to send again from either bill, so the kitchen is never asked to cook it twice.
    expect(() => orders.sendToKitchen(original.id)).toThrow(/Nothing new/);
    expect(() => orders.sendToKitchen(created.id)).toThrow(/Nothing new/);
    // The board shows each bill with what it holds, totalling what was sent: 3+1 Zingers and 2 Colas.
    const board = orders.kitchen();
    expect(board.map((x) => x.token)).toEqual([1, 2]);
    const cooked = board.flatMap((x) => x.items).reduce((m, i) => m.set(i.name, (m.get(i.name) ?? 0) + i.qty), new Map<string, number>());
    expect([...cooked]).toEqual([["Zinger", 4], ["Cola", 2]]);
  });

  it("sends only the new things later, and does not show an empty ticket for a bill whose sent items all moved", () => {
    const { o, a, b, c, cola } = table5();
    orders.sendToKitchen(o.id); // A, B, C sent
    orders.addItem(o.id, { productId: cola.id, qty: 1 }); // D: not sent
    // Move every sent item; the original keeps only D.
    const { original, created } = orders.splitItems(o.id, [{ itemId: a.id, qty: 3 }, { itemId: b.id, qty: 2 }, { itemId: c.id, qty: 1 }]);
    expect(original.items.map((i) => [i.name, i.sent])).toEqual([["Cola", false]]);
    expect(original).toMatchObject({ kitchenStatus: null, sentAt: null });
    expect(orders.kitchen().map((x) => x.token)).toEqual([created.token]);
    // D can still be sent, and only D goes.
    const ticket = orders.sendToKitchen(original.id);
    expect(ticket.items.map((i) => [i.name, i.qty])).toEqual([["Cola", 1]]);
  });

  it("carries the kitchen status over to a bill that holds sent food", () => {
    const { o, a } = table5();
    orders.sendToKitchen(o.id);
    orders.setKitchenStatus(o.id, "ready");
    const { original, created } = orders.splitItems(o.id, [{ itemId: a.id, qty: 1 }]);
    expect(original.kitchenStatus).toBe("ready");
    expect(created.kitchenStatus).toBe("ready");
    expect(created.sentAt).toBe(original.sentAt);
  });

  it("does not put an unsent bill on the kitchen board", () => {
    const { o, a } = table5();
    const { created } = orders.splitItems(o.id, [{ itemId: a.id, qty: 1 }]);
    expect(created).toMatchObject({ kitchenStatus: null, sentAt: null });
    expect(orders.kitchen()).toEqual([]);
  });

  it("lets bills split from the same order share their table, but nobody else can take it", () => {
    const { o, a, b } = table5();
    const { original, created } = orders.splitItems(o.id, [{ itemId: a.id, qty: 1 }]);
    // Editing either bill is not blocked by the other one.
    expect(orders.update(original.id, { note: "birthday" }).note).toBe("birthday");
    expect(orders.update(created.id, { note: "separate", tableLabel: "5" }).note).toBe("separate");
    // A third bill split from the second shares the table too, and all three can still be edited.
    const third = orders.splitItems(original.id, [{ itemId: b.id, qty: 2 }]).created;
    expect(third).toMatchObject({ token: 3, tableLabel: "5", splitFrom: original.id });
    for (const id of [original.id, created.id, third.id]) expect(orders.update(id, { note: "x" }).note).toBe("x");
    // Someone else cannot start a new order at that table while any of them is open...
    expect(() => orders.create({ type: "dine_in", tableLabel: "5" })).toThrow(/Table 5 already has an open order/);
    const other = orders.create({ type: "dine_in", tableLabel: "6" });
    expect(() => orders.update(other.id, { tableLabel: "5" })).toThrow(/Table 5 already has an open order/);
    // ...until every bill has been paid or cancelled.
    orders.pay(original.id, { payments: cash(500_000) });
    expect(() => orders.create({ type: "dine_in", tableLabel: "5" })).toThrow(/already has an open order/);
    orders.cancel(created.id, "left");
    orders.pay(third.id, { payments: cash(500_000) });
    expect(orders.create({ type: "dine_in", tableLabel: "5" }).tableLabel).toBe("5");
  });

  it("refuses a split that would leave the original with nothing, and says why", () => {
    const { o, a, b, c, cola } = table5();
    expect(() => orders.splitItems(o.id, [{ itemId: a.id, qty: 3 }, { itemId: b.id, qty: 2 }, { itemId: c.id, qty: 1 }])).toThrow(
      /original bill must keep at least one item/,
    );
    // Moving every unit of one line but not the others is fine, and so is a single-line bill split by quantity.
    expect(orders.splitItems(o.id, [{ itemId: a.id, qty: 3 }, { itemId: b.id, qty: 2 }]).original.items).toHaveLength(1);
    const solo = orders.create({ type: "takeaway" });
    const line = orders.addItem(solo.id, { productId: cola.id, qty: 2 }).items[0]!;
    expect(() => orders.splitItems(solo.id, [{ itemId: line.id, qty: 2 }])).toThrow(/must keep at least one item/);
    expect(orders.splitItems(solo.id, [{ itemId: line.id, qty: 1 }]).original.items[0]!.qty).toBe(1);
  });

  it("refuses invalid quantities and items, and a refused split changes nothing", () => {
    const { o, a, b } = table5();
    const before = JSON.stringify(orders.get(o.id));
    const bad: [string, { itemId: string; qty: number }[]][] = [
      ["nothing chosen", []],
      ["zero", [{ itemId: a.id, qty: 0 }]],
      ["negative", [{ itemId: a.id, qty: -1 }]],
      ["not a number", [{ itemId: a.id, qty: Number.NaN }]],
      ["more than there is", [{ itemId: a.id, qty: 4 }]],
      ["a fraction of a unit", [{ itemId: a.id, qty: 1.5 }]],
      ["an unknown item", [{ itemId: "nope", qty: 1 }]],
      ["the same line twice", [{ itemId: a.id, qty: 1 }, { itemId: a.id, qty: 1 }]],
      ["one good pick and one bad", [{ itemId: b.id, qty: 1 }, { itemId: a.id, qty: 9 }]],
    ];
    const messages = bad.map(([, picks]) => { try { orders.splitItems(o.id, picks); return "NO ERROR"; } catch (e) { return (e as Error).message; } });
    expect(messages).toEqual([
      "Choose at least one item to move to the new bill",
      "Quantity must be greater than zero",
      "Quantity must be greater than zero",
      "Quantity must be greater than zero",
      "There are only 3 Zinger on this bill",
      "Only whole quantities can be moved off a line (for example 1 of 3 Zinger)",
      "One of the chosen items is not on this order",
      "Zinger was chosen twice",
      "There are only 3 Zinger on this bill",
    ]);
    // No new order, no moved items, no token used, even where the first pick was fine.
    expect(JSON.stringify(orders.get(o.id))).toBe(before);
    expect(orders.open()).toHaveLength(1);
    expect(orders.create({ type: "takeaway" }).token).toBe(2);
  });

  it("refuses an item from another order, and a bill that is already paid or cancelled", () => {
    const { o, a, zinger } = table5();
    const other = orders.create({ type: "takeaway" });
    const foreign = orders.addItem(other.id, { productId: zinger.id, qty: 2 }).items[0]!;
    expect(() => orders.splitItems(o.id, [{ itemId: foreign.id, qty: 1 }])).toThrow(/not on this order/);
    orders.pay(o.id, { payments: cash(300_000) });
    expect(() => orders.splitItems(o.id, [{ itemId: a.id, qty: 1 }])).toThrow(/already been paid/);
    orders.cancel(other.id, "changed mind");
    expect(() => orders.splitItems(other.id, [{ itemId: foreign.id, qty: 1 }])).toThrow(/was cancelled/);
  });

  it("makes two bills that are paid separately, with sales that add up and stock used once", () => {
    const { o, a, b, chicken, bun, cheese, cola } = table5();
    const { original, created } = orders.splitItems(o.id, [{ itemId: a.id, qty: 1 }, { itemId: b.id, qty: 2 }]);
    // Original 140,000 paid in cash with 10,000 change; the new bill 61,000 paid by card.
    const first = orders.pay(original.id, { payments: cash(150_000) });
    const second = orders.pay(created.id, { payments: [{ method: "card", amountMinor: 61_000 }] });
    expect([first.totalMinor, second.totalMinor]).toEqual([140_000, 61_000]);
    expect(first.totalMinor + second.totalMinor).toBe(201_000); // exactly the one bill it came from
    expect(first.changeMinor).toBe(10_000);
    expect(first.id).not.toBe(second.id);
    expect(first.receiptNo).not.toBe(second.receiptNo);
    expect(first.orderLabel).toBe("Token 1 · Dine-in · Table 5");
    expect(second.orderLabel).toBe("Token 2 · Dine-in · Table 5");
    // Stock is used once: 4 Zingers = 4 x 0.15 kg chicken and 4 buns, 1 cheese for the add-on, 2 Colas.
    expect(inventory.stockOf(chicken.id)).toBe(9.4);
    expect(inventory.stockOf(bun.id)).toBe(96);
    expect(inventory.stockOf(cheese.id)).toBe(49);
    expect(inventory.stockOf(cola.id)).toBe(18);
    // Same takings and cost as one bill: sales 201,000; cost 4 x 14,000 + cheese 2,000 + 2 Colas x 5,000.
    const day = new FinanceService(db).profitAndLoss(dates.localDate(), dates.localDate());
    expect(day.netSalesMinor).toBe(201_000);
    expect(day.cogsMinor).toBe(68_000); // 56,000 + 2,000 + 10,000 
    expect(orders.open()).toHaveLength(0);
  });

  it("works out tax on each bill, so a split taxed meal still adds up here", () => {
    // Wrap 10,000 with 10% tax. Two on one bill: net 20,000, tax 2,000, total 22,000.
    // Split 1 + 1: each bill net 10,000 + tax 1,000 = 11,000; together 22,000.
    const wrap = products.create({ name: "Wrap", priceMinor: 10_000, taxRateBp: 1000, trackStock: false });
    const o = orders.create({ type: "dine_in", tableLabel: "2" });
    const line = orders.addItem(o.id, { productId: wrap.id, qty: 2 }).items[0]!;
    const { original, created } = orders.splitItems(o.id, [{ itemId: line.id, qty: 1 }]);
    const s1 = orders.pay(original.id, { payments: cash(11_000) });
    const s2 = orders.pay(created.id, { payments: cash(11_000) });
    expect([s1.taxMinor, s2.taxMinor, s1.totalMinor + s2.totalMinor]).toEqual([1_000, 1_000, 22_000]);
  });

  it("leaves a delivery charge with the original bill, so it is charged once", () => {
    const { zinger } = shop();
    const o = orders.create({ type: "delivery", deliveryAddress: "House 5", deliveryFeeMinor: 15_000 });
    const line = orders.addItem(o.id, { productId: zinger.id, qty: 2 }).items[0]!;
    const { original, created } = orders.splitItems(o.id, [{ itemId: line.id, qty: 1 }]);
    expect([original.deliveryFeeMinor, created.deliveryFeeMinor]).toEqual([15_000, 0]);
    expect(created).toMatchObject({ type: "delivery", deliveryAddress: "House 5" });
    // Original: 45,000 + 15,000 = 60,000. New: 45,000. Together 105,000 = 2 x 45,000 + 15,000.
    const s1 = orders.pay(original.id, { payments: cash(60_000) });
    const s2 = orders.pay(created.id, { payments: cash(45_000) });
    expect(s1.totalMinor + s2.totalMinor).toBe(105_000);
    expect(s2.items.map((i) => i.name)).toEqual(["Zinger"]);
  });
});
