import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CustomerService, OrderService, ProductService, SaleService, allocateDiscount, formatReceipt, migrate, migrations,
  openDatabase, totalsAfterDiscount, taxFor, type Db,
} from "../src/index.js";

let db: Db;
let customers: CustomerService;
let products: ProductService;
let sales: SaleService;
let orders: OrderService;
let burger: string; // 250.00, 10% tax
let tea: string; // 50.00, no tax

beforeEach(() => {
  db = openDatabase(":memory:");
  customers = new CustomerService(db);
  products = new ProductService(db);
  sales = new SaleService(db, "T1");
  orders = new OrderService(db, "T1");
  burger = products.create({ name: "Burger", priceMinor: 25_000, taxRateBp: 1000, trackStock: false }).id;
  tea = products.create({ name: "Tea", priceMinor: 5_000, trackStock: false }).id;
});

/** Every balance must equal the sum of its ledger rows. */
function expectLedgerMatchesBalances() {
  const bad = db
    .prepare(
      `SELECT c.id FROM customers c
        WHERE c.points <> COALESCE((SELECT SUM(delta) FROM customer_ledger WHERE customer_id = c.id AND account = 'points'), 0)
           OR c.wallet_minor <> COALESCE((SELECT SUM(delta) FROM customer_ledger WHERE customer_id = c.id AND account = 'wallet'), 0)`,
    )
    .all();
  expect(bad).toEqual([]);
}

describe("discount sharing", () => {
  it("shares a discount by largest remainder and always adds up", () => {
    // 1,000 over 25,000 and 5,000: 833.33 and 166.67 -> 833 + 167 (the spare unit goes to the bigger remainder)
    expect(allocateDiscount([25_000, 5_000], 1_000)).toEqual([833, 167]);
    expect(allocateDiscount([10, 10, 10], 1)).toEqual([1, 0, 0]);
    expect(allocateDiscount([0, 7], 3)).toEqual([0, 3]);
    expect(allocateDiscount([5, 5], 0)).toEqual([0, 0]);
    for (const d of [0, 1, 17, 99, 100]) expect(allocateDiscount([33, 33, 34], d).reduce((a, b) => a + b, 0)).toBe(d);
  });
  it("refuses a discount bigger than the items", () => {
    expect(() => allocateDiscount([100], 101)).toThrow(/more than the items/);
    expect(() => allocateDiscount([100], -1)).toThrow();
    expect(() => allocateDiscount([100], 1.5)).toThrow();
  });
  it("works out tax per line after the discount", () => {
    const t = totalsAfterDiscount([{ netMinor: 25_000, taxRateBp: 1000 }, { netMinor: 5_000, taxRateBp: 0 }], 1_000, taxFor);
    expect(t).toMatchObject({ discountMinor: 1_000, taxMinor: 2_417, totalMinor: 31_417 });
  });
});

describe("customers", () => {
  it("creates, updates and finds customers by name or phone", () => {
    const a = customers.create({ name: "Ayesha Khan", phone: "0300-123 4567", address: "House 5" });
    customers.create({ name: "Bilal", phone: "+92 321 7654321" });
    expect(a.phone).toBe("03001234567");
    expect(customers.search("ayesha").map((c) => c.name)).toEqual(["Ayesha Khan"]);
    expect(customers.search("0300 1234").map((c) => c.name)).toEqual(["Ayesha Khan"]);
    expect(customers.search("321765").map((c) => c.name)).toEqual(["Bilal"]);
    expect(customers.search("zzz")).toEqual([]);
    expect(customers.search("").length).toBe(2);
    expect(customers.search("100%")).toEqual([]); // % is not a wildcard
    expect(customers.update(a.id, { notes: "No onions", name: "Ayesha K." })).toMatchObject({ name: "Ayesha K.", notes: "No onions", phone: "03001234567" });
  });

  it("keeps a phone number to one customer, with plain messages", () => {
    customers.create({ name: "Ayesha", phone: "0300 1234567" });
    expect(() => customers.create({ name: "Other", phone: "03001234567" })).toThrow(/already belongs to Ayesha/);
    const b = customers.create({ name: "Bilal" });
    expect(() => customers.update(b.id, { phone: "0300-1234567" })).toThrow(/already belongs to Ayesha/);
    expect(() => customers.create({ name: " " })).toThrow(/name/);
    expect(() => customers.create({ name: "X", phone: "12" })).toThrow(/too short/);
    expect(() => customers.create({ name: "X", phone: "abc12345" })).toThrow(/digits/);
    expect(customers.create({ name: "No phone 1" }).phone).toBeNull();
    expect(customers.create({ name: "No phone 2" }).phone).toBeNull();
  });
});

