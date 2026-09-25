import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Angel One SmartAPI, stubbed: the server logs in with a one-time code, finds
// each stock's token, and reads candles, prices and depth; the scanner scans
// stocks only while NSE takes trades, and stock positions close at 3:20.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-angel-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.stubEnv("ANGEL_API_KEY", "key");
vi.stubEnv("ANGEL_CLIENT_CODE", "A123");
vi.stubEnv("ANGEL_PIN", "1234");
vi.stubEnv("ANGEL_TOTP_SECRET", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const IST = "+05:30";
/** Wednesday 23 September 2026, 10:02 IST. */
const now = Date.parse(`2026-09-23T10:02:00${IST}`);
const FIVE = 5 * 60_000;
const HOUR = 60 * 60_000;

const istToMs = (s: string) => Date.parse(`${s.replace(" ", "T")}:00${IST}`);
const isoIst = (ms: number) => new Date(ms + 5.5 * HOUR).toISOString().slice(0, 19) + IST;

/** SBIN rising steadily: candles between the requested times. */
function candles(from: number, to: number, step: number) {
  const out: unknown[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    // A strong trend, 0.15% a candle (well clear of stock trading costs), at ₹905 now.
    const c = 905 * Math.pow(1.0015, (t - now) / FIVE);
    out.push([isoIst(t), c * 0.9997, c * 1.0005, c * 0.9995, c, 50000 + ((t / FIVE) % 50) * 100]);
  }
  return out;
}

const calls: { path: string; body: any; auth?: string }[] = [];
let jwtIssued = 0;
let refuseNext = false;
let rateLimitNext = 0;

function angel(url: string, init?: RequestInit): Response {
  const p = new URL(url).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const auth = (init?.headers as Record<string, string>)?.Authorization;
  calls.push({ path: p, body, auth });
  const ok = (data: unknown) => new Response(JSON.stringify({ status: true, message: "SUCCESS", errorcode: "", data }));
  if (p.endsWith("/loginByPassword")) {
    jwtIssued++;
    return ok({ jwtToken: `jwt${jwtIssued}`, refreshToken: "r", feedToken: "f" });
  }
  if (rateLimitNext > 0) {
    rateLimitNext--;
    return new Response(JSON.stringify({ message: "Access denied because of exceeding access rate", status: false, errorcode: "" }), { status: 403 });
  }
  if (refuseNext) {
    refuseNext = false;
    return new Response(JSON.stringify({ status: false, message: "Invalid Token", errorcode: "AG8001", data: null }));
  }
  if (p.endsWith("/searchScrip")) {
    return ok(body.searchscrip === "SBIN" ? [{ exchange: "NSE", tradingsymbol: "SBIN-EQ", symboltoken: "3045" }, { tradingsymbol: "SBIN-BE", symboltoken: "9" }] : []);
  }
  if (p.endsWith("/getCandleData")) {
    return ok(candles(istToMs(body.fromdate), istToMs(body.todate), body.interval === "ONE_HOUR" ? HOUR : FIVE));
  }
  if (p.endsWith("/quote/")) {
    const last = (candles(now - FIVE, now, FIVE).at(-1) as number[])[4];
    return ok({
      fetched: [{ tradingSymbol: "SBIN-EQ", symbolToken: "3045", ltp: last, depth: { buy: [{ price: last - 0.05, quantity: 5000 }], sell: [{ price: last + 0.05, quantity: 5000 }] } }],
      unfetched: [],
    });
  }
  return new Response("not found", { status: 404 });
}

let angelOne: typeof import("../../server/angelOne");

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("apiconnect.angelone.in")) return Promise.resolve(angel(u, init));
    // CoinDCX and the news calendar: nothing (coins aren't under test here).
    if (/coindcx\.com/.test(u)) return Promise.resolve(new Response(u.includes("ticker") ? "[]" : "down", { status: u.includes("ticker") ? 200 : 503 }));
    if (/faireconomy/.test(u)) return Promise.resolve(new Response("[]"));
    return realFetch(url, init);
  });
  angelOne = await import("../../server/angelOne");
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  angelOne._resetAngelOne();
  angelOne._setAngelGaps(0);
  calls.length = 0;
  refuseNext = false;
  rateLimitNext = 0;
});

