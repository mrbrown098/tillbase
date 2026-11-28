import type { AdView } from "../electron/ads.js";
import type { UpdateInfo } from "../electron/updates.js";
import type {
  BackupStatus,
  BackupWhere,
  AttendanceRecord,
  KitchenStatus,
  KitchenTicket,
  Modifier,
  ModifierInput,
  Order,
  Customer,
  CustomerHistory,
  Debtor,
  Statement,
  CustomerInput,
  LedgerEntry,
  LoyaltyConfig,
  OrderInput,
  PaymentInput,
  PrinterConfig,
  BusinessProfile,
  BusinessProfilePatch,
  CheckoutInput,
  Employee,
  EmployeeInput,
  Expense,
  ExpenseCategory,
  ExpenseInput,
  ImportIssue,
  ImportRowResult,
  PayMethod,
  Payables,
  Payslip,
  PayslipLineInput,
  PayrollPreviewLine,
  ProfitAndLoss,
  Purchase,
  PurchaseInput,
  PurchaseOrder,
  PurchaseOrderInput,
  PurchaseOrderStatus,
  ReceiveInput,
  SupplierStatement,
  Recipe,
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
  user: Pick<User, "id" | "name" | "role" | "pinLength"> | null;
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

/** Stock and menu items. "all" lists both kinds. */
export type ItemKind = "product" | "ingredient" | "all";

/** Someone who can be clocked in or out. Pay details are left out on purpose. */
export interface RosterEntry {
  id: string;
  name: string;
  clockedIn: boolean;
  since: string | null;
}

export type StaffInput = { name: string; pin: string; role: Role };

/** A .csv file the person picked in the open dialog. The main process read it; the page never sees a path. */
export interface ProductCsvFile {
  name: string;
  text: string;
}

/** The choices on the import screen. Anything left out takes the safe default. */
export interface ProductCsvOptions {
  /** Change items that are already in Tillbase. Default true. */
  updateExisting?: boolean;
  /** Also correct stock counts of items already in Tillbase. Default false. */
  fixStock?: boolean;
  /** Save the good rows and skip the bad ones. Default false: one bad row means nothing is saved. */
  skipBadRows?: boolean;
}

/** What a preview says would happen, or what an import did. Row numbers count the header as row 1. */
export interface ProductCsvReport {
  /** True for a preview. */
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  stockAdjustments: number;
  rows: ImportRowResult[];
  issues: ImportIssue[];
  /** True when nothing was saved (a preview, or an import that was refused or rolled back). */
  nothingWritten: boolean;
}

// ---------------------------------------------------------------------------------------------------------
// Contract for the first-customer backend work (refunds, audit trail, day-close report, bank transfer).
// These are types only. The API methods that use them are added, with their handlers and tests, in the
// pull request that builds each feature, so nothing here can be called yet. Money is integer minor units.
// ---------------------------------------------------------------------------------------------------------

/** How money is handed back on a refund. Wallet and account (khata) sales cannot be part-refunded. */
export type RefundMethod = "cash" | "card" | "bank_transfer" | "other";

/** One line of a refund: a line of the original sale and how much of it comes back. */
export interface RefundLineInput {
  saleItemId: string;
  /** Quantity coming back. Must be above 0 and no more than what is left unrefunded on that line. */
  qty: number;
}

export interface RefundInput {
  saleId: string;
  lines: RefundLineInput[];
  /** Required. Shown in the audit trail and the day-close report. */
  reason: string;
  /** Put the goods back in stock (at the cost they were sold at). False when they cannot be resold. */
  restock: boolean;
  method: RefundMethod;
  /** For a bank transfer: the transaction number or note. */
  reference?: string | null;
  /** Created by the screen once per attempt, so a double click cannot refund twice. */
  requestId?: string;
}

export interface RefundLine {
  saleItemId: string;
  productId: string;
  name: string;
  qty: number;
  /** What this line returns to the customer, tax included. */
  amountMinor: number;
  /** The tax part of `amountMinor`. */
  taxMinor: number;
  restocked: boolean;
}

export interface Refund {
  id: string;
  saleId: string;
  receiptNo: string;
  /** The shift that was open when the refund was made (not necessarily the shift of the sale). */
  shiftId: string | null;
  userId: string;
  userName: string;
  reason: string;
  method: RefundMethod;
  reference: string | null;
  restock: boolean;
  /** Total handed back, tax included. */
  amountMinor: number;
  taxMinor: number;
  lines: RefundLine[];
  createdAt: string;
}

/** What the audit trail records. New kinds may be added; screens must show an unknown kind as plain text. */
export type AuditAction =
  | "sale.void"
  | "sale.refund"
  | "sale.discount"
  | "product.price"
  | "stock.adjust"
  | "user.create"
  | "user.update"
  | "user.pin_reset"
  | "settings.update"
  | "backup.restore"
  | "login.failed"
  | "shift.close";

export interface AuditEntry {
  /** Rises with every entry; entries are never changed or removed. */
  seq: number;
  at: string;
  /** Who did it. Null for something with no signed-in person, such as a failed sign-in. */
  userId: string | null;
  userName: string | null;
  action: AuditAction | (string & {});
  /** What it was done to, e.g. "sale", "product", "user", "settings". */
  entity: string;
  entityId: string | null;
  /** One plain sentence. Never contains a PIN. */
  summary: string;
  /** Before and after values and amounts, where there are any. */
  detail: Record<string, unknown> | null;
}

export interface AuditQuery {
  /** Business days, YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  action?: string;
  userId?: string;
  /** Newest first. Default 200, most 1000. */
  limit?: number;
  /** Return entries older than this `seq`, to page backwards. */
  beforeSeq?: number;
}

/** What is left to refund on one line of a sale. */
export interface RefundableLine {
  saleItemId: string;
  productId: string;
  name: string;
  qty: number;
  refundedQty: number;
  remainingQty: number;
  /** The whole line, tax included, after its own discount. */
  lineTotalMinor: number;
  /** What the remaining quantity would hand back, tax included. */
  remainingMinor: number;
}

export interface RefundableSale {
  saleId: string;
  receiptNo: string;
  /** False when the sale cannot be part-refunded; `blockedReason` says why in plain words. */
  allowed: boolean;
  blockedReason: string | null;
  lines: RefundableLine[];
  refunds: Refund[];
}

/** One shift as it appears on the day-close report. Cash figures for a closed shift never change afterwards. */
export interface DayCloseShift {
  shiftId: string;
  userName: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  openingCashMinor: number;
  cashSalesMinor: number;
  cashInMinor: number;
  cashOutMinor: number;
  /** Cash handed back to customers during this shift for sales or refunds. Part of `cashOutMinor`. */
  refundCashOutMinor: number;
  expectedCashMinor: number;
  /** Null while the shift is open. */
  countedCashMinor: number | null;
  varianceMinor: number | null;
  note: string | null;
}

/** All the figures for one business day, computed in the core. Screens only lay them out. */
export interface DayCloseReport {
  /** The business day, YYYY-MM-DD. */
  date: string;
  /** The UTC instants the day covers: `from` inclusive, `to` exclusive. */
  from: string;
  to: string;
  generatedAt: string;

  salesCount: number;
  /** Items at list price before discounts. */
  grossSalesMinor: number;
  discountsMinor: number;
  taxMinor: number;
  /** Total billed on completed sales, tax included, before refunds. */
  billedMinor: number;
  voidCount: number;
  voidedMinor: number;
  /** Sales rung on an earlier day and voided during this one. They come off this day, not the day they were rung. */
  earlierSaleVoids: { count: number; amountMinor: number };
  refundCount: number;
  refundedMinor: number;
  /** `billedMinor` minus `refundedMinor` minus the earlier-day voids. */
  netTakingsMinor: number;

  /** Money actually received, by method, after change given and refunds paid out. */
  receivedByMethod: { cash: number; card: number; bank_transfer: number; other: number };
  /** The part of bills put on a customer's account (khata). Income, but not received. */
  onAccountMinor: number;
  refundsByMethod: { cash: number; card: number; bank_transfer: number; other: number };

  shifts: DayCloseShift[];
  /** Totals across `shifts`. */
  cash: {
    openingMinor: number;
    salesMinor: number;
    inMinor: number;
    outMinor: number;
    expectedMinor: number;
    /** Null if any shift is still open. */
    countedMinor: number | null;
    varianceMinor: number | null;
  };

  /** Null unless the signed-in person may see profit (`finance.view`). */
  profit: { cogsMinor: number; grossProfitMinor: number; costMissing: boolean } | null;

  /** Plain sentences the owner should read before closing: open shifts, missing costs, sales voided after their shift closed. */
  warnings: string[];
}

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
  loginUsers(): Promise<Pick<User, "id" | "name" | "role" | "pinLength">[]>;
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
  /** Manager or owner. The money comes out of the open shift; closed shifts are never changed. */
  refundSale(input: RefundInput): Promise<Refund>;
  /** What is left to refund on a sale and why a sale cannot be part-refunded. */
  refundableSale(saleId: string): Promise<RefundableSale>;
  recentRefunds(limit?: number): Promise<Refund[]>;
  /** Owner only. Newest first. */
  listAudit(query?: AuditQuery): Promise<AuditEntry[]>;
  /** Everything for one business day, computed in the core. Profit is null unless the user has `finance.view`. Needs `reports.view`. */
  dayCloseReport(date: string): Promise<DayCloseReport>;

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

  // Orders: held orders, tokens, add-ons and the kitchen
  modifiers(includeInactive?: boolean): Promise<Modifier[]>;
  addModifier(input: ModifierInput): Promise<Modifier>;
  updateModifier(id: string, patch: Partial<ModifierInput> & { active?: boolean }): Promise<Modifier>;
  openOrders(): Promise<Order[]>;
  createOrder(input: Omit<OrderInput, "userId">): Promise<Order>;
  updateOrder(id: string, patch: Partial<Omit<OrderInput, "userId">>): Promise<Order>;
  addOrderItem(orderId: string, input: { productId: string; qty: number; modifierIds?: string[]; note?: string | null }): Promise<Order>;
  setOrderItemQty(itemId: string, qty: number): Promise<Order>;
  removeOrderItem(itemId: string): Promise<Order>;
  sendToKitchen(orderId: string): Promise<KitchenTicket>;
  kitchenBoard(): Promise<Order[]>;
  setKitchenStatus(orderId: string, status: KitchenStatus): Promise<Order>;
  cancelOrder(orderId: string, reason: string): Promise<Order>;
  payOrder(
    orderId: string,
    payments: PaymentInput[],
    /** Points to use as a discount and wallet money to spend, for the customer attached to the order. */
    loyalty?: { redeemPoints?: number; walletMinor?: number; onAccountMinor?: number },
  ): Promise<CheckoutResult>;
  /** Move the chosen items (or part of a line's quantity) to a new open bill for the same table. */
  // Customers, points and wallet
  searchCustomers(query: string): Promise<Customer[]>;
  getCustomer(id: string): Promise<Customer>;
  createCustomer(input: CustomerInput): Promise<Customer>;
  updateCustomer(id: string, patch: Partial<CustomerInput>): Promise<Customer>;
  /** Orders and spend. `totalSpentMinor` is null unless the signed-in person is the owner. */
  customerHistory(id: string): Promise<CustomerHistory>;
  customerLedger(id: string): Promise<LedgerEntry[]>;
  adjustCustomerPoints(id: string, delta: number, note: string): Promise<Customer>;
  adjustCustomerWallet(id: string, deltaMinor: number, note: string): Promise<Customer>;
  /** Cash goes into the open shift's drawer record; card does not touch the drawer. */
  topUpWallet(id: string, amountMinor: number, method: "cash" | "card", note?: string): Promise<Customer>;
  // Khata: customers buying on account
  /** Everyone who owes money, largest first. */
  owingCustomers(): Promise<Debtor[]>;
  customerStatement(id: string): Promise<Statement>;
  /** The statement as plain text for printing: 32 characters wide for 58 mm paper, 48 for 80 mm. */
  customerStatementText(id: string, width: 32 | 48): Promise<string>;
  /** Record money paid back. Cash goes into the open shift's drawer record. */
  repayCustomer(id: string, amountMinor: number, method: "cash" | "card", note?: string): Promise<Customer>;
  /** Manager: the most a customer may owe, or null for no limit. */
  setCreditLimit(id: string, limitMinor: number | null): Promise<Customer>;
  /** Manager: forgive some (or all, when no amount is given) of what a customer owes. */
  writeOffCustomer(id: string, note: string, amountMinor?: number): Promise<Customer>;
  getLoyalty(): Promise<LoyaltyConfig>;
  setLoyalty(config: LoyaltyConfig): Promise<LoyaltyConfig>;
  splitOrder(orderId: string, picks: { itemId: string; qty: number }[]): Promise<{ original: Order; created: Order }>;

  // Menu, ingredients and recipes
  listItems(kind?: ItemKind): Promise<ProductWithStock[]>;
  getRecipe(productId: string): Promise<Recipe>;
  setRecipe(productId: string, lines: { ingredientId: string; qty: number }[]): Promise<Recipe>;
  recipeCosts(): Promise<Record<string, number>>;

  // Purchases. `fromDrawer` takes the cash out of the open shift's drawer.
  recordPurchase(input: Omit<PurchaseInput, "userId">, fromDrawer?: boolean): Promise<Purchase>;
  payPurchase(id: string, amountMinor: number, method: PayMethod, fromDrawer?: boolean): Promise<Purchase>;
  listPurchases(onlyUnpaid?: boolean): Promise<Purchase[]>;
  payables(): Promise<Payables>;

  // Supplier purchase orders. Receiving goes through the purchasing service (stock, cost, what is owed).
  createPurchaseOrder(input: Omit<PurchaseOrderInput, "userId">): Promise<PurchaseOrder>;
  listPurchaseOrders(status?: PurchaseOrderStatus): Promise<PurchaseOrder[]>;
  receivePurchaseOrder(id: string, input: Omit<ReceiveInput, "userId">, fromDrawer?: boolean): Promise<PurchaseOrder>;
  cancelPurchaseOrder(id: string, reason?: string): Promise<PurchaseOrder>;
  supplierNames(): Promise<string[]>;
  supplierStatement(supplier: string, from?: string, to?: string): Promise<SupplierStatement>;

  // Running costs
  expenseCategories(): Promise<ExpenseCategory[]>;
  addExpenseCategory(name: string): Promise<ExpenseCategory>;
  addExpense(input: Omit<ExpenseInput, "userId">, fromDrawer?: boolean): Promise<Expense>;
  voidExpense(id: string, reason: string): Promise<Expense>;
  listExpenses(from: string, to: string): Promise<Expense[]>;

  // Attendance (managers) and payroll (owner)
  roster(): Promise<RosterEntry[]>;
  clockIn(employeeId: string): Promise<AttendanceRecord>;
  clockOut(employeeId: string): Promise<AttendanceRecord>;
  attendance(from: string, to: string, employeeId?: string): Promise<AttendanceRecord[]>;
  addShiftRecord(employeeId: string, clockIn: string, clockOut: string, note?: string): Promise<AttendanceRecord>;
  removeShiftRecord(id: string): Promise<void>;
  listEmployees(includeInactive?: boolean): Promise<Employee[]>;
  createEmployee(input: EmployeeInput): Promise<Employee>;
  updateEmployee(id: string, patch: Partial<EmployeeInput> & { active?: boolean }): Promise<Employee>;
  giveAdvance(employeeId: string, amountMinor: number, note?: string, fromDrawer?: boolean): Promise<void>;
  payrollPreview(start: string, end: string): Promise<PayrollPreviewLine[]>;
  runPayroll(start: string, end: string, lines?: PayslipLineInput[]): Promise<Payslip[]>;
  payPayslip(id: string, method: PayMethod, fromDrawer?: boolean): Promise<Payslip>;
  payslips(from?: string, to?: string): Promise<Payslip[]>;

  // Money: where it comes from and where it goes
  profitAndLoss(from: string, to: string): Promise<ProfitAndLoss>;
  /** Save the five accountant CSV files for a date range into a folder the person picks. Null if they cancel. */
  exportAccounting(from: string, to: string): Promise<{ folder: string; names: string[] } | null>;
  backupNow(): Promise<string>;

  // Sponsor line and "is there a newer Tillbase?". Neither sends anything about the shop.
  sponsorBanner(): Promise<AdView | null>;
  openSponsor(id: string): Promise<void>;
  appVersion(): Promise<string>;
  checkForUpdate(force?: boolean): Promise<UpdateInfo | null>;
  openDownloadPage(): Promise<void>;
  // Backups screen (owner only)
  backupStatus(): Promise<BackupStatus>;
  chooseBackupFolder(): Promise<BackupStatus | null>;
  clearBackupFolder(): Promise<BackupStatus>;
  restoreBackup(name: string, where: BackupWhere): Promise<void>;

  // Reports and settings
  salesSummary(from: string, to: string): Promise<SalesSummary>;
  updateSettings(patch: Partial<ShopSettings>): Promise<ShopSettings>;

  // Staff
  listStaff(): Promise<User[]>;
  createStaff(input: StaffInput): Promise<User>;
  updateStaff(id: string, patch: { name?: string; role?: Role; active?: boolean }): Promise<User>;
  resetPin(userId: string, newPin: string): Promise<void>;
  changeOwnPin(currentPin: string, newPin: string): Promise<void>;

  // Menu items as CSV (products.manage). Ingredients are not part of the file.
  chooseProductCsv(): Promise<ProductCsvFile | null>;
  productCsvTemplate(): Promise<string>;
  exportProductCsv(): Promise<string>;
  saveCsvFile(suggestedName: string, text: string): Promise<string | null>;
  previewProductCsv(text: string, options?: ProductCsvOptions): Promise<ProductCsvReport>;
  importProductCsv(text: string, options?: ProductCsvOptions): Promise<ProductCsvReport>;

  // Direct receipt printing. A print never throws for printer trouble: it answers with a PrintResult, so a sale is never blocked.
  /** Where receipts go (any signed-in user can read it, so screens know whether to print by themselves). */
  getPrinter(): Promise<PrinterConfig>;
  setPrinter(config: Partial<PrinterConfig>): Promise<PrinterConfig>;
  /** Print a sale's receipt (with the shop logo). Opens the cash drawer when the printer is set to and the sale took cash. */
  printReceipt(saleId: string): Promise<PrintResult>;
  printKitchenTicket(ticket: KitchenTicket): Promise<PrintResult>;
  printStatement(customerId: string): Promise<PrintResult>;
  /** Settings: print a short test page (optionally opening the drawer too). */
  printTestPage(openDrawer?: boolean): Promise<PrintResult>;
  /** Open the cash drawer without a sale. Managers only, because it is a "no sale" drawer opening. */
  openCashDrawer(): Promise<PrintResult>;

  // First-run setup and the business profile (what kind of business this is, and what the menu shows).
  /** Any signed-in user can read it (the menu and Home follow it). */
  getBusinessProfile(): Promise<BusinessProfile>;
  /** Save setup answers. Owner only. */
  saveBusinessProfile(patch: BusinessProfilePatch): Promise<BusinessProfile>;
  /** First run only: create the owner account AND mark setup as started, in one step, so an interrupted setup can be resumed. */
  beginOnboarding(name: string, pin: string): Promise<SessionInfo>;
  /** Setup is finished (or skipped): the wizard is not shown again. Owner only. */
  finishOnboarding(): Promise<BusinessProfile>;
  /** The owner chose to go through setup again. Keeps all answers and all data. Owner only. */
  restartOnboarding(): Promise<BusinessProfile>;
}

