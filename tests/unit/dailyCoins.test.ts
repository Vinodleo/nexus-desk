import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketBar, StrategySetup, TradeProposal } from "../../src/types";
import { appendBars, emptySeries, latestSlowSetups, SPACING_LOOKBACK_BARS, TIMEFRAME_RULES, HISTORY_VIEW_BARS, type CandleSeries } from "../../src/services/historyReplay";
import { panelSetupsOnHistory } from "../../src/services/labSimulation";
import { decorateBarsWithIndicators } from "../../src/services/marketDataService";
import { holdingDecision } from "../../src/shared/exitRules";
import { BREAKOUT_HOLD_MINUTES, DAILY_HOLD_MINUTES, holdMinutesFor } from "../../src/shared/coinHolds";
import { positionFromProposal } from "../../src/services/autopilot";
import { seeded } from "../../src/services/setupModel";
import { tradeOpenedMessage } from "../../src/shared/tradeMessages";
import { realByTrader } from "../../src/components/ledger/LedgerBreakdown";

// Coin trades on daily candles (paper): once a day after the daily close, the
// setups the two-year replay would take, opened by the server autopilot for
// traders whose daily record is positive, held up to 30 days.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-daily-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;

/** `count` daily candles of a lively coin trending up, the last one starting at `lastDayMs`. */
function dailySeries(count: number, lastDayMs: number, seed: number): CandleSeries {
  const random = seeded(seed);
  let p = 100;
  const bars: MarketBar[] = Array.from({ length: count }, (_, k) => {
    const o = p;
    p *= 1 + 0.004 + (random() - 0.5) * 0.06;
    return { time: "", timestampMs: lastDayMs - (count - 1 - k) * DAY, open: o, high: Math.max(o, p) * 1.02, low: Math.min(o, p) * 0.98, close: p, volume: 1000 + random() * 3000 };
  });
  const s = emptySeries();
  appendBars(s, bars);
  return s;
}
const head = (s: CandleSeries, n: number): CandleSeries => ({ t: s.t.slice(0, n), o: s.o.slice(0, n), h: s.h.slice(0, n), l: s.l.slice(0, n), c: s.c.slice(0, n), v: s.v.slice(0, n) });

describe("daily trades' exits", () => {
  it("close a daily trade at 30 days exactly, where a shorter trade that locked in profit runs on", () => {
    const openMs = Date.parse("2026-10-03T00:15:00Z");
    // The stop already locks in profit.
    const p = { symbol: "SOL/INR", direction: "LONG" as const, entryPrice: 100, stopLoss: 101, quantity: 1, openTime: new Date(openMs).toISOString(), expectedHoldingTimeMinutes: DAILY_HOLD_MINUTES };
    const at = (days: number) => openMs + days * DAY;
    expect(DAILY_HOLD_MINUTES).toBe(30 * 24 * 60);
    expect(holdingDecision({ ...p, timeframe: "1d" }, at(30) - MIN)).toBe("hold");
    expect(holdingDecision({ ...p, timeframe: "1d" }, at(30) + MIN)).toBe("expire");
    // Without the daily mark, a winner may run to three times its limit.
    expect(holdingDecision(p, at(30) + MIN)).toBe("hold");
  });

  it("opens a daily position held 30 days, trailed as a runner, and says so when it pops up", () => {
    const setup = { name: "Amara Confirmed Breakout", family: "breakout_confirmation", direction: "LONG", symbol: "SOL/INR", timeframe: "1d", entryPrice: 100, stopLoss: 92, takeProfit: 116, planAtr: 5, features: {} } as unknown as StrategySetup;
    const proposal = { symbol: "SOL/INR", setup, metaScore: { confidence: 0.55 } } as unknown as TradeProposal;
    const position = positionFromProposal({ proposal, entryPrice: 100, units: 0.5 }, { id: "pos-1", atr: 5, trailProfile: "tight", now: 0 });
    expect(position).toMatchObject({ timeframe: "1d", expectedHoldingTimeMinutes: DAILY_HOLD_MINUTES, trailMode: "TREND_RUNNER", atrAtEntry: 5 });
    expect(tradeOpenedMessage({ ...position, id: "pos-1" }, "server").title).toBe("Bought SOL/INR (daily, paper)");
  });
});