describe("loyalty ledger", () => {
  it("earns 1 point per 100.00 of items by default, on the amount before tax", () => {
    const c = customers.create({ name: "Ayesha", phone: "0300 1111111" });
    // 2 burgers: 50,000 net + 5,000 tax = 55,000. Points come from the 50,000: 5 points.
    const sale = sales.checkout({ lines: [{ productId: burger, qty: 2 }], payments: [{ method: "cash", amountMinor: 55_000 }], customerId: c.id });
    expect(sale).toMatchObject({ totalMinor: 55_000, pointsEarned: 5, pointsRedeemed: 0 });
    expect(customers.get(c.id)!.points).toBe(5);
    expect(customers.ledger(c.id).map((l) => [l.account, l.delta, l.reason])).toEqual([["points", 5, "earn"]]);
    expectLedgerMatchesBalances();
  });

  it("earns nothing for a small bill, and nothing without a customer", () => {
    const c = customers.create({ name: "A" });
    expect(sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }], customerId: c.id }).pointsEarned).toBe(0);
    expect(customers.ledger(c.id)).toEqual([]);
    const anon = sales.checkout({ lines: [{ productId: burger, qty: 4 }], payments: [{ method: "cash", amountMinor: 110_000 }] });
    expect(anon).toMatchObject({ customerId: null, customer: null, pointsEarned: 0 });
  });

  it("uses the rate the shop sets", () => {
    const c = customers.create({ name: "A" });
    customers.setConfig({ spendPerPointMinor: 1_000, pointValueMinor: 50 });
    const s = sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }], customerId: c.id });
    expect(s.pointsEarned).toBe(5);
    expect(customers.config()).toEqual({ spendPerPointMinor: 1_000, pointValueMinor: 50 });
    customers.setConfig({ spendPerPointMinor: 0, pointValueMinor: 0 }); // both off
    expect(sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }], customerId: c.id }).pointsEarned).toBe(0);
    expect(() => customers.setConfig({ spendPerPointMinor: -1, pointValueMinor: 1 })).toThrow(/0 or more/);
    expect(() => customers.setConfig({ spendPerPointMinor: 1.5, pointValueMinor: 1 })).toThrow(/0 or more/);
  });

  it("takes redeemed points off the items before tax, to the last unit", () => {
    const c = customers.create({ name: "Ayesha" });
    customers.adjustPoints(c.id, 25, "Welcome gift");
    // Burger 25,000 + Tea 5,000, 10 points = 1,000 off: shared 833 / 167.
    // Burger 24,167 + tax 2,417; Tea 4,833. Total 31,417. Points earned on 29,000 net: 2.
    const s = sales.checkout({
      lines: [{ productId: burger, qty: 1 }, { productId: tea, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 31_417 }],
      customerId: c.id, redeemPoints: 10,
    });
    expect(s).toMatchObject({ subtotalMinor: 30_000, discountMinor: 1_000, taxMinor: 2_417, totalMinor: 31_417, pointsRedeemed: 10, pointsEarned: 2 });
    expect(s.items.map((i) => [i.discountMinor, i.taxMinor, i.totalMinor])).toEqual([[833, 2_417, 26_584], [167, 0, 4_833]]);
    expect(customers.get(c.id)!.points).toBe(25 - 10 + 2);
    expectLedgerMatchesBalances();
  });

  it("refuses to use more points than the customer has, or more than the items cost", () => {
    const c = customers.create({ name: "Ayesha" });
    customers.adjustPoints(c.id, 1_000, "Gift");
    const pay = (n: number) => [{ method: "cash" as const, amountMinor: n }];
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: pay(5_000), customerId: c.id, redeemPoints: 1_001 })).toThrow(
      /has 1000 points, not 1001/,
    );
    // Tea is 5,000 = 50 points at 100 each.
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: pay(5_000), customerId: c.id, redeemPoints: 51 })).toThrow(
      /most that can be used here is 50/,
    );
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: pay(5_000), redeemPoints: 1 })).toThrow(/Choose a customer/);
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: pay(5_000), customerId: c.id, redeemPoints: 1.5 })).toThrow(/whole number/);
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: pay(5_000), customerId: c.id, redeemPoints: -1 })).toThrow(/whole number/);
    // Nothing was saved by any failed attempt.
    expect(customers.get(c.id)!.points).toBe(1_000);
    expect(sales.recent()).toEqual([]);
    // Exactly the limit works: all 50 points pay for the tea; only tax-free, so nothing left to pay.
    const s = sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [], customerId: c.id, redeemPoints: 50 });
    expect(s).toMatchObject({ totalMinor: 0, discountMinor: 5_000, pointsEarned: 0 });
    expect(customers.get(c.id)!.points).toBe(950);
    expectLedgerMatchesBalances();
  });

  it("cannot use points when the shop has switched redeeming off", () => {
    const c = customers.create({ name: "A" });
    customers.adjustPoints(c.id, 5, "x");
    customers.setConfig({ spendPerPointMinor: 10_000, pointValueMinor: 0 });
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }], customerId: c.id, redeemPoints: 1 })).toThrow(
      /cannot be used as a discount/,
    );
    expect(() => customers.redeemValue(c.id, 1, 5_000)).toThrow(/cannot be used as a discount/);
  });

  it("a delivery charge is never paid for with points and earns none", () => {
    const c = customers.create({ name: "A" });
    customers.adjustPoints(c.id, 1_000, "x");
    const o = orders.create({ type: "delivery", deliveryAddress: "House 1", deliveryFeeMinor: 3_000, customerId: c.id });
    orders.addItem(o.id, { productId: burger, qty: 1 });
    // Food 25,000 -> at most 250 points. Delivery 3,000 cannot be reduced.
    expect(() => orders.pay(o.id, { payments: [{ method: "cash", amountMinor: 99_999 }], redeemPoints: 251 })).toThrow(/most that can be used here is 250/);
    const sale = orders.pay(o.id, { payments: [{ method: "cash", amountMinor: 3_000 }], redeemPoints: 250 });
    // 250 points = 25,000 off the burger; tax on 0 is 0; only the 3,000 delivery remains.
    expect(sale).toMatchObject({ totalMinor: 3_000, discountMinor: 25_000, pointsEarned: 0, pointsRedeemed: 250 });
    expect(sale.items.at(-1)).toMatchObject({ name: "Delivery fee", discountMinor: 0, totalMinor: 3_000 });
    expect(customers.get(c.id)!.points).toBe(750);
  });

  it("voiding a sale gives back points and wallet money and takes back the points it earned", () => {
    const c = customers.create({ name: "Ayesha" });
    customers.adjustPoints(c.id, 25, "Gift");
    customers.topUp(c.id, 10_000, "Cash top-up");
    const s = sales.checkout({
      lines: [{ productId: burger, qty: 1 }, { productId: tea, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 21_417 }],
      customerId: c.id, redeemPoints: 10, walletMinor: 10_000,
    });
    expect(s.totalMinor).toBe(31_417);
    expect(customers.get(c.id)).toMatchObject({ points: 17, walletMinor: 0 });
    sales.voidSale(s.id, "Wrong order");
    expect(customers.get(c.id)).toMatchObject({ points: 25, walletMinor: 10_000 });
    expect(customers.ledger(c.id).filter((l) => l.saleId === s.id).map((l) => `${l.account}:${l.reason}:${l.delta}`).sort()).toEqual([
      "points:earn:2", "points:redeem:-10", "points:void_earn:-2", "points:void_redeem:10", "wallet:spend:-10000", "wallet:void_spend:10000",
    ]);
    expectLedgerMatchesBalances();
    expect(() => sales.voidSale(s.id, "again")).toThrow(/already void/);
    expect(customers.get(c.id)!.points).toBe(25); // a refused second void changes nothing
  });
});

