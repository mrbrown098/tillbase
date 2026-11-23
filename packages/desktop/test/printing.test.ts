import net from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import { describeNetworkError, logoRaster, sendToPrinter } from "../electron/printing";
import { channels, type TillbaseApi } from "../shared/api";

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const ascii = (s: string) => hex(Array.from(s, (c) => c.charCodeAt(0)));

interface Sent { host: string; port: number; bytes: Uint8Array }
let api: TillbaseApi;
let sent: Sent[];
let printerDown: Error | null;
let logoPixels: { width: number; height: number; data: Uint8Array } | null | "throw";

async function signInAs(name: string, role: "owner" | "manager" | "cashier") {
  await api.logout();
  const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
  await api.login(owner.id, "1111");
  if (role === "owner") return;
  if (!(await api.loginUsers()).some((u) => u.name === name)) await api.createStaff({ name, pin: "2222", role });
  const u = (await api.loginUsers()).find((x) => x.name === name)!;
  await api.logout();
  await api.login(u.id, "2222");
}

beforeEach(async () => {
  sent = [];
  printerDown = null;
  logoPixels = null;
  api = createHandlers(openDatabase(":memory:"), "T1", () => 1_000_000, {
    printing: {
      send: async (host, port, bytes) => {
        if (printerDown) throw printerDown;
        sent.push({ host, port, bytes });
      },
      decodeLogo: () => {
        if (logoPixels === "throw") throw new Error("bad picture");
        return logoPixels;
      },
    },
  });
  await api.setupOwner("Boss", "1111");
});

async function sell(method: "cash" | "card") {
  const tea = await api.createProduct({ name: "Tea", priceMinor: 5_000, trackStock: false });
  if (!(await api.session()).shift) await api.openShift(10_000);
  const r = await api.checkout({ lines: [{ productId: tea.id, qty: 2 }], payments: [{ method, amountMinor: 10_000 }] });
  return r.sale;
}

describe("the printing calls are wired through", () => {
  it("each method is in the channel list and has a handler", () => {
    for (const n of ["getPrinter", "setPrinter", "printReceipt", "printKitchenTicket", "printStatement", "printTestPage", "openCashDrawer"]) {
      expect(channels).toContain(n);
      expect(typeof (api as unknown as Record<string, unknown>)[n]).toBe("function");
    }
  });
});

describe("printer settings", () => {
  it("starts with no printer and port 9100, and saves what the owner sets", async () => {
    expect(await api.getPrinter()).toEqual({ host: "", port: 9100, openDrawer: false });
    expect(await api.setPrinter({ host: " 192.168.1.50 ", openDrawer: true })).toEqual({ host: "192.168.1.50", port: 9100, openDrawer: true });
    expect(await api.getPrinter()).toEqual({ host: "192.168.1.50", port: 9100, openDrawer: true });
    expect((await api.setPrinter({ host: "" })).host).toBe("");
  });

  it("refuses an address or port that cannot be right, in plain words", async () => {
    await expect(api.setPrinter({ host: "not an address!" })).rejects.toThrow(/does not look right/);
    await expect(api.setPrinter({ host: "10.0.0.2", port: 70000 })).rejects.toThrow(/between 1 and 65535/);
    expect((await api.getPrinter()).host).toBe("");
  });

  it("only the owner may change it; anyone signed in may read it; nobody signed out may", async () => {
    await signInAs("Cy", "cashier");
    await expect(api.setPrinter({ host: "10.0.0.2" })).rejects.toThrow(/permission/);
    await expect(api.printTestPage()).rejects.toThrow(/permission/);
    expect((await api.getPrinter()).port).toBe(9100);
    await signInAs("Mo", "manager");
    await expect(api.setPrinter({ host: "10.0.0.2" })).rejects.toThrow(/permission/);
    await api.logout();
    await expect(api.getPrinter()).rejects.toThrow(/sign in/i);
  });
});

