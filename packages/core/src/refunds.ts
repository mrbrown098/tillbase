import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { postLedger } from "./customers.js";
import { plainAmount } from "./customers.js";
import { ShiftService } from "./shifts.js";

export type RefundMethod = "cash" | "card" | "bank_transfer" | "other";
const methods: RefundMethod[] = ["cash", "card", "bank_transfer", "other"];

export interface RefundLineInput {
  saleItemId: string;
  qty: number;
}

export interface RefundInput {
  saleId: string;
  lines: RefundLineInput[];
  reason: string;
  restock: boolean;
  method: RefundMethod;
  reference?: string | null;
  requestId?: string;
}

export interface RefundLine {
  saleItemId: string;
  productId: string;
  name: string;
  qty: number;
  amountMinor: number;
  taxMinor: number;
  restocked: boolean;
}

export interface Refund {
  id: string;
  saleId: string;
  receiptNo: string;
  shiftId: string | null;
  userId: string;
  userName: string;
  reason: string;
  method: RefundMethod;
  reference: string | null;
  restock: boolean;
  amountMinor: number;
  taxMinor: number;
  lines: RefundLine[];
  createdAt: string;
}

/** One line of a sale as seen by the refund screen. */
export interface RefundableLine {
  saleItemId: string;
  productId: string;
  name: string;
  qty: number;
  refundedQty: number;
  remainingQty: number;
  /** What the whole line cost the customer, tax included, after its discount. */
  lineTotalMinor: number;
  /** What the remaining quantity would return, tax included. */
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

/** Who is refunding and which shift's drawer is open. */
export interface RefundContext {
  userId: string;
  userName: string;
  /** The shift open right now. Every refund belongs to the shift in which it was made. */
  shiftId: string;
}

interface ItemRow {
  id: string;
  sale_id: string;
  product_id: string;
  name: string;
  qty: number;
  total_minor: number;
  tax_minor: number;
  cogs_minor: number;
}

const EPS = 1e-9;

/**
 * The part of `whole` that belongs to the first `qty` of `itemQty` units, in whole minor units. At the full
 * quantity it is exactly `whole`, so a line refunded in several parts always adds up to the line, to the cent.
 */
function cumulative(whole: number, qty: number, itemQty: number): number {
  if (qty >= itemQty - EPS) return whole;
  if (qty <= EPS) return 0;
  return Math.round((whole * qty) / itemQty);
}

/** Same idea for a stock quantity (a REAL): exact at the full quantity, proportional before it. */
function cumulativeQty(whole: number, qty: number, itemQty: number): number {
  if (qty >= itemQty - EPS) return whole;
  if (qty <= EPS) return 0;
  return (whole * qty) / itemQty;
}

export class RefundService {
  constructor(private readonly db: Db) {}

  /**
   * Hand part of a sale back. In one transaction: check what is left on each line, record the refund (it
   * is its own record dated now and never edits the sale), put the goods back in stock at the cost they
   * were sold at when `restock` is true, take back a share of any loyalty points the sale earned, and for
   * a cash refund take the money out of the open drawer as a visible cash movement. Nothing about a closed
   * shift changes: the money always comes out of the shift that is open now.
   */
  refund(input: RefundInput, ctx: RefundContext): Refund {
    const reason = (input.reason ?? "").trim();
    if (!reason) throw new Error("A reason is required to refund a sale");
    if (reason.length > 200) throw new Error("The reason can be at most 200 characters");
    if (!methods.includes(input.method)) throw new Error("Choose how the money is handed back");
    const reference = input.reference?.trim() || null;
    if (reference !== null && reference.length > 80) throw new Error("A refund reference can be at most 80 characters");
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error("Choose at least one item to refund");
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (!Number.isFinite(l.qty) || !(l.qty > 0)) throw new Error("The quantity to refund must be more than zero");
      if (seen.has(l.saleItemId)) throw new Error("Each item can only be listed once");
      seen.add(l.saleItemId);
    }
    const requestId = input.requestId === undefined ? null : input.requestId.trim();
    if (requestId !== null && (requestId.length < 8 || requestId.length > 100)) {
      throw new Error("The request id must be 8 to 100 characters");
    }

