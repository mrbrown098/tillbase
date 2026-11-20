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
