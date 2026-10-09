import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { holdMinutesFor } from "../../src/shared/coinHolds";

// Breakout 55/20 on US stocks (paper): once each US trading day at 3:45 pm
// New York, this year's biggest US stocks above their 55-day high are
// bought; held ones below their 20-day low are sold. Held overnight, in
// fractions of a share, within the US limits.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-us-breakout-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const RATE = 88;
// Monday 5 October 2026, 3:46 pm New York (summer time: 19:46 UTC); Tuesday's the same.
const monday = Date.parse("2026-10-05T19:46:00Z");
const tuesday = monday + DAY;
const nyMidnight = (ms: number) => Date.parse(new Date(ms).toISOString().slice(0, 10) + "T04:00:00Z");

/** 80 quiet weekday sessions before `now` (high $101, low $99, close $100), then `extra` rows. */
function rows(now: number, extra: unknown[][] = []): unknown[][] {
  const out: unknown[][] = [];
  for (let t = nyMidnight(now) - 120 * DAY; t < nyMidnight(now); t += DAY) {
    const weekday = new Date(t).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    out.push([t, 100, 101, 99, 100, 1000]);
  }
  return [...out.slice(-80), ...extra];
}
const quote = (usd: number) => ({ price: usd * RATE, bid: (usd - 0.05) * RATE, ask: (usd + 0.05) * RATE });
const rec = (trades: number, totalR: number) => ({ trades, totalR, wins: Math.round(trades * 0.37), winR: totalR + trades, lossR: -trades });

const desk = {
  equity: 100000, dailyRealizedPnl: 0, pnlDay: "", autopilot: true, tradingMode: "PAPER" as const, trailProfile: "tight", killSwitch: false, scanning: true,
  // US limits apart from the coins': ₹20,000 a trade, ₹200 at risk, 3 at once.
  riskLimits: {
    maxOrderValueInr: 10000, maxAllowedExposureFraction: 1,
    marketLimits: {
      coins: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50 },
      stocks: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50 },
      us: { amountPerTradeInr: 20000, maxOpenTrades: 3, riskPerTradeInr: 200 },
    },
  },
  failureState: {
    simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
    simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
  },
  quarantines: {}, promotedModel: null, updatedAt: monday,
};

async function fresh() {
  const us = await import("../../server/scanner/usBreakout");
  us._resetUsBreakout();
  (await import("../../server/guardian"))._resetGuardian();
  (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
  return us;
}

/** AAPL and Berkshire break out on Monday (today's partial candle from Alpaca is left out); everything else is quiet. */
async function deps(now: number, over: Record<string, unknown> = {}) {
  const { runServerAutopilot } = await import("../../server/scanner/autopilot");
  const guardian = await import("../../server/guardian");
  const prices: Record<string, number> = { "AAPL.US": 105, "BRK.B.US": 104 };
  return {
    now: () => now,
    sleep: async () => {},
    daily: vi.fn(async () => rows(now, [[nyMidnight(now), 100, 106, 99, 105, 500]])),
    quotes: vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, quote(prices[s] ?? 100)]))),
    rate: () => RATE,
    classic: () => ({ "2020-Q1": { breakout: rec(554, 554 * 0.39) } }),
    desks: () => [["u", desk]] as [string, typeof desk][],
    dailyPnl: () => 0,
    open: vi.fn(runServerAutopilot),
    positions: () => [...guardian.daemonPositions.values()],
    close: (id: string, price: number) => guardian.closeServerPosition(id, price, "TRAILING_STOP"),
    ...over,
  };
}