describe("wallet", () => {
  it("tops up and spends, as a labelled payment, never below zero", () => {
    const c = customers.create({ name: "Ayesha" });
    expect(() => customers.topUp(c.id, 0)).toThrow(/above 0/);
    expect(() => customers.topUp(c.id, 10.5)).toThrow(/above 0/);
    expect(customers.topUp(c.id, 10_000, "Cash").walletMinor).toBe(10_000);
    const s = sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [], customerId: c.id, walletMinor: 5_000 });
    expect(s.payments).toMatchObject([{ method: "other", label: "wallet", amountMinor: 5_000 }]);
    expect(customers.get(c.id)!.walletMinor).toBe(5_000);
    expect(() => sales.checkout({ lines: [{ productId: burger, qty: 2 }], payments: [], customerId: c.id, walletMinor: 5_001 })).toThrow(/wallet has 50.00, not 50.01/);
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [], customerId: c.id, walletMinor: 5_001 })).toThrow(/wallet has 50.00|more than the bill/);
    expect(() => customers.adjustWallet(c.id, -5_001, "Refund")).toThrow(/does not have that much/);
    expect(customers.adjustWallet(c.id, -1_000, "Refund").walletMinor).toBe(4_000);
    expect(() => customers.adjustWallet(c.id, 100, " ")).toThrow(/reason/);
    expectLedgerMatchesBalances();
  });

  it("wallet money cannot pay more than the bill, and change only comes from cash", () => {
    const c = customers.create({ name: "A" });
    customers.topUp(c.id, 20_000);
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [], customerId: c.id, walletMinor: 6_000 })).toThrow(/more than the bill/);
    // Wallet 3,000 + cash 3,000 on a 5,000 bill: 1,000 change from the cash.
    const s = sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "cash", amountMinor: 3_000 }], customerId: c.id, walletMinor: 3_000 });
    expect(s).toMatchObject({ paidMinor: 6_000, changeMinor: 1_000 });
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "card", amountMinor: 3_000 }], customerId: c.id, walletMinor: 3_000 })).toThrow(/Change can only be given from a cash/);
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [], walletMinor: 1_000 })).toThrow(/Choose a customer/);
  });

  it("still needs a payment when nothing covers the bill", () => {
    expect(() => sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [] })).toThrow(/A payment is required/);
  });
});

