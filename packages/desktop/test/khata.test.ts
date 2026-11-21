import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import { channels, type TillbaseApi } from "../shared/api";

let api: TillbaseApi;

async function signInAs(name: string, role: "owner" | "manager" | "cashier") {
  await api.logout();
  const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
  await api.login(owner.id, "1111");
  if (role === "owner") return;
  if (!(await api.loginUsers()).some((u) => u.name === name)) await api.createStaff({ name, pin: "2222", role });
  const u = (await api.loginUsers()).find((x) => x.name === name)!;
  await api.logout();
  await api.login(u.id, "2222");
}

beforeEach(async () => {
  api = createHandlers(openDatabase(":memory:"), "T1", () => 1_000_000);
  await api.setupOwner("Boss", "1111");
});

async function shop() {
  const burger = await api.createProduct({ name: "Burger", priceMinor: 25_000, trackStock: false });
  const tea = await api.createProduct({ name: "Tea", priceMinor: 5_000, trackStock: false });
  await api.openShift(10_000);
  const c = await api.createCustomer({ name: "Ayesha Khan", phone: "0300 1234567" });
  return { burger, tea, c };
}
const expectedCash = async () => {
  await signInAs("Mo", "manager");
  return (await api.shiftSummary()).expectedCashMinor;
};

describe("khata calls are wired through", () => {
  it("every new method is in the channel list and has a handler", () => {
    for (const n of ["owingCustomers", "customerStatement", "customerStatementText", "repayCustomer", "setCreditLimit", "writeOffCustomer"]) {
      expect(channels).toContain(n);
      expect(typeof (api as unknown as Record<string, unknown>)[n]).toBe("function");
    }
    for (const c of channels) expect(typeof (api as unknown as Record<string, unknown>)[c]).toBe("function");
    for (const k of Object.keys(api)) expect(channels).toContain(k);
  });
});

describe("who may do what", () => {
  it("needs a sign-in", async () => {
    await api.logout();
    await expect(api.owingCustomers()).rejects.toThrow(/sign in/);
    await expect(api.repayCustomer("x", 1, "cash")).rejects.toThrow(/sign in/);
  });

  it("a cashier can sell on account, take a repayment and read statements, but cannot set limits or write off", async () => {
    const { tea, c } = await shop();
    await signInAs("Ali", "cashier");
    const r = await api.checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: [], customerId: c.id, onAccountMinor: 10_000 });
    expect(r.sale).toMatchObject({ totalMinor: 10_000, paidMinor: 0, onAccountMinor: 10_000 });
    expect(r.receipt).toMatch(/ON ACCOUNT/);
    expect(r.receipt).toMatch(/You owe/);
    expect((await api.owingCustomers()).map((d) => [d.name, d.owedMinor])).toEqual([["Ayesha Khan", 10_000]]);
    expect((await api.repayCustomer(c.id, 4_000, "cash", "part")).owedMinor).toBe(6_000);
    expect((await api.customerStatement(c.id)).rows.map((x) => x.kind)).toEqual(["sale", "repayment"]);
    const no = /do not have permission/;
    await expect(api.setCreditLimit(c.id, 1_000)).rejects.toThrow(no);
    await expect(api.writeOffCustomer(c.id, "kind")).rejects.toThrow(no);
    expect((await api.getCustomer(c.id)).creditLimitMinor).toBeNull();
    expect((await api.getCustomer(c.id)).owedMinor).toBe(6_000);
  });

  it("a manager sets the limit and writes off; the owner can too", async () => {
    const { tea, c } = await shop();
    await api.checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: [], customerId: c.id, onAccountMinor: 10_000 });
    await signInAs("Mo", "manager");
    expect((await api.setCreditLimit(c.id, 50_000)).creditLimitMinor).toBe(50_000);
    expect((await api.writeOffCustomer(c.id, "Left town", 4_000)).owedMinor).toBe(6_000);
    await signInAs("Boss", "owner");
    expect((await api.setCreditLimit(c.id, null)).creditLimitMinor).toBeNull();
    expect((await api.writeOffCustomer(c.id, "Forgiven")).owedMinor).toBe(0);
    const st = await api.customerStatement(c.id);
    expect(st.rows.map((x) => [x.kind, x.note])).toEqual([["sale", null], ["writeoff", "Left town"], ["writeoff", "Forgiven"]]);
  });
});

