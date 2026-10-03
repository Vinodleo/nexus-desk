import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { holdMinutesFor } from "../../src/shared/coinHolds";
import { tradeOpenedMessage } from "../../src/shared/tradeMessages";

// Momentum, top 3, on US stocks (paper): on each week's last US session at
// 3:45 pm New York, this year's biggest US stocks that rose most over 90
// sessions are held (the top 3, while SPY is above its 200-day average);
// those leaving the top 3 are sold. Held overnight, in fractions of a share,
// within the US limits, on momentum's own slots.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-us-momentum-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const RATE = 88;
// Friday 9 October 2026, 3:46 pm New York (summer time: 19:46 UTC), and the next Friday.
const friday = Date.parse("2026-10-09T19:46:00Z");
const nextFriday = friday + 7 * DAY;
const monday = friday - 4 * DAY;
const nyMidnight = (ms: number) => Date.parse(new Date(ms).toISOString().slice(0, 10) + "T04:00:00Z");
/** The US calendar: every weekday a session, but those listed as holidays. */
const calendar = (holidays: string[] = []) =>
  vi.fn(async (from: string, to: string) => {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      const wd = new Date(t).getUTCDay();
      if (wd !== 0 && wd !== 6 && !holidays.includes(day)) out.push(day);
    }
    return out;
  });

/** Weekday sessions before `now`'s day, the last `n`, by their New York midnight. */
function sessionsBefore(now: number, n: number): number[] {
  const out: number[] = [];
  for (let t = nyMidnight(now) - DAY; out.length < n; t -= DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(t);
  }
  return out;
}

/**
 * A stock that rose by `rise` over the last 90 sessions, steadily, to $100
 * today: its completed sessions (each 2% from low to high) and today's
 * price. `n` completed sessions.
 */
function climb(now: number, rise: number, n = 130): { rows: unknown[][]; today: number } {
  const step = Math.pow(1 + rise, 1 / 90);
  const closes = Array.from({ length: n + 1 }, (_, k) => 100 / Math.pow(step, n - k));
  const rows = sessionsBefore(now, n).map((t, k) => [t, closes[Math.max(0, k - 1)], closes[k] * 1.01, closes[k] * 0.99, closes[k], 1000]);
  return { rows, today: closes[n] };
}

const quote = (usd: number) => ({ price: usd * RATE, bid: (usd - 0.05) * RATE, ask: (usd + 0.05) * RATE });
const rec = (trades: number, totalR: number) => ({ trades, totalR, wins: Math.round(trades * 0.53), winR: totalR + trades, lossR: -trades });

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
  quarantines: {}, promotedModel: null, updatedAt: friday,
};

async function fresh() {
  const us = await import("../../server/scanner/usMomentum");
  us._resetUsMomentum();
  (await import("../../server/guardian"))._resetGuardian();
  (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
  return us;
}

/** This week: NVDA rose 40% over 90 sessions, Eli Lilly 30%, JPMorgan 20%, Apple 10%; the rest are flat. SPY rose 20% over a year. */
const WEEK1: Record<string, number> = { "NVDA.US": 0.4, "LLY.US": 0.3, "JPM.US": 0.2, "AAPL.US": 0.1 };

async function deps(now: number, rises: Record<string, number> = WEEK1, over: Record<string, unknown> = {}) {
  const { runServerAutopilot } = await import("../../server/scanner/autopilot");
  const guardian = await import("../../server/guardian");
  const spyRise = (over.spyRise as number | undefined) ?? 0.2;
  const of = (symbol: string) => (symbol === "SPY.US" ? climb(now, spyRise * (90 / 250), 250) : climb(now, rises[symbol] ?? 0));
  return {
    now: () => now,
    sleep: async () => {},
    // Alpaca's partial candle for today rides along; the check sets today at the price now.
    daily: vi.fn(async (symbol: string) => [...of(symbol).rows, [nyMidnight(now), 100, 100, 100, 100, 1]]),
    quotes: vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, quote(of(s).today)]))),
    rate: () => RATE,
    sessions: calendar(),
    classic: () => ({ "2020-Q1": { momentum: rec(341, 341 * 0.26) } }),
    desks: () => [["u", desk]] as [string, typeof desk][],
    dailyPnl: () => 0,
    open: vi.fn(runServerAutopilot),
    positions: () => [...guardian.daemonPositions.values()],
    close: (id: string, price: number) => guardian.closeServerPosition(id, price, "TRAILING_STOP"),
    busy: () => false,
    ...over,
  };
}

