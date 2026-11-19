import type {
  CheckoutInput,
  LowStockItem,
  NewProduct,
  Permission,
  Product,
  ProductPatch,
  Role,
  Sale,
  SalesSummary,
  Shift,
  ShiftSummary,
  ShopSettings,
  User,
} from "@tillbase/core";

export type ProductWithStock = Product & { stock: number };

export interface CheckoutResult {
  sale: Sale;
  receipt: string;
}

/** Who is signed in, what they may do, and whether a shift is open. */
export interface SessionInfo {
  /** True on first run, before any staff account exists. */
  needsSetup: boolean;
  user: Pick<User, "id" | "name" | "role"> | null;
  permissions: Permission[];
  shift: Shift | null;
}

/**
 * Shift totals. People without the `reports.view` permission get
 * `expectedCashMinor: null` while the shift is open, so they count the drawer
 * "blind" instead of counting up to a number they were shown.
 */
export type ShiftSummaryView = Omit<ShiftSummary, "expectedCashMinor"> & {
  expectedCashMinor: number | null;
};

export type StaffInput = { name: string; pin: string; role: Role };

/**
 * Everything the user interface may ask the app to do. The main process
 * implements it over @tillbase/core and checks the signed-in user's
 * permissions on every call; the preload script exposes it to the page as
 * `window.tillbase`. Every method rejects with a plain Error whose message is
 * safe to show to the cashier.
 */
export interface TillbaseApi {
  // Session (usable before signing in)
  session(): Promise<SessionInfo>;
  loginUsers(): Promise<Pick<User, "id" | "name" | "role">[]>;
  setupOwner(name: string, pin: string): Promise<SessionInfo>;
  login(userId: string, pin: string): Promise<SessionInfo>;
  logout(): Promise<SessionInfo>;
  getSettings(): Promise<ShopSettings>;

  // Selling
  listProducts(): Promise<ProductWithStock[]>;
  searchProducts(query: string): Promise<ProductWithStock[]>;
  findByBarcode(barcode: string): Promise<ProductWithStock | null>;
  checkout(input: Omit<CheckoutInput, "shiftId" | "userId" | "cashier">): Promise<CheckoutResult>;
  recentSales(limit?: number): Promise<Sale[]>;
  receiptText(saleId: string): Promise<string>;
  voidSale(saleId: string, reason: string): Promise<Sale>;

  // Shifts and cash
  openShift(openingCashMinor: number): Promise<SessionInfo>;
  shiftSummary(shiftId?: string): Promise<ShiftSummaryView>;
  cashMovement(amountMinor: number, reason: string): Promise<ShiftSummaryView>;
  closeShift(countedCashMinor: number, note?: string): Promise<ShiftSummaryView>;
  recentShifts(): Promise<Shift[]>;

  // Catalogue and stock
  createProduct(input: NewProduct, openingStock?: number): Promise<ProductWithStock>;
  updateProduct(id: string, patch: ProductPatch): Promise<ProductWithStock>;
  adjustStock(productId: string, qtyDelta: number, reason: string): Promise<void>;
  lowStock(): Promise<LowStockItem[]>;

  // Reports and settings
  salesSummary(from: string, to: string): Promise<SalesSummary>;
  updateSettings(patch: Partial<ShopSettings>): Promise<ShopSettings>;

  // Staff
  listStaff(): Promise<User[]>;
  createStaff(input: StaffInput): Promise<User>;
  updateStaff(id: string, patch: { name?: string; role?: Role; active?: boolean }): Promise<User>;
  resetPin(userId: string, newPin: string): Promise<void>;
  changeOwnPin(currentPin: string, newPin: string): Promise<void>;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** The IPC channel names, one per API method. */
export const channels: (keyof TillbaseApi)[] = [
  "session",
  "loginUsers",
  "setupOwner",
  "login",
  "logout",
  "getSettings",
  "listProducts",
  "searchProducts",
  "findByBarcode",
  "checkout",
  "recentSales",
  "receiptText",
  "voidSale",
  "openShift",
  "shiftSummary",
  "cashMovement",
  "closeShift",
  "recentShifts",
  "createProduct",
  "updateProduct",
  "adjustStock",
  "lowStock",
  "salesSummary",
  "updateSettings",
  "listStaff",
  "createStaff",
  "updateStaff",
  "resetPin",
  "changeOwnPin",
];
