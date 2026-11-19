export type Role = "owner" | "manager" | "cashier";

export type Permission =
  | "sell"
  | "discount"
  | "void"
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
  | "labour.manage";

const cashier: Permission[] = ["sell"];

const manager: Permission[] = [
  ...cashier,
  "discount",
  "void",
  "cash.movement",
  "products.manage",
  "stock.adjust",
  "reports.view",
  "shifts.manage_all",
  "purchases.manage",
  "expenses.manage",
  "attendance.manage",
];

// Profit figures and payroll are the owner's business: wages and margins are private.
const owner: Permission[] = [...manager, "users.manage", "settings.manage", "finance.view", "labour.manage"];

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
