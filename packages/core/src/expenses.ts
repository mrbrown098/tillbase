import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { assertDate, localDate } from "./dates.js";
import type { PayMethod } from "./purchases.js";

export interface ExpenseCategory {
  id: string;
  name: string;
  active: boolean;
}

export interface Expense {
  id: string;
  categoryId: string;
  category: string;
  description: string;
  amountMinor: number;
  spentOn: string;
  method: PayMethod;
  createdAt: string;
  voided: boolean;
  voidReason: string | null;
}

export interface ExpenseInput {
  categoryId: string;
  description: string;
  amountMinor: number;
  /** Calendar day the cost belongs to (YYYY-MM-DD). Defaults to today. */
  spentOn?: string;
  method?: PayMethod;
  userId?: string;
}

interface Row {
  id: string;
  category_id: string;
  category: string;
  description: string;
  amount_minor: number;
  spent_on: string;
  method: PayMethod;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

const toExpense = (r: Row): Expense => ({
  id: r.id,
  categoryId: r.category_id,
  category: r.category,
  description: r.description,
  amountMinor: r.amount_minor,
  spentOn: r.spent_on,
  method: r.method,
  createdAt: r.created_at,
  voided: r.voided_at !== null,
  voidReason: r.void_reason,
});

const SELECT = `SELECT e.*, c.name AS category FROM expenses e JOIN expense_categories c ON c.id = e.category_id`;

/** Running costs: rent, electricity, gas, packaging and so on. */
export class ExpenseService {
  constructor(private readonly db: Db) {}

  categories(): ExpenseCategory[] {
    return (
      this.db
        .prepare("SELECT id, name, active FROM expense_categories WHERE active = 1 ORDER BY name COLLATE NOCASE")
        .all() as { id: string; name: string; active: number }[]
    ).map((r) => ({ id: r.id, name: r.name, active: r.active === 1 }));
  }

  addCategory(name: string): ExpenseCategory {
    const n = name?.trim();
    if (!n) throw new Error("Category name is required");
    const id = randomUUID();
    try {
      this.db.prepare("INSERT INTO expense_categories (id, name) VALUES (?, ?)").run(id, n);
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        throw new Error("That category already exists");
      }
      throw e;
    }
    return { id, name: n, active: true };
  }

  add(input: ExpenseInput): Expense {
    if (!input.description?.trim()) throw new Error("A description is required");
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new Error("Amount must be a positive whole amount");
    }
    const spentOn = input.spentOn ?? localDate();
    assertDate("Date", spentOn);
    const cat = this.db
      .prepare("SELECT id FROM expense_categories WHERE id = ? AND active = 1")
      .get(input.categoryId);
    if (!cat) throw new Error("Choose a category");

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO expenses (id, category_id, description, amount_minor, spent_on, method, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.categoryId,
        input.description.trim(),
        input.amountMinor,
        spentOn,
        input.method ?? "cash",
        input.userId ?? null,
        new Date().toISOString(),
      );
    return this.mustGet(id);
  }

  /** Cancel a mistaken entry. It stays on record, marked void, and no longer counts. */
  void(id: string, reason: string): Expense {
    if (!reason?.trim()) throw new Error("A reason is required");
    const e = this.mustGet(id);
    if (e.voided) throw new Error("That expense is already cancelled");
    this.db
      .prepare("UPDATE expenses SET voided_at = ?, void_reason = ? WHERE id = ?")
      .run(new Date().toISOString(), reason.trim(), id);
    return this.mustGet(id);
  }

  list(from: string, to: string): Expense[] {
    assertDate("From", from);
    assertDate("To", to);
    return (
      this.db
        .prepare(`${SELECT} WHERE e.spent_on >= ? AND e.spent_on <= ? ORDER BY e.spent_on DESC, e.created_at DESC`)
        .all(from, to) as Row[]
    ).map(toExpense);
  }

  /** Total spent per category, biggest first. Cancelled entries are left out. */
  totalsByCategory(from: string, to: string): { categoryId: string; name: string; totalMinor: number }[] {
    return this.db
      .prepare(
        `SELECT c.id AS categoryId, c.name AS name, SUM(e.amount_minor) AS totalMinor
           FROM expenses e JOIN expense_categories c ON c.id = e.category_id
          WHERE e.voided_at IS NULL AND e.spent_on >= ? AND e.spent_on <= ?
          GROUP BY c.id ORDER BY totalMinor DESC`,
      )
      .all(from, to) as { categoryId: string; name: string; totalMinor: number }[];
  }

  private mustGet(id: string): Expense {
    const r = this.db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
    if (!r) throw new Error("Expense not found");
    return toExpense(r);
  }
}
