import type { Db } from "./db.js";
import { assertDate, dayEndISO, dayStartISO } from "./dates.js";
import { FinanceService, type ProfitAndLoss } from "./finance.js";
import { InventoryService, tidy, type LowStockItem } from "./inventory.js";
import { ExpenseService } from "./expenses.js";
import { PurchaseService } from "./purchases.js";
import { CustomerService, type Debtor } from "./customers.js";

export interface MethodTotal {
  /** "cash", "card", or the label of an "other" payment such as "wallet" or "JazzCash". */
  method: string;
  amountMinor: number;
}

export interface ProductPerformance {
  productId: string;
  name: string;
  qty: number;
  salesMinor: number;
  cogsMinor: number;
  profitMinor: number;
  costMissing: boolean;
}

export interface SlowProduct {
  productId: string;
  name: string;
  unit: string;
  qtySold: number;
  /** When it last sold at all (any date), or null if it never has. */
  lastSoldAt: string | null;
  stock: number;
}

export interface StockLine {
  productId: string;
  name: string;
  unit: string;
  stock: number;
  avgCostMinor: number;
  valueMinor: number;
  reorderLevel: number;
  low: boolean;
  /** No cost is known, so this line counts as zero in the stock value. */
  costMissing: boolean;
}

export interface SupplierLine {
  supplier: string;
  purchases: number;
  boughtMinor: number;
  paidMinor: number;
  /** What is still owed to this supplier in total, across all dates. */
  owedNowMinor: number;
}

export interface StaffLine {
  userId: string;
  name: string;
  salesCount: number;
  salesMinor: number;
  voidCount: number;
  averageSaleMinor: number;
}

export interface ShiftLine {
  shiftId: string;
  cashier: string;
  openedAt: string;
  closedAt: string | null;
  salesCount: number;
  salesMinor: number;
  openingCashMinor: number;
  countedCashMinor: number | null;
  varianceMinor: number | null;
}

export interface ReportCentre {
  from: string;
  to: string;
  generatedAt: string;
  pnl: ProfitAndLoss;
  /** Money actually received, by how it was paid. Cash is after change. Sales put on account are shown separately. */
  paymentMethods: MethodTotal[];
  onAccountMinor: number;
  topProducts: ProductPerformance[];
  slowProducts: SlowProduct[];
  stock: { valueMinor: number; lines: StockLine[]; low: LowStockItem[]; costMissingCount: number };
  suppliers: { lines: SupplierLine[]; boughtMinor: number; paidMinor: number; owedNowMinor: number };
  /** Every running cost in the range (cancelled ones left out), newest first. */
  expenseLines: { date: string; category: string; description: string; amountMinor: number }[];
  customers: { owing: Debtor[]; owedTotalMinor: number; creditSalesMinor: number; repaidMinor: number };
  staff: StaffLine[];
  shifts: ShiftLine[];
  /** Plain-words limits of these figures. Everything listed here is also shown on screen and in print. */
  notes: string[];
}

