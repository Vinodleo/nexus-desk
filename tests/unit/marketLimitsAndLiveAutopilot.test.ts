import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpectedValueAssessment, MetaLabelScore, StrategySetup, TradeProposal } from "../../src/types";
import { DEFAULT_RISK_POLICY, evaluateRiskEngine } from "../../src/services/riskEngine";
import { selectAutopilotTrades } from "../../src/services/autopilot";
import { cleanMarketLimits, DEFAULT_MARKET_LIMITS, sectorOf } from "../../src/shared/marketLimits";
import { SKIP_REASON_LABEL, skipReasonForRisk } from "../../src/services/scanOutcome";

// Amount per trade and trades at once, set separately for coins and stocks;
// and the server's autopilot placing real CoinDCX orders in Live mode, only
// while the server allows live orders.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-limits-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.parse("2026-09-24T05:00:00Z");
const limits = {
  coins: { amountPerTradeInr: 3000, maxOpenTrades: 2 },
  stocks: { amountPerTradeInr: 8000, maxOpenTrades: 1 },
  us: { amountPerTradeInr: 4000, maxOpenTrades: 1 },
};
const policy = { ...DEFAULT_RISK_POLICY, equity: 100000, marketLimits: limits };

function proposal(symbol: string, over: Partial<TradeProposal> = {}, setup: Partial<StrategySetup> = {}): TradeProposal {
  return {
    id: `prop-${symbol}`,
    symbol,
    status: "PENDING_APPROVAL",
    ensembleAgreement: 1,
    personaVotesCast: 3,
    riskCalc: { recommendedPositionSizeUnits: 3, riskDollars: 100 },
    metaScore: { confidence: 0.6, calibratedWinProbability: 0.6 },
    setup: { symbol, name: "Test", direction: "LONG", entryPrice: 1000, stopLoss: 940, takeProfit: 1180, family: "breakout_confirmation", horizon: "intraday", ...setup },
    ...over,
  } as unknown as TradeProposal;
}
const held = (symbol: string) => ({ symbol, quantity: 1, currentPrice: 1000 });

