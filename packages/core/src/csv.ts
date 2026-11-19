/**
 * A small CSV reader and writer, following RFC 4180 with the leniency real
 * shop files need. No dependencies, and no knowledge of Tillbase: this file
 * only turns text into rows of strings and back again.
 *
 * It handles the things that break naive `split(",")` code:
 *   - quoted fields containing commas, quotes or line breaks
 *   - doubled quotes ("") as an escaped quote
 *   - CRLF, LF and lone CR line endings
 *   - a UTF-8 byte-order mark, which Excel adds
 *   - semicolon and tab separated files, which Excel exports in many countries
 */

/** Anything a caller may hand to the writer. Empty values become empty cells. */
export type CsvCell = string | number | boolean | null | undefined;

export interface CsvReadOptions {
  /** Field separator. When omitted it is guessed from the first line. */
  delimiter?: string;
}

export interface CsvWriteOptions {
  /** Field separator. Defaults to a comma. */
  delimiter?: string;
  /**
   * Prepend a UTF-8 byte-order mark. Excel needs it to show Urdu and other
   * non-ASCII text correctly; most other tools accept it either way.
   */
  bom?: boolean;
  /**
   * Prefix cells that a spreadsheet would run as a formula (`=`, `+`, `-`, `@`)
   * with an apostrophe. Off by default so that export and import are exact
   * opposites; turn it on when handing a file to someone who will open it in
   * Excel. Plain numbers such as "-5" are never prefixed.
   */
  escapeFormulas?: boolean;
}

const CANDIDATES = [",", ";", "\t", "|"] as const;

/** Strip a byte-order mark if the file starts with one. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Guess the separator by counting candidates outside quoted fields on the
 * first line. A tie, or a line with none of them, means a comma.
 */
export function detectDelimiter(text: string): string {
  const src = stripBom(text);
  let counts = new Map<string, number>(CANDIDATES.map((c) => [c, 0]));
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (c === "\n" || c === "\r")) break;
    if (!quoted && counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best = ",";
  let bestCount = 0;
  for (const c of CANDIDATES) {
    const n = counts.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

function assertDelimiter(delimiter: string): void {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === "\r" || delimiter === "\n") {
    throw new Error("CSV delimiter must be a single character other than a quote or a line break");
  }
}

/**
 * Read CSV text into rows of strings. Completely blank lines are dropped.
 * Cells are returned exactly as written, without trimming, so the caller
 * decides what whitespace means.
 *
 * Throws if a quoted field is never closed, because the rest of the file
 * cannot be trusted after that point.
 */
export function parseCsv(text: string, opts: CsvReadOptions = {}): string[][] {
  const src = stripBom(text);
  const delimiter = opts.delimiter ?? detectDelimiter(src);
  assertDelimiter(delimiter);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldUsedQuotes = false;
  let line = 1;
  let i = 0;

  const endField = (): void => {
    row.push(field);
    field = "";
    fieldUsedQuotes = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i]!;

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (c === "\n") line++;
      field += c;
      i++;
      continue;
    }

    if (c === '"' && field === "" && !fieldUsedQuotes) {
      quoted = true;
      fieldUsedQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      endField();
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      i++;
      line++;
      endRow();
      continue;
    }
    field += c;
    i++;
  }

  if (quoted) throw new Error(`CSV has a quoted field that is never closed (line ${line})`);
  if (field !== "" || fieldUsedQuotes || row.length > 0) endRow();

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function encodeCell(value: CsvCell, delimiter: string, escapeFormulas: boolean): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (escapeFormulas && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  const needsQuotes =
    s.includes(delimiter) ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r") ||
    s !== s.trim();
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Write rows as CSV text. Lines end with CRLF and the file ends with a line
 * break, which is what RFC 4180 and Excel expect.
 */
export function formatCsv(rows: CsvCell[][], opts: CsvWriteOptions = {}): string {
  const delimiter = opts.delimiter ?? ",";
  assertDelimiter(delimiter);
  const escapeFormulas = opts.escapeFormulas ?? false;
  if (rows.length === 0) return opts.bom ? "\uFEFF" : "";
  const body = rows
    .map((r) => r.map((cell) => encodeCell(cell, delimiter, escapeFormulas)).join(delimiter))
    .join("\r\n");
  return `${opts.bom ? "\uFEFF" : ""}${body}\r\n`;
}
