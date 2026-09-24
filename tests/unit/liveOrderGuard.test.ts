import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Guard = typeof import("../../server/liveOrderGuard");
let guard: Guard;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-guard-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.stubEnv("LIVE_TRADING_ENABLED", "true");
  vi.resetModules();
  guard = await import("../../server/liveOrderGuard");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const order = (over: Partial<Parameters<Guard["evaluateLiveOrder"]>[0]> = {}) => ({
  market: "BTCINR",
  side: "buy" as const,
  quantity: 1,
  clientPrice: 1000,
  referencePrice: 1000,
  ...over,
});

describe("isLiveOrderRequest", () => {
  it.each([
    [{ isPaperTrade: false, confirmLiveOrder: true }, true],
    [{ isPaperTrade: false }, false],
    [{ confirmLiveOrder: true }, false],
    [{ isPaperTrade: "false", confirmLiveOrder: "true" }, false],
    [{ isPaperTrade: 0, confirmLiveOrder: 1 }, false],
    [{ isPaperTrade: true, confirmLiveOrder: true }, false],
    [{}, false],
    [null, false],
    ["live", false],
  ])("%j -> %s", (body, expected) => {
    expect(guard.isLiveOrderRequest(body)).toBe(expected);
  });
});

describe("evaluateLiveOrder", () => {
  it("rejects everything new when live trading is disabled", () => {
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    expect(guard.evaluateLiveOrder(order())).toMatchObject({ status: "rejected", code: "LIVE_DISABLED" });
  });

  it.each([
    ["market not allowed", { market: "DOGEINR" }, "MARKET_NOT_ALLOWED"],
    ["zero quantity", { quantity: 0 }, "BAD_QUANTITY"],
    ["NaN quantity", { quantity: NaN }, "BAD_QUANTITY"],
    ["no reference price", { referencePrice: undefined }, "NO_REFERENCE_PRICE"],
    ["price 2% off", { clientPrice: 1020 }, "PRICE_DEVIATION"],
    ["over per-order cap", { quantity: 6 }, "ORDER_NOTIONAL_CAP"],
  ])("rejects: %s", (_n, over, code) => {
    expect(guard.evaluateLiveOrder(order(over))).toMatchObject({ status: "rejected", code });
  });

  it("enforces the daily notional cap", () => {
    for (let i = 0; i < 5; i++) {
      const d = guard.evaluateLiveOrder(order({ quantity: 4 }));
      expect(d.status).toBe("accepted");
      if (d.status === "accepted") guard.recordLiveOrder("BTCINR", "buy", 4, d.notionalInr, d.isReducing);
    }
    expect(guard.evaluateLiveOrder(order({ quantity: 4 }))).toMatchObject({ code: "DAILY_NOTIONAL_CAP" });
  });

  it("enforces the daily order-count cap", () => {
    vi.stubEnv("LIVE_MAX_DAILY_ORDERS", "2");
    for (let i = 0; i < 2; i++) guard.recordLiveOrder("BTCINR", "buy", 0.1, 100, false);
    expect(guard.evaluateLiveOrder(order({ quantity: 0.1 }))).toMatchObject({ code: "DAILY_ORDER_CAP" });
  });

  it("always lets an exit of a held position through, even disabled and with no price", () => {
    guard.recordLiveOrder("BTCINR", "buy", 3, 3000, false);
    vi.stubEnv("LIVE_TRADING_ENABLED", "false");
    const d = guard.evaluateLiveOrder(order({ side: "sell", quantity: 3, referencePrice: undefined, clientPrice: 5000 }));
    expect(d).toMatchObject({ status: "accepted", isReducing: true });
  });

  it("refuses to sell more than is held: that would be a short on a spot market", () => {
    guard.recordLiveOrder("BTCINR", "buy", 1, 1000, false);
    expect(guard.evaluateLiveOrder(order({ side: "sell", quantity: 2 }))).toMatchObject({ code: "NO_SPOT_SHORT" });
    guard.recordLiveOrder("BTCINR", "sell", 1, 1000, true);
    expect(guard.evaluateLiveOrder(order({ side: "sell", quantity: 1 }))).toMatchObject({ code: "NO_SPOT_SHORT" });
  });

  it("resets daily caps at IST midnight but keeps open quantity", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T18:00:00Z")); // 23:30 IST
    guard.recordLiveOrder("BTCINR", "buy", 4, 20000, false);
    expect(guard.evaluateLiveOrder(order())).toMatchObject({ code: "DAILY_NOTIONAL_CAP" });
    vi.setSystemTime(new Date("2026-01-01T18:31:00Z")); // 00:01 IST next day
    expect(guard.evaluateLiveOrder(order()).status).toBe("accepted");
    expect(guard.liveRiskSnapshot().trackedNetQty).toEqual({ BTCINR: 4 });
  });

  it("persists the ledger across restarts", async () => {
    guard.recordLiveOrder("ETHINR", "buy", 2, 2000, false);
    vi.resetModules();
    const reloaded: Guard = await import("../../server/liveOrderGuard");
    expect(reloaded.liveRiskSnapshot()).toMatchObject({ openedOrdersToday: 1, trackedNetQty: { ETHINR: 2 } });
  });
});

describe("withLiveOrderLock", () => {
  it("runs tasks one at a time, in order, even if one throws", async () => {
    const events: string[] = [];
    const task = (n: number, ms: number, fail = false) =>
      guard.withLiveOrderLock(async () => {
        events.push(`start${n}`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`end${n}`);
        if (fail) throw new Error("boom");
      });
    const results = await Promise.allSettled([task(1, 20, true), task(2, 5), task(3, 1)]);
    expect(events).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
});
