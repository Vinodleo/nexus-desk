// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// initialize() loads each crypto symbol's closed 5-minute candles from
// CoinDCX. The candle still forming is dropped, and a symbol whose candles
// can't be fetched gets no bars at all (the scanner then skips it) rather
// than generated ones.

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({
  apiFetch: (url: string) => apiFetch(url),
  authenticateSocket: vi.fn(),
}));

const FIVE_MIN = 5 * 60 * 1000;
const fiveMinuteCandles = (base: number) => {
  // CoinDCX returns newest first, starting with the candle still forming.
  const formingOpen = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN;
  return Array.from({ length: 120 }, (_, i) => {
    const t = formingOpen - i * FIVE_MIN;
    const p = base + i;
    return { time: t, open: p, high: p + 1, low: p - 1, close: p, volume: 2 + i };
  });
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
  vi.stubGlobal("WebSocket", class { close() {} send() {} });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("market stream", () => {
  it("uses closed 5-minute candles, skips symbols without real data, and reads the ticker", async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/coindcx/ticker") {
        return new Response(JSON.stringify([{ market: "BTCINR", last_price: "5000200", change_24_hour: "1.25" }]));
      }
      if (url.startsWith("/api/coindcx/candles?symbol=BTC&interval=5m")) {
        return new Response(JSON.stringify(fiveMinuteCandles(5_000_000)));
      }
      return new Response("unavailable", { status: 503 });
    });
    const { liveMarketStream } = await import("../../src/services/liveMarketStreamService");
    await liveMarketStream.initialize();

    const btc = liveMarketStream.getBars("BTC/INR")!;
    expect(btc).toHaveLength(119); // the forming candle is dropped
    expect(btc.some((b) => b.isSynthetic)).toBe(false);
    expect(btc[0].timestampMs!).toBeLessThan(btc[btc.length - 1].timestampMs!);
    expect(btc[btc.length - 1].close).toBe(5_000_001); // newest closed candle
    expect(btc[btc.length - 1].volume).toBeGreaterThan(0);

    expect(liveMarketStream.getBars("ETH/INR")).toBeNull();
    // Why ETH has no candles is kept for the Floor to show.
    const eth = liveMarketStream.getCandleStatus().find((s) => s.symbol === "ETH/INR")!;
    expect(eth.bars).toBe(0);
    expect(eth.error).toBeTruthy();
    expect(liveMarketStream.getLastPrice("BTC/INR")).toBe(5_000_200);
    expect(liveMarketStream.dailyChanges.get("BTC/INR")).toBe(1.25);
  });
});

describe("candle helpers", () => {
  // A realistic epoch (Sept 2026), aligned to 5 minutes.
  const T0 = Math.floor(1_790_000_000_000 / FIVE_MIN) * FIVE_MIN;

  it("reads candles given as arrays, or with times in seconds", async () => {
    const { toClosedBars } = await import("../../src/services/liveMarketStreamService");
    const now = T0 + 10 * FIVE_MIN + 1000;
    const bars = toClosedBars(
      [
        [T0 + 9 * FIVE_MIN, "2", "3", "1", "2.5", "10"],
        { time: (T0 + 8 * FIVE_MIN) / 1000, open: 1, high: 2, low: 1, close: 1.5, volume: 4 },
      ],
      FIVE_MIN,
      now
    );
    expect(bars.map((b) => [b.timestampMs, b.close, b.volume])).toEqual([
      [T0 + 8 * FIVE_MIN, 1.5, 4],
      [T0 + 9 * FIVE_MIN, 2.5, 10],
    ]);
  });

  it("keeps only closed candles, oldest first", async () => {
    const { toClosedBars } = await import("../../src/services/liveMarketStreamService");
    const now = T0 + 10 * FIVE_MIN + 1000;
    const bars = toClosedBars(
      [
        { time: T0 + 10 * FIVE_MIN, open: 3, high: 3, low: 3, close: 3, volume: 1 }, // still forming
        { time: T0 + 9 * FIVE_MIN, open: 2, high: 2, low: 2, close: 2, volume: 1 },
        { time: T0 + 8 * FIVE_MIN, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
      FIVE_MIN,
      now
    );
    expect(bars.map((b) => b.close)).toEqual([1, 2]);
  });

  it("schedules the next fetch just after the next candle closes", async () => {
    const { nextCandleFetchAt } = await import("../../src/services/liveMarketStreamService");
    expect(nextCandleFetchAt(T0 + 10 * FIVE_MIN + 1000)).toBe(T0 + 11 * FIVE_MIN + 8000);
  });
});
