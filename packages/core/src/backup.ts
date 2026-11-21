import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Db } from "./db.js";
import { openDatabase } from "./db.js";
import { localDate } from "./dates.js";
import { migrations } from "./migrations.js";

/** The only file names Tillbase writes, lists, prunes and restores: tillbase-YYYY-MM-DD.sqlite. */
export const backupNamePattern = /^tillbase-\d{4}-\d{2}-\d{2}\.sqlite$/;

/** Remove all but the newest `keep` backups in `dir`. Only files named like our own backups are touched. */
function pruneBackups(dir: string, keep: number): void {
  const old = readdirSync(dir)
    .filter((f) => backupNamePattern.test(f))
    .sort()
    .reverse()
    .slice(Math.max(1, keep));
  for (const f of old) rmSync(join(dir, f), { force: true });
}

/**
 * Save a consistent copy of the database into `dir` as tillbase-YYYY-MM-DD.sqlite
 * (one per day; a later backup the same day replaces the earlier one), then keep
 * only the newest `keep` copies. Safe to run while the app is in use.
 * Returns the file written.
 */
export async function backupDatabase(db: Db, dir: string, keep = 14): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `tillbase-${localDate()}.sqlite`);
  const tmp = `${file}.partial`;
  if (existsSync(tmp)) rmSync(tmp);
  await db.backup(tmp);
  // Rename only once the copy is complete, so a crash never leaves a half-written backup under the real name.
  renameSync(tmp, file);
  pruneBackups(dir, keep);
  return file;
}

// ---- Listing ---------------------------------------------------------------------------------------

export interface BackupFile {
  /** File name, tillbase-YYYY-MM-DD.sqlite. */
  name: string;
  sizeBytes: number;
  /** When the file was last written (ISO). */
  modifiedAt: string;
}

/** Where a backup is kept: next to the database, or in the second place the owner chose. */
export type BackupWhere = "computer" | "second";

export interface BackupEntry extends BackupFile {
  where: BackupWhere;
}

/** Backups in a folder, newest first. A folder that is missing or unreadable gives an empty list. */
export function listBackups(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: BackupFile[] = [];
  for (const name of names) {
    if (!backupNamePattern.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) files.push({ name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    } catch {
      // Removed while we looked.
    }
  }
  return files.sort((a, b) => b.name.localeCompare(a.name));
}

// ---- The second place ------------------------------------------------------------------------------

export interface BackupConfig {
  /** A folder on a USB drive or in a synced folder (Dropbox, Google Drive...), or null for none. */
  secondFolder: string | null;
}

const configName = "backup-settings.json";

/**
 * The second place is remembered in a small file next to the database, not inside it. That way
 * restoring an old backup can never switch it off or point it somewhere else, and the path stays
 * with this computer instead of travelling with the data.
 */
export function readBackupConfig(dataDir: string): BackupConfig {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, configName), "utf8")) as { secondFolder?: unknown };
    return { secondFolder: typeof raw.secondFolder === "string" && raw.secondFolder !== "" ? raw.secondFolder : null };
  } catch {
    return { secondFolder: null };
  }
}

export function writeBackupConfig(dataDir: string, config: BackupConfig): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, configName);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/**
 * Check that a folder can be used as a second place. The folder itself is never created: if a USB
 * drive is unplugged, its mount point must not be quietly recreated on the local disk, because the
 * copies would then "succeed" onto the very computer they are meant to protect against.
 */
export function checkFolder(folder: string): void {
  let st;
  try {
    st = statSync(folder);
  } catch {
    throw new Error("That folder cannot be found. If it is on a USB drive, plug the drive in and try again.");
  }
  if (!st.isDirectory()) throw new Error("That is not a folder.");
  const probe = join(folder, `.tillbase-write-test-${process.pid}`);
  try {
    writeFileSync(probe, "ok");
    rmSync(probe);
  } catch {
    throw new Error("Tillbase cannot save files in that folder. It may be read-only or full.");
  }
}

/**
 * Copy a finished backup into the second place and keep only the newest `keep` there (never touching
 * files that are not Tillbase backups). Async, so a slow drive never freezes the till.
 */
export async function copyBackupToFolder(file: string, folder: string, keep = 30): Promise<string> {
  checkFolder(folder);
  const target = join(folder, basename(file));
  const tmp = `${target}.partial`;
  try {
    await copyFile(file, tmp);
    await rename(tmp, target);
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new Error("The copy did not finish. The drive may be full or may have been unplugged.");
  }
  try {
    pruneBackups(folder, keep);
  } catch {
    // Failing to tidy old copies is not worth a warning.
  }
  return target;
}

// ---- Restoring -------------------------------------------------------------------------------------

/** A problem with a backup that is safe to show to the owner as it is. */
class BackupProblem extends Error {}

const damaged = () =>
  new BackupProblem("That file is damaged or is not a Tillbase backup, so it was not used. Your current data has not been touched.");

/**
 * Check a private copy of a backup before it is allowed anywhere near the live data: it must open,
 * pass SQLite's own integrity check, look like a Tillbase shop, and not come from a newer Tillbase
 * than this one. An older backup is upgraded here, so a failing upgrade shows up before the swap.
 */