    const id = this.db.transaction((): string => {
      if (requestId !== null) {
        const done = this.db.prepare("SELECT id FROM refunds WHERE request_id = ?").get(requestId) as { id: string } | undefined;
        if (done) return done.id;
      }
      const sale = this.db
        .prepare("SELECT id, receipt_no AS receiptNo, status, total_minor AS total, on_account_minor AS onAccount, points_redeemed AS redeemed, points_earned AS earned, customer_id AS customerId, items_linked AS linked FROM sales WHERE id = ?")
        .get(input.saleId) as
        | { id: string; receiptNo: string; status: string; total: number; onAccount: number; redeemed: number; earned: number; customerId: string | null; linked: number }
        | undefined;
      if (!sale) throw new Error("Sale not found");
      const blocked = this.blockedReason(sale.id, sale.status, sale.onAccount, sale.redeemed);
      if (blocked) throw new Error(blocked);

      const now = new Date().toISOString();
      const refundId = randomUUID();
      const getItem = this.db.prepare("SELECT id, sale_id, product_id, name, qty, total_minor, tax_minor, cogs_minor FROM sale_items WHERE id = ?");
      const refundedBefore = this.db.prepare("SELECT COALESCE(SUM(qty), 0) AS q FROM refund_items WHERE sale_item_id = ?");
      const movesOf = this.db.prepare(
        `SELECT product_id AS productId, qty_delta AS qty, value_minor AS value
           FROM stock_movements WHERE sale_item_id = ? AND reason = 'sale'`,
      );

      let amount = 0;
      let tax = 0;
      let cogs = 0;
      const lines: { item: ItemRow; qty: number; amount: number; tax: number; cogs: number; moves: { productId: string; qty: number; value: number }[] }[] = [];
      for (const l of input.lines) {
        const item = getItem.get(l.saleItemId) as ItemRow | undefined;
        if (!item || item.sale_id !== sale.id) throw new Error("That item is not on this sale");
        const before = (refundedBefore.get(item.id) as { q: number }).q;
        const left = item.qty - before;
        if (l.qty > left + EPS) {
          throw new Error(left <= EPS ? `${item.name} has already been refunded` : `Only ${fmtQty(left)} of ${item.name} is left to refund`);
        }
        const after = before + l.qty;
        const part = (whole: number) => cumulative(whole, after, item.qty) - cumulative(whole, before, item.qty);
        const lineAmount = part(item.total_minor);
        const lineTax = part(item.tax_minor);
        const lineCogs = part(item.cogs_minor);

        // What this line used from stock, exactly as the sale recorded it.
        let moves: { productId: string; qty: number; value: number }[] = [];
        if (input.restock) {
          if (sale.linked === 1) {
            const logged = movesOf.all(item.id) as { productId: string; qty: number; value: number }[];
            moves = logged.map((m) => ({
              productId: m.productId,
              qty: -(cumulativeQty(m.qty, after, item.qty) - cumulativeQty(m.qty, before, item.qty)),
              value: -(cumulative(m.value, after, item.qty) - cumulative(m.value, before, item.qty)),
            }));
          } else {
            moves = this.legacyMoves(sale.id, item, before, after);
          }
        }
        amount += lineAmount;
        tax += lineTax;
        cogs += input.restock ? lineCogs : 0;
        lines.push({ item, qty: l.qty, amount: lineAmount, tax: lineTax, cogs: input.restock ? lineCogs : 0, moves });
      }
      if (amount <= 0) throw new Error("There is nothing to refund on those items");

      // Loyalty: take back the share of earned points that matches the share of the bill handed back.
      let pointsBack = 0;
      if (sale.customerId && sale.earned > 0) {
        const prior = this.db.prepare("SELECT COALESCE(SUM(amount_minor), 0) AS a, COALESCE(SUM(points_reversed), 0) AS p FROM refunds WHERE sale_id = ?").get(sale.id) as { a: number; p: number };
        const after = prior.a + amount;
        const target = after >= sale.total ? sale.earned : Math.round((sale.earned * after) / sale.total);
        const have = (this.db.prepare("SELECT points FROM customers WHERE id = ?").get(sale.customerId) as { points: number }).points;
        pointsBack = Math.max(0, Math.min(target - prior.p, have));
      }

      this.db
        .prepare(
          `INSERT INTO refunds (id, sale_id, shift_id, user_id, user_name, reason, method, reference, restock,
             amount_minor, tax_minor, cogs_minor, points_reversed, request_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(refundId, sale.id, ctx.shiftId, ctx.userId, ctx.userName, reason, input.method, reference, input.restock ? 1 : 0, amount, tax, cogs, pointsBack, requestId, now);

      const insItem = this.db.prepare(
        "INSERT INTO refund_items (id, refund_id, sale_item_id, qty, amount_minor, tax_minor, cogs_minor, restocked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insMove = this.db.prepare(
        `INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, created_at, value_minor, sale_item_id)
         VALUES (?, ?, ?, 'refund', 'refund', ?, ?, ?, ?)`,
      );
      for (const x of lines) {
        insItem.run(randomUUID(), refundId, x.item.id, x.qty, x.amount, x.tax, x.cogs, input.restock ? 1 : 0);
        for (const m of x.moves) {
          if (m.qty !== 0 || m.value !== 0) insMove.run(randomUUID(), m.productId, m.qty, refundId, now, m.value, x.item.id);
        }
      }

      if (pointsBack > 0) {
        postLedger(this.db, { customerId: sale.customerId!, account: "points", delta: -pointsBack, reason: "adjust", saleId: sale.id, userId: ctx.userId, note: `Refund on ${sale.receiptNo}` });
      }

      // Cash leaves the open drawer as a movement anyone can see on the shift. It can never leave an empty drawer.
      if (input.method === "cash") {
        try {
          new ShiftService(this.db).addCashMovement(ctx.shiftId, ctx.userId, -amount, `Refund on ${sale.receiptNo}: ${reason}`, { type: "refund", id: refundId });
        } catch (e) {
          if (/not that much cash/.test((e as Error).message)) {
            throw new Error(`There is not enough cash in the drawer to hand back ${plainAmount(amount)}. Refund by card or bank transfer, or put cash in the drawer first`);
          }
          throw e;
        }
      }
      return refundId;
    })();
    return this.mustGet(id);
  }

  /** What can still be refunded on a sale, and what has been refunded already. */
  refundable(saleId: string): RefundableSale {
    const sale = this.db
      .prepare("SELECT id, receipt_no AS receiptNo, status, on_account_minor AS onAccount, points_redeemed AS redeemed FROM sales WHERE id = ?")
      .get(saleId) as { id: string; receiptNo: string; status: string; onAccount: number; redeemed: number } | undefined;
    if (!sale) throw new Error("Sale not found");
    const blockedReason = this.blockedReason(sale.id, sale.status, sale.onAccount, sale.redeemed, false);
    const rows = this.db
      .prepare(
        `SELECT si.id, si.product_id AS productId, si.name, si.qty, si.total_minor AS total,
                COALESCE((SELECT SUM(ri.qty) FROM refund_items ri WHERE ri.sale_item_id = si.id), 0) AS refunded,
                COALESCE((SELECT SUM(ri.amount_minor) FROM refund_items ri WHERE ri.sale_item_id = si.id), 0) AS refundedMinor
           FROM sale_items si WHERE si.sale_id = ? ORDER BY si.rowid`,
      )
      .all(saleId) as { id: string; productId: string; name: string; qty: number; total: number; refunded: number; refundedMinor: number }[];
    return {
      saleId,
      receiptNo: sale.receiptNo,
      allowed: blockedReason === null,
      blockedReason,
      lines: rows.map((r) => ({
        saleItemId: r.id,
        productId: r.productId,
        name: r.name,
        qty: r.qty,
        refundedQty: r.refunded,
        remainingQty: Math.max(0, r.qty - r.refunded) < EPS ? 0 : r.qty - r.refunded,
        lineTotalMinor: r.total,
        remainingMinor: r.total - r.refundedMinor,
      })),
      refunds: this.forSale(saleId),
    };
  }

  forSale(saleId: string): Refund[] {
    return (this.db.prepare("SELECT id FROM refunds WHERE sale_id = ? ORDER BY created_at, rowid").all(saleId) as { id: string }[]).map((r) => this.mustGet(r.id));
  }

  /** Newest first. */
  recent(limit = 50): Refund[] {
    return (this.db.prepare("SELECT id FROM refunds ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as { id: string }[]).map((r) => this.mustGet(r.id));
  }

  get(id: string): Refund | undefined {
    const r = this.db
      .prepare(
        `SELECT r.*, s.receipt_no AS receipt_no FROM refunds r JOIN sales s ON s.id = r.sale_id WHERE r.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const lines = (
      this.db
        .prepare(
          `SELECT ri.sale_item_id AS saleItemId, si.product_id AS productId, si.name, ri.qty, ri.amount_minor AS amountMinor,
                  ri.tax_minor AS taxMinor, ri.restocked
             FROM refund_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.refund_id = ? ORDER BY ri.rowid`,
        )
        .all(id) as { saleItemId: string; productId: string; name: string; qty: number; amountMinor: number; taxMinor: number; restocked: number }[]
    ).map((l): RefundLine => ({ ...l, restocked: l.restocked === 1 }));
    return {
      id: r.id as string,
      saleId: r.sale_id as string,
      receiptNo: r.receipt_no as string,
      shiftId: (r.shift_id as string | null) ?? null,
      userId: r.user_id as string,
      userName: r.user_name as string,
      reason: r.reason as string,
      method: r.method as RefundMethod,
      reference: (r.reference as string | null) ?? null,
      restock: r.restock === 1,
      amountMinor: r.amount_minor as number,
      taxMinor: r.tax_minor as number,
      lines,
      createdAt: r.created_at as string,
    };
  }

  private mustGet(id: string): Refund {
    const r = this.get(id);
    if (!r) throw new Error("Refund not found");
    return r;
  }

  /** Why a sale cannot be part-refunded, or null. `strict` adds nothing today; reading a sale never throws. */
  private blockedReason(saleId: string, status: string, onAccount: number, redeemed: number, _strict = true): string | null {
    if (status === "void") return "This sale has been voided, so it cannot be refunded";
    if (onAccount > 0) return "This sale was put on a customer's account. Void it, or record the customer's repayment instead of refunding";
    if (redeemed > 0) return "This sale used loyalty points. Void it instead of refunding part of it";
    const wallet = this.db.prepare("SELECT 1 AS x FROM payments WHERE sale_id = ? AND label = 'wallet' LIMIT 1").get(saleId);
    if (wallet) return "Part of this sale was paid from the customer's wallet. Void it instead of refunding part of it";
    return null;
  }

  /**
   * Sales saved before refunds existed did not link their stock movements to a line. A simple product (it
   * used only itself) can still be put back from the sale's own movement for that product; anything more
   * involved cannot be matched safely, so it is refused with a clear way forward.
   */
  private legacyMoves(saleId: string, item: ItemRow, before: number, after: number): { productId: string; qty: number; value: number }[] {
    const sameProduct = this.db.prepare("SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ? AND product_id = ?").get(saleId, item.product_id) as { n: number };
    const recipe = this.db.prepare("SELECT COUNT(*) AS n FROM recipe_items WHERE product_id = ?").get(item.product_id) as { n: number };
    const logged = this.db
      .prepare("SELECT qty_delta AS qty, value_minor AS value FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ? AND reason = 'sale' AND product_id = ? AND sale_item_id IS NULL")
      .all(saleId, item.product_id) as { qty: number; value: number }[];
    if (recipe.n > 0 || sameProduct.n > 1) {
      throw new Error(`${item.name} was sold before refunds could put stock back for it. Refund it without putting it back in stock, then adjust the stock by hand`);
    }
    return logged.map((m) => ({
      productId: item.product_id,
      qty: -(cumulativeQty(m.qty, after, item.qty) - cumulativeQty(m.qty, before, item.qty)),
      value: -(cumulative(m.value, after, item.qty) - cumulative(m.value, before, item.qty)),
    }));
  }
}

const fmtQty = (n: number): string => String(Math.round(n * 1000) / 1000);
