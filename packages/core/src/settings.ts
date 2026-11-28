import type { Db } from "./db.js";

export interface ShopSettings {
  storeName: string;
  currency: string;
  locale: string;
  receiptFooter: string;
  receiptWidth: number;
  /** The shop's own logo as a small data: URL (PNG, JPEG or WebP), or "" for none. */
  businessLogo: string;
  /** Show the small, clearly labelled sponsor line on the Home screen. The owner can switch it off. */
  showSponsors: boolean;
}

export const defaultSettings: ShopSettings = {
  storeName: "My Shop",
  currency: "USD",
  locale: "en-US",
  receiptFooter: "Thank you!",
  receiptWidth: 32,
  businessLogo: "",
  showSponsors: true,
};

/** Largest logo we keep: it is stored in the database and shown on every screen. */
export const MAX_LOGO_BYTES = 300_000;

/** Key/value shop settings stored in the local database. */
export class SettingsService {
  constructor(private readonly db: Db) {}

  get(): ShopSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      storeName: stored.storeName ?? defaultSettings.storeName,
      currency: stored.currency ?? defaultSettings.currency,
      locale: stored.locale ?? defaultSettings.locale,
      receiptFooter: stored.receiptFooter ?? defaultSettings.receiptFooter,
      receiptWidth: stored.receiptWidth
        ? Number(stored.receiptWidth)
        : defaultSettings.receiptWidth,
      businessLogo: stored.businessLogo ?? defaultSettings.businessLogo,
      showSponsors: stored.showSponsors === undefined ? defaultSettings.showSponsors : stored.showSponsors === "true",
    };
  }

  update(patch: Partial<ShopSettings>): ShopSettings {
    if (patch.storeName !== undefined && !patch.storeName.trim()) {
      throw new Error("Store name cannot be empty");
    }
    if (patch.currency !== undefined && !/^[A-Za-z]{3}$/.test(patch.currency)) {
      throw new Error("Currency must be a 3-letter code such as USD or PKR");
    }
    if (
      patch.receiptWidth !== undefined &&
      (!Number.isInteger(patch.receiptWidth) ||
        patch.receiptWidth < 20 ||
        patch.receiptWidth > 80)
    ) {
      throw new Error("Receipt width must be a whole number between 20 and 80");
    }
    if (patch.businessLogo !== undefined && patch.businessLogo !== "") {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(patch.businessLogo)) {
        throw new Error("The logo must be a PNG, JPEG or WebP picture");
      }
      if (patch.businessLogo.length > MAX_LOGO_BYTES) {
        throw new Error("The logo is too big. Use a picture under 200 KB");
      }
    }
    const put = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        // The "Powered by Tillbase" credit is permanent. An old "showCredit" value from an earlier version is ignored.
        if (k === "showCredit") continue;
        const value = k === "currency" ? String(v).toUpperCase() : String(v);
        put.run(k, k === "storeName" ? value.trim() : value);
      }
    })();
    return this.get();
  }
}
