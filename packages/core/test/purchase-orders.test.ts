import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProductService, PurchaseOrderService, PurchaseService, migrations, openDatabase, type Db } from "../src/index.js";

let db: Db;
let products: ProductService;
let purchases: PurchaseService;
let orders: PurchaseOrderService;
let flour: string;
let oil: string;
let sugar: string;

const stockOf = (productId: string) =>
  (db.prepare("SELECT COALESCE(SUM(qty_delta), 0) AS q FROM stock_movements WHERE product_id = ?").get(productId) as { q: number }).q;
const avgCost = (productId: string) => (db.prepare("SELECT avg_cost AS c FROM products WHERE id = ?").get(productId) as { c: number }).c;
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0).toISOString();

beforeEach(() => {
  db = openDatabase(":memory:");
  products = new ProductService(db);
  purchases = new PurchaseService(db);
  orders = new PurchaseOrderService(db, purchases);
  flour = products.create({ name: "Flour", kind: "ingredient", unit: "kg", priceMinor: 0 }).id;
  oil = products.create({ name: "Oil", kind: "ingredient", unit: "l", priceMinor: 0 }).id;
  sugar = products.create({ name: "Sugar", kind: "ingredient", unit: "kg", priceMinor: 0 }).id;
});

/**
 * Prices are written in minor units: 8_000 is 80.00.
 *   Metro order: 10 kg Flour at 80.00 = 800.00, and 5 l Oil at 250.00 = 1,250.00. Total 2,050.00.
 */
const metro = () =>
  orders.create({
    supplier: "Metro",
    lines: [
      { productId: flour, qty: 10, unitCostMinor: 8_000 },
      { productId: oil, qty: 5, unitCostMinor: 25_000 },
    ],
  });

describe("creating an order", () => {
  it("totals the order at the agreed prices and changes neither stock nor what is owed", () => {
    const o = metro();
    expect(o.code).toBe("PO-0001");
    expect(o.status).toBe("open");
    expect(o.progress).toBe("waiting");
    expect(o.orderedTotalMinor).toBe(205_000); // 800.00 + 1,250.00
    expect(o.onOrderMinor).toBe(205_000);
    expect(o.receivedTotalMinor).toBe(0);
    expect(stockOf(flour)).toBe(0);
    expect(purchases.payables().totalMinor).toBe(0);
    expect(purchases.list()).toHaveLength(0);
  });

  it("numbers orders one after another", () => {
    expect(metro().code).toBe("PO-0001");
    expect(metro().code).toBe("PO-0002");
  });

  it("refuses an empty order, a missing supplier, a zero quantity, a fractional price and an unknown item", () => {
    expect(() => orders.create({ supplier: "Metro", lines: [] })).toThrow(/at least one item/);
    expect(() => orders.create({ supplier: "  ", lines: [{ productId: flour, qty: 1, unitCostMinor: 1 }] })).toThrow(/supplier/);
    expect(() => orders.create({ supplier: "M", lines: [{ productId: flour, qty: 0, unitCostMinor: 1 }] })).toThrow(/greater than zero/);
    expect(() => orders.create({ supplier: "M", lines: [{ productId: flour, qty: 1, unitCostMinor: 1.5 }] })).toThrow(/whole/);
    expect(() => orders.create({ supplier: "M", lines: [{ productId: "nope", qty: 1, unitCostMinor: 1 }] })).toThrow(/not found/);
    expect(orders.list()).toHaveLength(0); // nothing half-saved
  });
});