const held = async () => {
  const { daemonPositions } = await import("../../server/guardian");
  return [...daemonPositions.values()].map((p) => p.symbol).sort();
};

describe("US momentum trades", () => {
  beforeEach(async () => {
    await fresh();
  });

  it("buy the week's top 3 by their 90-session rise at 3:45 New York on Friday: the stop 3 ATR below, fractions of a share, its own slots", async () => {
    const us = await fresh();
    const { daemonPositions } = await import("../../server/guardian");
    await us.runUsMomentum(await deps(friday));
    // Apple rose too, but less: fourth.
    expect(await held()).toEqual(["JPM.US", "LLY.US", "NVDA.US"]);
    const nvda = [...daemonPositions.values()].find((p) => p.symbol === "NVDA.US")!;
    expect(nvda).toMatchObject({ setupName: "Momentum, top 3", strategy: "momentum", timeframe: "1d", trailProfile: "fixed", entryPrice: 100.05 * RATE });
    // No time limit in the replay: a year, as breakout's (not the daily traders' 30 days).
    expect(nvda.expectedHoldingTimeMinutes).toBe(holdMinutesFor({ strategy: "breakout" }));
    expect(nvda.expectedHoldingTimeMinutes).toBe(365 * 24 * 60);
    expect(tradeOpenedMessage(nvda, "server")).toMatchObject({ title: "Bought NVDA.US (momentum, paper)", body: expect.stringContaining("no target") });
    expect(nvda.partialQuantity).toBeUndefined();
    // Each session spans about 2% of the price: the stop 3 ATR (about 6%) below.
    expect(1 - nvda.stopLoss / nvda.entryPrice).toBeCloseTo(0.06, 2);
    // Sized to the US limits: ₹200 at the stop, in fractions of a share.
    expect((nvda.entryPrice - nvda.stopLoss) * nvda.quantity).toBeLessThanOrEqual(200.01);
    expect((nvda.entryPrice - nvda.stopLoss) * nvda.quantity).toBeGreaterThan(190);
    expect(nvda.quantity % 1).not.toBe(0);
    const run = us._usMomentumState().runs.u as import("../../server/scanner/usMomentum").MomentumRun;
    expect(run).toMatchObject({ day: "2026-10-09", coins: 21, failed: [], marketUp: true });
    expect(run.top.map((t) => [t.symbol, Number(t.rise.toFixed(2))])).toEqual([["NVDA.US", 0.4], ["LLY.US", 0.3], ["JPM.US", 0.2]]);
    expect(run.picks.map((p) => [p.symbol, p.outcome])).toEqual([["NVDA.US", "opened"], ["LLY.US", "opened"], ["JPM.US", "opened"]]);
    // Once a week.
    const again = await deps(friday + 60_000);
    await us.runUsMomentum(again);
    expect(again.quotes).not.toHaveBeenCalled();
  });

  it("check on the week's last session only: Friday, or Thursday before a Friday holiday; Friday when the calendar can't be read", async () => {
    let us = await fresh();
    const mon = await deps(monday);
    await us.runUsMomentum(mon);
    expect(mon.sessions).toHaveBeenCalledTimes(1);
    expect(mon.quotes).not.toHaveBeenCalled();
    // Monday is done with: not asked again that day.
    await us.runUsMomentum(mon);
    expect(mon.sessions).toHaveBeenCalledTimes(1);

    // Friday 9 October a holiday: Thursday is the week's last session, and Friday has none.
    us = await fresh();
    const thursday = await deps(friday - DAY, WEEK1, { sessions: calendar(["2026-10-09"]) });
    await us.runUsMomentum(thursday);
    expect(await held()).toEqual(["JPM.US", "LLY.US", "NVDA.US"]);
    us = await fresh();
    const holiday = await deps(friday, WEEK1, { sessions: calendar(["2026-10-09"]) });
    await us.runUsMomentum(holiday);
    expect(holiday.quotes).not.toHaveBeenCalled();

    us = await fresh();
    const noCalendar = vi.fn(async () => Promise.reject(new Error("Alpaca: service unavailable")));
    const tue = await deps(monday + DAY, WEEK1, { sessions: noCalendar });
    await us.runUsMomentum(tue);
    expect(tue.quotes).not.toHaveBeenCalled();
    const fri = await deps(friday, WEEK1, { sessions: noCalendar });
    await us.runUsMomentum(fri);
    expect(await held()).toEqual(["JPM.US", "LLY.US", "NVDA.US"]);

    // From 3:45 to 3:50 New York only; and after US breakout's check, not alongside it.
    for (const over of [{ now: () => friday - 2 * 60_000 }, { now: () => friday + 4 * 60_000 }, { busy: () => true }]) {
      us = await fresh();
      const d = await deps(friday, WEEK1, over);
      await us.runUsMomentum(d);
      expect(d.sessions).not.toHaveBeenCalled();
    }
  });

  it("next week, sell those out of the top 3 at the bid, keep those still in it, and buy the new one", async () => {
    const us = await fresh();
    const { closedTradesFor } = await import("../../server/guardian");
    await us.runUsMomentum(await deps(friday));
    // Eli Lilly fell back; Apple rose most.
    await us.runUsMomentum(await deps(nextFriday, { "AAPL.US": 0.5, "NVDA.US": 0.35, "JPM.US": 0.25, "LLY.US": -0.05 }));
    expect(await held()).toEqual(["AAPL.US", "JPM.US", "NVDA.US"]);
    const [closed] = closedTradesFor("u");
    expect(closed).toMatchObject({ symbol: "LLY.US", exitPrice: 99.95 * RATE, exitReason: "TRAILING_STOP", strategy: "momentum" });
    expect(us._usMomentumState().runs.u.picks).toEqual([
      { symbol: "AAPL.US", trader: "Momentum, top 3", outcome: "opened" },
      { symbol: "LLY.US", trader: "Momentum, top 3", outcome: "sold", reason: "out of the top 3" },
      { symbol: "NVDA.US", trader: "Momentum, top 3", outcome: "kept", reason: "still in the top 3 (+35% over 90 sessions)" },
      { symbol: "JPM.US", trader: "Momentum, top 3", outcome: "kept", reason: "still in the top 3 (+25% over 90 sessions)" },
    ]);
  });

  it("sell even with autopilot off (an open trade keeps its exit), and sell everything when SPY falls below its 200-day", async () => {
    let us = await fresh();
    await us.runUsMomentum(await deps(friday));
    await us.runUsMomentum(await deps(nextFriday, { "AAPL.US": 0.5, "NVDA.US": 0.35, "JPM.US": 0.25 }, { desks: () => [["u", { ...desk, autopilot: false }]] }));
    expect(await held()).toEqual(["JPM.US", "NVDA.US"]);
    expect(us._usMomentumState().runs.u.picks.map((p) => [p.symbol, p.outcome])).toEqual([
      ["LLY.US", "sold"],
      ["NVDA.US", "kept"],
      ["JPM.US", "kept"],
      ["AAPL.US", "waiting"],
    ]);
    expect(us._usMomentumState().runs.u.note).toBe("Autopilot is off, so no daily trades were opened.");

    us = await fresh();
    await us.runUsMomentum(await deps(friday));
    // SPY fell 20% over the year: below its 200-day average.
    await us.runUsMomentum(await deps(nextFriday, WEEK1, { spyRise: -0.2 }));
    expect(await held()).toEqual([]);
    const run = us._usMomentumState().runs.u as import("../../server/scanner/usMomentum").MomentumRun;
    expect(run).toMatchObject({ marketUp: false, top: [] });
    expect(run.picks.every((p) => p.outcome === "sold" && p.reason === "SPY is below its 200-day average")).toBe(true);
  });

  it("trade only while the US record since 2016 is positive", async () => {
    for (const [classic, reason] of [
      [() => null, "no record since 2016"],
      [() => ({ "2020-Q1": { momentum: rec(341, -20) } }), "record since 2016 −0.06R (needs +0.05R)"],
    ] as const) {
      const us = await fresh();
      await us.runUsMomentum(await deps(friday, WEEK1, { classic }));
      expect(await held()).toEqual([]);
      expect(us._usMomentumState().runs.u.picks[0]).toEqual({ symbol: "NVDA.US", trader: "Momentum, top 3", outcome: "paused", reason });
    }
  });

  it("leave a pick another strategy holds (one trade per stock), and try again a minute later when prices or SPY can't be read", async () => {
    let us = await fresh();
    const guardian = await import("../../server/guardian");
    // US breakout holds NVDA already.
    guardian.daemonPositions.set("b1", { id: "b1", userId: "u", symbol: "NVDA.US", direction: "LONG", entryPrice: 8000, stopLoss: 7500, takeProfit: 8e6, quantity: 0.1, strategy: "breakout", openTime: new Date(friday - DAY).toISOString() } as never);
    await us.runUsMomentum(await deps(friday));
    expect(await held()).toEqual(["JPM.US", "LLY.US", "NVDA.US"]);
    const nvda = us._usMomentumState().runs.u.picks.find((p) => p.symbol === "NVDA.US")!;
    expect(nvda).toMatchObject({ outcome: "waiting", reason: expect.stringContaining("already holding a NVDA.US position") });

    us = await fresh();
    const down = await deps(friday, WEEK1, { quotes: vi.fn(async () => Promise.reject(new Error("Alpaca: service unavailable"))) });
    await us.runUsMomentum(down);
    expect(us._usMomentumState().lastDay).toBeNull();
    const noSpy = await deps(friday + 60_000);
    noSpy.daily = vi.fn(async (symbol: string) => (symbol === "SPY.US" ? Promise.reject(new Error("no bars")) : (await deps(friday)).daily(symbol)));
    await us.runUsMomentum(noSpy);
    expect(us._usMomentumState().lastDay).toBeNull();
    expect(us._usMomentumState().runs.u.note).toContain("Couldn't read SPY's daily candles");
    expect(await held()).toEqual([]);
    await us.runUsMomentum(await deps(friday + 2 * 60_000));
    expect(await held()).toEqual(["JPM.US", "LLY.US", "NVDA.US"]);
  });

  it("know the week's last session, and say when the next check is: 3:45 pm New York on Friday, summer or winter", async () => {
    const us = await fresh();
    const week = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"];
    expect(us.weekLastSession("2026-10-09", week)).toBe(true);
    expect(us.weekLastSession("2026-10-08", week)).toBe(false);
    expect(us.weekLastSession("2026-10-08", week.filter((d) => d !== "2026-10-09"))).toBe(true);
    expect(us.weekLastSession("2026-10-09", week.filter((d) => d !== "2026-10-09"))).toBe(false);
    expect(us.weekLastSession("2026-10-09", null)).toBe(true);
    expect(us.weekLastSession("2026-10-08", null)).toBe(false);

    expect(us.nextMomentumCheckAt(monday, null)).toBe(Date.parse("2026-10-09T19:45:00Z"));
    expect(us.nextMomentumCheckAt(friday, "2026-10-09")).toBe(Date.parse("2026-10-16T19:45:00Z"));
    // Winter: 20:45 UTC.
    expect(us.nextMomentumCheckAt(Date.parse("2026-12-07T12:00:00Z"), null)).toBe(Date.parse("2026-12-11T20:45:00Z"));
  });
});
