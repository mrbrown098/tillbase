import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
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
}

export interface Payment {
  id: string;
  method: PaymentMethod;
  amountMinor: number;
}

export interface Sale {
  id: string;
  receiptNo: string;
  status: "completed" | "void";
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  changeMinor: number;
  cashier: string | null;
  voidReason: string | null;
  createdAt: string;
  voidedAt: string | null;
  items: SaleItem[];
  payments: Payment[];
}

interface ProductRow {
  id: string;
  name: string;
  price_minor: number;
  tax_rate_bp: number;
  track_stock: number;
  active: number;
}

export class SaleService {
  constructor(
    private readonly db: Db,
    /** Short prefix for receipt numbers, e.g. a till or branch code. */
    private readonly receiptPrefix = "R",
  ) {}

  /**
   * Complete a sale in one database transaction: price the lines, check
   * stock and payment, write the sale, and remove stock. If anything fails,
   * nothing is saved.
   */
  checkout(input: CheckoutInput): Sale {
    if (input.lines.length === 0) throw new Error("The cart is empty");
    if (input.payments.length === 0) throw new Error("A payment is required");

    const run = this.db.transaction((): string => {
      const now = new Date().toISOString();
      const saleId = randomUUID();

      let subtotal = 0;
      let discount = 0;
      let tax = 0;

      const priced = input.lines.map((line) => {
        if (!(line.qty > 0) || !Number.isFinite(line.qty)) {
          throw new Error("Quantity must be greater than zero");
        }
        const p = this.db
          .prepare(
            "SELECT id, name, price_minor, tax_rate_bp, track_stock, active FROM products WHERE id = ?",
          )
          .get(line.productId) as ProductRow | undefined;
        if (!p) throw new Error(`Product not found: ${line.productId}`);
        if (p.active !== 1) throw new Error(`Product is inactive: ${p.name}`);

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
        const net = gross - lineDiscount;
        const lineTax = taxFor(net, p.tax_rate_bp);

        if (p.track_stock === 1 && !input.allowNegativeStock) {
          const have = (
            this.db
              .prepare(
                "SELECT COALESCE(SUM(qty_delta), 0) AS q FROM stock_movements WHERE product_id = ?",
              )
              .get(p.id) as { q: number }
          ).q;
          if (have < line.qty) {
            throw new Error(
              `Not enough stock for ${p.name} (have ${have}, need ${line.qty})`,
            );
          }
        }

        subtotal += gross;
        discount += lineDiscount;
        tax += lineTax;
        return {
          p,
          qty: line.qty,
          unit,
          lineDiscount,
          lineTax,
          total: net + lineTax,
        };
      });

      const total = subtotal - discount + tax;

      for (const pay of input.payments) {
        if (!Number.isInteger(pay.amountMinor) || pay.amountMinor <= 0) {
          throw new Error("Payment amounts must be positive integers");
        }
      }
      const paid = input.payments.reduce((s, x) => s + x.amountMinor, 0);
      if (paid < total) {
        throw new Error(`Payment is short by ${total - paid} (minor units)`);
      }
      const change = paid - total;
      const cashPaid = input.payments
        .filter((x) => x.method === "cash")
        .reduce((s, x) => s + x.amountMinor, 0);
      if (change > cashPaid) {
        throw new Error("Change can only be given from a cash payment");
      }

      const receiptNo = this.nextReceiptNo();
      this.db
        .prepare(
          `INSERT INTO sales (id, receipt_no, status, subtotal_minor, discount_minor,
             tax_minor, total_minor, paid_minor, change_minor, cashier, created_at)
           VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );

      const insItem = this.db.prepare(
        `INSERT INTO sale_items (id, sale_id, product_id, name, qty, unit_price_minor,
           discount_minor, tax_rate_bp, tax_minor, total_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insMove = this.db.prepare(
        `INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, 'sale', 'sale', ?, ?)`,
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
        );
        if (x.p.track_stock === 1) {
          insMove.run(randomUUID(), x.p.id, -x.qty, saleId, now);
        }
      }

      const insPay = this.db.prepare(
        "INSERT INTO payments (id, sale_id, method, amount_minor) VALUES (?, ?, ?, ?)",
      );
      for (const pay of input.payments) {
        insPay.run(randomUUID(), saleId, pay.method, pay.amountMinor);
      }
      return saleId;
    });

    return this.mustGet(run());
  }

  /** Void a completed sale and put its stock back. Cannot be undone. */
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

      const items = this.db
        .prepare(
          `SELECT si.product_id AS productId, si.qty AS qty, p.track_stock AS track
             FROM sale_items si JOIN products p ON p.id = si.product_id
            WHERE si.sale_id = ?`,
        )
        .all(saleId) as { productId: string; qty: number; track: number }[];
      const insMove = this.db.prepare(
        `INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, 'void', 'sale', ?, ?)`,
      );
      for (const it of items) {
        if (it.track === 1) insMove.run(randomUUID(), it.productId, it.qty, saleId, now);
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
      }),
    );

    return {
      id: s.id as string,
      receiptNo: s.receipt_no as string,
      status: s.status as "completed" | "void",
      subtotalMinor: s.subtotal_minor as number,
      discountMinor: s.discount_minor as number,
      taxMinor: s.tax_minor as number,
      totalMinor: s.total_minor as number,
      paidMinor: s.paid_minor as number,
      changeMinor: s.change_minor as number,
      cashier: (s.cashier as string | null) ?? null,
      voidReason: (s.void_reason as string | null) ?? null,
      createdAt: s.created_at as string,
      voidedAt: (s.voided_at as string | null) ?? null,
      items,
      payments,
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
