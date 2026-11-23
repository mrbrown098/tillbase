import type { Db } from "./db.js";
import type { OrderType } from "./orders.js";

/**
 * The business profile: what kind of business this is, which parts of Tillbase it shows, and the details
 * the first-run setup collects. It only decides what is SHOWN and the starting choices. It never removes a
 * permission check and never hides data, so changing it later is always safe.
 *
 * Stored in the shared `settings` table under `business.*` keys (like `printer.*`), so no migration is needed
 * and an existing installation simply has no keys yet ("legacy": nothing changes for it).
 */

// ---- Modules ----------------------------------------------------------------------------------------------------

/** The parts of the menu a business can switch off. The rest (Home, Checkout, Shift, Sales, Products, Money, Staff, Settings, Backups) are always shown. */
export const optionalModules = ["orders", "kitchen", "customers", "purchases", "orders-to-suppliers", "costs", "team"] as const;
export type ModuleId = (typeof optionalModules)[number];

export const moduleLabel: Record<ModuleId, { label: string; about: string }> = {
  orders: { label: "Orders", about: "Open orders: tables, takeaway, delivery, tokens, split bills" },
  kitchen: { label: "Kitchen", about: "The kitchen screen and kitchen tickets" },
  customers: { label: "Customers", about: "Customer list, loyalty points, wallet and khata (credit)" },
  purchases: { label: "Purchases", about: "Record stock you buy and what you owe suppliers" },
  "orders-to-suppliers": { label: "Supplier orders", about: "Orders you send to suppliers, and receiving them" },
  costs: { label: "Running costs", about: "Rent, power and other regular costs" },
  team: { label: "Team and wages", about: "Clock in and out, wages and payslips" },
};

// ---- Business types ---------------------------------------------------------------------------------------------

export const businessTypes = ["retail", "restaurant", "fastfood", "pharmacy", "custom"] as const;
export type BusinessType = (typeof businessTypes)[number];
export const retailKinds = ["grocery", "general", "clothing"] as const;
export type RetailKind = (typeof retailKinds)[number];
export const retailKindLabel: Record<RetailKind, string> = { grocery: "Grocery store", general: "General store", clothing: "Clothing store" };

export interface ProfileDefinition {
  id: BusinessType;
  label: string;
  tagline: string;
  /** Menu parts shown by default (the owner can change them later). */
  modules: readonly ModuleId[];
  /** Order types offered on the Orders screen by default. */
  orderTypes: readonly OrderType[];
  /** What the Products menu item is called. */
  productsLabel: string;
  /** Home screen buttons, in order. Each is a menu part or "checkout"/"products". */
  shortcuts: readonly ("checkout" | "orders" | "kitchen" | "customers" | "products" | "purchases")[];
  /** What works today for this kind of business. Only things that are built and tested. */
  available: readonly string[];
  /** What is NOT built yet, shown clearly so nobody relies on it. */
  notYet: readonly string[];
  /** Shown above the lists, when the profile needs a plain warning. */
  warning?: string;
}

const retailAvailable = [
  "Barcode-first checkout: scan or search, change quantities, line discounts, cash, card or split payments",
  "Products and stock with a full stock history, low-stock alerts and CSV import and export",
  "Purchases from suppliers, supplier orders and what you owe suppliers",
  "Customers with loyalty points, a wallet and khata (sell on account)",
  "Shifts with a counted cash drawer, daily sales and profit",
];

