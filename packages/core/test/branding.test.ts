import { describe, expect, it } from "vitest";
import { SettingsService, footerWithCredit, openDatabase } from "../src/index.js";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("shop logo and receipt credit settings", () => {
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

  it("adds the Tillbase credit and copyright line under the footer unless it is switched off", () => {
    const s = new SettingsService(openDatabase(":memory:"));
    expect(s.get().showCredit).toBe(true);
    const on = footerWithCredit(s.get(), 2026);
    expect(on.split("\n")).toEqual(["Thank you!", "Powered by Tillbase (free POS)", "(c) 2026 Tillbase contributors"]);
    s.update({ showCredit: false });
    expect(s.get().showCredit).toBe(false);
    expect(footerWithCredit(s.get(), 2026)).toBe("Thank you!");
  });
});
