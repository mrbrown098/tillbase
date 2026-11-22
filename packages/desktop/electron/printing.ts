import net from "node:net";
import { createRequire } from "node:module";
import { rasterFromRgba, type PaperMm, type Raster, type Rgba } from "@tillbase/core";

/** How long to wait for a network printer to answer before telling the cashier it is not reachable. */
export const PRINTER_TIMEOUT_MS = 3000;

/** A problem sending to the printer, worded so a cashier can act on it. */
export class PrintError extends Error {}

/** Send bytes to a network receipt printer (raw printing on TCP port 9100). Resolves when they are handed over. */
export function sendToPrinter(host: string, port: number, bytes: Uint8Array, timeoutMs = PRINTER_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let finished = false;
    let linger: NodeJS.Timeout | undefined;
    const end = (err?: PrintError) => {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer);
      if (linger) clearTimeout(linger);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const connectTimer = setTimeout(() => end(new PrintError(unreachable(host, timeoutMs))), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      // While sending, give the printer a fair time to take each chunk.
      socket.setTimeout(timeoutMs * 3, () => end(new PrintError(`The printer at ${host} stopped answering while printing. Check it has paper and is switched on, then try again.`)));
      socket.end(Buffer.from(bytes));
    });
    // Printers often never close their end: once everything is written, give them a moment and call it sent.
    socket.once("finish", () => {
      linger = setTimeout(() => end(), 300);
    });
    socket.once("close", () => end());
    socket.once("error", (e: NodeJS.ErrnoException) => end(new PrintError(describeNetworkError(e, host, port, timeoutMs))));
  });
}

const unreachable = (host: string, ms: number) =>
  `Could not reach the printer at ${host}: no answer after ${Math.round(ms / 1000)} seconds. Check that it is switched on and on the same network as this computer.`;

export function describeNetworkError(e: NodeJS.ErrnoException, host: string, port: number, timeoutMs = PRINTER_TIMEOUT_MS): string {
  switch (e.code) {
    case "ECONNREFUSED":
      return `The printer at ${host} refused the connection on port ${port}. Check the port number (most receipt printers use 9100).`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not find a printer called "${host}". Check the address in the printer settings.`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ENETDOWN":
      return `This computer cannot reach the printer at ${host}. Check that it is switched on and on the same network.`;
    case "ETIMEDOUT":
      return unreachable(host, timeoutMs);
    default:
      return `Could not print to ${host}: ${e.code ?? e.message}.`;
  }
}

// ---- The shop logo ----------------------------------------------------------------------------------------------

interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toBitmap(): Buffer;
}
type DecodeFn = (dataUrl: string) => Rgba | null | Promise<Rgba | null>;

/**
 * Decode a PNG, JPEG or WebP data: URL into pixels using Electron's own image decoder. Returns null when this is
 * not running inside Electron (tests) or when the picture cannot be read.
 */
function decodeWithNativeImage(dataUrl: string): Rgba | null {
  try {
    // Bundled into the app as CommonJS `require` exists; when run as an ES module (tests) it does not, and there is no Electron anyway.
    const load = typeof require === "function" ? require : createRequire(import.meta.url);
    const electron = load("electron") as { nativeImage?: { createFromDataURL(u: string): NativeImageLike } };
    if (!electron || typeof electron !== "object" || !electron.nativeImage) return null;
    const img = electron.nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const bgra = img.toBitmap();
    if (width < 1 || height < 1 || bgra.length < width * height * 4) return null;
    // Electron gives premultiplied BGRA; the dot maker wants straight RGBA.
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const a = bgra[i * 4 + 3]!;
      const un = (v: number) => (a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a)));
      rgba[i * 4] = un(bgra[i * 4 + 2]!);
      rgba[i * 4 + 1] = un(bgra[i * 4 + 1]!);
      rgba[i * 4 + 2] = un(bgra[i * 4]!);
      rgba[i * 4 + 3] = a;
    }
    return { width, height, data: rgba };
  } catch {
    return null;
  }
}

interface WindowLike {
  loadURL(url: string): Promise<void>;
  close(): void;
  isDestroyed(): boolean;
  webContents: { executeJavaScript(code: string): Promise<unknown> };
}

/**
 * Electron's quick decoder reads PNG and JPEG but not WebP, so for anything it cannot read, let the browser engine do it:
 * a hidden window draws the picture on a canvas and hands back the pixels. Large pictures are shrunk first.
 */
async function decodeWithHiddenWindow(dataUrl: string): Promise<Rgba | null> {
  let win: WindowLike | null = null;
  try {
    const load = typeof require === "function" ? require : createRequire(import.meta.url);
    const electron = load("electron") as { BrowserWindow?: new (o: object) => WindowLike };
    if (!electron || typeof electron !== "object" || !electron.BrowserWindow) return null;
    win = new electron.BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL("data:text/html;charset=utf-8,%3C!doctype%20html%3E");
    const code = `(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const k = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
      return { width: w, height: h, data: g.getImageData(0, 0, w, h).data };
    })()`;
    const out = (await Promise.race([win.webContents.executeJavaScript(code), new Promise((r) => setTimeout(() => r(null), 5000))])) as { width: number; height: number; data: Uint8ClampedArray } | null;
    return out && out.width > 0 && out.height > 0 && out.data.length >= out.width * out.height * 4 ? out : null;
  } catch {
    return null;
  } finally {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
      /* nothing to clean up */
    }
  }
}

/** Decode a PNG, JPEG or WebP data: URL into pixels with Electron. Null outside Electron (tests) or when the picture cannot be read. */
export const decodeLogoWithElectron: DecodeFn = async (dataUrl) => decodeWithNativeImage(dataUrl) ?? (await decodeWithHiddenWindow(dataUrl));

/** The shop logo as dots for this paper, or null (no logo, or one we cannot read: printing carries on without it). */
export async function logoRaster(dataUrl: string, paper: PaperMm, decode: DecodeFn = decodeLogoWithElectron): Promise<Raster | null> {
  if (!dataUrl) return null;
  try {
    const pixels = await decode(dataUrl);
    return pixels ? rasterFromRgba(pixels, paper) : null;
  } catch {
    return null;
  }
}

export type { DecodeFn };
