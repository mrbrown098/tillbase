import { describe, expect, it } from "vitest";
import { maxPoints, planPayment, pointsEarned } from "../renderer/src/loyalty";

const lines = [
  { netMinor: 25_000, taxRateBp: 1000 },
  { netMinor: 5_000, taxRateBp: 0 },
];

describe("loyalty maths on the till screen (must match the core)", () => {
  it("limits points to what the customer has and what the items cost", () => {
    expect(maxPoints(25, 30_000, 100)).toBe(25);
    expect(maxPoints(1_000, 30_000, 100)).toBe(300);
    expect(maxPoints(10, 30_000, 0)).toBe(0);
    expect(maxPoints(0, 30_000, 100)).toBe(0);
    expect(maxPoints(10, 50, 100)).toBe(0);
  });

  it("works out the same totals the core does: 10 points off 25,000 + 5,000", () => {
    // Burger 24,167 + tax 2,417, tea 4,833 = 31,417 (hand-computed in the core tests).
    const p = planPayment({ lines, extraMinor: 0, redeemPoints: 10, pointValueMinor: 100, useWallet: false, walletBalanceMinor: 0 });
    expect(p).toEqual({ discountMinor: 1_000, taxMinor: 2_417, payableMinor: 31_417, walletMinor: 0, dueMinor: 31_417 });
  });

  it("a delivery charge is added after, and wallet never pays more than the bill or the balance", () => {
    const base = { lines, pointValueMinor: 100, redeemPoints: 0 };
    expect(planPayment({ ...base, extraMinor: 3_000, useWallet: false, walletBalanceMinor: 0 }).payableMinor).toBe(35_500);
    expect(planPayment({ ...base, extraMinor: 0, useWallet: true, walletBalanceMinor: 10_000 })).toMatchObject({ walletMinor: 10_000, dueMinor: 22_500 });
    expect(planPayment({ ...base, extraMinor: 0, useWallet: true, walletBalanceMinor: 99_999 })).toMatchObject({ walletMinor: 32_500, dueMinor: 0 });
  });

  it("ignores more points than the items can take", () => {
    const p = planPayment({ lines, extraMinor: 0, redeemPoints: 9_999, pointValueMinor: 100, useWallet: false, walletBalanceMinor: 0 });
    expect(p.discountMinor).toBe(30_000);
    expect(p.payableMinor).toBe(0);
  });

  it("earns whole points only", () => {
    expect(pointsEarned(29_999, 10_000)).toBe(2);
    expect(pointsEarned(9_999, 10_000)).toBe(0);
    expect(pointsEarned(10_000, 0)).toBe(0);
  });
});
