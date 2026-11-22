import { describe, expect, it } from "vitest";
import {
  PAPER_CHARS, PAPER_DOTS, drawerKickJob, encodeText, escposCommands as cmd, kitchenTicketJob, paperForWidth,
  rasterCommands, rasterFromRgba, receiptJob, reportJob, statementJob, type Rgba,
} from "../src/index.js";

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");

/** An RGBA picture from rows of "#" (black) and "." (white). */
function picture(rows: string[], alpha = 255): Rgba {
  const w = rows[0]!.length;
  const data = new Uint8Array(w * rows.length * 4);
  rows.forEach((r, y) =>
    [...r].forEach((c, x) => {
      const v = c === "#" ? 0 : 255;
      data.set([v, v, v, alpha], (y * w + x) * 4);
    }),
  );
  return { width: w, height: rows.length, data };
}

describe("ESC/POS commands (golden bytes)", () => {
  it("has the documented byte sequences", () => {
    expect(hex(cmd.init)).toBe("1b 40"); // ESC @
    expect(hex(cmd.codePage437)).toBe("1b 74 00"); // ESC t 0
    expect(hex(cmd.alignLeft)).toBe("1b 61 00");
    expect(hex(cmd.alignCenter)).toBe("1b 61 01");
    expect(hex(cmd.boldOn)).toBe("1b 45 01");
    expect(hex(cmd.boldOff)).toBe("1b 45 00");
    expect(hex(cmd.bigOn)).toBe("1d 21 11");
    expect(hex(cmd.bigOff)).toBe("1d 21 00");
    expect(hex(cmd.drawerKick)).toBe("1b 70 00 19 fa"); // ESC p 0, 25 x 2 ms on, 250 x 2 ms off
    expect(hex(cmd.cut)).toBe("1d 56 42 00"); // GS V 66 0
    expect(hex(cmd.feed(4))).toBe("1b 64 04");
    expect(hex(cmd.feed(999))).toBe("1b 64 ff");
    expect(hex(cmd.feed(-3))).toBe("1b 64 00");
  });

  it("opens only the drawer", () => {
    expect(hex(drawerKickJob())).toBe("1b 40 1b 70 00 19 fa");
  });

  it("knows the paper sizes", () => {
    expect(PAPER_DOTS).toEqual({ 58: 384, 80: 576 });
    expect(PAPER_CHARS).toEqual({ 58: 32, 80: 48 });
    expect(paperForWidth(32)).toBe(58);
    expect(paperForWidth(28)).toBe(58);
    expect(paperForWidth(48)).toBe(80);
  });
});

describe("encodeText", () => {
  it("keeps plain text and turns newlines into line feeds", () => {
    expect(hex(encodeText("Hi 5\n"))).toBe("48 69 20 35 0a");
  });
  it("drops accents, keeps the pound sign, spells out the euro, and never sends a stray byte", () => {
    expect(hex(encodeText("Café"))).toBe(ascii("Cafe"));
    expect(hex(encodeText("£5"))).toBe("9c 35"); // PC437 has the pound sign at 0x9C
    expect(hex(encodeText("€5"))).toBe(ascii("EUR5"));
    expect(hex(encodeText("日本"))).toBe("3f 3f"); // "??"
    expect(hex(encodeText("a\r\nb"))).toBe("61 0a 62"); // carriage returns are dropped
    expect(hex(encodeText("it’s – ok"))).toBe(ascii("it's - ok"));
  });
});

describe("jobs", () => {
  const text = "Shop\n-----\nTotal 5\n-----\nThanks";

  it("receipt: init, bold centred shop name, left body, centred footer, feed, cut", () => {
    const got = hex(receiptJob(text, { paper: 58 }));
    const expected = [
      "1b 40", "1b 74 00",
      "1b 45 01", "1b 61 01", ascii("Shop"), "0a", "1b 61 00", "1b 45 00", // heading
      ascii("-----"), "0a",
      ascii("Total 5"), "0a",
      ascii("-----"), "0a",
      "1b 61 01", ascii("Thanks"), "0a", "1b 61 00", // footer after the last rule
      "1b 64 04", "1d 56 42 00",
    ].join(" ");
    expect(got).toBe(expected);
  });

  it("receipt with the drawer opening and no cut", () => {
    const got = hex(receiptJob("A", { paper: 80, openDrawer: true, cut: false, feedLines: 2 }));
    expect(got).toBe(["1b 40", "1b 74 00", "1b 70 00 19 fa", "1b 45 01", "1b 61 01", "41", "0a", "1b 61 00", "1b 45 00", "1b 64 02"].join(" "));
  });

  it("receipt with a logo: centred picture first, then the text", () => {
    const logo = rasterFromRgba(picture(["##########", ".........."]), 58)!;
    const got = hex(receiptJob("A", { paper: 58, logo, cut: false, feedLines: 0 }));
    expect(got).toBe(
      [
        "1b 40", "1b 74 00",
        "1b 61 01", "1d 76 30 00 02 00 02 00 ff c0 00 00", "0a", "1b 61 00",
        "1b 45 01", "1b 61 01", "41", "0a", "1b 61 00", "1b 45 00",
        "1b 64 00",
      ].join(" "),
    );
  });

  it("statement: the first two lines are bold and centred", () => {
    const got = hex(statementJob("Shop\nACCOUNT STATEMENT\nx", { paper: 58, cut: false, feedLines: 0 }));
    expect(got).toBe(
      [
        "1b 40", "1b 74 00",
        "1b 45 01", "1b 61 01", ascii("Shop"), "0a", "1b 61 00", "1b 45 00",
        "1b 45 01", "1b 61 01", ascii("ACCOUNT STATEMENT"), "0a", "1b 61 00", "1b 45 00",
        ascii("x"), "0a",
        "1b 64 00",
      ].join(" "),
    );
  });

  it("kitchen ticket: big first line, never a logo", () => {
    const logo = rasterFromRgba(picture(["#"]), 58)!;
    const got = hex(kitchenTicketJob("KITCHEN  #7\n2 x Tea", { paper: 58, logo, cut: false, feedLines: 1 }));
    expect(got).toBe(
      [
        "1b 40", "1b 74 00",
        "1b 45 01", "1d 21 11", ascii("KITCHEN  #7"), "0a", "1d 21 00", "1b 45 00",
        ascii("2 x Tea"), "0a",
        "1b 64 01",
      ].join(" "),
    );
  });

  it("report job reads like a receipt", () => {
    expect(hex(reportJob(text, { paper: 80 }))).toBe(hex(receiptJob(text, { paper: 80 })));
  });
});

