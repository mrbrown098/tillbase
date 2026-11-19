import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { backupDatabase, openDatabase, type Db } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { TillbaseApi } from "../shared/api";

let api: TillbaseApi;
let db: Db;
const day = () => new Date().toLocaleDateString("sv"); // YYYY-MM-DD in local time

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
  db = openDatabase(":memory:");
  api = createHandlers(db, "T1", () => 1_000_000);
  await api.setupOwner("Boss", "1111");
});

describe("who may see money", () => {
  it("keeps profit and payroll from managers, and everything from cashiers", async () => {
    await as("Mgr", "manager");
    await expect(api.profitAndLoss(day(), day())).rejects.toThrow(/permission/);
    await expect(api.listEmployees()).rejects.toThrow(/permission/);
    await expect(api.runPayroll(day(), day())).rejects.toThrow(/permission/);
    await expect(api.backupNow()).rejects.toThrow(/permission/);
    expect(await api.expenseCategories()).toHaveLength(12); // managers do record costs
    expect(await api.roster()).toEqual([]);

    await as("Till", "cashier");
    await expect(api.expenseCategories()).rejects.toThrow(/permission/);
    await expect(api.recordPurchase({ items: [] })).rejects.toThrow(/permission/);
    await expect(api.roster()).rejects.toThrow(/permission/);
    await expect(api.listItems()).rejects.toThrow(/permission/);
  });

  it("lets the owner see the P&L and roster without pay details", async () => {
    await api.createEmployee({ name: "Ali", payType: "hourly", payRateMinor: 10_000 });
    await as("Mgr", "manager");
    const roster = await api.roster();
    expect(roster).toEqual([{ id: expect.any(String), name: "Ali", clockedIn: false, since: null }]);
    expect(JSON.stringify(roster)).not.toContain("10000");
  });
});

describe("paying from the drawer", () => {
  it("takes cash out of the open shift for a purchase, an expense, an advance and wages", async () => {
    await api.openShift(500_000);
    const flour = await api.createProduct({ name: "Flour", kind: "ingredient", unit: "kg", priceMinor: 0 });
    await api.recordPurchase({ items: [{ productId: flour.id, qty: 10, costMinor: 100_000 }], paidMinor: 100_000, supplier: "Mill" }, true);
    const cat = (await api.expenseCategories())[0]!;
    await api.addExpense({ categoryId: cat.id, description: "Gas cylinder", amountMinor: 20_000 }, true);
    const e = await api.createEmployee({ name: "Ali", payType: "daily", payRateMinor: 50_000 });
    await api.giveAdvance(e.id, 10_000, "advance", true);
    const now = new Date();
    await api.addShiftRecord(e.id, new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9).toISOString(), new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17).toISOString());
    const [slip] = await api.runPayroll(day(), day(), [{ employeeId: e.id, recoverAdvanceMinor: 10_000 }]);
    expect(slip!.netMinor).toBe(40_000);
    await api.payPayslip(slip!.id, "cash", true);

    const s = await api.shiftSummary();
    // 500,000 float - 100,000 - 20,000 - 10,000 - 40,000
    expect(s.expectedCashMinor).toBe(330_000);
  });

  it("refuses and saves nothing when the drawer is short or no shift is open", async () => {
    const cat = (await api.expenseCategories())[0]!;
    await expect(api.addExpense({ categoryId: cat.id, description: "x", amountMinor: 100 }, true)).rejects.toThrow(/Open a shift/);
    expect(await api.listExpenses(day(), day())).toHaveLength(0);

    await api.openShift(5_000);
    await expect(api.addExpense({ categoryId: cat.id, description: "x", amountMinor: 6_000 }, true)).rejects.toThrow(/not enough cash/);
    expect(await api.listExpenses(day(), day())).toHaveLength(0);

    // Without fromDrawer (paid by card, or from the owner's pocket) no shift is needed.
    await api.addExpense({ categoryId: cat.id, description: "x", amountMinor: 6_000 });
    expect((await api.shiftSummary()).expectedCashMinor).toBe(5_000);
  });
});

describe("end to end through the API", () => {
  it("menu item with a recipe sells, and the P&L shows the cost", async () => {
    await api.openShift(0);
    const chicken = await api.createProduct({ name: "Chicken", kind: "ingredient", unit: "kg", priceMinor: 0 });
    await api.recordPurchase({ items: [{ productId: chicken.id, qty: 10, costMinor: 800_000 }], paidMinor: 800_000 }, false);
    const burger = await api.createProduct({ name: "Burger", priceMinor: 45_000, trackStock: false });
    await api.setRecipe(burger.id, [{ ingredientId: chicken.id, qty: 0.15 }]);
    expect((await api.recipeCosts())[burger.id]).toBe(12_000);
    expect((await api.listProducts()).map((p) => p.name)).toEqual(["Burger"]); // ingredients are not on the till
    expect((await api.listItems("ingredient")).map((p) => p.name)).toEqual(["Chicken"]);

    await api.checkout({ lines: [{ productId: burger.id, qty: 2 }], payments: [{ method: "card", amountMinor: 90_000 }] });
    const pl = await api.profitAndLoss(day(), day());
    expect(pl.netSalesMinor).toBe(90_000);
    expect(pl.cogsMinor).toBe(24_000);
    expect(pl.grossProfitMinor).toBe(66_000);
    expect((await api.payables()).totalMinor).toBe(0);
  });
});

describe("backups", () => {
  it("writes a dated copy that opens as a real database, and keeps only the newest few", async () => {
    await api.openShift(1_234);
    const dir = mkdtempSync(join(tmpdir(), "tillbase-bk-"));
    const file = await backupDatabase(db, dir, 2);
    const copy = openDatabase(file);
    expect((copy.prepare("SELECT opening_cash_minor AS c FROM shifts").get() as { c: number }).c).toBe(1_234);
    copy.close();
    // Old copies are pruned
    for (const d of ["2020-01-01", "2020-01-02", "2020-01-03"]) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, `tillbase-${d}.sqlite`), "x");
    }
    await backupDatabase(db, dir, 2);
    expect(readdirSync(dir).sort()).toEqual([`tillbase-2020-01-03.sqlite`, file.split("/").pop()!].sort());
  });

  it("owner can trigger a backup through the API", async () => {
    const calls: string[] = [];
    const a = createHandlers(openDatabase(":memory:"), "T1", () => 1, { backup: async () => (calls.push("x"), "/tmp/b.sqlite") });
    await a.setupOwner("Boss", "1111");
    expect(await a.backupNow()).toBe("/tmp/b.sqlite");
    expect(calls).toHaveLength(1);
  });
});