describe("printing a receipt", () => {
  it("with no printer set up it says so and sends nothing (the screen then uses the print window)", async () => {
    const sale = await sell("cash");
    expect(await api.printReceipt(sale.id)).toEqual({ status: "no_printer" });
    expect(sent).toHaveLength(0);
  });

  it("sends the receipt text to the saved address and port, as ESC/POS ending with a cut", async () => {
    await api.setPrinter({ host: "192.168.1.50", port: 9101 });
    const sale = await sell("card");
    expect(await api.printReceipt(sale.id)).toEqual({ status: "printed" });
    expect(sent).toHaveLength(1);
    const { host, port, bytes } = sent[0]!;
    expect([host, port]).toEqual(["192.168.1.50", 9101]);
    const h = hex(bytes);
    expect(h.startsWith("1b 40 1b 74 00")).toBe(true); // init, code page
    expect(h).toContain(ascii(`Receipt: ${sale.receiptNo}`));
    expect(h).toContain(ascii("TOTAL"));
    expect(h).toContain(ascii("Powered by Tillbase")); // the credit footer built into the receipt text
    expect(h.endsWith("1b 64 04 1d 56 42 00")).toBe(true); // feed 4, cut
    expect(h).not.toContain("1b 70 00 19 fa"); // drawer not asked for
  });

  it("opens the cash drawer only when asked to AND the sale took cash", async () => {
    await api.setPrinter({ host: "10.0.0.9", openDrawer: true });
    const cash = await sell("cash");
    await api.printReceipt(cash.id);
    expect(hex(sent[0]!.bytes)).toContain("1b 70 00 19 fa");
    const card = await sell("card");
    await api.printReceipt(card.id);
    expect(hex(sent[1]!.bytes)).not.toContain("1b 70 00 19 fa");
    await api.setPrinter({ openDrawer: false });
    await api.printReceipt(cash.id);
    expect(hex(sent[2]!.bytes)).not.toContain("1b 70 00 19 fa");
  });

  it("prints the logo above the receipt when there is one, at the paper's width", async () => {
    await api.updateSettings({ businessLogo: "data:image/png;base64,AAAA" });
    await api.setPrinter({ host: "10.0.0.9" });
    // A 1000 x 100 white-on-white picture: 58 mm paper is 384 dots wide -> 384 x 38 dots (3.84 rounds to 38); 48 bytes per row.
    logoPixels = { width: 1000, height: 100, data: new Uint8Array(1000 * 100 * 4).fill(255) };
    const sale = await sell("card");
    await api.printReceipt(sale.id);
    expect(hex(sent[0]!.bytes)).toContain("1d 76 30 00 30 00 26 00"); // GS v 0, 48 bytes wide, 38 rows
    await api.updateSettings({ receiptWidth: 48 });
    await api.printReceipt(sale.id);
    // 80 mm paper is 576 dots = 72 bytes (0x48) wide; 1000 x 100 scaled by 0.576 is 576 x 57.6 -> 58 rows (0x3a).
    expect(hex(sent[1]!.bytes)).toContain("1d 76 30 00 48 00 3a 00");
  });

  it("skips a logo it cannot read, quietly, and still prints", async () => {
    await api.updateSettings({ businessLogo: "data:image/png;base64,AAAA" });
    await api.setPrinter({ host: "10.0.0.9" });
    const sale = await sell("card");
    for (const bad of [null, "throw"] as const) {
      logoPixels = bad;
      expect(await api.printReceipt(sale.id)).toEqual({ status: "printed" });
    }
    expect(sent).toHaveLength(2);
    for (const s of sent) expect(hex(s.bytes)).not.toContain("1d 76 30");
  });

  it("never blocks a sale: a printer that is off gives a message, and the sale is still saved", async () => {
    await api.setPrinter({ host: "10.0.0.9" });
    printerDown = new Error("Could not reach the printer at 10.0.0.9: no answer after 3 seconds.");
    const sale = await sell("cash");
    expect(await api.printReceipt(sale.id)).toEqual({ status: "failed", message: "Could not reach the printer at 10.0.0.9: no answer after 3 seconds." });
    expect((await api.recentSales()).map((s) => s.id)).toContain(sale.id);
    printerDown = null; // "Print again" works once the printer is back
    expect(await api.printReceipt(sale.id)).toEqual({ status: "printed" });
  });

  it("a cashier can print a receipt, and an unknown sale is an error", async () => {
    await api.setPrinter({ host: "10.0.0.9" });
    const sale = await sell("card");
    await signInAs("Cy", "cashier");
    expect((await api.printReceipt(sale.id)).status).toBe("printed");
    await expect(api.printReceipt("nope")).rejects.toThrow(/not found/i);
  });
});