/**
 * What happened when something was sent to the receipt printer. `no_printer`: none is set up, so the screen uses
 * the system print window. `failed`: one is set up but could not be used; `message` says why, in plain words.
 */
export type PrintResult = { status: "printed" } | { status: "no_printer" } | { status: "failed"; message: string };

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
  "voidSale","refundSale","refundableSale","recentRefunds","listAudit","dayCloseReport",
  "openShift",
  "shiftSummary",
  "cashMovement",
  "closeShift",
  "recentShifts",
  "createProduct",
  "updateProduct",
  "adjustStock",
  "lowStock",
  "modifiers","addModifier","updateModifier","openOrders","createOrder","updateOrder",
  "addOrderItem","setOrderItemQty","removeOrderItem","sendToKitchen","kitchenBoard",
  "setKitchenStatus","cancelOrder","payOrder","splitOrder",
  "searchCustomers","getCustomer","createCustomer","updateCustomer","customerHistory","customerLedger",
  "adjustCustomerPoints","adjustCustomerWallet","topUpWallet","getLoyalty","setLoyalty",
  "owingCustomers","customerStatement","customerStatementText","repayCustomer","setCreditLimit","writeOffCustomer",
  "listItems","getRecipe","setRecipe","recipeCosts",
  "recordPurchase","payPurchase","listPurchases","payables",
  "createPurchaseOrder","listPurchaseOrders","receivePurchaseOrder","cancelPurchaseOrder","supplierNames","supplierStatement",
  "expenseCategories","addExpenseCategory","addExpense","voidExpense","listExpenses",
  "roster","clockIn","clockOut","attendance","addShiftRecord","removeShiftRecord",
  "listEmployees","createEmployee","updateEmployee","giveAdvance",
  "payrollPreview","runPayroll","payPayslip","payslips",
  "profitAndLoss","backupNow",
  "sponsorBanner","openSponsor","appVersion","checkForUpdate","openDownloadPage",
  "backupStatus","chooseBackupFolder","clearBackupFolder","restoreBackup",
  "exportAccounting",
  "salesSummary",
  "updateSettings",
  "listStaff",
  "createStaff",
  "updateStaff",
  "resetPin",
  "changeOwnPin",
  "chooseProductCsv","productCsvTemplate","exportProductCsv","saveCsvFile","previewProductCsv","importProductCsv",
  "getPrinter","setPrinter","printReceipt","printKitchenTicket","printStatement","printTestPage","openCashDrawer",
  "getBusinessProfile","saveBusinessProfile","beginOnboarding","finishOnboarding","restartOnboarding",
];
