import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BusinessProfileService, SettingsService, UserService, businessProfiles, businessTypes, countries, countryByCode, guessCountry,
  homeShortcuts, isTimeZone, optionalModules, openDatabase, productsLabelFor,
} from "../src/index.js";

const fresh = () => {
  const db = openDatabase(":memory:");
  return { db, biz: new BusinessProfileService(db) };
};

describe("the profile catalogue", () => {
  it("has the five profiles, each using only menu parts and home buttons that exist", () => {
    expect([...businessTypes]).toEqual(["retail", "restaurant", "fastfood", "pharmacy", "custom"]);
    for (const p of Object.values(businessProfiles)) {
      for (const m of p.modules) expect(optionalModules).toContain(m);
      for (const s of p.shortcuts) expect(["checkout", "products", ...optionalModules]).toContain(s);
      expect(p.orderTypes.length).toBeGreaterThan(0);
    }
  });

  it("shows the right menu parts for each kind of business (stated by hand)", () => {
    const m = (t: keyof typeof businessProfiles) => [...businessProfiles[t].modules].sort();
    // Retail and pharmacy: no table or kitchen screens.
    expect(m("retail")).toEqual(["costs", "customers", "orders-to-suppliers", "purchases", "team"]);
    expect(m("pharmacy")).toEqual(m("retail"));
    // Restaurant has everything. Fast food has everything except supplier orders.
    expect(m("restaurant")).toEqual([...optionalModules].sort());
    expect(m("fastfood")).toEqual(["costs", "customers", "kitchen", "orders", "purchases", "team"]);
    expect(m("custom")).toEqual([...optionalModules].sort());
    expect([...businessProfiles.restaurant.orderTypes]).toEqual(["dine_in", "takeaway", "delivery"]);
    expect([...businessProfiles.fastfood.orderTypes]).toEqual(["takeaway", "delivery"]);
  });

  it("is honest about pharmacy: lists what is missing and never claims it", () => {
    const ph = businessProfiles.pharmacy;
    expect(ph.warning).toMatch(/not a complete pharmacy system/i);
    for (const missing of [/batch/i, /expiry/i, /prescription/i, /controlled-medicine/i]) {
      expect(ph.notYet.some((x) => missing.test(x))).toBe(true);
      expect(ph.available.some((x) => missing.test(x))).toBe(false);
    }
    // No profile's "available" list claims any of these features.
    for (const p of Object.values(businessProfiles)) {
      expect(p.available.join(" ")).not.toMatch(/batch|expiry|prescription|controlled|reservation|floor plan|variant/i);
    }
    expect(businessProfiles.pharmacy.label).not.toMatch(/full|complete|ready/i);
  });

  it("names the Products menu item to suit the business", () => {
    expect(productsLabelFor({ type: "retail" })).toBe("Products and stock");
    expect(productsLabelFor({ type: "restaurant" })).toBe("Menu and stock");
    expect(productsLabelFor({ type: null })).toBe("Menu and stock"); // an existing installation keeps its old name
  });
});

