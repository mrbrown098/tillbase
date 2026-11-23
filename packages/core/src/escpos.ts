/**
 * ESC/POS: the command language almost every receipt printer (Epson, Star in Epson mode, Xprinter, Rongta and
 * the rest) understands. Everything here is plain functions that return bytes, so it can be tested without a
 * printer. Sending the bytes (TCP port 9100) lives in the desktop app.
 *
 * Paper: 58 mm paper is 384 dots (32 text characters) wide, 80 mm paper is 576 dots (48 characters).
 */

export type PaperMm = 58 | 80;

export const PAPER_DOTS: Record<PaperMm, number> = { 58: 384, 80: 576 };
export const PAPER_CHARS: Record<PaperMm, number> = { 58: 32, 80: 48 };

/** The paper that goes with the shop's "characters per line" setting (32 = 58 mm, 48 = 80 mm). */
export function paperForWidth(chars: number): PaperMm {
  return chars > 32 ? 80 : 58;
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** The small commands, exported so tests (and curious people) can see exactly what is sent. */
export const cmd = {
  /** ESC @ : forget any earlier settings. */
  init: [ESC, 0x40],
  /** ESC t 0 : use character table PC437, the one every printer has. */
  codePage437: [ESC, 0x74, 0x00],
  alignLeft: [ESC, 0x61, 0x00],
  alignCenter: [ESC, 0x61, 0x01],
  boldOn: [ESC, 0x45, 0x01],
  boldOff: [ESC, 0x45, 0x00],
  /** GS ! 0x11 : double width and double height. */
  bigOn: [GS, 0x21, 0x11],
  bigOff: [GS, 0x21, 0x00],
  /** ESC p 0 25 250 : pulse pin 2 (50 ms on, 500 ms off), which is what cash drawers are wired to. */
  drawerKick: [ESC, 0x70, 0x00, 0x19, 0xfa],
  /** GS V 66 0 : feed to the cutter and make a partial cut. */
  cut: [GS, 0x56, 0x42, 0x00],
  /** ESC d n : feed n lines. */
  feed: (n: number) => [ESC, 0x64, Math.max(0, Math.min(255, Math.round(n)))],
};

// ---- Text -------------------------------------------------------------------------------------------------------

const SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "₹": "Rs",
  "₨": "Rs",
  "×": "x",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "•": "*",
  "…": "...",
  " ": " ",
};
/** A few symbols the PC437 table has, as the byte it uses for them. */
const CP437: Record<string, number> = { "£": 0x9c, "¥": 0x9d, "¢": 0x9b, "°": 0xf8 };

/**
 * Turn text into bytes a printer shows correctly. Printers only have a small built-in character table, so
 * accents are dropped ("é" becomes "e"), a few money symbols are kept, and anything else prints as "?".
 * Languages with their own scripts (Urdu, Arabic, Chinese) cannot be printed this way.
 */
export function encodeText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize("NFC")) {
    if (ch === "\n") out.push(LF);
    else if (ch === "\r") continue;
    else if (CP437[ch] !== undefined) out.push(CP437[ch]);
    else if (SYMBOLS[ch] !== undefined) for (const c of SYMBOLS[ch]) out.push(c.charCodeAt(0));
    else {
      const code = ch.codePointAt(0) ?? 63;
      if (code >= 0x20 && code < 0x7f) out.push(code);
      else {
        const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
        out.push(plain.length === 1 && plain.charCodeAt(0) >= 0x20 && plain.charCodeAt(0) < 0x7f ? plain.charCodeAt(0) : 63);
      }
    }
  }
  return out;
}

// ---- Pictures ---------------------------------------------------------------------------------------------------

/** A black-and-white picture: `data` holds `height` rows of `widthBytes` bytes, leftmost dot in the top bit, 1 = black. */
export interface Raster {
  widthDots: number;
  heightDots: number;
  data: Uint8Array;
}

/** A decoded picture: RGBA, 4 bytes per pixel. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** The tallest logo we print, so a strange picture cannot waste a metre of paper. */
export const MAX_LOGO_DOTS_HIGH = 240;

/**
 * Make a logo printable: shrink it to fit the paper (a small logo is kept small and printed in the middle),
 * put it on white paper (transparent areas become white), and turn it into black and white dots. Grey areas
 * are dithered (Floyd-Steinberg) so they still look grey. Returns null for a picture with no pixels.
 */
