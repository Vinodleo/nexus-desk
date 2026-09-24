import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pickTopCoins } from "../../src/shared/coinUniverse";
import { mergeBars } from "../../src/services/liveMarketStreamService";
import { getSymbolConfig } from "../../src/services/marketDataService";

const tick = (market: string, volume: number, last_price = 10) => ({ market, volume: String(volume), last_price: String(last_price) });

describe("picking the most traded coins", () => {
  it("ranks INR coins by 24-hour rupee volume and caps the list", () => {
    const tickers = [tick("BTCINR", 9e8), tick("PEPEINR", 5e8), tick("SOLINR", 7e8), tick("ETHINR", 8e8)];
    expect(pickTopCoins(tickers, { size: 3 }).map((c) => c.symbol)).toEqual(["BTC/INR", "ETH/INR", "SOL/INR"]);
  });

  it("leaves out stablecoins, other quote currencies, quiet and inactive markets", () => {
    const tickers = [
      tick("USDTINR", 9e9),
      tick("BTCUSDT", 9e9),
      tick("DOGEINR", 500), // below ₹10 lakh a day
      tick("DEADINR", 9e8, 0), // no price
      tick("OLDINR", 9e8),
      tick("SOLINR", 7e8),
      { market: "BAD-INR", volume: "9e9", last_price: "1" },
    ];
    const coins = pickTopCoins(tickers, { activeMarkets: new Set(["SOLINR", "DOGEINR", "DEADINR"]) });
    expect(coins).toEqual([{ symbol: "SOL/INR", volumeInr: 7e8 }]);
    expect(pickTopCoins("nope")).toEqual([]);
  });
});

describe("coins outside the fixed list", () => {
  it("get their own config instead of Bitcoin's", () => {
    expect(getSymbolConfig("PEPE/INR")).toMatchObject({ symbol: "PEPE/INR", assetClass: "crypto", correlatedGroup: "CRYPTO_ALT" });
    expect(getSymbolConfig("BTC/INR").name).toBe("Bitcoin / INR");
  });
});

describe("merging fresh candles", () => {
  const bar = (t: number, close: number) => ({ time: "", timestampMs: t, open: close, high: close, low: close, close, volume: 1 });
  it("replaces candles with the same time, adds new ones and keeps the newest", () => {
    const merged = mergeBars([bar(1, 1), bar(2, 2), bar(3, 3)], [bar(3, 30), bar(4, 4)], 3);
    expect(merged.map((b) => [b.timestampMs, b.close])).toEqual([[2, 2], [3, 30], [4, 4]]);
  });
});

describe("GET /api/coindcx/universe", () => {
  let base: string;
  let server: Server;
  const ticker = vi.fn();
  const details = vi.fn();

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://public.coindcx.com/exchange/ticker")) return ticker();
      if (u.startsWith("https://api.coindcx.com/exchange/v1/markets_details")) return details();
      return realFetch(url, init);
    });
    const { router } = await import("../../server/routes/coindcx");
    const app = express();
    app.use(router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    (await import("../../server/coinUniverse"))._resetCoinUniverse();
    (await import("../../server/coindcxTicker")).resetTickerCache();
    (await import("../../server/marketRules"))._resetMarketRulesCache();
    ticker.mockReset();
    details.mockReset();
  });

  afterAll(() => {
    server?.close();
    vi.unstubAllGlobals();
  });

  it("lists the top coins from CoinDCX's ticker", async () => {
    ticker.mockImplementation(async () => new Response(JSON.stringify([tick("ETHINR", 8e8), tick("BTCINR", 9e8), tick("USDTINR", 9e9)])));
    details.mockImplementation(async () => new Response("down", { status: 503 }));
    const body = await (await fetch(`${base}/api/coindcx/universe`)).json();
    expect(body.fallback).toBe(false);
    expect(body.coins.map((c: { symbol: string }) => c.symbol)).toEqual(["BTC/INR", "ETH/INR"]);
  });

  it("falls back to the default coins when the ticker can't be read", async () => {
    ticker.mockImplementation(async () => new Response("down", { status: 503 }));
    details.mockImplementation(async () => new Response("down", { status: 503 }));
    const body = await (await fetch(`${base}/api/coindcx/universe`)).json();
    expect(body.fallback).toBe(true);
    expect(body.coins.map((c: { symbol: string }) => c.symbol)).toContain("BTC/INR");
  });
});
