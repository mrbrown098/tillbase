import { formatMoney } from "./money.js";
import type { Sale } from "./sales.js";

export interface ReceiptOptions {
  storeName: string;
  currency?: string;
  locale?: string;
  /** Characters per line. 32 suits 58mm printers, 48 suits 80mm printers. */
  width?: number;
  footer?: string;
}

function row(left: string, right: string, width: number): string {
  const space = Math.max(1, width - left.length - right.length);
  return left + " ".repeat(space) + right;
}

/** Plain-text receipt, ready for a thermal printer or an on-screen preview. */
export function formatReceipt(sale: Sale, opts: ReceiptOptions): string {
  const width = opts.width ?? 32;
  const money = (m: number) => formatMoney(m, opts.currency, opts.locale);
  const line = "-".repeat(width);
  const out: string[] = [];

  out.push(opts.storeName.slice(0, width));
  out.push(line);
  out.push(`Receipt: ${sale.receiptNo}`);
  out.push(`Date:    ${sale.createdAt.replace("T", " ").slice(0, 16)}`);
  if (sale.cashier) out.push(`Cashier: ${sale.cashier}`);
  if (sale.status === "void") out.push("*** VOID ***");
  out.push(line);

  for (const it of sale.items) {
    out.push(it.name.slice(0, width));
    out.push(
      row(`  ${it.qty} x ${money(it.unitPriceMinor)}`, money(it.totalMinor), width),
    );
  }

  out.push(line);
  out.push(row("Subtotal", money(sale.subtotalMinor), width));
  if (sale.discountMinor > 0) {
    out.push(row("Discount", `-${money(sale.discountMinor)}`, width));
  }
  if (sale.taxMinor > 0) out.push(row("Tax", money(sale.taxMinor), width));
  out.push(row("TOTAL", money(sale.totalMinor), width));
  for (const p of sale.payments) {
    out.push(row(p.method.toUpperCase(), money(p.amountMinor), width));
  }
  if (sale.changeMinor > 0) out.push(row("Change", money(sale.changeMinor), width));
  out.push(line);
  out.push(opts.footer ?? "Thank you!");
  return out.join("\n");
}