describe("US breakout trades", () => {
  beforeEach(async () => {
    await fresh();
  });

  it("buy this year's biggest stocks above their 55-day high at 3:45 New York: fractions of a share, the stop 2 ATR below, the US limits", async () => {
    const us = await fresh();
    const { daemonPositions } = await import("../../server/guardian");
    await us.runUsBreakout(await deps(monday));
    const held = [...daemonPositions.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    expect(held.map((p) => p.symbol)).toEqual(["AAPL.US", "BRK.B.US"]);
    const aapl = held[0];
    expect(aapl).toMatchObject({ setupName: "Breakout 55/20", strategy: "breakout", timeframe: "1d", trailProfile: "fixed", entryPrice: 105.05 * RATE });
    expect(aapl.expectedHoldingTimeMinutes).toBe(holdMinutesFor({ strategy: "breakout" }));
    expect(aapl.partialQuantity).toBeUndefined();
    // ATR $2.15 (19 quiet days of $2 and today's $5 jump): the stop $4.30 below $105.
    expect(aapl.stopLoss / aapl.entryPrice).toBeCloseTo(100.7 / 105, 4);
    // Sized to the US limits: ₹200 at the stop, in fractions of a share.
    expect((aapl.entryPrice - aapl.stopLoss) * aapl.quantity).toBeLessThanOrEqual(200.01);
    expect((aapl.entryPrice - aapl.stopLoss) * aapl.quantity).toBeGreaterThan(190);
    expect(aapl.quantity % 1).not.toBe(0);
    expect(us._usBreakoutState().runs.u).toMatchObject({ day: "2026-10-05", coins: 20, failed: [] });
    expect(us._usBreakoutState().runs.u.picks).toEqual([
      { symbol: "AAPL.US", trader: "Breakout 55/20", outcome: "opened" },
      { symbol: "BRK.B.US", trader: "Breakout 55/20", outcome: "opened" },
    ]);
    // Once a day.
    const again = await deps(monday + 60_000);
    await us.runUsBreakout(again);
    expect(again.open).not.toHaveBeenCalled();
  });

  it("check only from 3:45 to 3:50 New York on weekdays, and try again a minute later if prices can't be read", async () => {
    let us = await fresh();
    for (const at of [monday - 2 * 60_000, monday + 4 * 60_000, monday - 2 * DAY]) {
      const d = await deps(at);
      await us.runUsBreakout(d);
      expect(d.quotes).not.toHaveBeenCalled();
    }
    us = await fresh();
    const down = await deps(monday, { quotes: vi.fn(async () => Promise.reject(new Error("Alpaca: service unavailable"))) });
    await us.runUsBreakout(down);
    expect(us._usBreakoutState().lastDay).toBeNull();
    const back = await deps(monday + 60_000);
    await us.runUsBreakout(back);
    expect(back.open).toHaveBeenCalledTimes(1);
  });

  it("trade only while the US record since 2016 is positive", async () => {
    for (const [classic, reason] of [
      [() => null, "no record since 2016"],
      [() => ({ "2020-Q1": { breakout: rec(554, -20) } }), "record since 2016 −0.04R (needs +0.05R)"],
    ] as const) {
      const us = await fresh();
      const { daemonPositions } = await import("../../server/guardian");
      await us.runUsBreakout(await deps(monday, { classic }));
      expect(daemonPositions.size).toBe(0);
      expect(us._usBreakoutState().runs.u.picks[0]).toEqual({ symbol: "AAPL.US", trader: "Breakout 55/20", outcome: "paused", reason });
    }
  });

  it("sell a held trade below its 20-day low at the bid, even with autopilot off, and hold one that isn't; one trade per stock", async () => {
    const { daemonPositions, closedTradesFor } = await import("../../server/guardian");
    // Tuesday: Monday's candle is complete now.
    const monRow = [nyMidnight(monday), 100, 106, 99, 105, 500];
    for (const over of [{}, { desks: () => [["u", { ...desk, autopilot: false }]] }]) {
      const us = await fresh();
      await us.runUsBreakout(await deps(monday));
      const tue = await deps(tuesday, {
        daily: async () => rows(tuesday, [monRow]).filter((r, k, all) => all.findIndex((x) => x[0] === r[0]) === k),
        quotes: async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, quote(s === "AAPL.US" ? 95 : s === "BRK.B.US" ? 107 : 100)])),
        ...over,
      });
      await us.runUsBreakout(tue);
      // AAPL at $95, under its 20-day low of $99: sold at the bid. Berkshire at $107, a new high: still held, not bought twice.
      expect([...daemonPositions.values()].map((p) => p.symbol)).toEqual(["BRK.B.US"]);
      const [closed] = closedTradesFor("u");
      expect(closed).toMatchObject({ symbol: "AAPL.US", exitPrice: 94.95 * RATE, exitReason: "TRAILING_STOP", strategy: "breakout" });
      expect(us._usBreakoutState().runs.u.picks).toEqual([{ symbol: "AAPL.US", trader: "Breakout 55/20", outcome: "sold", reason: "closed below its 20-day low" }]);
    }
  });

  it("say when the next check is: 3:45 pm New York on the next weekday, summer or winter", async () => {
    const us = await fresh();
    // Before Monday's check; after it; Friday's, then Monday's.
    expect(us.nextUsCheckAt(monday - 3600_000, null)).toBe(Date.parse("2026-10-05T19:45:00Z"));
    expect(us.nextUsCheckAt(monday, "2026-10-05")).toBe(Date.parse("2026-10-06T19:45:00Z"));
    expect(us.nextUsCheckAt(monday + 4 * DAY, "2026-10-09")).toBe(Date.parse("2026-10-12T19:45:00Z"));
    // Winter: 20:45 UTC.
    expect(us.nextUsCheckAt(Date.parse("2026-12-07T12:00:00Z"), null)).toBe(Date.parse("2026-12-07T20:45:00Z"));
    expect(us.usBreakoutStocks(2026)).toContain("BRK.B.US");
  });
});