/** Everything the owner's report centre shows for one date range, computed from the database only. */
export class ReportCentreService {
  private readonly finance: FinanceService;
  private readonly inventory: InventoryService;
  private readonly purchases: PurchaseService;
  private readonly customers: CustomerService;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.finance = new FinanceService(db);
    this.inventory = new InventoryService(db);
    this.purchases = new PurchaseService(db);
    this.customers = new CustomerService(db);
  }

  build(from: string, to: string): ReportCentre {
    assertDate("From", from);
    assertDate("To", to);
    if (to < from) throw new Error("The end date cannot be before the start date");
    const start = dayStartISO(from);
    const end = dayEndISO(to);
    const pnl = this.finance.profitAndLoss(from, to);

    // ---- Payment methods: money received. Change is taken off cash. ---------------------------------------------
    const rows = this.db
      .prepare(
        `SELECT COALESCE(p.label, p.method) AS method, p.method AS base, SUM(p.amount_minor) AS amount
           FROM payments p JOIN sales s ON s.id = p.sale_id
          WHERE s.status = 'completed' AND s.created_at >= ? AND s.created_at < ?
          GROUP BY COALESCE(p.label, p.method), p.method`,
      )
      .all(start, end) as { method: string; base: string; amount: number }[];
    const change = (
      this.db
        .prepare("SELECT COALESCE(SUM(change_minor), 0) AS c, COALESCE(SUM(on_account_minor), 0) AS a FROM sales WHERE status = 'completed' AND created_at >= ? AND created_at < ?")
        .get(start, end) as { c: number; a: number }
    );
    const methods = new Map<string, number>();
    for (const r of rows) methods.set(r.method, (methods.get(r.method) ?? 0) + r.amount);
    if (change.c > 0) methods.set("cash", (methods.get("cash") ?? 0) - change.c);
    const paymentMethods = [...methods.entries()]
      .map(([method, amountMinor]) => ({ method, amountMinor }))
      .filter((m) => m.amountMinor !== 0)
      .sort((a, b) => b.amountMinor - a.amountMinor);

    // ---- Products ------------------------------------------------------------------------------------------------
    const real = pnl.items.filter((i) => this.isSellable(i.productId));
    const topProducts: ProductPerformance[] = [...real]
      .sort((a, b) => b.salesMinor - a.salesMinor || b.qty - a.qty)
      .slice(0, 10)
      .map((i) => ({ productId: i.productId, name: i.name, qty: i.qty, salesMinor: i.salesMinor, cogsMinor: i.cogsMinor, profitMinor: i.profitMinor, costMissing: i.costMissing }));

    const levels = this.inventory.stockLevels();
    const slowRows = this.db
      .prepare(
        `SELECT p.id AS productId, p.name AS name, p.unit AS unit,
                COALESCE((SELECT SUM(si.qty) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                           WHERE si.product_id = p.id AND s.status = 'completed' AND s.created_at >= ? AND s.created_at < ?), 0) AS qtySold,
                (SELECT MAX(s.created_at) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                  WHERE si.product_id = p.id AND s.status = 'completed') AS lastSoldAt
           FROM products p
          WHERE p.active = 1 AND p.is_system = 0 AND p.kind <> 'ingredient'`,
      )
      .all(start, end) as { productId: string; name: string; unit: string; qtySold: number; lastSoldAt: string | null }[];
    const slowProducts: SlowProduct[] = slowRows
      .sort((a, b) => a.qtySold - b.qtySold || a.name.localeCompare(b.name))
      .slice(0, 10)
      .map((r) => ({ ...r, qtySold: tidy(r.qtySold), stock: tidy(levels[r.productId] ?? 0) }));

    // ---- Stock (right now, not limited to the range) -------------------------------------------------------------
    const low = this.inventory.lowStock();
    const lowIds = new Set(low.map((l) => l.productId));
    const stockRows = this.db
      .prepare("SELECT id, name, unit, avg_cost AS cost, reorder_level AS reorder FROM products WHERE active = 1 AND track_stock = 1 AND is_system = 0 ORDER BY name COLLATE NOCASE")
      .all() as { id: string; name: string; unit: string; cost: number; reorder: number }[];
    const lines: StockLine[] = stockRows.map((r) => {
      const stock = tidy(levels[r.id] ?? 0);
      return {
        productId: r.id,
        name: r.name,
        unit: r.unit,
        stock,
        avgCostMinor: Math.round(r.cost),
        valueMinor: Math.round(Math.max(0, stock) * r.cost),
        reorderLevel: r.reorder,
        low: lowIds.has(r.id),
        costMissing: r.cost === 0 && stock > 0,
      };
    });

    // ---- Suppliers -----------------------------------------------------------------------------------------------
    const bought = this.db
      .prepare(
        `SELECT COALESCE(supplier, 'Unnamed supplier') AS supplier, COUNT(*) AS purchases,
                SUM(total_minor) AS bought, SUM(paid_minor) AS paid
           FROM purchases WHERE created_at >= ? AND created_at < ? GROUP BY COALESCE(supplier, 'Unnamed supplier')`,
      )
      .all(start, end) as { supplier: string; purchases: number; bought: number; paid: number }[];
    const owedNow = new Map(this.purchases.payables().bySupplier.map((s) => [s.supplier, s.outstandingMinor]));
    const names = new Set([...bought.map((b) => b.supplier), ...owedNow.keys()]);
    const supplierLines: SupplierLine[] = [...names]
      .map((supplier) => {
        const b = bought.find((x) => x.supplier === supplier);
        return { supplier, purchases: b?.purchases ?? 0, boughtMinor: b?.bought ?? 0, paidMinor: b?.paid ?? 0, owedNowMinor: owedNow.get(supplier) ?? 0 };
      })
      .sort((a, b) => b.owedNowMinor - a.owedNowMinor || b.boughtMinor - a.boughtMinor || a.supplier.localeCompare(b.supplier));

    // ---- Customers and Khata -------------------------------------------------------------------------------------
    const owing = this.customers.owing();
    const ledger = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN reason = 'credit_sale' THEN delta END), 0) AS sold,
                COALESCE(SUM(CASE WHEN reason = 'repayment' THEN -delta END), 0) AS repaid
           FROM customer_ledger WHERE account = 'credit' AND created_at >= ? AND created_at < ?`,
      )
      .get(start, end) as { sold: number; repaid: number };

    // ---- Staff and shifts ----------------------------------------------------------------------------------------
    const staff = this.db
      .prepare(
        `SELECT u.id AS userId, u.name AS name,
                SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS salesCount,
                COALESCE(SUM(CASE WHEN s.status = 'completed' THEN s.subtotal_minor - s.discount_minor END), 0) AS salesMinor,
                SUM(CASE WHEN s.status = 'void' THEN 1 ELSE 0 END) AS voidCount
           FROM sales s JOIN users u ON u.id = s.user_id
          WHERE s.created_at >= ? AND s.created_at < ? GROUP BY u.id ORDER BY salesMinor DESC, u.name`,
      )
      .all(start, end) as { userId: string; name: string; salesCount: number; salesMinor: number; voidCount: number }[];
    const shifts = this.db
      .prepare(
        `SELECT sh.id AS shiftId, u.name AS cashier, sh.opened_at AS openedAt, sh.closed_at AS closedAt,
                sh.opening_cash_minor AS openingCashMinor, sh.counted_cash_minor AS countedCashMinor, sh.variance_minor AS varianceMinor,
                (SELECT COUNT(*) FROM sales s WHERE s.shift_id = sh.id AND s.status = 'completed') AS salesCount,
                COALESCE((SELECT SUM(s.subtotal_minor - s.discount_minor) FROM sales s WHERE s.shift_id = sh.id AND s.status = 'completed'), 0) AS salesMinor
           FROM shifts sh JOIN users u ON u.id = sh.user_id
          WHERE sh.opened_at >= ? AND sh.opened_at < ? ORDER BY sh.opened_at`,
      )
      .all(start, end) as ShiftLine[];

    // ---- Honesty -------------------------------------------------------------------------------------------------
    const notes: string[] = [...pnl.warnings];
    const missing = lines.filter((l) => l.costMissing);
    if (missing.length > 0) notes.push(`${missing.length} stocked item${missing.length > 1 ? "s have" : " has"} no cost, so ${missing.length > 1 ? "they count" : "it counts"} as zero in the stock value.`);
    notes.push("Stock value, supplier balances and customer balances are as of now, not limited to the dates chosen.");
    notes.push("Profit over time shows gross profit (sales minus the cost of what was sold). Running costs and wages are only subtracted in the period totals, because they are not tied to a single day.");

    return {
      from,
      to,
      generatedAt: new Date(this.now()).toISOString(),
      pnl,
      paymentMethods,
      onAccountMinor: change.a,
      topProducts,
      slowProducts,
      stock: { valueMinor: this.inventory.stockValue(), lines, low, costMissingCount: missing.length },
      suppliers: {
        lines: supplierLines,
        boughtMinor: bought.reduce((s, b) => s + b.bought, 0),
        paidMinor: bought.reduce((s, b) => s + b.paid, 0),
        owedNowMinor: [...owedNow.values()].reduce((s, n) => s + n, 0),
      },
      expenseLines: new ExpenseService(this.db).list(from, to).filter((e) => !e.voided).map((e) => ({ date: e.spentOn, category: e.category, description: e.description, amountMinor: e.amountMinor })),
      customers: { owing, owedTotalMinor: owing.reduce((s, d) => s + d.owedMinor, 0), creditSalesMinor: ledger.sold, repaidMinor: ledger.repaid },
      staff: staff.map((r) => ({ ...r, averageSaleMinor: r.salesCount ? Math.round(r.salesMinor / r.salesCount) : 0 })),
      shifts,
      notes,
    };
  }

  private isSellable(productId: string): boolean {
    const r = this.db.prepare("SELECT is_system AS s FROM products WHERE id = ?").get(productId) as { s: number } | undefined;
    return !!r && r.s === 0;
  }
}
