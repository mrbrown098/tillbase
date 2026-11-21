import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { TillbaseApi } from "../shared/api";

let api: TillbaseApi;

async function signInAs(name: string, role: "manager" | "cashier") {
  await api.logout();
  const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
  await api.login(owner.id, "1111");
  await api.createStaff({ name, pin: "2222", role });
  const u = (await api.loginUsers()).find((x) => x.name === name)!;
  await api.logout();
  await api.login(u.id, "2222");
}

beforeEach(async () => {
  api = createHandlers(openDatabase(":memory:"), "T1", () => 1_000_000);
  await api.setupOwner("Boss", "1111");
});

async function menu() {
  const burger = await api.createProduct({ name: "Burger", priceMinor: 45_000, trackStock: false });
  const cola = await api.createProduct({ name: "Cola", priceMinor: 8_000, trackStock: false });
  const mod = await api.addModifier({ name: "Extra cheese", priceMinor: 5_000 });
  return { burger, cola, mod };
}

describe("orders through the API", () => {
  it("takes an order, sends it to the kitchen, serves it and takes payment with the token on the receipt", async () => {
    const { burger, mod } = await menu();
    await api.openShift(0);
    const o = await api.createOrder({ type: "dine_in", tableLabel: "4" });
    await api.addOrderItem(o.id, { productId: burger.id, qty: 2, modifierIds: [mod.id] });
    const ticket = await api.sendToKitchen(o.id);
    expect(ticket.items[0]).toMatchObject({ name: "Burger", qty: 2, modifiers: ["Extra cheese"] });
    expect((await api.kitchenBoard())[0]!.token).toBe(1);
    await api.setKitchenStatus(o.id, "ready");
    await api.setKitchenStatus(o.id, "served");
    const { sale, receipt } = await api.payOrder(o.id, [{ method: "cash", amountMinor: 100_000 }]);
    expect(sale.totalMinor).toBe(100_000);
    expect(receipt).toContain("Token 1 · Dine-in · Table 4");
    expect(await api.openOrders()).toHaveLength(0);
    expect(await api.kitchenBoard()).toHaveLength(0);
    expect((await api.shiftSummary()).expectedCashMinor).toBe(100_000);
  });

  it("cannot be paid without an open shift, and keeps the order open", async () => {
    const { burger } = await menu();
    const o = await api.createOrder({ type: "takeaway" });
    await api.addOrderItem(o.id, { productId: burger.id, qty: 1 });
    await expect(api.payOrder(o.id, [{ method: "cash", amountMinor: 45_000 }])).rejects.toThrow(/Open a shift/);
    expect(await api.openOrders()).toHaveLength(1);
  });

  it("needs sign-in, and only managers can change what is already in the kitchen", async () => {
    const { burger } = await menu();
    await signInAs("Till", "cashier");
    const o = await api.createOrder({ type: "takeaway" });
    const withItem = await api.addOrderItem(o.id, { productId: burger.id, qty: 1 });
    await api.sendToKitchen(o.id);
    const itemId = withItem.items[0]!.id;
    await expect(api.removeOrderItem(itemId)).rejects.toThrow(/already gone to the kitchen/);
    await expect(api.setOrderItemQty(itemId, 5)).rejects.toThrow(/already gone to the kitchen/);
    await expect(api.cancelOrder(o.id, "changed mind")).rejects.toThrow(/Ask a manager/);
    await expect(api.addModifier({ name: "Hacked" })).rejects.toThrow(/permission/);

    await signInAs("Mgr", "manager");
    expect((await api.setOrderItemQty(itemId, 5)).items[0]!.qty).toBe(5);
    expect((await api.cancelOrder(o.id, "changed mind")).status).toBe("cancelled");

    await api.logout();
    await expect(api.openOrders()).rejects.toThrow(/sign in/);
    await expect(api.kitchenBoard()).rejects.toThrow(/sign in/);
  });

  it("a cashier can cancel an order that never reached the kitchen", async () => {
    await menu();
    await signInAs("Till", "cashier");
    const o = await api.createOrder({ type: "takeaway" });
    expect((await api.cancelOrder(o.id, "customer left")).status).toBe("cancelled");
  });
});

const day = () => new Date().toLocaleDateString("sv"); // YYYY-MM-DD in local time

