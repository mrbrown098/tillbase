import type {
  CheckoutInput,
  LowStockItem,
  NewProduct,
  Product,
  ProductPatch,
  Sale,
  SalesSummary,
  ShopSettings,
} from "@tillbase/core";

export type ProductWithStock = Product & { stock: number };

export interface CheckoutResult {
  sale: Sale;
  receipt: string;
}

/**
 * Everything the user interface may ask the app to do. The main process
 * implements it over @tillbase/core; the preload script exposes it to the
 * page as `window.tillbase`. Every method rejects with a plain Error whose
 * message is safe to show to the cashier.
 */
export interface TillbaseApi {
  listProducts(): Promise<ProductWithStock[]>;
  searchProducts(query: string): Promise<ProductWithStock[]>;
  findByBarcode(barcode: string): Promise<ProductWithStock | null>;
  createProduct(input: NewProduct, openingStock?: number): Promise<ProductWithStock>;
  updateProduct(id: string, patch: ProductPatch): Promise<ProductWithStock>;
  adjustStock(productId: string, qtyDelta: number, reason: string): Promise<void>;
  lowStock(): Promise<LowStockItem[]>;
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
  recentSales(limit?: number): Promise<Sale[]>;
  voidSale(saleId: string, reason: string): Promise<Sale>;
  receiptText(saleId: string): Promise<string>;
  salesSummary(from: string, to: string): Promise<SalesSummary>;
  getSettings(): Promise<ShopSettings>;
  updateSettings(patch: Partial<ShopSettings>): Promise<ShopSettings>;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The IPC channel names, one per API method. */
export const channels: (keyof TillbaseApi)[] = [
  "listProducts",
  "searchProducts",
  "findByBarcode",
  "createProduct",
  "updateProduct",
  "adjustStock",
  "lowStock",
  "checkout",
  "recentSales",
  "voidSale",
  "receiptText",
  "salesSummary",
  "getSettings",
  "updateSettings",
];
