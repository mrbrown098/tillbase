import { describe, expect, it } from "vitest";
import { stockLogText } from "../renderer/src/csv-text";

// The preview once said "stock count entry" for the opening stock of a brand-new item, even with
// stock correction switched off. Entries for existing items only exist when the person asked for them.
describe("stockLogText", () => {
  it("says the entries are for new items' opening stock when corrections are off", () => {
    expect(stockLogText(1, false, false)).toBe("1 stock log entry will be added for the opening stock of new items.");
    expect(stockLogText(12, false, false)).toBe("12 stock log entries will be added for the opening stock of new items.");
  });

  it("mentions corrections only when the person turned them on", () => {
    expect(stockLogText(3, true, false)).toBe(
      "3 stock log entries will be added for the opening stock of new items and the corrections you chose.",
    );
    expect(stockLogText(3, false, false)).not.toMatch(/correction/);
  });

  it("uses the past tense once the import has run", () => {
    expect(stockLogText(1, false, true)).toBe("1 stock log entry was added for the opening stock of new items.");
    expect(stockLogText(2, true, true)).toBe(
      "2 stock log entries were added for the opening stock of new items and the corrections you chose.",
    );
  });
});
