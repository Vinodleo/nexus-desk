import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePositionRecord } from "../../server/liveExecution";
import type { LiveTestDeps } from "../../server/liveTest";
import { _resetLiveTest, liveTestStatus, sellLiveTest, startLiveTest } from "../../server/liveTest";
import { liveTestLines, type LiveTestRun } from "../../src/shared/liveTest";

// The live test order: one small real CoinDCX buy and its sale, through the
// same checks and exit every live trade takes, reading the balances around
// each to see where the fee comes from.

let dir: string;
const NOW = Date.parse("2026-10-06T10:00:00Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-live-test-"));
  _resetLiveTest();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const cfg = (over: Partial<ReturnType<LiveTestDeps["config"]>> = {}) => ({
  enabled: true,
  allowedMarkets: new Set(["SOLINR", "BTCINR"]),
  maxOrderNotionalInr: 5000,
  maxDailyNotionalInr: 20000,
  maxDailyOrders: 10,
  maxPriceDeviationPct: 1,
  ...over,
});

/** A pretend CoinDCX: 10,000 rupees, SOL at 20,000. */
function fake(over: Partial<LiveTestDeps> = {}) {
  const held: Record<string, number> = { INR: 10000, SOL: 0 };
  const records: Record<string, LivePositionRecord> = {};
  const deps: LiveTestDeps = {
    now: () => NOW,
    dir: () => dir,
    keys: () => true,
    config: () => cfg(),
    price: async () => 20000,
    balances: async () => ({ ...held }),
    placeEntry: vi.fn(async (req) => {
      const quantity = Number(req.quantity.toFixed(4));
      // CoinDCX takes 0.2% in coins.
      held.INR -= quantity * 20010;
      held.SOL += quantity * 0.998;
      records[req.positionId] = {
        positionId: req.positionId, userId: req.userId, market: "SOLINR", entrySide: "buy", quantity, entryOrderId: "b1",
        entryClientOrderId: `nx_open_${req.positionId}`, openedAt: new Date(NOW).toISOString(), status: "OPEN", exitAttempts: 0,
      };
      return { ok: true as const, orderId: "b1", quantity };
    }),
    exit: vi.fn(async (id: string) => {
      const rec = records[id];
      held.SOL -= rec.quantity;
      held.INR += rec.quantity * 19990;
      Object.assign(rec, { status: "CLOSED", exitClientOrderId: "nx_exit_x", exitOrderId: "s1", closedAt: new Date(NOW + 60_000).toISOString() });
      return rec;
    }),
    record: (id) => records[id],
    status: vi.fn(async (ref) => ({ state: "found" as const, status: "filled", orderId: ref.orderId, avgPrice: ref.orderId === "s1" ? 19990 : 20010 })),
    wait: async () => {},
    ...over,
  };
  return { deps, held, records };
}

