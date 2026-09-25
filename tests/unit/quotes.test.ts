import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeoutPrice, entryPriceFrom, isFreshQuote, spreadPct, QUOTE_FRESH_MS } from "../../src/shared/quotes";
import { markPriceFor } from "../../src/services/positionTick";
import { simulateExit } from "../../src/services/exitComparison";
import type { MarketBar, StrategySetup } from "../../src/types";

// CoinDCX's INR spreads are wide (Bitcoin's was 0.59%) and trades land on
// either side, so positions are judged on what they could be closed at (the
// bid for a long) and bought at the ask.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-quotes-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

let book = { bids: { "99": "5" }, asks: { "101": "5" } } as Record<string, Record<string, string>>;

beforeAll(() => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).includes("public.coindcx.com/market_data/orderbook")
      ? Promise.resolve(new Response(JSON.stringify(book)))
      : realFetch(url, init)
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.now();
const q = { bid: 84_23_267, ask: 84_73_114, at: now };

describe("quotes", () => {
  it("close a long at the bid and open it at the ask (the reverse for a short)", () => {
    expect(closeoutPrice("LONG", q)).toBe(q.bid);
    expect(closeoutPrice("SHORT", q)).toBe(q.ask);
    expect(entryPriceFrom("LONG", q)).toBe(q.ask);
    expect(entryPriceFrom("SHORT", q)).toBe(q.bid);
    // The Bitcoin book from 24 September.
    expect(spreadPct(q)).toBeCloseTo(0.0059, 4);
  });

  it("are used only while fresh", () => {
    expect(isFreshQuote(q, now + QUOTE_FRESH_MS)).toBe(true);
    expect(isFreshQuote(q, now + QUOTE_FRESH_MS + 1)).toBe(false);
    expect(isFreshQuote({ bid: 10, ask: 9, at: now }, now)).toBe(false);
    expect(isFreshQuote(undefined, now)).toBe(false);
  });

  it("decide the price the app judges a position on", () => {
    const quotes = new Map([["BTC/INR", q]]);
    const prices = { "BTC/INR": q.ask }; // a trade print at the ask
    expect(markPriceFor({ symbol: "BTC/INR", direction: "LONG" }, prices, quotes, now)).toBe(q.bid);
    // Without a fresh quote, the trade price.
    expect(markPriceFor({ symbol: "BTC/INR", direction: "LONG" }, prices, quotes, now + QUOTE_FRESH_MS + 1)).toBe(q.ask);
    expect(markPriceFor({ symbol: "ETH/INR", direction: "LONG" }, { "ETH/INR": 5 }, quotes, now)).toBe(5);
  });
});

describe("the guardian on quotes", () => {
  beforeEach(async () => {
    (await import("../../server/guardian"))._resetGuardian();
    (await import("../../server/quotes"))._resetQuotes();
    book = { bids: { "99": "5" }, asks: { "101": "5" } };
  });

  const long = (over: Record<string, unknown> = {}) => ({
    id: "p1", userId: "u", symbol: "BTC/INR", direction: "LONG" as const, entryPrice: 100, currentPrice: 100,
    quantity: 1, stopLoss: 95, takeProfit: 130, openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 30, ...over,
  });

  it("doesn't let a print at the ask move the trailing stop", async () => {
    const guardian = await import("../../server/guardian");
    guardian.daemonPositions.set("p1", long());
    // Bid 99, ask 103: the ask would look like a +3% gain; what it could sell at is 99.
    guardian.evaluateDaemonPositions("BTC/INR", 103, { bid: 99, ask: 103, at: Date.now() });
    const p = guardian.daemonPositions.get("p1")!;
    expect(p.currentPrice).toBe(99);
    expect(p.highestPrice).toBe(100);
    expect(p.trailActive).toBeFalsy();
  });

  it("stops out when the bid reaches the stop, and fills there", async () => {
    const guardian = await import("../../server/guardian");
    guardian.daemonPositions.set("p1", long({ stopLoss: 99.5 }));
    const { pollQuotes, freshQuote } = await import("../../server/quotes");
    expect(await pollQuotes()).toBe(1);
    expect(guardian.daemonPositions.has("p1")).toBe(false);
    const [closed] = guardian.closedTradesFor("u");
    expect(closed).toMatchObject({ exitReason: "STOP_LOSS", fillAtExit: 99 });
    expect(freshQuote("BTC/INR")).toMatchObject({ bid: 99, ask: 101 });
  });

  it("reads only the coins held", async () => {
    const { pollQuotes } = await import("../../server/quotes");
    expect(await pollQuotes()).toBe(0);
  });
});

describe("the traders' replay", () => {
  it("charges the spread once per trade", () => {
    const FIVE = 5 * 60 * 1000;
    const t0 = Math.floor(now / FIVE) * FIVE - 20 * FIVE;
    const bars: MarketBar[] = Array.from({ length: 20 }, (_, k) => ({
      time: "", timestampMs: t0 + k * FIVE, open: 100, high: 100.2, low: 99.8, close: 100, volume: 10,
    }));
    const setup = { symbol: "BTC/INR", direction: "LONG", entryPrice: 100, stopLoss: 98, takeProfit: 104, family: "momentum_scalp", horizon: "intraday", name: "Test" } as unknown as StrategySetup;
    const plain = simulateExit(setup, bars, 0, "fixed")!;
    const spread = simulateExit(setup, bars, 0, "fixed", 0.006)!;
    // 0.6% of a ₹100 entry on a ₹2 risk: 0.3R.
    expect(plain.r - spread.r).toBeCloseTo(0.3, 6);
  });
});

describe("observed spreads", () => {
  it("average each coin's books, and stand in with the middle of the others for a coin never read", async () => {
    const { recordSpread, typicalSpread, _resetServerScanner } = await import("../../server/scanner/scannerService");
    _resetServerScanner();
    expect(typicalSpread("BTC/INR")).toBeUndefined();
    recordSpread("BTC/INR", 0.006);
    recordSpread("BTC/INR", 0.004);
    expect(typicalSpread("BTC/INR")).toBeCloseTo(0.006 * 0.7 + 0.004 * 0.3, 9);
    recordSpread("ZEC/INR", 0.01);
    recordSpread("ONDO/INR", 0.008);
    expect(typicalSpread("NEW/INR")).toBeCloseTo(0.008, 9);
    // Stocks aren't given a coin's spread.
    expect(typicalSpread("SBIN")).toBeUndefined();
  });
});
