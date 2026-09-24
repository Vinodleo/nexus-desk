import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aggregateMinuteCandles } from "../../server/candles";

const MIN = 60 * 1000;
const T0 = Math.floor(1_790_000_000_000 / (5 * MIN)) * (5 * MIN); // a 5-minute boundary

// 1-minute candles, newest first as CoinDCX sends them.
const minutes = (from: number, count: number, skip: number[] = []) =>
  Array.from({ length: count }, (_, i) => from + i)
    .filter((m) => !skip.includes(m))
    .map((m) => ({ time: T0 + m * MIN, open: 100 + m, high: 101 + m, low: 99 + m, close: 100.5 + m, volume: 2 }))
    .reverse();

describe("aggregateMinuteCandles", () => {
  it("combines each five minutes into one candle, newest first", () => {
    const out = aggregateMinuteCandles(minutes(0, 10), 5);
    expect(out).toEqual([
      { time: T0 + 5 * MIN, open: 105, high: 110, low: 104, close: 109.5, volume: 10 },
      { time: T0, open: 100, high: 105, low: 99, close: 104.5, volume: 10 },
    ]);
  });

  it("drops a partial first bucket and keeps the forming last one", () => {
    const out = aggregateMinuteCandles(minutes(2, 10), 5); // minutes 2..11
    expect(out.map((c) => c.time)).toEqual([T0 + 10 * MIN, T0 + 5 * MIN]); // 2..4 dropped; 10..11 still forming
    expect(out[0].volume).toBe(4);
  });

  it("fills a five-minute gap with no trades as a flat candle", () => {
    const out = aggregateMinuteCandles(minutes(0, 15, [5, 6, 7, 8, 9]), 5);
    expect(out[1]).toEqual({ time: T0 + 5 * MIN, open: 104.5, high: 104.5, low: 104.5, close: 104.5, volume: 0 });
  });
});

describe("GET /api/coindcx/candles", () => {
  let base: string;
  let server: Server;
  const upstream = vi.fn();

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).startsWith("https://public.coindcx.com") ? upstream(String(url)) : realFetch(url, init)
    );
    const { router } = await import("../../server/routes/coindcx");
    const app = express();
    app.use(router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    vi.unstubAllGlobals();
  });

  it("builds 5-minute candles from CoinDCX's 1-minute ones", async () => {
    upstream.mockResolvedValueOnce(new Response(JSON.stringify(minutes(0, 20))));
    const res = await fetch(`${base}/api/coindcx/candles?symbol=BTC&interval=5m&limit=3`);
    const body = await res.json();
    expect(upstream.mock.calls[0][0]).toContain("pair=I-BTC_INR&interval=1m&limit=20");
    expect(body.map((c: { time: number }) => c.time)).toEqual([T0 + 15 * MIN, T0 + 10 * MIN, T0 + 5 * MIN]);
  });

  it("passes CoinDCX's error through", async () => {
    upstream.mockResolvedValue(
      new Response(JSON.stringify({ code: 422, message: "interval must be one of [1m, 15m, 1h, 1d]" }), { status: 422 })
    );
    const res = await fetch(`${base}/api/coindcx/candles?symbol=BTC&interval=15m&limit=3`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/HTTP 422 .*interval must be one of/);
  });

  it("rejects intervals CoinDCX doesn't offer for INR", async () => {
    const res = await fetch(`${base}/api/coindcx/candles?symbol=BTC&interval=30m`);
    expect(res.status).toBe(400);
  });
});
