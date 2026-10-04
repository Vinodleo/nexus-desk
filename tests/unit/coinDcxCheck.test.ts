import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePositionRecord } from "../../server/liveExecution";
import { coinProblemMessage } from "../../src/shared/coinDcxCheck";

// The daily check against CoinDCX: the coins held there match the open live
// trades the server knows, with a pop-up on a mismatch.

let dir: string;
let check: typeof import("../../server/coinDcxCheck");
let exec: typeof import("../../server/liveExecution");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-coindcx-check-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.stubEnv("COINDCX_API_KEY", "key");
  vi.stubEnv("COINDCX_API_SECRET", "secret");
  check = await import("../../server/coinDcxCheck");
  exec = await import("../../server/liveExecution");
});
beforeEach(() => {
  check._resetCoinDcxCheck();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-05T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const rec = (id: string, market: string, quantity: number, extra: Partial<LivePositionRecord> = {}): LivePositionRecord => ({
  positionId: id,
  userId: "u1",
  market,
  entrySide: "buy",
  quantity,
  entryOrderId: `e_${id}`,
  entryClientOrderId: `nx_open_${id}`,
  openedAt: new Date(NOW - 2 * HOUR).toISOString(),
  status: "OPEN",
  exitAttempts: 0,
  ...extra,
});

describe("comparing CoinDCX's coins with the live trades", () => {
  it("finds them all there, counting the coins an open order holds", () => {
    const r = check.compareHoldings([rec("p1", "BTCINR", 0.002), rec("p2", "ETHINR", 0.05)], { BTC: 0.002, ETH: 0.05, INR: 12000 }, NOW);
    expect(r).toEqual({ trades: 2, coins: ["BTC", "ETH"], problems: [], extras: [] });
  });

  it("calls a small shortfall the fee taken in coins, and a bigger one missing", () => {
    const fee = check.compareHoldings([rec("p1", "BTCINR", 0.002)], { BTC: 0.001992 }, NOW);
    expect(fee.problems).toEqual([{ coin: "BTC", kind: "fee", expected: 0.002, held: 0.001992, positions: ["p1"] }]);
    const missing = check.compareHoldings([rec("p1", "BTCINR", 0.002)], { BTC: 0.0012 }, NOW);
    expect(missing.problems).toEqual([{ coin: "BTC", kind: "missing", expected: 0.002, held: 0.0012, positions: ["p1"] }]);
    // Nothing there at all.
    expect(check.compareHoldings([rec("p1", "BTCINR", 0.002)], {}, NOW).problems[0]).toMatchObject({ kind: "missing", held: 0 });
    // Rounding in the last places isn't a mismatch.
    expect(check.compareHoldings([rec("p1", "BTCINR", 0.002)], { BTC: 0.0019999 }, NOW).problems).toEqual([]);
  });

  it("adds up two trades in one coin", () => {
    const r = check.compareHoldings([rec("p1", "SOLINR", 1), rec("p2", "SOLINR", 2)], { SOL: 2 }, NOW);
    expect(r.trades).toBe(2);
    expect(r.problems).toEqual([{ coin: "SOL", kind: "missing", expected: 3, held: 2, positions: ["p1", "p2"] }]);
  });

  it("leaves out trades just opened (the buy may still be filling) and ones being closed", () => {
    const fresh = rec("p1", "BTCINR", 0.002, { openedAt: new Date(NOW - MIN).toISOString() });
    const closing = rec("p2", "ETHINR", 0.05, { status: "EXIT_PENDING", exitSentAt: new Date(NOW - MIN).toISOString() });
    const closed = rec("p3", "SOLINR", 1, { status: "CLOSED" });
    expect(check.compareHoldings([fresh, closing, closed], {}, NOW)).toEqual({ trades: 0, coins: [], problems: [], extras: [] });
  });

  it("finds a failed exit's coins still there, for a week after its last try", () => {
    const failed = rec("p1", "BTCINR", 0.002, { status: "EXIT_FAILED", exitSentAt: new Date(NOW - 2 * HOUR).toISOString() });
    expect(check.compareHoldings([failed], { BTC: 0.002 }, NOW).problems).toEqual([{ coin: "BTC", kind: "unsold", expected: 0.002, held: 0.002, positions: ["p1"] }]);
    // Sold by hand since: nothing to say.
    expect(check.compareHoldings([failed], { BTC: 0 }, NOW).problems).toEqual([]);
    // An open trade's coins in the same coin aren't the failed exit's.
    expect(check.compareHoldings([failed, rec("p2", "BTCINR", 0.002)], { BTC: 0.002 }, NOW).problems).toEqual([]);
    const old = { ...failed, exitSentAt: new Date(NOW - 8 * 24 * HOUR).toISOString() };
    expect(check.compareHoldings([old], { BTC: 0.002 }, NOW).problems).toEqual([]);
  });

  it("lists coins held beyond the live trades without calling them a mismatch, leaving out cash and dust", () => {
    const price = (coin: string) => ({ ETH: 300000, DOGE: 15 })[coin];
    const r = check.compareHoldings([rec("p1", "BTCINR", 0.002)], { BTC: 0.003, ETH: 0.01, DOGE: 2, XYZ: 5, INR: 5000, USDT: 10 }, NOW, price);
    expect(r.problems).toEqual([]);
    // ETH ₹3,000 and the extra BTC listed; DOGE ₹30 is dust; XYZ has no price here, so it's listed.
    expect(r.extras.map((e) => e.coin)).toEqual(["BTC", "ETH", "XYZ"]);
    expect(r.extras[0].held).toBeCloseTo(0.001, 9);
  });
});

describe("the check", () => {
  const notify = vi.fn();
  const deps = (over: Partial<import("../../server/coinDcxCheck").CoinDcxCheckDeps> = {}) => {
    let now = NOW;
    const d: import("../../server/coinDcxCheck").CoinDcxCheckDeps = {
      now: () => now,
      dir: () => dir,
      configured: () => true,
      records: () => [rec("p1", "BTCINR", 0.002)],
      balances: async () => ({ BTC: 0.002 }),
      priceOf: () => undefined,
      notify,
      ...over,
    };
    return { d, later: (ms: number) => (now += ms) };
  };
  beforeEach(() => notify.mockReset());

  it("does nothing without CoinDCX keys", async () => {
    const balances = vi.fn(async () => ({}));
    expect(await check.runCoinDcxCheck(deps({ configured: () => false, balances }).d)).toBe("off");
    expect(balances).not.toHaveBeenCalled();
  });

  it("tells a mismatch once it's seen twice in a row, and once a day", async () => {
    const { d, later } = deps({ balances: async () => ({ BTC: 0.001 }) });
    expect(await check.runCoinDcxCheck(d)).toBe("done");
    // First sighting: checked again 5 minutes later before anyone is told.
    expect(notify).not.toHaveBeenCalled();
    expect(check._coinDcxCheckState()).toMatchObject({ problems: [], pending: ["BTC:missing"] });
    expect(check.checkDue(check._coinDcxCheckState(), NOW + 4 * MIN, true)).toBe(false);
    expect(check.checkDue(check._coinDcxCheckState(), NOW + 5 * MIN, true)).toBe(true);

    later(5 * MIN);
    await check.runCoinDcxCheck(d);
    const { title, body } = coinProblemMessage({ coin: "BTC", kind: "missing", expected: 0.002, held: 0.001, positions: ["p1"] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(title, body, "coindcx-check-BTC");
    expect(title).toBe("CoinDCX check: BTC missing");
    expect(check._coinDcxCheckState().problems).toHaveLength(1);

    // An hour later, the same day: shown, not told again.
    later(HOUR);
    await check.runCoinDcxCheck(d);
    expect(notify).toHaveBeenCalledTimes(1);
    // The next day it's told again.
    later(24 * HOUR);
    await check.runCoinDcxCheck(d);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("drops a first sighting that's gone 5 minutes later (an order mid-fill)", async () => {
    let held = 0;
    const { d, later } = deps({ balances: async () => ({ BTC: held }) });
    await check.runCoinDcxCheck(d);
    held = 0.002;
    later(5 * MIN);
    await check.runCoinDcxCheck(d);
    expect(notify).not.toHaveBeenCalled();
    expect(check._coinDcxCheckState()).toMatchObject({ problems: [], pending: [], trades: 1, coins: ["BTC"] });
  });

  it("tells a failed check only while live trades are open, once a day", async () => {
    const balances = async () => {
      throw new Error("CoinDCX answered 401");
    };
    const quiet = deps({ balances, records: () => [] });
    expect(await check.runCoinDcxCheck(quiet.d)).toBe("failed");
    expect(notify).not.toHaveBeenCalled();
    expect(check._coinDcxCheckState()).toMatchObject({ lastError: "CoinDCX answered 401", lastErrorAt: NOW });

    const live = deps({ balances });
    await check.runCoinDcxCheck(live.d);
    live.later(HOUR);
    await check.runCoinDcxCheck(live.d);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("CoinDCX check failed");
  });

  it("runs daily without live trades, hourly with them, and keeps its findings across restarts", async () => {
    const { d } = deps({ records: () => [] });
    expect(check.checkDue(check._coinDcxCheckState(), NOW, false)).toBe(true);
    await check.runCoinDcxCheck(d);
    const s = check._coinDcxCheckState();
    expect(check.checkDue(s, NOW + 2 * HOUR, false)).toBe(false);
    expect(check.checkDue(s, NOW + 24 * HOUR, false)).toBe(true);
    expect(check.checkDue(s, NOW + HOUR, true)).toBe(true);
    expect(check.checkDue(s, NOW + 30 * MIN, true)).toBe(false);

    check._resetCoinDcxCheck();
    check._loadCoinDcxCheck(dir);
    expect(check._coinDcxCheckState()).toMatchObject({ lastAt: NOW, lastTriedAt: NOW, trades: 0 });
  });
});

describe("CoinDCX's balances", () => {
  it("count what open orders hold as held (total = balance + locked_balance)", async () => {
    const sent: Array<{ url: string; body: any; headers: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
      return new Response(JSON.stringify([
        { currency: "BTC", balance: "0.0005", locked_balance: "0.0015" },
        { currency: "INR", balance: 1200.5, locked_balance: 0 },
      ]), { status: 200 });
    });
    expect(await exec.fetchCoinBalances()).toEqual({ BTC: 0.002, INR: 1200.5 });
    expect(sent[0].url).toBe("https://api.coindcx.com/exchange/v1/users/balances");
    expect(sent[0].body).toEqual({ timestamp: expect.any(Number) });
    expect(sent[0].headers["X-AUTH-APIKEY"]).toBe("key");
  });

  it("fail when CoinDCX refuses", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 401 }));
    await expect(exec.fetchCoinBalances()).rejects.toThrow("Invalid credentials");
  });
});