describe("the setups at the day's close", () => {
  it("are the ones the replay takes at that candle, entered at its close", () => {
    const series = dailySeries(320, Date.parse("2026-10-02T00:00:00Z"), 4);
    const rules = TIMEFRAME_RULES["1d"];
    const bars = decorateBarsWithIndicators(
      series.t.map((t, k) => ({ time: "", timestampMs: t, open: series.o[k], high: series.h[k], low: series.l[k], close: series.c[k], volume: series.v[k] }))
    );
    for (const b of bars) b.atrHour = b.atr;
    // The replay over the same candles, from its warm-up.
    const replay = panelSetupsOnHistory("ETH/INR", bars, undefined, {
      from: rules.warmupBars,
      view: HISTORY_VIEW_BARS,
      intervalMs: rules.intervalMs,
      higherMs: rules.higherMs,
      anyTime: true,
    }).filter((f) => f.i <= rules.warmupBars + SPACING_LOOKBACK_BARS);
    expect(replay.length).toBeGreaterThan(0);
    const shape = (s: StrategySetup) => [s.name, s.entryPrice, s.stopLoss, s.takeProfit];
    for (const { i, setups } of replay) {
      // Live, the day of candle i has just closed: the candles up to it.
      const live = latestSlowSetups("ETH/INR", head(series, i + 1), "1d", 0)!;
      expect(live.setups.map(shape)).toEqual(setups.map(shape));
      for (const s of live.setups) expect(s.entryPrice).toBe(series.c[i]);
    }
    // A candle the replay found nothing at: nothing live either.
    const quiet = Array.from({ length: SPACING_LOOKBACK_BARS }, (_, k) => rules.warmupBars + k).find((i) => !replay.some((f) => f.i === i))!;
    expect(latestSlowSetups("ETH/INR", head(series, quiet + 1), "1d", 0)!.setups).toEqual([]);
  });
});

