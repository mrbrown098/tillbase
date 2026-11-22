import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import { roles, type Role } from "./permissions.js";

export interface User {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
  /** How many digits this person's PIN has, once known. Lets the sign-in screen show the right number of boxes. */
  pinLength: number | null;
}

interface Row {
  id: string;
  name: string;
  role: Role;
  pin_salt: string;
  pin_hash: string;
  active: number;
  created_at: string;
  pin_length: number | null;
}

const MAX_FAILS = 5;
const LOCK_MS = 30_000;

function toUser(r: Row): User {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    active: r.active === 1,
    createdAt: r.created_at,
    pinLength: r.pin_length ?? null,
  };
}

function assertPin(pin: string): void {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN must be 4 to 8 digits");
}

function hashPin(pin: string, salt: string): string {
  return scryptSync(pin, salt, 32).toString("hex");
}

/**
 * Staff accounts with PIN login. PINs are never stored: only a salted scrypt
 * hash. Repeated wrong PINs lock that account for a short time.
 */
export class UserService {
  private readonly attempts = new Map<string, { fails: number; lockedUntil: number }>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  create(input: { name: string; pin: string; role: Role }): User {
    const name = input.name?.trim();
    if (!name) throw new Error("Name is required");
    if (!roles.includes(input.role)) throw new Error("Unknown role");
    assertPin(input.pin);
    const salt = randomBytes(16).toString("hex");
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, name, role, pin_salt, pin_hash, active, created_at, pin_length)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, name, input.role, salt, hashPin(input.pin, salt), new Date().toISOString(), input.pin.length);
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        throw new Error("A staff member with this name already exists");
      }
      throw e;
    }
    return this.mustGet(id);
  }

  get(id: string): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return r ? toUser(r) : undefined;
  }

  list(opts: { includeInactive?: boolean } = {}): User[] {
    const sql = opts.includeInactive
      ? "SELECT * FROM users ORDER BY name COLLATE NOCASE"
      : "SELECT * FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE";
    return (this.db.prepare(sql).all() as Row[]).map(toUser);
  }

  /** Check a PIN. Returns the user, or throws a message that is safe to show. */
  authenticate(userId: string, pin: string): User {
    const wait = this.lockedFor(userId);
    if (wait > 0) {
      throw new Error(`Too many wrong PINs. Try again in ${Math.ceil(wait / 1000)} seconds`);
    }
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Row | undefined;
    // Run the hash even for unknown users so timing does not reveal which exist.
    const salt = row?.pin_salt ?? "0".repeat(32);
    const candidate = Buffer.from(hashPin(String(pin), salt), "hex");
    const stored = Buffer.from(row?.pin_hash ?? "0".repeat(64), "hex");
    const ok = row !== undefined && row.active === 1 && timingSafeEqual(candidate, stored);
    if (!ok) {
      this.recordFailure(userId);
      throw new Error("Wrong PIN");
    }
    this.attempts.delete(userId);
    // Accounts made before PIN lengths were recorded learn theirs now.
    if (row.pin_length == null) {
      this.db.prepare("UPDATE users SET pin_length = ? WHERE id = ?").run(String(pin).length, userId);
      row.pin_length = String(pin).length;
    }
    return toUser(row);
  }

  changePin(userId: string, newPin: string): void {
    assertPin(newPin);
    this.mustGet(userId);
    const salt = randomBytes(16).toString("hex");
    this.db
      .prepare("UPDATE users SET pin_salt = ?, pin_hash = ?, pin_length = ? WHERE id = ?")
      .run(salt, hashPin(newPin, salt), newPin.length, userId);
    this.attempts.delete(userId);
  }

  update(userId: string, patch: { name?: string; role?: Role; active?: boolean }): User {
    const cur = this.mustGet(userId);
    const next = {
      name: patch.name?.trim() ?? cur.name,
      role: patch.role ?? cur.role,
      active: patch.active ?? cur.active,
    };
    if (!next.name) throw new Error("Name is required");
    if (!roles.includes(next.role)) throw new Error("Unknown role");

    const losesOwner = cur.role === "owner" && cur.active && (next.role !== "owner" || !next.active);
    if (losesOwner && this.activeOwners() <= 1) {
      throw new Error("There must always be at least one active owner");
    }
    try {
      this.db
        .prepare("UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?")
        .run(next.name, next.role, next.active ? 1 : 0, userId);
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        throw new Error("A staff member with this name already exists");
      }
      throw e;
    }
    return this.mustGet(userId);
  }

  private activeOwners(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1")
        .get() as { n: number }
    ).n;
  }

  private lockedFor(userId: string): number {
    const a = this.attempts.get(userId);
    return a ? Math.max(0, a.lockedUntil - this.now()) : 0;
  }

  private recordFailure(userId: string): void {
    const a = this.attempts.get(userId) ?? { fails: 0, lockedUntil: 0 };
    a.fails += 1;
    if (a.fails >= MAX_FAILS) {
      a.lockedUntil = this.now() + LOCK_MS;
      a.fails = 0;
    }
    this.attempts.set(userId, a);
  }

  private mustGet(id: string): User {
    const u = this.get(id);
    if (!u) throw new Error("Staff member not found");
    return u;
  }
}
