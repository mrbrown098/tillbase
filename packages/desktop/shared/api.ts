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
  ReportCentre,
  ReportKind,
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

/**
 * Everything the user interface may ask the app to do. The main process
 * implements it over @tillbase/core and checks the signed-in user's
 * permissions on every call; the preload script exposes it to the page as
 * `window.tillbase`. Every method rejects with a plain Error whose message is
 * safe to show to the cashier.
 */
/**
 * Which report to make. Daily uses the "to" day; monthly uses the whole calendar month that "to" falls in;
 * the others use from..to. Statements also need a customer (customerId) or a supplier name.
 */
export interface ReportRequest {
  kind: ReportKind;
  from: string;
  to: string;
  customerId?: string;
  supplier?: string;
}

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

  // Report centre (owner). Statements follow the permission of the screen they belong to.
  reportCentre(from: string, to: string): Promise<ReportCentre>;
  /** The A4 report as an HTML page, for the on-screen preview. */
  reportHtml(request: ReportRequest): Promise<string>;
  /** Makes the A4 PDF and opens it in the computer's PDF viewer, where it can be printed. Returns the file's name. */
  printReport(request: ReportRequest): Promise<string>;
  /** Makes the A4 PDF and asks where to save it. Null if cancelled. */
  saveReportPdf(request: ReportRequest): Promise<string | null>;
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
  "modifiers","addModifier","updateModifier","openOrders","createOrder","updateOrder",
  "addOrderItem","setOrderItemQty","removeOrderItem","sendToKitchen","kitchenBoard",
  "setKitchenStatus","cancelOrder","payOrder","splitOrder",
  "searchCustomers","getCustomer","createCustomer","updateCustomer","customerHistory","customerLedger",
  "adjustCustomerPoints","adjustCustomerWallet","topUpWallet","getLoyalty","setLoyalty",
  "owingCustomers","customerStatement","customerStatementText","repayCustomer","setCreditLimit","writeOffCustomer",
  "listItems","getRecipe","setRecipe","recipeCosts",
  "recordPurchase","payPurchase","listPurchases","payables",
  "createPurchaseOrder","listPurchaseOrders","receivePurchaseOrder","cancelPurchaseOrder","supplierNames","supplierStatement","reportCentre","reportHtml","printReport","saveReportPdf",
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
];
