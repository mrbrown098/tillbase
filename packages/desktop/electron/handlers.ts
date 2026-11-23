import { createHash } from "node:crypto";
import {
  BackupManager,
  AccountingExportService,
  ExpenseService,
  FinanceService,
  InventoryService,
  BusinessProfileService,
  LabourService,
  PAPER_CHARS,
  PrinterConfigService,
  CustomerService,
  OrderService,
  ProductCsvService,
  PurchaseOrderService,
  PurchaseService,
  RecipeService,
  ProductService,
  ReportService,
  ReportCentreService,
  dates,
  buildReportHtml,
  reportTitles,
  type ReportDocInput,
  SaleService,
  SettingsService,
  ShiftService,
  UserService,
  can,
  drawerKickJob,
  formatKitchenTicket,
  withTillbaseFooter,
  formatReceipt,
  formatStatement,
  kitchenTicketJob,
  paperForWidth,
  receiptJob,
  statementJob,
  permissionsOf,
  type Db,
  type JobOptions,
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
  PrintResult,
  ShiftSummaryView,
  TillbaseApi,
  ReportRequest,
} from "../shared/api.js";
import type { AdView } from "./ads.js";
import type { UpdateInfo } from "./updates.js";
import { logoRaster, sendToPrinter, type DecodeFn } from "./printing.js";

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
    /** Backups, the second place and restore (see BackupManager). */
    backups?: BackupManager;
    /** Called after a restore has swapped the data in: the app must restart. */
    afterRestore?: () => void;
    afterShiftClose?: () => void;
    /** Sponsor line and update check, supplied by the Electron main process (tests pass fakes). */
    ads?: { current: () => Promise<AdView | null>; open: (id: string) => Promise<void> };
    updates?: { check: (force?: boolean) => Promise<UpdateInfo | null>; openDownload: () => Promise<void> };
    appVersion?: string;
    /** Receipt printer plumbing. Tests replace these so no real printer or Electron is needed. */
    printing?: {
      send?: (host: string, port: number, bytes: Uint8Array) => Promise<void>;
      decodeLogo?: DecodeFn;
    };
    /** Native file dialogs, supplied by the Electron main process. Each returns null if the person cancels. */
    /** Turns an A4 report into a PDF and opens or saves it (Electron main process). */
    reportOutput?: {
      open: (name: string, html: string) => Promise<void>;
      save: (name: string, html: string) => Promise<string | null>;
    };
    files?: {
      openCsv: () => Promise<ProductCsvFile | null>;
      saveCsv: (suggestedName: string, text: string) => Promise<string | null>;
      chooseBackupFolder?: () => Promise<string | null>;
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
  const purchaseOrders = new PurchaseOrderService(db, purchases);
  const expenses = new ExpenseService(db);
  const labour = new LabourService(db);
  const finance = new FinanceService(db);
  const accounting = new AccountingExportService(db);
  const orders = new OrderService(db, receiptPrefix);
  const productCsv = new ProductCsvService(db);
  const customers = new CustomerService(db);
  const printerConfig = new PrinterConfigService(db);
  const business = new BusinessProfileService(db);
  /** Every report, summary and date range follows the shop's time zone and the hour its business day starts. */
  const applyCalendar = () => {
    const p = business.get();
    dates.setBusinessCalendar({ timeZone: p.timezone, cutoffHour: p.dayCutoffHour });
  };
  applyCalendar();

  let current: User | null = null;
  const needBackups = (): BackupManager => {
    if (!hooks.backups) throw new Error("Backups are not available here");
    return hooks.backups;
  };

  const reportCentre = new ReportCentreService(db, now);
  /** Checks the permission, gathers the real figures, and returns a function that builds the A4 page. */
  const reportDocument = (req: ReportRequest) => {
    const needsCentre = req.kind !== "customer-statement" && req.kind !== "supplier-statement";
    authorize(req.kind === "customer-statement" ? "khata.use" : req.kind === "supplier-statement" ? "purchases.manage" : "finance.view");
    const s = settings.get();
    const shop = { name: s.storeName, logo: s.businessLogo, currency: s.currency, locale: s.locale, timeZone: dates.getBusinessCalendar().timeZone };
    const generatedAt = new Date(now()).toISOString();
    let from = req.from;
    let to = req.to;
    if (req.kind === "daily-sales") from = to;
    if (req.kind === "monthly-sales") {
      from = dates.startOfMonth(to);
      to = dates.endOfMonth(to);
    }
    const input: ReportDocInput = { kind: req.kind, shop, generatedAt };
    let tag = `${from}${to === from ? "" : `_to_${to}`}`;
    if (needsCentre) input.centre = reportCentre.build(from, to);
    else if (req.kind === "customer-statement") {
      if (!req.customerId) throw new Error("Choose a customer");
      input.customerStatement = customers.statement(req.customerId);
      tag = input.customerStatement.customer.name;
    } else {
      if (!req.supplier) throw new Error("Choose a supplier");
      input.supplierStatement = purchaseOrders.statement(req.supplier, { from: req.from, to: req.to });
      tag = `${req.supplier}_${req.from}_to_${req.to}`;
    }
    const safe = `${reportTitles[req.kind]}_${tag}`.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
    return { fileName: `${safe}.pdf`, html: (o?: { forPdf?: boolean }) => buildReportHtml(input, o) };
  };

  const publicUser = (u: User) => ({ id: u.id, name: u.name, role: u.role, pinLength: u.pinLength });

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


  // ---- Direct receipt printing -------------------------------------------
  /**
   * Build and send one print job. This never throws: if no printer is set up it says so (the screen then uses the
   * system print window), and if the printer cannot be reached it returns a plain message, so a sale is never held up.
   */
  const sendJob = async (build: (o: JobOptions & { chars: number }) => Uint8Array, opts: { logo?: boolean; drawer?: boolean } = {}): Promise<PrintResult> => {
    const cfg = printerConfig.get();
    if (!cfg.host) return { status: "no_printer" };
    try {
      const s = settings.get();
      const paper = paperForWidth(s.receiptWidth);
      const logo = opts.logo ? await logoRaster(s.businessLogo, paper, hooks.printing?.decodeLogo) : null;
      const bytes = build({ paper, logo, openDrawer: !!opts.drawer && cfg.openDrawer, chars: PAPER_CHARS[paper] });
      await (hooks.printing?.send ?? sendToPrinter)(cfg.host, cfg.port, bytes);
      return { status: "printed" };
    } catch (e) {
      return { status: "failed", message: e instanceof Error && e.message ? e.message : "The receipt printer did not answer." };
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
      if ((input.onAccountMinor ?? 0) > 0) authorize("khata.use");
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
      if ((loyalty?.onAccountMinor ?? 0) > 0) authorize("khata.use");
      const shift = openShiftOrThrow();
      const sale = orders.pay(orderId, {
        payments, shiftId: shift.id, userId: user.id, cashier: user.name,
        redeemPoints: loyalty?.redeemPoints, walletMinor: loyalty?.walletMinor, onAccountMinor: loyalty?.onAccountMinor,
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
    // ---- Khata: customers buying on account ---------------------------------------
    async owingCustomers() {
      authorize("khata.use");
      return customers.owing();
    },
    async customerStatement(id) {
      authorize("khata.use");
      return customers.statement(id);
    },
    async customerStatementText(id, width) {
      authorize("khata.use");
      const s = settings.get();
      return formatStatement(customers.statement(id), {
        storeName: s.storeName,
        currency: s.currency,
        locale: s.locale,
        width: width === 48 ? 48 : 32,
        footer: s.receiptFooter,
      });
    },
    async repayCustomer(id, amountMinor, method, note) {
      const user = authorize("khata.use");
      if (method !== "cash" && method !== "card") throw new Error("Choose cash or card for the repayment");
      // Cash paid back goes into the drawer, so it is recorded on the shift. Do both or neither.
      const shift = method === "cash" ? openShiftOrThrow() : null;
      return db.transaction(() => {
        const c = customers.repay(id, amountMinor, method, note, user.id);
        if (shift) shifts.addCashMovement(shift.id, user.id, amountMinor, `Khata repayment from ${c.name}`);
        return c;
      })();
    },
    async setCreditLimit(id, limitMinor) {
      authorize("khata.manage");
      return customers.setCreditLimit(id, limitMinor);
    },
    async writeOffCustomer(id, note, amountMinor) {
      const user = authorize("khata.manage");
      return customers.writeOff(id, note, amountMinor ?? null, user.id);
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

    // ---- Supplier purchase orders --------------------------------------------
    async createPurchaseOrder(input) {
      const user = authorize("purchases.manage");
      return purchaseOrders.create({ ...input, userId: user.id });
    },
    async listPurchaseOrders(status) {
      authorize("purchases.manage");
      return purchaseOrders.list({ status });
    },
    async receivePurchaseOrder(id, input, fromDrawer = false) {
      const user = authorize("purchases.manage");
      return db.transaction(() => {
        const order = purchaseOrders.receive(id, { ...input, userId: user.id });
        if (fromDrawer && (input.method ?? "cash") === "cash") {
          drawerOut(user, input.paidMinor ?? 0, `Delivery ${order.code} from ${order.supplier}`);
        }
        return order;
      })();
    },
    async cancelPurchaseOrder(id, reason) {
      authorize("purchases.manage");
      return purchaseOrders.cancel(id, reason);
    },
    async supplierNames() {
      authorize("purchases.manage");
      return purchaseOrders.suppliers();
    },
    async supplierStatement(supplier, from, to) {
      authorize("purchases.manage");
      return purchaseOrders.statement(supplier, { from, to });
    },

    // ---- Report centre ----------------------------------------------------
    async reportCentre(from, to) {
      authorize("finance.view");
      return reportCentre.build(from, to);
    },
    async reportHtml(request) {
      return reportDocument(request).html();
    },
    async printReport(request) {
      const doc = reportDocument(request);
      if (!hooks.reportOutput) throw new Error("Printing reports is not available here");
      await hooks.reportOutput.open(doc.fileName, doc.html({ forPdf: true }));
      return doc.fileName;
    },
    async saveReportPdf(request) {
      const doc = reportDocument(request);
      if (!hooks.reportOutput) throw new Error("Saving reports is not available here");
      return hooks.reportOutput.save(doc.fileName, doc.html({ forPdf: true }));
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
    async sponsorBanner() {
      authorize();
      return hooks.ads ? hooks.ads.current() : null;
    },
    async openSponsor(id: string) {
      authorize();
      if (typeof id === "string") await hooks.ads?.open(id);
    },
    async appVersion() {
      return hooks.appVersion ?? "dev";
    },
    async checkForUpdate(force?: boolean) {
      // Only people who run the shop need to hear about new versions.
      const who = authorize();
      if (!can(who.role, "settings.manage")) return null;
      return hooks.updates ? hooks.updates.check(force === true) : null;
    },
    async openDownloadPage() {
      authorize("settings.manage");
      await hooks.updates?.openDownload();
    },
    async backupNow() {
      authorize("settings.manage");
      if (!hooks.backup) throw new Error("Backups are not available here");
      return hooks.backup();
    },
    async backupStatus() {
      authorize("settings.manage");
      return needBackups().status();
    },
    async chooseBackupFolder() {
      authorize("settings.manage");
      const manager = needBackups();
      if (!hooks.files?.chooseBackupFolder) throw new Error("Choosing a folder is not available here");
      const folder = await hooks.files.chooseBackupFolder();
      return folder ? manager.setSecondFolder(folder) : null;
    },
    async clearBackupFolder() {
      authorize("settings.manage");
      return needBackups().clearSecondFolder();
    },
    async restoreBackup(name, where) {
      authorize("settings.manage");
      const manager = needBackups();
      // closeLive is called only after the backup has passed every check.
      manager.restore(name, where, () => db.close());
      current = null;
      hooks.afterRestore?.();
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
    // ---- Direct receipt printing -----------------------------------------
    async getPrinter() {
      authorize();
      return printerConfig.get();
    },
    async setPrinter(config) {
      authorize("settings.manage");
      return printerConfig.set(config);
    },
    async printReceipt(saleId) {
      authorize("sell");
      const sale = sales.get(saleId);
      if (!sale) throw new Error("Sale not found");
      const text = receipt(sale);
      return sendJob((o) => receiptJob(text, o), { logo: true, drawer: sale.payments.some((p) => p.method === "cash") });
    },
    async printKitchenTicket(ticket) {
      authorize("sell");
      return sendJob((o) => kitchenTicketJob(formatKitchenTicket(ticket, { width: o.chars }), o));
    },
    async printStatement(customerId) {
      authorize("khata.use");
      const st = customers.statement(customerId);
      const s = settings.get();
      return sendJob(
        (o) => statementJob(formatStatement(st, { storeName: s.storeName, currency: s.currency, locale: s.locale, width: o.chars, footer: s.receiptFooter }), o),
        { logo: true },
      );
    },
    async printTestPage(openDrawer) {
      authorize("settings.manage");
      const s = settings.get();
      return sendJob(
        (o) => {
          const rule = "-".repeat(o.chars);
          const text = withTillbaseFooter([s.storeName.slice(0, o.chars), rule, "Printer test", `Paper: ${o.paper} mm (${o.chars} characters)`, "1234567890".repeat(5).slice(0, o.chars), rule, "If you can read this, printing works."].join("\n"));
          return receiptJob(text, { ...o, openDrawer: !!openDrawer });
        },
        { logo: true },
      );
    },
    async openCashDrawer() {
      authorize("cash.movement");
      const cfg = printerConfig.get();
      if (!cfg.host) return { status: "no_printer" };
      try {
        await (hooks.printing?.send ?? sendToPrinter)(cfg.host, cfg.port, drawerKickJob());
        return { status: "printed" };
      } catch (e) {
        return { status: "failed", message: e instanceof Error && e.message ? e.message : "The receipt printer did not answer." };
      }
    },
    // ---- First-run setup and the business profile -------------------------
    async getBusinessProfile() {
      authorize();
      return business.get();
    },
    async saveBusinessProfile(patch) {
      authorize("settings.manage");
      const saved = business.save(patch);
      applyCalendar();
      return saved;
    },
    async beginOnboarding(name, pin) {
      if (users.count() > 0) throw new Error("Setup has already been completed");
      // One transaction: the owner exists only together with "setup has started", so closing the app now resumes the setup.
      current = db.transaction(() => {
        const owner = users.create({ name, pin, role: "owner" });
        business.begin();
        return owner;
      })();
      return sessionInfo();
    },
    async finishOnboarding() {
      authorize("settings.manage");
      const done = business.finish();
      applyCalendar();
      return done;
    },
    async restartOnboarding() {
      authorize("settings.manage");
      return business.restart();
    },
  };
}
