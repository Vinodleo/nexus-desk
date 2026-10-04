import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPECTANCY_TTL_MS,
  RECORD_DAYS,
  _clearExpectancyCache,
  getExpectancyTable,
  keepTrades,
  measureExpectancy,
  measureTrades,
  oneAtATime,
  type ExpectancyTable,
  type MeasuredTrade,
  type TradeHistory,
} from "../../src/services/exitExpectancy";
import { recordSpan } from "../../src/components/ledger/LedgerBreakdown";
import type { MarketBar } from "../../src/types";
import { _setCoinRoundTripFee } from "../../src/shared/tradeCosts";

// These follow 5-minute coin setups through the app's later steps, so they
// charge a cheaper venue's 0.1% round trip: CoinDCX's real 1.18% stops every
// one of them at the costs check (lossFixes.test.ts shows it).
beforeAll(() => _setCoinRoundTripFee(0.001));
afterAll(() => _setCoinRoundTripFee());

// The traders' records: one trade at a time per trader and market (as the
// desk trades live), and on the server the last 30 days of trades rather
// than the day of candles held.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-records-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FIVE = 5 * MIN;
const t = (over: Partial<MeasuredTrade>): MeasuredTrade => ({ symbol: "SOL/INR", trader: "Marcus Swing Trend", entryMs: 0, exitMs: HOUR, r: 1, ...over });

/** `n` five-minute candles, the last opening at `lastOpen`, priced by candle number from `from`. */
function candles(n: number, lastOpen: number, from: number, priceAt: (k: number) => number): MarketBar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = priceAt(from + i);
    return { time: String(i), timestampMs: lastOpen - (n - 1 - i) * FIVE, open: c - 2, high: c + 4, low: c - 4, close: c, volume: 100 + i };
  });
}
const rising = (k: number) => 10000 + k * 8;
const counted = (table: ExpectancyTable) => Object.values(table.byKey).reduce((n, r) => n + r.trades, 0);

describe("one trade at a time", () => {
  it("counts a trader's setup only once their last trade in that market has closed", () => {
    const fresh = [
      t({ entryMs: 0, exitMs: 60 * MIN, r: -1 }),
      t({ entryMs: 20 * MIN, exitMs: 80 * MIN, r: 2 }), // while the first is open
      t({ entryMs: 60 * MIN, exitMs: 90 * MIN, r: 0.5 }), // as the first closes
      t({ trader: "Priya Momentum Scalp", entryMs: 20 * MIN, exitMs: 30 * MIN }), // another trader
      t({ symbol: "ETH/INR", entryMs: 20 * MIN, exitMs: 30 * MIN }), // another market
    ];
    expect(oneAtATime([], fresh).map((x) => [x.symbol, x.trader, x.entryMs / MIN])).toEqual([
      ["SOL/INR", "Marcus Swing Trend", 0],
      ["SOL/INR", "Priya Momentum Scalp", 20],
      ["ETH/INR", "Marcus Swing Trend", 20],
      ["SOL/INR", "Marcus Swing Trend", 60],
    ]);
  });

  it("holds a trade still running until it ends, and counts a trade seen again once", () => {
    const running = t({ entryMs: 0, exitMs: 30 * MIN, open: true });
    expect(oneAtATime([], [running, t({ entryMs: 40 * MIN, exitMs: 50 * MIN })])).toEqual([running]);
    const kept = [t({ entryMs: 0, exitMs: 60 * MIN })];
    const again = oneAtATime(kept, [t({ entryMs: 0, exitMs: 60 * MIN }), t({ entryMs: 60 * MIN, exitMs: 70 * MIN })]);
    expect(again.map((x) => x.entryMs)).toEqual([60 * MIN]);
  });

  it("makes the records count each move once, not every setup along it", () => {
    const bars = candles(300, Date.parse("2026-09-27T00:00:00Z"), 0, rising);
    const { trades } = measureTrades([{ symbol: "SOL/INR", bars }], "tight");
    const table = measureExpectancy([{ symbol: "SOL/INR", bars }], "tight");
    // A steady climb: trades run for hours while setups repeat every 20 minutes.
    expect(counted(table)).toBeLessThan(trades.length);
    expect(counted(table)).toBe(oneAtATime([], trades).length);
    expect(counted(table)).toBeGreaterThan(0);
  });
});

