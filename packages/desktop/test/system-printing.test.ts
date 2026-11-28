import { readFile, stat } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import { WINDOWS_RAW_SCRIPT, runCommand, sendToSystemPrinter, type RunFn, type RunResult } from "../electron/printing";
import type { TillbaseApi } from "../shared/api";

const bytes = new Uint8Array([0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x00]);

describe("sendToSystemPrinter", () => {
  it("on macOS and Linux hands the bytes to `lp -o raw` with no shell and no print dialog", async () => {
    const calls: { cmd: string; args: string[]; input?: Uint8Array }[] = [];
    const run: RunFn = async (cmd, args, o) => (calls.push({ cmd, args, input: o.input }), { code: 0, stderr: "" });
    await sendToSystemPrinter('EPSON TM-T20; rm -rf "/"', bytes, { platform: "linux", run });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("lp");
    expect(calls[0]!.args).toEqual(["-d", 'EPSON TM-T20; rm -rf "/"', "-o", "raw", "-t", "Tillbase"]);
    expect([...calls[0]!.input!]).toEqual([...bytes]);
  });

  it("on Windows writes a RAW spooler job: script in -EncodedCommand, printer and file only in the environment", async () => {
    const seen: { cmd: string; args: string[]; env?: Record<string, string>; file?: Uint8Array } = { cmd: "", args: [] };
    const run: RunFn = async (cmd, args, o) => {
      Object.assign(seen, { cmd, args, env: o.env, file: new Uint8Array(await readFile(o.env!.TILLBASE_FILE!)) });
      return { code: 0, stderr: "" };
    };
    await sendToSystemPrinter("POS-80", bytes, { platform: "win32", run });
    expect(seen.cmd).toBe("powershell.exe");
    expect(seen.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(Buffer.from(seen.args[5]!, "base64").toString("utf16le")).toBe(WINDOWS_RAW_SCRIPT);
    expect(WINDOWS_RAW_SCRIPT).toContain('"RAW"');
    expect(WINDOWS_RAW_SCRIPT).not.toContain("POS-80");
    expect(seen.args.join(" ")).not.toContain("POS-80");
    expect(seen.env!.TILLBASE_PRINTER).toBe("POS-80");
    expect([...seen.file!]).toEqual([...bytes]);
    // the temporary job file is removed afterwards
    await expect(stat(seen.env!.TILLBASE_FILE!)).rejects.toThrow();
  });

  it("removes the Windows job file even when printing fails", async () => {
    let file = "";
    const run: RunFn = async (_c, _a, o) => ((file = o.env!.TILLBASE_FILE!), { code: 1, stderr: "Exception: NOPRINTER:1801" });
    await expect(sendToSystemPrinter("Gone", bytes, { platform: "win32", run })).rejects.toThrow(/Could not find a printer called "Gone"/);
    await expect(stat(file)).rejects.toThrow();
  });

  it("explains each failure in plain words", async () => {
    const fail = (r: RunResult) => sendToSystemPrinter("P1", bytes, { platform: "linux", run: async () => r });
    await expect(fail({ code: null, stderr: "", error: Object.assign(new Error("x"), { code: "ENOENT" }) })).rejects.toThrow(/no print service/);
    await expect(fail({ code: 1, stderr: "lp: The printer or class does not exist. destination unknown" })).rejects.toThrow(/Could not find a printer called "P1"/);
    await expect(fail({ code: 1, stderr: "lp: Destination \"P1\" is not accepting jobs." })).rejects.toThrow(/would not take the receipt/);
    await expect(fail({ code: 7, stderr: "" })).rejects.toThrow(/Could not print to "P1" \(error 7\)/);
  });

  it("refuses an empty printer name", async () => {
    await expect(sendToSystemPrinter("  ", bytes, { platform: "linux", run: async () => ({ code: 0, stderr: "" }) })).rejects.toThrow(/No printer is chosen/);
  });
});

describe("runCommand (the real process runner)", () => {
  it("passes bytes on stdin and values in the environment, and reports the exit code and errors", async () => {
    const script = "let n=0;process.stdin.on('data',d=>n+=d.length);process.stdin.on('end',()=>{process.stderr.write(process.env.TB_X+':'+n);process.exit(3)})";
    const r = await runCommand(process.execPath, ["-e", script], { env: { TB_X: "ok" }, input: bytes });
    expect(r).toMatchObject({ code: 3, stderr: `ok:${bytes.length}` });
    const missing = await runCommand("tillbase-no-such-program", [], {});
    expect(missing.error?.code).toBe("ENOENT");
  });
});

describe("printing through an installed printer", () => {
  let api: TillbaseApi;
  let network: { host: string }[];
  let system: { name: string; bytes: Uint8Array }[];
  let systemDown: Error | null;

  beforeEach(async () => {
    network = [];
    system = [];
    systemDown = null;
    api = createHandlers(openDatabase(":memory:"), "T1", () => 1_000_000, {
      printing: {
        send: async (host) => void network.push({ host }),
        sendSystem: async (name, b) => {
          if (systemDown) throw systemDown;
          system.push({ name, bytes: b });
        },
        listSystem: async () => [{ name: "POS-80", isDefault: true }, { name: "Receipt 58", isDefault: false }],
      },
    });
    await api.setupOwner("Boss", "1111");
  });

  const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

  it("prints a test page to the chosen printer for 80 mm and for 58 mm, and never touches the network", async () => {
    await api.setPrinter({ transport: "system", systemName: "POS-80" });
    await api.updateSettings({ receiptWidth: 48 });
    expect(await api.printTestPage(false)).toEqual({ status: "printed" });
    await api.updateSettings({ receiptWidth: 32 });
    expect(await api.printTestPage(false)).toEqual({ status: "printed" });
    expect(network).toHaveLength(0);
    expect(system.map((s) => s.name)).toEqual(["POS-80", "POS-80"]);
    expect(text(system[0]!.bytes)).toContain("-".repeat(48));
    expect(text(system[0]!.bytes)).not.toContain("-".repeat(49));
    expect(text(system[1]!.bytes)).toContain("-".repeat(32));
    expect(text(system[1]!.bytes)).not.toContain("-".repeat(33));
    expect(system[0]!.bytes[0]).toBe(0x1b); // starts with ESC @ (initialise)
  });

  it("sends the drawer kick through the installed printer", async () => {
    await api.setPrinter({ transport: "system", systemName: "POS-80" });
    expect(await api.openCashDrawer()).toEqual({ status: "printed" });
    expect(system).toHaveLength(1);
    expect(network).toHaveLength(0);
  });

  it("keeps network printing as it was, and a network host does not count as a chosen system printer", async () => {
    await api.setPrinter({ host: "192.168.1.50" });
    expect(await api.printTestPage(false)).toEqual({ status: "printed" });
    expect(network).toEqual([{ host: "192.168.1.50" }]);
    expect(system).toHaveLength(0);
    await api.setPrinter({ transport: "system", systemName: "POS-80" });
    await api.setPrinter({ transport: "network", host: "" });
    expect(await api.printTestPage(false)).toEqual({ status: "no_printer" });
  });

  it("reports an installed printer that fails in plain words and does not throw", async () => {
    await api.setPrinter({ transport: "system", systemName: "POS-80" });
    systemDown = new Error('The printer "POS-80" would not take the receipt.');
    expect(await api.printTestPage(false)).toEqual({ status: "failed", message: 'The printer "POS-80" would not take the receipt.' });
  });

  it("validates the choice, stores it, and lists printers only for people who manage settings", async () => {
    await expect(api.setPrinter({ transport: "system", systemName: "" })).rejects.toThrow(/Choose which installed printer/);
    await expect(api.setPrinter({ transport: "system", systemName: "bad\nname" })).rejects.toThrow(/does not look right/);
    await expect(api.setPrinter({ transport: "usb" as never })).rejects.toThrow(/Choose a network printer/);
    expect(await api.setPrinter({ transport: "system", systemName: "Receipt 58" })).toMatchObject({ transport: "system", systemName: "Receipt 58" });
    expect(await api.listSystemPrinters()).toEqual([{ name: "POS-80", isDefault: true }, { name: "Receipt 58", isDefault: false }]);
    await api.createStaff({ name: "Cy", pin: "2222", role: "cashier" });
    const cy = (await api.loginUsers()).find((u) => u.name === "Cy")!;
    await api.logout();
    await api.login(cy.id, "2222");
    await expect(api.listSystemPrinters()).rejects.toThrow(/permission/);
  });

  it("returns an empty list when the printers cannot be read", async () => {
    const bare = createHandlers(openDatabase(":memory:"), "T1", () => 1_000_000);
    await bare.setupOwner("Boss", "1111");
    expect(await bare.listSystemPrinters()).toEqual([]);
  });
});
