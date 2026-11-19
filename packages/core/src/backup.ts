import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { localDate } from "./dates.js";

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
  const old = readdirSync(dir)
    .filter((f) => /^tillbase-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
    .sort()
    .reverse()
    .slice(Math.max(1, keep));
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
}
