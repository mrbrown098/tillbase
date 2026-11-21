import { createHash } from "node:crypto";
import {
  AccountingExportService,
  ExpenseService,
  FinanceService,
  InventoryService,
  LabourService,
  CustomerService,
  OrderService,
  ProductCsvService,
  PurchaseService,
  RecipeService,
  ProductService,
  ReportService,
  SaleService,
  SettingsService,
  ShiftService,
  UserService,
  can,
  formatReceipt,
  permissionsOf,
  type Db,
  type ImportResult,
  type Permission,
  type Sale,
  type User,
} from "@tillbase/core";
import type {
  CheckoutResult,
  ProductCsvFile,
  ProductCsvOptions,
  ProductCsvReport,
  ProductWithStock,
  SessionInfo,
  ShiftSummaryView,
  TillbaseApi,
} from "../shared/api.js";

/**
 * The real implementation of the app's API. It has no Electron imports, so it
 * can be tested directly against an in-memory database.
 *
 * The signed-in user lives here, in the main process. The page can only ask
 * for things through this API, and every method checks the permission it
 * needs, so a modified page cannot do more than the signed-in role allows.
 */
export function createHandlers(
  db: Db,
  receiptPrefix = "T1",
  now: () => number = Date.now,
  hooks: {
    backup?: () => Promise<string>;
    afterShiftClose?: () => void;
    /** Native file dialogs, supplied by the Electron main process. Each returns null if the person cancels. */
    files?: {
      openCsv: () => Promise<ProductCsvFile | null>;
      saveCsv: (suggestedName: string, text: string) => Promise<string | null>;
      saveFiles?: (files: { name: string; text: string }[]) => Promise<{ folder: string; names: string[] } | null>;
    };
  } = {},
): TillbaseApi {
  const products = new ProductService(db);
  const inventory = new InventoryService(db);
  const sales = new SaleService(db, receiptPrefix);
  const reports = new ReportService(db);
  const settings = new SettingsService(db);
  const users = new UserService(db, now);
  const shifts = new ShiftService(db);
  const recipes = new RecipeService(db);
  const purchases = new PurchaseService(db);
  const expenses = new ExpenseService(db);
  const labour = new LabourService(db);
  const finance = new FinanceService(db);
  const accounting = new AccountingExportService(db);
  const orders = new OrderService(db, receiptPrefix);
  const productCsv = new ProductCsvService(db);
  const customers = new CustomerService(db);

  let current: User | null = null;

  const publicUser = (u: User) => ({ id: u.id, name: u.name, role: u.role });

  /** The signed-in user, or an error. Re-reads the account so a deactivated or demoted user loses access at once. */
  const authorize = (permission?: Permission): User => {
    if (!current) throw new Error("Please sign in");
    const fresh = users.get(current.id);
    if (!fresh || !fresh.active) {
      current = null;
      throw new Error("Please sign in");
    }
    current = fresh;
    if (permission && !can(fresh.role, permission)) {
      throw new Error("You do not have permission to do that");
    }
    return fresh;
  };

  const sessionInfo = (): SessionInfo => {
    const user = current ? users.get(current.id) : undefined;
    const active = user && user.active ? user : null;
    if (!active) current = null;
    return {
      needsSetup: users.count() === 0,
      user: active ? publicUser(active) : null,
      permissions: active ? permissionsOf(active.role) : [],
      shift: active ? (shifts.current() ?? null) : null,
    };
  };

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

  const view = (summary: ReturnType<ShiftService["summary"]>, user: User): ShiftSummaryView => {
    const reveal = can(user.role, "reports.view") || summary.shift.status === "closed";
    return { ...summary, expectedCashMinor: reveal ? summary.expectedCashMinor : null };
  };

  const openShiftOrThrow = () => {
    const shift = shifts.current();
    if (!shift) throw new Error("Open a shift before selling");
    return shift;
  };

  /** Take cash for a business payment out of the open drawer, so the shift count stays honest. */
  const drawerOut = (user: User, amountMinor: number, reason: string) => {
    if (amountMinor <= 0) return;
    const shift = shifts.current();
    if (!shift) throw new Error("Open a shift to pay from the drawer");
    try {
      shifts.addCashMovement(shift.id, user.id, -amountMinor, reason);
    } catch {
      throw new Error("There is not enough cash in the drawer for that payment");
    }
  };

  // ---- CSV helpers -------------------------------------------------------
  const maxCsvChars = 5_000_000;
  /** The file and choices of the last preview. An import is only allowed for exactly that. */
  let previewed: string | null = null;
  const csvFingerprint = (text: string, o: ProductCsvOptions) =>
    createHash("sha256")
      .update(JSON.stringify([text, o.updateExisting ?? true, o.fixStock === true]))
      .digest("hex");
  const csvText = (text: unknown): string => {
    if (typeof text !== "string") throw new Error("Choose a CSV file first");
    if (text.length > maxCsvChars) throw new Error("That file is too big to import at once (over 5 MB). Please split it into smaller files.");
    return text;
  };
  const csvReport = (r: ImportResult): ProductCsvReport => ({
    dryRun: r.dryRun,
    created: r.created,
    updated: r.updated,
    skipped: r.skipped,
    failed: r.failed,
    stockAdjustments: r.stockAdjustments,
    rows: r.rows,
    issues: r.issues,
    nothingWritten: r.nothingWritten,
  });
  const csvFiles = () => {
    if (!hooks.files) throw new Error("Opening and saving files is not available here");
    return hooks.files;
  };

  return {
    // ---- Session -------------------------------------------------------
    async session() {
      return sessionInfo();
    },
    async loginUsers() {
      return users.list().map(publicUser);
    },
    async setupOwner(name, pin) {
      if (users.count() > 0) throw new Error("Setup has already been completed");
      current = users.create({ name, pin, role: "owner" });
      return sessionInfo();
    },
    async login(userId, pin) {
      current = users.authenticate(userId, pin);
      return sessionInfo();
    },
    async logout() {
      current = null;
      return sessionInfo();
    },
    async getSettings() {
      return settings.get();
    },

    // ---- Selling -------------------------------------------------------
    async listProducts() {
      authorize("sell");
      return withStock(products.list({ kind: "product" }));
    },
    async searchProducts(query) {
      authorize("sell");
      return query.trim() ? withStock(products.search(query)) : withStock(products.list({ kind: "product" }));
    },
    async findByBarcode(barcode) {
      authorize("sell");
      const p = products.findByBarcode(barcode);
      return p ? one(p.id) : null;
    },
    async checkout(input): Promise<CheckoutResult> {
      const user = authorize("sell");
      if (input.lines.some((l) => (l.discountMinor ?? 0) > 0 || l.unitPriceMinor !== undefined)) {
        authorize("discount");
      }
      const shift = openShiftOrThrow();
      const sale = sales.checkout({
        ...input,
        shiftId: shift.id,
        userId: user.id,
        cashier: user.name,
      });
      return { sale, receipt: receipt(sale) };
    },
    async recentSales(limit = 50) {
      authorize("sell");
      return sales.recent(limit);
    },
    async receiptText(saleId) {
      authorize("sell");
      const sale = sales.get(saleId);
      if (!sale) throw new Error("Sale not found");
      return receipt(sale);
    },
    async voidSale(saleId, reason) {
      const user = authorize("void");
      const shift = openShiftOrThrow();
      const sale = sales.get(saleId);
      if (!sale) throw new Error("Sale not found");
      return db.transaction(() => {
        // If the sale was rung up in an earlier shift, that shift's cash is already
        // counted and closed, so the refund comes out of today's drawer.
        if (sale.status === "completed" && sale.shiftId !== shift.id) {
          const cash =
            sale.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amountMinor, 0) -
            sale.changeMinor;
          if (cash > 0) {
            try {
              shifts.addCashMovement(shift.id, user.id, -cash, `Refund for voided ${sale.receiptNo}`);
            } catch {
              throw new Error("There is not enough cash in the drawer to refund this sale");
            }
          }
        }
        return sales.voidSale(saleId, reason);
      })();
    },

    // ---- Shifts and cash ----------------------------------------------
    async openShift(openingCashMinor) {
      const user = authorize("sell");
      shifts.open(user.id, openingCashMinor);
      return sessionInfo();
    },
    async shiftSummary(shiftId) {
      const user = authorize("sell");
      const id = shiftId ?? shifts.current()?.id;
      if (!id) throw new Error("No shift is open");
      const summary = shifts.summary(id);
      // Anyone selling may see the shift currently open (they are working on it);
      // other people's past shifts are for managers and owners.
      const isCurrent = summary.shift.status === "open";
      if (!isCurrent && summary.shift.userId !== user.id && !can(user.role, "shifts.manage_all")) {
        throw new Error("You do not have permission to do that");
      }
      return view(summary, user);
    },
    async cashMovement(amountMinor, reason) {
      const user = authorize("cash.movement");
      const shift = openShiftOrThrow();
      shifts.addCashMovement(shift.id, user.id, amountMinor, reason);
      return view(shifts.summary(shift.id), user);
    },
    async closeShift(countedCashMinor, note) {
      const user = authorize("sell");
      const shift = openShiftOrThrow();
      if (shift.userId !== user.id && !can(user.role, "shifts.manage_all")) {
        throw new Error("Only the person who opened the shift, or a manager, can close it");
      }
      const closed = view(shifts.close(shift.id, countedCashMinor, note), user);
      hooks.afterShiftClose?.();
      return closed;
    },
    async recentShifts() {
      authorize("shifts.manage_all");
      return shifts.recent();
    },

    // ---- Catalogue and stock ------------------------------------------
    async createProduct(input, openingStock) {
      authorize("products.manage");
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
      authorize("products.manage");
      products.update(id, patch);
      return one(id);
    },
    async adjustStock(productId, qtyDelta, reason) {
      authorize("stock.adjust");
      if (!products.get(productId)) throw new Error("Product not found");
      inventory.adjust(productId, qtyDelta, reason);
    },
    async lowStock() {
      authorize("reports.view");
      return inventory.lowStock();
    },

    // ---- Orders and the kitchen -----------------------------------------
    async modifiers(includeInactive = false) {
      authorize("sell");
      return orders.modifiers({ includeInactive });
    },
    async addModifier(input) {
      authorize("products.manage");
      return orders.addModifier(input);
    },
    async updateModifier(id, patch) {
      authorize("products.manage");
      return orders.updateModifier(id, patch);
    },
    async openOrders() {
      authorize("sell");
      return orders.open();
    },
    async createOrder(input) {
      const user = authorize("sell");
      return orders.create({ ...input, userId: user.id });
    },
    async updateOrder(id, patch) {
      authorize("sell");
      return orders.update(id, patch);
    },
    async addOrderItem(orderId, input) {
      authorize("sell");
      return orders.addItem(orderId, input);
    },
    // Items already sent to the kitchen can only be changed by someone who may void.
    async setOrderItemQty(itemId, qty) {
      const user = authorize("sell");
      return orders.setItemQty(itemId, qty, { allowSent: can(user.role, "void") });
    },
    async removeOrderItem(itemId) {
      const user = authorize("sell");
      return orders.removeItem(itemId, { allowSent: can(user.role, "void") });
    },
    async sendToKitchen(orderId) {
      authorize("sell");
      return orders.sendToKitchen(orderId);
    },
    async kitchenBoard() {
      authorize("sell");
      return orders.kitchen();
    },
    async setKitchenStatus(orderId, status) {
      authorize("sell");
      return orders.setKitchenStatus(orderId, status);
    },
    async cancelOrder(orderId, reason) {
      const user = authorize("sell");
      const o = orders.get(orderId);
      // Food that is already being made is a loss, so cancelling it needs a manager.
      if (o?.items.some((i) => i.sent) && !can(user.role, "void")) {
        throw new Error("That order is already in the kitchen. Ask a manager to cancel it");
      }
      return orders.cancel(orderId, reason);
    },
    async payOrder(orderId, payments, loyalty) {
      const user = authorize("sell");
      const shift = openShiftOrThrow();
      const sale = orders.pay(orderId, {
        payments, shiftId: shift.id, userId: user.id, cashier: user.name,
        redeemPoints: loyalty?.redeemPoints, walletMinor: loyalty?.walletMinor,
      });
      return { sale, receipt: receipt(sale) };
    },
    // ---- Customers, points and wallet ----------------------------------
    async searchCustomers(query) {
      authorize("customers.use");
      return customers.search(query);
    },
    async getCustomer(id) {
      authorize("customers.use");
      const c = customers.get(id);
      if (!c) throw new Error("Customer not found");
      return c;
    },
    async createCustomer(input) {
      authorize("customers.use");
      return customers.create(input);
    },
    async updateCustomer(id, patch) {
      authorize("customers.manage");
      return customers.update(id, patch);
    },
    async customerHistory(id) {
      const user = authorize("customers.manage");
      return customers.history(id, can(user.role, "customers.view_spend"));
    },
    async customerLedger(id) {
      authorize("customers.manage");
      return customers.ledger(id);
    },
    async adjustCustomerPoints(id, delta, note) {
      const user = authorize("customers.manage");
      return customers.adjustPoints(id, delta, note, user.id);
    },
    async adjustCustomerWallet(id, deltaMinor, note) {
      const user = authorize("customers.manage");
      return customers.adjustWallet(id, deltaMinor, note, user.id);
    },
    async topUpWallet(id, amountMinor, method, note) {
      const user = authorize("customers.manage");
      if (method !== "cash" && method !== "card") throw new Error("Choose cash or card for the top-up");
      // Cash put in a wallet goes into the drawer, so it is recorded on the shift. Do both or neither.
      const shift = method === "cash" ? openShiftOrThrow() : null;
      return db.transaction(() => {
        const c = customers.topUp(id, amountMinor, [method === "cash" ? "Cash" : "Card", note?.trim()].filter(Boolean).join(" · "), user.id);
        if (shift) shifts.addCashMovement(shift.id, user.id, amountMinor, `Wallet top-up for ${c.name}`);
        return c;
      })();
    },
    async getLoyalty() {
      authorize("customers.use");
      return customers.config();
    },
    async setLoyalty(config) {
      authorize("customers.manage");
      return customers.setConfig(config);
    },
    // Splitting does not remove any food or change a price, so any seller may do it, even for items already sent.
    async splitOrder(orderId, picks) {
      const user = authorize("sell");
      return orders.splitItems(orderId, picks, { userId: user.id });
    },

    // ---- Menu, ingredients and recipes --------------------------------
    async listItems(kind = "all") {
      authorize("products.manage");
      if (kind === "all") return withStock([...products.list({ kind: "product" }), ...products.list({ kind: "ingredient" })]);
      return withStock(products.list({ kind }));
    },
    async getRecipe(productId) {
      authorize("products.manage");
      return recipes.get(productId);
    },
    async setRecipe(productId, lines) {
      authorize("products.manage");
      return recipes.set(productId, lines);
    },
    async recipeCosts() {
      authorize("products.manage");
      return recipes.costs();
    },

    // ---- Purchases ------------------------------------------------------
    async recordPurchase(input, fromDrawer = false) {
      const user = authorize("purchases.manage");
      return db.transaction(() => {
        const p = purchases.record({ ...input, userId: user.id });
        if (fromDrawer && (input.method ?? "cash") === "cash") {
          drawerOut(user, p.paidMinor, `Purchase${p.supplier ? ` from ${p.supplier}` : ""}`);
        }
        return p;
      })();
    },
    async payPurchase(id, amountMinor, method, fromDrawer = false) {
      const user = authorize("purchases.manage");
      return db.transaction(() => {
        const p = purchases.pay(id, amountMinor, method);
        if (fromDrawer && method === "cash") drawerOut(user, amountMinor, `Paid supplier${p.supplier ? ` ${p.supplier}` : ""}`);
        return p;
      })();
    },
    async listPurchases(onlyUnpaid = false) {
      authorize("purchases.manage");
      return purchases.list({ onlyUnpaid });
    },
    async payables() {
      authorize("purchases.manage");
      return purchases.payables();
    },

    // ---- Running costs --------------------------------------------------
    async expenseCategories() {
      authorize("expenses.manage");
      return expenses.categories();
    },
    async addExpenseCategory(name) {
      authorize("expenses.manage");
      return expenses.addCategory(name);
    },
    async addExpense(input, fromDrawer = false) {
      const user = authorize("expenses.manage");
      return db.transaction(() => {
        const e = expenses.add({ ...input, userId: user.id });
        if (fromDrawer && e.method === "cash") drawerOut(user, e.amountMinor, e.description);
        return e;
      })();
    },
    async voidExpense(id, reason) {
      authorize("expenses.manage");
      return expenses.void(id, reason);
    },
    async listExpenses(from, to) {
      authorize("expenses.manage");
      return expenses.list(from, to);
    },

    // ---- Attendance and payroll ----------------------------------------
    async roster() {
      authorize("attendance.manage");
      const inNow = new Map(labour.whoIsIn().map((r) => [r.employeeId, r.clockIn]));
      return labour.employees().map((e) => ({
        id: e.id,
        name: e.name,
        clockedIn: inNow.has(e.id),
        since: inNow.get(e.id) ?? null,
      }));
    },
    async clockIn(employeeId) {
      authorize("attendance.manage");
      return labour.clockIn(employeeId);
    },
    async clockOut(employeeId) {
      authorize("attendance.manage");
      return labour.clockOut(employeeId);
    },
    async attendance(from, to, employeeId) {
      authorize("attendance.manage");
      return labour.attendance(from, to, employeeId);
    },
    async addShiftRecord(employeeId, clockIn, clockOut, note) {
      authorize("attendance.manage");
      return labour.addShift(employeeId, clockIn, clockOut, note);
    },
    async removeShiftRecord(id) {
      authorize("attendance.manage");
      labour.removeShift(id);
    },
    async listEmployees(includeInactive = false) {
      authorize("labour.manage");
      return labour.employees({ includeInactive });
    },
    async createEmployee(input) {
      authorize("labour.manage");
      return labour.createEmployee(input);
    },
    async updateEmployee(id, patch) {
      authorize("labour.manage");
      return labour.updateEmployee(id, patch);
    },
    async giveAdvance(employeeId, amountMinor, note, fromDrawer = false) {
      const user = authorize("labour.manage");
      db.transaction(() => {
        labour.giveAdvance(employeeId, amountMinor, undefined, note);
        if (fromDrawer) drawerOut(user, amountMinor, "Salary advance");
      })();
    },
    async payrollPreview(start, end) {
      authorize("labour.manage");
      return labour.preview(start, end);
    },
    async runPayroll(start, end, lines) {
      const user = authorize("labour.manage");
      return labour.finalize({ periodStart: start, periodEnd: end, userId: user.id, lines });
    },
    async payPayslip(id, method, fromDrawer = false) {
      const user = authorize("labour.manage");
      return db.transaction(() => {
        const slip = labour.pay(id, method);
        if (fromDrawer && method === "cash") drawerOut(user, slip.netMinor, "Wages");
        return slip;
      })();
    },
    async payslips(from, to) {
      authorize("labour.manage");
      return labour.payslips({ from, to });
    },

    // ---- Money in and out -----------------------------------------------
    async profitAndLoss(from, to) {
      authorize("finance.view");
      return finance.profitAndLoss(from, to);
    },
    async exportAccounting(from, to) {
      authorize("finance.view");
      if (!hooks.files?.saveFiles) throw new Error("Saving files is not available here");
      // Built first so a bad date range is reported before any folder window opens.
      const files = accounting.all(from, to).map((f) => ({ name: f.name, text: f.csv }));
      return hooks.files.saveFiles(files);
    },
    async backupNow() {
      authorize("settings.manage");
      if (!hooks.backup) throw new Error("Backups are not available here");
      return hooks.backup();
    },

    // ---- Reports and settings -----------------------------------------
    async salesSummary(from, to) {
      authorize("reports.view");
      return reports.salesSummary(from, to, 5);
    },
    async updateSettings(patch) {
      authorize("settings.manage");
      return settings.update(patch);
    },

    // ---- Staff ---------------------------------------------------------
    async listStaff() {
      authorize("users.manage");
      return users.list({ includeInactive: true });
    },
    async createStaff(input) {
      authorize("users.manage");
      return users.create(input);
    },
    async updateStaff(id, patch) {
      const me = authorize("users.manage");
      const updated = users.update(id, patch);
      if (id === me.id) current = updated.active ? updated : null;
      return updated;
    },
    async resetPin(userId, newPin) {
      authorize("users.manage");
      users.changePin(userId, newPin);
    },
    async changeOwnPin(currentPin, newPin) {
      const me = authorize();
      users.authenticate(me.id, currentPin);
      users.changePin(me.id, newPin);
    },

    // ---- Menu items as CSV ----------------------------------------------
    async chooseProductCsv() {
      authorize("products.manage");
      return csvFiles().openCsv();
    },
    async productCsvTemplate() {
      authorize("products.manage");
      return productCsv.templateCsv({ bom: true });
    },
    async exportProductCsv() {
      authorize("products.manage");
      // Retired items and the id column are included so the file can be brought back later and updates, not duplicates.
      return productCsv.exportCsv({ includeInactive: true, includeIds: true, bom: true });
    },
    async saveCsvFile(suggestedName, text) {
      authorize("products.manage");
      const body = csvText(text);
      const base = String(suggestedName).replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "tillbase";
      return csvFiles().saveCsv(/\.csv$/i.test(base) ? base : `${base}.csv`, body);
    },
    async previewProductCsv(text, options = {}) {
      authorize("products.manage");
      const body = csvText(text);
      const result = productCsv.importCsv(body, {
        dryRun: true,
        updateExisting: options.updateExisting ?? true,
        stockMode: options.fixStock ? "set" : "ignore",
      });
      previewed = csvFingerprint(body, options);
      return csvReport(result);
    },
    async importProductCsv(text, options = {}) {
      authorize("products.manage");
      const body = csvText(text);
      if (previewed !== csvFingerprint(body, options)) {
        throw new Error("Please look over the preview of this file before importing it");
      }
      previewed = null; // one preview, one import: a second click cannot import the file twice
      const result = productCsv.importCsv(body, {
        updateExisting: options.updateExisting ?? true,
        stockMode: options.fixStock ? "set" : "ignore",
        onError: options.skipBadRows ? "skip" : "abort",
      });
      return csvReport(result);
    },
  };
}
