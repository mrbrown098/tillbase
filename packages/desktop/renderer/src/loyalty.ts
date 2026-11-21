import { taxFor } from "@tillbase/core/money";
import { totalsAfterDiscount } from "@tillbase/core/discount";

export interface BillLine {
  /** Price after any line discount, before tax. */
  netMinor: number;
  taxRateBp: number;
}

export interface PayPlanInput {
  lines: BillLine[];
  /** Untaxed charges points cannot pay for, such as a delivery fee. */
  extraMinor: number;
  redeemPoints: number;
  pointValueMinor: number;
  useWallet: boolean;
  walletBalanceMinor: number;
}

export interface PayPlan {
  /** Taken off the items by points. */
  discountMinor: number;
  taxMinor: number;
  /** The bill once points are used. */
  payableMinor: number;
  /** Taken from the wallet (never more than the balance or the bill). */
  walletMinor: number;
  /** What cash, card or other must still cover. */
  dueMinor: number;
}

/** The most points that can be used: what the customer has, and no more than the items cost. */
export function maxPoints(points: number, itemsMinor: number, pointValueMinor: number): number {
  if (pointValueMinor <= 0 || points <= 0 || itemsMinor <= 0) return 0;
  return Math.min(points, Math.floor(itemsMinor / pointValueMinor));
}

/** The same sums the core does when it makes the sale, so the screen never shows a different total. */
export function planPayment(i: PayPlanInput): PayPlan {
  const items = i.lines.reduce((s, l) => s + l.netMinor, 0);
  const points = Math.min(Math.max(0, Math.trunc(i.redeemPoints) || 0), maxPoints(Number.MAX_SAFE_INTEGER, items, i.pointValueMinor));
  const t = totalsAfterDiscount(i.lines, points * i.pointValueMinor, taxFor);
  const payable = t.totalMinor + i.extraMinor;
  const wallet = i.useWallet ? Math.min(Math.max(0, i.walletBalanceMinor), payable) : 0;
  return { discountMinor: t.discountMinor, taxMinor: t.taxMinor, payableMinor: payable, walletMinor: wallet, dueMinor: payable - wallet };
}

/** Points a bill earns, as the core works them out (items after any discount, before tax). */
export function pointsEarned(itemsAfterDiscountMinor: number, spendPerPointMinor: number): number {
  if (spendPerPointMinor <= 0 || itemsAfterDiscountMinor <= 0) return 0;
  return Math.floor(itemsAfterDiscountMinor / spendPerPointMinor);
}
