import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Years of 5-minute candles for the history replay: coins from Binance page
// by page, US stocks from Alpaca and Indian ones from Angel One in pieces.

const angel = vi.hoisted(() => ({ fetchStockCandles: vi.fn() }));
const alpaca = vi.hoisted(() => ({ fetchUsCandles: vi.fn(), fetchUsDailyBars: vi.fn() }));
vi.mock("../../server/angelOne", () => angel);
vi.mock("../../server/alpaca", () => alpaca);

const { fetchCoinHistory, fetchNseDaily, fetchNseHistory, fetchUsDaily, fetchUsHistory, binancePair, _resetHistoryCandles } = await import("../../server/history/historyCandles");

const FIVE = 5 * 60_000;
const DAY = 24 * 3_600_000;
const noPause = async () => {};

/** Binance, stubbed: BTCUSDT from `listedAt`, 1,000 candles a page; any other pair is unknown. */
const listedAt = Date.parse("2025-01-01T00:00:00Z");
let calls: string[] = [];
let dataApiDown = false;
function binance(url: URL): Response {
  const pair = url.searchParams.get("symbol");
  if (pair !== "BTCUSDT") return new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 });
  const start = Math.max(listedAt, Math.ceil(Number(url.searchParams.get("startTime")) / FIVE) * FIVE);
  const end = Number(url.searchParams.get("endTime"));
  const rows: unknown[] = [];
  for (let t = start; t <= end && rows.length < Number(url.searchParams.get("limit")); t += FIVE) {
    rows.push([t, "100.0", "101.0", "99.0", "100.5", "12.5", t + FIVE - 1, "0", 10, "0", "0", "0"]);
  }
  return new Response(JSON.stringify(rows));
}