function checkBackupCopy(file: string): number {
  let probe: Db | undefined;
  try {
    probe = new Database(file, { fileMustExist: true });
    const integrity = probe.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw damaged();
    const version = probe.pragma("user_version", { simple: true }) as number;
    const latest = migrations[migrations.length - 1]?.version ?? 0;
    if (version < 1) throw damaged();
    if (version > latest) {
      throw new BackupProblem("This backup was made by a newer version of Tillbase. Update Tillbase first, then try again. Your current data has not been touched.");
    }
    probe.close();
    probe = undefined;
    // Upgrade the copy now (an older backup is missing tables added since), then check it is a Tillbase shop.
    const upgraded = openDatabase(file);
    try {
      const tables = new Set(
        (upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
      );
      for (const t of ["settings", "users", "products", "sales"]) if (!tables.has(t)) throw damaged();
    } finally {
      upgraded.close();
    }
    return version;
  } catch (e) {
    if (e instanceof BackupProblem) throw e;
    throw damaged();
  } finally {
    try {
      probe?.close();
    } catch {
      // Already closed.
    }
  }
}

const sidecars = ["-wal", "-shm"] as const;

function removeSqliteFiles(file: string): void {
  for (const s of ["", ...sidecars]) rmSync(`${file}${s}`, { force: true });
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Older safety copies kept after restores. The newest few are enough; each one is a whole database. */
const keepBeforeRestore = 5;

function pruneBeforeRestore(dbPath: string): void {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.before-restore`;
  const copies = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && !sidecars.some((s) => f.endsWith(s)))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(keepBeforeRestore);
  for (const { f } of copies) removeSqliteFiles(join(dir, f));
}

export interface RestoreOptions {
  /** The live database file. */
  dbPath: string;
  /** The backup to restore. */
  backupFile: string;
  /**
   * Called once the backup has passed every check and just before the files are swapped. It must
   * flush and close the live database (the app then restarts).
   */
  closeLive: () => void;
}

export interface RestoreResult {
  /** Where the data that was live a moment ago has been kept: <database>.before-restore. */
  previousCopy: string;
  schemaVersion: number;
}

/**
 * Replace the live database with a backup, safely.
 *
 * 1. The backup is copied aside and checked. If anything is wrong this throws and the live data has
 *    not been touched, closed or moved.
 * 2. Only then is the live database closed and the current file kept as `<database>.before-restore`
 *    (an older one is kept under a dated name), and the checked copy renamed into place. If a rename
 *    fails, everything is put back.
 *
 * The caller restarts the app afterwards: nothing may keep using the old connection.
 */
export function restoreFromBackup(opts: RestoreOptions): RestoreResult {
  const { dbPath, backupFile } = opts;
  if (!existsSync(backupFile)) {
    throw new Error("That backup file is not there any more. If it is on a USB drive, plug the drive in and try again.");
  }
  const staging = `${dbPath}.restoring`;
  removeSqliteFiles(staging);
  try {
    copyFileSync(backupFile, staging);
  } catch {
    throw new Error("Tillbase could not read that backup file. Is the drive still connected?");
  }
  let schemaVersion: number;
  try {
    schemaVersion = checkBackupCopy(staging);
  } catch (e) {
    removeSqliteFiles(staging);
    throw e;
  }

  // From here on the live database is being replaced.
  opts.closeLive();
  const previous = `${dbPath}.before-restore`;
  const moved: [from: string, to: string][] = [];
  const move = (from: string, to: string) => {
    renameSync(from, to);
    moved.push([from, to]);
  };
  try {
    if (existsSync(previous)) {
      // Never overwrite an earlier safety copy.
      let older = `${previous}-${stamp(statSync(previous).mtime)}`;
      for (let n = 2; existsSync(older); n++) older = `${previous}-${stamp(statSync(previous).mtime)}-${n}`;
      for (const s of ["", ...sidecars]) if (existsSync(`${previous}${s}`)) move(`${previous}${s}`, `${older}${s}`);
    }
    for (const s of ["", ...sidecars]) if (existsSync(`${dbPath}${s}`)) move(`${dbPath}${s}`, `${previous}${s}`);
    move(staging, dbPath);
  } catch {
    for (const [from, to] of moved.reverse()) {
      try {
        renameSync(to, from);
      } catch {
        // Nothing more can be done; the safety copy is still on disk.
      }
    }
    removeSqliteFiles(staging);
    throw new Error("Tillbase could not swap the backup in. Your data is unchanged. Close Tillbase, open it again and try once more.");
  }
  try {
    pruneBeforeRestore(dbPath);
  } catch {
    // Tidying is optional.
  }
  return { previousCopy: previous, schemaVersion };
}

// ---- The manager the app uses ------------------------------------------------------------------------

export interface BackupStatus {
  /** The folder the shop's data lives in. */
  dataFolder: string;
  /** Where the daily copies on this computer are kept. */
  localFolder: string;
  /** The second place, or null if none has been chosen. */
  secondFolder: string | null;
  /** A plain-language warning for the owner, or null when everything is fine. */
  warning: string | null;
  /** When the last copy to the second place worked (ISO), since Tillbase started. */
  lastSecondCopyAt: string | null;
  /** Both places, newest first. */
  backups: BackupEntry[];
}

export interface BackupManagerOptions {
  /** The live database file. Copies go in a `backups` folder next to it. */
  dbPath: string;
  keepLocal?: number;
  keepSecond?: number;
}

/**
 * Everything about backups in one place: daily copies on this computer, a second copy in a folder the
 * owner chose, and restoring. A problem with the second place is recorded as a warning and never
 * thrown, so it can never stop the till.
 */
export class BackupManager {
  readonly dataDir: string;
  readonly localDir: string;
  private readonly keepLocal: number;
  private readonly keepSecond: number;
  private lastSecond: { at: string | null; problem: string | null } = { at: null, problem: null };

  constructor(
    private readonly db: Db,
    private readonly opts: BackupManagerOptions,
  ) {
    this.dataDir = dirname(opts.dbPath);
    this.localDir = join(this.dataDir, "backups");
    this.keepLocal = opts.keepLocal ?? 14;
    this.keepSecond = opts.keepSecond ?? 30;
  }

  /**
   * Back up now: a copy on this computer, then a copy in the second place if there is one.
   * Resolves with the copy on this computer. A failure of the second copy is not thrown: it becomes
   * the warning in `status()`.
   */
  async backupNow(): Promise<string> {
    const file = await backupDatabase(this.db, this.localDir, this.keepLocal);
    await this.copyToSecond(file);
    return file;
  }

  private async copyToSecond(file: string): Promise<void> {
    const { secondFolder } = readBackupConfig(this.dataDir);
    if (!secondFolder) {
      this.lastSecond = { at: null, problem: null };
      return;
    }
    try {
      await copyBackupToFolder(file, secondFolder, this.keepSecond);
      this.lastSecond = { at: new Date().toISOString(), problem: null };
    } catch (e) {
      this.lastSecond = { at: this.lastSecond.at, problem: this.explain(secondFolder, e) };
    }
  }

  private explain(folder: string, e: unknown): string {
    const why = e instanceof Error ? e.message : "Something went wrong.";
    return `Your second backup place (${folder}) could not be used. ${why} Backups are still saved on this computer, and selling is not affected.`;
  }

  status(): BackupStatus {
    const { secondFolder } = readBackupConfig(this.dataDir);
    let warning: string | null = null;
    if (secondFolder) {
      try {
        checkFolder(secondFolder);
        warning = this.lastSecond.problem
          ? `${this.lastSecond.problem} Press "Back up now" to try again.`
          : null;
      } catch (e) {
        warning = this.explain(secondFolder, e);
      }
    }
    const entries: BackupEntry[] = [
      ...listBackups(this.localDir).map((b) => ({ ...b, where: "computer" as const })),
      ...(secondFolder ? listBackups(secondFolder).map((b) => ({ ...b, where: "second" as const })) : []),
    ].sort((a, b) => b.name.localeCompare(a.name) || (a.where === "computer" ? -1 : 1));
    return {
      dataFolder: this.dataDir,
      localFolder: this.localDir,
      secondFolder,
      warning,
      lastSecondCopyAt: this.lastSecond.at,
      backups: entries,
    };
  }

  /** Choose the second place. It must exist and be writable, and be somewhere other than this computer's own backup folder. */
  async setSecondFolder(folder: string): Promise<BackupStatus> {
    const chosen = resolve(folder);
    const inside = (a: string, b: string) => a === b || a.startsWith(b + sep);
    if (inside(chosen, resolve(this.localDir)) || inside(chosen, resolve(this.dataDir))) {
      throw new Error("Please choose a different place: a USB drive, or a Dropbox or Google Drive folder. This folder is where Tillbase keeps its own data.");
    }
    checkFolder(chosen);
    writeBackupConfig(this.dataDir, { secondFolder: chosen });
    this.lastSecond = { at: null, problem: null };
    // Put the newest copy there straight away, so the folder is not empty and a problem shows at once.
    const newest = listBackups(this.localDir)[0];
    if (newest) await this.copyToSecond(join(this.localDir, newest.name));
    return this.status();
  }

  clearSecondFolder(): BackupStatus {
    writeBackupConfig(this.dataDir, { secondFolder: null });
    this.lastSecond = { at: null, problem: null };
    return this.status();
  }

  /**
   * Restore one of the listed backups. `name` must be exactly one of our own file names, so a
   * crafted request can never point this at some other file. See `restoreFromBackup`.
   */
  restore(name: string, where: BackupWhere, closeLive: () => void): RestoreResult {
    if (typeof name !== "string" || !backupNamePattern.test(name)) {
      throw new Error("That is not one of Tillbase's backup files.");
    }
    if (where !== "computer" && where !== "second") throw new Error("Choose where the backup is kept.");
    const dir = where === "second" ? readBackupConfig(this.dataDir).secondFolder : this.localDir;
    if (!dir) throw new Error("No second backup place has been set up.");
    return restoreFromBackup({ dbPath: this.opts.dbPath, backupFile: join(dir, name), closeLive });
  }
}
