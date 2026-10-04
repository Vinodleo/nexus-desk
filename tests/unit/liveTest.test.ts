import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePositionRecord } from "../../server/liveExecution";
import type { LiveTestDeps } from "../../server/liveTest";
import { _liveTestFollowed, _resetLiveTest, BALANCE_READS, liveTestStatus, sellLiveTest, startLiveTest } from "../../server/liveTest";
import { feeFromCoins, liveTestLines, roundTripCost, type LiveTestRun } from "../../src/shared/liveTest";

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

/**
 * A pretend CoinDCX: 10,000 rupees, SOL at 20,000. Its fee comes out of
 * rupees (0.59% a side, 1% TDS on sales), and like the real one its balances
 * show an order only after a few reads (`lag`).
 */
function fake(over: Partial<LiveTestDeps> = {}, lag = 2) {
  const held: Record<string, number> = { INR: 10000, SOL: 0 };
  let shown = { ...held };
  let stale = 0;
  const reads = { count: 0 };
  const records: Record<string, LivePositionRecord> = {};
  const deps: LiveTestDeps = {
    now: () => NOW,
    dir: () => dir,
    keys: () => true,
    config: () => cfg(),
    price: async () => 20000,
    balances: vi.fn(async () => {
      reads.count++;
      if (stale > 0) {
        stale--;
        return { ...shown };
      }
      shown = { ...held };
      return { ...shown };
    }),
    placeEntry: vi.fn(async (req) => {
      const quantity = Number(req.quantity.toFixed(4));
      // 0.01 SOL at 20,010 is ₹200.10, and ₹1.18 of fee and GST.
      held.INR = Number((held.INR - 201.28).toFixed(2));
      held.SOL += quantity;
      stale = lag;
      records[req.positionId] = {
        positionId: req.positionId, userId: req.userId, market: "SOLINR", entrySide: "buy", quantity, entryOrderId: "b1",
        entryClientOrderId: `nx_open_${req.positionId}`, openedAt: new Date(NOW).toISOString(), status: "OPEN", exitAttempts: 0,
      };
      return { ok: true as const, orderId: "b1", quantity };
    }),
    exit: vi.fn(async (id: string) => {
      const rec = records[id];
      // 0.01 SOL at 19,990 is ₹199.90, less ₹1.18 of fee and GST and ₹2.00 TDS.
      held.SOL -= rec.quantity;
      held.INR = Number((held.INR + 196.72).toFixed(2));
      stale = lag;
      Object.assign(rec, { status: "CLOSED", exitClientOrderId: "nx_exit_x", exitOrderId: "s1", closedAt: new Date(NOW + 60_000).toISOString() });
      return rec;
    }),
    record: (id) => records[id],
    status: vi.fn(async (ref) => ({ state: "found" as const, status: "filled", orderId: ref.orderId, avgPrice: ref.orderId === "s1" ? 19990 : 20010 })),
    wait: async () => {},
    ...over,
  };
  return { deps, held, records, reads };
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

  it("buys ₹200 through the live path, then reads CoinDCX's balance until it shows the buy", async () => {
    const { deps, reads } = fake();
    const result = await startLiveTest("u1", "SOL/INR", deps);
    expect(deps.placeEntry).toHaveBeenCalledWith({ userId: "u1", positionId: `livetest-${NOW}`, symbol: "SOLINR", side: "buy", quantity: 0.01, price: 20000 });
    // The app hears at once; the balances follow.
    expect(result).toMatchObject({ ok: true, run: { status: "BOUGHT", market: "SOLINR", coin: "SOL", quantity: 0.01, buyOrderId: "b1", settling: true } });
    // Nothing else while it reads them: no sale, no second test.
    expect(await sellLiveTest("u1", deps)).toMatchObject({ ok: false, status: 409 });
    await _liveTestFollowed();
    // The first two reads still showed the old balance (as CoinDCX's did on the first test): not taken as the buy.
    expect(reads.count).toBe(4);
    expect(liveTestStatus("u1", deps).run).toMatchObject({ buyPrice: 20010, coinReceived: 0.01, inrSpent: 201.28, settling: false });
    expect(await startLiveTest("u1", "SOLINR", deps)).toMatchObject({ ok: false, status: 409 });
    expect(deps.placeEntry).toHaveBeenCalledTimes(1);
  });

  it("says so when CoinDCX's balance never shows the order, rather than guessing", async () => {
    const { deps } = fake({}, 1000);
    await startLiveTest("u1", "SOLINR", deps);
    await _liveTestFollowed();
    const run = liveTestStatus("u1", deps).run!;
    expect(run).toMatchObject({ buyPrice: 20010, settling: false, balanceNote: "CoinDCX's balance didn't show the buy within two minutes: check it on CoinDCX." });
    expect(run.coinReceived).toBeUndefined();
    expect(deps.balances).toHaveBeenCalledTimes(1 + BALANCE_READS);
  });

  it("sells through the server's live exit and reports what came back, once the balance shows it", async () => {
    const { deps } = fake();
    await startLiveTest("u1", "SOLINR", deps);
    await _liveTestFollowed();
    const sold = await sellLiveTest("u1", deps);
    expect(deps.exit).toHaveBeenCalledWith(`livetest-${NOW}`, "TEST_ORDER");
    expect(sold).toMatchObject({ ok: true, run: { status: "SOLD", settling: true } });
    await _liveTestFollowed();
    expect(liveTestStatus("u1", deps).run).toMatchObject({ status: "SOLD", sellPrice: 19990, inrReceived: 196.72, settling: false });
    // Sold: selling again sends nothing.
    await sellLiveTest("u1", deps);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it("shows a refused sale while the server keeps trying, then that it failed", async () => {
    const f = fake();
    f.deps.exit = vi.fn(async (id: string) => Object.assign(f.records[id], { status: "EXIT_PENDING", lastError: "Insufficient funds" }));
    await startLiveTest("u1", "SOLINR", f.deps);
    await _liveTestFollowed();
    expect(await sellLiveTest("u1", f.deps)).toMatchObject({ ok: true, run: { status: "SELLING", error: "Insufficient funds" } });
    // The server's retries give up.
    f.records[`livetest-${NOW}`].status = "EXIT_FAILED";
    expect(liveTestStatus("u1", f.deps).run).toMatchObject({ status: "SELL_FAILED", error: "Insufficient funds" });
  });

  it("follows a sale that goes through on one of the server's retries", async () => {
    const f = fake();
    f.deps.exit = vi.fn(async (id: string) => Object.assign(f.records[id], { status: "EXIT_PENDING", lastError: "Try again" }));
    await startLiveTest("u1", "SOLINR", f.deps);
    await _liveTestFollowed();
    await sellLiveTest("u1", f.deps);
    // A retry sells it.
    Object.assign(f.records[`livetest-${NOW}`], { status: "CLOSED", exitClientOrderId: "nx_exit2_x", exitOrderId: "s1", closedAt: new Date(NOW + 60_000).toISOString() });
    f.held.SOL = 0;
    f.held.INR = Number((f.held.INR + 196.72).toFixed(2));
    expect(liveTestStatus("u1", f.deps).run).toMatchObject({ status: "SOLD", settling: true });
    await _liveTestFollowed();
    expect(liveTestStatus("u1", f.deps).run).toMatchObject({ status: "SOLD", sellPrice: 19990, inrReceived: 196.72, settling: false });
  });

  it("is kept across restarts, and shown only to whoever ran it", async () => {
    const { deps } = fake();
    await startLiveTest("u1", "SOLINR", deps);
    // A restart mid-read: nothing is still reading the balances afterwards, so the test isn't stuck.
    _resetLiveTest();
    expect(liveTestStatus("u1", deps)).toMatchObject({ keys: true, liveEnabled: true, markets: ["SOLINR", "BTCINR"], amountInr: 200, run: { status: "BOUGHT", coin: "SOL", settling: false } });
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

  it("doesn't read a balance that hadn't caught up as a fee (the first test's early read: nothing received, nothing spent)", () => {
    const early: LiveTestRun = { ...run, quantity: 0.00002, coin: "BTC", buyPrice: 8500026.1, coinReceived: 0, inrSpent: 0 };
    expect(feeFromCoins(early)).toBeUndefined();
    expect(liveTestLines(early)).toEqual(["Bought 0.00002 BTC at ₹85,00,026.10."]);
    // Sold, with only the sale's figures: no cost made up from the missing buy.
    expect(liveTestLines({ ...early, status: "SOLD", sellPrice: 8457500.1, inrReceived: 166.47 })).toEqual([
      "Bought 0.00002 BTC at ₹85,00,026.10.",
      "Sold at ₹84,57,500.10: ₹166.47 back.",
    ]);
  });

  it("splits what the round trip cost into fees, TDS and the price move (the first test's figures from CoinDCX)", () => {
    const first: LiveTestRun = { ...run, status: "SOLD", quantity: 0.00002, coin: "BTC", buyPrice: 8500026.1, coinReceived: 0.00002, inrSpent: 171, sellPrice: 8457500.1, inrReceived: 166.47 };
    expect(roundTripCost(first)).toEqual({ total: 4.53, fees: 1.99, tds: 1.69, move: 0.85 });
    expect(liveTestLines(first).slice(2)).toEqual([
      "Sold at ₹84,57,500.10: ₹166.47 back.",
      "The round trip cost ₹4.53: ₹1.99 in fees, ₹1.69 TDS (reclaimed when you file), and the price fell ₹0.85.",
    ]);
    // A rise can pay for it.
    // ₹180.00 sold, less ₹1.06 of fee and GST and ₹1.80 TDS.
    const rose = { ...first, sellPrice: 9000000, inrReceived: 177.14 };
    expect(liveTestLines(rose)[3]).toBe("The round trip made ₹6.14: ₹2.06 in fees, ₹1.80 TDS (reclaimed when you file), and the price rose ₹10.00.");
  });

  it("says how the sale went, and while the balance is read", () => {
    expect(liveTestLines({ ...run, settling: true }).at(-1)).toBe("Reading CoinDCX's balance (it can take a few seconds to show an order)…");
    expect(liveTestLines({ ...run, status: "SELLING", error: "Insufficient funds" })[2]).toBe(
      "The sale was refused (Insufficient funds). The server keeps trying; if it doesn't go through, sell it on CoinDCX by hand."
    );
    expect(liveTestLines({ ...run, status: "SELL_FAILED", error: "Insufficient funds" })[2]).toBe("The sale failed (Insufficient funds). Sell it on CoinDCX by hand.");
  });
});
