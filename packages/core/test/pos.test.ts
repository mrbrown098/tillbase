import { beforeEach, describe, expect, it } from "vitest";
import {
  InventoryService,
  ProductService,
  ReportService,
  SaleService,
  SettingsService,
  formatReceipt,
  openDatabase,
  taxFor,
  toMinor,
  type Db,
} from "../src/index.js";

let db: Db;
let products: ProductService;
let inventory: InventoryService;
let sales: SaleService;
let reports: ReportService;

beforeEach(() => {
  db = openDatabase(":memory:");
  products = new ProductService(db);
  inventory = new InventoryService(db);
  sales = new SaleService(db, "T1");
  reports = new ReportService(db);
});

function stocked(name: string, price: number, qty: number, taxRateBp = 0) {
  const p = products.create({
    name,
    priceMinor: price,
    taxRateBp,
    barcode: `bc-${name}`,
  });
  inventory.adjust(p.id, qty, "purchase");
  return p;
}

describe("money", () => {
  it("converts and taxes in integer minor units", () => {
    expect(toMinor(12.5)).toBe(1250);
    expect(taxFor(1000, 1800)).toBe(180);
    expect(taxFor(333, 1800)).toBe(60); // 59.94 rounds to 60
  });
});

describe("products", () => {
  it("creates, finds by barcode and searches", () => {
    const p = products.create({ name: "Milk 1L", priceMinor: 250, barcode: "123" });
    expect(products.findByBarcode("123")?.id).toBe(p.id);
    expect(products.search("milk")).toHaveLength(1);
    expect(products.search("zzz")).toHaveLength(0);
  });

  it("rejects duplicate barcodes and bad input", () => {
    products.create({ name: "A", priceMinor: 100, barcode: "dup" });
    expect(() => products.create({ name: "B", priceMinor: 100, barcode: "dup" })).toThrow(
      /barcode already exists/,
    );
    expect(() => products.create({ name: " ", priceMinor: 100 })).toThrow(/name/);
    expect(() => products.create({ name: "C", priceMinor: 1.5 })).toThrow(/integer/);
  });

  it("allows several products without a barcode", () => {
    products.create({ name: "Loose A", priceMinor: 100 });
    products.create({ name: "Loose B", priceMinor: 100 });
    expect(products.list()).toHaveLength(2);
  });

  it("hides inactive products from search and scanning", () => {
    const p = products.create({ name: "Old", priceMinor: 100, barcode: "old" });
    products.update(p.id, { active: false });
    expect(products.findByBarcode("old")).toBeUndefined();
    expect(products.search("old")).toHaveLength(0);
  });
});