describe("per-market limits", () => {
  it("keep only sensible values, defaulting the rest", () => {
    expect(cleanMarketLimits(null)).toEqual(DEFAULT_MARKET_LIMITS);
    expect(cleanMarketLimits({ coins: { amountPerTradeInr: 2500, maxOpenTrades: 4 }, stocks: { amountPerTradeInr: -5, maxOpenTrades: 99 } })).toEqual({
      // Saved before risk per trade existed: 1% of the amount; before breakout's own slots: 3; before momentum's: none for coins.
      coins: { amountPerTradeInr: 2500, maxOpenTrades: 4, riskPerTradeInr: 25, breakoutTrades: 3, momentumTrades: 0 },
      stocks: DEFAULT_MARKET_LIMITS.stocks,
      // Saved before US stocks existed: the default.
      us: DEFAULT_MARKET_LIMITS.us,
    });
  });

  it("keep a chosen risk per trade, and start at 1% of the amount", () => {
    expect(DEFAULT_MARKET_LIMITS.coins.riskPerTradeInr).toBe(50);
    const cleaned = cleanMarketLimits({
      coins: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 150 },
      stocks: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 3 },
      us: { amountPerTradeInr: 50000, maxOpenTrades: 2 },
    });
    expect(cleaned.coins.riskPerTradeInr).toBe(150);
    expect(cleaned.stocks.riskPerTradeInr).toBe(50); // too small to be meant
    // US shares cost ₹10,000 or more each: a ₹50,000 amount starts at ₹500, so a trade can still buy one.
    expect(cleaned.us.riskPerTradeInr).toBe(500);
  });

  it("size each trade so its stop loses the market's risk per trade, up to the amount", () => {
    const sized = { ...DEFAULT_RISK_POLICY, equity: 100000, marketLimits: cleanMarketLimits(null) };
    const score = { calibratedWinProbability: 0.6, confidence: 0.6 } as MetaLabelScore;
    const ev = { isPositiveEdge: true, expectedNetValue: 100 } as ExpectedValueAssessment;
    const noDrills = {
      globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
      simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
    };
    const lossAtStop = (stopLoss: number, p = sized) => {
      const setup = { symbol: "SOL/INR", direction: "LONG", entryPrice: 1000, stopLoss, takeProfit: 1100, riskRewardRatio: 3 } as StrategySetup;
      const r = evaluateRiskEngine(setup, score, ev, [], 0, 80, p, noDrills, false);
      expect(r.passedAllChecks).toBe(true);
      return r.recommendedPositionSizeUnits * (1000 - stopLoss);
    };
    // A 10% stop and a 6% stop both lose ₹50: the wider one is 60% the size.
    // (Coin stops need room for CoinDCX's 1.18% round trip: under about 4.7% the fees alone are too much.)
    expect(lossAtStop(900)).toBeCloseTo(50, 1);
    expect(lossAtStop(940)).toBeCloseTo(50, 1);
    // ₹500 at risk on a 6% stop would need ₹8,333; the ₹5,000 amount caps it, so it loses less.
    const bigger = { ...sized, marketLimits: { ...sized.marketLimits, coins: { ...sized.marketLimits.coins, riskPerTradeInr: 500 } } };
    expect(lossAtStop(940, bigger)).toBeCloseTo(300, 1);
    // The share of equity still caps it: ₹10,000 of equity at 0.3% is ₹30.
    expect(lossAtStop(940, { ...sized, equity: 10000 })).toBeCloseTo(30, 1);
  });

  it("size each trade to its market's amount, and count trades per market", () => {
    const setup = { symbol: "SOL/INR", direction: "LONG", entryPrice: 1000, stopLoss: 940, takeProfit: 1180, riskRewardRatio: 3 } as StrategySetup;
    const score = { calibratedWinProbability: 0.6, confidence: 0.6 } as MetaLabelScore;
    const ev = { isPositiveEdge: true, expectedNetValue: 100 } as ExpectedValueAssessment;
    const noDrills = {
      globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
      simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
    };
    const run = (s: StrategySetup, positions: any[]) =>
      evaluateRiskEngine(s, score, ev, positions, 0, 80, policy, noDrills, false);
    const coin = run(setup, []);
    expect(coin.passedAllChecks).toBe(true);
    // ₹3,000 at ₹1,000 = 3 units, well under the ₹300 risk cap.
    expect(coin.recommendedDollarExposure).toBeLessThanOrEqual(3000);
    expect(coin.recommendedDollarExposure).toBeGreaterThan(2500);
    // Two coins open: a third is refused; a stock still fits its own count.
    const two = [held("A/INR"), held("B/INR")];
    expect(run(setup, two).rejectionReason).toMatch(/Maximum open coin trades reached \(2\/2\)/);
    const stock = run({ ...setup, symbol: "SBIN" }, two);
    expect(stock.passedAllChecks).toBe(true);
    expect(stock.recommendedDollarExposure).toBeGreaterThan(3000);
    expect(run({ ...setup, symbol: "TCS" }, [...two, held("SBIN")]).rejectionReason).toMatch(/open Indian stock trades reached \(1\/1\)/);
  });

  it("put stocks in sectors, Indian and US apart, and coins in none", () => {
    expect(sectorOf("SBIN")).toEqual({ key: "stocks:BANK", label: "banking" });
    expect(sectorOf("HDFCBANK")?.key).toBe(sectorOf("SBIN")?.key);
    expect(sectorOf("TCS")?.key).toBe("stocks:IT");
    expect(sectorOf("AAPL.US")).toEqual({ key: "us:TECH", label: "tech" });
    expect(sectorOf("SOL/INR")).toBeNull();
  });

  it("allow at most two open stock trades in one sector, whatever the market's count", () => {
    const roomy = { ...policy, marketLimits: { ...limits, stocks: { amountPerTradeInr: 8000, maxOpenTrades: 4 } } };
    const score = { calibratedWinProbability: 0.6, confidence: 0.6 } as MetaLabelScore;
    const ev = { isPositiveEdge: true, expectedNetValue: 100 } as ExpectedValueAssessment;
    const noDrills = {
      globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
      simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
    };
    const run = (symbol: string, positions: any[]) =>
      evaluateRiskEngine({ symbol, direction: "LONG", entryPrice: 1000, stopLoss: 940, takeProfit: 1180, riskRewardRatio: 3 } as StrategySetup, score, ev, positions, 0, 80, roomy, noDrills, false);
    const twoBanks = [held("HDFCBANK"), held("ICICIBANK")];
    expect(roomy.maxCorrelatedPositionsPerGroup).toBe(2);
    const third = run("SBIN", twoBanks);
    expect(third.rejectionCode).toBe("correlation");
    expect(third.rejectionReason).toMatch(/Already 2 open Indian stock trades in banking \(max 2\)/);
    expect(SKIP_REASON_LABEL[skipReasonForRisk("correlation")]).toBe("Enough trades open in this sector already");
    // Another sector, or one bank, is fine; coins aren't held to sectors.
    expect(run("TCS", twoBanks).passedAllChecks).toBe(true);
    expect(run("SBIN", [held("HDFCBANK")]).passedAllChecks).toBe(true);
    expect(run("SOL/INR", [held("A/INR")]).passedAllChecks).toBe(true);
  });

  it("hold the autopilot to two per sector across one batch", () => {
    const roomy = { ...policy, marketLimits: { ...limits, stocks: { amountPerTradeInr: 8000, maxOpenTrades: 4 } }, autopilotMaxApprovalsPerHour: 10 };
    const batch = ["SBIN", "ICICIBANK", "TCS"].map((s) => proposal(s));
    const { accepted, deferred } = selectAutopilotTrades(batch, { positions: [held("HDFCBANK")], openedLastHour: 0, quarantines: {} }, roomy, () => 1000, now);
    expect(accepted.map((a) => a.proposal.symbol)).toEqual(["SBIN", "TCS"]);
    expect(deferred.map((d) => [d.proposal.symbol, d.reason])).toEqual([["ICICIBANK", "would exceed 2 open trades in banking"]]);
  });

  it("give breakout 55/20 slots of its own in coins and US stocks: the other trades can't fill them, nor it theirs", () => {
    expect([DEFAULT_MARKET_LIMITS.coins.breakoutTrades, DEFAULT_MARKET_LIMITS.stocks.breakoutTrades, DEFAULT_MARKET_LIMITS.us.breakoutTrades]).toEqual([3, 0, 3]);
    const cleaned = cleanMarketLimits({
      coins: { amountPerTradeInr: 5000, maxOpenTrades: 2, breakoutTrades: 0 },
      stocks: { amountPerTradeInr: 5000, maxOpenTrades: 2 },
      us: { amountPerTradeInr: 5000, maxOpenTrades: 2, breakoutTrades: 99 },
    });
    // None switches breakout off; nonsense falls back to the default.
    expect([cleaned.coins.breakoutTrades, cleaned.us.breakoutTrades]).toEqual([0, 3]);

    const roomy = { ...policy, marketLimits: { ...limits, coins: { ...limits.coins, breakoutTrades: 2 } }, autopilotMaxApprovalsPerHour: 10 };
    const breakout = (symbol: string) => proposal(symbol, {}, { strategy: "breakout" });
    const heldBreakout = (symbol: string) => ({ ...held(symbol), strategy: "breakout" as const });
    // Two daily coin trades fill the coin slots: breakout still opens on its own two.
    const daily = [held("A/INR"), held("B/INR")];
    const batch = [breakout("C/INR"), proposal("D/INR"), breakout("E/INR"), breakout("F/INR")];
    const { accepted, deferred } = selectAutopilotTrades(batch, { positions: daily, openedLastHour: 0, quarantines: {} }, roomy, () => 1000, now);
    expect(accepted.map((a) => a.proposal.symbol)).toEqual(["C/INR", "E/INR"]);
    expect(deferred.map((d) => [d.proposal.symbol, d.reason])).toEqual([
      ["D/INR", "would exceed 2 open coin trades at once"],
      ["F/INR", "would exceed 2 open coin breakout trades at once"],
    ]);
    // Two breakout trades held: the daily traders' slots are still free.
    const breakouts = [heldBreakout("X/INR"), heldBreakout("Y/INR")];
    expect(selectAutopilotTrades([proposal("D/INR")], { positions: breakouts, openedLastHour: 0, quarantines: {} }, roomy, () => 1000, now).accepted).toHaveLength(1);

    // The scanner's risk check counts the same way.
    const score = { calibratedWinProbability: 0.6, confidence: 0.6 } as MetaLabelScore;
    const ev = { isPositiveEdge: true, expectedNetValue: 100 } as ExpectedValueAssessment;
    const noDrills = {
      globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
      simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
    };
    const setup = { symbol: "SOL/INR", direction: "LONG", entryPrice: 1000, stopLoss: 940, takeProfit: 1180, riskRewardRatio: 3 } as StrategySetup;
    const run = (s: StrategySetup, positions: any[]) => evaluateRiskEngine(s, score, ev, positions, 0, 80, roomy, noDrills, false);
    expect(run(setup, breakouts).passedAllChecks).toBe(true);
    expect(run({ ...setup, strategy: "breakout" }, breakouts).rejectionReason).toMatch(/Maximum open coin breakout trades reached \(2\/2\)/);
    expect(run({ ...setup, strategy: "breakout" }, daily).passedAllChecks).toBe(true);
  });

  it("give US momentum slots of its own too: breakout's and the other trades can't fill them, nor it theirs", () => {
    expect([DEFAULT_MARKET_LIMITS.coins.momentumTrades, DEFAULT_MARKET_LIMITS.stocks.momentumTrades, DEFAULT_MARKET_LIMITS.us.momentumTrades]).toEqual([0, 0, 3]);
    const cleaned = cleanMarketLimits({ coins: { amountPerTradeInr: 5000, maxOpenTrades: 2 }, stocks: { amountPerTradeInr: 5000, maxOpenTrades: 2 }, us: { amountPerTradeInr: 5000, maxOpenTrades: 2, momentumTrades: 0 } });
    expect(cleaned.us.momentumTrades).toBe(0);
    expect(cleanMarketLimits({ us: { amountPerTradeInr: 5000, maxOpenTrades: 2, momentumTrades: 99 } }).us.momentumTrades).toBe(3);

    const roomy = { ...policy, marketLimits: { ...limits, us: { ...limits.us, breakoutTrades: 1, momentumTrades: 2 } }, autopilotMaxApprovalsPerHour: 10 };
    const momentum = (symbol: string) => proposal(symbol, {}, { strategy: "momentum" });
    // A US intraday trade and a US breakout trade fill their slots (1 each): momentum still opens on its own two.
    const book = [held("XOM.US"), { ...held("UNH.US"), strategy: "breakout" as const }];
    const batch = [momentum("JPM.US"), proposal("COST.US"), momentum("LLY.US"), momentum("NFLX.US"), proposal("WMT.US", {}, { strategy: "breakout" })];
    const { accepted, deferred } = selectAutopilotTrades(batch, { positions: book, openedLastHour: 0, quarantines: {} }, roomy, () => 1000, now);
    expect(accepted.map((a) => a.proposal.symbol)).toEqual(["JPM.US", "LLY.US"]);
    expect(deferred.map((d) => [d.proposal.symbol, d.reason])).toEqual([
      ["COST.US", "would exceed 1 open US stock trade at once"],
      ["NFLX.US", "would exceed 2 open US stock momentum trades at once"],
      ["WMT.US", "would exceed 1 open US stock breakout trade at once"],
    ]);

    // The scanner's risk check counts the same way.
    const score = { calibratedWinProbability: 0.6, confidence: 0.6 } as MetaLabelScore;
    const ev = { isPositiveEdge: true, expectedNetValue: 100 } as ExpectedValueAssessment;
    const noDrills = {
      globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
      simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
    };
    const setup = { symbol: "V.US", direction: "LONG", entryPrice: 1000, stopLoss: 940, takeProfit: 1e6, riskRewardRatio: 3, strategy: "momentum" } as StrategySetup;
    const run = (positions: any[]) => evaluateRiskEngine(setup, score, ev, positions, 0, 80, roomy, noDrills, false);
    expect(run(book).passedAllChecks).toBe(true);
    const twoMomentum = [{ ...held("JPM.US"), strategy: "momentum" as const }, { ...held("LLY.US"), strategy: "momentum" as const }];
    expect(run(twoMomentum).rejectionReason).toMatch(/Maximum open US stock momentum trades reached \(2\/2\)/);
  });

  it("let breakout's and momentum's checks open their picks past the hourly cap (their own slots bound them), and count them toward it", () => {
    const roomy = { ...policy, marketLimits: { ...limits, coins: { ...limits.coins, maxOpenTrades: 5, breakoutTrades: 3 }, us: { ...limits.us, momentumTrades: 3 } }, autopilotMaxApprovalsPerHour: 3 };
    const batch = [proposal("NVDA.US", {}, { strategy: "momentum" }), proposal("SOL/INR", {}, { strategy: "breakout" }), proposal("ETH/INR")];
    // Three opened in the last hour already: the cap is reached.
    const { accepted, deferred } = selectAutopilotTrades(batch, { positions: [], openedLastHour: 3, quarantines: {} }, roomy, () => 1000, now);
    expect(accepted.map((a) => a.proposal.symbol)).toEqual(["NVDA.US", "SOL/INR"]);
    expect(deferred.map((d) => [d.proposal.symbol, d.reason])).toEqual([["ETH/INR", "would exceed 3 autonomous approvals/hour"]]);
    // A momentum pick counts toward the hour for the trades after it.
    const after = selectAutopilotTrades([proposal("V.US", {}, { strategy: "momentum" }), proposal("A/INR"), proposal("B/INR"), proposal("C/INR")], { positions: [], openedLastHour: 1, quarantines: {} }, roomy, () => 1000, now);
    expect(after.accepted.map((a) => a.proposal.symbol)).toEqual(["V.US", "A/INR"]);
  });

  it("hold the autopilot to each market's count across one batch", () => {
    const batch = ["A/INR", "B/INR", "C/INR", "SBIN", "TCS"].map((s) => proposal(s));
    const { accepted, deferred } = selectAutopilotTrades(batch, { positions: [], openedLastHour: 0, quarantines: {} }, { ...policy, autopilotMaxApprovalsPerHour: 10 }, () => 1000, now);
    expect(accepted.map((a) => a.proposal.symbol)).toEqual(["A/INR", "B/INR", "SBIN"]);
    expect(deferred.map((d) => d.reason)).toEqual([
      "would exceed 2 open coin trades at once",
      "would exceed 1 open Indian stock trade at once",
    ]);
  });
});

