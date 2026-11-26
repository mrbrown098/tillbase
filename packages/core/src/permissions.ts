export type Role = "owner" | "manager" | "cashier";

export type Permission =
  | "sell"
  | "discount"
  | "void"
  | "refund"
  | "cash.movement"
  | "products.manage"
  | "stock.adjust"
  | "reports.view"
  | "shifts.manage_all"
  | "users.manage"
  | "settings.manage"
  | "purchases.manage"
  | "expenses.manage"
  | "attendance.manage"
  | "finance.view"
  | "labour.manage"
  | "customers.use"
  | "customers.manage"
  | "customers.view_spend"
  | "khata.use"
  | "khata.manage";

// Cashiers can find, add and attach customers (they are serving them). Changing or correcting a customer is a manager's job.
const cashier: Permission[] = ["sell", "customers.use", "khata.use"];

const manager: Permission[] = [
  ...cashier,
  "discount",
  "void",
  "refund",
  "cash.movement",
  "products.manage",
  "stock.adjust",
  "reports.view",
  "shifts.manage_all",
  "purchases.manage",
  "expenses.manage",
  "attendance.manage",
  "customers.manage",
  "khata.manage",
];

// Profit figures and payroll are the owner's business: wages and margins are private.
const owner: Permission[] = [...manager, "users.manage", "settings.manage", "finance.view", "labour.manage", "customers.view_spend"];

const grants: Record<Role, ReadonlySet<Permission>> = {
  cashier: new Set(cashier),
  manager: new Set(manager),
  owner: new Set(owner),
};

export const roles: Role[] = ["owner", "manager", "cashier"];

export function can(role: Role, permission: Permission): boolean {
  return grants[role].has(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return [...grants[role]];
}
