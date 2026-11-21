/**
 * Spreading a discount over the lines of a sale. Pure integer maths with no database, so the till
 * screen shows exactly what the core will charge.
 */

/**
 * Split `discountMinor` across lines in proportion to `netMinor` using the largest-remainder rule,
 * so the parts always add up to exactly the discount and no line gets more than its own amount.
 * Lines with a net of 0 get nothing. Throws if the discount is more than the lines add up to.
 */
export function allocateDiscount(netMinor: number[], discountMinor: number): number[] {
  if (!Number.isInteger(discountMinor) || discountMinor < 0) throw new Error("A discount must be a whole number of 0 or more");
  const total = netMinor.reduce((s, n) => s + n, 0);
  if (discountMinor > total) throw new Error("The discount is more than the items cost");
  if (discountMinor === 0 || total === 0) return netMinor.map(() => 0);

  const base = netMinor.map((n) => Math.floor((n * discountMinor) / total));
  let left = discountMinor - base.reduce((s, n) => s + n, 0);
  // Hand out the leftover pennies to the lines with the biggest fractional part (ties: earlier line first).
  const order = netMinor
    .map((n, i) => ({ i, rem: (n * discountMinor) % total }))
    .filter((x) => netMinor[x.i]! > 0)
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    if (base[i]! < netMinor[i]!) {
      base[i]! += 1;
      left -= 1;
    }
  }
  return base;
}

export interface PricedLine {
  /** Price after any line discount, before tax. */
  netMinor: number;
  taxRateBp: number;
}

/** Totals of a cart once a loyalty discount is taken off the lines (tax is worked out per line after the discount). */
export function totalsAfterDiscount(
  lines: PricedLine[],
  discountMinor: number,
  taxFor: (netMinor: number, rateBp: number) => number,
): { discountMinor: number; taxMinor: number; totalMinor: number; shares: number[] } {
  const shares = allocateDiscount(lines.map((l) => l.netMinor), discountMinor);
  let tax = 0;
  let net = 0;
  lines.forEach((l, i) => {
    const n = l.netMinor - shares[i]!;
    net += n;
    tax += taxFor(n, l.taxRateBp);
  });
  return { discountMinor, taxMinor: tax, totalMinor: net + tax, shares };
}
