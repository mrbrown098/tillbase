import type { PaymentInput, SalePaymentMethod } from "@tillbase/core";

export const methodLabel: Record<SalePaymentMethod, string> = { cash: "Cash", card: "Card", bank_transfer: "Bank transfer", other: "Other" };

export interface PaymentSummary {
  /** Everything entered so far. */
  paidMinor: number;
  /** What is still to pay (0 once covered). */
  remainingMinor: number;
  /** What goes back to the customer. Only ever taken out of the cash that was handed over. */
  changeMinor: number;
  /** True when the sale can be completed. */
  ok: boolean;
  /** Plain words about what is wrong, or null. */
  problem: string | null;
}

/**
 * Work out where a split payment stands. Mirrors the rule the core enforces when the sale is made, so
 * the person sees the reason on screen instead of an error after pressing the button:
 * the total must be covered, and change may only come out of cash.
 */
export function summarizePayments(totalMinor: number, payments: PaymentInput[]): PaymentSummary {
  const paid = payments.reduce((s, p) => s + p.amountMinor, 0);
  const cash = payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amountMinor, 0);
  const remaining = Math.max(0, totalMinor - paid);
  const change = Math.max(0, paid - totalMinor);
  if (payments.length === 0) return { paidMinor: 0, remainingMinor: totalMinor, changeMinor: 0, ok: false, problem: null };
  if (remaining > 0) return { paidMinor: paid, remainingMinor: remaining, changeMinor: 0, ok: false, problem: null };
  if (change > cash) {
    return {
      paidMinor: paid,
      remainingMinor: 0,
      changeMinor: change,
      ok: false,
      problem:
        cash === 0
          ? "Card and other payments cannot be more than what is left to pay. Change can only be given from cash."
          : "Too much was entered. Change can only be given from the cash handed over, so lower the card or other amount.",
    };
  }
  return { paidMinor: paid, remainingMinor: 0, changeMinor: change, ok: true, problem: null };
}
