import { describe, expect, it } from "vitest";
import { freeCash, moneyInTrades } from "../../src/shared/paperCash";

// A paper desk is a cash account: open trades tie up what they cost.

describe("paper cash", () => {
  it("counts what open paper trades cost on the part still held, not live ones", () => {
    const positions = [
      { entryPrice: 23073, quantity: 4.3339 },
      // Half banked at +1R: only the half still held ties up money.
      { entryPrice: 1000, quantity: 10, bankedQuantity: 5 },
      // Live: CoinDCX's balance already holds it back.
      { entryPrice: 500, quantity: 4, isLiveOrder: true },
    ];
    expect(moneyInTrades(positions)).toBeCloseTo(23073 * 4.3339 + 5000, 6);
    expect(freeCash(1_000_000, positions)).toBeCloseTo(1_000_000 - 23073 * 4.3339 - 5000, 6);
    expect(freeCash(1000, positions)).toBe(0);
    expect(freeCash(1000, [])).toBe(1000);
  });
});
