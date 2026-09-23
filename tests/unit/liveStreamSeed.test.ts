// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// initialize() seeds each symbol's chart. Crypto charts should start from
// CoinDCX's real 1-minute candles; anything that can't be fetched falls back
// to generated bars that are flagged isSynthetic.

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({
  apiFetch: (url: string) => apiFetch(url),
  authenticateSocket: vi.fn(),
}));

const minuteCandles = (base: number) =>
  // CoinDCX returns newest first
  Array.from({ length: 120 }, (_, i) => {
    const t = Date.now() - i * 60000;
    const p = base + i;
    return { time: t, open: p, high: p + 1, low: p - 1, close: p, volume: 2 };
  });

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setInterval"] });
  vi.stubGlobal("WebSocket", class { close() {} send() {} });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live chart seeding", () => {
  it("uses real candles where available and flags generated fallbacks", async () => {
    apiFetch.mockImplementation(async (url: string) => {
      if (url === "/api/coindcx/ticker") {
        return new Response(JSON.stringify([{ market: "BTCINR", last_price: "5000000" }]));
      }
      // Real 1m candles for BTC only; every other symbol's candle fetch fails.
      if (url.startsWith("/api/coindcx/candles?symbol=BTC&interval=1m")) {
        return new Response(JSON.stringify(minuteCandles(5_000_000)));
      }
      return new Response("unavailable", { status: 503 });
    });
    const { liveMarketStream } = await import("../../src/services/liveMarketStreamService");
    await liveMarketStream.initialize();

    const btc = liveMarketStream.getBars("BTC/INR")!;
    expect(btc).toHaveLength(120);
    expect(btc.some((b) => b.isSynthetic)).toBe(false);
    // oldest first, as indicator maths needs
    expect(btc[0].timestampMs!).toBeLessThan(btc[btc.length - 1].timestampMs!);
    expect(btc[btc.length - 1].close).toBe(5_000_000);

    const eth = liveMarketStream.getBars("ETH/INR")!;
    expect(eth.length).toBeGreaterThan(0);
    expect(eth.every((b) => b.isSynthetic)).toBe(true);
  });
});
