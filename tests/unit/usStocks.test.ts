import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inUsSession, isUsOpen, isUsSymbol, usSquareOffDue, usTakesEntries, US_ROUND_TRIP_RATE } from "../../src/shared/usMarket";
import { marketOf } from "../../src/shared/marketLimits";
import { holdMinutesFor, planAtr, stopFloorPct, isCoin } from "../../src/shared/coinHolds";
import { breakevenBuffer, holdingDecision } from "../../src/shared/exitRules";
import { computeClosedTradePnl } from "../../src/shared/tradeMath";

// US stocks (paper) from Alpaca: a third market, priced in rupees, traded on
// stock rules (not coin ones), long only, inside New York trading hours.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-us-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.stubEnv("ALPACA_API_KEY_ID", "PKTEST");
vi.stubEnv("ALPACA_API_SECRET_KEY", "secret");
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

/** Thursday 24 September 2026, 11:00 New York (EDT) = 20:30 IST: US open, NSE closed. */
const now = Date.parse("2026-09-24T15:00:00Z");
const FIVE = 5 * 60_000;
const USDINR = 84;

describe("the US market", () => {
  it("is its own market, never a coin or an NSE stock", () => {
    expect(isUsSymbol("AAPL.US")).toBe(true);
    expect(isUsSymbol("AAPL")).toBe(false);
    expect(marketOf("AAPL.US")).toBe("us");
    expect(marketOf("SBIN")).toBe("stocks");
    expect(marketOf("BTC/INR")).toBe("coins");
    expect(isCoin("AAPL.US")).toBe(false);
  });

  it("keeps New York hours, daylight saving included", () => {
    expect(isUsOpen(now)).toBe(true);
    // 9:00 New York in December (EST) is 14:00 UTC: not open yet; 9:40 is.
    expect(isUsOpen(Date.parse("2026-12-10T14:00:00Z"))).toBe(false);
    expect(isUsOpen(Date.parse("2026-12-10T14:40:00Z"))).toBe(true);
    // Saturday.
    expect(isUsOpen(Date.parse("2026-09-26T15:00:00Z"))).toBe(false);
    // No new trades after 3:30; positions closed from 3:50, or on a later day.
    expect(usTakesEntries(Date.parse("2026-09-24T19:35:00Z"))).toBe(false);
    const opened = new Date(now).toISOString();
    expect(usSquareOffDue(opened, Date.parse("2026-09-24T19:45:00Z"))).toBe(false);
    expect(usSquareOffDue(opened, Date.parse("2026-09-24T19:50:00Z"))).toBe(true);
    expect(usSquareOffDue(opened, Date.parse("2026-09-25T14:00:00Z"))).toBe(true);
  });

  it("trades on stock rules: 5-minute plan, 30-minute limit, closed at 3:50, near-zero costs", () => {
    expect(holdMinutesFor({ symbol: "AAPL.US", horizon: "intraday" })).toBe(30);
    expect(planAtr("AAPL.US", { atr: 2, atrHour: 9, close: 1000 })).toBe(2);
    expect(stopFloorPct("AAPL.US", 0.003)).toBe(0.003);
    expect(breakevenBuffer("AAPL.US")).toBe(0.001);
    const pos = {
      symbol: "AAPL.US", direction: "LONG" as const, entryPrice: 100, stopLoss: 110, quantity: 1,
      openTime: new Date(now).toISOString(), expectedHoldingTimeMinutes: 10_000,
    };
    expect(holdingDecision(pos, Date.parse("2026-09-24T19:51:00Z"))).toBe("expire");
    // ₹10,000 in and out: regulatory fees only.
    const pnl = computeClosedTradePnl("LONG", 100, 101, 100, "TAKE_PROFIT", undefined, "AAPL.US");
    expect(pnl.feesPaid).toBeCloseTo((10_000 + 10_100) * (US_ROUND_TRIP_RATE / 2), 2);
  });
});

// ---------- Alpaca, stubbed ----------

const calls: string[] = [];
let alpacaDown = false;

