import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { CustomerSummary } from "./customers.js";
import { allocateDiscount } from "./discount.js";
import { assertWithinCreditLimit, customerSummary, loyaltyConfig, plainAmount, pointsFor, postLedger, reverseSaleLedger } from "./customers.js";
import { taxFor } from "./money.js";

export type PaymentMethod = "cash" | "card" | "other";

export interface CartLine {
  productId: string;
  qty: number;
  /** Override the catalogue price (minor units). */
  unitPriceMinor?: number;
  /** Discount on this line (minor units). */
  discountMinor?: number;
}

export interface PaymentInput {
  method: PaymentMethod;
  amountMinor: number;
}

export interface CheckoutInput {
  lines: CartLine[];
  payments: PaymentInput[];
  cashier?: string;
  /** Allow selling more than is in stock. Default: false. */
  allowNegativeStock?: boolean;
  /** The open shift this sale belongs to, and who rang it up. */
  shiftId?: string;
  userId?: string;
  /** The customer this sale is for. Needed to earn or use points, or to pay from a wallet. */
  customerId?: string | null;
  /** Loyalty points to use as a discount on the items (not on a delivery charge). */
  redeemPoints?: number;
  /** Money to take from the customer's wallet (minor units). It counts as a payment. */
  walletMinor?: number;
  /**
   * The part of the bill the customer will pay later (khata). It is income now, but not money received, so
   * it is not a payment and never reaches the drawer. Needs a customer, and respects their credit limit.
   */
  onAccountMinor?: number;
}

export interface SaleItem {
  id: string;
  productId: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBp: number;
  taxMinor: number;
  totalMinor: number;
  /** What the ingredients or goods sold on this line cost at the time of sale. */
  cogsMinor: number;
}

export interface Payment {
  id: string;
  method: PaymentMethod;
  amountMinor: number;
  /** Names an "other" payment, e.g. "wallet". */
  label: string | null;
}

export interface Sale {
  id: string;
  /** For orders taken through the order screen: e.g. "Token 12 · Dine-in · Table 5". */
  orderLabel: string | null;
  receiptNo: string;
  status: "completed" | "void";
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** Money actually received now (cash, card, other, wallet). Does not include `onAccountMinor`. */
  paidMinor: number;
  changeMinor: number;
  /** The part of the total put on the customer's account (khata) to be paid later. */
  onAccountMinor: number;
  cashier: string | null;
  voidReason: string | null;
  shiftId: string | null;
  userId: string | null;
  createdAt: string;
  voidedAt: string | null;
  items: SaleItem[];
  payments: Payment[];
  customerId: string | null;
  /** The customer's name and balances after this sale (current, not as at the sale). */
  customer: CustomerSummary | null;
  pointsEarned: number;
  pointsRedeemed: number;
}

interface ProductRow {
  id: string;
  name: string;
  kind: string;
  unit: string;
  price_minor: number;
  tax_rate_bp: number;
  track_stock: number;
  avg_cost: number;
  active: number;
  is_system: number;
}

/** One stock item used up by a sale line: the product itself, or an ingredient of its recipe. */
interface Use {
  productId: string;
  name: string;
  unit: string;
  qty: number;
  avgCost: number;
  track: boolean;
}

const fmtQty = (n: number): string => String(Math.round(n * 1000) / 1000);

export class SaleService {
  constructor(
    private readonly db: Db,
    /** Short prefix for receipt numbers, e.g. a till or branch code. */
    private readonly receiptPrefix = "R",
  ) {}

