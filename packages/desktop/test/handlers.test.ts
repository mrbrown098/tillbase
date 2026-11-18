import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { TillbaseApi } from "../shared/api";

let api: TillbaseApi;

beforeEach(() => {
  api = createHandlers(openDatabase(":memory:"), "T1");
});

describe("desktop API", () => {
  it("creates a product with opening stock and finds it by barcode", async () => {
    const p = await api.createProduct(
      { name: "Milk 1L", priceMinor: 250, barcode: "6001", taxRateBp: 1000 },
      24,
    );
    expect(p.stock).toBe(24);
    expect((await api.findByBarcode("6001"))?.id).toBe(p.id);
    expect(await api.findByBarcode("nope")).toBeNull();
  });

  it("rolls back product creation if opening stock fails", async () => {
    await api.createProduct({ name: "A", priceMinor: 100, barcode: "dup" }, 1);
    await expect(
      api.createProduct({ name: "B", priceMinor: 100, barcode: "dup" }, 5),
    ).rejects.toThrow(/barcode already exists/);
    expect(await api.listProducts()).toHaveLength(1);
  });

  it("checks out and returns a receipt using shop settings", async () => {
    await api.updateSettings({ storeName: "Corner Shop", currency: "USD" });
    const p = await api.createProduct({ name: "Rice", priceMinor: 1000 }, 10);
    const { sale, receipt } = await api.checkout({
      lines: [{ productId: p.id, qty: 2 }],
      payments: [{ method: "cash", amountMinor: 2500 }],
    });
    expect(sale.totalMinor).toBe(2000);
    expect(sale.changeMinor).toBe(500);
    expect(receipt).toContain("Corner Shop");
    expect(receipt).toContain("T1-000001");
    expect((await api.listProducts())[0]?.stock).toBe(8);
    expect(await api.receiptText(sale.id)).toBe(receipt);
  });

  it("voids a sale and restores stock", async () => {
    const p = await api.createProduct({ name: "Tea", priceMinor: 400 }, 5);
    const { sale } = await api.checkout({
      lines: [{ productId: p.id, qty: 3 }],
      payments: [{ method: "card", amountMinor: 1200 }],
    });
    await api.voidSale(sale.id, "returned");
    expect((await api.listProducts())[0]?.stock).toBe(5);
    expect((await api.recentSales())[0]?.status).toBe("void");
  });

  it("reports today's summary and low stock", async () => {
    const p = await api.createProduct({ name: "Bread", priceMinor: 150, reorderLevel: 5 }, 6);
    await api.checkout({
      lines: [{ productId: p.id, qty: 2 }],
      payments: [{ method: "cash", amountMinor: 300 }],
    });
    const summary = await api.salesSummary("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    expect(summary.salesCount).toBe(1);
    expect(summary.byMethod.cash).toBe(300);
    expect((await api.lowStock()).map((x) => x.name)).toEqual(["Bread"]);
  });

  it("gives clear errors for unknown products", async () => {
    await expect(api.adjustStock("missing", 1, "x")).rejects.toThrow(/not found/);
    await expect(api.receiptText("missing")).rejects.toThrow(/not found/);
    await expect(api.updateProduct("missing", { name: "x" })).rejects.toThrow(/not found/);
  });

  it("searches and lists all products when the query is empty", async () => {
    await api.createProduct({ name: "Apple", priceMinor: 100 });
    await api.createProduct({ name: "Banana", priceMinor: 100 });
    expect(await api.searchProducts("")).toHaveLength(2);
    expect((await api.searchProducts("ban")).map((x) => x.name)).toEqual(["Banana"]);
  });
});
