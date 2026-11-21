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
  await api.createStaff({ name, pin: "2222", role });
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
  await api.openShift(0);
  return { burger, tea };
}

describe("every customer call is wired through the channel list", () => {
  it("lists each method the page can call, and no handler is missing", () => {
    const names = ["searchCustomers", "getCustomer", "createCustomer", "updateCustomer", "customerHistory", "customerLedger",
      "adjustCustomerPoints", "adjustCustomerWallet", "topUpWallet", "getLoyalty", "setLoyalty"];
    for (const n of names) {
      expect(channels).toContain(n);
      expect(typeof (api as unknown as Record<string, unknown>)[n]).toBe("function");
    }
    // Everything in the list has a handler, and every handler is in the list (so the page can reach it).
    for (const c of channels) expect(typeof (api as unknown as Record<string, unknown>)[c]).toBe("function");
    for (const k of Object.keys(api)) expect(channels).toContain(k);
  });
});

describe("who may do what with customers", () => {
  it("needs a sign-in", async () => {
    await api.logout();
    await expect(api.searchCustomers("")).rejects.toThrow(/sign in/);
    await expect(api.createCustomer({ name: "A" })).rejects.toThrow(/sign in/);
    await expect(api.getLoyalty()).rejects.toThrow(/sign in/);
  });

  it("a cashier can search, add and look up a customer, and attach one to an order", async () => {
    await shop();
    await signInAs("Ali", "cashier");
    const c = await api.createCustomer({ name: "Ayesha", phone: "0300 1234567", address: "House 5" });
    expect((await api.searchCustomers("0300 123")).map((x) => x.id)).toEqual([c.id]);
    expect((await api.getCustomer(c.id)).name).toBe("Ayesha");
    expect(await api.getLoyalty()).toEqual({ spendPerPointMinor: 10_000, pointValueMinor: 100 });
    const o = await api.createOrder({ type: "delivery", customerId: c.id });
    expect(o).toMatchObject({ customerId: c.id, deliveryAddress: "House 5" });
    expect((await api.updateOrder(o.id, { customerId: null })).customerId).toBeNull();
  });

  it("a cashier cannot edit, correct, top up, read history or change the rates", async () => {
    await shop();
    await signInAs("Ali", "cashier");
    const c = await api.createCustomer({ name: "Ayesha" });
    const no = /do not have permission/;
    await expect(api.updateCustomer(c.id, { name: "X" })).rejects.toThrow(no);
    await expect(api.customerHistory(c.id)).rejects.toThrow(no);
    await expect(api.customerLedger(c.id)).rejects.toThrow(no);
    await expect(api.adjustCustomerPoints(c.id, 5, "gift")).rejects.toThrow(no);
    await expect(api.adjustCustomerWallet(c.id, 500, "gift")).rejects.toThrow(no);
    await expect(api.topUpWallet(c.id, 500, "cash")).rejects.toThrow(no);
    await expect(api.setLoyalty({ spendPerPointMinor: 1, pointValueMinor: 1 })).rejects.toThrow(no);
    expect((await api.getCustomer(c.id)).points).toBe(0);
  });

  it("a manager manages customers, but history hides what they spent; the owner sees it", async () => {
    const { tea } = await shop();
    const owner = await api.createCustomer({ name: "Ayesha" });
    await api.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }], customerId: owner.id });
    await signInAs("Mo", "manager");
    expect((await api.updateCustomer(owner.id, { notes: "VIP" })).notes).toBe("VIP");
    expect((await api.adjustCustomerPoints(owner.id, 10, "Welcome gift")).points).toBe(10);
    const h = await api.customerHistory(owner.id);
    expect(h.visitCount).toBe(1);
    expect(h.visits).toHaveLength(1);
    expect(h.totalSpentMinor).toBeNull();
    expect((await api.setLoyalty({ spendPerPointMinor: 5_000, pointValueMinor: 100 })).spendPerPointMinor).toBe(5_000);
    await signInAs("Boss", "owner");
    expect((await api.customerHistory(owner.id)).totalSpentMinor).toBe(5_000);
    expect((await api.customerLedger(owner.id)).map((l) => l.reason).sort()).toEqual(["adjust"]) // 50.00 of tea is below the 100.00 that earns a point;
  });
});