/** Each 5-minute slot's count of session candles before it, over the days the tests read: prices move only while the market is open. */
const sessionIndex = new Map<number, number>();
for (let ms = now - 8 * 24 * 60 * 60_000, k = 0; ms <= now + 24 * 60 * 60_000; ms += FIVE) {
  sessionIndex.set(ms, k);
  if (inUsSession(ms, FIVE)) k++;
}
/** A strong uptrend (0.15% a session candle, well clear of costs), at $250 now; flat overnight. */
const usdAt = (t: number) => 250 * Math.pow(1.0015, sessionIndex.get(Math.floor(t / FIVE) * FIVE)! - sessionIndex.get(now)!);

function alpaca(url: URL): Response {
  if (alpacaDown) return new Response(JSON.stringify({ message: "forbidden." }), { status: 403 });
  const tickers = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
  if (url.pathname.endsWith("/stocks/bars")) {
    const step = url.searchParams.get("timeframe") === "1Hour" ? 60 * 60_000 : FIVE;
    const from = Date.parse(url.searchParams.get("start")!);
    const to = Date.parse(url.searchParams.get("end")!);
    const bars: Record<string, unknown[]> = {};
    for (const t of tickers) {
      bars[t] = [];
      for (let ms = Math.ceil(from / step) * step; ms <= to; ms += step) {
        const c = usdAt(ms);
        bars[t].push({ t: new Date(ms).toISOString(), o: c * 0.9997, h: c * 1.0005, l: c * 0.9995, c, v: 5000 + ((ms / FIVE) % 50) * 100 });
      }
    }
    return new Response(JSON.stringify({ bars, next_page_token: null }));
  }
  if (url.pathname.endsWith("/stocks/snapshots")) {
    const out: Record<string, unknown> = {};
    for (const t of tickers) {
      const p = usdAt(now);
      out[t] = { latestTrade: { p }, latestQuote: { bp: p - 0.02, ap: p + 0.02, bs: 300, as: 200 } };
    }
    return new Response(JSON.stringify(out));
  }
  if (url.pathname.endsWith("/account")) return new Response(JSON.stringify({ status: "ACTIVE" }));
  return new Response("not found", { status: 404 });
}

beforeAll(() => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const u = String(input);
    if (u.includes("alpaca.markets")) {
      calls.push(u);
      return Promise.resolve(alpaca(new URL(u)));
    }
    if (u.includes("frankfurter")) return Promise.resolve(new Response(JSON.stringify({ base: "USD", rates: { INR: USDINR } })));
    if (/coindcx\.com/.test(u)) return Promise.resolve(new Response(u.includes("ticker") ? "[]" : "down", { status: u.includes("ticker") ? 200 : 503 }));
    if (/faireconomy/.test(u)) return Promise.resolve(new Response("[]"));
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls.length = 0;
  alpacaDown = false;
  (await import("../../server/fx"))._setUsdInr(null);
  (await import("../../server/alpaca"))._resetAlpaca();
});

describe("USD/INR", () => {
  it("comes from the reference rate, can be pinned with USD_INR_RATE, and ignores nonsense", async () => {
    const fx = await import("../../server/fx");
    expect(fx.usdInr()).toBeNull();
    expect(await fx.refreshUsdInr(now)).toBe(USDINR);
    vi.stubEnv("USD_INR_RATE", "83.25");
    expect(fx.usdInr()).toBe(83.25);
    vi.stubEnv("USD_INR_RATE", "5");
    expect(fx.usdInr()).toBe(USDINR);
    vi.stubEnv("USD_INR_RATE", "");
  });
});

