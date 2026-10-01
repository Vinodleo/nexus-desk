import { describe, expect, it, vi } from "vitest";
import type { MarketBar } from "../../src/types";
import {
  CHUNK_BARS,
  CHUNK_WARMUP_BARS,
  HISTORY_VIEW_BARS,
  addToRecords,
  appendBars,
  emptySeries,
  halfYears,
  historyRows,
  profileTotals,
  quarterOf,
  replayHistory,
  type CandleSeries,
  type HistoryRecords,
  type HistoryTrade,
} from "../../src/services/historyReplay";
import { panelSetupsOnHistory } from "../../src/services/labSimulation";
import { decorateBarsWithIndicators } from "../../src/services/marketDataService";
import { TRADER_PERSONAS } from "../../src/services/personaEngine";

// The traders over years of history, replayed a chunk at a time.

const FIVE = 5 * 60_000;
const PROFILES = ["tight", "balanced", "patient", "fixed"] as const;

/** A coin wandering for `count` 5-minute candles. */
function coinSeries(count: number, seed = 11): CandleSeries {
  const s = emptySeries();
  let p = 100;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bars: MarketBar[] = [];
  for (let k = 0; k < count; k++) {
    const t = Date.parse("2025-01-01T00:00:00Z") + k * FIVE;
    const o = p;
    p *= 1 + (rnd() - 0.5) * 0.006;
    bars.push({ time: new Date(t).toISOString(), timestampMs: t, open: o, high: Math.max(o, p) * (1 + rnd() * 0.002), low: Math.min(o, p) * (1 - rnd() * 0.002), close: p, volume: 1000 + rnd() * 5000 });
  }
  appendBars(s, bars);
  return s;
}

describe("the history replay", () => {
  it("replays a chunk at a time, one trade at a time per trader under each exit profile", () => {
    const series = coinSeries(CHUNK_WARMUP_BARS + 2 * CHUNK_BARS + 400);
    const slices: HistoryTrade[][] = [...replayHistory("BTC/INR", series, [...PROFILES], 0.0005)];
    // It pauses every SLICE_BARS candles: 4 + 4 + 1 times.
    expect(slices.length).toBe(9);
    const trades = slices.flat();
    expect(new Set(trades.map((t) => t.profile))).toEqual(new Set(PROFILES));
    const firstJudged = series.t[CHUNK_WARMUP_BARS];
    const end = series.t[series.t.length - 1] + FIVE;
    for (const t of trades) {
      expect(t.entryMs).toBeGreaterThan(firstJudged);
      expect(t.exitMs).toBeGreaterThanOrEqual(t.entryMs);
      expect(t.exitMs).toBeLessThanOrEqual(end);
    }
    // Under each profile, a trader's next trade opens only once the last one closed, across chunks too.
    const byKey = new Map<string, HistoryTrade[]>();
    for (const t of trades) byKey.set(`${t.profile}|${t.trader}`, [...(byKey.get(`${t.profile}|${t.trader}`) ?? []), t]);
    for (const list of byKey.values()) {
      for (let k = 1; k < list.length; k++) expect(list[k].entryMs).toBeGreaterThanOrEqual(list[k - 1].exitMs);
    }
    // Trades on both sides of the chunk boundaries.
    const boundary = series.t[CHUNK_WARMUP_BARS + CHUNK_BARS];
    expect(trades.some((t) => t.entryMs < boundary)).toBe(true);
    expect(trades.some((t) => t.entryMs > boundary)).toBe(true);
  });

  it("gives each chunk the candles before it, so a trader reading earlier sessions still finds its setup", () => {
    // Nifty sessions (9:15 IST = 03:45 UTC, 75 candles), rising steadily, each opening on 10,000 shares.
    const weekdays: string[] = [];
    for (let d = Date.parse("2026-09-24T00:00:00Z"); weekdays.length < 36; d -= 24 * 3_600_000) {
      const day = new Date(d).getUTCDay();
      if (day !== 0 && day !== 6) weekdays.unshift(new Date(d).toISOString().slice(0, 10));
    }
    const bars: MarketBar[] = [];
    weekdays.forEach((date, n) => {
      const t0 = Date.parse(`${date}T03:45:00Z`);
      for (let k = 0; k < 75; k++) {
        const p = 1000 + (n * 75 + k) * 0.25 + (k % 3) * 0.6;
        const t = t0 + k * FIVE;
        bars.push({ time: new Date(t).toISOString(), timestampMs: t, open: p * 0.9995, high: p * 1.002, low: p * 0.998, close: p, volume: k === 0 ? 10_000 : 5000 });
      }
    });
    // Today: a rising opening candle on three times the usual volume, then a close above it.
    const today = Date.parse("2026-09-25T03:45:00Z");
    const last = bars[bars.length - 1].close;
    const open = [
      { open: last, high: last + 6, low: last - 2, close: last + 5, volume: 30_000 },
      { open: last + 5, high: last + 6, low: last + 2, close: last + 4, volume: 5000 },
      { open: last + 4, high: last + 9, low: last + 3, close: last + 8, volume: 5000 },
    ];
    for (let k = 0; k < 75; k++) {
      const t = today + k * FIVE;
      const c = open[k] ?? { open: last + 10, high: last + 10.5, low: last + 9.5, close: last + 10, volume: 5000 };
      bars.push({ time: new Date(t).toISOString(), timestampMs: t, ...c });
    }
    const series = emptySeries();
    appendBars(series, bars);
    // Today's opening lands in the second chunk; the earlier sessions it needs are in the first.
    const opening = bars.length - 75;
    expect(opening).toBeGreaterThan(CHUNK_WARMUP_BARS + CHUNK_BARS);
    const trades = [...replayHistory("RELIANCE", series, ["tight"])].flat();
    const nora = trades.find((t) => t.trader === "Nora Opening Range");
    expect(nora?.entryMs).toBe(bars[opening + 2].timestampMs! + FIVE);
  });

  it("shows the traders only the candles the server holds live", () => {
    const series = coinSeries(1200);
    const bars = decorateBarsWithIndicators(
      series.t.map((t, k) => ({ time: new Date(t).toISOString(), timestampMs: t, open: series.o[k], high: series.h[k], low: series.l[k], close: series.c[k], volume: series.v[k] }))
    );
    const seen: number[] = [];
    const spy = vi.spyOn(TRADER_PERSONAS[0], "evaluate").mockImplementation((ctx) => {
      seen.push(ctx.bars.length);
      return null;
    });
    try {
      panelSetupsOnHistory("BTC/INR", bars, undefined, { from: 900, to: 950, view: HISTORY_VIEW_BARS });
    } finally {
      spy.mockRestore();
    }
    expect(seen.length).toBe(50);
    expect(Math.max(...seen)).toBe(HISTORY_VIEW_BARS);
  });
});

