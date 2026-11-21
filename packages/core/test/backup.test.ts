import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupManager,
  ProductService,
  copyBackupToFolder,
  listBackups,
  migrations,
  openDatabase,
  readBackupConfig,
  restoreFromBackup,
  type Db,
} from "../src/index.js";

let root: string;
let dbPath: string;
let db: Db;
let manager: BackupManager;

const names = (dir: string) => readdirSync(dir).sort();
const productNames = (file: string) => {
  const d = new Database(file, { readonly: true });
  try {
    return (d.prepare("SELECT name FROM products ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  } finally {
    d.close();
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tillbase-backup-"));
  mkdirSync(join(root, "data"));
  dbPath = join(root, "data", "tillbase.sqlite");
  db = openDatabase(dbPath);
  new ProductService(db).create({ name: "Tea", priceMinor: 15000 });
  manager = new BackupManager(db, { dbPath });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // Already closed by a restore.
  }
  rmSync(root, { recursive: true, force: true });
});

describe("backing up to a second place", () => {
  it("copies each backup to the chosen folder and keeps a copy on this computer", async () => {
    const usb = join(root, "usb");
    mkdirSync(usb);
    await manager.setSecondFolder(usb);
    const file = await manager.backupNow();
    expect(existsSync(file)).toBe(true);
    const copies = listBackups(usb);
    expect(copies).toHaveLength(1);
    expect(productNames(join(usb, copies[0]!.name))).toEqual(["Tea"]);
    const status = manager.status();
    expect(status.warning).toBeNull();
    expect(status.backups.map((b) => b.where).sort()).toEqual(["computer", "second"]);
  });

  it("never blocks selling when the folder is missing: the backup still succeeds and a plain warning shows", async () => {
    const usb = join(root, "usb");
    mkdirSync(usb);
    await manager.setSecondFolder(usb);
    rmSync(usb, { recursive: true });
    const file = await manager.backupNow(); // must not throw
    expect(existsSync(file)).toBe(true);
    const warning = manager.status().warning;
    expect(warning).toMatch(/second backup place/);
    expect(warning).toMatch(/selling is not affected/);
    // The missing drive's folder is not quietly created on this computer.
    expect(existsSync(usb)).toBe(false);
    // Plugging the drive back in clears the warning on the next backup.
    mkdirSync(usb);
    await manager.backupNow();
    expect(manager.status().warning).toBeNull();
    expect(listBackups(usb)).toHaveLength(1);
  });

  it("refuses a folder that does not exist or sits inside Tillbase's own data", async () => {
    await expect(manager.setSecondFolder(join(root, "nope"))).rejects.toThrow(/cannot be found/);
    await expect(manager.setSecondFolder(join(root, "data", "backups"))).rejects.toThrow(/different place/);
    expect(readBackupConfig(join(root, "data")).secondFolder).toBeNull();
  });

  it("remembers the folder outside the database and can forget it", async () => {
    const usb = join(root, "usb");
    mkdirSync(usb);
    await manager.backupNow();
    await manager.setSecondFolder(usb); // the newest copy is put there straight away
    expect(readBackupConfig(join(root, "data")).secondFolder).toBe(usb);
    expect(listBackups(usb)).toHaveLength(1);
    manager.clearSecondFolder();
    expect(manager.status().secondFolder).toBeNull();
    rmSync(join(usb, listBackups(usb)[0]!.name));
    await manager.backupNow();
    expect(listBackups(usb)).toHaveLength(0); // nothing is copied once it is forgotten
  });

  it("only prunes Tillbase backups in the second folder, never other files", async () => {
    const usb = join(root, "usb");
    mkdirSync(usb);
    writeFileSync(join(usb, "holiday-photos.sqlite"), "keep me");
    for (let d = 1; d <= 5; d++) writeFileSync(join(usb, `tillbase-2020-01-0${d}.sqlite`), "old");
    const file = await manager.backupNow();
    await copyBackupToFolder(file, usb, 2);
    expect(names(usb).filter((n) => n.startsWith("tillbase-"))).toHaveLength(2);
    expect(names(usb)).toContain("holiday-photos.sqlite");
  });

  it("leaves no half-written copies behind", async () => {
    const usb = join(root, "usb");
    mkdirSync(usb);
    await manager.setSecondFolder(usb);
    await manager.backupNow();
    expect(names(usb).some((n) => n.endsWith(".partial"))).toBe(false);
    expect(names(join(root, "data", "backups")).some((n) => n.endsWith(".partial"))).toBe(false);
  });
});

describe("restoring", () => {
  it("brings back the data as it was, opens cleanly, and keeps the current file as .before-restore", async () => {
    const file = await manager.backupNow(); // has Tea only
    const products = new ProductService(db);
    products.create({ name: "Cake", priceMinor: 30000 });
    expect(productNames(dbPath)).toEqual(["Cake", "Tea"]);
    const name = listBackups(join(root, "data", "backups"))[0]!.name;
    expect(file.endsWith(name)).toBe(true);

    let closed = 0;
    const result = manager.restore(name, "computer", () => {
      closed++;
      db.close();
    });
    expect(closed).toBe(1);
    expect(result.previousCopy).toBe(`${dbPath}.before-restore`);

    // The restored file opens with the normal code and has the old data.
    const reopened = openDatabase(dbPath);
    expect((reopened.pragma("integrity_check", { simple: true }) as string)).toBe("ok");
    expect(new ProductService(reopened).list().map((p) => p.name)).toEqual(["Tea"]);
    reopened.close();

    // What was live a moment ago is kept, whole, with its later data.
    expect(productNames(`${dbPath}.before-restore`)).toEqual(["Cake", "Tea"]);
    expect(existsSync(`${dbPath}.restoring`)).toBe(false);
  });

  it("restores from the second place too", async () => {
    const usb = join(root, "usb");
    mkdirSync(usb);
    await manager.setSecondFolder(usb);
    await manager.backupNow();
    new ProductService(db).create({ name: "Cake", priceMinor: 30000 });
    // Lose the local copies, as if the computer's disk had been replaced.
    rmSync(join(root, "data", "backups"), { recursive: true });
    const name = listBackups(usb)[0]!.name;
    manager.restore(name, "second", () => db.close());
    expect(productNames(dbPath)).toEqual(["Tea"]);
    // The second-place setting survives the restore because it is not inside the database.
    expect(readBackupConfig(join(root, "data")).secondFolder).toBe(usb);
  });

  it("does not touch or even close the live data when the backup is damaged", async () => {
    const bad = join(root, "data", "backups");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "tillbase-2020-01-01.sqlite"), "this is not a database at all");
    let closed = false;
    expect(() =>
      manager.restore("tillbase-2020-01-01.sqlite", "computer", () => {
        closed = true;
      }),
    ).toThrow(/damaged or is not a Tillbase backup/);
    expect(closed).toBe(false);
    expect(productNames(dbPath)).toEqual(["Tea"]); // live db still open and unchanged
    expect(existsSync(`${dbPath}.before-restore`)).toBe(false);
    expect(existsSync(`${dbPath}.restoring`)).toBe(false);
  });

  it("rejects a truncated copy of a real backup", async () => {
    const file = await manager.backupNow();
    const bytes = readFileSync(file);
    const cut = join(root, "data", "backups", "tillbase-2020-02-02.sqlite");
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 3)));
    expect(() => manager.restore("tillbase-2020-02-02.sqlite", "computer", () => db.close())).toThrow(/damaged/);
    expect(productNames(dbPath)).toEqual(["Tea"]);
  });

  it("rejects a valid SQLite file that is not a Tillbase shop", async () => {
    const dir = join(root, "data", "backups");
    mkdirSync(dir, { recursive: true });
    const other = new Database(join(dir, "tillbase-2020-03-03.sqlite"));
    other.exec("CREATE TABLE notes (x TEXT)");
    other.close();
    expect(() => manager.restore("tillbase-2020-03-03.sqlite", "computer", () => db.close())).toThrow(/not a Tillbase backup/);
    expect(productNames(dbPath)).toEqual(["Tea"]);
  });

  it("rejects a backup from a newer Tillbase", async () => {
    const file = await manager.backupNow();
    const future = join(root, "data", "backups", "tillbase-2099-01-01.sqlite");
    writeFileSync(future, readFileSync(file));
    const d = new Database(future);
    d.pragma("user_version = 9999");
    d.close();
    expect(() => manager.restore("tillbase-2099-01-01.sqlite", "computer", () => db.close())).toThrow(/newer version of Tillbase/);
    expect(productNames(dbPath)).toEqual(["Tea"]);
  });

  it("upgrades a backup made by an older Tillbase, and the data comes through", () => {
    const dir = join(root, "data", "backups");
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, "tillbase-2020-04-04.sqlite");
    const old = new Database(oldFile);
    old.exec(migrations[0]!.sql);
    old.pragma("user_version = 1");
    old.prepare("INSERT INTO products (id, name, price_minor, created_at, updated_at) VALUES ('p1', 'OldTea', 5000, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')").run();
    old.close();
    expect(migrations.length).toBeGreaterThan(1);

    const result = manager.restore("tillbase-2020-04-04.sqlite", "computer", () => db.close());
    expect(result.schemaVersion).toBe(1);
    const reopened = openDatabase(dbPath); // runs the remaining migrations
    expect(reopened.pragma("user_version", { simple: true })).toBe(migrations.length);
    expect(new ProductService(reopened).list().map((p) => p.name)).toEqual(["OldTea"]);
    reopened.close();
  });

  it("only accepts Tillbase's own backup names, so a request cannot point at another file", async () => {
    for (const bad of ["../tillbase.sqlite", "tillbase.sqlite", "/etc/passwd", "tillbase-2020-01-01.sqlite/../../x", ""]) {
      expect(() => manager.restore(bad, "computer", () => db.close())).toThrow(/not one of Tillbase's backup files/);
    }
    expect(productNames(dbPath)).toEqual(["Tea"]);
  });

  it("says so plainly when the backup file has gone (unplugged drive)", () => {
    expect(() => manager.restore("tillbase-2020-05-05.sqlite", "computer", () => db.close())).toThrow(/not there any more/);
  });

  it("keeps an earlier safety copy instead of overwriting it, and only the newest few", async () => {
    const file = await manager.backupNow();
    const name = basename(file);
    for (let i = 0; i < 7; i++) {
      manager.restore(name, "computer", () => {
        try {
          db.close();
        } catch {
          // closed by the previous round
        }
      });
      db = openDatabase(dbPath);
      manager = new BackupManager(db, { dbPath });
    }
    const safety = names(join(root, "data")).filter((n) => n.startsWith("tillbase.sqlite.before-restore") && !/-(wal|shm)$/.test(n));
    expect(safety.length).toBeGreaterThanOrEqual(2);
    expect(safety.length).toBeLessThanOrEqual(5);
    expect(safety).toContain("tillbase.sqlite.before-restore");
  });
});

describe("restoreFromBackup directly", () => {
  it("puts everything back if the swap cannot be completed", () => {
    const backup = join(root, "b.sqlite");
    const d = openDatabase(backup);
    new ProductService(d).create({ name: "FromBackup", priceMinor: 100 });
    d.close();
    // Make the data folder read-only so renaming inside it fails after the checks pass.
    const dataDir = join(root, "data");
    let threw = false;
    try {
      restoreFromBackup({
        dbPath,
        backupFile: backup,
        closeLive: () => {
          chmodSync(dataDir, 0o555);
        },
      });
    } catch {
      threw = true;
    } finally {
      chmodSync(dataDir, 0o755);
    }
    // Running as root ignores directory permissions, so the swap may legitimately succeed there.
    if (threw) expect(productNames(dbPath)).toEqual(["Tea"]);
    else expect(productNames(dbPath)).toEqual(["FromBackup"]);
  });
});
