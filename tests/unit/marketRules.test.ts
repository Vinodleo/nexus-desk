import { afterEach, describe, expect, it } from "vitest";
import { estimatedRule, fitQuantity, floorToStep, parseMarketsDetails } from "../../src/shared/marketRules";
import { _setMarketRules } from "../../src/services/marketRulesStore";
import { DEFAULT_RISK_POLICY, evaluateExpectedValue, evaluateRiskEngine } from "../../src/services/riskEngine";

afterEach(() => _setMarketRules([]));

describe("CoinDCX market rules", () => {
  it("parses active INR markets and ignores the rest", () => {
    const rules = parseMarketsDetails([
      { coindcx_name: "BTCINR", base_currency_short_name: "INR", target_currency_short_name: "BTC", min_quantity: 0.0001, max_quantity: 100, step: 0.0001, min_notional: 100, target_currency_precision: 4, base_currency_precision: 0, status: "active" },
      { coindcx_name: "ETHUSDT", base_currency_short_name: "USDT", target_currency_short_name: "ETH", status: "active" },
      { coindcx_name: "OLDINR", base_currency_short_name: "INR", target_currency_short_name: "OLD", status: "inactive" },
      "junk",
    ]);
    expect(rules).toEqual([
      { market: "BTCINR", symbol: "BTC/INR", minQuantity: 0.0001, maxQuantity: 100, quantityStep: 0.0001, minNotional: 100, quantityPrecision: 4, pricePrecision: 0 },
    ]);
  });

  it("rounds down to the step without floating-point dust", () => {
    expect(floorToStep(0.00179999, { quantityStep: 0.0001, quantityPrecision: 4 })).toBe(0.0017);
    expect(floorToStep(0.3, { quantityStep: 0.1, quantityPrecision: 1 })).toBe(0.3);
    expect(floorToStep(47.9, { quantityStep: 1, quantityPrecision: 0 })).toBe(47);
  });

  it("rejects sizes under the minimum quantity or order value", () => {
    const rule = { ...estimatedRule("BTC/INR", 5_800_000), minQuantity: 0.0001, quantityStep: 0.0001, quantityPrecision: 4 };
    expect(fitQuantity(0.00005, 5_800_000, rule).ok).toBe(false);
    expect(fitQuantity(0.0017, 5_800_000, rule)).toEqual({ ok: true, quantity: 0.0017, notional: 9860 });
    const cheap = { ...estimatedRule("XRP/INR", 212), minNotional: 100 };
    const small = fitQuantity(0.3, 212, cheap);
    expect(small.ok).toBe(false);
    if (!small.ok) expect(small.reason).toMatch(/below XRP\/INR's minimum of ₹100/);
  });
});

describe("sizing with market rules", () => {
  const noDrills = {
    globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
    simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
  };
  const trade = (symbol: string, price: number) => {
    const atr = price * 0.008; // a 1.2% stop: coins never stop closer (COIN_MIN_STOP_PCT)
    const setup: any = {
      id: "s", name: "t", family: "trend_following", direction: "LONG", symbol, timeframe: "5m", entryPrice: price,
      stopLoss: price - 1.5 * atr, takeProfit: price + 3.3 * atr, riskRewardRatio: 2.2, baseProbability: 0.58, qualifies: true,
      features: { emaAlignment: true, volumeSurgeRatio: 1.5, vwapDistancePercent: 0.1, adx: 30, rsi: 55, atr },
    };
    const meta: any = { confidence: 0.62, calibratedWinProbability: 0.62 };
    const ev = evaluateExpectedValue(setup, meta, price * 0.0005, 88);
    return evaluateRiskEngine(setup, meta, ev, [], 0, 88, 2, DEFAULT_RISK_POLICY, noDrills, false, { spread: price * 0.0005 });
  };

  it("can trade BTC, ETH and SOL again (the invented lot sizes blocked them)", () => {
    for (const [sym, price] of [["BTC/INR", 5_861_300], ["ETH/INR", 265_922], ["SOL/INR", 11_444]] as const) {
      const r = trade(sym, price);
      expect(r.passedAllChecks).toBe(true);
      expect(r.recommendedPositionSizeUnits).toBeGreaterThan(0);
      expect(r.recommendedDollarExposure).toBeLessThanOrEqual(DEFAULT_RISK_POLICY.maxOrderValueInr);
    }
  });

  it("uses CoinDCX's own step once loaded", () => {
    _setMarketRules([{ market: "BTCINR", symbol: "BTC/INR", minQuantity: 0.001, maxQuantity: 10, quantityStep: 0.001, minNotional: 100, quantityPrecision: 3, pricePrecision: 0 }]);
    const r = trade("BTC/INR", 5_861_300);
    expect(r.recommendedPositionSizeUnits).toBe(0.001);
  });

  it("rejects with a size code when the exchange minimum can't be met", () => {
    _setMarketRules([{ market: "BTCINR", symbol: "BTC/INR", minQuantity: 0.01, maxQuantity: 10, quantityStep: 0.01, minNotional: 100, quantityPrecision: 2, pricePrecision: 0 }]);
    const r = trade("BTC/INR", 5_861_300);
    expect(r.passedAllChecks).toBe(false);
    expect(r.rejectionCode).toBe("size");
  });
});
