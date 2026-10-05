import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { MarketBar } from "../../src/types";
import { appendBars, emptySeries, type CandleSeries } from "../../src/services/historyReplay";

// The classic strategies on US and Indian stocks' daily candles since 2016:
// each year only that year's 20 biggest stocks, the market's index fund as
// the guard, Indian candles adjusted for splits and bonus issues.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-stocks-long-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const stocks = await import("../../server/history/stocksLong");
const { CLASSIC_VERSION } = await import("../../server/history/dailyLong");
const { fetchUsDailyBars } = await import("../../server/alpaca");

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * Weekday daily candles from 1 Jan 2015 until `toMs`, starting `offset` past
 * UTC midnight: falling through 2015, then rising `daily` a day (so the
 * 50-day average crosses above the 200-day once the lists begin).
 */
function weekdays(toMs: number, offset: number, daily = 0.002, at?: (k: number, p: number) => number): CandleSeries {
  const s = emptySeries();
  const bars: MarketBar[] = [];
  let p = 100;
  for (let start = Date.UTC(2015, 0, 1); start + DAY <= toMs; start += DAY) {
    const weekday = new Date(start).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const o: number = at ? at(bars.length, p) : p;
    p = o * (1 + (start < Date.UTC(2016, 0, 1) ? -0.001 : daily));
    bars.push({ time: "", timestampMs: start + offset, open: o, high: Math.max(o, p), low: Math.min(o, p) * 0.995, close: p, volume: 1000 });
  }
  appendBars(s, bars);
  return s;
}

describe("splits and bonus issues", () => {
  const series = (rows: [number, number][]) => {
    const s = emptySeries();
    appendBars(s, rows.map(([open, close], k) => ({ time: "", timestampMs: k * DAY, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 100 })));
    return s;
  };

  it("adjust the earlier candles where a day opens and closes at a split's share of the day before", () => {
    // A 2-for-1 split: 100 → 50.
    const split = series([[100, 100], [100, 102], [51, 50], [50, 51]]);
    expect(stocks.adjustForSplits(split)).toBe(1);
    expect(split.c).toEqual([50, 51, 50, 51]);
    expect(split.v.slice(0, 2)).toEqual([200, 200]);
    // A 1:2 bonus: a third off.
    const bonus = series([[90, 90], [60, 60.5]]);
    expect(stocks.adjustForSplits(bonus)).toBe(1);
    expect(bonus.c[0]).toBeCloseTo(60, 9);
  });

  it("leave real falls alone, even one that opens at half and recovers", () => {
    const fall = series([[100, 100], [90, 88]]);
    expect(stocks.adjustForSplits(fall)).toBe(0);
    const crash = series([[100, 100], [50, 80]]);
    expect(stocks.adjustForSplits(crash)).toBe(0);
    expect(crash.c).toEqual([100, 80]);
  });
});

describe("each year's stocks", () => {
  it("trade only in the years they were among the 20 biggest, and none before 2016", () => {
    expect(stocks.stockCohortFor("us", 2015)).toEqual([]);
    expect(stocks.stockCohortFor("us", 2016)).toContain("GE");
    expect(stocks.stockCohortFor("us", 2030)).toEqual(stocks.STOCK_COHORTS.us[2025]);
    expect(stocks.inStockCohort("NFLX.US", Date.UTC(2024, 5, 1))).toBe(false);
    expect(stocks.inStockCohort("NFLX.US", Date.UTC(2025, 5, 1))).toBe(true);
    expect(stocks.inStockCohort("M&M", Date.UTC(2025, 5, 1))).toBe(true);
    expect(stocks.inStockCohort("HDFC", Date.UTC(2023, 5, 1))).toBe(true);
    // Each market's fund first: it guards, it isn't traded.
    expect(stocks.stockSymbols("us")[0]).toBe("SPY.US");
    expect(stocks.stockSymbols("nse")[0]).toBe("NIFTYBEES");
    for (const year of Object.keys(stocks.STOCK_COHORTS.nse)) expect(stocks.STOCK_COHORTS.nse[Number(year)].length).toBe(20);
    for (const year of Object.keys(stocks.STOCK_COHORTS.us)) expect(stocks.STOCK_COHORTS.us[Number(year)].length).toBe(20);
  });

  it("pay Alpaca's fees and a spread in the US, delivery charges in India (about 0.5% a round trip)", () => {
    expect(stocks.stockCost("us")).toBeCloseTo(0.0004, 9);
    expect(stocks.stockCost("nse")).toBeGreaterThan(0.004);
    expect(stocks.stockCost("nse")).toBeLessThan(0.007);
  });
});