describe("logo to black and white dots", () => {
  it("packs 10 dots into 2 bytes, leftmost dot in the top bit", () => {
    // Row 1: ten black dots = 11111111 11000000 = ff c0. Row 2: all white = 00 00.
    const r = rasterFromRgba(picture(["##########", ".........."]), 58)!;
    expect([r.widthDots, r.heightDots]).toEqual([10, 2]);
    expect(hex(r.data)).toBe("ff c0 00 00");
    expect(hex(rasterCommands(r))).toBe("1d 76 30 00 02 00 02 00 ff c0 00 00"); // GS v 0, m=0, 2 bytes wide, 2 rows
  });

  it("prints a left-to-right pattern in the right bits", () => {
    const r = rasterFromRgba(picture(["#.#.#.#."]), 58)!;
    expect(hex(r.data)).toBe("aa"); // 10101010
  });

  it("shrinks a picture wider than the paper, keeping its shape", () => {
    // 768 x 100 -> scale 384/768 = 0.5 -> 384 x 50 on 58 mm paper; 576/768 = 0.75 -> 576 x 75 on 80 mm paper.
    const big = picture(Array.from({ length: 100 }, () => ".".repeat(768)));
    const a = rasterFromRgba(big, 58)!;
    expect([a.widthDots, a.heightDots]).toEqual([384, 50]);
    const b = rasterFromRgba(big, 80)!;
    expect([b.widthDots, b.heightDots]).toEqual([576, 75]);
  });

  it("keeps a small logo small, and caps the height at 240 dots", () => {
    const tall = picture(Array.from({ length: 1000 }, () => "#".repeat(100)));
    // scale = min(1, 384/100, 240/1000) = 0.24 -> 24 x 240
    const r = rasterFromRgba(tall, 58)!;
    expect([r.widthDots, r.heightDots]).toEqual([24, 240]);
    expect(r.data.length).toBe(3 * 240);
  });

  it("treats transparent pixels as white paper", () => {
    const r = rasterFromRgba(picture(["########"], 0), 58)!;
    expect(hex(r.data)).toBe("00");
  });

  it("dithers grey so it still looks grey (hand-worked Floyd-Steinberg on a 2x2 of grey 127)", () => {
    // (0,0)=127 is below 128, so black, error 127; it adds 55.6 to (1,0), 39.7 to (0,1), 7.9 to (1,1).
    // (1,0)=182.6 white, error -72.4 -> (0,1)=153.1, (1,1)=112.3. (0,1)=153.1 white, error -101.9 -> (1,1)=67.7: black.
    const data = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) data.set([127, 127, 127, 255], i * 4);
    const r = rasterFromRgba({ width: 2, height: 2, data }, 58)!;
    expect(hex(r.data)).toBe("80 40");
  });

  it("sends tall pictures in bands of 128 rows", () => {
    const r = rasterFromRgba(picture(Array.from({ length: 240 }, () => "#" + ".".repeat(7))), 58)!;
    const bytes = rasterCommands(r);
    // band 1: header + 128 rows of 1 byte; band 2: header + 112 rows
    expect(hex(bytes.slice(0, 8))).toBe("1d 76 30 00 01 00 80 00");
    expect(hex(bytes.slice(8 + 128, 8 + 128 + 8))).toBe("1d 76 30 00 01 00 70 00");
    expect(bytes.length).toBe(8 + 128 + 8 + 112);
  });

  it("gives back nothing for a broken picture instead of throwing", () => {
    expect(rasterFromRgba({ width: 0, height: 0, data: new Uint8Array(0) }, 58)).toBeNull();
    expect(rasterFromRgba({ width: 4, height: 4, data: new Uint8Array(3) }, 58)).toBeNull();
  });
});
