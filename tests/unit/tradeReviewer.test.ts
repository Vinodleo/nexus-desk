import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketBar, StrategySetup, TradeProposal } from "../../src/types";
import { DEFAULT_RISK_POLICY } from "../../src/services/riskEngine";
import { reviewerSummary } from "../../src/services/reviewerSummary";

// Gemini reviewing the server autopilot's trades just before they open: it
// can skip one, never add one, and without an answer the trade goes ahead.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-reviewer-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.parse("2026-09-24T05:00:00Z");
const limits = {
  coins: { amountPerTradeInr: 3000, maxOpenTrades: 3 },
  stocks: { amountPerTradeInr: 8000, maxOpenTrades: 1 },
  us: { amountPerTradeInr: 4000, maxOpenTrades: 1 },
};
const policy = { ...DEFAULT_RISK_POLICY, equity: 100000, marketLimits: limits, autopilotMaxApprovalsPerHour: 10 };

function proposal(symbol: string, setup: Partial<StrategySetup> = {}): TradeProposal {
  return {
    id: `prop-${symbol}`,
    symbol,
    status: "PENDING_APPROVAL",
    regime: "trending_up",
    ensembleAgreement: 1,
    personaVotesCast: 3,
    riskCalc: { recommendedPositionSizeUnits: 3, riskDollars: 100 },
    metaScore: { confidence: 0.6, calibratedWinProbability: 0.55 },
    exitEdge: { r: 0.12, trades: 40 },
    setup: {
      symbol, name: "Chen Conservative Trend", direction: "LONG", entryPrice: 1000, stopLoss: 980, takeProfit: 1060,
      riskRewardRatio: 3, family: "trend_pullback", horizon: "intraday",
      features: { emaAlignment: true, volumeSurgeRatio: 1.4, vwapDistancePercent: 0.3, adx: 27, rsi: 58, atr: 8 },
      ...setup,
    },
  } as unknown as TradeProposal;
}

const bars: MarketBar[] = Array.from({ length: 50 }, (_, i) => {
  const t = now - (50 - i) * 5 * 60_000;
  return { time: new Date(t).toISOString(), timestampMs: t, open: 990 + i * 0.2, high: 992 + i * 0.2, low: 989 + i * 0.2, close: 991 + i * 0.2, volume: 100 + i };
});

const desk = {
  equity: 100000, riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 1, marketLimits: limits }, dailyRealizedPnl: 0, pnlDay: "",
  autopilot: true, tradingMode: "PAPER" as const, killSwitch: false, scanning: true,
  failureState: {
    simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
    simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
  },
  quarantines: {}, promotedModel: null, updatedAt: now,
};
const deps = { livePrice: () => 1001, barAtr: () => 5, bars: () => bars };

beforeEach(async () => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.stubEnv("GEMINI_REVIEW_MODELS", "");
  vi.stubEnv("GEMINI_REVIEW_DAILY_LIMIT", "");
  (await import("../../server/tradeReviewer"))._resetReviewer({ minGapMs: 0 });
  (await import("../../server/guardian"))._resetGuardian();
  (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
});