describe("the ledger can only be added to", () => {
  it("refuses to change or delete a row, and a row cannot have a zero amount", () => {
    const c = customers.create({ name: "A" });
    customers.adjustPoints(c.id, 5, "x");
    expect(() => db.prepare("UPDATE customer_ledger SET delta = 500").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM customer_ledger").run()).toThrow(/cannot be changed/);
    expect(() => customers.adjustPoints(c.id, 0, "x")).toThrow(/other than 0/);
    expect(() => customers.adjustPoints(c.id, -6, "x")).toThrow(/only has 5 points/);
    expect(() => customers.adjustPoints(c.id, 1, "")).toThrow(/reason/);
    expect(customers.get(c.id)!.points).toBe(5);
    expectLedgerMatchesBalances();
  });

  it("the wallet cannot go below zero even through the database", () => {
    const c = customers.create({ name: "A" });
    expect(() => db.prepare("INSERT INTO customer_ledger (id, customer_id, account, delta, reason, created_at) VALUES ('x', ?, 'wallet', -1, 'spend', 't')").run(c.id)).toThrow();
  });

  it("stays exact over many sales and voids", () => {
    const c = customers.create({ name: "A" });
    customers.topUp(c.id, 100_000);
    let n = 0;
    for (let i = 1; i <= 25; i++) {
      const s = sales.checkout({
        lines: [{ productId: burger, qty: i % 3 + 1 }, { productId: tea, qty: i % 2 + 1 }],
        payments: [{ method: "cash", amountMinor: 200_000 }], customerId: c.id,
        redeemPoints: customers.get(c.id)!.points >= 3 ? 3 : 0, walletMinor: i % 4 === 0 ? 1_000 : 0,
      });
      if (i % 5 === 0) sales.voidSale(s.id, "test");
      n++;
    }
    expect(n).toBe(25);
    expectLedgerMatchesBalances();
    expect(customers.get(c.id)!.walletMinor).toBeGreaterThanOrEqual(0);
  });
});

describe("history", () => {
  it("lists orders, spend and last visit, hiding spend unless allowed", () => {
    const c = customers.create({ name: "Ayesha" });
    const a = sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }], customerId: c.id });
    const b = sales.checkout({ lines: [{ productId: burger, qty: 1 }], payments: [{ method: "cash", amountMinor: 27_500 }], customerId: c.id });
    const gone = sales.checkout({ lines: [{ productId: tea, qty: 2 }], payments: [{ method: "cash", amountMinor: 10_000 }], customerId: c.id });
    sales.voidSale(gone.id, "mistake");
    const h = customers.history(c.id, true);
    expect(h.visitCount).toBe(2);
    expect(h.totalSpentMinor).toBe(5_000 + 27_500);
    expect(h.visits.map((v) => v.receiptNo)).toEqual([gone.receiptNo, b.receiptNo, a.receiptNo]);
    expect(h.visits[0]).toMatchObject({ status: "void", items: "Tea" });
    expect(h.lastVisit).toBe(b.createdAt);
    expect(customers.history(c.id, false).totalSpentMinor).toBeNull();
    expect(() => customers.history("nope", true)).toThrow(/Customer not found/);
  });
});