describe("a paper desk's free cash", () => {
  it("is all the server's autopilot spends: a trade that costs more than is left waits", async () => {
    const us = await fresh();
    // ₹6,000 of paper money: one ₹200-risk US trade (about ₹4,900) fits, the second doesn't.
    const poor = { ...desk, equity: 6000 };
    await us.runUsBreakout(await deps(monday, { desks: () => [["u", poor]] }));
    const picks = us._usBreakoutState().runs.u.picks;
    expect(picks.filter((p) => p.outcome === "opened")).toHaveLength(1);
    expect(picks.find((p) => p.outcome === "waiting")?.reason).toMatch(/^not enough free cash: ₹\d[\d,]* left for a ₹[\d,]+ trade with its fee$/);
  });
});

describe("funds breakout trades (gold, bonds and the rest)", () => {
  beforeEach(async () => {
    await fresh();
  });

  /** US limits with one breakout slot for stocks and two for the funds. */
  const narrow = {
    ...desk,
    riskLimits: {
      ...desk.riskLimits,
      marketLimits: { ...desk.riskLimits.marketLimits, us: { amountPerTradeInr: 20000, maxOpenTrades: 3, riskPerTradeInr: 200, breakoutTrades: 1, fundsTrades: 2 } },
    },
  };
  const funds = { "2020-Q1": { breakout: rec(443, 443 * 0.54) } };

  it("buy the funds above their 55-day high right after the US check, on slots of their own, and sell them below their 20-day low", async () => {
    const us = await fresh();
    const { daemonPositions } = await import("../../server/guardian");
    const { slotKindOf } = await import("../../src/shared/marketLimits");
    const prices: Record<string, number> = { "AAPL.US": 105, "BRK.B.US": 104, "GLD.US": 105, "TLT.US": 104, "SLV.US": 103 };
    const at = async (now: number, classic: unknown, over: Record<string, number> = {}) =>
      deps(now, {
        desks: () => [["u", narrow]],
        classic: () => classic,
        quotes: vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, quote({ ...prices, ...over }[s] ?? 100)]))),
      });

    // US stocks: one breakout slot, so one of AAPL and Berkshire.
    await us.runUsBreakout(await at(monday, { "2020-Q1": { breakout: rec(554, 554 * 0.39) } }));
    expect(us._usBreakoutState().runs.u.picks.filter((p) => p.outcome === "opened")).toHaveLength(1);
    // The funds: their own two slots, whatever US stocks hold, filled in the list's order; the third waits.
    const d = await at(monday, funds);
    await us.runFundsBreakout(d);
    const run = us._fundsBreakoutState().runs.u;
    expect(run).toMatchObject({ day: "2026-10-05", coins: 16, failed: [] });
    expect(d.quotes.mock.calls[0][0]).toEqual(us.breakoutFunds());
    expect(run.picks.filter((p) => p.outcome === "opened").map((p) => p.symbol).sort()).toEqual(["GLD.US", "SLV.US"]);
    expect(run.picks.find((p) => p.symbol === "TLT.US")).toMatchObject({ outcome: "waiting", reason: expect.stringContaining("would exceed 2 open funds breakout trades at once") });
    const fundTrades = [...daemonPositions.values()].filter((p) => p.symbol === "GLD.US" || p.symbol === "SLV.US");
    expect(fundTrades.every((p) => p.strategy === "breakout" && p.trailProfile === "fixed" && slotKindOf(p) === "funds")).toBe(true);
    expect([...daemonPositions.values()].filter((p) => slotKindOf(p) === "breakout")).toHaveLength(1);

    // Tuesday: gold falls below its 20-day low. The US check leaves the funds alone; the funds' check sells it.
    await us.runUsBreakout(await at(tuesday, { "2020-Q1": { breakout: rec(554, 554 * 0.39) } }, { "GLD.US": 90, "AAPL.US": 100, "BRK.B.US": 100 }));
    expect(us._usBreakoutState().runs.u.picks.some((p) => p.symbol === "GLD.US")).toBe(false);
    expect([...daemonPositions.values()].some((p) => p.symbol === "GLD.US")).toBe(true);
    await us.runFundsBreakout(await at(tuesday, funds, { "GLD.US": 90, "TLT.US": 100, "SLV.US": 100 }));
    expect(us._fundsBreakoutState().runs.u.picks).toContainEqual({ symbol: "GLD.US", trader: "Breakout 55/20", outcome: "sold", reason: "closed below its 20-day low" });
    expect([...daemonPositions.values()].some((p) => p.symbol === "GLD.US")).toBe(false);
    expect([...daemonPositions.values()].some((p) => p.symbol === "SLV.US")).toBe(true);
  });

  it("trade only while the funds' own record since 2016 clears the bar", async () => {
    const us = await fresh();
    await us.runFundsBreakout(
      await deps(monday, {
        classic: () => ({ "2020-Q1": { breakout: rec(443, -20) } }),
        quotes: vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, quote(s === "GLD.US" ? 105 : 100)]))),
      })
    );
    expect(us._fundsBreakoutState().runs.u.picks).toEqual([
      { symbol: "GLD.US", trader: "Breakout 55/20", outcome: "paused", reason: "record since 2016 −0.045R (needs +0.05R)" },
    ]);
  });
});
