import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { TillbaseApi } from "../shared/api";

let api: TillbaseApi;
let flour: string;

async function as(name: string, role: "manager" | "cashier") {
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
  flour = (await api.createProduct({ name: "Flour", kind: "ingredient", unit: "kg", priceMinor: 0 })).id;
});

describe("supplier orders through the app's API", () => {
  it("lets the owner order, receive in two parts, and see what is owed, with stock moving only on receipt", async () => {
    const o = await api.createPurchaseOrder({ supplier: "Metro", lines: [{ productId: flour, qty: 10, unitCostMinor: 8_000 }] });
    expect(o.code).toBe("PO-0001");
    expect((await api.payables()).totalMinor).toBe(0);
    expect((await api.listItems("all")).find((i) => i.id === flour)?.stock).toBe(0);

    const part = await api.receivePurchaseOrder(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 6 }], paidMinor: 20_000 });
    expect(part.progress).toBe("partly_received");
    expect((await api.listItems("all")).find((i) => i.id === flour)?.stock).toBe(6);
    expect((await api.payables()).totalMinor).toBe(28_000); // 480.00 bought, 200.00 paid

    const done = await api.receivePurchaseOrder(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 4 }] });
    expect(done.status).toBe("received");
    expect((await api.payables()).totalMinor).toBe(60_000); // + 4 kg x 80.00 = 320.00
    expect(await api.supplierNames()).toEqual(["Metro"]);
    const st = await api.supplierStatement("Metro");
    expect(st.closingBalanceMinor).toBe(60_000);
    expect((await api.listPurchaseOrders("received")).map((x) => x.code)).toEqual(["PO-0001"]);
    expect(await api.listPurchaseOrders("open")).toEqual([]);
  });

  it("takes the paid cash out of the till drawer when asked, and refuses when no shift is open", async () => {
    const o = await api.createPurchaseOrder({ supplier: "Metro", lines: [{ productId: flour, qty: 10, unitCostMinor: 8_000 }] });
    const line = o.lines[0]!.id;
    await expect(api.receivePurchaseOrder(o.id, { lines: [{ lineId: line, qty: 2 }], paidMinor: 5_000 }, true)).rejects.toThrow(/Open a shift/);
    // The refusal rolled the delivery back too: nothing was booked.
    expect((await api.listPurchaseOrders("open"))[0]!.lines[0]!.qtyReceived).toBe(0);
    expect((await api.payables()).totalMinor).toBe(0);

    await api.openShift(50_000);
    await api.receivePurchaseOrder(o.id, { lines: [{ lineId: line, qty: 2 }], paidMinor: 5_000 }, true);
    const s = await api.shiftSummary();
    expect(s.cashOutMinor).toBe(5_000);
    expect(s.movements[0]?.reason).toBe("Delivery PO-0001 from Metro");
  });

  it("cancels, and tells the owner why a receipt was refused", async () => {
    const o = await api.createPurchaseOrder({ supplier: "Metro", lines: [{ productId: flour, qty: 3, unitCostMinor: 1_000 }] });
    await expect(api.receivePurchaseOrder(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 4 }] })).rejects.toThrow(/Only 3 kg of Flour/);
    const c = await api.cancelPurchaseOrder(o.id, "Changed supplier");
    expect(c.progress).toBe("cancelled");
    await expect(api.cancelPurchaseOrder(o.id)).rejects.toThrow(/already cancelled/);
  });

  it("needs the purchasing permission: cashiers are refused every call", async () => {
    const o = await api.createPurchaseOrder({ supplier: "Metro", lines: [{ productId: flour, qty: 1, unitCostMinor: 1_000 }] });
    await as("Till", "cashier");
    await expect(api.listPurchaseOrders()).rejects.toThrow(/permission/);
    await expect(api.createPurchaseOrder({ supplier: "X", lines: [{ productId: flour, qty: 1, unitCostMinor: 1 }] })).rejects.toThrow(/permission/);
    await expect(api.receivePurchaseOrder(o.id, { lines: [{ lineId: o.lines[0]!.id, qty: 1 }] })).rejects.toThrow(/permission/);
    await expect(api.cancelPurchaseOrder(o.id)).rejects.toThrow(/permission/);
    await expect(api.supplierNames()).rejects.toThrow(/permission/);
    await expect(api.supplierStatement("Metro")).rejects.toThrow(/permission/);
  });
});