describe("Gemini's review", () => {
  it("is off, and asks nothing, without a key", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { reviewTrade, reviewerStatus } = await import("../../server/tradeReviewer");
    const generate = vi.fn();
    expect(await reviewTrade(proposal("SOL/INR"), bars, now, generate)).toMatchObject({ outcome: "unreviewed", off: true });
    expect(generate).not.toHaveBeenCalled();
    expect(reviewerStatus(now)).toMatchObject({ configured: false, reviewed: 0, unreviewed: 0 });
  });

  it("shows Gemini the setup, the trader's record and three hours of candles, and counts its answers", async () => {
    const { reviewTrade, reviewerStatus } = await import("../../server/tradeReviewer");
    const generate = vi.fn(async ({ prompt }: { prompt: string }) =>
      JSON.parse(prompt).symbol === "SOL/INR" ? '{"take": true, "reason": "Clean pullback in an uptrend."}' : '{"take": false, "reason": "Straight into resistance."}'
    );
    expect(await reviewTrade(proposal("SOL/INR"), bars, now, generate)).toMatchObject({ outcome: "take", model: "gemini-3.1-flash-lite" });
    expect(await reviewTrade(proposal("ETH/INR"), bars, now, generate)).toMatchObject({ outcome: "skip", reason: "Straight into resistance." });
    const sent = JSON.parse(generate.mock.calls[0][0].prompt);
    expect(sent).toMatchObject({ symbol: "SOL/INR", direction: "LONG", trader: "Chen Conservative Trend", entry: 1000, stop: 980, target: 1060 });
    expect(sent.traderRecentAverageR).toEqual({ r: 0.12, trades: 40 });
    expect(sent.candles5mUtc.rows).toHaveLength(36);
    expect(reviewerStatus(now)).toMatchObject({ configured: true, reviewed: 2, taken: 1, skipped: 1, unreviewed: 0, lastError: null });
  });

  it("tries the next model when one isn't available", async () => {
    const { reviewTrade } = await import("../../server/tradeReviewer");
    const generate = vi.fn(async ({ model }: { model: string }) => {
      if (model === "gemini-3.1-flash-lite") throw Object.assign(new Error("models/gemini-3.1-flash-lite is not found"), { status: 404 });
      return '{"take": true, "reason": "ok"}';
    });
    expect(await reviewTrade(proposal("SOL/INR"), bars, now, generate)).toMatchObject({ outcome: "take", model: "gemini-3.8-flash" });
  });

  it("backs off when Google's free tier says no, and lets the trade go ahead unreviewed", async () => {
    const { reviewTrade, reviewerStatus } = await import("../../server/tradeReviewer");
    const generate = vi.fn(async () => {
      throw Object.assign(new Error("RESOURCE_EXHAUSTED: quota exceeded"), { status: 429 });
    });
    expect(await reviewTrade(proposal("SOL/INR"), bars, now, generate)).toMatchObject({ outcome: "unreviewed" });
    // A minute later it doesn't ask again yet.
    expect(await reviewTrade(proposal("ETH/INR"), bars, now + 60_000, generate)).toMatchObject({ outcome: "unreviewed" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(reviewerStatus(now + 60_000)).toMatchObject({ limitHits: 1, unreviewed: 2, limitReached: true });
  });

  it("stops at the daily cap, and starts again the next day (India time)", async () => {
    vi.stubEnv("GEMINI_REVIEW_DAILY_LIMIT", "1");
    const { reviewTrade, reviewerStatus } = await import("../../server/tradeReviewer");
    const generate = vi.fn(async () => '{"take": true, "reason": "ok"}');
    await reviewTrade(proposal("SOL/INR"), bars, now, generate);
    expect(await reviewTrade(proposal("ETH/INR"), bars, now, generate)).toMatchObject({ outcome: "unreviewed", reason: expect.stringMatching(/1 reviews are used up/) });
    expect(generate).toHaveBeenCalledTimes(1);
    const tomorrow = now + 24 * 60 * 60_000;
    expect(await reviewTrade(proposal("ETH/INR"), bars, tomorrow, generate)).toMatchObject({ outcome: "take" });
    expect(reviewerStatus(tomorrow)).toMatchObject({ reviewed: 1, unreviewed: 0 });
  });

  it("treats a garbled answer as no answer", async () => {
    const { reviewTrade } = await import("../../server/tradeReviewer");
    expect(await reviewTrade(proposal("SOL/INR"), bars, now, async () => "maybe?")).toMatchObject({ outcome: "unreviewed" });
  });
});

describe("the server's autopilot with Gemini", () => {
  it("opens what Gemini takes, holds back what it skips, and goes ahead without an answer", async () => {
    const { runServerAutopilot } = await import("../../server/scanner/autopilot");
    const { daemonPositions } = await import("../../server/guardian");
    const reviewTrade = vi.fn(async (p: TradeProposal, _bars?: MarketBar[]) =>
      p.symbol === "SOL/INR"
        ? { outcome: "take" as const, reason: "Clean pullback.", model: "m" }
        : p.symbol === "ETH/INR"
          ? { outcome: "skip" as const, reason: "Straight into resistance.", model: "m" }
          : { outcome: "unreviewed" as const, reason: "no answer in 20s" }
    );
    const out = await runServerAutopilot("u", desk, [proposal("SOL/INR"), proposal("ETH/INR"), proposal("XRP/INR")], policy, deps, now, {
      placeLiveEntry: vi.fn(),
      reviewTrade,
    });
    const byId = Object.fromEntries(out.map((p) => [p.symbol, p]));
    expect(byId["SOL/INR"]).toMatchObject({ status: "APPROVED", aiReview: { outcome: "take" } });
    expect(byId["ETH/INR"]).toMatchObject({ status: "DEFERRED", deferralReason: "Gemini skipped it: Straight into resistance.", aiReview: { outcome: "skip" } });
    expect(byId["XRP/INR"]).toMatchObject({ status: "APPROVED", aiReview: { outcome: "unreviewed" } });
    expect([...daemonPositions.values()].map((p) => p.symbol).sort()).toEqual(["SOL/INR", "XRP/INR"]);
    // It saw the candles.
    expect(reviewTrade.mock.calls[0][1]).toBe(bars);
  });

  it("never reviews a trade the checks already refused", async () => {
    const { runServerAutopilot } = await import("../../server/scanner/autopilot");
    const reviewTrade = vi.fn();
    await runServerAutopilot("u", { ...desk, autopilot: false }, [proposal("SOL/INR")], policy, deps, now, { placeLiveEntry: vi.fn(), reviewTrade });
    expect(reviewTrade).not.toHaveBeenCalled();
  });
});

describe("Settings' Gemini row", () => {
  const base = { startedAt: 0, uptimeSec: 1, cloudRun: null, storage: { dir: "", kept: true, note: "" }, scanner: { lastTickAt: 0, lastCycleDoneAt: 0, stalled: false } };
  const reviewer = { configured: true, dailyLimit: 300, reviewed: 12, taken: 9, skipped: 3, unreviewed: 0, limitHits: 0, limitReached: false, lastError: null };
  it("says how many trades Gemini handled today", () => {
    expect(reviewerSummary(null).badge).toBe("checking");
    expect(reviewerSummary({ ...base }).badge).toBe("off");
    expect(reviewerSummary({ ...base, reviewer })).toEqual({ sub: "Today 12/300 reviewed · 9 taken · 3 skipped", badge: "working" });
    expect(reviewerSummary({ ...base, reviewer: { ...reviewer, limitHits: 2, unreviewed: 4, limitReached: true } }).sub).toBe(
      "Today 12/300 reviewed · 9 taken · 3 skipped · 4 went ahead unreviewed · Google's limit hit 2×"
    );
    expect(reviewerSummary({ ...base, reviewer: { ...reviewer, limitReached: true } }).badge).toBe("limit");
  });
});
