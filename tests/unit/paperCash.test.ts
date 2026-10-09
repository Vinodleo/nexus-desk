import { describe, expect, it } from "vitest";
import { cashTiedUp, freeCash, moneyInTrades } from "../../src/shared/paperCash";
import { COIN_FEE_PER_SIDE } from "../../src/shared/tradeMath";
import { US_FEE_RATE_PER_SIDE } from "../../src/shared/usMarket";
import { nseTradeCosts } from "../../src/shared/nse";

// A paper desk is a cash account: open trades tie up what they cost, and the fee paid to open them.

describe("paper cash", () => {
  it("counts what open paper trades cost on the part still held, and their opening fee, not live ones", () => {
    const positions = [
      { symbol: "SOL/INR", entryPrice: 23073, quantity: 4.3339 },
      // Half banked at +1R: only the half still held ties up its cost; the fee to open it all was paid.
      { symbol: "ETH/INR", entryPrice: 1000, quantity: 10, bankedQuantity: 5 },
      // Live: CoinDCX's balance already holds it back.
      { symbol: "BTC/INR", entryPrice: 500, quantity: 4, isLiveOrder: true },
    ];
    const tied = 23073 * 4.3339 * (1 + COIN_FEE_PER_SIDE) + 5000 + 10_000 * COIN_FEE_PER_SIDE;
    expect(moneyInTrades(positions)).toBeCloseTo(tied, 6);
    expect(freeCash(1_000_000, positions)).toBeCloseTo(1_000_000 - tied, 6);
    expect(freeCash(1000, positions)).toBe(0);
    expect(freeCash(1000, [])).toBe(1000);
  });

  it("takes each market's own opening fee", () => {
    expect(cashTiedUp({ symbol: "AAPL.US", direction: "LONG", entryPrice: 1000, quantity: 10 })).toBeCloseTo(10_000 * (1 + US_FEE_RATE_PER_SIDE), 6);
    expect(cashTiedUp({ symbol: "SBIN", direction: "LONG", entryPrice: 1000, quantity: 10 })).toBeCloseTo(
      10_000 + nseTradeCosts([{ side: "BUY", value: 10_000 }]),
      6
    );
  });
});