describe("the daily scan", () => {
  const now = Date.parse("2026-10-03T00:15:00Z");
  const yesterday = Date.parse("2026-10-02T00:00:00Z");
  const desk = {
    equity: 100000, riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 1 }, dailyRealizedPnl: 0, pnlDay: "",
    autopilot: true, tradingMode: "PAPER" as const, trailProfile: "tight", killSwitch: false, scanning: true,
    failureState: {
      simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
      simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
    },
    quarantines: {}, promotedModel: null, updatedAt: now,
  };
  /** A coin whose last daily candle has setups. */
  const withSetups = (() => {
    for (let seed = 1; seed < 200; seed++) {
      const series = dailySeries(400, yesterday, seed);
      const at = latestSlowSetups("SOL/INR", series, "1d", 0.002, 0.001);
      if (at && at.setups.length > 0) return { series, setups: at.setups };
    }
    throw new Error("no seed gives a setup");
  })();
  const rec = (trades: number, totalR: number) => ({ trades, totalR, wins: Math.round(trades / 2), winR: Math.max(totalR, 0) + trades / 4, lossR: Math.min(totalR, 0) - trades / 4 });
  const trader = withSetups.setups[0].name;

  async function fresh() {
    const daily = await import("../../server/scanner/dailyCoins");
    daily._resetDailyCoins();
    (await import("../../server/guardian"))._resetGuardian();
    (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
    return daily;
  }
  async function deps(over: Record<string, unknown> = {}) {
    const { runServerAutopilot } = await import("../../server/scanner/autopilot");
    return {
      now: () => now,
      sleep: async () => {},
      coins: async () => ["SOL/INR", "OLD/INR"],
      // OLD/INR's candles stop the day before: not traded on a stale candle.
      daily: async (symbol: string) => ({ series: symbol === "SOL/INR" ? withSetups.series : dailySeries(400, yesterday - DAY, 1) }),
      quote: async () => ({ bid: 9990, ask: 10000 }),
      spread: () => 0.001,
      records: () => ({ span: "since 2017", records: { tight: { "2026-Q3": { [`crypto:${trader}`]: rec(20, 4), "crypto:Kenji Extreme Reversion": rec(8, 2) } } } }),
      desks: () => [["u", desk]] as [string, typeof desk][],
      dailyPnl: () => 0,
      open: vi.fn(runServerAutopilot),
      ...over,
    };
  }

  beforeEach(async () => {
    await fresh();
  });

  it("opens the day's setups as paper trades for traders with a positive daily record, priced in rupees on CoinDCX", async () => {
    const daily = await fresh();
    const { daemonPositions } = await import("../../server/guardian");
    const d = await deps();
    await daily.runDailyCoins(d);
    const positions = [...daemonPositions.values()];
    expect(positions.length).toBe(1);
    const [p] = positions;
    const setup = withSetups.setups[0];
    expect(p).toMatchObject({ symbol: "SOL/INR", setupName: trader, timeframe: "1d", expectedHoldingTimeMinutes: DAILY_HOLD_MINUTES, openedByServer: true, entryPrice: 10000 });
    // The stop and the trailing ATR the same share of the price away as on Binance's chart.
    expect(p.stopLoss / p.entryPrice).toBeCloseTo(setup.stopLoss / setup.entryPrice, 4);
    expect(p.atrAtEntry! / p.entryPrice).toBeCloseTo(Math.max(setup.planAtr! / setup.entryPrice, 0.003), 6);
    // Sized to the coin limits: ₹50 lost at the stop, at most ₹5,000 in.
    expect((p.entryPrice - p.stopLoss) * p.quantity).toBeLessThanOrEqual(50.01);
    expect(p.entryPrice * p.quantity).toBeLessThanOrEqual(5000);
    // Each trader alone: no panel vote needed.
    const policy = vi.mocked(d.open).mock.calls[0][3];
    expect(policy).toMatchObject({ autopilotMinConsensus: 0, autopilotMinPersonaVotes: 1 });

    const run = daily._dailyCoinsState().runs.u;
    expect(run).toMatchObject({ day: "2026-10-03", coins: 2, failed: ["OLD/INR"] });
    expect(run.picks[0]).toEqual({ symbol: "SOL/INR", trader, outcome: "opened" });
    // Other traders at that candle have no daily record: paused.
    for (const pick of run.picks.slice(1)) expect(pick).toMatchObject({ outcome: "paused", reason: "no daily record since 2017" });

    // Once a day: a second check the same day does nothing.
    await daily.runDailyCoins(d);
    expect(d.open).toHaveBeenCalledTimes(1);
    expect(daemonPositions.size).toBe(1);
  });

  it("checks only in the hours after the daily close", async () => {
    const daily = await fresh();
    const early = await deps({ now: () => Date.parse("2026-10-03T00:05:00Z") });
    await daily.runDailyCoins(early);
    expect(early.open).not.toHaveBeenCalled();
    // The server was down until 7 am UTC: the day is skipped, not traded late.
    const late = await deps({ now: () => Date.parse("2026-10-03T07:00:00Z") });
    await daily.runDailyCoins(late);
    expect(late.open).not.toHaveBeenCalled();
    expect(daily._dailyCoinsState().runs).toEqual({});
  });

  it("leaves paused traders paused, and opens nothing for a desk in live mode or with autopilot off", async () => {
    let daily = await fresh();
    const paused = await deps({ records: () => ({ span: "since 2017", records: { tight: { "2026-Q3": { [`crypto:${trader}`]: rec(9, 3) } } } }) });
    await daily.runDailyCoins(paused);
    expect(paused.open).not.toHaveBeenCalled();
    expect(daily._dailyCoinsState().runs.u.picks[0]).toEqual({ symbol: "SOL/INR", trader, outcome: "paused", reason: "only 9 replayed setups (needs 10)" });

    daily = await fresh();
    const losing = await deps({ records: () => ({ span: "since 2017", records: { tight: { "2026-Q3": { [`crypto:${trader}`]: rec(40, -2) } } } }) });
    await daily.runDailyCoins(losing);
    expect(daily._dailyCoinsState().runs.u.picks[0].reason).toBe("daily record since 2017 −0.05R (needs +0.05R)");

    for (const [over, note] of [
      [{ tradingMode: "LIVE_COINDCX" }, "Your desk is in live mode; daily trades are paper only for now."],
      [{ autopilot: false }, "Autopilot is off, so no daily trades were opened."],
    ] as const) {
      daily = await fresh();
      const d = await deps({ desks: () => [["u", { ...desk, ...over }]] });
      await daily.runDailyCoins(d);
      expect(d.open).not.toHaveBeenCalled();
      const run = daily._dailyCoinsState().runs.u;
      expect(run.note).toBe(note);
      expect(run.picks[0]).toEqual({ symbol: "SOL/INR", trader, outcome: "waiting", reason: note });
    }
  });

  it("judges each trader on its daily coin record with your trailing stop", async () => {
    const { dailyTraderGates } = await fresh();
    const records = {
      tight: {
        "2025-Q4": { "crypto:Sofia Range Scalp": rec(6, 1.2), "us:Sofia Range Scalp": rec(50, 10) },
        "2026-Q1": { "crypto:Sofia Range Scalp": rec(6, 1.2), "crypto:Priya Momentum Scalp": rec(30, 1.2) },
      },
      patient: { "2026-Q1": { "crypto:Priya Momentum Scalp": rec(30, 3) } },
    };
    // Sofia: 12 setups at +0.20R; Priya: +0.04R, under the +0.05R a trader needs. US records don't count.
    expect(dailyTraderGates(records, "tight")).toEqual([
      { trader: "Sofia Range Scalp", trades: 12, avgR: expect.closeTo(0.2, 9), on: true },
      { trader: "Priya Momentum Scalp", trades: 30, avgR: expect.closeTo(0.04, 9), on: false },
    ]);
    expect(dailyTraderGates(records, "patient")).toEqual([{ trader: "Priya Momentum Scalp", trades: 30, avgR: expect.closeTo(0.1, 9), on: true }]);
    expect(dailyTraderGates(null, "tight")).toEqual([]);
  });
});

