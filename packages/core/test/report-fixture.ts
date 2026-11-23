import { ExpenseService, ProductService, PurchaseService, SaleService, ShiftService, UserService, type Db } from "../src/index.js";

/** 9:30 on 3 Nov is at(2026, 11, 3, 9, 30), in the shop's own time zone. */
export const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const card = (n: number) => [{ method: "card" as const, amountMinor: n }];

/**
 * The shop used by the hand-computed tests (all money in minor units):
 *   Burger  price 500.00, bought 10 for 3,000.00 -> cost 300.00 each
 *   Fries   price 200.00, bought 20 for 2,000.00 -> cost 100.00 each
 *   Pie     price 300.00, bought  5 for   500.00 -> cost 100.00 each, never sold
 *   Cola    price 100.00, not stock-tracked, NO cost set
 * Sales:  10 Nov 10:00  Sara   2 Burger + 1 Fries    = 1,200.00 paid 1,500.00 cash (change 300.00); cost 700.00
 *         10 Nov 23:59  Sara   3 Cola                =   300.00 card;                         cost 0
 *         10 Nov 12:00  Sara   1 Burger, then VOIDED
 *         11 Nov 00:00  Maryam 2 Fries               =   400.00 card;                         cost 200.00
 * Rent 200.00 on 10 Nov.  Purchases on 10 Nov: Meat Co (Burger 3,000.00 paid 1,000.00; Fries 2,000.00 paid in full), Bakery (Pie 500.00, unpaid).
 */
export function shop(db: Db) {
  const products = new ProductService(db);
  const purchases = new PurchaseService(db);
  const sales = new SaleService(db, "T1");
  const when = (saleId: string, iso: string) => db.prepare("UPDATE sales SET created_at = ? WHERE id = ?").run(iso, saleId);
  const users = new UserService(db);
  const sara = users.create({ name: "Sara", pin: "1111", role: "cashier" });
  const maryam = users.create({ name: "Maryam", pin: "2222", role: "owner" });
  const burger = products.create({ name: "Burger", priceMinor: 50_000, trackStock: true });
  const fries = products.create({ name: "Fries", priceMinor: 20_000, trackStock: true });
  const pie = products.create({ name: "Pie", priceMinor: 30_000, trackStock: true });
  const cola = products.create({ name: "Cola", priceMinor: 10_000, trackStock: false });
  const p1 = purchases.record({ supplier: "Meat Co", items: [{ productId: burger.id, qty: 10, costMinor: 300_000 }], paidMinor: 100_000 });
  const p2 = purchases.record({ supplier: "Meat Co", items: [{ productId: fries.id, qty: 20, costMinor: 200_000 }], paidMinor: 200_000 });
  const p3 = purchases.record({ supplier: "Bakery", items: [{ productId: pie.id, qty: 5, costMinor: 50_000 }], paidMinor: 0 });
  for (const p of [p1, p2, p3]) db.prepare("UPDATE purchases SET created_at = ? WHERE id = ?").run(at(2026, 11, 10, 8, 0), p.id);
  db.prepare("UPDATE products SET reorder_level = 8 WHERE id = ?").run(burger.id); // 8 left is "at the reorder level"

  const shifts = new ShiftService(db);
  const shift = shifts.open(sara.id, 50_000);
  db.prepare("UPDATE shifts SET opened_at = ? WHERE id = ?").run(at(2026, 11, 10, 8, 0), shift.id);

  const s1 = sales.checkout({ lines: [{ productId: burger.id, qty: 2 }, { productId: fries.id, qty: 1 }], payments: [{ method: "cash", amountMinor: 150_000 }], shiftId: shift.id, userId: sara.id });
  when(s1.id, at(2026, 11, 10, 10, 0));
  const s2 = sales.checkout({ lines: [{ productId: cola.id, qty: 3 }], payments: card(30_000), shiftId: shift.id, userId: sara.id });
  when(s2.id, at(2026, 11, 10, 23, 59));
  const s4 = sales.checkout({ lines: [{ productId: burger.id, qty: 1 }], payments: card(50_000), shiftId: shift.id, userId: sara.id });
  sales.voidSale(s4.id, "Customer left");
  when(s4.id, at(2026, 11, 10, 12, 0));
  const s3 = sales.checkout({ lines: [{ productId: fries.id, qty: 2 }], payments: card(40_000), userId: maryam.id });
  when(s3.id, at(2026, 11, 11, 0, 0));

  shifts.close(shift.id, 168_000); // expected 500.00 float + 1,200.00 cash kept = 1,700.00; counted 1,680.00
  db.prepare("UPDATE shifts SET closed_at = ? WHERE id = ?").run(at(2026, 11, 10, 23, 59), shift.id);

  const expenses = new ExpenseService(db);
  const rent = expenses.categories().find((c) => c.name === "Rent") ?? expenses.addCategory("Rent");
  expenses.add({ categoryId: rent.id, description: "Shop rent", amountMinor: 20_000, spentOn: "2026-11-10" });
  return { burger, fries, pie, cola, sara, maryam, shift };
}

