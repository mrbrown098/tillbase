import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupManager, openDatabase, type Db } from "@tillbase/core";
import { createHandlers } from "../electron/handlers";
import type { TillbaseApi } from "../shared/api";

let root: string;
let dbPath: string;
let db: Db;
let api: TillbaseApi;
let usb: string;
let restarts: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tillbase-api-bk-"));
  mkdirSync(join(root, "data"));
  usb = join(root, "usb");
  mkdirSync(usb);
  restarts = 0;
  dbPath = join(root, "data", "tillbase.sqlite");
  db = openDatabase(dbPath);
  const backups = new BackupManager(db, { dbPath });
  api = createHandlers(db, "T1", () => 1_000_000, {
    backup: () => backups.backupNow(),
    backups,
    afterRestore: () => void restarts++,
    files: {
      openCsv: async () => null,
      saveCsv: async () => null,
      chooseBackupFolder: async () => usb,
    },
  });
  await api.setupOwner("Boss", "1111");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // closed by a restore
  }
  rmSync(root, { recursive: true, force: true });
});

async function asRole(name: string, role: "manager" | "cashier") {
  await api.logout();
  const owner = (await api.loginUsers()).find((u) => u.role === "owner")!;
  await api.login(owner.id, "1111");
  await api.createStaff({ name, pin: "2222", role });
  await api.logout();
  await api.login((await api.loginUsers()).find((u) => u.name === name)!.id, "2222");
}

describe("backups screen API", () => {
  it("is owner-only", async () => {
    for (const role of ["manager", "cashier"] as const) {
      await asRole(`R-${role}`, role);
      await expect(api.backupStatus()).rejects.toThrow(/permission/);
      await expect(api.chooseBackupFolder()).rejects.toThrow(/permission/);
      await expect(api.clearBackupFolder()).rejects.toThrow(/permission/);
      await expect(api.restoreBackup("tillbase-2020-01-01.sqlite", "computer")).rejects.toThrow(/permission/);
    }
  });

  it("chooses a second place, backs up to both, and lists them", async () => {
    const chosen = await api.chooseBackupFolder();
    expect(chosen?.secondFolder).toBe(usb);
    await api.backupNow();
    const status = await api.backupStatus();
    expect(status.warning).toBeNull();
    expect(status.backups.map((b) => b.where).sort()).toEqual(["computer", "second"]);
  });

  it("keeps working, with a plain warning, when the drive is unplugged", async () => {
    await api.chooseBackupFolder();
    rmSync(usb, { recursive: true });
    await expect(api.backupNow()).resolves.toMatch(/tillbase-\d{4}-\d{2}-\d{2}\.sqlite$/);
    expect((await api.backupStatus()).warning).toMatch(/selling is not affected/);
    // Selling still works: open a shift.
    await expect(api.openShift(0)).resolves.toBeTruthy();
  });

  it("restores through the API: data comes back, old connection closed, app is told to restart, safety copy kept", async () => {
    await api.backupNow();
    await api.openShift(5_000); // happens after the backup
    const name = (await api.backupStatus()).backups[0]!.name;
    await api.restoreBackup(name, "computer");
    expect(restarts).toBe(1);
    expect(existsSync(`${dbPath}.before-restore`)).toBe(true);
    // The old connection is closed on purpose: nothing may keep using it while the app restarts.
    await expect(api.session()).rejects.toThrow(/not open/);

    const restored = openDatabase(dbPath);
    expect((restored.prepare("SELECT COUNT(*) AS n FROM shifts").get() as { n: number }).n).toBe(0);
    restored.close();
    const before = openDatabase(`${dbPath}.before-restore`);
    expect((before.prepare("SELECT COUNT(*) AS n FROM shifts").get() as { n: number }).n).toBe(1);
    before.close();
  });

  it("does not restart or sign anyone out when the backup is bad", async () => {
    await expect(api.restoreBackup("tillbase-2020-01-01.sqlite", "computer")).rejects.toThrow(/not there any more/);
    expect(restarts).toBe(0);
    await expect(api.backupStatus()).resolves.toBeTruthy();
  });
});
