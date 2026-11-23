import { formatMoney } from "./money.js";
import { TILLBASE_FOOTER } from "./branding.js";
import { wallClock } from "./dates.js";
import type { Statement } from "./customers.js";
import type { Sale } from "./sales.js";
import type { KitchenTicket } from "./orders.js";

export interface ReceiptOptions {
  storeName: string;
  currency?: string;
  locale?: string;
  /** Characters per line. 32 suits 58mm printers, 48 suits 80mm printers. */
  width?: number;
  footer?: string;
}


/** "2026-11-18 17:25" on the shop's clock (stored times are UTC). */
function localStamp(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return iso;
  return wallClock(iso).stamp;
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
  if (sale.orderLabel) out.push(sale.orderLabel);
  out.push(`Receipt: ${sale.receiptNo}`);
  out.push(`Date:    ${localStamp(sale.createdAt)}`);
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
    out.push(row((p.label ?? p.method).toUpperCase(), money(p.amountMinor), width));
  }
  if (sale.onAccountMinor > 0) out.push(row("ON ACCOUNT", money(sale.onAccountMinor), width));
  if (sale.changeMinor > 0) out.push(row("Change", money(sale.changeMinor), width));
  if (sale.customer) {
    const c = sale.customer;
    const pts = (n: number) => `${n} point${n === 1 ? "" : "s"}`;
    out.push(line);
    out.push(`Customer: ${c.name}`.slice(0, width));
    if (sale.pointsRedeemed > 0) out.push(row("Points used", `-${sale.pointsRedeemed}`, width));
    if (sale.pointsEarned > 0) out.push(row("Points earned", `+${sale.pointsEarned}`, width));
    out.push(row("Points balance", pts(c.points), width));
    if (c.owedMinor > 0) out.push(row("You owe", money(c.owedMinor), width));
    if (sale.payments.some((p) => p.label === "wallet") || c.walletMinor > 0) {
      out.push(row("Wallet balance", money(c.walletMinor), width));
    }
  }
  out.push(line);
  out.push(opts.footer ?? "Thank you!"); // the shop's own message
  out.push(TILLBASE_FOOTER); // permanent, added here so no caller can leave it out
  return out.join("\n");
}

const shortDate = (iso: string) => localStamp(iso).slice(0, 10);

/**
 * A customer's account statement as plain text: every sale on account, repayment and write-off, with what
 * they owed afterwards. `width` is 32 for 58mm paper and 48 for 80mm paper.
 */
export function formatStatement(st: Statement, opts: ReceiptOptions & { printedAt?: string }): string {
  const width = opts.width ?? 32;
  const money = (m: number) => formatMoney(m, opts.currency, opts.locale);
  const signed = (m: number) => (m > 0 ? `+${money(m)}` : `-${money(-m)}`);
  const line = "-".repeat(width);
  const out: string[] = [];
  out.push(opts.storeName.slice(0, width));
  out.push("ACCOUNT STATEMENT");
  out.push(line);
  out.push(st.customer.name.slice(0, width));
  if (st.customer.phone) out.push(st.customer.phone.slice(0, width));
  out.push(`Printed ${localStamp(opts.printedAt ?? new Date().toISOString())}`);
  out.push(line);
  if (st.rows.length === 0) out.push("Nothing on account yet.");
  for (const r of st.rows) {
    const label =
      r.kind === "sale" ? `Sale ${r.receiptNo ?? ""}`.trim()
      : r.kind === "repayment" ? `Paid back${r.method ? ` (${r.method})` : ""}`
      : r.kind === "writeoff" ? "Written off"
      : `Sale voided ${r.receiptNo ?? ""}`.trim();
    const amount = signed(r.deltaMinor);
    // Two lines per entry so nothing important is cut off on narrow paper: what happened, then the money.
    out.push(`${shortDate(r.at)} ${label}`.slice(0, width));
    out.push(row("", `${amount}   owes ${money(r.balanceMinor)}`, width));
  }
  out.push(line);
  out.push(row("OWES NOW", money(st.owedMinor), width));
  if (st.customer.creditLimitMinor !== null) out.push(row("Credit limit", money(st.customer.creditLimitMinor), width));
  out.push(line);
  out.push(opts.footer ?? "Thank you!"); // the shop's own message
  out.push(TILLBASE_FOOTER); // permanent, added here so no caller can leave it out
  return out.join("\n");
}

const orderTypeLabel = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" } as const;

/** The kitchen ticket: only what was newly sent, with add-ons and notes. `width` is 28 on screen, 32 or 48 on paper. */
export function formatKitchenTicket(t: KitchenTicket, opts: { width?: number } = {}): string {
  const width = opts.width ?? 28;
  const rule = "-".repeat(width);
  const lines = t.items.map(
    (i) => `${i.qty} x ${i.name}${i.modifiers.length ? `\n    + ${i.modifiers.join(", ")}` : ""}${i.note ? `\n    NOTE: ${i.note}` : ""}`,
  );
  return [
    `KITCHEN  #${t.token}`,
    `${orderTypeLabel[t.type]}${t.tableLabel ? `  Table ${t.tableLabel}` : ""}`,
    rule,
    ...lines,
    ...(t.note ? [rule, `ORDER NOTE: ${t.note}`] : []),
    rule,
    TILLBASE_FOOTER,
  ].join("\n");
}
