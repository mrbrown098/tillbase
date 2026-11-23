import { describe, expect, it } from "vitest";
import { SettingsService, openDatabase } from "../src/index.js";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("shop logo and footer settings", () => {
  it("keeps a valid logo, and removes it again with an empty string", () => {
    const s = new SettingsService(openDatabase(":memory:"));
    expect(s.get().businessLogo).toBe("");
    expect(s.update({ businessLogo: tinyPng }).businessLogo).toBe(tinyPng);
    expect(s.update({ businessLogo: "" }).businessLogo).toBe("");
  });

  it("refuses things that are not a small PNG, JPEG or WebP picture", () => {
    const s = new SettingsService(openDatabase(":memory:"));
    expect(() => s.update({ businessLogo: "https://example.com/logo.png" })).toThrow("PNG, JPEG or WebP");
    expect(() => s.update({ businessLogo: "data:image/svg+xml;base64,PHN2Zy8+" })).toThrow("PNG, JPEG or WebP");
    expect(() => s.update({ businessLogo: "data:text/html;base64,PHNjcmlwdD4=" })).toThrow("PNG, JPEG or WebP");
    const huge = "data:image/png;base64," + "A".repeat(310_000);
    expect(() => s.update({ businessLogo: huge })).toThrow("too big");
    expect(s.get().businessLogo).toBe("");
  });

  it("has no setting for the Tillbase credit: an old showCredit value is ignored and the footer stays separate", () => {
    const db = openDatabase(":memory:");
    const s = new SettingsService(db);
    expect("showCredit" in s.get()).toBe(false);
    s.update({ receiptFooter: "See you soon" });
    s.update({ showCredit: false } as never); // what an old screen might still send
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'showCredit'").get()).toEqual({ n: 0 });
    expect(s.get().receiptFooter).toBe("See you soon");
  });
});
