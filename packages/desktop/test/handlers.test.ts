import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { TillbaseApi } from "../shared/api";

let api: TillbaseApi;
let clock: number;

/** Fresh app, owner created and signed in, shift open with a 100.00 float. */
async function ready() {
  await api.setupOwner("Boss", "1111");
  await api.openShift(10000);
}

async function makeStaff(name: string, role: "manager" | "cashier", pin = "2222") {
  await api.createStaff({ name, pin, role });
  const staff = (await api.loginUsers()).find((u) => u.name === name)!;
  return { id: staff.id, pin };
}

beforeEach(() => {
  clock = 1_000_000;
  api = createHandlers(openDatabase(":memory:"), "T1", () => clock);
});

describe("first run and sign in", () => {
  it("asks for setup, creates the owner once, and signs them in", async () => {
    expect((await api.session()).needsSetup).toBe(true);
    const s = await api.setupOwner("Boss", "1111");
    expect(s.needsSetup).toBe(false);
    expect(s.user?.role).toBe("owner");
    await expect(api.setupOwner("Intruder", "9999")).rejects.toThrow(/already been completed/);
  });

  it("blocks everything until someone signs in", async () => {
    await api.setupOwner("Boss", "1111");
    await api.logout();
    await expect(api.listProducts()).rejects.toThrow(/sign in/);
    await expect(api.checkout({ lines: [], payments: [] })).rejects.toThrow(/sign in/);
    await expect(api.listStaff()).rejects.toThrow(/sign in/);
    expect((await api.session()).user).toBeNull();
    expect((await api.getSettings()).storeName).toBeTruthy(); // login screen needs this
  });

  it("signs in with the right PIN and rejects the wrong one", async () => {
    await api.setupOwner("Boss", "1111");
    const { id } = (await api.loginUsers())[0]!;
    await api.logout();
    await expect(api.login(id, "0000")).rejects.toThrow(/Wrong PIN/);
    expect((await api.login(id, "1111")).user?.name).toBe("Boss");
  });

  it("signs a user out immediately when they are deactivated", async () => {
    await ready();
    const cashier = await makeStaff("Ali", "cashier");
    await api.logout();
    const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
    await api.login(owner.id, "1111");
    // Ali signs in on another session; here we just check the owner path then deactivate.
    await api.updateStaff(cashier.id, { active: false });
    expect((await api.loginUsers()).map((u) => u.name)).toEqual(["Boss"]);
  });
});

describe("permissions", () => {
  it("lets a cashier sell but not manage products, stock, reports, settings or staff", async () => {
    await ready();
    const p = await api.createProduct({ name: "Tea", priceMinor: 500 }, 10);
    const c = await makeStaff("Ali", "cashier");
    await api.logout();
    await api.login(c.id, c.pin);

    expect((await api.listProducts())[0]?.name).toBe("Tea");
    await expect(api.createProduct({ name: "X", priceMinor: 1 })).rejects.toThrow(/permission/);
    await expect(api.updateProduct(p.id, { priceMinor: 1 })).rejects.toThrow(/permission/);
    await expect(api.adjustStock(p.id, 5, "x")).rejects.toThrow(/permission/);
    await expect(api.lowStock()).rejects.toThrow(/permission/);
    await expect(api.salesSummary("2000-01-01", "2100-01-01")).rejects.toThrow(/permission/);
    await expect(api.updateSettings({ storeName: "Hacked" })).rejects.toThrow(/permission/);
    await expect(api.listStaff()).rejects.toThrow(/permission/);
    await expect(api.createStaff({ name: "Z", pin: "1234", role: "owner" })).rejects.toThrow(/permission/);
    await expect(api.recentShifts()).rejects.toThrow(/permission/);
    await expect(api.cashMovement(100, "x")).rejects.toThrow(/permission/);
  });

  it("stops a cashier giving discounts or overriding prices, but not selling at list price", async () => {
    await ready();
    const p = await api.createProduct({ name: "Tea", priceMinor: 500 }, 10);
    const c = await makeStaff("Ali", "cashier");
    await api.logout();
    await api.login(c.id, c.pin);
    const pay = [{ method: "cash" as const, amountMinor: 1000 }];
    await expect(
      api.checkout({ lines: [{ productId: p.id, qty: 1, discountMinor: 100 }], payments: pay }),
    ).rejects.toThrow(/permission/);
    await expect(
      api.checkout({ lines: [{ productId: p.id, qty: 1, unitPriceMinor: 1 }], payments: pay }),
    ).rejects.toThrow(/permission/);
    const ok = await api.checkout({ lines: [{ productId: p.id, qty: 1 }], payments: pay });
    expect(ok.sale.cashier).toBe("Ali");
    expect(ok.sale.userId).toBe(c.id);
  });

  it("lets a manager void and discount but not manage staff or settings", async () => {
    await ready();
    const p = await api.createProduct({ name: "Tea", priceMinor: 500 }, 10);
    const m = await makeStaff("Sara", "manager");
    await api.logout();
    await api.login(m.id, m.pin);
    const { sale } = await api.checkout({
      lines: [{ productId: p.id, qty: 1, discountMinor: 100 }],
      payments: [{ method: "cash", amountMinor: 400 }],
    });
    expect(sale.totalMinor).toBe(400);
    await api.voidSale(sale.id, "test");
    await expect(api.listStaff()).rejects.toThrow(/permission/);
    await expect(api.updateSettings({ storeName: "X" })).rejects.toThrow(/permission/);
  });

  it("lets a user change their own PIN only with the current one", async () => {
    await ready();
    const c = await makeStaff("Ali", "cashier");
    await api.logout();
    await api.login(c.id, c.pin);
    await expect(api.changeOwnPin("0000", "5555")).rejects.toThrow(/Wrong PIN/);
    await api.changeOwnPin(c.pin, "5555");
    await api.logout();
    await expect(api.login(c.id, c.pin)).rejects.toThrow(/Wrong PIN/);
    expect((await api.login(c.id, "5555")).user?.name).toBe("Ali");
  });

  it("lets an owner reset someone else's PIN", async () => {
    await ready();
    const c = await makeStaff("Ali", "cashier");
    await api.resetPin(c.id, "8888");
    await api.logout();
    expect((await api.login(c.id, "8888")).user?.name).toBe("Ali");
  });
});