describe("the history results", () => {
  const at = (iso: string) => Date.parse(iso);
  const trade = (trader: string, profile: (typeof PROFILES)[number], iso: string, r: number): HistoryTrade => ({ trader, profile, entryMs: at(iso), exitMs: at(iso) + FIVE, r });

  it("adds up each trader's results by quarter, and shows them by half-year", () => {
    expect(quarterOf(at("2025-02-10T00:00:00Z"))).toBe("2025-Q1");
    expect(halfYears(["2025-Q2", "2024-Q4", "2025-Q1"])).toEqual([
      { label: "Oct–Dec 2024", quarters: ["2024-Q4"] },
      { label: "Jan–Jun 2025", quarters: ["2025-Q1", "2025-Q2"] },
    ]);
    expect(halfYears(["2024-Q4", "2025-Q1"])).toEqual([{ label: "Oct 2024–Mar 2025", quarters: ["2024-Q4", "2025-Q1"] }]);

    const records: HistoryRecords = {};
    addToRecords(records, "BTC/INR", [
      trade("Sofia Range Scalp", "tight", "2024-11-01T00:00:00Z", 0.5),
      trade("Sofia Range Scalp", "tight", "2025-02-01T00:00:00Z", -1),
      trade("Sofia Range Scalp", "tight", "2025-05-01T00:00:00Z", 1.5),
      trade("Diego Aggressive Breakout", "tight", "2025-05-01T00:00:00Z", -0.4),
      trade("Sofia Range Scalp", "fixed", "2025-05-01T00:00:00Z", -0.2),
    ]);
    addToRecords(records, "TCS", [trade("Sofia Range Scalp", "tight", "2025-05-01T00:00:00Z", -0.6)]);

    const { halves, rows } = historyRows(records, "tight");
    expect(halves).toEqual(["Oct–Dec 2024", "Jan–Jun 2025"]);
    const sofia = rows.find((r) => r.market === "crypto" && r.trader === "Sofia Range Scalp")!;
    expect(sofia).toMatchObject({ trades: 3, winPct: 67, avgWinR: 1, avgLossR: -1 });
    expect(sofia.avgR).toBeCloseTo(1 / 3, 9);
    expect(sofia.halves).toEqual([{ avgR: 0.5, trades: 1 }, { avgR: 0.25, trades: 2 }]);
    // Diego had no setups in the first half-year.
    expect(rows.find((r) => r.trader === "Diego Aggressive Breakout")!.halves[0]).toEqual({ avgR: null, trades: 0 });
    // Coins first (best first), then Indian stocks.
    expect(rows.map((r) => `${r.market}:${r.trader}`)).toEqual(["crypto:Sofia Range Scalp", "crypto:Diego Aggressive Breakout", "nse:Sofia Range Scalp"]);

    const totals = profileTotals(records);
    expect(totals.find((t) => t.market === "crypto" && t.profile === "tight")!.stats).toMatchObject({ trades: 4, winPct: 50 });
    expect(totals.find((t) => t.market === "crypto" && t.profile === "fixed")!.stats.avgR).toBeCloseTo(-0.2, 9);
    expect(totals.some((t) => t.market === "us")).toBe(false);
  });
});