describe("the replay", () => {
  afterEach(() => stocks._resetStocksLong());
  const toMs = Date.UTC(2026, 9, 3);

  function deps(over: Record<string, unknown> = {}) {
    const downloads: string[] = [];
    let nseChecks = 0;
    const waits: number[] = [];
    return {
      downloads,
      waits,
      deps: {
        now: () => toMs + 10 * HOUR,
        sleep: async (ms: number) => {
          waits.push(ms);
        },
        download: async (symbol: string) => {
          downloads.push(symbol);
          if (symbol === "HDFC") return { error: "HDFC isn't listed at Angel One" };
          if (symbol.endsWith(".US")) return { series: weekdays(toMs, 5 * HOUR) };
          // Reliance has a 1:1 bonus on its 300th session; Angel One doesn't adjust for it.
          if (symbol === "RELIANCE") return { series: weekdays(toMs, -5.5 * HOUR, 0.002, (k, p) => (k === 300 ? p / 2 : p)) };
          return { series: weekdays(toMs, -5.5 * HOUR) };
        },
        scannerBusy: () => false,
        // NSE is open for the first two checks.
        nseBusy: () => nseChecks++ < 2,
        ...over,
      },
    };
  }

  it("replays each market's stocks in their list years, waits for NSE to close, adjusts Indian splits and tries a failed stock once more", async () => {
    const { deps: d, downloads, waits } = deps();
    await stocks.startStocksLong(true, d);
    const run = stocks._stocksLongRun()!;
    expect(run.finishedAt).not.toBeNull();
    expect(run.done).toEqual(["us", "funds", "nse"]);
    expect(run.classicVersion).toBe(CLASSIC_VERSION);
    // US breakout and momentum trades are saved for the machine-learning test (closed ones: these still rise, so none yet); India's aren't.
    const { readBreakoutSetups } = await import("../../server/history/breakoutSetups");
    expect(readBreakoutSetups("us")).toMatchObject({ savedAt: d.now(), setups: [] });
    expect(readBreakoutSetups("us", "momentum")).toMatchObject({ savedAt: d.now(), setups: [] });
    // Every US stock rises steadily: one breakout trade each, opened in its first list year (none before 2016), the fund not traded.
    const usStocks = stocks.stockSymbols("us").length - 1;
    const breakouts = (market: "us" | "nse") => Object.values(run.classic[market]!).reduce((n, q) => n + (q.breakout?.trades ?? 0), 0);
    expect(breakouts("us")).toBe(usStocks);
    expect(Object.keys(run.classic.us!).every((q) => q >= "2016")).toBe(true);
    // Netflix joined the list in 2025: its trade opened then.
    expect(run.classic.us!["2025-Q1"]?.breakout?.trades).toBeGreaterThanOrEqual(1);
    // Moving averages and momentum trade too (SPY rising, so the guard is up).
    expect(Object.values(run.classic.us!).some((q) => (q.maTrend?.trades ?? 0) > 0)).toBe(true);
    expect(Object.values(run.classic.us!).some((q) => (q.momentum?.trades ?? 0) > 0)).toBe(true);
    // India: HDFC (merged in 2023) isn't at Angel One: tried twice, then left out; Reliance's bonus adjusted.
    expect(downloads.filter((s) => s === "HDFC").length).toBe(2);
    expect(breakouts("nse")).toBe(stocks.stockSymbols("nse").length - 2);
    expect(run.markets.RELIANCE).toMatchObject({ status: "done", adjusted: 1 });
    // Indian downloads waited twice for NSE to close; HDFC's second try came 10 minutes after the first pass.
    expect(waits.filter((ms) => ms === 5 * 60 * 1000).length).toBe(2);
    expect(waits.filter((ms) => ms === 10 * 60 * 1000).length).toBe(1);

    const view = stocks.stocksLongView();
    expect(view).toMatchObject({ running: false, funds: { us: "SPY", nse: "NIFTYBEES", funds: "SPY" } });
    expect(view.run!.problems).toEqual([{ symbol: "HDFC", note: "HDFC isn't listed at Angel One" }]);
    expect(view.run!.adjusted).toEqual([{ symbol: "RELIANCE", count: 1 }]);
    expect(Object.keys(view.classic)).toEqual(["us", "funds", "nse"]);
    // Kept on disk, and due again in a month (or when the classic strategies change).
    stocks._resetStocksLong();
    stocks.loadStocksLong();
    const saved = stocks._stocksLongRun()!;
    expect(saved.done).toEqual(["us", "funds", "nse"]);
    expect(stocks.stocksLongDue(saved, saved.finishedAt! + 29 * DAY)).toBe(false);
    expect(stocks.stocksLongDue(saved, saved.finishedAt! + 31 * DAY)).toBe(true);
    expect(stocks.stocksLongDue({ ...saved, classicVersion: CLASSIC_VERSION - 1 }, saved.finishedAt!)).toBe(true);
    expect(stocks.stocksLongDue(null, 0)).toBe(true);
  });

  it("replays the funds across kinds of assets, the same every year and with no share-market guard, and saves their trades for the machine-learning test", async () => {
    // SPY falls the whole time: US stocks' guard is down; the funds' isn't.
    const { deps: d, downloads } = deps({
      download: async (symbol: string) => {
        downloads.push(symbol);
        if (symbol === "SPY.US") return { series: weekdays(toMs, 5 * HOUR, -0.001) };
        return { series: weekdays(toMs, symbol.endsWith(".US") ? 5 * HOUR : -5.5 * HOUR) };
      },
    });
    await stocks.startStocksLong(true, d);
    const run = stocks._stocksLongRun()!;
    expect(stocks.stockSymbols("funds")).toEqual(["SPY.US", ...stocks.FUNDS.map((t) => `${t}.US`)]);
    expect(stocks.FUNDS).toEqual(expect.arrayContaining(["GLD", "TLT", "IEF", "SLV"]));
    expect(stocks.inStockCohort("GLD.US", Date.UTC(2016, 5, 1), "funds")).toBe(true);
    expect(stocks.inStockCohort("GLD.US", Date.UTC(2030, 5, 1), "funds")).toBe(true);
    expect(stocks.inStockCohort("GLD.US", Date.UTC(2016, 5, 1))).toBe(false);
    const count = (market: "us" | "funds", id: "breakout" | "maTrend" | "momentum") =>
      Object.values(run.classic[market]!).reduce((n, q) => n + (q[id]?.trades ?? 0), 0);
    // Every fund rises steadily: one breakout trade each, from 2016.
    expect(count("funds", "breakout")).toBe(stocks.FUNDS.length);
    expect(Object.keys(run.classic.funds!).every((q) => q >= "2016")).toBe(true);
    // Moving averages and momentum trade the funds with SPY falling; US stocks' don't.
    expect(count("funds", "maTrend")).toBeGreaterThan(0);
    expect(count("funds", "momentum")).toBeGreaterThan(0);
    expect(count("us", "maTrend")).toBe(0);
    expect(count("us", "momentum")).toBe(0);
    // Saved for the machine-learning test (closed trades only: these still rise, so none yet).
    const { readBreakoutSetups } = await import("../../server/history/breakoutSetups");
    expect(readBreakoutSetups("funds")).toMatchObject({ savedAt: d.now(), setups: [] });
    expect(readBreakoutSetups("funds", "momentum")).toMatchObject({ savedAt: d.now(), setups: [] });
  });

  it("replays a market added since a finished run (the funds) alone, without downloading the others again", async () => {
    const first = deps();
    await stocks.startStocksLong(true, first.deps);
    // A run from before the funds: finished with US stocks and India only.
    const before = { ...stocks._stocksLongRun()!, done: ["us", "nse"] as ("us" | "nse")[], classic: { ...stocks._stocksLongRun()!.classic, funds: undefined } };
    fs.writeFileSync(path.join(dataDir, "stocks_long.json"), JSON.stringify(before));
    stocks._resetStocksLong();
    stocks.loadStocksLong();
    expect(stocks.stocksLongMissing(stocks._stocksLongRun())).toBe(true);
    expect(stocks.stocksLongDue(stocks._stocksLongRun(), toMs)).toBe(false);
    const second = deps();
    await stocks.startStocksLong(false, second.deps);
    expect(second.downloads).toEqual(stocks.stockSymbols("funds"));
    const run = stocks._stocksLongRun()!;
    expect(run.done).toEqual(["us", "nse", "funds"]);
    expect(run.classic.funds).toBeTruthy();
    expect(run.classic.us).toEqual(before.classic.us);
    expect(stocks.stocksLongMissing(run)).toBe(false);
    expect(stocks.stocksLongMissing(null)).toBe(false);
  });

  it("keeps the last results on show while it replays again, market by market", async () => {
    const first = deps();
    await stocks.startStocksLong(true, first.deps);
    const before = stocks._stocksLongRun()!.classic;
    // The next run stops in the US downloads: India's last results are still there.
    let calls = 0;
    const second = deps({
      download: async (symbol: string) => {
        if (++calls === 3) stocks._resetStocksLong();
        return { series: weekdays(toMs, symbol.endsWith(".US") ? 5 * HOUR : -5.5 * HOUR) };
      },
    });
    stocks.loadStocksLong();
    await stocks.startStocksLong(true, second.deps);
    stocks.loadStocksLong();
    const kept = stocks._stocksLongRun()!;
    expect(kept.finishedAt).toBeNull();
    expect(kept.done).toEqual([]);
    expect(kept.classic.nse).toEqual(before.nse);
  });
});