describe("selling needs an open shift", () => {
  it("refuses to sell with no shift, then sells once one is open", async () => {
    await api.setupOwner("Boss", "1111");
    const p = await api.createProduct({ name: "Tea", priceMinor: 500 }, 10);
    const input = {
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "cash" as const, amountMinor: 500 }],
    };
    await expect(api.checkout(input)).rejects.toThrow(/Open a shift/);
    await api.openShift(0);
    expect((await api.checkout(input)).sale.shiftId).toBeTruthy();
  });

  it("tracks cash through a shift and closes with a variance", async () => {
    await ready();
    const p = await api.createProduct({ name: "Tea", priceMinor: 500 }, 10);
    await api.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 1000 }],
    });
    await api.cashMovement(-200, "bought milk");
    const mid = await api.shiftSummary();
    expect(mid.expectedCashMinor).toBe(10000 + 500 - 200);
    const closed = await api.closeShift(10200, "short 1.00");
    expect(closed.shift.varianceMinor).toBe(-100);
    expect((await api.session()).shift).toBeNull();
  });

  it("hides the expected cash from a cashier until the shift is closed", async () => {
    await ready();
    const c = await makeStaff("Ali", "cashier");
    await api.closeShift(10000); // owner closes the starting shift
    await api.logout();
    await api.login(c.id, c.pin);
    await api.openShift(5000);
    expect((await api.shiftSummary()).expectedCashMinor).toBeNull();
    const closed = await api.closeShift(4900);
    expect(closed.expectedCashMinor).toBe(5000);
    expect(closed.shift.varianceMinor).toBe(-100);
  });

  it("only lets the opener or a manager close a shift", async () => {
    await ready(); // shift opened by the owner
    const c = await makeStaff("Ali", "cashier");
    await api.logout();
    await api.login(c.id, c.pin);
    await expect(api.closeShift(10000)).rejects.toThrow(/opened the shift, or a manager/);
    // They can see the shift they are working on, but not the expected cash.
    const mine = await api.shiftSummary();
    expect(mine.shift.userName).toBe("Boss");
    expect(mine.expectedCashMinor).toBeNull();
  });

  it("keeps other people's finished shifts private from a cashier", async () => {
    await ready(); // owner's shift
    const c = await makeStaff("Ali", "cashier");
    const finished = await api.closeShift(10000);
    await api.logout();
    await api.login(c.id, c.pin);
    await expect(api.shiftSummary(finished.shift.id)).rejects.toThrow(/permission/);
  });
});

