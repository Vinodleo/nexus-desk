import { describe, expect, it } from "vitest";
import { buildBreakoutSetup } from "../../src/services/strategyEngine";
import { LAB_PERSONA_ID, labTunedPersona, panelRoster, runPersonaPanel, TRADER_PERSONAS } from "../../src/services/personaEngine";
import { DEFAULT_MIN_CONFIDENCE, requiredMetaConfidence } from "../../src/services/marketScannerService";
import { describeTunedSettings } from "../../src/components/ledger/LedgerLab";
import type { MarketBar, MetaLabelScore, PromotedLabModel } from "../../src/types";

// 19 quiet bars around 100, then a close at 105 on 3× volume: a breakout.
function breakoutBars(rsi: number): MarketBar[] {
  const bars: MarketBar[] = Array.from({ length: 19 }, (_, i) => ({
    time: String(i), open: 100, high: 101, low: 99, close: 100, volume: 100,
  }));
  bars.push({ time: "19", open: 100, high: 105, low: 100, close: 105, volume: 300, rsi });
  return bars;
}

const ctx = (rsi: number, promotedModel: PromotedLabModel | null = null) => ({
  symbol: "BTC/INR", timeframe: "5m", bars: breakoutBars(rsi), regime: "trending_bullish" as const,
  eventWindowActive: false, promotedModel,
});

const params = { slMultiplier: 1.4, tpMultiplier: 2.8, volSurgeThreshold: 1.2, rsiThreshold: 60, minConfidence: 0.48 };
const model: PromotedLabModel = {
  promotedAt: "2026-09-20T10:00:00Z", datasetName: "BTC/INR (1h, 1000 bars)", accuracyPct: 61, winRatePct: 57,
  sharpeRatio: 1.1, totalCandlesEvaluated: 1000, distilledRulesCount: 2, distilledLessons: [], optimizedParameters: params,
};

const tuning = {
  idSuffix: "t", name: "t", volSurgeThreshold: 1.2, stopAtrMult: 1.4, stopPriceFloorPct: 0.001,
  targetAtrMult: 2.8, targetStopMultFloor: 1, baseProbability: 0.55,
};

describe("breakout RSI filter", () => {
  it("skips a long breakout when RSI is past the Lab's limit", () => {
    expect(buildBreakoutSetup(ctx(55), { ...tuning, rsiCeiling: 60 })?.qualifies).toBe(true);
    const stretched = buildBreakoutSetup(ctx(72), { ...tuning, rsiCeiling: 60 });
    expect(stretched?.qualifies).toBe(false);
    expect(stretched?.disqualificationReason).toMatch(/RSI 72 too stretched/);
    // Without a limit, RSI doesn't matter (the fixed roster's behaviour).
    expect(buildBreakoutSetup(ctx(72), tuning)?.qualifies).toBe(true);
  });

  it("uses the Lab's stop and target in ATRs: hourly ones for a coin, 5-minute ones for a stock", () => {
    // ATR defaults to 0.5% of 105 = 0.525. A coin plans on the hourly scale;
    // without an hour of candles yet, that's the 5-minute ATR × √12.
    const hourly = 0.525 * Math.sqrt(12);
    const coin = labTunedPersona(model)!.evaluate(ctx(55))!;
    expect(coin.stopLoss).toBeCloseTo(105 - hourly * 1.4, 2);
    expect(coin.takeProfit).toBeCloseTo(105 + hourly * 2.8, 2);
    expect(coin.planAtr).toBeCloseTo(hourly, 6);
    const stock = labTunedPersona(model)!.evaluate({ ...ctx(55), symbol: "SBIN" })!;
    expect(stock.stopLoss).toBeCloseTo(105 - 0.525 * 1.4, 2);
  });
});

describe("the Lab's tuned trader", () => {
  it("joins the panel only for a real-data model with tuned parameters", () => {
    expect(panelRoster(null)).toBe(TRADER_PERSONAS);
    expect(panelRoster(model).map((p) => p.id)).toContain(LAB_PERSONA_ID);
    expect(panelRoster({ ...model, isSynthetic: true })).toBe(TRADER_PERSONAS);
    expect(panelRoster({ ...model, optimizedParameters: undefined })).toBe(TRADER_PERSONAS);
  });

  it("votes with the panel when its settings qualify", () => {
    const score = () => ({ confidence: 0.6, calibratedWinProbability: 0.6 }) as MetaLabelScore;
    const withLab = runPersonaPanel(ctx(55, model), score);
    expect(withLab.supportingPersonas).toContain("Lab — Tuned Breakout");
    expect(withLab.totalPersonasRun).toBe(runPersonaPanel(ctx(55), score).totalPersonasRun + 1);

    // Overextended: the other breakout traders still vote, the Lab's doesn't.
    const stretched = runPersonaPanel(ctx(72, model), score);
    expect(stretched.supportingPersonas).not.toContain("Lab — Tuned Breakout");
  });
});

describe("confidence bar", () => {
  it("can be raised by a promoted model but never lowered", () => {
    expect(requiredMetaConfidence(null)).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(requiredMetaConfidence(model)).toBe(DEFAULT_MIN_CONFIDENCE); // Lab's 0.48 is ignored
    expect(requiredMetaConfidence({ ...model, optimizedParameters: { ...params, minConfidence: 0.65 } })).toBe(0.65);
  });
});

describe("Lab wording", () => {
  it("describes the tuned settings in plain words", () => {
    expect(describeTunedSettings(params)).toBe("Volume at least 1.2× normal, stop 1.4 ATR, target 2.8 ATR, skip if RSI is past 60");
  });
});