describe("kitchen ticket, statement, test page and drawer", () => {
  it("prints a kitchen ticket with a big first line and no logo", async () => {
    await api.updateSettings({ businessLogo: "data:image/png;base64,AAAA" });
    await api.setPrinter({ host: "10.0.0.9" });
    logoPixels = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) };
    const tea = await api.createProduct({ name: "Tea", priceMinor: 5_000, trackStock: false });
    await api.openShift(0);
    const o = await api.createOrder({ type: "dine_in", tableLabel: "4" });
    await api.addOrderItem(o.id, { productId: tea.id, qty: 2 });
    const t = await api.sendToKitchen(o.id);
    expect(await api.printKitchenTicket(t)).toEqual({ status: "printed" });
    const h = hex(sent[0]!.bytes);
    expect(h).toContain(`1b 45 01 1d 21 11 ${ascii(`KITCHEN  #${t.token}`)} 0a 1d 21 00 1b 45 00`);
    expect(h).toContain(ascii("2 x Tea"));
    expect(h).not.toContain("1d 76 30");
  });

  it("prints a customer statement (cashiers may: they take repayments)", async () => {
    await api.setPrinter({ host: "10.0.0.9" });
    const c = await api.createCustomer({ name: "Ayesha Khan", phone: "0300 1234567" });
    await signInAs("Cy", "cashier");
    expect((await api.printStatement(c.id)).status).toBe("printed");
    expect(hex(sent[0]!.bytes)).toContain(ascii("ACCOUNT STATEMENT"));
  });

  it("test page: owner only, and can open the drawer too", async () => {
    await api.setPrinter({ host: "10.0.0.9" });
    expect((await api.printTestPage(true)).status).toBe("printed");
    const h = hex(sent[0]!.bytes);
    expect(h).toContain(ascii("Printer test"));
    expect(h).toContain("1b 70 00 19 fa");
  });

  it("opening the drawer with no sale is for managers", async () => {
    await api.setPrinter({ host: "10.0.0.9" });
    await signInAs("Cy", "cashier");
    await expect(api.openCashDrawer()).rejects.toThrow(/permission/);
    await signInAs("Mo", "manager");
    expect(await api.openCashDrawer()).toEqual({ status: "printed" });
    expect(hex(sent[0]!.bytes)).toBe("1b 40 1b 70 00 19 fa");
    await signInAs("Boss", "owner");
    await api.setPrinter({ host: "" });
    expect(await api.openCashDrawer()).toEqual({ status: "no_printer" });
  });
});

describe("sending over the network (a real TCP server standing in for the printer)", () => {
  it("delivers exactly the bytes sent", async () => {
    const got: Buffer[] = [];
    const server = net.createServer((s) => s.on("data", (d) => got.push(d)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    await sendToPrinter("127.0.0.1", port, Uint8Array.from([0x1b, 0x40, 0x41, 0x0a, 0x1d, 0x56, 0x42, 0x00]));
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    expect(hex(Buffer.concat(got))).toBe("1b 40 41 0a 1d 56 42 00");
  });

  it("explains a refused connection in plain words", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    await expect(sendToPrinter("127.0.0.1", port, new Uint8Array([1]))).rejects.toThrow(`The printer at 127.0.0.1 refused the connection on port ${port}`);
  });

  it("gives up on a printer that never answers, after the timeout", async () => {
    // A listening socket that is never accepted does not complete the handshake on a full backlog; use a TEST-NET address instead.
    const t0 = Date.now();
    await expect(sendToPrinter("192.0.2.1", 9100, new Uint8Array([1]), 300)).rejects.toThrow(/printer at 192\.0\.2\.1/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("words each kind of network trouble", () => {
    const e = (code: string) => Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
    expect(describeNetworkError(e("ENOTFOUND"), "till.local", 9100)).toBe('Could not find a printer called "till.local". Check the address in the printer settings.');
    expect(describeNetworkError(e("EHOSTUNREACH"), "10.0.0.2", 9100)).toContain("cannot reach the printer at 10.0.0.2");
    expect(describeNetworkError(e("ETIMEDOUT"), "10.0.0.2", 9100, 3000)).toContain("no answer after 3 seconds");
    expect(describeNetworkError(e("EWHATEVER"), "10.0.0.2", 9100)).toBe("Could not print to 10.0.0.2: EWHATEVER.");
  });
});

describe("logoRaster", () => {
  it("is null for no logo, a picture that cannot be read, or code that throws", async () => {
    expect(await logoRaster("", 58, () => ({ width: 1, height: 1, data: new Uint8Array(4) }))).toBeNull();
    expect(await logoRaster("data:image/png;base64,AAAA", 58, () => null)).toBeNull();
    expect(await logoRaster("data:image/png;base64,AAAA", 58, () => { throw new Error("x"); })).toBeNull();
    // Outside Electron (as in these tests) the real decoder says "cannot read" instead of crashing.
    expect(await logoRaster("data:image/png;base64,AAAA", 58)).toBeNull();
  });
});