describe("kept trades", () => {
  it("are the last 30 days' finished trades, one at a time", () => {
    const now = 100 * DAY;
    const old = t({ entryMs: now - (RECORD_DAYS + 1) * DAY, exitMs: now - (RECORD_DAYS + 1) * DAY + HOUR });
    const recent = t({ entryMs: now - 2 * DAY, exitMs: now - 2 * DAY + HOUR });
    const fresh = t({ entryMs: now - 3 * HOUR, exitMs: now - 2 * HOUR });
    const running = t({ trader: "Priya Momentum Scalp", entryMs: now - HOUR, exitMs: now, open: true });
    expect(keepTrades([old, recent], [recent, fresh, running], now)).toEqual([recent, fresh]);
  });

  it("build a record past the day of candles held, and judge the trades still running without keeping them", () => {
    _clearExpectancyCache();
    const store = new Map<string, MeasuredTrade[]>();
    const history: TradeHistory = { load: (p) => store.get(p) ?? [], save: (p, x) => void store.set(p, x) };
    // Day one's 300 candles, then the next 300 (25 hours later).
    const end1 = Date.parse("2026-09-26T00:00:00Z");
    const end2 = end1 + 300 * FIVE;
    const day1 = candles(300, end1, 0, rising);
    const day2 = candles(300, end2, 300, rising);
    const first = getExpectancyTable(["SOL/INR"], () => day1, "tight", end1 + FIVE, undefined, history);
    const second = getExpectancyTable(["SOL/INR"], () => day2, "tight", end1 + FIVE + EXPECTANCY_TTL_MS, undefined, history);
    _clearExpectancyCache();
    const day2Alone = getExpectancyTable(["SOL/INR"], () => day2, "tight", end2 + FIVE);
    // The second measure still has day one's trades: more than day two alone, going back to day one.
    expect(counted(second)).toBeGreaterThan(counted(day2Alone));
    expect(second.since).toBe(first.since);
    expect(second.since).toBeLessThan(day2[0].timestampMs as number);
    // Only finished trades are kept.
    expect(store.get("tight")!.length).toBeGreaterThan(0);
    expect(store.get("tight")!.every((x) => !x.open)).toBe(true);
  });
});

describe("the server's store", () => {
  it("saves kept trades on the volume and reads them back after a restart, skipping damaged ones", async () => {
    const { traderHistory, loadTraderRecords, _resetTraderRecords } = await import("../../server/scanner/traderRecords");
    const trade = t({ entryMs: 5 * DAY, exitMs: 5 * DAY + HOUR, r: -0.4 });
    traderHistory.save("tight", [trade]);
    const file = path.join(dataDir, "trader_records.json");
    expect(fs.existsSync(file)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.tight.push({ symbol: "X/INR", trader: "Nobody", entryMs: 1, exitMs: 2, r: "lots" });
    fs.writeFileSync(file, JSON.stringify(saved));
    _resetTraderRecords();
    expect(traderHistory.load("tight")).toEqual([]);
    loadTraderRecords();
    expect(traderHistory.load("tight")).toEqual([trade]);
  });

  it("drops coin trades measured under the old coin fee, keeping the stocks'", async () => {
    const { traderHistory, loadTraderRecords, _resetTraderRecords } = await import("../../server/scanner/traderRecords");
    const coin = t({ symbol: "SOL/INR", entryMs: 5 * DAY, exitMs: 5 * DAY + HOUR, r: 0.4 });
    const us = t({ symbol: "AAPL.US", entryMs: 5 * DAY, exitMs: 5 * DAY + HOUR, r: 0.2 });
    // A file from before CoinDCX's real fee: no costs marker.
    fs.writeFileSync(path.join(dataDir, "trader_records.json"), JSON.stringify({ tight: [coin, us] }));
    _resetTraderRecords();
    loadTraderRecords();
    expect(traderHistory.load("tight")).toEqual([us]);
    // Saved again with the marker: its coin trades are kept from now on.
    traderHistory.save("tight", [coin, us]);
    _resetTraderRecords();
    loadTraderRecords();
    expect(traderHistory.load("tight")).toEqual([coin, us]);
  });
});

describe("the card", () => {
  it("says how far back the records go", () => {
    expect(recordSpan({ since: Date.parse("2026-09-27T10:00:00Z"), recordDays: 30 })).toMatch(/^since 27 Sept? \(the server keeps up to 30 days\)$/);
    // A server that doesn't keep them measures the day of candles it holds.
    expect(recordSpan({})).toBe("over the last day");
  });
});