describe("limits at the till", () => {
  it("refuses a sale over the limit with a plain message and sells nothing", async () => {
    const { tea, c } = await shop();
    await signInAs("Mo", "manager");
    await api.setCreditLimit(c.id, 12_000);
    await signInAs("Ali", "cashier");
    await api.checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: [], customerId: c.id, onAccountMinor: 10_000 });
    await expect(api.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: [], customerId: c.id, onAccountMinor: 5_000 })).rejects.toThrow(
      "Ayesha Khan owes 100.00, and putting 50.00 more on account would go over their limit of 120.00. The most you can put on account is 20.00.",
    );
    expect(await api.recentSales()).toHaveLength(1);
  });

  it("an order is paid partly on account, and the account part is not cash", async () => {
    const { burger, c } = await shop();
    const o = await api.createOrder({ type: "takeaway", customerId: c.id });
    await api.addOrderItem(o.id, { productId: burger.id, qty: 1 });
    const r = await api.payOrder(o.id, [{ method: "cash", amountMinor: 10_000 }], { onAccountMinor: 15_000 });
    expect(r.sale).toMatchObject({ totalMinor: 25_000, paidMinor: 10_000, onAccountMinor: 15_000 });
    expect((await api.getCustomer(c.id)).owedMinor).toBe(15_000);
    expect(await expectedCash()).toBe(20_000); // 100.00 float + 100.00 cash; the 150.00 on account is not in the drawer
  });
});

describe("repayments and the drawer", () => {
  it("cash goes into the drawer record, card does not; each is one step", async () => {
    const { tea, c } = await shop();
    await api.checkout({ lines: [{ productId: tea.id, qty: 4 }], payments: [], customerId: c.id, onAccountMinor: 20_000 });
    expect(await expectedCash()).toBe(10_000); // the sale on account added nothing
    await api.repayCustomer(c.id, 5_000, "cash", "first part");
    expect(await expectedCash()).toBe(15_000);
    await api.repayCustomer(c.id, 3_000, "card");
    expect(await expectedCash()).toBe(15_000);
    expect((await api.getCustomer(c.id)).owedMinor).toBe(12_000);
    const sum = await api.shiftSummary();
    expect(sum.movements.map((m) => [m.amountMinor, m.reason])).toEqual([[5_000, "Khata repayment from Ayesha Khan"]]);
    const ledger = await api.customerLedger(c.id);
    expect(ledger.filter((l) => l.reason === "repayment").map((l) => [l.method, l.delta, l.note]).sort()).toEqual([["card", -3_000, null], ["cash", -5_000, "first part"]]);
  });

  it("a cash repayment needs an open shift and changes nothing when refused", async () => {
    const { tea, c } = await shop();
    await api.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: [], customerId: c.id, onAccountMinor: 5_000 });
    await signInAs("Mo", "manager");
    await api.closeShift(10_000);
    await expect(api.repayCustomer(c.id, 1_000, "cash")).rejects.toThrow(/Open a shift/);
    expect((await api.getCustomer(c.id)).owedMinor).toBe(5_000);
    expect((await api.repayCustomer(c.id, 1_000, "card")).owedMinor).toBe(4_000); // card needs no drawer
  });

  it("refuses too much, nothing, or the wrong method, with plain messages", async () => {
    const { tea, c } = await shop();
    await api.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: [], customerId: c.id, onAccountMinor: 5_000 });
    await expect(api.repayCustomer(c.id, 5_001, "cash")).rejects.toThrow(/owes 50\.00, so 50\.01 is too much/);
    await expect(api.repayCustomer(c.id, 0, "cash")).rejects.toThrow(/above 0/);
    await expect(api.repayCustomer(c.id, 100, "cheque" as never)).rejects.toThrow(/cash or card/);
    expect(await expectedCash()).toBe(10_000);
  });
});

describe("voiding and statements", () => {
  it("a manager voiding a sale on account reverses it exactly", async () => {
    const { tea, c } = await shop();
    const r = await api.checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: [], customerId: c.id, onAccountMinor: 10_000 });
    await signInAs("Mo", "manager");
    await api.voidSale(r.sale.id, "Wrong customer");
    expect((await api.getCustomer(c.id)).owedMinor).toBe(0);
    expect(await api.owingCustomers()).toEqual([]);
    expect((await api.customerStatement(c.id)).rows.map((x) => [x.kind, x.balanceMinor])).toEqual([["sale", 10_000], ["void", 0]]);
  });

  it("prints a statement for 58 mm and 80 mm paper", async () => {
    const { tea, c } = await shop();
    await api.checkout({ lines: [{ productId: tea.id, qty: 3 }], payments: [], customerId: c.id, onAccountMinor: 15_000 });
    for (const w of [32, 48] as const) {
      const text = await api.customerStatementText(c.id, w);
      expect(text).toMatch(/ACCOUNT STATEMENT/);
      expect(text).toMatch(/OWES NOW\s+\$150\.00/);
      for (const l of text.split("\n")) expect(l.length).toBeLessThanOrEqual(w);
    }
  });
});
