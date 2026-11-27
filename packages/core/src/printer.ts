import type { Db } from "./db.js";

/**
 * Where receipts go. Kept in the shared `settings` table under its own `printer.*` keys, so it does not touch
 * the shop settings. `host` empty means "no receipt printer set up": printing then uses the system print window.
 */
export interface PrinterConfig {
  /** Address of a network receipt printer, e.g. "192.168.1.50" or "kitchen-printer.local". Empty for none. */
  host: string;
  /** Almost every receipt printer listens on 9100. */
  port: number;
  /** Also open the cash drawer (through the printer) when a sale includes cash. */
  openDrawer: boolean;
  /**
   * How bytes reach the printer. "network" sends to `host:port`. "system" hands them to a printer installed on this
   * computer (a USB printer, for example) by name, through the operating system's print queue.
   */
  transport: "network" | "system";
  /** Name of the installed printer, exactly as the operating system lists it. Used when `transport` is "system". */
  systemName: string;
}

export const defaultPrinterConfig: PrinterConfig = { host: "", port: 9100, openDrawer: false, transport: "network", systemName: "" };

/** "192.168.1.50" or "printer-1.local": letters, digits, dots and dashes only. */
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export class PrinterConfigService {
  constructor(private readonly db: Db) {}

  get(): PrinterConfig {
    const rows = this.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'printer.%'").all() as { key: string; value: string }[];
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const port = Number(s["printer.port"]);
    return {
      host: s["printer.host"] ?? defaultPrinterConfig.host,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : defaultPrinterConfig.port,
      openDrawer: s["printer.openDrawer"] === "true",
      transport: s["printer.transport"] === "system" ? "system" : "network",
      systemName: s["printer.systemName"] ?? "",
    };
  }

  set(patch: Partial<PrinterConfig>): PrinterConfig {
    const next = { ...this.get(), ...patch };
    next.host = next.host.trim();
    if (next.host && !HOST.test(next.host)) {
      throw new Error("That printer address does not look right. Use numbers like 192.168.1.50, or a name like printer.local");
    }
    if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) {
      throw new Error("The printer port must be a number between 1 and 65535 (most printers use 9100)");
    }
    if (next.transport !== "network" && next.transport !== "system") throw new Error("Choose a network printer or a printer installed on this computer");
    next.systemName = String(next.systemName ?? "").trim();
    // eslint-disable-next-line no-control-regex
    if (next.systemName.length > 200 || /[\u0000-\u001f]/.test(next.systemName)) throw new Error("That printer name does not look right. Choose it from the list");
    if (next.transport === "system" && !next.systemName) throw new Error("Choose which installed printer to use");
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.transaction(() => {
      put.run("printer.host", next.host);
      put.run("printer.port", String(next.port));
      put.run("printer.openDrawer", String(!!next.openDrawer));
      put.run("printer.transport", next.transport);
      put.run("printer.systemName", next.systemName);
    })();
    return this.get();
  }
}
