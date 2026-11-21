import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { TillbaseApi } from "../shared/api";

let api: TillbaseApi;
let saved: { name: string; text: string }[][];
let dialogs: number;

beforeEach(async () => {
  saved = [];
  dialogs = 0;
  api = createHandlers(openDatabase(":memory:"), "T1", () => 1_000_000, {
    files: {
      openCsv: async () => null,
      saveCsv: async () => null,
      saveFiles: async (files) => {
        dialogs++;
        saved.push(files);
        return { folder: "/chosen", names: files.map((f) => f.name) };
      },
    },
  });
  await api.setupOwner("Boss", "1111");
});

describe("accountant export", () => {
  it("hands the five files to the folder dialog for the owner", async () => {
    const result = await api.exportAccounting("2026-11-01", "2026-11-30");
    expect(result?.folder).toBe("/chosen");
    expect(result?.names).toEqual([
      "tillbase-sales-by-day-2026-11-01-to-2026-11-30.csv",
      "tillbase-expenses-by-category-2026-11-01-to-2026-11-30.csv",
      "tillbase-purchases-2026-11-01-to-2026-11-30.csv",
      "tillbase-payroll-2026-11-01-to-2026-11-30.csv",
      "tillbase-profit-and-loss-2026-11-01-to-2026-11-30.csv",
    ]);
    expect(saved[0]!.every((f) => f.text.charCodeAt(0) === 0xfeff)).toBe(true);
  });

  it("needs the finance permission: managers and cashiers are refused before any window opens", async () => {
    for (const role of ["manager", "cashier"] as const) {
      await api.logout();
      const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
      await api.login(owner.id, "1111");
      await api.createStaff({ name: role, pin: "2222", role });
      await api.logout();
      await api.login((await api.loginUsers()).find((u) => u.name === role)!.id, "2222");
      await expect(api.exportAccounting("2026-11-01", "2026-11-30")).rejects.toThrow(/permission/);
    }
    expect(dialogs).toBe(0);
  });

  it("reports a bad date range before opening the folder window", async () => {
    await expect(api.exportAccounting("2026-11-30", "2026-11-01")).rejects.toThrow(/cannot be before/);
    expect(dialogs).toBe(0);
  });

  it("returns null when the person cancels the folder window", async () => {
    const a = createHandlers(openDatabase(":memory:"), "T1", () => 1, {
      files: { openCsv: async () => null, saveCsv: async () => null, saveFiles: async () => null },
    });
    await a.setupOwner("Boss", "1111");
    await expect(a.exportAccounting("2026-11-01", "2026-11-30")).resolves.toBeNull();
  });
});