describe("checkout", () => {
  it("prices, taxes, takes payment, gives change and removes stock", () => {
    const rice = stocked("Rice", 1000, 10, 1000); // 10% tax
    const sale = sales.checkout({
      lines: [{ productId: rice.id, qty: 2 }],
      payments: [{ method: "cash", amountMinor: 3000 }],
      cashier: "Ali",
    });
    expect(sale.receiptNo).toBe("T1-000001");
    expect(sale.subtotalMinor).toBe(2000);
    expect(sale.taxMinor).toBe(200);
    expect(sale.totalMinor).toBe(2200);
    expect(sale.changeMinor).toBe(800);
    expect(inventory.stockOf(rice.id)).toBe(8);
  });

  it("applies line discounts before tax", () => {
    const p = stocked("Soap", 500, 5, 1000);
    const sale = sales.checkout({
      lines: [{ productId: p.id, qty: 2, discountMinor: 100 }],
      payments: [{ method: "card", amountMinor: 990 }],
    });
    // gross 1000 - 100 = 900, tax 90, total 990
    expect(sale.totalMinor).toBe(990);
    expect(sale.changeMinor).toBe(0);
  });

  it("supports split payments", () => {
    const p = stocked("TV", 10000, 1);
    const sale = sales.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [
        { method: "card", amountMinor: 6000 },
        { method: "cash", amountMinor: 4000 },
      ],
    });
    expect(sale.payments).toHaveLength(2);
    expect(sale.changeMinor).toBe(0);
  });

  it("numbers receipts in sequence", () => {
    const p = stocked("Gum", 100, 10);
    const pay = [{ method: "cash" as const, amountMinor: 100 }];
    const a = sales.checkout({ lines: [{ productId: p.id, qty: 1 }], payments: pay });
    const b = sales.checkout({ lines: [{ productId: p.id, qty: 1 }], payments: pay });
    expect([a.receiptNo, b.receiptNo]).toEqual(["T1-000001", "T1-000002"]);
  });

  it("refuses short payment and saves nothing", () => {
    const p = stocked("Pen", 300, 5);
    expect(() =>
      sales.checkout({
        lines: [{ productId: p.id, qty: 1 }],
        payments: [{ method: "cash", amountMinor: 100 }],
      }),
    ).toThrow(/short/);
    expect(inventory.stockOf(p.id)).toBe(5);
    expect(db.prepare("SELECT COUNT(*) c FROM sales").get()).toEqual({ c: 0 });
  });

  it("refuses overselling and rolls back the whole cart", () => {
    const a = stocked("A", 100, 5);
    const b = stocked("B", 100, 1);
    expect(() =>
      sales.checkout({
        lines: [
          { productId: a.id, qty: 2 },
          { productId: b.id, qty: 3 },
        ],
        payments: [{ method: "cash", amountMinor: 10000 }],
      }),
    ).toThrow(/Not enough stock for B/);
    expect(inventory.stockOf(a.id)).toBe(5);
    expect(inventory.stockOf(b.id)).toBe(1);
  });

  it("allows overselling when explicitly enabled", () => {
    const p = stocked("Rare", 100, 1);
    sales.checkout({
      lines: [{ productId: p.id, qty: 3 }],
      payments: [{ method: "cash", amountMinor: 300 }],
      allowNegativeStock: true,
    });
    expect(inventory.stockOf(p.id)).toBe(-2);
  });

  it("does not move stock for untracked items", () => {
    const svc = products.create({ name: "Gift wrap", priceMinor: 200, trackStock: false });
    sales.checkout({
      lines: [{ productId: svc.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 200 }],
    });
    expect(inventory.stockOf(svc.id)).toBe(0);
  });

  it("only gives change from cash", () => {
    const p = stocked("Cup", 500, 5);
    expect(() =>
      sales.checkout({
        lines: [{ productId: p.id, qty: 1 }],
        payments: [{ method: "card", amountMinor: 700 }],
      }),
    ).toThrow(/cash/);
  });

  it("rejects empty carts, bad quantities and inactive products", () => {
    const p = stocked("Dead", 100, 5);
    const pay = [{ method: "cash" as const, amountMinor: 1000 }];
    expect(() => sales.checkout({ lines: [], payments: pay })).toThrow(/empty/);
    expect(() =>
      sales.checkout({ lines: [{ productId: p.id, qty: 0 }], payments: pay }),
    ).toThrow(/Quantity/);
    products.update(p.id, { active: false });
    expect(() =>
      sales.checkout({ lines: [{ productId: p.id, qty: 1 }], payments: pay }),
    ).toThrow(/inactive/);
  });
});

describe("void", () => {
  it("restores stock and cannot be repeated", () => {
    const p = stocked("Tea", 400, 10);
    const sale = sales.checkout({
      lines: [{ productId: p.id, qty: 4 }],
      payments: [{ method: "cash", amountMinor: 1600 }],
    });
    expect(inventory.stockOf(p.id)).toBe(6);
    const voided = sales.voidSale(sale.id, "customer returned");
    expect(voided.status).toBe("void");
    expect(inventory.stockOf(p.id)).toBe(10);
    expect(() => sales.voidSale(sale.id, "again")).toThrow(/already void/);
    expect(() => sales.voidSale(sale.id, " ")).toThrow(/reason/);
  });
});

describe("inventory", () => {
  it("lists low stock items", () => {
    const p = products.create({ name: "Bread", priceMinor: 150, reorderLevel: 5 });
    inventory.adjust(p.id, 4, "purchase");
    stocked("Plenty", 100, 100);
    const low = inventory.lowStock();
    expect(low.map((x) => x.name)).toEqual(["Bread"]);
  });

  it("rejects zero adjustments", () => {
    const p = stocked("Z", 100, 1);
    expect(() => inventory.adjust(p.id, 0, "x")).toThrow(/non-zero/);
  });
});