describe("receiving goes through the purchasing service", () => {
  it("a partial delivery adds stock at the real cost, records a purchase, and leaves the order open", () => {
    const o = metro();
    const flourLine = o.lines[0]!;
    // 6 kg arrive: 6 x 80.00 = 480.00. 200.00 is paid now.
    const after = orders.receive(o.id, { lines: [{ lineId: flourLine.id, qty: 6 }], paidMinor: 20_000, method: "cash" });

    expect(after.status).toBe("open");
    expect(after.progress).toBe("partly_received");
    expect(after.lines[0]).toMatchObject({ qtyOrdered: 10, qtyReceived: 6, qtyRemaining: 4 });
    expect(after.lines[1]).toMatchObject({ qtyReceived: 0, qtyRemaining: 5 });
    expect(after.receivedTotalMinor).toBe(48_000);
    expect(after.onOrderMinor).toBe(32_000 + 125_000); // 4 kg x 80.00 + 5 l x 250.00 = 1,570.00

    // It is a real purchase, made by PurchaseService:
    const list = purchases.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ supplier: "Metro", reference: "PO-0001", totalMinor: 48_000, paidMinor: 20_000, outstandingMinor: 28_000 });
    expect(after.receipts[0]?.purchaseId).toBe(list[0]!.id);
    // ...with a stock movement at its value, and the average cost it sets:
    const moves = db.prepare("SELECT reason, ref_type AS refType, ref_id AS refId, qty_delta AS q, value_minor AS v FROM stock_movements WHERE product_id = ?").all(flour);
    expect(moves).toEqual([{ reason: "purchase", refType: "purchase", refId: list[0]!.id, q: 6, v: 48_000 }]);
    expect(stockOf(flour)).toBe(6);
    expect(avgCost(flour)).toBe(8_000); // 480.00 / 6 kg
    expect(purchases.payables()).toEqual({ totalMinor: 28_000, bySupplier: [{ supplier: "Metro", outstandingMinor: 28_000 }] });
  });

  it("the second delivery completes the order, may differ from the agreed price, and moves the weighted average", () => {
    const o = metro();
    orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 6 }], paidMinor: 20_000 });
    // The rest: 4 kg flour at the agreed 80.00 = 320.00, and 5 l oil that the invoice charged 1,240.00 for
    // (the agreed 1,250.00 was a little high). Nothing paid yet.
    const done = orders.receive(o.id, {
      lines: [
        { lineId: o.lines[0]!.id, qty: 4 },
        { lineId: o.lines[1]!.id, qty: 5, costMinor: 124_000 },
      ],
      invoiceRef: "INV-77",
    });
    expect(done.status).toBe("received");
    expect(done.progress).toBe("received");
    expect(done.onOrderMinor).toBe(0);
    expect(done.receivedTotalMinor).toBe(48_000 + 32_000 + 124_000); // 2,040.00
    expect(done.receipts).toHaveLength(2);

    expect(stockOf(flour)).toBe(10);
    expect(stockOf(oil)).toBe(5);
    expect(avgCost(flour)).toBe(8_000); // (6 x 8,000 + 32,000) / 10
    expect(avgCost(oil)).toBe(24_800); // 124,000 / 5
    // Owed: 28,000 still on the first delivery + 156,000 (flour 32,000 + oil 124,000) on the second.
    expect(purchases.payables().totalMinor).toBe(184_000);
    expect(purchases.list()[0]?.note).toBe("Invoice INV-77");
  });

  it("receiveAll books whatever is still expected at the agreed prices", () => {
    const o = metro();
    orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 6 }] });
    const done = orders.receiveAll(o.id, { paidMinor: 100_000 });
    expect(done.status).toBe("received");
    // 4 kg x 80.00 + 5 l x 250.00 = 320.00 + 1,250.00 = 1,570.00 on this delivery
    expect(purchases.list()[0]).toMatchObject({ totalMinor: 157_000, paidMinor: 100_000, outstandingMinor: 57_000 });
  });

  it("rounds a fractional delivery to the nearest minor unit", () => {
    const o = orders.create({ supplier: "Metro", lines: [{ productId: flour, qty: 4, unitCostMinor: 7_001 }] });
    orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 2.5 }] });
    // 2.5 x 70.01 = 175.025, which is 17,502.5 minor units: rounds to 17,503
    expect(purchases.list()[0]?.totalMinor).toBe(17_503);
    expect(stockOf(flour)).toBe(2.5);
  });

  it("refuses more than is still expected, unknown lines, duplicates, and nothing at all, without booking anything", () => {
    const o = metro();
    const [f, l] = o.lines;
    orders.receive(o.id, { lines: [{ lineId: f!.id, qty: 6 }] });
    expect(() => orders.receive(o.id, { lines: [{ lineId: f!.id, qty: 5 }] })).toThrow(/Only 4 kg of Flour is still expected/);
    expect(() => orders.receive(o.id, { lines: [{ lineId: "nope", qty: 1 }] })).toThrow(/not on this order/);
    expect(() => orders.receive(o.id, { lines: [{ lineId: f!.id, qty: 1 }, { lineId: f!.id, qty: 1 }] })).toThrow(/twice/);
    expect(() => orders.receive(o.id, { lines: [] })).toThrow(/what arrived/);
    expect(() => orders.receive(o.id, { lines: [{ lineId: f!.id, qty: -1 }] })).toThrow(/greater than zero/);
    // A bad second line must not leave the good first line booked.
    expect(() => orders.receive(o.id, { lines: [{ lineId: f!.id, qty: 1 }, { lineId: l!.id, qty: 99 }] })).toThrow(/Only 5 l of Oil/);
    expect(stockOf(flour)).toBe(6);
    expect(purchases.list()).toHaveLength(1);
    expect(orders.get(o.id)!.lines[0]!.qtyReceived).toBe(6);
  });

  it("rolls everything back if the payment is more than the delivery", () => {
    const o = metro();
    expect(() => orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 1 }], paidMinor: 8_001 })).toThrow(/more than the purchase total/);
    expect(stockOf(flour)).toBe(0);
    expect(purchases.list()).toHaveLength(0);
    expect(orders.get(o.id)!.receipts).toHaveLength(0);
    expect(orders.get(o.id)!.lines[0]!.qtyReceived).toBe(0);
  });

  it("copes with tenth-of-a-kilo quantities adding up to the order exactly", () => {
    const o = orders.create({ supplier: "Metro", lines: [{ productId: flour, qty: 0.3, unitCostMinor: 1_000 }] });
    orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 0.1 }] });
    orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 0.2 }] }); // 0.1 + 0.2 is 0.30000000000000004
    expect(orders.get(o.id)!.status).toBe("received");
  });
});

