import { createHash } from "node:crypto";
import {
  BackupManager,
  AccountingExportService,
  ExpenseService,
  DayCloseService,
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
  SaleService,
  SettingsService,
  AuditService,
  formatMoney,
  RefundService,
  queueAuditAfterRestore,
  ShiftService,
  UserService,
  can,
  drawerKickJob,
  footerWithCredit,
  formatKitchenTicket,
  formatReceipt,
  formatStatement,
  kitchenTicketJob,
  paperForWidth,
  receiptJob,
  statementJob,
  permissionsOf,
  type AuditInput,
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
    /** Where the database file is. Needed so a restore can leave a note in the audit trail of the restored data. */
    dbPath?: string;
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
  const dayClose = new DayCloseService(db);
  const accounting = new AccountingExportService(db);
  const orders = new OrderService(db, receiptPrefix);
  const productCsv = new ProductCsvService(db);
  const customers = new CustomerService(db);
  const refunds = new RefundService(db);
  const audit = new AuditService(db);
  /** Write one line of the audit trail. Call it inside the transaction of the thing it describes. */
  const note = (user: User | null, e: Omit<AuditInput, "userId" | "userName">) =>
    audit.record({ ...e, userId: user?.id ?? null, userName: user?.name ?? null });
  /** One entry for a settings change, listing only the values that changed (an image is noted, not stored). */
  const noteSettings = (user: User | null, before: Record<string, unknown>, after: Record<string, unknown>, what = "Settings") => {
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(after)) {
      if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
      const big = (v: unknown) => (typeof v === "string" && v.length > 200 ? "[image or long text]" : v);
      changed[k] = { from: big(before[k]), to: big(after[k]) };
    }
    if (Object.keys(changed).length === 0) return;
    note(user, { action: "settings.update", entity: "settings", summary: `${what} changed: ${Object.keys(changed).join(", ")}`, detail: { changed } });
  };
  const moneyText = (minor: number) => {
    const s = settings.get();
    return formatMoney(minor, s.currency, s.locale);
  };
  const printerConfig = new PrinterConfigService(db);
  const business = new BusinessProfileService(db);

  let current: User | null = null;
  const needBackups = (): BackupManager => {
    if (!hooks.backups) throw new Error("Backups are not available here");
    return hooks.backups;
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
      footer: footerWithCredit(s),
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
      try {
        current = users.authenticate(userId, pin);
      } catch (e) {
        // Wrong PINs and lock-outs are recorded (never the PIN). Nobody is signed in, so there is no actor.
        const who = users.get(userId);
        note(null, {
          action: "login.failed",
          entity: "user",
          entityId: userId,
          summary: `Failed sign-in${who ? ` for ${who.name}` : ""}: ${(e as Error).message}`,
          detail: { name: who?.name ?? null, role: who?.role ?? null },
        });
        throw e;
      }
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
      const sale = db.transaction(() => {
        const made = sales.checkout({
          ...input,
          shiftId: shift.id,
          userId: user.id,
          cashier: user.name,
        });
        const overrides = input.lines
          .filter((l) => (l.discountMinor ?? 0) > 0 || l.unitPriceMinor !== undefined)
          .map((l) => {
            const p = products.get(l.productId);
            return { name: p?.name ?? l.productId, listPriceMinor: p?.priceMinor ?? null, soldAtMinor: l.unitPriceMinor ?? p?.priceMinor ?? null, discountMinor: l.discountMinor ?? 0 };
          })
          .filter((o) => o.discountMinor > 0 || (o.soldAtMinor !== null && o.soldAtMinor !== o.listPriceMinor));
        // A repeated request returns the sale that is already saved: it must not be noted twice.
        if (overrides.length > 0 && !audit.has("sale.discount", made.id)) {
          note(user, {
            action: "sale.discount",
            entity: "sale",
            entityId: made.id,
            summary: `Discount or price change on ${made.receiptNo}`,
            detail: { receiptNo: made.receiptNo, totalMinor: made.totalMinor, lines: overrides },
          });
        }
        return made;
      })();
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
              shifts.addCashMovement(shift.id, user.id, -cash, `Refund for voided ${sale.receiptNo}`, { type: "void", id: sale.id });
            } catch {
              throw new Error("There is not enough cash in the drawer to refund this sale");
            }
          }
        }
        const voided = sales.voidSale(saleId, reason);
        note(user, {
          action: "sale.void",
          entity: "sale",
          entityId: saleId,
          summary: `Voided ${sale.receiptNo} (${moneyText(sale.totalMinor)}): ${reason.trim()}`,
          detail: { receiptNo: sale.receiptNo, totalMinor: sale.totalMinor, reason: reason.trim(), fromEarlierShift: sale.shiftId !== shift.id },
        });
        return voided;
      })();
    },

    async refundSale(input) {
      const user = authorize("refund");
      const shift = openShiftOrThrow();
      return db.transaction(() => {
        const r = refunds.refund(input, { userId: user.id, userName: user.name, shiftId: shift.id });
        if (!audit.has("sale.refund", r.id)) {
          note(user, {
            action: "sale.refund",
            entity: "refund",
            entityId: r.id,
            summary: `Refunded ${moneyText(r.amountMinor)} on ${r.receiptNo} by ${r.method.replace("_", " ")}: ${r.reason}`,
            detail: { saleId: r.saleId, receiptNo: r.receiptNo, amountMinor: r.amountMinor, method: r.method, restock: r.restock, reference: r.reference, lines: r.lines.map((l) => ({ name: l.name, qty: l.qty, amountMinor: l.amountMinor })) },
          });
        }
        return r;
      })();
    },
    async refundableSale(saleId) {
      authorize("refund");
      return refunds.refundable(saleId);
    },
    async listAudit(query) {
      authorize("audit.view");
      return audit.list(query ?? {});
    },
    async recentRefunds(limit = 50) {
      authorize("refund");
      return refunds.recent(limit);
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
      db.transaction(() => {
        shifts.addCashMovement(shift.id, user.id, amountMinor, reason);
        note(user, { action: "cash.movement", entity: "shift", entityId: shift.id, summary: `${amountMinor > 0 ? "Cash put in" : "Cash taken out"}: ${moneyText(Math.abs(amountMinor))} (${reason.trim()})`, detail: { amountMinor, reason: reason.trim() } });
      })();
      return view(shifts.summary(shift.id), user);
    },
    async closeShift(countedCashMinor, note) {
      const user = authorize("sell");
      const shift = openShiftOrThrow();
      if (shift.userId !== user.id && !can(user.role, "shifts.manage_all")) {
        throw new Error("Only the person who opened the shift, or a manager, can close it");
      }
      const closed = db.transaction(() => {
        const sum = shifts.close(shift.id, countedCashMinor, note);
        audit.record({
          userId: user.id,
          userName: user.name,
          action: "shift.close",
          entity: "shift",
          entityId: shift.id,
          summary: `Closed shift: counted ${moneyText(countedCashMinor)}, expected ${moneyText(sum.expectedCashMinor)}`,
          detail: { expectedMinor: sum.expectedCashMinor, countedMinor: countedCashMinor, varianceMinor: countedCashMinor - sum.expectedCashMinor, note: note?.trim() || null },
        });
        return view(sum, user);
      })();
      hooks.afterShiftClose?.();
      return closed;
    },
    async recentShifts() {
      authorize("shifts.manage_all");
      return shifts.recent();
    },

    // ---- Catalogue and stock ------------------------------------------
    async createProduct(input, openingStock) {
      const user = authorize("products.manage");
      const created = db.transaction(() => {
        const p = products.create(input);
        if (openingStock !== undefined && openingStock !== 0) {
          inventory.adjust(p.id, openingStock, "opening stock");
          note(user, { action: "stock.adjust", entity: "product", entityId: p.id, summary: `Opening stock for ${p.name}: ${openingStock}`, detail: { name: p.name, qtyDelta: openingStock, reason: "opening stock" } });
        }
        return p;
      })();
      return one(created.id);
    },
    async updateProduct(id, patch) {
      const user = authorize("products.manage");
      db.transaction(() => {
        const before = products.get(id);
        products.update(id, patch);
        const after = products.get(id);
        if (before && after && (before.priceMinor !== after.priceMinor || before.costMinor !== after.costMinor || before.taxRateBp !== after.taxRateBp)) {
          note(user, {
            action: "product.price",
            entity: "product",
            entityId: id,
            summary: `Changed ${after.name}${before.priceMinor !== after.priceMinor ? `: price ${moneyText(before.priceMinor)} to ${moneyText(after.priceMinor)}` : ""}`,
            detail: {
              name: after.name,
              priceMinor: { from: before.priceMinor, to: after.priceMinor },
              costMinor: { from: before.costMinor, to: after.costMinor },
              taxRateBp: { from: before.taxRateBp, to: after.taxRateBp },
            },
          });
        }
      })();
      return one(id);
    },
    async adjustStock(productId, qtyDelta, reason) {
      const user = authorize("stock.adjust");
      const product = products.get(productId);
      if (!product) throw new Error("Product not found");
      db.transaction(() => {
        inventory.adjust(productId, qtyDelta, reason);
        note(user, { action: "stock.adjust", entity: "product", entityId: productId, summary: `Stock of ${product.name} changed by ${qtyDelta}: ${reason}`, detail: { name: product.name, qtyDelta, reason } });
      })();
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
        footer: footerWithCredit(s),
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
      const me = authorize("customers.manage");
      return db.transaction(() => {
        const before = customers.config() as unknown as Record<string, unknown>;
        const after = customers.setConfig(config);
        noteSettings(me, before, after as unknown as Record<string, unknown>, "Loyalty settings");
        return after;
      })();
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
    async dayCloseReport(date) {
      const user = authorize("reports.view");
      return dayClose.report(date, { includeProfit: can(user.role, "finance.view") });
    },

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
      const me = authorize("settings.manage");
      const manager = needBackups();
      // closeLive is called only after the backup has passed every check.
      manager.restore(name, where, () => db.close());
      // The restore replaced the whole file, so the note is parked and written into the restored data on start.
      if (hooks.dbPath && hooks.dbPath !== ":memory:") {
        try {
          queueAuditAfterRestore(hooks.dbPath, {
            userId: me.id,
            userName: me.name,
            action: "backup.restore",
            entity: "backup",
            entityId: name,
            summary: `Restored data from backup ${name} (${where === "second" ? "second place" : "this computer"})`,
            detail: { name, where },
          });
        } catch {
          /* the restore itself succeeded; never fail it over the note */
        }
      }
      current = null;
      hooks.afterRestore?.();
    },

    // ---- Reports and settings -----------------------------------------
    async salesSummary(from, to) {
      authorize("reports.view");
      return reports.salesSummary(from, to, 5);
    },
    async updateSettings(patch) {
      const me = authorize("settings.manage");
      return db.transaction(() => {
        const before = settings.get() as unknown as Record<string, unknown>;
        const after = settings.update(patch);
        noteSettings(me, before, after as unknown as Record<string, unknown>);
        return after;
      })();
    },

    // ---- Staff ---------------------------------------------------------
    async listStaff() {
      authorize("users.manage");
      return users.list({ includeInactive: true });
    },
    async createStaff(input) {
      const me = authorize("users.manage");
      return db.transaction(() => {
        const created = users.create(input);
        note(me, { action: "user.create", entity: "user", entityId: created.id, summary: `Added ${created.name} as ${created.role}`, detail: { name: created.name, role: created.role } });
        return created;
      })();
    },
    async updateStaff(id, patch) {
      const me = authorize("users.manage");
      const updated = db.transaction(() => {
        const before = users.get(id);
        const after = users.update(id, patch);
        note(me, {
          action: "user.update",
          entity: "user",
          entityId: id,
          summary: `Changed ${after.name}${before && before.role !== after.role ? `: role ${before.role} to ${after.role}` : ""}${before && before.active !== after.active ? (after.active ? ": reactivated" : ": deactivated") : ""}`,
          detail: { name: { from: before?.name ?? null, to: after.name }, role: { from: before?.role ?? null, to: after.role }, active: { from: before?.active ?? null, to: after.active } },
        });
        return after;
      })();
      if (id === me.id) current = updated.active ? updated : null;
      return updated;
    },
    async resetPin(userId, newPin) {
      const me = authorize("users.manage");
      db.transaction(() => {
        users.changePin(userId, newPin);
        const who = users.get(userId);
        note(me, { action: "user.pin_reset", entity: "user", entityId: userId, summary: `PIN reset for ${who?.name ?? "a user"}` });
      })();
    },
    async changeOwnPin(currentPin, newPin) {
      const me = authorize();
      users.authenticate(me.id, currentPin);
      db.transaction(() => {
        users.changePin(me.id, newPin);
        note(me, { action: "user.pin_change", entity: "user", entityId: me.id, summary: `${me.name} changed their own PIN` });
      })();
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
      const me = authorize("settings.manage");
      return db.transaction(() => {
        const before = printerConfig.get() as unknown as Record<string, unknown>;
        const after = printerConfig.set(config);
        noteSettings(me, before, after as unknown as Record<string, unknown>, "Printer settings");
        return after;
      })();
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
        (o) => statementJob(formatStatement(st, { storeName: s.storeName, currency: s.currency, locale: s.locale, width: o.chars, footer: footerWithCredit(s) }), o),
        { logo: true },
      );
    },
    async printTestPage(openDrawer) {
      authorize("settings.manage");
      const s = settings.get();
      return sendJob(
        (o) => {
          const rule = "-".repeat(o.chars);
          const text = [s.storeName.slice(0, o.chars), rule, "Printer test", `Paper: ${o.paper} mm (${o.chars} characters)`, "1234567890".repeat(5).slice(0, o.chars), rule, "If you can read this, printing works."].join("\n");
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
      const me = authorize("settings.manage");
      return db.transaction(() => {
        const before = business.get();
        const after = business.save(patch);
        // The first-run guide saves every step; only changes made once setup is finished are part of the trail.
        if (before.status === "complete") noteSettings(me, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, "Business profile");
        return after;
      })();
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
      return business.finish();
    },
    async restartOnboarding() {
      authorize("settings.manage");
      return business.restart();
    },
  };
}