export const profiles: Record<BusinessType, ProfileDefinition> = {
  retail: {
    id: "retail",
    label: "Retail shop",
    tagline: "Grocery, general or clothing store: scan, sell, keep stock right",
    modules: ["customers", "purchases", "orders-to-suppliers", "costs", "team"],
    orderTypes: ["takeaway", "delivery"],
    productsLabel: "Products and stock",
    shortcuts: ["checkout", "products", "purchases", "customers"],
    available: retailAvailable,
    notYet: ["Sizes and colours for one item (for now, add each size as its own item)", "Weighing scales connected to the till"],
  },
  restaurant: {
    id: "restaurant",
    label: "Restaurant",
    tagline: "Dine-in with tables, takeaway and delivery, with a kitchen",
    modules: ["orders", "kitchen", "customers", "purchases", "orders-to-suppliers", "costs", "team"],
    orderTypes: ["dine_in", "takeaway", "delivery"],
    productsLabel: "Menu and stock",
    shortcuts: ["orders", "kitchen", "checkout", "customers"],
    available: [
      "Orders for tables, takeaway and delivery, with split bills and a delivery charge",
      "Kitchen screen and kitchen tickets for new items only",
      "Menu with add-ons, and recipes that work out the real cost of each dish",
      "Ingredients, purchases, wastage and running costs",
      "Customers with loyalty points, a wallet and khata",
    ],
    notYet: ["A drawn floor plan or table map", "Table reservations", "Online ordering"],
  },
  fastfood: {
    id: "fastfood",
    label: "Fast food",
    tagline: "Counter billing, token numbers, takeaway and delivery",
    modules: ["orders", "kitchen", "customers", "purchases", "costs", "team"],
    orderTypes: ["takeaway", "delivery"],
    productsLabel: "Menu and stock",
    shortcuts: ["checkout", "orders", "kitchen", "customers"],
    available: [
      "Counter billing: tap items, take payment, print the receipt",
      "Every order gets a token number; takeaway and delivery orders with a delivery charge",
      "Kitchen tickets and a kitchen screen",
      "Menu with add-ons, and recipes that work out the real cost of each item",
      "Fast checkout with split payments and a printed receipt",
    ],
    notYet: ["A customer-facing token display screen", "Online ordering"],
  },
  pharmacy: {
    id: "pharmacy",
    label: "Pharmacy / medical store",
    tagline: "A starting point: sell and keep stock like a shop. Not a full pharmacy system yet",
    modules: ["customers", "purchases", "orders-to-suppliers", "costs", "team"],
    orderTypes: ["takeaway", "delivery"],
    productsLabel: "Products and stock",
    shortcuts: ["checkout", "products", "purchases", "customers"],
    warning:
      "Tillbase is not a complete pharmacy system yet. It does not track batches or expiry dates, does not stop an expired medicine being sold, and has no prescription records or controlled-medicine register. You stay responsible for following your local pharmacy rules.",
    available: [
      "Barcode checkout and receipts",
      "Products and stock counts with low-stock alerts",
      "Purchases from suppliers, supplier orders and what you owe suppliers",
      "Customers and khata (sell on account)",
    ],
    notYet: [
      "Batch and lot numbers",
      "Expiry dates, expiry alerts, and stopping expired medicine from being sold",
      "Prescription records",
      "Controlled-medicine register",
      "Medicine database or substitute suggestions",
    ],
  },
  custom: {
    id: "custom",
    label: "Custom",
    tagline: "Start plain and choose exactly which parts of Tillbase you want to see",
    modules: [...optionalModules],
    orderTypes: ["dine_in", "takeaway", "delivery"],
    productsLabel: "Products and stock",
    shortcuts: ["checkout", "orders", "products", "customers"],
    available: ["Everything Tillbase can do today: you choose which parts to show"],
    notYet: [],
  },
};

// ---- Countries --------------------------------------------------------------------------------------------------

export interface Country {
  code: string;
  name: string;
  currency: string;
  /** How numbers and dates are written (a BCP 47 tag). */
  locale: string;
  timezone: string;
}