beforeEach(() => {
  calls = [];
  dataApiDown = false;
  _resetHistoryCandles();
  angel.fetchStockCandles.mockReset();
  alpaca.fetchUsCandles.mockReset();
  alpaca.fetchUsDailyBars.mockReset();
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(String(input));
    calls.push(url.host);
    if (dataApiDown && url.host === "data-api.binance.vision") throw new Error("fetch failed");
    return binance(url);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("coin history from Binance", () => {
  it("pages forward from the coin's listing to the end, one candle per time", async () => {
    expect(binancePair("BTC/INR")).toBe("BTCUSDT");
    const to = listedAt + 5 * DAY;
    const got = await fetchCoinHistory("BTC/INR", listedAt - 30 * DAY, to, noPause);
    if ("error" in got) throw new Error(got.error);
    const { t, c } = got.series;
    // Five days of 5-minute candles that closed by `to`.
    expect(t.length).toBe((5 * DAY) / FIVE);
    expect(t[0]).toBe(listedAt);
    expect(t[t.length - 1]).toBe(to - FIVE);
    expect(t.every((x, k) => k === 0 || x - t[k - 1] === FIVE)).toBe(true);
    expect(c[0]).toBe(100.5);
    // 1,440 candles: one full page, then the rest.
    expect(calls.length).toBe(2);
  });

  it("falls back to Binance's main address, and says when a coin isn't listed there", async () => {
    dataApiDown = true;
    const got = await fetchCoinHistory("BTC/INR", listedAt, listedAt + DAY, noPause);
    expect("series" in got && got.series.t.length).toBe(DAY / FIVE);
    expect(calls).toEqual(["data-api.binance.vision", "api.binance.com"]);
    expect(await fetchCoinHistory("WIF/INR", listedAt, listedAt + DAY, noPause)).toEqual({ error: "WIFUSDT isn't on Binance" });
  });
});

describe("stock history", () => {
  it("fetches US stocks from Alpaca 120 days at a time", async () => {
    alpaca.fetchUsCandles.mockImplementation(async (symbols: string[], _tf: string, from: number) => ({
      [symbols[0]]: [[from + 13.5 * 3_600_000, 20000, 20100, 19900, 20050, 300]],
    }));
    const from = Date.parse("2025-01-01T00:00:00Z");
    const got = await fetchUsHistory("AAPL.US", from, from + 300 * DAY, noPause);
    expect("series" in got && got.series.t.length).toBe(3);
    expect(alpaca.fetchUsCandles.mock.calls.map((c) => [(c[2] - from) / DAY, (c[3] - from) / DAY])).toEqual([[0, 120], [120, 240], [240, 300]]);
    alpaca.fetchUsCandles.mockRejectedValue(new Error("No USD/INR rate yet, so US prices can't be shown in rupees"));
    expect(await fetchUsHistory("AAPL.US", from, from + DAY, noPause)).toEqual({ error: "No USD/INR rate yet, so US prices can't be shown in rupees" });
  });

  it("fetches Indian stocks from Angel One 90 days at a time, skipping pieces it has nothing for", async () => {
    const from = Date.parse("2024-10-01T00:00:00Z");
    angel.fetchStockCandles.mockImplementation(async (_s: string, _i: string, start: number) => {
      if (start < from + 180 * DAY) throw new Error("Angel One getCandleData: No data found (AB2001)");
      return [["2025-05-02T09:15:00+05:30", 1400, 1406, 1398, 1405, 30000]];
    });
    const got = await fetchNseHistory("RELIANCE", from, from + 365 * DAY);
    expect("series" in got && got.series.t).toEqual([Date.parse("2025-05-02T03:45:00Z")]);
    expect(angel.fetchStockCandles).toHaveBeenCalledTimes(5);

    // Being asked to slow down stops it (to try again later), as does nothing at all.
    angel.fetchStockCandles.mockReset().mockRejectedValue(new Error("Angel One asked to slow down; historical requests resume in 60s."));
    expect(await fetchNseHistory("RELIANCE", from, from + 365 * DAY)).toEqual({ error: "Angel One asked to slow down; historical requests resume in 60s." });
    expect(angel.fetchStockCandles).toHaveBeenCalledTimes(1);
    angel.fetchStockCandles.mockReset().mockRejectedValue(new Error("Angel One getCandleData: No data found (AB2001)"));
    expect(await fetchNseHistory("RELIANCE", from, from + 100 * DAY)).toEqual({ error: "Angel One getCandleData: No data found (AB2001)" });
  });

  it("fetches daily stock candles for the stocks' long replay: US in one go, India 1,800 days at a time", async () => {
    const from = Date.UTC(2015, 0, 1);
    const to = Date.UTC(2026, 9, 3);
    // Alpaca's daily candles start at New York's midnight; today's, still open, is left out.
    alpaca.fetchUsDailyBars.mockResolvedValue([
      [Date.parse("2016-01-04T05:00:00Z"), 100, 102, 99, 101, 1000],
      [Date.parse("2026-10-03T04:00:00Z"), 200, 201, 199, 200, 1000],
    ]);
    const us = await fetchUsDaily("AAPL.US", from, to);
    expect("series" in us && us.series.t).toEqual([Date.parse("2016-01-04T05:00:00Z")]);
    alpaca.fetchUsDailyBars.mockResolvedValue([]);
    expect(await fetchUsDaily("META.US", from, to)).toEqual({ error: "Alpaca has no daily candles for META" });
    alpaca.fetchUsDailyBars.mockRejectedValue(new Error("Alpaca refused the keys: check ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY"));
    expect(await fetchUsDaily("AAPL.US", from, to)).toEqual({ error: "Alpaca refused the keys: check ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY" });

    // Angel One: the first piece is before it has candles; the rest come.
    angel.fetchStockCandles.mockImplementation(async (_s: string, interval: string, start: number) => {
      expect(interval).toBe("ONE_DAY");
      if (start === from) throw new Error("Angel One getCandleData: No data found (AB2001)");
      return [["2021-06-01T00:00:00+05:30", 2100, 2120, 2090, 2110, 50000]];
    });
    const nse = await fetchNseDaily("RELIANCE", from, to);
    expect("series" in nse && nse.series.t).toEqual([Date.parse("2021-05-31T18:30:00Z")]);
    expect(angel.fetchStockCandles.mock.calls.map((c) => Math.round((c[2] - from) / DAY))).toEqual([0, 1800, 3600]);
    angel.fetchStockCandles.mockReset().mockRejectedValue(new Error("HDFC isn't listed at Angel One"));
    expect(await fetchNseDaily("HDFC", from, to)).toEqual({ error: "HDFC isn't listed at Angel One" });
    expect(angel.fetchStockCandles).toHaveBeenCalledTimes(1);
  });
});