describe("stock levels, recent sales and settings", () => {
  it("returns stock for all products at once", () => {
    const a = stocked("A", 100, 7);
    const b = stocked("B", 100, 3);
    sales.checkout({
      lines: [{ productId: a.id, qty: 2 }],
      payments: [{ method: "cash", amountMinor: 200 }],
    });
    expect(inventory.stockLevels()).toEqual({ [a.id]: 5, [b.id]: 3 });
  });

  it("lists recent sales newest first, including voids", () => {
    const p = stocked("P", 100, 10);
    const pay = [{ method: "cash" as const, amountMinor: 100 }];
    const s1 = sales.checkout({ lines: [{ productId: p.id, qty: 1 }], payments: pay });
    const s2 = sales.checkout({ lines: [{ productId: p.id, qty: 1 }], payments: pay });
    sales.voidSale(s1.id, "oops");
    const recent = sales.recent();
    expect(recent.map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(recent[1]?.status).toBe("void");
    expect(sales.recent(1)).toHaveLength(1);
  });

  it("stores and validates settings", () => {
    const settings = new SettingsService(db);
    expect(settings.get().storeName).toBe("My Shop");
    const next = settings.update({ storeName: "  Corner Shop ", currency: "pkr" });
    expect(next.storeName).toBe("Corner Shop");
    expect(next.currency).toBe("PKR");
    expect(settings.get().receiptWidth).toBe(32);
    expect(() => settings.update({ storeName: " " })).toThrow(/Store name/);
    expect(() => settings.update({ currency: "DOLLARS" })).toThrow(/Currency/);
    expect(() => settings.update({ receiptWidth: 5 })).toThrow(/width/);
  });
});

describe("reports and receipts", () => {
  it("summarises sales, voids and payment methods", () => {
    const a = stocked("Apple", 100, 50);
    const pay = (n: number) => [{ method: "cash" as const, amountMinor: n }];
    sales.checkout({ lines: [{ productId: a.id, qty: 3 }], payments: pay(500) }); // total 300, change 200
    const s2 = sales.checkout({
      lines: [{ productId: a.id, qty: 2 }],
      payments: [{ method: "card", amountMinor: 200 }],
    });
    const s3 = sales.checkout({ lines: [{ productId: a.id, qty: 1 }], payments: pay(100) });
    sales.voidSale(s3.id, "mistake");

    const r = reports.salesSummary("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    expect(r.salesCount).toBe(2);
    expect(r.voidCount).toBe(1);
    expect(r.totalMinor).toBe(500);
    expect(r.byMethod).toEqual({ cash: 300, card: 200 });
    expect(r.topProducts[0]).toMatchObject({ name: "Apple", qty: 5 });
    expect(s2.status).toBe("completed");
  });

  it("prints the receipt time in local time, not UTC", () => {
    const p = stocked("Clock", 100, 1);
    const sale = sales.checkout({
      lines: [{ productId: p.id, qty: 1 }],
      payments: [{ method: "cash", amountMinor: 100 }],
    });
    const d = new Date("2026-11-18T12:25:00.000Z");
    const p2 = (n: number) => String(n).padStart(2, "0");
    const expected = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const text = formatReceipt(
      { ...sale, createdAt: "2026-11-18T12:25:00.000Z" },
      { storeName: "Shop" },
    );
    expect(text).toContain(`Date:    ${expected}`);
  });

  it("prints a readable receipt", () => {
    const p = stocked("Coffee", 450, 10, 1000);
    const sale = sales.checkout({
      lines: [{ productId: p.id, qty: 2 }],
      payments: [{ method: "cash", amountMinor: 1000 }],
      cashier: "Sara",
    });
    const text = formatReceipt(sale, { storeName: "Corner Cafe" });
    expect(text).toContain("Corner Cafe");
    expect(text).toContain("T1-000001");
    expect(text).toContain("TOTAL");
    expect(text).toContain("$9.90");
    expect(text).toContain("Change");
  });
});