describe("customers on orders", () => {
  it("attaching a customer fills in blanks, including the delivery address", () => {
    const c = customers.create({ name: "Ayesha", phone: "0300 1234567", address: "House 5, Street 2" });
    const o = orders.create({ type: "delivery", customerId: c.id });
    expect(o).toMatchObject({ customerId: c.id, customerName: "Ayesha", customerPhone: "03001234567", deliveryAddress: "House 5, Street 2" });
    expect(o.customer).toMatchObject({ id: c.id, points: 0, walletMinor: 0 });
    // A typed address wins over the saved one.
    expect(orders.create({ type: "delivery", customerId: c.id, deliveryAddress: "Office 9" }).deliveryAddress).toBe("Office 9");
    // Takeaway has no address, but still gets name and phone.
    expect(orders.create({ type: "takeaway", customerId: c.id })).toMatchObject({ deliveryAddress: null, customerName: "Ayesha" });
    expect(() => orders.create({ type: "takeaway", customerId: "nope" })).toThrow(/Customer not found/);
  });

  it("attaches, switches and detaches on an open order", () => {
    const a = customers.create({ name: "Ayesha", phone: "0300 1111111", address: "A road" });
    const b = customers.create({ name: "Bilal", phone: "0300 2222222", address: "B road" });
    const o = orders.create({ type: "delivery", customerName: "Walk-in" });
    // Attaching a saved customer makes the order theirs: their saved details replace what was typed.
    expect(orders.update(o.id, { customerId: a.id })).toMatchObject({ customerId: a.id, customerName: "Ayesha", customerPhone: "03001111111", deliveryAddress: "A road" });
    // Switching to another customer replaces the details that came from the first.
    expect(orders.update(o.id, { customerId: b.id })).toMatchObject({ customerId: b.id, customerName: "Bilal", deliveryAddress: "B road" });
    // An unrelated edit leaves the customer alone.
    expect(orders.update(o.id, { note: "ring twice" })).toMatchObject({ customerId: b.id, customerName: "Bilal" });
    const d = orders.update(o.id, { customerId: null });
    expect(d).toMatchObject({ customerId: null, customer: null });
  });

  it("a split bill stays with the same customer, and paying earns points for that customer", () => {
    const c = customers.create({ name: "Ayesha" });
    const o = orders.create({ type: "dine_in", tableLabel: "4", customerId: c.id });
    orders.addItem(o.id, { productId: tea, qty: 2 });
    const { original, created } = orders.splitItems(o.id, [{ itemId: orders.get(o.id)!.items[0]!.id, qty: 1 }]);
    expect(created.customerId).toBe(c.id);
    expect(original.customerId).toBe(c.id);
    const s = orders.pay(o.id, { payments: [{ method: "cash", amountMinor: 5_000 }] });
    expect(s.customer).toMatchObject({ id: c.id, name: "Ayesha" });
  });

  it("paying an order with points and wallet", () => {
    const c = customers.create({ name: "Ayesha" });
    customers.adjustPoints(c.id, 10, "x");
    customers.topUp(c.id, 5_000);
    const o = orders.create({ type: "takeaway", customerId: c.id });
    orders.addItem(o.id, { productId: burger, qty: 1 });
    // 25,000 - 1,000 (10 points) = 24,000 + 10% = 26,400. Wallet 5,000, cash 21,400.
    const s = orders.pay(o.id, { payments: [{ method: "cash", amountMinor: 21_400 }], redeemPoints: 10, walletMinor: 5_000 });
    expect(s).toMatchObject({ totalMinor: 26_400, pointsRedeemed: 10, pointsEarned: 2, customerId: c.id });
    expect(customers.get(c.id)).toMatchObject({ points: 2, walletMinor: 0 });
    expect(orders.get(o.id)!.status).toBe("paid");
  });

  it("nothing is saved when paying an order fails part-way", () => {
    const c = customers.create({ name: "A" });
    customers.adjustPoints(c.id, 3, "x");
    const o = orders.create({ type: "takeaway", customerId: c.id });
    orders.addItem(o.id, { productId: tea, qty: 1 });
    expect(() => orders.pay(o.id, { payments: [{ method: "cash", amountMinor: 1 }], redeemPoints: 3 })).toThrow(/short/);
    expect(customers.get(c.id)!.points).toBe(3);
    expect(orders.get(o.id)!.status).toBe("open");
    expectLedgerMatchesBalances();
  });
});