describe("the server's autopilot in Live mode", () => {
  const desk = {
    equity: 100000, riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 1, marketLimits: limits }, dailyRealizedPnl: 0, pnlDay: "",
    autopilot: true, tradingMode: "LIVE_COINDCX" as const, killSwitch: false, scanning: true,
    failureState: {
      simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
      simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
    },
    quarantines: {}, promotedModel: null, updatedAt: now,
  };
  const deps = { livePrice: () => 1001, barAtr: () => 5 };

  beforeEach(async () => {
    (await import("../../server/guardian"))._resetGuardian();
    (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
  });

  it("places nothing while the server blocks live orders", async () => {
    vi.stubEnv("LIVE_TRADING_ENABLED", "");
    const { runServerAutopilot } = await import("../../server/scanner/autopilot");
    const placeLiveEntry = vi.fn();
    const out = await runServerAutopilot("u", desk, [proposal("SOL/INR")], policy, deps, now, { placeLiveEntry });
    expect(placeLiveEntry).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ status: "DEFERRED", deferralReason: expect.stringMatching(/blocked on the server/) });
  });

  it("places real coin orders when allowed, guards them as live, and leaves stocks and refusals for you", async () => {
    vi.stubEnv("LIVE_TRADING_ENABLED", "true");
    const { runServerAutopilot } = await import("../../server/scanner/autopilot");
    const { daemonPositions } = await import("../../server/guardian");
    const placeLiveEntry = vi.fn(async (req: any) =>
      req.symbol === "BAD/INR"
        ? { ok: false as const, status: 403, error: "Order is above the server's cap" }
        : { ok: true as const, orderId: "cdx-1", executedPrice: 1002, quantity: 2.5 }
    );
    const out = await runServerAutopilot(
      "u",
      desk,
      [proposal("SOL/INR"), proposal("SBIN"), proposal("BAD/INR")],
      { ...policy, marketLimits: { ...limits, coins: { amountPerTradeInr: 3000, maxOpenTrades: 3 } }, autopilotMaxApprovalsPerHour: 10 },
      deps,
      now,
      { placeLiveEntry }
    );
    expect(placeLiveEntry).toHaveBeenCalledTimes(2);
    expect(placeLiveEntry.mock.calls[0][0]).toMatchObject({ userId: "u", symbol: "SOL/INR", side: "buy", price: 1001 });
    const byId = Object.fromEntries(out.map((p) => [p.symbol, p]));
    expect(byId["SOL/INR"].status).toBe("APPROVED");
    expect(byId.SBIN).toMatchObject({ status: "DEFERRED", deferralReason: expect.stringMatching(/Angel One live orders aren't set up/) });
    expect(byId["BAD/INR"]).toMatchObject({ status: "DEFERRED", deferralReason: "CoinDCX order not placed: Order is above the server's cap" });
    const positions = [...daemonPositions.values()];
    expect(positions).toHaveLength(1);
    // At the fill and quantity CoinDCX reported, guarded as a live position, never banking half.
    expect(positions[0]).toMatchObject({ symbol: "SOL/INR", isLiveOrder: true, openedByServer: true, entryPrice: 1002, quantity: 2.5 });
    expect(positions[0].partialQuantity).toBeUndefined();
  });

  it("stays paper in Paper mode, whatever the server allows", async () => {
    vi.stubEnv("LIVE_TRADING_ENABLED", "true");
    const { runServerAutopilot } = await import("../../server/scanner/autopilot");
    const { daemonPositions } = await import("../../server/guardian");
    const placeLiveEntry = vi.fn();
    await runServerAutopilot("u", { ...desk, tradingMode: "PAPER" }, [proposal("SOL/INR")], policy, deps, now, { placeLiveEntry });
    expect(placeLiveEntry).not.toHaveBeenCalled();
    expect([...daemonPositions.values()][0]).toMatchObject({ symbol: "SOL/INR", isLiveOrder: false });
  });
});