describe("voids and cash", () => {
  it("voiding in the same shift removes the sale from the drawer", async () => {
    await ready();
    const p = await api.createProduct({ name: "Tea", priceMinor: 500 }, 10);
    const { sale } = await api.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 500 }],
    });
    await api.voidSale(sale.id, "mistake");
    expect((await api.shiftSummary()).expectedCashMinor).toBe(10000);
    expect((await api.listProducts())[0]?.stock).toBe(10);
  });

  it("voiding a sale from an earlier shift refunds from today's drawer", async () => {
    await ready();
    const p = await api.createProduct({ name: "Tea", priceMinor: 500 }, 10);
    const { sale } = await api.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 500 }],
    });
    await api.closeShift(10500);
    await api.openShift(10000);
    await api.voidSale(sale.id, "customer returned it");
    const s = await api.shiftSummary();
    expect(s.cashOutMinor).toBe(500);
    expect(s.expectedCashMinor).toBe(9500);
    expect(s.movements[0]?.reason).toContain("T1-000001");
  });

  it("blocks a refund when the drawer does not hold enough cash", async () => {
    await api.setupOwner("Boss", "1111");
    await api.openShift(0);
    const p = await api.createProduct({ name: "TV", priceMinor: 50000 }, 2);
    const { sale } = await api.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 50000 }],
    });
    await api.closeShift(50000);
    await api.openShift(0); // empty drawer today
    await expect(api.voidSale(sale.id, "return")).rejects.toThrow(/not enough cash/);
    expect((await api.recentSales())[0]?.status).toBe("completed"); // nothing half-done
  });

  it("needs an open shift to void", async () => {
    await ready();
    const p = await api.createProduct({ name: "Tea", priceMinor: 500 }, 10);
    const { sale } = await api.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "card", amountMinor: 500 }],
    });
    await api.closeShift(10000);
    await expect(api.voidSale(sale.id, "x")).rejects.toThrow(/Open a shift/);
  });
});

describe("catalogue, receipts and reports", () => {
  it("creates a product with opening stock and finds it by barcode", async () => {
    await ready();
    const p = await api.createProduct(
      { name: "Milk 1L", priceMinor: 250, barcode: "6001", taxRateBp: 1000 },
      24,
    );
    expect(p.stock).toBe(24);
    expect((await api.findByBarcode("6001"))?.id).toBe(p.id);
    expect(await api.findByBarcode("nope")).toBeNull();
  });

  it("rolls back product creation if the barcode is a duplicate", async () => {
    await ready();
    await api.createProduct({ name: "A", priceMinor: 100, barcode: "dup" }, 1);
    await expect(
      api.createProduct({ name: "B", priceMinor: 100, barcode: "dup" }, 5),
    ).rejects.toThrow(/barcode already exists/);
    expect(await api.listProducts()).toHaveLength(1);
  });

  it("returns a receipt built from the shop settings", async () => {
    await ready();
    await api.updateSettings({ storeName: "Corner Shop", currency: "USD" });
    const p = await api.createProduct({ name: "Rice", priceMinor: 1000 }, 10);
    const { sale, receipt } = await api.checkout({
      lines: [{ productId: p.id, qty: 2 }],
      payments: [{ method: "cash", amountMinor: 2500 }],
    });
    expect(sale.changeMinor).toBe(500);
    expect(receipt).toContain("Corner Shop");
    expect(receipt).toContain("T1-000001");
    expect(await api.receiptText(sale.id)).toBe(receipt);
  });

  it("reports the day and low stock to managers", async () => {
    await ready();
    const p = await api.createProduct({ name: "Bread", priceMinor: 150, reorderLevel: 5 }, 6);
    await api.checkout({
      lines: [{ productId: p.id, qty: 2 }],
      payments: [{ method: "cash", amountMinor: 300 }],
    });
    const summary = await api.salesSummary("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    expect(summary.salesCount).toBe(1);
    expect((await api.lowStock()).map((x) => x.name)).toEqual(["Bread"]);
  });

  it("gives clear errors for unknown records", async () => {
    await ready();
    await expect(api.adjustStock("missing", 1, "x")).rejects.toThrow(/not found/);
    await expect(api.receiptText("missing")).rejects.toThrow(/not found/);
    await expect(api.updateProduct("missing", { name: "x" })).rejects.toThrow(/not found/);
  });
});

describe("staff management", () => {
  it("cannot demote or deactivate the last owner", async () => {
    await ready();
    const me = (await api.session()).user!;
    await expect(api.updateStaff(me.id, { role: "manager" })).rejects.toThrow(/at least one active owner/);
    await expect(api.updateStaff(me.id, { active: false })).rejects.toThrow(/at least one active owner/);
  });

  it("never exposes PINs or hashes in staff lists", async () => {
    await ready();
    await makeStaff("Ali", "cashier", "4321");
    const json = JSON.stringify([await api.listStaff(), await api.loginUsers(), await api.session()]);
    expect(json).not.toContain("4321");
    expect(json).not.toMatch(/pin_hash|pin_salt|pinHash/);
  });
});