describe("countries and time zones", () => {
  it("Pakistan is PKR in Asia/Karachi, suggested but only as a starting point", () => {
    const pk = countryByCode("pk")!;
    expect([pk.name, pk.currency, pk.timezone, pk.locale]).toEqual(["Pakistan", "PKR", "Asia/Karachi", "en-PK"]);
  });
  it("guesses the country from the computer's time zone, then its language", () => {
    expect(guessCountry("Asia/Karachi", "en-US")?.code).toBe("PK");
    expect(guessCountry("Etc/Unknown", "en-PK")?.code).toBe("PK");
    expect(guessCountry(undefined, "ur_PK")?.code).toBe("PK");
    expect(guessCountry("Etc/UTC", "en")).toBeNull(); // cannot tell: the person picks
    expect(guessCountry("Etc/UTC", "en-US")).toBeNull(); // en-US is the factory setting of computers everywhere
    expect(guessCountry("America/New_York", "en-US")?.code).toBe("US"); // but the time zone is a real clue
    expect(guessCountry("Etc/UTC", "en-GB")?.code).toBe("GB");
    expect(guessCountry(undefined, undefined)).toBeNull();
  });
  it("every country has a unique code, a 3-letter currency and a time zone this computer knows", () => {
    expect(new Set(countries.map((c) => c.code)).size).toBe(countries.length);
    for (const c of countries) {
      expect(c.currency).toMatch(/^[A-Z]{3}$/);
      expect(isTimeZone(c.timezone)).toBe(true);
    }
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("BusinessProfileService", () => {
  it("an installation that never did setup is 'legacy': everything shown, no tax assumed", () => {
    const p = fresh().biz.get();
    expect(p.status).toBe("legacy");
    expect(p.type).toBeNull();
    expect([...p.modules].sort()).toEqual([...optionalModules].sort());
    expect(p.orderTypes).toEqual(["dine_in", "takeaway", "delivery"]);
    expect(p.dayCutoffHour).toBe(0);
    expect(p.tax).toEqual({ enabled: false, name: "", defaultRateBp: null });
    expect(homeShortcuts(p)).toEqual(["checkout", "orders", "products", "customers"]); // the buttons Home always had, plus Menu
  });

  it("picking a type starts that type's menu parts and order types; picking another resets them", () => {
    const { biz } = fresh();
    expect(biz.save({ type: "fastfood" }).modules).toEqual(["orders", "kitchen", "customers", "purchases", "costs", "team"]);
    expect(biz.get().orderTypes).toEqual(["takeaway", "delivery"]);
    biz.save({ modules: ["orders", "kitchen"], orderTypes: ["takeaway"] });
    expect(biz.get().modules).toEqual(["orders", "kitchen"]);
    // Saving the SAME type again does not undo the owner's own choices.
    biz.save({ type: "fastfood", address: "1 Main Road" });
    expect(biz.get().modules).toEqual(["orders", "kitchen"]);
    // A different type starts fresh.
    expect(biz.save({ type: "retail", subtype: "clothing" }).modules).toEqual(["customers", "purchases", "orders-to-suppliers", "costs", "team"]);
    expect(biz.get().subtype).toBe("clothing");
    expect(biz.save({ type: "restaurant" }).subtype).toBeNull(); // a retail kind does not follow you
  });

  it("stores the details exactly as typed (trimmed) and the tax rate in basis points", () => {
    const { biz } = fresh();
    const p = biz.save({
      country: "pk", timezone: "Asia/Karachi", dayCutoffHour: 4, address: "  Shop 4, Main Market  ", phone: "0300 1234567", email: "a@b.pk",
      taxNumber: " 1234567-8 ", tax: { enabled: true, name: "Sales tax", defaultRateBp: 1800 },
    });
    expect(p).toMatchObject({ country: "PK", timezone: "Asia/Karachi", dayCutoffHour: 4, address: "Shop 4, Main Market", phone: "0300 1234567", email: "a@b.pk", taxNumber: "1234567-8" });
    expect(p.tax).toEqual({ enabled: true, name: "Sales tax", defaultRateBp: 1800 });
    expect(biz.save({ tax: { enabled: false, defaultRateBp: null } }).tax).toEqual({ enabled: false, name: "Sales tax", defaultRateBp: null });
  });

  it("refuses answers that cannot be right, in plain words, and saves nothing from that call", () => {
    const { biz } = fresh();
    expect(() => biz.save({ country: "ZZ" })).toThrow(/choose a country/i);
    expect(() => biz.save({ timezone: "Mars/Olympus" })).toThrow(/time zone/i);
    expect(() => biz.save({ dayCutoffHour: 9 })).toThrow(/midnight \(0\) and 8/);
    expect(() => biz.save({ dayCutoffHour: 1.5 })).toThrow(/midnight/);
    expect(() => biz.save({ email: "not an email" })).toThrow(/email/i);
    expect(() => biz.save({ tax: { defaultRateBp: 10_001 } })).toThrow(/between 0% and 100%/);
    expect(() => biz.save({ tax: { defaultRateBp: -1 } })).toThrow(/between 0% and 100%/);
    expect(() => biz.save({ orderTypes: [] })).toThrow(/at least one/);
    expect(() => biz.save({ modules: ["nope" as never] })).toThrow(/unknown menu part/i);
    expect(() => biz.save({ type: "bank" as never })).toThrow(/business type/i);
    expect(() => biz.save({ address: "x".repeat(301) })).toThrow(/too long/);
    expect(() => biz.save({ step: 99 })).toThrow(/step/);
    // A bad value in a call that also had good ones saves none of them.
    expect(() => biz.save({ phone: "123", country: "ZZ" })).toThrow();
    expect(biz.get().phone).toBe("");
  });

  it("goes legacy -> in progress -> complete, and restart keeps every answer", () => {
    const { biz } = fresh();
    expect(biz.begin()).toMatchObject({ status: "in_progress", step: 3 });
    biz.save({ type: "retail", step: 6, address: "A" });
    expect(biz.finish()).toMatchObject({ status: "complete", type: "retail", address: "A" });
    expect(biz.restart()).toMatchObject({ status: "in_progress", step: 3, type: "retail", address: "A" });
  });

  it("an interrupted setup resumes where it stopped, after the app is closed and opened again", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "tb-biz-")), "t.sqlite");
    const a = openDatabase(file);
    new BusinessProfileService(a).begin();
    new BusinessProfileService(a).save({ country: "PK", type: "restaurant", step: 6, orderTypes: ["dine_in", "takeaway"] });
    a.close();
    const b = openDatabase(file);
    expect(new BusinessProfileService(b).get()).toMatchObject({ status: "in_progress", step: 6, country: "PK", type: "restaurant", orderTypes: ["dine_in", "takeaway"] });
    b.close();
  });

  it("never assumes a tax rate, even after setup is finished with nothing entered", () => {
    const { biz } = fresh();
    biz.begin();
    biz.save({ type: "retail" });
    expect(biz.finish().tax).toEqual({ enabled: false, name: "", defaultRateBp: null });
  });

  it("ignores damaged stored values instead of crashing", () => {
    const { db, biz } = fresh();
    const put = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    put.run("business.type", "spaceship");
    put.run("business.modules", "not json");
    put.run("business.orderTypes", '["flying"]');
    put.run("business.dayCutoffHour", "99");
    put.run("business.step", "-4");
    put.run("business.taxRateBp", "abc");
    const p = biz.get();
    expect(p.type).toBeNull();
    expect(p.modules.length).toBe(optionalModules.length);
    expect(p.orderTypes).toEqual(["dine_in", "takeaway", "delivery"]);
    expect([p.dayCutoffHour, p.step, p.tax.defaultRateBp]).toEqual([0, 0, null]);
  });
});

