import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CoinDCX's live price feed on the server. Its price-change messages name no
// coin ({"p":"6692306.2","T":…,"pr":"spot"}, as on 17 Nov 2026), so they can't
// be priced; the server said so once a second, 4,193 of the 4,210 warnings in
// the log, which pushed everything else out of it after 80 minutes.

const handlers: Record<string, (data: unknown) => void> = {};
const socket = { connected: false, on: (event: string, fn: (data: unknown) => void) => void (handlers[event] = fn), emit: vi.fn() };
vi.mock("socket.io-client", () => ({ default: () => socket }));
vi.mock("../../server/guardian", () => ({ daemonPositions: new Map(), evaluateDaemonPositions: vi.fn() }));
vi.mock("../../server/coinUniverse", () => ({ getCoinUniverse: async () => ({ coins: [] }) }));
vi.mock("../../server/realtime", () => ({ broadcast: vi.fn(), currentPrices: {} as Record<string, number> }));
vi.mock("../../server/quotes", () => ({ freshQuote: () => false }));

const { startCoinDcxRelay, PRICE_NOTE_EVERY_MS } = await import("../../server/marketRelay");
const { broadcast, currentPrices } = await import("../../server/realtime");

const NOW = Date.parse("2026-11-17T06:34:52Z");
const nameless = (p: string) => ({ event: "price-change", data: JSON.stringify({ p, T: 1794897292000, pr: "spot" }) });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval"], now: NOW });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  startCoinDcxRelay();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const priceNotes = () => warn.mock.calls.filter((c) => String(c[0]).includes("price-change"));

describe("CoinDCX's price feed on the server", () => {
  it("says once an hour, not once a message, that price-change messages name no coin", () => {
    for (let i = 0; i < 100; i++) handlers["price-change"](nameless(String(6_692_306 + i)));
    expect(priceNotes()).toHaveLength(1);
    expect(String(priceNotes()[0][0])).toBe("[CoinDCX WS] price-change messages name no coin, so they're skipped (1 in the last hour). One:");

    vi.setSystemTime(NOW + PRICE_NOTE_EVERY_MS);
    handlers["price-change"](nameless("6700000"));
    expect(priceNotes()).toHaveLength(2);
    expect(String(priceNotes()[1][0])).toBe("[CoinDCX WS] price-change messages name no coin, so they're skipped (100 in the last hour). One:");
  });

  it("still prices a message that names its coin", () => {
    handlers["price-change"]({ event: "price-change", data: JSON.stringify({ s: "I-BTC_INR", p: "6692306.2", T: 1, pr: "spot" }) });
    handlers["new-trade"]({ event: "new-trade", data: JSON.stringify({ s: "I-ETH_INR", p: "250000" }) });
    expect(currentPrices["BTC/INR"]).toBe(6692306.2);
    expect(currentPrices["ETH/INR"]).toBe(250000);
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith({ type: "TICK", data: { "BTC/INR": 6692306.2 }, is24h: true });
    expect(priceNotes()).toHaveLength(0);
  });

  it("says a message it can't read at most once an hour too", () => {
    for (let i = 0; i < 50; i++) handlers["price-change"]("{not json");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("parse error"))).toHaveLength(1);
  });
});