describe("paying with several payments", () => {
  async function meal500() {
    return api.createProduct({ name: "Meal", priceMinor: 500, trackStock: false });
  }
  const cashIn = async () => (await api.shiftSummary()).expectedCashMinor;

  it("takes 300 cash + 200 card on a 500 sale, and the drawer counts only the 300", async () => {
    const meal = await meal500();
    await api.openShift(1_000); // float 1,000
    const { sale } = await api.checkout({
      lines: [{ productId: meal.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 300 }, { method: "card", amountMinor: 200 }],
    });
    expect(sale.totalMinor).toBe(500);
    expect(sale.payments.map((p) => [p.method, p.amountMinor])).toEqual([["cash", 300], ["card", 200]]);
    // Expected cash = float 1,000 + cash part 300 = 1,300. The 200 on the card is not in the drawer.
    expect(await cashIn()).toBe(1_300);
    const summary = await api.shiftSummary();
    expect(summary.byMethod).toMatchObject({ cash: 300, card: 200 });
  });

  it("rejects a split that does not cover the total, and changes nothing", async () => {
    const meal = await meal500();
    await api.openShift(0);
    await expect(
      api.checkout({ lines: [{ productId: meal.id, qty: 1 }], payments: [{ method: "cash", amountMinor: 300 }, { method: "card", amountMinor: 100 }] }),
    ).rejects.toThrow(/short by 100/);
    expect(await api.recentSales()).toHaveLength(0);
    expect(await cashIn()).toBe(0);
  });

  it("gives change only from the cash part", async () => {
    const meal = await meal500();
    await api.openShift(0);
    // 300 cash + 300 card = 600 for 500: change 100 comes out of the 300 cash, so the drawer keeps 200.
    const ok = await api.checkout({
      lines: [{ productId: meal.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 300 }, { method: "card", amountMinor: 300 }],
    });
    expect(ok.sale.changeMinor).toBe(100);
    expect(await cashIn()).toBe(200);
    // 40 cash + 520 card = 560 for 500: 60 change but only 40 cash to give it from.
    await expect(
      api.checkout({ lines: [{ productId: meal.id, qty: 1 }], payments: [{ method: "cash", amountMinor: 40 }, { method: "card", amountMinor: 520 }] }),
    ).rejects.toThrow("Change can only be given from a cash payment");
    // Card only, overpaid.
    await expect(
      api.checkout({ lines: [{ productId: meal.id, qty: 1 }], payments: [{ method: "card", amountMinor: 600 }] }),
    ).rejects.toThrow("Change can only be given from a cash payment");
    expect(await api.recentSales()).toHaveLength(1);
    expect(await cashIn()).toBe(200);
  });

  it("does the same when paying an order, including three methods", async () => {
    const meal = await meal500();
    await api.openShift(0);
    const o = await api.createOrder({ type: "takeaway" });
    await api.addOrderItem(o.id, { productId: meal.id, qty: 1 });
    await expect(
      api.payOrder(o.id, [{ method: "cash", amountMinor: 100 }, { method: "card", amountMinor: 100 }]),
    ).rejects.toThrow(/short by 300/);
    expect(await api.openOrders()).toHaveLength(1);
    const { sale } = await api.payOrder(o.id, [
      { method: "cash", amountMinor: 100 },
      { method: "card", amountMinor: 250 },
      { method: "other", amountMinor: 150 },
    ]);
    expect(sale.payments.map((p) => p.method)).toEqual(["cash", "card", "other"]);
    expect(sale.changeMinor).toBe(0);
    expect(await cashIn()).toBe(100); // only the 100 of cash
    expect(await api.openOrders()).toHaveLength(0);
  });

  it("rejects zero, negative and fractional payment amounts", async () => {
    const meal = await meal500();
    await api.openShift(0);
    for (const amount of [0, -100, 250.5]) {
      await expect(
        api.checkout({ lines: [{ productId: meal.id, qty: 1 }], payments: [{ method: "cash", amountMinor: 500 }, { method: "card", amountMinor: amount }] }),
      ).rejects.toThrow(/positive integers/);
    }
    expect(await api.recentSales()).toHaveLength(0);
  });
});