describe("the Alpaca client", () => {
  it("returns candles and quotes in rupees", async () => {
    const fx = await import("../../server/fx");
    const alpacaClient = await import("../../server/alpaca");
    fx._setUsdInr(USDINR, now);
    const rows = await alpacaClient.fetchUsCandles(["AAPL.US"], "5Min", now - 60 * 60_000, now);
    const last = rows["AAPL.US"].at(-1) as number[];
    expect(last[4]).toBeCloseTo(usdAt(now) * USDINR, 6);
    const snaps = await alpacaClient.fetchUsSnapshots(["AAPL.US"]);
    expect(snaps["AAPL.US"]).toMatchObject({ price: usdAt(now) * USDINR, bidSize: 300, askSize: 200 });
    expect(snaps["AAPL.US"].ask! - snaps["AAPL.US"].bid!).toBeCloseTo(0.04 * USDINR, 6);
    // The free IEX feed, with the keys in headers (never in the URL).
    expect(calls.every((c) => c.includes("feed=iex") && !c.includes("secret"))).toBe(true);
  });

  it("keeps only regular-session candles: Alpaca's pre-market and after-hours ones are left out", async () => {
    const fx = await import("../../server/fx");
    const alpacaClient = await import("../../server/alpaca");
    fx._setUsdInr(USDINR, now);
    const day = 24 * 60 * 60_000;
    const five = (await alpacaClient.fetchUsCandles(["AAPL.US"], "5Min", now - day, now))["AAPL.US"] as number[][];
    // The stub answers around the clock. 11:00 yesterday to 11:00 today (New
    // York) holds one session's 78 five-minute candles, plus the one opening now.
    expect(five.length).toBe(79);
    expect(five.every(([t]) => isUsOpen(t))).toBe(true);
    const hours = (await alpacaClient.fetchUsCandles(["AAPL.US"], "1Hour", now - day, now))["AAPL.US"] as number[][];
    const nyHour = (t: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(t));
    // 9:00 (it holds the 9:30 open) to 15:00 New York: 8:00 and 16:00 are out.
    expect([...new Set(hours.map(([t]) => nyHour(t)))].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15]);
  });

  it("won't price anything without a rate, and says when the keys are refused", async () => {
    const alpacaClient = await import("../../server/alpaca");
    await expect(alpacaClient.fetchUsSnapshots(["AAPL.US"])).rejects.toThrow(/No USD\/INR rate/);
    (await import("../../server/fx"))._setUsdInr(USDINR, now);
    alpacaDown = true;
    await expect(alpacaClient.fetchUsSnapshots(["AAPL.US"])).rejects.toThrow(/refused the keys/);
    expect(alpacaClient.alpacaStatus().lastError).toMatch(/refused the keys/);
  });
});

describe("the traders' replay", () => {
  it("counts a stock setup only in the hours the live scanner takes trades, so none is judged across the night", async () => {
    const { takesEntriesAt, panelSetupsOnHistory, LAB_INTERVAL_MS } = await import("../../src/services/labSimulation");
    const { toClosedBars } = await import("../../src/services/liveMarketStreamService");
    const { decorateBarsWithIndicators } = await import("../../src/services/marketDataService");
    // Coins any time; US stocks 9:30 to 3:30 New York; Indian stocks 9:15 to 3:00 IST.
    expect(takesEntriesAt("SOL/INR", Date.parse("2026-09-26T03:00:00Z"))).toBe(true);
    expect(takesEntriesAt("AAPL.US", Date.parse("2026-09-24T19:25:00Z"))).toBe(true);
    expect(takesEntriesAt("AAPL.US", Date.parse("2026-09-24T19:35:00Z"))).toBe(false);
    expect(takesEntriesAt("AAPL.US", Date.parse("2026-09-24T12:00:00Z"))).toBe(false);
    expect(takesEntriesAt("SBIN", Date.parse("2026-09-24T09:25:00Z"))).toBe(true);
    expect(takesEntriesAt("SBIN", Date.parse("2026-09-24T09:35:00Z"))).toBe(false);

    const fx = await import("../../server/fx");
    const alpacaClient = await import("../../server/alpaca");
    fx._setUsdInr(USDINR, now);
    const rows = (await alpacaClient.fetchUsCandles(["AAPL.US"], "5Min", now - 7 * 24 * 60 * 60_000, now))["AAPL.US"];
    const bars = decorateBarsWithIndicators(toClosedBars(rows, FIVE, now));
    const entryAt = (i: number) => (bars[i].timestampMs as number) + LAB_INTERVAL_MS;
    // The history has candles after 3:30 (and the night after them)...
    expect(bars.some((_, i) => !usTakesEntries(entryAt(i)))).toBe(true);
    // ...but every setup counted opens when a live one could.
    const found = panelSetupsOnHistory("AAPL.US", bars);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(({ i }) => usTakesEntries(entryAt(i)))).toBe(true);
  });
});