describe("the live test order", () => {
  it("refuses before any money moves: no keys, live trading off, a coin not allowed, too little at CoinDCX", async () => {
    const off = fake({ keys: () => false });
    expect(await startLiveTest("u1", "SOLINR", off.deps)).toMatchObject({ ok: false, error: expect.stringContaining("No CoinDCX keys") });
    const disabled = fake({ config: () => cfg({ enabled: false }) });
    expect(await startLiveTest("u1", "SOLINR", disabled.deps)).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("LIVE_TRADING_ENABLED") });
    const notAllowed = fake();
    expect(await startLiveTest("u1", "DOGEINR", notAllowed.deps)).toMatchObject({ ok: false, error: "DOGEINR isn't on LIVE_ALLOWED_MARKETS." });
    // ₹100 isn't enough for a ₹200 order and its fee.
    const poor = fake();
    poor.held.INR = 100;
    expect(await startLiveTest("u1", "SOLINR", poor.deps)).toMatchObject({ ok: false, error: "CoinDCX has ₹100.00; the test needs about ₹205 (₹200 and the fee)." });
    for (const f of [off, disabled, notAllowed, poor]) expect(f.deps.placeEntry).not.toHaveBeenCalled();
  });

  it("buys ₹200 through the live path and sees where the fee came from", async () => {
    const { deps } = fake();
    const result = await startLiveTest("u1", "SOL/INR", deps);
    expect(deps.placeEntry).toHaveBeenCalledWith({ userId: "u1", positionId: `livetest-${NOW}`, symbol: "SOLINR", side: "buy", quantity: 0.01, price: 20000 });
    expect(result).toMatchObject({
      ok: true,
      run: { status: "BOUGHT", market: "SOLINR", coin: "SOL", quantity: 0.01, buyOrderId: "b1", buyPrice: 20010, coinReceived: 0.00998, inrSpent: 200.1 },
    });
    // A second test waits until this one is sold.
    expect(await startLiveTest("u1", "SOLINR", deps)).toMatchObject({ ok: false, status: 409 });
    expect(deps.placeEntry).toHaveBeenCalledTimes(1);
  });

  it("sells through the server's live exit and reports what came back", async () => {
    const { deps } = fake();
    await startLiveTest("u1", "SOLINR", deps);
    const sold = await sellLiveTest("u1", deps);
    expect(deps.exit).toHaveBeenCalledWith(`livetest-${NOW}`, "TEST_ORDER");
    expect(sold).toMatchObject({ ok: true, run: { status: "SOLD", sellPrice: 19990, inrReceived: 199.9 } });
    // Sold: a new test can run, and selling again sends nothing.
    await sellLiveTest("u1", deps);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it("shows a refused sale while the server keeps trying, then that it failed", async () => {
    const f = fake();
    f.deps.exit = vi.fn(async (id: string) => Object.assign(f.records[id], { status: "EXIT_PENDING", lastError: "Insufficient funds" }));
    await startLiveTest("u1", "SOLINR", f.deps);
    expect(await sellLiveTest("u1", f.deps)).toMatchObject({ ok: true, run: { status: "SELLING", error: "Insufficient funds" } });
    // The server's retries give up.
    f.records[`livetest-${NOW}`].status = "EXIT_FAILED";
    expect(liveTestStatus("u1", f.deps).run).toMatchObject({ status: "SELL_FAILED", error: "Insufficient funds" });
  });

  it("is kept across restarts, and shown only to whoever ran it", async () => {
    const { deps } = fake();
    await startLiveTest("u1", "SOLINR", deps);
    _resetLiveTest();
    expect(liveTestStatus("u1", deps)).toMatchObject({ keys: true, liveEnabled: true, markets: ["SOLINR", "BTCINR"], amountInr: 200, run: { status: "BOUGHT", coin: "SOL" } });
    expect(liveTestStatus("u2", deps).run).toBeNull();
    expect(await sellLiveTest("u2", deps)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the test's result in words", () => {
  const run: LiveTestRun = { positionId: "p", market: "SOLINR", coin: "SOL", status: "BOUGHT", quantity: 0.01, boughtAt: "", buyOrderId: "b1", buyPrice: 20010, coinReceived: 0.00998, inrSpent: 200.1 };

  it("says whether the fee came out of the coins or rupees", () => {
    expect(liveTestLines(run)).toEqual([
      "Bought 0.01 SOL at ₹20,010.00 (₹200.10 spent with the fee).",
      "CoinDCX holds 0.00998 of it, 0.20% less: the fee came out of the coins, so a sale of the whole 0.01 may be refused.",
    ]);
    expect(liveTestLines({ ...run, coinReceived: 0.01 })[1]).toBe("CoinDCX holds all 0.01: the fee came out of rupees, so sales of the whole quantity work.");
  });

  it("says how the sale went", () => {
    expect(liveTestLines({ ...run, status: "SOLD", sellPrice: 19990, inrReceived: 199.9 }).slice(2)).toEqual([
      "Sold at ₹19,990.00: ₹199.90 back.",
      "The test cost ₹0.20 (fees, spread and the price move).",
    ]);
    expect(liveTestLines({ ...run, status: "SELLING", error: "Insufficient funds" })[2]).toBe(
      "The sale was refused (Insufficient funds). The server keeps trying; if it doesn't go through, sell it on CoinDCX by hand."
    );
    expect(liveTestLines({ ...run, status: "SELL_FAILED", error: "Insufficient funds" })[2]).toBe("The sale failed (Insufficient funds). Sell it on CoinDCX by hand.");
  });
});
