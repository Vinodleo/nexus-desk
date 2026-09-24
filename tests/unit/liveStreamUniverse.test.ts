// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketBar } from "../../src/types";

// The stream scans the coins the server picks (CoinDCX's most traded INR
// coins), not a fixed list, and the scanner handles coins outside it.

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({
  apiFetch: (url: string) => apiFetch(url),
  authenticateSocket: vi.fn(),
}));

const FIVE_MIN = 5 * 60 * 1000;
const candles = (base: number) => {
  const formingOpen = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN;
  return Array.from({ length: 120 }, (_, i) => {
    const p = base + i;
    return { time: formingOpen - i * FIVE_MIN, open: p, high: p + 1, low: p - 1, close: p, volume: 5 };
  });
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
  vi.stubGlobal("WebSocket", class { close() {} send() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("coin list from the server", () => {
  it("loads candles for the server's coins and reports only those", async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/coindcx/universe") {
        return new Response(
          JSON.stringify({ coins: [{ symbol: "BTC/INR", volumeInr: 9e8 }, { symbol: "PEPE/INR", volumeInr: 5e8 }], updatedAt: 1, fallback: false })
        );
      }
      if (url.startsWith("/api/coindcx/candles?symbol=BTC&interval=5m")) return new Response(JSON.stringify(candles(5_000_000)));
      if (url.startsWith("/api/coindcx/candles?symbol=PEPE&interval=5m")) return new Response(JSON.stringify(candles(1)));
      return new Response("unavailable", { status: 503 });
    });
    const { liveMarketStream } = await import("../../src/services/liveMarketStreamService");
    await liveMarketStream.initialize();

    expect(liveMarketStream.getCryptoSymbols()).toEqual(["BTC/INR", "PEPE/INR"]);
    expect(liveMarketStream.getUniverseInfo()).toMatchObject({ count: 2, fallback: false });
    expect(liveMarketStream.getBars("PEPE/INR")).toHaveLength(119);
    expect(liveMarketStream.getBars("ETH/INR")).toBeNull(); // not on the list, not fetched
    expect(liveMarketStream.getCandleStatus().map((s) => s.symbol)).toEqual(["BTC/INR", "PEPE/INR"]);
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes("symbol=ETH"))).toBe(false);
  });

  it("scans a coin outside the fixed list", async () => {
    const { scanAllMarkets, _resetScannedCandles } = await import("../../src/services/marketScannerService");
    _resetScannedCandles();
    const lastOpen = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
    const trend: MarketBar[] = Array.from({ length: 150 }, (_, i) => {
      const c = 10000 + i * 8;
      return { time: String(i), timestampMs: lastOpen - (149 - i) * FIVE_MIN, open: c - 2, high: c + 4, low: c - 4, close: c, volume: 100 + i };
    });
    const report = await scanAllMarkets({
      symbols: ["PEPE/INR", "not a coin"],
      barsMap: { "PEPE/INR": trend },
      activePositions: [],
      dailyRealizedPnl: 0,
      experiences: [],
      failureState: {
        globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
        simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
      },
    });
    expect(report.outcomes).toEqual([{ symbol: "PEPE/INR", proposed: true }]);
    expect(report.newProposals[0].symbol).toBe("PEPE/INR");
  });
});
