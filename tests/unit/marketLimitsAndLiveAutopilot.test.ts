import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpectedValueAssessment, MetaLabelScore, StrategySetup, TradeProposal } from "../../src/types";
import { DEFAULT_RISK_POLICY, evaluateRiskEngine } from "../../src/services/riskEngine";
import { selectAutopilotTrades } from "../../src/services/autopilot";
import { cleanMarketLimits, DEFAULT_MARKET_LIMITS } from "../../src/shared/marketLimits";

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
    setup: { symbol, name: "Test", direction: "LONG", entryPrice: 1000, stopLoss: 980, takeProfit: 1060, family: "breakout_confirmation", horizon: "intraday", ...setup },
    ...over,
  } as unknown as TradeProposal;
}
const held = (symbol: string) => ({ symbol, quantity: 1, currentPrice: 1000 });

describe("per-market limits", () => {
  it("keep only sensible values, defaulting the rest", () => {
    expect(cleanMarketLimits(null)).toEqual(DEFAULT_MARKET_LIMITS);
    expect(cleanMarketLimits({ coins: { amountPerTradeInr: 2500, maxOpenTrades: 4 }, stocks: { amountPerTradeInr: -5, maxOpenTrades: 99 } })).toEqual({
      coins: { amountPerTradeInr: 2500, maxOpenTrades: 4 },
      stocks: DEFAULT_MARKET_LIMITS.stocks,
      // Saved before US stocks existed: the default.
      us: DEFAULT_MARKET_LIMITS.us,
    });
  });

  it("size each trade to its market's amount, and count trades per market", () => {
    const setup = { symbol: "SOL/INR", direction: "LONG", entryPrice: 1000, stopLoss: 980, takeProfit: 1060, riskRewardRatio: 3 } as StrategySetup;
    const score = { calibratedWinProbability: 0.6, confidence: 0.6 } as MetaLabelScore;
    const ev = { isPositiveEdge: true, expectedNetValue: 100 } as ExpectedValueAssessment;
    const noDrills = {
      globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
      simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
    };
    const run = (s: StrategySetup, positions: any[]) =>
      evaluateRiskEngine(s, score, ev, positions, 0, 80, 0, policy, noDrills, false);
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
