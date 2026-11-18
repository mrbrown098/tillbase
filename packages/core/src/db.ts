import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { migrate } from "./migrations.js";

/**
 * Open (and migrate) a Tillbase database. Pass a file path for a real shop,
 * or ":memory:" (the default) for tests.
 */
export function openDatabase(path = ":memory:"): Db {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

export type { Db };