describe("breakout 55/20 paper trades", () => {
  const day1 = Date.parse("2026-10-03T00:15:00Z");
  const day2 = day1 + DAY;
  const desk = {
    equity: 100000, riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 1 }, dailyRealizedPnl: 0, pnlDay: "",
    autopilot: true, tradingMode: "PAPER" as const, trailProfile: "tight", killSwitch: false, scanning: true,
    failureState: {
      simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
      simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
    },
    quarantines: {}, promotedModel: null, updatedAt: day2,
  };
  type Row = [number, number, number, number];
  /** Daily candles [open, high, low, close], the last one starting the day before `now`. */
  const candles = (rows: Row[], now: number) => {
    const last = Math.floor(now / DAY) * DAY - DAY;
    const s = emptySeries();
    appendBars(s, rows.map(([open, high, low, close], k) => ({ time: "", timestampMs: last - (rows.length - 1 - k) * DAY, open, high, low, close, volume: 1 })));
    return s;
  };
  // 80 quiet days, then a close above the 55-day high (ATR 2.2 by then: a stop 4.4 below 105).
  const quiet: Row[] = Array.from({ length: 80 }, () => [100, 101, 99, 100]);
  const breakout: Row[] = [...quiet, [100, 106, 100, 105]];
  const rec = (trades: number, totalR: number) => ({ trades, totalR, wins: Math.round(trades / 4), winR: Math.max(totalR, 0) + trades / 4, lossR: Math.min(totalR, 0) - trades / 4 });
  // Its record since 2018: +0.98R over 476 trades.
  const record = { "2020-Q4": { breakout: rec(300, 400) }, "2022-Q2": { breakout: rec(176, 66.48), maTrend: rec(5, -50) } };

  async function fresh() {
    const daily = await import("../../server/scanner/dailyCoins");
    daily._resetDailyCoins();
    (await import("../../server/guardian"))._resetGuardian();
    (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
    return daily;
  }
  async function deps(now: number, rows: Row[], over: Record<string, unknown> = {}) {
    const { runServerAutopilot } = await import("../../server/scanner/autopilot");
    return {
      now: () => now,
      sleep: async () => {},
      coins: async () => ["SOL/INR"],
      daily: async () => ({ series: candles(rows, now) }),
      quote: async () => ({ bid: 9990, ask: 10000 }),
      spread: () => 0.001,
      records: () => null,
      desks: () => [["u", desk]] as [string, typeof desk][],
      dailyPnl: () => 0,
      open: vi.fn(runServerAutopilot),
      classic: () => record,
      ...over,
    };
  }

  beforeEach(async () => {
    await fresh();
  });

  it("buys a close above the 55-day high on this year's biggest coins: a stop 2 ATR below, no target, no trailing, nothing banked", async () => {
    const daily = await fresh();
    const { daemonPositions } = await import("../../server/guardian");
    await daily.runDailyCoins(await deps(day1, breakout));
    const [p, ...others] = [...daemonPositions.values()];
    expect(others).toEqual([]);
    expect(p).toMatchObject({
      symbol: "SOL/INR",
      setupName: "Breakout 55/20",
      strategy: "breakout",
      timeframe: "1d",
      trailProfile: "fixed",
      expectedHoldingTimeMinutes: BREAKOUT_HOLD_MINUTES,
      entryPrice: 10000,
      openedByServer: true,
    });
    expect(p.partialQuantity).toBeUndefined();
    // The stop the same share below as on Binance's chart: 4.4 below 105.
    expect(p.stopLoss / p.entryPrice).toBeCloseTo(100.6 / 105, 4);
    expect(p.takeProfit).toBeGreaterThan(p.entryPrice * 100);
    // Sized to the coin limits like any coin trade: ₹50 lost at the stop.
    expect((p.entryPrice - p.stopLoss) * p.quantity).toBeLessThanOrEqual(50.01);
    expect(daily._dailyCoinsState().runs.u.picks).toEqual([{ symbol: "SOL/INR", trader: "Breakout 55/20", outcome: "opened" }]);
    expect(tradeOpenedMessage(p, "server")).toMatchObject({ title: "Bought SOL/INR (breakout, paper)", body: expect.stringContaining("no target") });

    // The guardian keeps its first stop: at +3R nothing trails and nothing is banked.
    const { evaluateDaemonPositions } = await import("../../server/guardian");
    const stop = p.stopLoss;
    evaluateDaemonPositions("SOL/INR", p.entryPrice + 3 * (p.entryPrice - stop));
    expect(daemonPositions.get(p.id)!.stopLoss).toBe(stop);
    expect(daemonPositions.get(p.id)!.bankedQuantity).toBeUndefined();
    // A year to run, where a daily trader's has 30 days.
    expect(holdMinutesFor({ symbol: "SOL/INR", timeframe: "1d", strategy: "breakout" })).toBe(365 * 24 * 60);
    expect(holdingDecision(p, day1 + 31 * DAY)).toBe("hold");
  });

  it("buys only this year's biggest coins, and only while its record since 2018 is positive", async () => {
    let daily = await fresh();
    const { daemonPositions } = await import("../../server/guardian");
    // ARB isn't on the list.
    await daily.runDailyCoins(await deps(day1, breakout, { coins: async () => ["ARB/INR"] }));
    expect(daemonPositions.size).toBe(0);
    expect(daily._dailyCoinsState().runs.u.picks).toEqual([]);

    for (const [classic, reason] of [
      [() => null, "no record since 2018"],
      [() => ({ "2022-Q2": { breakout: rec(476, -10) } }), "record since 2018 −0.02R (needs +0.05R)"],
      [() => ({ "2022-Q2": { breakout: rec(9, 9) } }), "only 9 replayed setups (needs 10)"],
    ] as const) {
      daily = await fresh();
      await daily.runDailyCoins(await deps(day1, breakout, { classic }));
      expect(daemonPositions.size).toBe(0);
      expect(daily._dailyCoinsState().runs.u.picks).toEqual([{ symbol: "SOL/INR", trader: "Breakout 55/20", outcome: "paused", reason }]);
    }
    expect(daily.breakoutGate(record)).toEqual({ trader: "Breakout 55/20", trades: 476, avgR: expect.closeTo(0.98, 9), on: true });
  });

  it("sells on a close below the 20-day low at CoinDCX's bid, even with autopilot off, and holds on otherwise", async () => {
    const { daemonPositions, closedTradesFor } = await import("../../server/guardian");
    // A new high while holding: no second trade; a close above the 20-day low: held.
    for (const next of [[105, 108, 105, 107], [105, 106, 101, 102]] as Row[]) {
      const daily = await fresh();
      await daily.runDailyCoins(await deps(day1, breakout));
      const d2 = await deps(day2, [...breakout, next]);
      await daily.runDailyCoins(d2);
      expect(daemonPositions.size).toBe(1);
      expect(daily._dailyCoinsState().runs.u.picks).toEqual([]);
      expect(d2.open).not.toHaveBeenCalled();
    }

    // A close at 98, below the 20-day low of 99: sold, whatever the desk.
    for (const over of [{}, { desks: () => [["u", { ...desk, autopilot: false }]] }, { desks: () => [] }]) {
      const daily = await fresh();
      await daily.runDailyCoins(await deps(day1, breakout));
      const [held] = [...daemonPositions.values()];
      await daily.runDailyCoins(await deps(day2, [...breakout, [101, 101, 97, 98]], over));
      expect(daemonPositions.size).toBe(0);
      const [closed] = closedTradesFor("u");
      expect(closed.id).toContain(held.id);
      expect(closed).toMatchObject({ exitPrice: 9990, exitReason: "TRAILING_STOP", strategy: "breakout", timeframe: "1d" });
      expect(daily._dailyCoinsState().runs.u.picks[0]).toEqual({ symbol: "SOL/INR", trader: "Breakout 55/20", outcome: "sold", reason: "closed below its 20-day low" });
    }

    // No price to sell at: it waits, under its stop.
    const daily = await fresh();
    await daily.runDailyCoins(await deps(day1, breakout));
    await daily.runDailyCoins(await deps(day2, [...breakout, [101, 101, 97, 98]], { quote: async () => null }));
    expect(daemonPositions.size).toBe(1);
    expect(daily._dailyCoinsState().runs.u.picks[0]).toMatchObject({ outcome: "waiting", reason: expect.stringContaining("its stop still guards it") });
  });
});