describe("cancelling", () => {
  it("cancels an order nothing has arrived on", () => {
    const o = metro();
    const c = orders.cancel(o.id, "Supplier out of stock");
    expect(c).toMatchObject({ status: "cancelled", progress: "cancelled", cancelReason: "Supplier out of stock", onOrderMinor: 0 });
    expect(c.cancelledAt).not.toBeNull();
    expect(purchases.payables().totalMinor).toBe(0);
    expect(() => orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 1 }] })).toThrow(/was cancelled/);
  });

  it("cancelling after a partial delivery drops only what is still expected and keeps what arrived", () => {
    const o = orders.create({ supplier: "Metro", lines: [{ productId: sugar, qty: 20, unitCostMinor: 10_000 }] });
    orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 8 }], paidMinor: 30_000 });
    const c = orders.cancel(o.id);
    expect(c.status).toBe("cancelled");
    expect(c.onOrderMinor).toBe(0); // the 12 kg that never came are not "on order" any more
    expect(c.receivedTotalMinor).toBe(80_000); // 8 kg x 100.00 stays booked
    expect(stockOf(sugar)).toBe(8);
    expect(purchases.payables().totalMinor).toBe(50_000); // 800.00 - 300.00 still owed
  });

  it("refuses to cancel twice or to cancel an order that was received in full", () => {
    const a = metro();
    orders.cancel(a.id);
    expect(() => orders.cancel(a.id)).toThrow(/already cancelled/);
    const b = metro();
    orders.receiveAll(b.id);
    expect(() => orders.cancel(b.id)).toThrow(/received in full/);
    expect(() => orders.receiveAll(b.id)).toThrow(/already been received/);
  });
});