describe("existing installations are left alone (upgrade)", () => {
  it("a database with an owner, shop settings and sales from before setup existed opens as legacy, with its data unchanged", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "tb-up-")), "old.sqlite");
    const old = openDatabase(file);
    const users = new UserService(old);
    const owner = users.create({ name: "Ayesha", pin: "4821", role: "owner" });
    new SettingsService(old).update({ storeName: "Old Corner Shop", currency: "PKR", receiptWidth: 48 });
    old.close();

    const db = openDatabase(file);
    const biz = new BusinessProfileService(db);
    expect(biz.get().status).toBe("legacy"); // the wizard is never shown for this one
    expect(new UserService(db).count()).toBe(1);
    expect(new UserService(db).authenticate(owner.id, "4821").name).toBe("Ayesha"); // the old PIN still works
    expect(new SettingsService(db).get()).toMatchObject({ storeName: "Old Corner Shop", currency: "PKR", receiptWidth: 48 });
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(9);
    // Opening it did not write any business keys.
    expect((db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'business.%'").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("home buttons follow the profile and the parts that are shown", () => {
  it("per profile", () => {
    const { biz } = fresh();
    expect(homeShortcuts(biz.save({ type: "retail" }))).toEqual(["checkout", "products", "purchases", "customers"]);
    expect(homeShortcuts(biz.save({ type: "restaurant" }))).toEqual(["orders", "kitchen", "checkout", "customers"]);
    expect(homeShortcuts(biz.save({ type: "fastfood" }))).toEqual(["checkout", "orders", "kitchen", "customers"]);
    expect(homeShortcuts(biz.save({ type: "pharmacy" }))).toEqual(["checkout", "products", "purchases", "customers"]);
  });
  it("a part switched off has no button", () => {
    const { biz } = fresh();
    biz.save({ type: "restaurant" });
    expect(homeShortcuts(biz.save({ modules: ["orders", "customers"] }))).toEqual(["orders", "checkout", "customers"]);
  });
});