describe("the record daily traders are judged on", () => {
  const rec = (trades: number, totalR: number) => ({ trades, totalR, wins: Math.round(trades / 2), winR: Math.max(totalR, 0) + trades / 4, lossR: Math.min(totalR, 0) - trades / 4 });
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(dataDir, name), JSON.stringify(body));
  const longRun = (over: Record<string, unknown>) => ({
    version: 1, startedAt: 0, fromMs: 0, toMs: 0, traders: [], markets: {}, records: {}, finishedAt: 1, ...over,
  });
  const nineYears = { tight: { "2022-Q2": { "crypto:Sofia Range Scalp": rec(385, -15.4), "crypto:Chen Conservative Trend": rec(1728, 155.52) } } };
  const twoYears = { tight: { "2026-Q2": { "crypto:Sofia Range Scalp": rec(145, 31.9) } } };

  it("is the replay since 2017 once it has finished (the last finished one while it runs again), else the two years", async () => {
    const { dailyCoinsView } = await import("../../server/scanner/dailyCoins");
    const historyJob = await import("../../server/history/historyJob");
    const long = await import("../../server/history/dailyLong");
    const reload = () => {
      historyJob._resetHistoryJob();
      historyJob.loadHistory();
      long._resetDailyLong();
      long.loadDailyLong();
    };
    fs.rmSync(path.join(dataDir, "daily_long.json"), { force: true });
    fs.rmSync(path.join(dataDir, "history_results.json"), { force: true });
    reload();
    expect(dailyCoinsView("u")).toMatchObject({ recordSpan: null, traders: [] });

    // Only the two-year replay so far: Sofia trades on +0.22R.
    write("history_results.json", { version: 4, startedAt: 0, finishedAt: 1, fromMs: 0, toMs: 0, traders: [], markets: {}, records: {}, slow: { "1d": twoYears } });
    reload();
    expect(dailyCoinsView("u")).toMatchObject({ recordSpan: "over two years", traders: [{ trader: "Sofia Range Scalp", trades: 145, on: true }] });

    // The replay since 2017 has finished: Sofia lost over it (−0.04R), so she's paused.
    write("daily_long.json", longRun({ records: nineYears }));
    reload();
    const view = dailyCoinsView("u");
    expect(view.recordSpan).toBe("since 2017");
    expect(view.traders).toEqual([
      { trader: "Chen Conservative Trend", trades: 1728, avgR: expect.closeTo(0.09, 9), on: true },
      { trader: "Sofia Range Scalp", trades: 385, avgR: expect.closeTo(-0.04, 9), on: false },
    ]);

    // Replaying again: the last finished records still decide.
    write("daily_long.json", longRun({ finishedAt: null, records: { tight: { "2018-Q1": { "crypto:Sofia Range Scalp": rec(2, 2) } } }, lastRecords: nineYears }));
    reload();
    expect(dailyCoinsView("u").traders).toEqual(view.traders);
    // Never finished yet: the two years.
    write("daily_long.json", longRun({ finishedAt: null }));
    reload();
    expect(dailyCoinsView("u").recordSpan).toBe("over two years");
    fs.rmSync(path.join(dataDir, "daily_long.json"), { force: true });
    fs.rmSync(path.join(dataDir, "history_results.json"), { force: true });
    reload();
  });
});

describe("Traders with your exits", () => {
  it("leave daily trades out of the 5-minute traders' real record", () => {
    const trade = (over: Record<string, unknown>) => ({ symbol: "SOL/INR", setupName: "Amara Confirmed Breakout", riskAtOpen: 50, realizedPnl: 100, closedAtMs: 1, ...over });
    const real = realByTrader([trade({}), trade({ realizedPnl: -50, timeframe: "1d" })] as never);
    expect(real.get("crypto:Amara Confirmed Breakout")).toEqual({ trades: 1, avgR: 2 });
  });
});
