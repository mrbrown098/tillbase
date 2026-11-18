import {
  InventoryService,
  ProductService,
  ReportService,
  SaleService,
  SettingsService,
  formatReceipt,
  type Db,
  type Sale,
} from "@tillbase/core";
import type { CheckoutResult, ProductWithStock, TillbaseApi } from "../shared/api.js";

/**
 * The real implementation of the app's API. It has no Electron imports, so it
 * can be tested directly against an in-memory database.
 */
export function createHandlers(db: Db, receiptPrefix = "T1"): TillbaseApi {
  const products = new ProductService(db);
  const inventory = new InventoryService(db);
  const sales = new SaleService(db, receiptPrefix);
  const reports = new ReportService(db);
  const settings = new SettingsService(db);

  const withStock = (list: ReturnType<ProductService["list"]>): ProductWithStock[] => {
    const levels = inventory.stockLevels();
    return list.map((p) => ({ ...p, stock: levels[p.id] ?? 0 }));
  };
  const one = (id: string): ProductWithStock => {
    const p = products.get(id);
    if (!p) throw new Error("Product not found");
    return { ...p, stock: inventory.stockOf(id) };
  };
  const receipt = (sale: Sale): string => {
    const s = settings.get();
    return formatReceipt(sale, {
      storeName: s.storeName,
      currency: s.currency,
      locale: s.locale,
      width: s.receiptWidth,
      footer: s.receiptFooter,
    });
  };

  return {
    async listProducts() {
      return withStock(products.list());
    },
    async searchProducts(query) {
      return query.trim() ? withStock(products.search(query)) : withStock(products.list());
    },
    async findByBarcode(barcode) {
      const p = products.findByBarcode(barcode);
      return p ? one(p.id) : null;
    },
    async createProduct(input, openingStock) {
      const created = db.transaction(() => {
        const p = products.create(input);
        if (openingStock !== undefined && openingStock !== 0) {
          inventory.adjust(p.id, openingStock, "opening stock");
        }
        return p;
      })();
      return one(created.id);
    },
    async updateProduct(id, patch) {
      products.update(id, patch);
      return one(id);
    },
    async adjustStock(productId, qtyDelta, reason) {
      if (!products.get(productId)) throw new Error("Product not found");
      inventory.adjust(productId, qtyDelta, reason);
    },
    async lowStock() {
      return inventory.lowStock();
    },
    async checkout(input): Promise<CheckoutResult> {
      const sale = sales.checkout(input);
      return { sale, receipt: receipt(sale) };
    },
    async recentSales(limit = 50) {
      return sales.recent(limit);
    },
    async voidSale(saleId, reason) {
      return sales.voidSale(saleId, reason);
    },
    async receiptText(saleId) {
      const sale = sales.get(saleId);
      if (!sale) throw new Error("Sale not found");
      return receipt(sale);
    },
    async salesSummary(from, to) {
      return reports.salesSummary(from, to, 5);
    },
    async getSettings() {
      return settings.get();
    },
    async updateSettings(patch) {
      return settings.update(patch);
    },
  };
}
