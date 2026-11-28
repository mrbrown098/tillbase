import { describe, expect, it } from "vitest";
import { MAX_REFERENCE, buildPayment, methodLabel, saleMethods, summarizePayments } from "../renderer/src/payments";

const cash = (n: number) => ({ method: "cash" as const, amountMinor: n });
const card = (n: number) => ({ method: "card" as const, amountMinor: n });
const other = (n: number) => ({ method: "other" as const, amountMinor: n });

describe("summarizePayments (the split-payment rules shown in the pay screen)", () => {
  it("starts with everything remaining and nothing to complete", () => {
    expect(summarizePayments(500, [])).toEqual({ paidMinor: 0, remainingMinor: 500, changeMinor: 0, ok: false, problem: null });
  });

  it("shows what is remaining after a partial payment", () => {
    // 500 total, 300 cash so far: 200 remaining.
    expect(summarizePayments(500, [cash(300)])).toEqual({ paidMinor: 300, remainingMinor: 200, changeMinor: 0, ok: false, problem: null });
  });

  it("completes when exactly covered: 300 cash + 200 card on 500", () => {
    expect(summarizePayments(500, [cash(300), card(200)])).toEqual({ paidMinor: 500, remainingMinor: 0, changeMinor: 0, ok: true, problem: null });
  });

  it("completes with three methods: 100 cash + 250 card + 150 other on 500", () => {
    expect(summarizePayments(500, [cash(100), card(250), other(150)]).ok).toBe(true);
  });

  it("gives change from cash: 300 cash + 300 card on 500 means 100 back, which the 300 cash can cover", () => {
    expect(summarizePayments(500, [cash(300), card(300)])).toMatchObject({ changeMinor: 100, ok: true });
  });

  it("refuses change that cash cannot cover: 40 cash + 520 card on 500 means 60 back from only 40 cash", () => {
    const s = summarizePayments(500, [cash(40), card(520)]);
    expect(s.ok).toBe(false);
    expect(s.changeMinor).toBe(60);
    expect(s.problem).toMatch(/Change can only be given from the cash handed over/);
  });

  it("refuses card-only overpayment with a readable reason", () => {
    const s = summarizePayments(500, [card(600)]);
    expect(s.ok).toBe(false);
    expect(s.problem).toMatch(/Change can only be given from cash/);
  });

  it("allows change exactly equal to the cash handed over (100 cash + 450 card on 500: 50 back)", () => {
    expect(summarizePayments(500, [cash(100), card(450)])).toMatchObject({ changeMinor: 50, ok: true });
  });

  it("agrees with the core on the same cases (so the screen never promises what the core refuses)", () => {
    // Core: change > cash paid is refused. 100 cash + 401 card on 500: change 1, cash 100: fine.
    expect(summarizePayments(500, [cash(100), card(401)]).ok).toBe(true);
    // 0 cash: any change is refused.
    expect(summarizePayments(500, [card(501)]).ok).toBe(false);
  });
});

describe("bank transfer at the till", () => {
  const bank = (n: number) => ({ method: "bank_transfer" as const, amountMinor: n });

  it("is offered after card and before other, with a plain label", () => {
    expect(saleMethods).toEqual(["cash", "card", "bank_transfer", "other"]);
    expect(methodLabel.bank_transfer).toBe("Bank transfer");
  });

  it("follows the same rule as card: it covers the bill but never produces change", () => {
    expect(summarizePayments(500, [cash(200), bank(300)])).toEqual({ paidMinor: 500, remainingMinor: 0, changeMinor: 0, ok: true, problem: null });
    const over = summarizePayments(500, [bank(600)]);
    expect(over.ok).toBe(false);
    expect(over.problem).toMatch(/bank transfer/i);
    expect(over.problem).toMatch(/Change can only be given from cash/);
    const mixed = summarizePayments(500, [cash(10), bank(600)]);
    expect(mixed.ok).toBe(false);
    expect(mixed.problem).toMatch(/lower the card, bank transfer or other amount/);
  });

  it("keeps the reference only on a bank transfer, trimmed, and leaves an empty one out", () => {
    expect(buildPayment("bank_transfer", 500, "  TX 8841 ")).toEqual({ method: "bank_transfer", amountMinor: 500, reference: "TX 8841" });
    expect(buildPayment("bank_transfer", 500, "   ")).toEqual({ method: "bank_transfer", amountMinor: 500 });
    expect(buildPayment("bank_transfer", 500)).toEqual({ method: "bank_transfer", amountMinor: 500 });
    expect(buildPayment("card", 500, "left over from a transfer")).toEqual({ method: "card", amountMinor: 500 });
    expect(buildPayment("bank_transfer", 500, "x".repeat(200)).reference).toHaveLength(MAX_REFERENCE);
  });
});