describe("delivery fee through the API", () => {
  it("is set on the order, paid by a split, shown on the receipt, and counted as income, not as a menu item", async () => {
    const burger = await api.createProduct({ name: "Burger", priceMinor: 45_000, trackStock: false });
    await api.openShift(0);
    const o = await api.createOrder({ type: "delivery", deliveryAddress: "House 5", deliveryFeeMinor: 5_000 });
    expect(o.deliveryFeeMinor).toBe(5_000);
    await api.addOrderItem(o.id, { productId: burger.id, qty: 2 });
    expect((await api.updateOrder(o.id, { deliveryFeeMinor: 15_000 })).deliveryFeeMinor).toBe(15_000);
    // 90,000 food + 15,000 delivery = 105,000, paid 60,000 cash + 45,000 card.
    const { sale, receipt } = await api.payOrder(o.id, [{ method: "cash", amountMinor: 60_000 }, { method: "card", amountMinor: 45_000 }]);
    expect(sale.totalMinor).toBe(105_000);
    expect(receipt).toContain("Delivery fee");
    expect((await api.shiftSummary()).expectedCashMinor).toBe(60_000);
    // The Money screen: income 105,000 and no "no cost" warning from the fee.
    const pl = await api.profitAndLoss(day(), day());
    expect(pl.netSalesMinor).toBe(105_000);
    expect(pl.items.find((i) => i.name === "Delivery fee")).toMatchObject({ salesMinor: 15_000, costMissing: false });
    expect(pl.warnings.filter((w) => /Delivery/.test(w))).toEqual([]);
    // Not on the till, search, menu list, or low stock.
    expect((await api.listProducts()).map((p) => p.name)).toEqual(["Burger"]);
    expect(await api.searchProducts("Delivery")).toEqual([]);
    expect((await api.listItems("all")).map((p) => p.name)).toEqual(["Burger"]);
    expect(await api.exportProductCsv()).not.toContain("Delivery");
    // Voiding the sale takes it back out of the takings.
    await api.voidSale(sale.id, "refused at the door");
    expect((await api.profitAndLoss(day(), day())).netSalesMinor).toBe(0);
  });

  it("can be set by a cashier, and refuses a bad amount", async () => {
    await signInAs("Till", "cashier");
    const o = await api.createOrder({ type: "delivery", deliveryAddress: "House 5" });
    expect((await api.updateOrder(o.id, { deliveryFeeMinor: 12_000 })).deliveryFeeMinor).toBe(12_000);
    await expect(api.updateOrder(o.id, { deliveryFeeMinor: -1 })).rejects.toThrow(/whole amount/);
    await expect(api.updateOrder(o.id, { deliveryFeeMinor: 1.5 })).rejects.toThrow(/whole amount/);
  });
});

describe("splitting a bill through the API", () => {
  async function table() {
    const burger = await api.createProduct({ name: "Burger", priceMinor: 45_000, trackStock: false });
    const cola = await api.createProduct({ name: "Cola", priceMinor: 8_000, trackStock: false });
    await api.openShift(0);
    const o = await api.createOrder({ type: "dine_in", tableLabel: "9" });
    await api.addOrderItem(o.id, { productId: burger.id, qty: 3 });
    const full = await api.addOrderItem(o.id, { productId: cola.id, qty: 3 });
    return { o, burger, cola, a: full.items[0]!, b: full.items[1]! };
  }

  it("lets a cashier split a bill that is already in the kitchen, and both bills are paid separately", async () => {
    const { o, a, b } = await table(); // set up as the owner, who may create products and open the shift
    await signInAs("Till", "cashier");
    // The cashier cannot remove sent food, but splitting removes nothing, so it is allowed.
    await api.sendToKitchen(o.id);
    await expect(api.removeOrderItem(a.id)).rejects.toThrow(/already gone to the kitchen/);
    // Burger x3 = 135,000, Cola x3 = 24,000: whole bill 159,000. Move 1 Burger + 3 Colas: 45,000 + 24,000 = 69,000.
    const { original, created } = await api.splitOrder(o.id, [{ itemId: a.id, qty: 1 }, { itemId: b.id, qty: 3 }]);
    expect([original.subtotalMinor, created.subtotalMinor]).toEqual([90_000, 69_000]);
    expect(original.subtotalMinor + created.subtotalMinor).toBe(159_000);
    expect(created).toMatchObject({ token: 2, tableLabel: "9", type: "dine_in", splitFrom: o.id });
    expect((await api.openOrders()).map((x) => x.token)).toEqual([1, 2]);
    expect([...original.items, ...created.items].every((i) => i.sent)).toBe(true);
    await expect(api.sendToKitchen(created.id)).rejects.toThrow(/Nothing new/);

    const s1 = await api.payOrder(original.id, [{ method: "cash", amountMinor: 90_000 }]);
    const s2 = await api.payOrder(created.id, [{ method: "card", amountMinor: 69_000 }]);
    expect(s1.sale.totalMinor + s2.sale.totalMinor).toBe(159_000);
    expect(s1.receipt).toContain("Token 1 · Dine-in · Table 9");
    expect(s2.receipt).toContain("Token 2 · Dine-in · Table 9");
    expect(await api.openOrders()).toHaveLength(0);
    // Drawer: only the cash bill. Float 0 + 90,000. (A cashier's view hides the expected cash, so the owner looks.)
    expect((await api.shiftSummary()).expectedCashMinor).toBeNull();
    await api.logout();
    await api.login((await api.loginUsers()).find((u) => u.role === "owner")!.id, "1111");
    expect((await api.shiftSummary()).expectedCashMinor).toBe(90_000);
  });

  it("needs a sign-in and refuses a split that empties the original, with a readable message", async () => {
    const { o, a, b } = await table();
    await expect(api.splitOrder(o.id, [{ itemId: a.id, qty: 3 }, { itemId: b.id, qty: 3 }])).rejects.toThrow(
      "The original bill must keep at least one item. To pay for everything, just pay the bill",
    );
    expect(await api.openOrders()).toHaveLength(1);
    await api.logout();
    await expect(api.splitOrder(o.id, [{ itemId: a.id, qty: 1 }])).rejects.toThrow(/sign in/);
  });
});