describe("receipt", () => {
  it("shows the customer, points used and earned, wallet and balances", () => {
    const c = customers.create({ name: "Ayesha" });
    customers.adjustPoints(c.id, 25, "x");
    customers.topUp(c.id, 10_000);
    const s = sales.checkout({
      lines: [{ productId: burger, qty: 1 }, { productId: tea, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 21_417 }], customerId: c.id, redeemPoints: 10, walletMinor: 10_000,
    });
    const text = formatReceipt(s, { storeName: "Test Cafe", currency: "USD", width: 40 });
    expect(text).toMatch(/Customer: Ayesha/);
    expect(text).toMatch(/Points used\s+-10/);
    expect(text).toMatch(/Points earned\s+\+2/);
    expect(text).toMatch(/Points balance\s+17 points/);
    expect(text).toMatch(/WALLET\s+\$100\.00/);
    expect(text).toMatch(/Wallet balance\s+\$0\.00/);
    const plain = formatReceipt(sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }] }), { storeName: "Test Cafe" });
    expect(plain).not.toMatch(/Customer|Points/);
  });
});

describe("upgrading to v6", () => {
  it("upgrades a real v5 database with sales and orders, keeping every row", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    for (const m of migrations.slice(0, 5)) old.exec(m.sql);
    old.pragma("user_version = 5");
    old.prepare("INSERT INTO products (id, name, price_minor, created_at, updated_at) VALUES ('p', 'Tea', 5000, 't', 't')").run();
    old.prepare(
      `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor, tax_minor, total_minor, paid_minor, change_minor, created_at)
       VALUES ('s1', 'R-000001', 'completed', 5000, 0, 0, 5000, 5000, 0, '2026-01-01T00:00:00Z')`,
    ).run();
    old.prepare("INSERT INTO payments (id, sale_id, method, amount_minor) VALUES ('pay1', 's1', 'cash', 5000)").run();
    old.prepare("INSERT INTO orders (id, token_date, token, type, status, created_at) VALUES ('o1', '2026-01-01', 1, 'takeaway', 'open', 't')").run();

    migrate(old);

    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
    const sale = new SaleService(old).get("s1")!;
    expect(sale).toMatchObject({ totalMinor: 5_000, customerId: null, customer: null, pointsEarned: 0, pointsRedeemed: 0 });
    expect(sale.payments).toEqual([{ id: "pay1", method: "cash", amountMinor: 5_000, label: null }]);
    expect(new OrderService(old).get("o1")).toMatchObject({ status: "open", customerId: null, customer: null });
    // The new features work on the upgraded database, and running the upgrade again is harmless.
    const cs = new CustomerService(old);
    const c = cs.create({ name: "Ayesha", phone: "0300 1234567" });
    const s2 = new SaleService(old, "T1").checkout({ lines: [{ productId: "p", qty: 2 }], payments: [{ method: "cash", amountMinor: 10_000 }], customerId: c.id, allowNegativeStock: true });
    expect(s2.customerId).toBe(c.id);
    migrate(old);
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
    expect(cs.get(c.id)!.name).toBe("Ayesha");
  });
});