/** A starting list. The owner can change the currency, the locale-style and the time zone afterwards. */
export const countries: readonly Country[] = [
  { code: "PK", name: "Pakistan", currency: "PKR", locale: "en-PK", timezone: "Asia/Karachi" },
  { code: "IN", name: "India", currency: "INR", locale: "en-IN", timezone: "Asia/Kolkata" },
  { code: "BD", name: "Bangladesh", currency: "BDT", locale: "en-BD", timezone: "Asia/Dhaka" },
  { code: "LK", name: "Sri Lanka", currency: "LKR", locale: "en-LK", timezone: "Asia/Colombo" },
  { code: "NP", name: "Nepal", currency: "NPR", locale: "en-NP", timezone: "Asia/Kathmandu" },
  { code: "AE", name: "United Arab Emirates", currency: "AED", locale: "en-AE", timezone: "Asia/Dubai" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR", locale: "en-SA", timezone: "Asia/Riyadh" },
  { code: "QA", name: "Qatar", currency: "QAR", locale: "en-QA", timezone: "Asia/Qatar" },
  { code: "OM", name: "Oman", currency: "OMR", locale: "en-OM", timezone: "Asia/Muscat" },
  { code: "TR", name: "Turkey", currency: "TRY", locale: "en-TR", timezone: "Europe/Istanbul" },
  { code: "EG", name: "Egypt", currency: "EGP", locale: "en-EG", timezone: "Africa/Cairo" },
  { code: "GB", name: "United Kingdom", currency: "GBP", locale: "en-GB", timezone: "Europe/London" },
  { code: "IE", name: "Ireland", currency: "EUR", locale: "en-IE", timezone: "Europe/Dublin" },
  { code: "DE", name: "Germany", currency: "EUR", locale: "de-DE", timezone: "Europe/Berlin" },
  { code: "FR", name: "France", currency: "EUR", locale: "fr-FR", timezone: "Europe/Paris" },
  { code: "ES", name: "Spain", currency: "EUR", locale: "es-ES", timezone: "Europe/Madrid" },
  { code: "IT", name: "Italy", currency: "EUR", locale: "it-IT", timezone: "Europe/Rome" },
  { code: "US", name: "United States", currency: "USD", locale: "en-US", timezone: "America/New_York" },
  { code: "CA", name: "Canada", currency: "CAD", locale: "en-CA", timezone: "America/Toronto" },
  { code: "AU", name: "Australia", currency: "AUD", locale: "en-AU", timezone: "Australia/Sydney" },
  { code: "NZ", name: "New Zealand", currency: "NZD", locale: "en-NZ", timezone: "Pacific/Auckland" },
  { code: "ZA", name: "South Africa", currency: "ZAR", locale: "en-ZA", timezone: "Africa/Johannesburg" },
  { code: "NG", name: "Nigeria", currency: "NGN", locale: "en-NG", timezone: "Africa/Lagos" },
  { code: "KE", name: "Kenya", currency: "KES", locale: "en-KE", timezone: "Africa/Nairobi" },
  { code: "MY", name: "Malaysia", currency: "MYR", locale: "en-MY", timezone: "Asia/Kuala_Lumpur" },
  { code: "SG", name: "Singapore", currency: "SGD", locale: "en-SG", timezone: "Asia/Singapore" },
  { code: "ID", name: "Indonesia", currency: "IDR", locale: "en-ID", timezone: "Asia/Jakarta" },
  { code: "PH", name: "Philippines", currency: "PHP", locale: "en-PH", timezone: "Asia/Manila" },
];

export const countryByCode = (code: string): Country | undefined => countries.find((c) => c.code === code.toUpperCase());

/**
 * A first guess at the country from this computer's time zone, then from its language setting ("en-PK" means
 * Pakistan). Returns null when it cannot tell: the person then picks. Never asks the network. The guess is only a
 * starting point that is shown and can be changed.
 */
export function guessCountry(timeZone: string | undefined, locale: string | undefined): Country | null {
  if (timeZone) {
    const byZone = countries.find((c) => c.timezone === timeZone);
    if (byZone) return byZone;
  }
  const region = locale?.match(/[-_]([A-Za-z]{2})\b/)?.[1]?.toUpperCase();
  // "en-US" is the factory language of computers all over the world, so on its own it does not mean the shop is in the US.
  if (region === "US") return null;
  return region ? (countryByCode(region) ?? null) : null;
}

/** Is this a time zone name the system knows? */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

// ---- The profile -------------------------------------------------------------------------------------------------

export type OnboardingStatus = "legacy" | "in_progress" | "complete";

export interface BusinessProfile {
  /** `legacy`: an installation from before setup existed. It is never sent through the wizard. */
  status: OnboardingStatus;
  /** The wizard step to resume at after an interruption. */
  step: number;
  type: BusinessType | null;
  subtype: RetailKind | null;
  /** The optional menu parts that are shown. */
  modules: ModuleId[];
  orderTypes: OrderType[];
  country: string;
  timezone: string;
  /** Hour (0 to 8) when the trading day starts, for places open past midnight. 0 = midnight. */
  dayCutoffHour: number;
  address: string;
  phone: string;
  email: string;
  /** The shop's own tax registration number, as the owner types it. Never checked or validated. */
  taxNumber: string;
  tax: { enabled: boolean; name: string; /** What the owner typed. We never suggest one. */ defaultRateBp: number | null };
}

export type BusinessProfilePatch = Partial<Omit<BusinessProfile, "status" | "tax">> & { tax?: Partial<BusinessProfile["tax"]> };

const KEYS = {
  status: "business.status",
  step: "business.step",
  type: "business.type",
  subtype: "business.subtype",
  modules: "business.modules",
  orderTypes: "business.orderTypes",
  country: "business.country",
  timezone: "business.timezone",
  dayCutoffHour: "business.dayCutoffHour",
  address: "business.address",
  phone: "business.phone",
  email: "business.email",
  taxNumber: "business.taxNumber",
  taxEnabled: "business.taxEnabled",
  taxName: "business.taxName",
  taxRateBp: "business.taxRateBp",
} as const;

export const MAX_STEP = 11;
const ALL_ORDER_TYPES: OrderType[] = ["dine_in", "takeaway", "delivery"];

const json = <T>(raw: string | undefined, ok: (v: unknown) => v is T): T | null => {
  if (raw === undefined) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return ok(v) ? v : null;
  } catch {
    return null;
  }
};
const isModules = (v: unknown): v is ModuleId[] => Array.isArray(v) && v.every((m) => (optionalModules as readonly string[]).includes(m as string));
const isOrderTypes = (v: unknown): v is OrderType[] => Array.isArray(v) && v.every((m) => (ALL_ORDER_TYPES as string[]).includes(m as string));