describe("US stocks on the server", () => {
  const desk = {
    equity: 100000,
    riskLimits: {
      maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.5,
      marketLimits: {
        coins: { amountPerTradeInr: 5000, maxOpenTrades: 2 },
        stocks: { amountPerTradeInr: 5000, maxOpenTrades: 2 },
        us: { amountPerTradeInr: 50000, maxOpenTrades: 2 },
      },
    },
    dailyRealizedPnl: 0, autopilot: true, tradingMode: "PAPER" as const, killSwitch: false, scanning: true,
    failureState: {
      simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
      simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
    },
    quarantines: {}, promotedModel: null,
  };

  beforeEach(async () => {
    (await import("../../server/scanner/scannerService"))._resetServerScanner();
    (await import("../../server/scanner/deskState"))._resetDeskStates();
    (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
    (await import("../../server/guardian"))._resetGuardian();
    (await import("../../server/quotes"))._resetQuotes();
    (await import("../../server/usPrices"))._resetUsPrices();
  });

  it("scans US stocks during US hours, and autopilot buys at the ask, in rupees", async () => {
    const { setDeskState } = await import("../../server/scanner/deskState");
    const { runScanCycle, reportsSince, scannerStatus } = await import("../../server/scanner/scannerService");
    const { pollUsPrices } = await import("../../server/usPrices");
    setDeskState("owner", desk, now);
    // Quotes are polled every few seconds, so the scan has them.
    (await import("../../server/fx"))._setUsdInr(USDINR, now);
    expect(await pollUsPrices(now)).toBe(31);
    await runScanCycle(now);
    expect(scannerStatus("owner", now).usStocks).toBe(31);
    const outcomes = reportsSince("owner", 0).flatMap((r) => r.outcomes).filter((o) => isUsSymbol(o.symbol));
    expect(outcomes.length).toBeGreaterThan(0);
    const { daemonPositions } = await import("../../server/guardian");
    const opened = [...daemonPositions.values()].filter((p) => isUsSymbol(p.symbol));
    expect(opened.length).toBeGreaterThan(0);
    for (const p of opened) {
      expect(p.direction).toBe("LONG");
      expect(p.entryPrice).toBeCloseTo((usdAt(now) + 0.02) * USDINR, 4);
      expect(p.expectedHoldingTimeMinutes).toBe(30);
    }
  });

  it("judges US positions on the bid, and records the spread for the replay", async () => {
    const guardian = await import("../../server/guardian");
    const { pollUsPrices } = await import("../../server/usPrices");
    const { typicalSpread, recordSpread } = await import("../../server/scanner/scannerService");
    (await import("../../server/fx"))._setUsdInr(USDINR, now);
    guardian.daemonPositions.set("u1", {
      id: "u1", userId: "owner", symbol: "AAPL.US", direction: "LONG", entryPrice: 20950, currentPrice: 20950,
      quantity: 1, stopLoss: 20000, takeProfit: 30000, openTime: new Date(now).toISOString(), expectedHoldingTimeMinutes: 30,
    });
    await pollUsPrices(now);
    expect(guardian.daemonPositions.get("u1")!.currentPrice).toBeCloseTo((usdAt(now) - 0.02) * USDINR, 4);
    const spread = typicalSpread("AAPL.US")!;
    expect(spread).toBeCloseTo(0.04 / usdAt(now), 6);
    // A US stock never read stands in with the US spread, not a coin's or an Indian stock's.
    recordSpread("SOL/INR", 0.006);
    recordSpread("SBIN", 0.0002);
    expect(typicalSpread("NVDA.US")).toBeCloseTo(spread, 9);
  });

  it("does nothing outside US hours but load candles once after a restart", async () => {
    const { setDeskState } = await import("../../server/scanner/deskState");
    const { runScanCycle, reportsSince } = await import("../../server/scanner/scannerService");
    const { pollUsPrices } = await import("../../server/usPrices");
    const saturday = Date.parse("2026-09-26T15:00:00Z");
    setDeskState("owner", desk, saturday);
    await runScanCycle(saturday);
    expect(calls.filter((c) => c.includes("timeframe=5Min")).length).toBe(1);
    expect(reportsSince("owner", 0).flatMap((r) => r.outcomes).some((o) => isUsSymbol(o.symbol))).toBe(false);
    expect(await pollUsPrices(saturday)).toBe(0);
    await runScanCycle(saturday + FIVE);
    expect(calls.filter((c) => c.includes("timeframe=5Min")).length).toBe(1);
  });
});