describe("points and wallet at the till", () => {
  it("a cashier sells with points; the receipt shows them; a void by a manager puts them back", async () => {
    const { burger, tea } = await shop();
    await signInAs("Mo", "manager");
    const c = await api.createCustomer({ name: "Ayesha" });
    await api.adjustCustomerPoints(c.id, 25, "Gift");
    await signInAs("Ali", "cashier");
    const r = await api.checkout({
      lines: [{ productId: burger.id, qty: 1 }, { productId: tea.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 29_000 }], customerId: c.id, redeemPoints: 10,
    });
    expect(r.sale).toMatchObject({ totalMinor: 29_000, discountMinor: 1_000, pointsRedeemed: 10, pointsEarned: 2 });
    expect(r.receipt).toMatch(/Customer: Ayesha/);
    expect(r.receipt).toMatch(/Points used\s+-10/);
    expect(r.receipt).toMatch(/Points balance\s+17 points/);
    // A cashier using points is not a manual discount: the line prices are the menu's.
    expect((await api.getCustomer(c.id)).points).toBe(17);
    await signInAs("Mo2", "manager");
    await api.voidSale(r.sale.id, "Wrong order");
    expect((await api.getCustomer(c.id)).points).toBe(25);
  });

  it("refuses points the customer does not have, with a plain message, and sells nothing", async () => {
    const { tea } = await shop();
    const c = await api.createCustomer({ name: "Ayesha" });
    await expect(
      api.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: [{ method: "cash", amountMinor: 5_000 }], customerId: c.id, redeemPoints: 3 }),
    ).rejects.toThrow(/Ayesha has 0 points, not 3/);
    expect(await api.recentSales()).toEqual([]);
  });

  it("pays an order with points and wallet", async () => {
    const { burger } = await shop();
    await signInAs("Mo", "manager");
    const c = await api.createCustomer({ name: "Ayesha" });
    await api.adjustCustomerPoints(c.id, 10, "Gift");
    await api.topUpWallet(c.id, 5_000, "card");
    const o = await api.createOrder({ type: "takeaway", customerId: c.id });
    await api.addOrderItem(o.id, { productId: burger.id, qty: 1 });
    const r = await api.payOrder(o.id, [{ method: "cash", amountMinor: 19_000 }], { redeemPoints: 10, walletMinor: 5_000 });
    expect(r.sale.totalMinor).toBe(24_000);
    expect(r.receipt).toMatch(/WALLET\s+/);
    expect(await api.getCustomer(c.id)).toMatchObject({ points: 2, walletMinor: 0 });
  });
});

describe("wallet top-up and the cash drawer", () => {
  async function drawer() {
    return (await api.shiftSummary()).expectedCashMinor;
  }

  it("a cash top-up goes into the drawer record; a card top-up does not", async () => {
    await shop();
    await signInAs("Mo", "manager");
    const c = await api.createCustomer({ name: "Ayesha" });
    expect(await drawer()).toBe(0);
    await api.topUpWallet(c.id, 10_000, "cash", "Walk-in");
    expect(await drawer()).toBe(10_000);
    await api.topUpWallet(c.id, 2_000, "card");
    expect(await drawer()).toBe(10_000);
    expect((await api.getCustomer(c.id)).walletMinor).toBe(12_000);
    const reasons = (await api.customerLedger(c.id)).map((l) => l.note).sort();
    expect(reasons).toEqual(["Card", "Cash · Walk-in"]);
  });

  it("a cash top-up needs an open shift and changes nothing when refused", async () => {
    await api.createProduct({ name: "Tea", priceMinor: 5_000, trackStock: false });
    const c = await api.createCustomer({ name: "Ayesha" });
    await expect(api.topUpWallet(c.id, 1_000, "cash")).rejects.toThrow(/Open a shift/);
    expect((await api.getCustomer(c.id)).walletMinor).toBe(0);
    await expect(api.topUpWallet(c.id, 0, "card")).rejects.toThrow(/above 0/);
    await expect(api.topUpWallet(c.id, 1_000, "cheque" as never)).rejects.toThrow(/cash or card/);
  });

  it("spending the wallet takes no cash from the drawer", async () => {
    const { tea } = await shop();
    const c = await api.createCustomer({ name: "Ayesha" });
    await api.topUpWallet(c.id, 5_000, "card");
    await api.checkout({ lines: [{ productId: tea.id, qty: 1 }], payments: [], customerId: c.id, walletMinor: 5_000 });
    expect(await drawer()).toBe(0);
    expect((await api.getCustomer(c.id)).walletMinor).toBe(0);
  });
});
