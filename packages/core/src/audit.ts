import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { Db } from "./db.js";
import { assertDate, dayEndISO, dayStartISO } from "./dates.js";

export interface AuditInput {
  /** Who did it. Leave out for something with no signed-in person, such as a failed sign-in. */
  userId?: string | null;
  userName?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  /** One plain sentence. */
  summary: string;
  /** Before and after values and amounts. Anything that looks like a PIN or secret is replaced. */
  detail?: Record<string, unknown> | null;
}

export interface AuditEntry {
  seq: number;
  at: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface AuditQuery {
  from?: string;
  to?: string;
  action?: string;
  userId?: string;
  limit?: number;
  beforeSeq?: number;
}

const SECRET_WORDS = new Set(["pin", "pins", "secret", "token", "password", "passwd", "hash", "salt", "apikey", "otp"]);
/** True for names like pin, newPin, pin_hash or apiKey, but not for shipping or spinach. */
const isSecretName = (k: string): boolean =>
  k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).some((w) => SECRET_WORDS.has(w));
const MAX_DETAIL = 4_000;

/** A copy of `v` with every value under a secret-looking name replaced, however deep. */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[too deep]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = isSecretName(k) ? "[hidden]" : redact(x, depth + 1);
    return out;
  }
  if (typeof v === "string" && v.length > 300) return `${v.slice(0, 300)}...`;
  return v;
}

/** The trail of who did what. Written by the app next to the action itself; read only by the owner. */
export class AuditService {
  constructor(private readonly db: Db) {}

  /** Add one entry. Call it inside the transaction of the action it describes, so both happen or neither does. */
  record(e: AuditInput): number {
    if (!e.action.trim() || !e.entity.trim() || !e.summary.trim()) throw new Error("An audit entry needs an action, an entity and a summary");
    let detail: string | null = null;
    if (e.detail) {
      detail = JSON.stringify(redact(e.detail));
      if (detail.length > MAX_DETAIL) detail = JSON.stringify({ truncated: true, note: "Details were too long to keep" });
    }
    const r = this.db
      .prepare("INSERT INTO audit_log (at, user_id, user_name, action, entity, entity_id, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), e.userId ?? null, e.userName ?? null, e.action, e.entity, e.entityId ?? null, e.summary.slice(0, 300), detail);
    return Number(r.lastInsertRowid);
  }

  /** Whether an entry of this kind already exists for this thing (used so a repeated request is not noted twice). */
  has(action: string, entityId: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM audit_log WHERE action = ? AND entity_id = ? LIMIT 1").get(action, entityId) !== undefined;
  }

  /** Newest first. `from` and `to` are business days, inclusive. */
  list(q: AuditQuery = {}): AuditEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.from !== undefined) {
      assertDate("From", q.from);
      where.push("at >= ?");
      args.push(dayStartISO(q.from));
    }
    if (q.to !== undefined) {
      assertDate("To", q.to);
      where.push("at < ?");
      args.push(dayEndISO(q.to));
    }
    if (q.action) {
      where.push("action = ?");
      args.push(q.action);
    }
    if (q.userId) {
      where.push("user_id = ?");
      args.push(q.userId);
    }
    if (q.beforeSeq !== undefined) {
      where.push("seq < ?");
      args.push(q.beforeSeq);
    }
    const limit = Math.min(1_000, Math.max(1, Math.floor(q.limit ?? 200)));
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`)
      .all(...args, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: r.seq as number,
      at: r.at as string,
      userId: (r.user_id as string | null) ?? null,
      userName: (r.user_name as string | null) ?? null,
      action: r.action as string,
      entity: r.entity as string,
      entityId: (r.entity_id as string | null) ?? null,
      summary: r.summary as string,
      detail: r.detail ? (JSON.parse(r.detail as string) as Record<string, unknown>) : null,
    }));
  }
}

// ---- Restoring a backup ---------------------------------------------------------------------------------
// A restore replaces the whole database file, so an entry written before it would vanish with the old file.
// The entry is parked next to the database and written into the restored one the next time it is opened.

const pendingPath = (dbPath: string) => `${dbPath}.audit-pending.json`;

/** Park an entry to be written into the database that is opened after a restore. */
export function queueAuditAfterRestore(dbPath: string, entry: AuditInput): void {
  const file = pendingPath(dbPath);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), "utf8");
  renameSync(tmp, file);
}

/** Write any parked entry into `db`. Safe to call on every start. Returns true if one was written. */
export function flushPendingAudit(db: Db, dbPath: string): boolean {
  const file = pendingPath(dbPath);
  if (!existsSync(file)) return false;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as AuditInput;
    new AuditService(db).record(entry);
    unlinkSync(file);
    return true;
  } catch {
    // A damaged file must never stop the shop opening; leave it where it is for someone to look at.
    return false;
  }
}
