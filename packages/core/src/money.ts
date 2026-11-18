/**
 * All money in Tillbase is stored as integers in the currency's minor unit
 * (for example cents, or paisa). This avoids floating point rounding bugs.
 */

/** Convert a decimal amount (e.g. 12.5) to minor units (1250). */
export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

/** Convert minor units back to a decimal amount. */
export function fromMinor(minor: number): number {
  return minor / 100;
}

/** Tax on a net amount. `rateBp` is in basis points: 1800 = 18.00%. */
export function taxFor(netMinor: number, rateBp: number): number {
  return Math.round((netMinor * rateBp) / 10000);
}

/** Format minor units for display, e.g. formatMoney(1250, "USD") -> "$12.50". */
export function formatMoney(
  minor: number,
  currency = "USD",
  locale = "en-US",
): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    fromMinor(minor),
  );
}