  /**
   * Complete a sale in one database transaction: price the lines, check
   * stock and payment, write the sale, use up stock (ingredients, for menu items
   * with a recipe) and record what it all cost. If anything fails, nothing is saved.
   */
  checkout(input: CheckoutInput): Sale {
    if (input.lines.length === 0) throw new Error("The cart is empty");

    const run = this.db.transaction((): string => {
      const now = new Date().toISOString();
      const saleId = randomUUID();

      let subtotal = 0;
      let discount = 0;
      let tax = 0;

      const getProduct = this.db.prepare(
        `SELECT id, name, kind, unit, price_minor, tax_rate_bp, track_stock, avg_cost, active, is_system
           FROM products WHERE id = ?`,
      );
      const getRecipe = this.db.prepare(
        `SELECT ri.ingredient_id AS id, i.name AS name, i.unit AS unit, i.track_stock AS track,
                i.avg_cost AS avgCost, ri.qty AS qty
           FROM recipe_items ri JOIN products i ON i.id = ri.ingredient_id
          WHERE ri.product_id = ?`,
      );
      const stockOf = this.db.prepare(
        "SELECT COALESCE(SUM(qty_delta), 0) AS q FROM stock_movements WHERE product_id = ?",
      );

      // Total needed per stock item across the whole cart, so two lines that
      // both use the same chicken are checked together.
      const needs = new Map<string, { name: string; unit: string; qty: number }>();

      const priced = input.lines.map((line) => {
        if (!(line.qty > 0) || !Number.isFinite(line.qty)) {
          throw new Error("Quantity must be greater than zero");
        }
        const p = getProduct.get(line.productId) as ProductRow | undefined;
        if (!p) throw new Error(`Product not found: ${line.productId}`);
        if (p.active !== 1) throw new Error(`Product is inactive: ${p.name}`);
        if (p.kind !== "product") throw new Error(`${p.name} is an ingredient and cannot be sold`);

        const unit = line.unitPriceMinor ?? p.price_minor;
        const lineDiscount = line.discountMinor ?? 0;
        if (!Number.isInteger(unit) || unit < 0) {
          throw new Error("Unit price must be a non-negative integer");
        }
        if (!Number.isInteger(lineDiscount) || lineDiscount < 0) {
          throw new Error("Discount must be a non-negative integer");
        }
        const gross = Math.round(line.qty * unit);
        if (lineDiscount > gross) {
          throw new Error(`Discount is larger than the line total for ${p.name}`);
        }

        const recipe = getRecipe.all(p.id) as {
          id: string;
          name: string;
          unit: string;
          track: number;
          avgCost: number;
          qty: number;
        }[];
        const uses: Use[] =
          recipe.length > 0
            ? recipe.map((r) => ({
                productId: r.id,
                name: r.name,
                unit: r.unit,
                qty: r.qty * line.qty,
                avgCost: r.avgCost,
                track: r.track === 1,
              }))
            : [
                {
                  productId: p.id,
                  name: p.name,
                  unit: p.unit,
                  qty: line.qty,
                  avgCost: p.avg_cost,
                  track: p.track_stock === 1,
                },
              ];
        for (const u of uses) {
          if (!u.track) continue;
          const cur = needs.get(u.productId);
          if (cur) cur.qty += u.qty;
          else needs.set(u.productId, { name: u.name, unit: u.unit, qty: u.qty });
        }
        const cogs = uses.reduce((sum, u) => sum + Math.round(u.qty * u.avgCost), 0);

        return { p, qty: line.qty, unit, gross, lineDiscount, lineTax: 0, total: 0, uses, cogs };
      });

      // Customer, points and wallet. The points discount comes off the food lines only, shared out in
      // proportion to what each line costs, before tax is worked out, so tax stays correct per line.
      const customerId = input.customerId ?? null;
      const redeem = input.redeemPoints ?? 0;
      const walletWanted = input.walletMinor ?? 0;
      if (!Number.isInteger(walletWanted) || walletWanted < 0) throw new Error("The wallet amount must be a whole number of 0 or more");
      const onAccount = input.onAccountMinor ?? 0;
      if (!Number.isInteger(onAccount) || onAccount < 0) throw new Error("The amount to put on account must be a whole number of 0 or more");
      if (!Number.isInteger(redeem) || redeem < 0) throw new Error("Points to use must be a whole number of 0 or more");
      let cust: { id: string; name: string; points: number; wallet: number } | undefined;
      if (customerId) {
        cust = this.db.prepare("SELECT id, name, points, wallet_minor AS wallet FROM customers WHERE id = ?").get(customerId) as typeof cust;
        if (!cust) throw new Error("Customer not found");
      } else if (redeem > 0 || walletWanted > 0) {
        throw new Error("Choose a customer to use points or a wallet");
      } else if (onAccount > 0) {
        throw new Error("Choose a customer to put this on account");
      }
      const cfg = loyaltyConfig(this.db);
      const eligible = priced.map((x) => (x.p.is_system === 1 ? 0 : x.gross - x.lineDiscount));
      const eligibleTotal = eligible.reduce((a, b) => a + b, 0);
      let loyaltyDiscount = 0;
      if (redeem > 0) {
        if (cfg.pointValueMinor <= 0) throw new Error("Points cannot be used as a discount right now");
        if (redeem > cust!.points) throw new Error(`${cust!.name} has ${cust!.points} point${cust!.points === 1 ? "" : "s"}, not ${redeem}`);
        loyaltyDiscount = redeem * cfg.pointValueMinor;
        if (loyaltyDiscount > eligibleTotal) {
          throw new Error(`Points can only pay for the items on the bill. The most that can be used here is ${Math.floor(eligibleTotal / cfg.pointValueMinor)}`);
        }
      }
      const shares = allocateDiscount(eligible, loyaltyDiscount);
      let eligibleNetAfter = 0;
      priced.forEach((x, i) => {
        x.lineDiscount += shares[i]!;
        const net = x.gross - x.lineDiscount;
        x.lineTax = taxFor(net, x.p.tax_rate_bp);
        x.total = net + x.lineTax;
        if (x.p.is_system !== 1) eligibleNetAfter += net;
        subtotal += x.gross;
        discount += x.lineDiscount;
        tax += x.lineTax;
      });

      if (!input.allowNegativeStock) {
        for (const [id, need] of needs) {
          const have = (stockOf.get(id) as { q: number }).q;
          if (have + 1e-9 < need.qty) {
            throw new Error(
              `Not enough stock for ${need.name} (have ${fmtQty(have)} ${need.unit}, need ${fmtQty(need.qty)} ${need.unit})`,
            );
          }
        }
      }

      const total = subtotal - discount + tax;

      if (walletWanted > 0) {
        if (walletWanted > cust!.wallet) {
          throw new Error(`${cust!.name}'s wallet has ${plainAmount(cust!.wallet)}, not ${plainAmount(walletWanted)}`);
        }
        if (walletWanted > total) throw new Error("The wallet amount is more than the bill");
      }
      if (onAccount > 0) {
        if (walletWanted + onAccount > total) throw new Error("The wallet and the amount on account are more than the bill");
        assertWithinCreditLimit(this.db, cust!.id, onAccount);
      }
      const allPayments: { method: PaymentMethod; amountMinor: number; label: string | null }[] = [
        ...input.payments.map((x) => ({ ...x, label: null })),
        ...(walletWanted > 0 ? [{ method: "other" as const, amountMinor: walletWanted, label: "wallet" }] : []),
      ];
      if (allPayments.length === 0 && total - onAccount > 0) throw new Error("A payment is required");
      const earned = cust ? pointsFor(eligibleNetAfter, cfg) : 0;

      for (const pay of input.payments) {
        if (!Number.isInteger(pay.amountMinor) || pay.amountMinor <= 0) {
          throw new Error("Payment amounts must be positive integers");
        }
      }
      const paid = allPayments.reduce((s, x) => s + x.amountMinor, 0);
      // What must be paid now is the bill less what goes on account.
      const dueNow = total - onAccount;
      if (paid < dueNow) {
        throw new Error(`Payment is short by ${plainAmount(dueNow - paid)}`);
      }
      const change = paid - dueNow;
      const cashPaid = allPayments
        .filter((x) => x.method === "cash")
        .reduce((s, x) => s + x.amountMinor, 0);
      if (change > cashPaid) {
        throw new Error("Change can only be given from a cash payment");
      }

      const receiptNo = this.nextReceiptNo();
      this.db
        .prepare(
          `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor,
             tax_minor, total_minor, paid_minor, change_minor, cashier, created_at,
             shift_id, user_id, customer_id, points_earned, points_redeemed, on_account_minor)
           VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          saleId,
          receiptNo,
          subtotal,
          discount,
          tax,
          total,
          paid,
          change,
          input.cashier ?? null,
          now,
          input.shiftId ?? null,
          input.userId ?? null,
          customerId,
          earned,
          redeem,
          onAccount,
        );

      const insItem = this.db.prepare(
        `INSERT INTO sale_items (id, sale_id, product_id, name, qty, unit_price_minor,
           discount_minor, tax_rate_bp, tax_minor, total_minor, cogs_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insMove = this.db.prepare(
        `INSERT INTO stock_movements
           (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor)
         VALUES (?, ?, ?, 'sale', 'sale', ?, ?, ?)`,
      );
      for (const x of priced) {
        insItem.run(
          randomUUID(),
          saleId,
          x.p.id,
          x.p.name,
          x.qty,
          x.unit,
          x.lineDiscount,
          x.p.tax_rate_bp,
          x.lineTax,
          x.total,
          x.cogs,
        );
        for (const u of x.uses) {
          if (u.track) {
            insMove.run(randomUUID(), u.productId, -u.qty, saleId, now, -Math.round(u.qty * u.avgCost));
          }
        }
      }

      const insPay = this.db.prepare(
        "INSERT INTO payments (id, sale_id, method, amount_minor, label) VALUES (?, ?, ?, ?, ?)",
      );
      for (const pay of allPayments) {
        insPay.run(randomUUID(), saleId, pay.method, pay.amountMinor, pay.label);
      }

      // The customer's ledger: points used, wallet spent, points earned.
      if (cust) {
        const post = (account: "points" | "wallet", delta: number, reason: "earn" | "redeem" | "spend") => {
          if (delta !== 0) postLedger(this.db, { customerId: cust!.id, account, delta, reason, saleId, userId: input.userId });
        };
        post("points", -redeem, "redeem");
        post("wallet", -walletWanted, "spend");
        post("points", earned, "earn");
        if (onAccount > 0) postLedger(this.db, { customerId: cust.id, account: "credit", delta: onAccount, reason: "credit_sale", saleId, userId: input.userId });
      }
      return saleId;
    });

    return this.mustGet(run());
  }

  /**
   * Void a completed sale and put its stock back. The stock movements made by the
   * sale are reversed exactly (same items, same quantities, same cost), so recipes
   * and costs stay correct. Cannot be undone.
   */
  voidSale(saleId: string, reason: string): Sale {
    if (!reason.trim()) throw new Error("A reason is required to void a sale");
    this.db.transaction(() => {
      const sale = this.db
        .prepare("SELECT status FROM sales WHERE id = ?")
        .get(saleId) as { status: string } | undefined;
      if (!sale) throw new Error(`Sale not found: ${saleId}`);
      if (sale.status === "void") throw new Error("Sale is already void");

      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE sales SET status='void', void_reason=?, voided_at=? WHERE id=?",
        )
        .run(reason.trim(), now, saleId);
      // Give back points and wallet money the sale used, and take back the points it earned.
      reverseSaleLedger(this.db, saleId);

      const original = this.db
        .prepare(
          `SELECT product_id AS productId, qty_delta AS qty, value_minor AS value
             FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ? AND reason = 'sale'`,
        )
        .all(saleId) as { productId: string; qty: number; value: number }[];
      const insMove = this.db.prepare(
        `INSERT INTO stock_movements
           (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor)
         VALUES (?, ?, ?, 'void', 'sale', ?, ?, ?)`,
      );
      for (const m of original) {
        insMove.run(randomUUID(), m.productId, -m.qty, saleId, now, -m.value);
      }
    })();
    return this.mustGet(saleId);
  }

  get(saleId: string): Sale | undefined {
    const s = this.db.prepare("SELECT * FROM sales WHERE id = ?").get(saleId) as
      | Record<string, unknown>
      | undefined;
    if (!s) return undefined;

    const items = (
      this.db
        .prepare("SELECT * FROM sale_items WHERE sale_id = ? ORDER BY rowid")
        .all(saleId) as Record<string, unknown>[]
    ).map(
      (r): SaleItem => ({
        id: r.id as string,
        productId: r.product_id as string,
        name: r.name as string,
        qty: r.qty as number,
        unitPriceMinor: r.unit_price_minor as number,
        discountMinor: r.discount_minor as number,
        taxRateBp: r.tax_rate_bp as number,
        taxMinor: r.tax_minor as number,
        totalMinor: r.total_minor as number,
        cogsMinor: (r.cogs_minor as number | undefined) ?? 0,
      }),
    );
    const payments = (
      this.db
        .prepare("SELECT * FROM payments WHERE sale_id = ? ORDER BY rowid")
        .all(saleId) as Record<string, unknown>[]
    ).map(
      (r): Payment => ({
        id: r.id as string,
        method: r.method as PaymentMethod,
        amountMinor: r.amount_minor as number,
        label: (r.label as string | null) ?? null,
      }),
    );

    const ord = this.db
      .prepare("SELECT token, type, table_label AS tbl FROM orders WHERE sale_id = ?")
      .get(saleId) as { token: number; type: string; tbl: string | null } | undefined;
    const typeName: Record<string, string> = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
    const orderLabel = ord
      ? `Token ${ord.token} · ${typeName[ord.type] ?? ord.type}${ord.tbl ? ` · Table ${ord.tbl}` : ""}`
      : null;

    return {
      id: s.id as string,
      orderLabel,
      receiptNo: s.receipt_no as string,
      status: s.status as "completed" | "void",
      subtotalMinor: s.subtotal_minor as number,
      discountMinor: s.discount_minor as number,
      taxMinor: s.tax_minor as number,
      totalMinor: s.total_minor as number,
      paidMinor: s.paid_minor as number,
      changeMinor: s.change_minor as number,
      onAccountMinor: (s.on_account_minor as number | undefined) ?? 0,
      cashier: (s.cashier as string | null) ?? null,
      voidReason: (s.void_reason as string | null) ?? null,
      shiftId: (s.shift_id as string | null) ?? null,
      userId: (s.user_id as string | null) ?? null,
      createdAt: s.created_at as string,
      voidedAt: (s.voided_at as string | null) ?? null,
      items,
      payments,
      customerId: (s.customer_id as string | null) ?? null,
      customer: s.customer_id ? customerSummary(this.db, s.customer_id as string) : null,
      pointsEarned: (s.points_earned as number | undefined) ?? 0,
      pointsRedeemed: (s.points_redeemed as number | undefined) ?? 0,
    };
  }

  /** Most recent sales first, including voided ones. */
  recent(limit = 50): Sale[] {
    const ids = this.db
      .prepare("SELECT id FROM sales ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as { id: string }[];
    return ids.map((r) => this.mustGet(r.id));
  }

  findByReceiptNo(receiptNo: string): Sale | undefined {
    const row = this.db
      .prepare("SELECT id FROM sales WHERE receipt_no = ?")
      .get(receiptNo) as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
  }

  private nextReceiptNo(): string {
    this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES ('receipt', 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1`,
      )
      .run();
    const { value } = this.db
      .prepare("SELECT value FROM counters WHERE name = 'receipt'")
      .get() as { value: number };
    return `${this.receiptPrefix}-${String(value).padStart(6, "0")}`;
  }

  private mustGet(id: string): Sale {
    const s = this.get(id);
    if (!s) throw new Error(`Sale not found: ${id}`);
    return s;
  }
}