/** Which parts of the menu to show. */
export function isModuleShown(profile: Pick<BusinessProfile, "modules">, id: ModuleId): boolean {
  return profile.modules.includes(id);
}

/** The Home screen buttons, only for parts that are shown. */
export function homeShortcuts(profile: BusinessProfile): ProfileDefinition["shortcuts"][number][] {
  const def = profiles[profile.type ?? "custom"];
  const list = profile.type ? def.shortcuts : profiles.custom.shortcuts;
  return list.filter((s) => s === "checkout" || s === "products" || profile.modules.includes(s));
}

export const productsLabelFor = (profile: Pick<BusinessProfile, "type">): string => (profile.type ? profiles[profile.type].productsLabel : "Menu and stock");

export class BusinessProfileService {
  constructor(private readonly db: Db) {}

  get(): BusinessProfile {
    const rows = this.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'business.%'").all() as { key: string; value: string }[];
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const typeRaw = s[KEYS.type];
    const type = (businessTypes as readonly string[]).includes(typeRaw ?? "") ? (typeRaw as BusinessType) : null;
    const subtypeRaw = s[KEYS.subtype];
    const status = s[KEYS.status];
    const step = Number(s[KEYS.step]);
    const cutoff = Number(s[KEYS.dayCutoffHour]);
    const rate = s[KEYS.taxRateBp] === undefined || s[KEYS.taxRateBp] === "" ? null : Number(s[KEYS.taxRateBp]);
    return {
      status: status === "in_progress" || status === "complete" ? status : "legacy",
      step: Number.isInteger(step) && step >= 0 && step <= MAX_STEP ? step : 0,
      type,
      subtype: (retailKinds as readonly string[]).includes(subtypeRaw ?? "") ? (subtypeRaw as RetailKind) : null,
      // Nothing chosen (an installation from before setup existed): show everything, as before.
      modules: json(s[KEYS.modules], isModules) ?? (type ? [...profiles[type].modules] : [...optionalModules]),
      orderTypes: json(s[KEYS.orderTypes], isOrderTypes) ?? (type ? [...profiles[type].orderTypes] : [...ALL_ORDER_TYPES]),
      country: s[KEYS.country] ?? "",
      timezone: s[KEYS.timezone] ?? "",
      dayCutoffHour: Number.isInteger(cutoff) && cutoff >= 0 && cutoff <= 8 ? cutoff : 0,
      address: s[KEYS.address] ?? "",
      phone: s[KEYS.phone] ?? "",
      email: s[KEYS.email] ?? "",
      taxNumber: s[KEYS.taxNumber] ?? "",
      tax: {
        enabled: s[KEYS.taxEnabled] === "true",
        name: s[KEYS.taxName] ?? "",
        defaultRateBp: rate !== null && Number.isInteger(rate) && rate >= 0 && rate <= 10_000 ? rate : null,
      },
    };
  }