describe("Alpaca's daily candles", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ask for every exchange's trades, and for IEX's when the plan doesn't allow them", async () => {
    vi.stubEnv("ALPACA_API_KEY_ID", "key");
    vi.stubEnv("ALPACA_API_SECRET_KEY", "secret");
    const feeds: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      feeds.push(u.searchParams.get("feed")!);
      expect(u.searchParams.get("timeframe")).toBe("1Day");
      expect(u.searchParams.get("adjustment")).toBe("all");
      if (u.searchParams.get("feed") === "sip") return new Response(JSON.stringify({ message: "subscription does not permit querying recent SIP data" }), { status: 403 });
      return new Response(JSON.stringify({ bars: { "BRK.B": [{ t: "2016-01-04T05:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: null }));
    });
    const rows = await fetchUsDailyBars("BRK.B.US", Date.UTC(2015, 0, 1), Date.UTC(2026, 9, 3));
    expect(feeds).toEqual(["sip", "iex"]);
    expect(rows).toEqual([[Date.parse("2016-01-04T05:00:00Z"), 1, 2, 0.5, 1.5, 10]]);

    // Keys refused: no other feed tried.
    feeds.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      feeds.push(new URL(url).searchParams.get("feed")!);
      return new Response(JSON.stringify({ message: "forbidden" }), { status: 401 });
    });
    await expect(fetchUsDailyBars("AAPL.US", 0, 1)).rejects.toThrow(/refused the keys/);
    expect(feeds).toEqual(["sip"]);
  });
});
