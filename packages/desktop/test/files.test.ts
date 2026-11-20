import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// files.ts imports Electron, which plain Node cannot load. The dialogs below must never open in
// these tests: if they do, the test-only path is not being honoured and the call fails loudly.
const electron = vi.hoisted(() => ({
  app: { isPackaged: false, getPath: () => "/tmp" },
  dialog: {
    showOpenDialog: async () => {
      throw new Error("the open window must not appear when a test path is set");
    },
    showSaveDialog: async () => {
      throw new Error("the save window must not appear when a test path is set");
    },
  },
}));
vi.mock("electron", () => electron);

import { createFileDialogs, decodeCsv, testPath } from "../electron/files";

describe("testPath: the test-only way to skip the native file windows", () => {
  it("returns nothing when the variable is not set, so the normal window is used", () => {
    expect(testPath("TILLBASE_TEST_CSV_OPEN", {}, false)).toBeNull();
  });

  it("returns nothing for an empty or blank value", () => {
    expect(testPath("TILLBASE_TEST_CSV_OPEN", { TILLBASE_TEST_CSV_OPEN: "" }, false)).toBeNull();
    expect(testPath("TILLBASE_TEST_CSV_OPEN", { TILLBASE_TEST_CSV_OPEN: "   " }, false)).toBeNull();
  });

  it("returns the path when set in a development run", () => {
    expect(testPath("TILLBASE_TEST_CSV_OPEN", { TILLBASE_TEST_CSV_OPEN: "/tmp/a.csv" }, false)).toBe("/tmp/a.csv");
  });

  it("is ignored completely in an installed (packaged) app, even when the variable is set", () => {
    expect(testPath("TILLBASE_TEST_CSV_OPEN", { TILLBASE_TEST_CSV_OPEN: "/tmp/a.csv" }, true)).toBeNull();
    expect(testPath("TILLBASE_TEST_CSV_SAVE", { TILLBASE_TEST_CSV_SAVE: "/tmp/b.csv" }, true)).toBeNull();
  });

  it("reads only the variable it is asked for", () => {
    expect(testPath("TILLBASE_TEST_CSV_SAVE", { TILLBASE_TEST_CSV_OPEN: "/tmp/a.csv" }, false)).toBeNull();
  });
});

describe("file dialogs with a test path", () => {
  const dialogs = createFileDialogs(() => null);

  it("reads the file at the test path without opening a window, and still checks the file type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-files-"));
    const good = join(dir, "menu.csv");
    writeFileSync(good, "name,price\nTea,10\n");
    process.env.TILLBASE_TEST_CSV_OPEN = good;
    try {
      expect(await dialogs.openCsv()).toEqual({ name: "menu.csv", text: "name,price\nTea,10\n" });

      const wrongType = join(dir, "menu.txt");
      writeFileSync(wrongType, "x");
      process.env.TILLBASE_TEST_CSV_OPEN = wrongType;
      await expect(dialogs.openCsv()).rejects.toThrow(/\.csv/);

      process.env.TILLBASE_TEST_CSV_OPEN = join(dir, "missing.csv");
      await expect(dialogs.openCsv()).rejects.toThrow(/could not open/);
    } finally {
      delete process.env.TILLBASE_TEST_CSV_OPEN;
    }
  });

  it("writes to the test path without opening a window, adding .csv when it is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-files-"));
    process.env.TILLBASE_TEST_CSV_SAVE = join(dir, "out");
    try {
      const saved = await dialogs.saveCsv("ignored.csv", "a,b\n1,2\n");
      expect(saved).toBe(join(dir, "out.csv"));
      expect(readFileSync(join(dir, "out.csv"), "utf8")).toBe("a,b\n1,2\n");
    } finally {
      delete process.env.TILLBASE_TEST_CSV_SAVE;
    }
  });

  it("falls back to the system window when no test path is set", async () => {
    delete process.env.TILLBASE_TEST_CSV_OPEN;
    await expect(dialogs.openCsv()).rejects.toThrow(/open window must not appear/);
  });
});

describe("decodeCsv", () => {
  it("reads UTF-8 and falls back to Windows-1252", () => {
    expect(decodeCsv(new TextEncoder().encode("Café"))).toBe("Café");
    expect(decodeCsv(Uint8Array.from([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
  });
});
