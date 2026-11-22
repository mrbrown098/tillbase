import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CustomerService, ProductService, ReportService, SaleService, ShiftService, UserService, formatReceipt, formatStatement,
  migrate, migrations, openDatabase, type Db,
} from "../src/index.js";

let db: Db;
let customers: CustomerService;
let sales: SaleService;
let shifts: ShiftService;
let burger: string; // 250.00 + 10% tax = 275.00
let tea: string; // 50.00, no tax
let cust: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  customers = new CustomerService(db);
  sales = new SaleService(db, "T1");
  shifts = new ShiftService(db);
  const products = new ProductService(db);
  burger = products.create({ name: "Burger", priceMinor: 25_000, taxRateBp: 1000, trackStock: false }).id;
  tea = products.create({ name: "Tea", priceMinor: 5_000, trackStock: false }).id;
  cust = customers.create({ name: "Ayesha Khan", phone: "0300 1234567" }).id;
});

/** The balance owed must always equal the sum of the customer's credit ledger rows. */
function expectOwedIsLedgerSum(id = cust) {
  const sum = (db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM customer_ledger WHERE customer_id = ? AND account = 'credit'").get(id) as { n: number }).n;
  expect(customers.get(id)!.owedMinor).toBe(sum);
}
const onAccount = (lines: { productId: string; qty: number }[], onAccountMinor: number, payments: { method: "cash" | "card" | "other"; amountMinor: number }[] = [], extra = {}) =>
  sales.checkout({ lines, payments, customerId: cust, onAccountMinor, ...extra });

describe("selling on account (khata)", () => {
  it("puts a whole sale on account: it is income, but no money was received", () => {
    // 2 burgers: 50,000 + 5,000 tax = 55,000
    const s = onAccount([{ productId: burger, qty: 2 }], 55_000);
    expect(s).toMatchObject({ totalMinor: 55_000, paidMinor: 0, changeMinor: 0, onAccountMinor: 55_000, payments: [] });
    expect(customers.get(cust)!.owedMinor).toBe(55_000);
    expect(customers.ledger(cust).map((l) => [l.account, l.delta, l.reason])).toContainEqual(["credit", 55_000, "credit_sale"]);
    expectOwedIsLedgerSum();
  });

  it("splits a bill between money now and account, with change only from the cash", () => {
    // 1 burger = 27,500. Customer hands over 12,000 cash: 10,000 is due now, so change is 2,000. 17,500 goes on account.
    const s = onAccount([{ productId: burger, qty: 1 }], 17_500, [{ method: "cash", amountMinor: 12_000 }]);
    expect(s).toMatchObject({ totalMinor: 27_500, paidMinor: 12_000, changeMinor: 2_000, onAccountMinor: 17_500 });
    expect(customers.get(cust)!.owedMinor).toBe(17_500);
    // Card cannot give change.
    expect(() => onAccount([{ productId: burger, qty: 1 }], 17_500, [{ method: "card", amountMinor: 12_000 }])).toThrow(/Change can only be given from a cash/);
  });

  it("refuses an account sale that is not allowed, with plain messages, and saves nothing", () => {
    const tea1 = [{ productId: tea, qty: 1 }];
    expect(() => sales.checkout({ lines: tea1, payments: [], onAccountMinor: 5_000 })).toThrow(/Choose a customer to put this on account/);
    expect(() => onAccount(tea1, 5_001)).toThrow(/more than the bill|short|wallet and the amount/);
    expect(() => onAccount(tea1, -1)).toThrow(/whole number/);
    expect(() => onAccount(tea1, 1.5)).toThrow(/whole number/);
    // 5,000 bill, 3,000 on account, 1,000 cash: 1,000 short -> "10.00"
    expect(() => onAccount(tea1, 3_000, [{ method: "cash", amountMinor: 1_000 }])).toThrow(/short by 10\.00/);
    // nothing to pay and nothing on account
    expect(() => onAccount(tea1, 0)).toThrow(/A payment is required/);
    expect(sales.recent()).toEqual([]);
    expect(customers.get(cust)!.owedMinor).toBe(0);
    expect(customers.ledger(cust)).toEqual([]);
  });

  it("wallet and account together cannot be more than the bill", () => {
    customers.topUp(cust, 10_000);
    expect(() => onAccount([{ productId: tea, qty: 1 }], 3_000, [], { walletMinor: 3_000 })).toThrow(/wallet and the amount on account are more than the bill/);
    const s = onAccount([{ productId: tea, qty: 1 }], 2_000, [], { walletMinor: 3_000 });
    expect(s).toMatchObject({ totalMinor: 5_000, paidMinor: 3_000, onAccountMinor: 2_000 });
    expect(customers.get(cust)).toMatchObject({ owedMinor: 2_000, walletMinor: 7_000 });
  });
});

describe("credit limit", () => {
  it("refuses a sale that would pass the limit and says how much is left", () => {
    customers.setCreditLimit(cust, 100_000); // 1,000.00
    onAccount([{ productId: burger, qty: 2 }], 55_000); // owes 550.00
    onAccount([{ productId: burger, qty: 1 }], 27_500); // owes 825.00, room 175.00
    expect(() => onAccount([{ productId: burger, qty: 1 }], 27_500)).toThrow(
      "Ayesha Khan owes 825.00, and putting 275.00 more on account would go over their limit of 1000.00. The most you can put on account is 175.00.",
    );
    expect(customers.get(cust)!.owedMinor).toBe(82_500); // the refused sale changed nothing
    expect(sales.recent()).toHaveLength(2);
    // Exactly up to the limit is fine: 17,500 more is 100,000.
    onAccount([{ productId: tea, qty: 1 }, { productId: tea, qty: 1 }], 10_000);
    expect(customers.get(cust)!.owedMinor).toBe(92_500);
    onAccount([{ productId: tea, qty: 1 }], 5_000);
    onAccount([{ productId: tea, qty: 1 }], 2_500, [{ method: "cash", amountMinor: 2_500 }]);
    expect(customers.get(cust)!.owedMinor).toBe(100_000);
    expect(() => onAccount([{ productId: tea, qty: 1 }], 5_000)).toThrow(/already at their limit of 1000\.00. They need to pay something back first/);
    // Part cash is still fine at the limit: only the account part counts.
    onAccount([{ productId: tea, qty: 1 }], 0, [{ method: "cash", amountMinor: 5_000 }]);
  });

  it("has no limit unless one is set, and the limit can be changed or cleared", () => {
    expect(customers.get(cust)!.creditLimitMinor).toBeNull();
    onAccount([{ productId: burger, qty: 20 }], 550_000);
    expect(customers.setCreditLimit(cust, 0).creditLimitMinor).toBe(0);
    expect(() => onAccount([{ productId: tea, qty: 1 }], 1)).toThrow(/limit of 0\.00/);
    expect(customers.setCreditLimit(cust, null).creditLimitMinor).toBeNull();
    onAccount([{ productId: tea, qty: 1 }], 5_000);
    expect(() => customers.setCreditLimit(cust, -1)).toThrow(/0 or more/);
    expect(() => customers.setCreditLimit(cust, 1.5)).toThrow(/0 or more/);
    expect(() => customers.setCreditLimit("nope", 5)).toThrow(/Customer not found/);
  });
});

describe("repayments, write-offs and the statement", () => {
  it("hand-computed running balance", () => {
    const a = onAccount([{ productId: burger, qty: 2 }], 55_000); // owes 55,000
    customers.repay(cust, 20_000, "cash", "part payment"); // 35,000
    const b = onAccount([{ productId: burger, qty: 1 }], 17_500, [{ method: "cash", amountMinor: 10_000 }]); // 52,500
    customers.writeOff(cust, "Goodwill", 2_500); // 50,000
    sales.voidSale(b.id, "Wrong customer"); // reverses +17,500 -> 32,500
    customers.repay(cust, 2_500, "card"); // 30,000
    const st = customers.statement(cust);
    expect(st.rows.map((r) => [r.kind, r.deltaMinor, r.balanceMinor])).toEqual([
      ["sale", 55_000, 55_000],
      ["repayment", -20_000, 35_000],
      ["sale", 17_500, 52_500],
      ["writeoff", -2_500, 50_000],
      ["void", -17_500, 32_500],
      ["repayment", -2_500, 30_000],
    ]);
    expect(st.owedMinor).toBe(30_000);
    expect(st.rows[0]).toMatchObject({ receiptNo: a.receiptNo });
    expect(st.rows[1]).toMatchObject({ method: "cash", note: "part payment" });
    expect(st.rows[3]).toMatchObject({ note: "Goodwill" });
    expectOwedIsLedgerSum();
  });

  it("refuses bad repayments with plain messages", () => {
    expect(() => customers.repay(cust, 1_000, "cash")).toThrow(/does not owe anything/);
    onAccount([{ productId: tea, qty: 1 }], 5_000);
    expect(() => customers.repay(cust, 0, "cash")).toThrow(/above 0/);
    expect(() => customers.repay(cust, 1.5, "cash")).toThrow(/above 0/);
    expect(() => customers.repay(cust, 5_001, "cash")).toThrow(/owes 50\.00, so 50\.01 is too much. For extra money, top up their wallet/);
    expect(() => customers.repay(cust, 100, "cheque" as never)).toThrow(/cash or card/);
    expect(customers.get(cust)!.owedMinor).toBe(5_000);
    expect(customers.repay(cust, 5_000, "card").owedMinor).toBe(0);
    expect(() => customers.repay(cust, 1, "card")).toThrow(/does not owe anything/);
  });

  it("writes off all or part, needs a reason, and cannot write off more than is owed", () => {
    onAccount([{ productId: tea, qty: 2 }], 10_000);
    expect(() => customers.writeOff(cust, " ")).toThrow(/reason/);
    expect(() => customers.writeOff(cust, "x", 10_001)).toThrow(/only owes 100\.00/);
    expect(() => customers.writeOff(cust, "x", 0)).toThrow(/above 0/);
    expect(customers.writeOff(cust, "Left town", 4_000).owedMinor).toBe(6_000);
    expect(customers.writeOff(cust, "Left town").owedMinor).toBe(0);
    expect(() => customers.writeOff(cust, "again")).toThrow(/does not owe anything/);
  });

  it("lists who owes, largest first, and leaves out those who are square", () => {
    const b = customers.create({ name: "Bilal" }).id;
    const c = customers.create({ name: "Chaudhry" }).id;
    const sell = (id: string, qty: number) => sales.checkout({ lines: [{ productId: tea, qty }], payments: [], customerId: id, onAccountMinor: qty * 5_000 });
    sell(cust, 2); // 10,000
    sell(b, 5); // 25,000
    sell(c, 1); // 5,000
    customers.repay(c, 5_000, "cash");
    expect(customers.owing().map((d) => [d.name, d.owedMinor])).toEqual([["Bilal", 25_000], ["Ayesha Khan", 10_000]]);
  });

  it("someone who paid ahead (after a void) shows a negative balance, never a wrong positive one", () => {
    const s = onAccount([{ productId: tea, qty: 2 }], 10_000);
    customers.repay(cust, 10_000, "cash");
    sales.voidSale(s.id, "Mistake");
    expect(customers.get(cust)!.owedMinor).toBe(-10_000);
    expect(customers.owing()).toEqual([]);
    expectOwedIsLedgerSum();
  });
});

describe("voiding a sale on account", () => {
  it("reverses the ledger exactly, and points, and can only happen once", () => {
    customers.adjustPoints(cust, 5, "gift");
    // 2 burgers 55,000: earns 5 points (50,000 net / 10,000)
    const s = onAccount([{ productId: burger, qty: 2 }], 55_000);
    expect(customers.get(cust)).toMatchObject({ owedMinor: 55_000, points: 10 });
    sales.voidSale(s.id, "Customer cancelled");
    expect(customers.get(cust)).toMatchObject({ owedMinor: 0, points: 5 });
    expect(customers.ledger(cust).filter((l) => l.saleId === s.id).map((l) => `${l.account}:${l.reason}:${l.delta}`).sort()).toEqual([
      "credit:credit_sale:55000", "credit:void_credit_sale:-55000", "points:earn:5", "points:void_earn:-5",
    ]);
    expect(() => sales.voidSale(s.id, "again")).toThrow(/already void/);
    expect(customers.get(cust)!.owedMinor).toBe(0);
    expectOwedIsLedgerSum();
  });
});

describe("the drawer and the day's money", () => {
  it("a sale on account is income but adds nothing to cash, card or the drawer", () => {
    const user = new UserService(db).create({ name: "Ali", pin: "1234", role: "cashier" });
    const shift = shifts.open(user.id, 10_000); // 100.00 float
    const sell = (onAcc: number, cash: number) =>
      sales.checkout({
        lines: [{ productId: burger, qty: 1 }], // 27,500
        payments: cash ? [{ method: "cash", amountMinor: cash }] : [], customerId: cust, onAccountMinor: onAcc, shiftId: shift.id, userId: user.id,
      });
    sell(27_500, 0); // all on account
    let sum = shifts.summary(shift.id);
    expect(sum).toMatchObject({ salesCount: 1, salesTotalMinor: 27_500, cashSalesMinor: 0, expectedCashMinor: 10_000, byMethod: {} });
    sell(17_500, 10_000); // 10,000 cash, 17,500 account
    sum = shifts.summary(shift.id);
    expect(sum).toMatchObject({ salesCount: 2, salesTotalMinor: 55_000, cashSalesMinor: 10_000, expectedCashMinor: 20_000, byMethod: { cash: 10_000 } });
    // A repayment in cash goes in as cash-in (the handler does this), and the count follows.
    customers.repay(cust, 5_000, "cash");
    shifts.addCashMovement(shift.id, user.id, 5_000, "Khata repayment");
    expect(shifts.summary(shift.id).expectedCashMinor).toBe(25_000);

    const r = new ReportService(db).salesSummary("2000-01-01", "2100-01-01");
    expect(r.totalMinor).toBe(55_000); // sales income includes what is on account
    expect(r.byMethod).toEqual({ cash: 10_000 }); // money received does not
  });
});

describe("receipt and statement text", () => {
  it("receipt shows the account part and what the customer owes now", () => {
    const s = onAccount([{ productId: burger, qty: 1 }], 17_500, [{ method: "cash", amountMinor: 10_000 }]);
    const text = formatReceipt(s, { storeName: "Test Cafe", currency: "USD", width: 32 });
    expect(text).toMatch(/CASH\s+\$100\.00/);
    expect(text).toMatch(/ON ACCOUNT\s+\$175\.00/);
    expect(text).toMatch(/You owe\s+\$175\.00/);
    const plain = formatReceipt(sales.checkout({ lines: [{ productId: tea, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }] }), { storeName: "T" });
    expect(plain).not.toMatch(/ON ACCOUNT|You owe/);
  });

  it("statement fits 58mm (32) and 80mm (48) paper and ends with what is owed", () => {
    onAccount([{ productId: burger, qty: 2 }], 55_000);
    customers.repay(cust, 20_000, "cash");
    customers.setCreditLimit(cust, 100_000);
    for (const width of [32, 48]) {
      const text = formatStatement(customers.statement(cust), { storeName: "A Very Long Shop Name Indeed Pvt Ltd", currency: "USD", width });
      for (const l of text.split("\n")) expect(l.length).toBeLessThanOrEqual(width);
      expect(text).toMatch(/ACCOUNT STATEMENT/);
      expect(text).toMatch(/Ayesha Khan/);
      expect(text).toMatch(/\+\$550\.00/);
      expect(text).toMatch(/-\$200\.00/);
      expect(text).toMatch(/OWES NOW\s+\$350\.00/);
      expect(text).toMatch(/Credit limit\s+\$1,000\.00/);
    }
    expect(formatStatement(customers.statement(customers.create({ name: "New" }).id), { storeName: "S" })).toMatch(/Nothing on account yet/);
  });
});

describe("the ledger stays append-only for account entries", () => {
  it("cannot be edited or deleted, and only known kinds are accepted", () => {
    onAccount([{ productId: tea, qty: 1 }], 5_000);
    expect(() => db.prepare("UPDATE customer_ledger SET delta = 1 WHERE account = 'credit'").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM customer_ledger WHERE account = 'credit'").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("INSERT INTO customer_ledger (id, customer_id, account, delta, reason, created_at) VALUES ('x', ?, 'credit', 5, 'bogus', 't')").run(cust)).toThrow();
    expect(() => db.prepare("INSERT INTO customer_ledger (id, customer_id, account, delta, reason, created_at, method) VALUES ('y', ?, 'credit', -5, 'repayment', 't', 'cheque')").run(cust)).toThrow();
  });

  it("stays exact over many sales, repayments and voids", () => {
    let expected = 0;
    for (let i = 1; i <= 30; i++) {
      const amount = (i % 4 + 1) * 5_000;
      const s = onAccount([{ productId: tea, qty: amount / 5_000 }], amount);
      expected += amount;
      if (i % 3 === 0) { sales.voidSale(s.id, "t"); expected -= amount; }
      const owed = customers.get(cust)!.owedMinor;
      if (i % 5 === 0 && owed > 0) { customers.repay(cust, Math.min(owed, 7_000), i % 2 ? "cash" : "card"); expected -= Math.min(owed, 7_000); }
      expect(customers.get(cust)!.owedMinor).toBe(expected);
    }
    expectOwedIsLedgerSum();
    expect(customers.statement(cust).rows.at(-1)!.balanceMinor).toBe(expected);
  });
});

describe("upgrading to v9", () => {
  it("rebuilds the ledger keeping every row, order and trigger, and khata then works", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    for (const m of migrations.slice(0, 6)) old.exec(m.sql);
    old.pragma("user_version = 6");
    old.prepare("INSERT INTO customers (id, name, phone, created_at) VALUES ('c1', 'Old Customer', '0300', 't')").run();
    const ins = old.prepare("INSERT INTO customer_ledger (id, customer_id, account, delta, reason, note, created_at) VALUES (?, 'c1', ?, ?, ?, ?, ?)");
    ins.run("l1", "points", 10, "adjust", "gift", "2026-01-01T00:00:00Z");
    ins.run("l2", "wallet", 5_000, "topup", "cash", "2026-01-01T00:00:01Z");
    ins.run("l3", "points", -4, "adjust", "oops", "2026-01-01T00:00:02Z");
    expect(old.prepare("SELECT points, wallet_minor FROM customers WHERE id = 'c1'").get()).toEqual({ points: 6, wallet_minor: 5_000 });

    migrate(old);

    expect(old.pragma("user_version", { simple: true })).toBe(migrations.at(-1)!.version);
    expect(old.prepare("SELECT id, account, delta, reason, note, method FROM customer_ledger ORDER BY rowid").all()).toEqual([
      { id: "l1", account: "points", delta: 10, reason: "adjust", note: "gift", method: null },
      { id: "l2", account: "wallet", delta: 5_000, reason: "topup", note: "cash", method: null },
      { id: "l3", account: "points", delta: -4, reason: "adjust", note: "oops", method: null },
    ]);
    // balances kept, triggers alive
    expect(old.prepare("SELECT points, wallet_minor FROM customers WHERE id = 'c1'").get()).toEqual({ points: 6, wallet_minor: 5_000 });
    expect(() => old.prepare("DELETE FROM customer_ledger").run()).toThrow(/cannot be changed/);
    expect(() => old.prepare("UPDATE customer_ledger SET delta = 1").run()).toThrow(/cannot be changed/);
    const cs = new CustomerService(old);
    cs.adjustPoints("c1", 3, "more");
    expect(cs.get("c1")).toMatchObject({ points: 9, walletMinor: 5_000, owedMinor: 0, creditLimitMinor: null });
    // khata on the upgraded database
    const p = new ProductService(old).create({ name: "Tea", priceMinor: 5_000, trackStock: false });
    const s = new SaleService(old, "T1").checkout({ lines: [{ productId: p.id, qty: 1 }], payments: [], customerId: "c1", onAccountMinor: 5_000, allowNegativeStock: true });
    expect(s.onAccountMinor).toBe(5_000);
    expect(cs.get("c1")!.owedMinor).toBe(5_000);
    migrate(old); // running it again is harmless
    expect(cs.get("c1")!.owedMinor).toBe(5_000);
    // an old sale (before the column existed) reads as nothing on account
  });
});
