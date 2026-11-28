/**
 * The permanent Tillbase credit printed on every document Tillbase makes (receipts, kitchen tickets, statements,
 * reports). It is added by the formatters themselves, never read from a setting, so it cannot be switched off or
 * edited from the app. The shop's own receipt message is a separate setting (`receiptFooter`) and is printed above it.
 */
export const TILLBASE_FOOTER = "Powered by Tillbase";

/** Make sure plain text ends with the credit exactly once. Used for text that does not come from a formatter. */
export function withTillbaseFooter(text: string): string {
  const body = text.trimEnd();
  return body.endsWith(TILLBASE_FOOTER) ? body : `${body}\n${TILLBASE_FOOTER}`;
}