  /** Save answers. Picking a business type starts that type's menu parts and order types, unless the patch says otherwise. */
  save(patch: BusinessProfilePatch): BusinessProfile {
    const clean = (v: string | undefined, label: string, max: number) => {
      const t = (v ?? "").trim();
      if (t.length > max) throw new Error(`${label} is too long (most ${max} characters)`);
      return t;
    };
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const writes: [string, string][] = [];

    if (patch.type !== undefined) {
      if (patch.type !== null && !(businessTypes as readonly string[]).includes(patch.type)) throw new Error("Choose a business type from the list");
      writes.push([KEYS.type, patch.type ?? ""]);
      if (patch.type && patch.type !== this.get().type) {
        if (patch.modules === undefined) writes.push([KEYS.modules, JSON.stringify(profiles[patch.type].modules)]);
        if (patch.orderTypes === undefined) writes.push([KEYS.orderTypes, JSON.stringify(profiles[patch.type].orderTypes)]);
        if (patch.subtype === undefined) writes.push([KEYS.subtype, ""]);
      }
    }
    if (patch.subtype !== undefined) {
      if (patch.subtype !== null && !(retailKinds as readonly string[]).includes(patch.subtype)) throw new Error("Choose grocery, general or clothing");
      writes.push([KEYS.subtype, patch.subtype ?? ""]);
    }
    if (patch.modules !== undefined) {
      if (!isModules(patch.modules)) throw new Error("Unknown menu part in the list");
      writes.push([KEYS.modules, JSON.stringify([...new Set(patch.modules)])]);
    }
    if (patch.orderTypes !== undefined) {
      if (!isOrderTypes(patch.orderTypes) || patch.orderTypes.length === 0) throw new Error("Choose at least one kind of order");
      writes.push([KEYS.orderTypes, JSON.stringify([...new Set(patch.orderTypes)])]);
    }
    if (patch.country !== undefined) {
      if (patch.country !== "" && !countryByCode(patch.country)) throw new Error("Choose a country from the list");
      writes.push([KEYS.country, patch.country.toUpperCase()]);
    }
    if (patch.timezone !== undefined) {
      if (patch.timezone !== "" && !isTimeZone(patch.timezone)) throw new Error("That time zone is not one this computer knows. Pick one from the list");
      writes.push([KEYS.timezone, patch.timezone]);
    }
    if (patch.dayCutoffHour !== undefined) {
      if (!Number.isInteger(patch.dayCutoffHour) || patch.dayCutoffHour < 0 || patch.dayCutoffHour > 8) throw new Error("The new day can start between midnight (0) and 8 in the morning");
      writes.push([KEYS.dayCutoffHour, String(patch.dayCutoffHour)]);
    }
    if (patch.address !== undefined) writes.push([KEYS.address, clean(patch.address, "The address", 300)]);
    if (patch.phone !== undefined) writes.push([KEYS.phone, clean(patch.phone, "The phone number", 40)]);
    if (patch.email !== undefined) {
      const e = clean(patch.email, "The email", 120);
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("That email address does not look right");
      writes.push([KEYS.email, e]);
    }
    if (patch.taxNumber !== undefined) writes.push([KEYS.taxNumber, clean(patch.taxNumber, "The tax number", 60)]);
    if (patch.tax) {
      if (patch.tax.enabled !== undefined) writes.push([KEYS.taxEnabled, String(!!patch.tax.enabled)]);
      if (patch.tax.name !== undefined) writes.push([KEYS.taxName, clean(patch.tax.name, "The tax name", 40)]);
      if (patch.tax.defaultRateBp !== undefined) {
        const r = patch.tax.defaultRateBp;
        if (r !== null && (!Number.isInteger(r) || r < 0 || r > 10_000)) throw new Error("The tax rate must be between 0% and 100%");
        writes.push([KEYS.taxRateBp, r === null ? "" : String(r)]);
      }
    }
    if (patch.step !== undefined) {
      if (!Number.isInteger(patch.step) || patch.step < 0 || patch.step > MAX_STEP) throw new Error("Unknown setup step");
      writes.push([KEYS.step, String(patch.step)]);
    }
    this.db.transaction(() => writes.forEach(([k, v]) => put.run(k, v)))();
    return this.get();
  }

  private setStatus(status: OnboardingStatus, step: number): void {
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.transaction(() => {
      put.run(KEYS.status, status);
      put.run(KEYS.step, String(step));
    })();
  }

  /** The wizard has started (the owner account was just made). */
  begin(): BusinessProfile {
    this.setStatus("in_progress", 3);
    return this.get();
  }
  /** Setup finished or skipped: the wizard is not shown again. */
  finish(): BusinessProfile {
    this.setStatus("complete", 0);
    return this.get();
  }
  /** The owner chose to go through setup again. Their answers and all their data are kept. */
  restart(): BusinessProfile {
    this.setStatus("in_progress", 3);
    return this.get();
  }
}