describe("Angel One client", () => {
  it("makes the RFC 6238 one-time code", () => {
    // RFC 6238 test key "12345678901234567890"; at 59s the 8-digit code is 94287082.
    expect(angelOne.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000, 8)).toBe("94287082");
    expect(angelOne.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
  });

  it("logs in by itself, finds the stock's token once, and reads candles", async () => {
    const bars = await angelOne.fetchStockCandles("SBIN", "FIVE_MINUTE", now - HOUR, now);
    expect(bars.length).toBeGreaterThan(10);
    const login = calls.find((c) => c.path.endsWith("/loginByPassword"))!;
    expect(login.body).toMatchObject({ clientcode: "A123", password: "1234" });
    expect(login.body.totp).toMatch(/^\d{6}$/);
    const candleCall = calls.find((c) => c.path.endsWith("/getCandleData"))!;
    expect(candleCall.body).toMatchObject({ exchange: "NSE", symboltoken: "3045", interval: "FIVE_MINUTE", todate: "2026-09-23 10:02" });
    expect(candleCall.auth).toMatch(/^Bearer jwt\d+$/);
    // The token was saved: no second search, even after a restart.
    angelOne._resetAngelOne();
    angelOne._setAngelGaps(0);
    calls.length = 0;
    expect(await angelOne.tokenFor("SBIN")).toBe("3045");
    expect(calls.some((c) => c.path.endsWith("/searchScrip"))).toBe(false);
  });

  it("skips stocks Angel One doesn't list", async () => {
    expect(await angelOne.tokenFor("NOTASTOCK")).toBeNull();
    const prices = await angelOne.fetchStockPrices(["SBIN", "NOTASTOCK"]);
    expect(Object.keys(prices)).toEqual(["SBIN"]);
  });

  it("logs in again when the session is refused", async () => {
    await angelOne.fetchStockPrices(["SBIN"]);
    const before = jwtIssued;
    refuseNext = true;
    const prices = await angelOne.fetchStockPrices(["SBIN"]);
    expect(prices.SBIN).toBeGreaterThan(0);
    expect(jwtIssued).toBe(before + 1);
  });

  it("slows down when Angel One says requests come too fast, instead of logging in again", async () => {
    await angelOne.fetchStockPrices(["SBIN"]);
    const logins = jwtIssued;
    rateLimitNext = 1;
    await expect(angelOne.fetchStockPrices(["SBIN"])).rejects.toThrow(/exceeding access rate/);
    // No new login: that only adds to the count and gets the login refused too.
    expect(jwtIssued).toBe(logins);
    expect(angelOne.angelStatus().lastError).toMatch(/slow down/);
    // Quotes wait a minute; nothing is sent meanwhile.
    calls.length = 0;
    await expect(angelOne.fetchStockPrices(["SBIN"])).rejects.toThrow(/resume in \d+s/);
    expect(calls.filter((c) => c.path.endsWith("/quote/"))).toHaveLength(0);
    // Other kinds of request carry on, and a success clears the problem.
    await angelOne.fetchStockCandles("SBIN", "FIVE_MINUTE", now - HOUR, now);
    expect(angelOne.angelStatus().lastError).toBeNull();
  });

  it("reads market depth as an order book", async () => {
    const book = await angelOne.fetchStockDepth("SBIN", now);
    expect(book?.bids[0][1]).toBe(5000);
    expect(book!.asks[0][0]).toBeGreaterThan(book!.bids[0][0]);
  });
});

describe("stocks on the server", () => {
  const desk = {
    equity: 100000,
    riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.5 },
    dailyRealizedPnl: 0,
    autopilot: true,
    tradingMode: "PAPER" as const,
    killSwitch: false,
    scanning: true,
    failureState: {
      simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
      simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
    },
    quarantines: {},
    promotedModel: null,
  };

  beforeEach(async () => {
    (await import("../../server/scanner/scannerService"))._resetServerScanner();
    (await import("../../server/scanner/deskState"))._resetDeskStates();
    (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
    (await import("../../server/guardian"))._resetGuardian();
  });

  it("scans the stocks Angel One lists while NSE takes trades, and autopilot opens one", async () => {
    const { setDeskState } = await import("../../server/scanner/deskState");
    const { runScanCycle, reportsSince, scannerStatus } = await import("../../server/scanner/scannerService");
    setDeskState("owner", desk, now);
    await runScanCycle(now);
    const report = reportsSince("owner", 0)[0];
    const sbin = report.outcomes.find((o) => o.symbol === "SBIN");
    expect(sbin).toBeDefined();
    expect(scannerStatus("owner", now).stocks).toBe(50);

    const proposal = report.newProposals.find((p) => p.symbol === "SBIN")!;
    expect(proposal).toMatchObject({ status: "APPROVED" });
    // Priced with Angel One's market depth, not a simulated book.
    expect(proposal.dataQuality?.simulatedOrderBook).toBe(false);
    const { daemonPositions } = await import("../../server/guardian");
    const opened = [...daemonPositions.values()].find((p) => p.symbol === "SBIN")!;
    expect(opened).toMatchObject({ openedByServer: true, isSelfApproved: true });
    // Whole shares, within the order limit.
    expect(Number.isInteger(opened.quantity)).toBe(true);
    expect(opened.quantity * opened.entryPrice).toBeLessThanOrEqual(10000);
  });

  it("leaves stocks alone after 3:00 IST", async () => {
    const { setDeskState } = await import("../../server/scanner/deskState");
    const { runScanCycle, reportsSince } = await import("../../server/scanner/scannerService");
    const late = Date.parse(`2026-09-23T15:05:00${IST}`);
    setDeskState("owner", desk, late);
    calls.length = 0;
    await runScanCycle(late);
    expect(reportsSince("owner", 0).flatMap((r) => r.outcomes).some((o) => o.symbol === "SBIN")).toBe(false);
  });

  it("feeds stock prices to the guardian while NSE is open, which closes stock positions at 3:20", async () => {
    const guardian = await import("../../server/guardian");
    const { pollStockPrices } = await import("../../server/stockPrices");
    guardian.daemonPositions.set("s1", {
      id: "s1", userId: "owner", symbol: "SBIN", direction: "LONG", entryPrice: 900, currentPrice: 900,
      quantity: 10, stopLoss: 850, takeProfit: 2000, openTime: new Date(now).toISOString(), expectedHoldingTimeMinutes: 30,
    });
    expect(await pollStockPrices(now)).toBeGreaterThan(0);
    expect(guardian.daemonPositions.get("s1")!.currentPrice).not.toBe(900);
    expect(await pollStockPrices(Date.parse(`2026-09-23T16:00:00${IST}`))).toBe(0);

    const { isPastHoldingTime } = await import("../../server/guardianLogic");
    const pos = guardian.daemonPositions.get("s1")!;
    // Winning and inside its extended limit, but it's 3:20.
    pos.stopLoss = 950;
    pos.openTime = new Date(Date.parse(`2026-09-23T15:05:00${IST}`)).toISOString();
    expect(isPastHoldingTime(pos, Date.parse(`2026-09-23T15:19:00${IST}`))).toBe(false);
    expect(isPastHoldingTime(pos, Date.parse(`2026-09-23T15:20:00${IST}`))).toBe(true);
  });
});