describe("supplier statement", () => {
  /**
   * Metro, in order:
   *   1 Nov   delivery PO-0001: 480.00, 200.00 paid on the day
   *   5 Nov   payment of 100.00 on that purchase
   *   10 Nov  delivery PO-0001: 1,560.00 (flour 320.00 + oil 1,240.00), nothing paid
   * A purchase written as "metro " (other capitals, a stray space) belongs to the same supplier, and a
   * purchase from "Other Co" does not.
   * Open order PO-0002: 4 kg Sugar at 50.00 = 200.00, not delivered.
   */
  function story() {
    const o = metro();
    orders.receive(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 6 }], paidMinor: 20_000 });
    orders.receive(o.id, {
      lines: [{ lineId: o.lines[0]!.id, qty: 4 }, { lineId: o.lines[1]!.id, qty: 5, costMinor: 124_000 }],
    });
    const [p1, p2] = purchases.list().reverse();
    purchases.pay(p1!.id, 10_000, "cash");
    db.prepare("UPDATE purchases SET created_at = ? WHERE id = ?").run(at(2026, 11, 1), p1!.id);
    db.prepare("UPDATE purchases SET created_at = ? WHERE id = ?").run(at(2026, 11, 10), p2!.id);
    db.prepare("UPDATE purchase_payments SET created_at = ? WHERE purchase_id = ? AND amount_minor = 20000").run(at(2026, 11, 1), p1!.id);
    db.prepare("UPDATE purchase_payments SET created_at = ? WHERE purchase_id = ? AND amount_minor = 10000").run(at(2026, 11, 5), p1!.id);
    purchases.record({ supplier: "Other Co", items: [{ productId: sugar, qty: 1, costMinor: 5_000 }] });
    orders.create({ supplier: "Metro", lines: [{ productId: sugar, qty: 4, unitCostMinor: 5_000 }] });
  }

  it("lists purchases and payments with a running balance that ends at what is owed", () => {
    story();
    const s = orders.statement("Metro");
    expect(s.entries.map((e) => [e.kind, e.debitMinor, e.creditMinor, e.balanceMinor])).toEqual([
      ["purchase", 48_000, 0, 48_000], //  1 Nov: we owe 480.00
      ["payment", 0, 20_000, 28_000], //   1 Nov: paid 200.00 -> 280.00
      ["payment", 0, 10_000, 18_000], //   5 Nov: paid 100.00 -> 180.00
      ["purchase", 0 + 156_000, 0, 174_000], // 10 Nov: +1,560.00 -> 1,740.00
    ]);
    expect(s.openingBalanceMinor).toBe(0);
    expect(s.totalPurchasedMinor).toBe(204_000); // 480.00 + 1,560.00
    expect(s.totalPaidMinor).toBe(30_000);
    expect(s.closingBalanceMinor).toBe(174_000);
    // It agrees with the existing "owed to suppliers" figure.
    expect(purchases.payables().bySupplier).toContainEqual({ supplier: "Metro", outstandingMinor: 174_000 });
    // The undelivered order is shown separately and is not part of what is owed.
    expect(s.onOrder.map((x) => [x.code, x.remainingMinor])).toEqual([["PO-0002", 20_000]]);
    expect(s.onOrderTotalMinor).toBe(20_000);
  });

  it("a date range starts from what was owed just before it", () => {
    story();
    const s = orders.statement("Metro", { from: "2026-11-05", to: "2026-11-30" });
    // Before 5 Nov: 480.00 bought, 200.00 paid -> 280.00 owed.
    expect(s.openingBalanceMinor).toBe(28_000);
    expect(s.entries.map((e) => [e.kind, e.balanceMinor])).toEqual([
      ["payment", 18_000], // 5 Nov: 100.00 paid
      ["purchase", 174_000], // 10 Nov: +1,560.00
    ]);
    expect(s.totalPurchasedMinor).toBe(156_000);
    expect(s.totalPaidMinor).toBe(10_000);
    expect(s.closingBalanceMinor).toBe(28_000 + 156_000 - 10_000); // 1,740.00
    // Ending before the big delivery:
    const early = orders.statement("Metro", { to: "2026-11-09" });
    expect(early.closingBalanceMinor).toBe(18_000);
    expect(early.entries).toHaveLength(3);
  });

  it("matches the supplier name regardless of capitals and spaces, and keeps other suppliers apart", () => {
    story();
    purchases.record({ supplier: "metro ", items: [{ productId: sugar, qty: 1, costMinor: 1_000 }] });
    expect(orders.statement("METRO").closingBalanceMinor).toBe(175_000);
    expect(orders.statement("Other Co").closingBalanceMinor).toBe(5_000);
    expect(orders.suppliers()).toEqual(["Metro", "Other Co"]);
  });

  it("is empty and zero for a supplier we never bought from, and rejects bad input", () => {
    expect(orders.statement("Nobody")).toMatchObject({ entries: [], closingBalanceMinor: 0, onOrderTotalMinor: 0 });
    expect(() => orders.statement(" ")).toThrow(/Choose a supplier/);
    expect(() => orders.statement("Metro", { from: "2026-12-01", to: "2026-11-01" })).toThrow(/cannot be before/);
    expect(() => orders.statement("Metro", { from: "soon" })).toThrow(/date/i);
  });
});

describe("upgrading an existing shop to the purchase orders migration", () => {
  it("keeps every existing purchase, adds the new tables, and works straight away", () => {
    const dir = mkdtempSync(join(tmpdir(), "tillbase-po-"));
    const file = join(dir, "old.sqlite");
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    const before = migrations.filter((m) => m.version <= 6);
    for (const m of before) old.exec(m.sql);
    old.pragma("user_version = 6");
    old.prepare("INSERT INTO products (id, name, price_minor, kind, unit, created_at, updated_at) VALUES ('f', 'Flour', 0, 'ingredient', 'kg', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    old.prepare("INSERT INTO purchases (id, supplier, total_minor, paid_minor, created_at) VALUES ('p1', 'Metro', 50000, 20000, '2026-01-02T10:00:00.000Z')").run();
    old.prepare("INSERT INTO purchase_payments (id, purchase_id, amount_minor, method, created_at) VALUES ('pay1', 'p1', 20000, 'cash', '2026-01-02T10:00:00.000Z')").run();
    expect(old.pragma("user_version", { simple: true })).toBe(6);
    old.close();
    // Open it the way the app does: this runs the missing migrations.
    const up = openDatabase(file);
    expect(up.pragma("user_version", { simple: true })).toBe(migrations[migrations.length - 1]!.version);
    const svc = new PurchaseOrderService(up);
    // The old purchase is untouched and shows on the statement.
    expect((up.prepare("SELECT total_minor AS t, paid_minor AS p FROM purchases WHERE id = 'p1'").get())).toEqual({ t: 50_000, p: 20_000 });
    expect(svc.statement("Metro")).toMatchObject({ totalPurchasedMinor: 50_000, totalPaidMinor: 20_000, closingBalanceMinor: 30_000 });
    // And a new order can be made and received.
    const o = svc.create({ supplier: "Metro", lines: [{ productId: "f", qty: 2, unitCostMinor: 1_000 }] });
    expect(svc.receiveAll(o.id).status).toBe("received");
    up.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