export function rasterFromRgba(img: Rgba, paper: PaperMm): Raster | null {
  const { width: sw, height: sh } = img;
  if (!Number.isInteger(sw) || !Number.isInteger(sh) || sw < 1 || sh < 1 || img.data.length < sw * sh * 4) return null;
  const maxW = PAPER_DOTS[paper];
  const scale = Math.min(1, maxW / sw, MAX_LOGO_DOTS_HIGH / sh);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  // Brightness 0..255 of each target dot: the average of the source pixels it covers, on white paper.
  const grey = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * sh) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * sw) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / w));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          const a = (img.data[i + 3] ?? 255) / 255;
          const lum = 0.299 * (img.data[i] ?? 0) + 0.587 * (img.data[i + 1] ?? 0) + 0.114 * (img.data[i + 2] ?? 0);
          sum += lum * a + 255 * (1 - a);
          n++;
        }
      }
      grey[y * w + x] = sum / n;
    }
  }

  // Dither to black and white.
  const dots = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const old = grey[y * w + x] ?? 255;
      const black = old < 128;
      dots[y * w + x] = black ? 1 : 0;
      const err = old - (black ? 0 : 255);
      if (x + 1 < w) grey[y * w + x + 1] = (grey[y * w + x + 1] ?? 0) + (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) grey[(y + 1) * w + x - 1] = (grey[(y + 1) * w + x - 1] ?? 0) + (err * 3) / 16;
        grey[(y + 1) * w + x] = (grey[(y + 1) * w + x] ?? 0) + (err * 5) / 16;
        if (x + 1 < w) grey[(y + 1) * w + x + 1] = (grey[(y + 1) * w + x + 1] ?? 0) + err / 16;
      }
    }
  }

  const widthBytes = Math.ceil(w / 8);
  const data = new Uint8Array(widthBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (dots[y * w + x]) data[y * widthBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { widthDots: w, heightDots: h, data };
}

/** GS v 0 : print a raster picture. Sent in bands of 128 rows, which every printer accepts. */
export function rasterCommands(r: Raster): number[] {
  const widthBytes = Math.ceil(r.widthDots / 8);
  const out: number[] = [];
  for (let y = 0; y < r.heightDots; y += 128) {
    const rows = Math.min(128, r.heightDots - y);
    out.push(GS, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, rows & 0xff, rows >> 8);
    for (const b of r.data.subarray(y * widthBytes, (y + rows) * widthBytes)) out.push(b);
  }
  return out;
}

// ---- Jobs: whole things to print ---------------------------------------------------------------------------------

export interface JobOptions {
  paper: PaperMm;
  /** Printed above the text, centred. Leave out for none. */
  logo?: Raster | null;
  /** Pop the cash drawer open (when the printer has one plugged in). */
  openDrawer?: boolean;
  /** Cut the paper afterwards. Default true. */
  cut?: boolean;
  /** Blank lines before the cut so the text clears the cutter. Default 4. */
  feedLines?: number;
}

interface Layout {
  /** How many lines at the top are printed bold and centred. */
  headingLines?: number;
  /** Centre the lines after the last rule (the "thank you" footer). */
  centerFooter?: boolean;
  /** Print the first line double size (kitchen tickets). */
  bigFirstLine?: boolean;
}

const isRule = (line: string) => /^-{5,}$/.test(line);

function job(text: string, opts: JobOptions, layout: Layout): Uint8Array {
  const out: number[] = [...cmd.init, ...cmd.codePage437];
  if (opts.openDrawer) out.push(...cmd.drawerKick);
  if (opts.logo) {
    out.push(...cmd.alignCenter, ...rasterCommands(opts.logo), LF, ...cmd.alignLeft);
  }
  const lines = text.replace(/\r/g, "").split("\n");
  let lastRule = -1;
  lines.forEach((l, i) => {
    if (isRule(l)) lastRule = i;
  });
  const heading = layout.headingLines ?? 0;
  lines.forEach((line, i) => {
    const centered = i < heading || (layout.centerFooter && lastRule >= 0 && i > lastRule);
    const big = !!layout.bigFirstLine && i === 0;
    const head = i < heading;
    if (big) out.push(...cmd.boldOn, ...cmd.bigOn);
    else if (head) out.push(...cmd.boldOn);
    if (centered) out.push(...cmd.alignCenter);
    out.push(...encodeText(line), LF);
    if (centered) out.push(...cmd.alignLeft);
    if (big) out.push(...cmd.bigOff, ...cmd.boldOff);
    else if (head) out.push(...cmd.boldOff);
  });
  out.push(...cmd.feed(opts.feedLines ?? 4));
  if (opts.cut !== false) out.push(...cmd.cut);
  return Uint8Array.from(out);
}

/** A sale receipt (the text from `formatReceipt`): shop name in bold in the middle, footer in the middle. */
export function receiptJob(text: string, opts: JobOptions): Uint8Array {
  return job(text, opts, { headingLines: 1, centerFooter: true });
}

/** A customer's account statement (the text from `formatStatement`): shop name and title in the middle. */
export function statementJob(text: string, opts: JobOptions): Uint8Array {
  return job(text, opts, { headingLines: 2, centerFooter: true });
}

/** A kitchen ticket: the first line (order number) in big letters, no logo. */
export function kitchenTicketJob(text: string, opts: JobOptions): Uint8Array {
  return job(text, { ...opts, logo: null }, { bigFirstLine: true });
}

/** Any other plain report (the shift report): the first line in bold in the middle. */
export function reportJob(text: string, opts: JobOptions): Uint8Array {
  return job(text, opts, { headingLines: 1, centerFooter: true });
}

/** Only open the cash drawer. */
export function drawerKickJob(): Uint8Array {
  return Uint8Array.from([...cmd.init, ...cmd.drawerKick]);
}
