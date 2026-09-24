import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import os from "os";
import fs from "fs";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The server scans the way the app does, from CoinDCX's candles, for every
// user whose app has sent its desk settings, and keeps the results.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-scan-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const MIN = 60_000;
const now = Date.now();
// SOL rising steadily: 1,000 one-minute candles, newest first (as CoinDCX sends them).
const minuteCandles = () => {
  const lastOpen = Math.floor(now / MIN) * MIN;
  return Array.from({ length: 1000 }, (_, k) => {
    const j = 999 - k;
    const c = 10000 + j * 1.6;
    return { time: lastOpen - k * MIN, open: c - 0.3, high: c + 0.8, low: c - 0.8, close: c, volume: 20 + j * 0.2 };
  });
};
const hourCandles = () => {
  const lastOpen = Math.floor(now / (60 * MIN)) * 60 * MIN;
  return Array.from({ length: 100 }, (_, k) => {
    const c = 10000 - k * 20;
    return { time: lastOpen - k * 60 * MIN, open: c - 5, high: c + 10, low: c - 10, close: c, volume: 500 };
  });
};

function fakeCoinDcx(url: string): Response {
  if (url.includes("/exchange/ticker")) return new Response(JSON.stringify([{ market: "SOLINR", volume: "900000000", last_price: "11600" }]));
  if (url.includes("markets_details")) return new Response("down", { status: 503 });
  if (url.includes("interval=1m")) return new Response(JSON.stringify(minuteCandles()));
  if (url.includes("interval=1h")) return new Response(JSON.stringify(hourCandles()));
  if (url.includes("/orderbook")) return new Response(JSON.stringify({ bids: { "11598": "50" }, asks: { "11600": "50" } }));
  return new Response("not found", { status: 404 });
}

const desk = {
  equity: 100000,
  riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.5 },
  dailyRealizedPnl: 0,
  autopilot: false,
  killSwitch: false,
  scanning: true,
  failureState: {
    simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
    simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
  },
  quarantines: {},
  promotedModel: null,
};

let base: string;
let server: Server;

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    /coindcx\.com/.test(String(url))
      ? Promise.resolve(fakeCoinDcx(String(url)))
      : /faireconomy/.test(String(url))
      ? Promise.resolve(new Response("[]")) // no scheduled news this week
      : realFetch(url, init)
  );
  const { router } = await import("../../server/routes/scanner");
  const app = express();
  app.use(express.json());
  // Stands in for requireAuth.
  app.use((req, _res, next) => {
    (req as any).user = { uid: String(req.headers["x-uid"] || "owner") };
    next();
  });
  app.use(router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  (await import("../../server/scanner/scannerService"))._resetServerScanner();
  (await import("../../server/scanner/deskState"))._resetDeskStates();
  (await import("../../server/coinUniverse"))._resetCoinUniverse();
  (await import("../../server/coindcxTicker")).resetTickerCache();
  (await import("../../server/marketRules"))._resetMarketRulesCache();
  (await import("../../server/guardian")).daemonPositions.clear();
});

const post = (p: string, body: unknown, uid = "owner") =>
  fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "x-uid": uid }, body: JSON.stringify(body) });

describe("server scanner", () => {
  it("scans every coin on the list for a user whose app sent its settings, and keeps the results", async () => {
    expect((await post("/api/desk/state", desk)).status).toBe(200);
    const { runScanCycle, reportsSince, shadowsFor, scannerStatus } = await import("../../server/scanner/scannerService");
    await runScanCycle(now);

    const reports = reportsSince("owner", 0);
    expect(reports).toHaveLength(1);
    expect(reports[0].outcomes).toHaveLength(1);
    expect(reports[0].outcomes[0].symbol).toBe("SOL/INR");
    // Real candles arrived: the coin was scanned, not skipped for missing data.
    expect(reports[0].outcomes[0]).not.toMatchObject({ reason: "no_data" });
    expect(scannerStatus("owner", now)).toMatchObject({ running: true, lastScanAt: now, coins: 1, problems: [] });
    // Every setup found is followed, and saved to disk.
    expect(reports[0].outcomes[0]).toEqual({ symbol: "SOL/INR", proposed: true });
    expect(reports[0].newProposals[0]).toMatchObject({ symbol: "SOL/INR", status: "PENDING_APPROVAL" });
    // Priced with CoinDCX's order book, fetched on the server.
    expect(reports[0].newProposals[0].dataQuality?.simulatedOrderBook).toBe(false);
    expect(shadowsFor("owner").length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dataDir, "scanner_shadows.json"))).toBe(true);

    // The app picks them up over HTTP.
    const res = await fetch(`${base}/api/scanner/reports?since=0`, { headers: { "x-uid": "owner" } });
    const body = await res.json();
    expect(body.status.running).toBe(true);
    expect(body.reports).toHaveLength(1);
    const later = await fetch(`${base}/api/scanner/reports?since=${now}`, { headers: { "x-uid": "owner" } });
    expect((await later.json()).reports).toEqual([]);
  });

  it("counts the user's open positions from the guardian", async () => {
    await post("/api/desk/state", desk);
    const { daemonPositions } = await import("../../server/guardian");
    daemonPositions.set("p1", {
      id: "p1", userId: "owner", symbol: "SOL/INR", direction: "LONG", entryPrice: 11000, currentPrice: 11600,
      quantity: 0.5, stopLoss: 10900, takeProfit: 12000, openTime: new Date(now).toISOString(),
    });
    daemonPositions.set("p2", {
      id: "p2", userId: "someone-else", symbol: "BTC/INR", direction: "LONG", entryPrice: 1, currentPrice: 1,
      quantity: 1, stopLoss: 0.9, takeProfit: 1.2, openTime: new Date(now).toISOString(),
    });
    const { runScanCycle, reportsSince } = await import("../../server/scanner/scannerService");
    await runScanCycle(now);
    const outcome = reportsSince("owner", 0)[0].outcomes[0];
    // The same scan proposes SOL without the position; holding it, it doesn't.
    expect(outcome).toEqual({ symbol: "SOL/INR", proposed: false, reason: "already_open" });
  });

  it("counts as scanning as soon as it has the settings, before its first scan", async () => {
    const { scannerStatus } = await import("../../server/scanner/scannerService");
    expect(scannerStatus("owner", now)).toMatchObject({ running: false, hasDesk: false });
    await post("/api/desk/state", desk);
    // No scan yet, but one is due: the app mustn't start scanning (and trading) the same candles.
    expect(scannerStatus("owner", Date.now())).toMatchObject({ running: true, hasDesk: true, lastScanAt: 0 });
  });

  it("doesn't scan for a user who switched scanning off, or who never sent settings", async () => {
    await post("/api/desk/state", { ...desk, scanning: false });
    const { runScanCycle, reportsSince, scannerStatus } = await import("../../server/scanner/scannerService");
    await runScanCycle(now);
    expect(reportsSince("owner", 0)).toEqual([]);
    expect(scannerStatus("owner", now).running).toBe(false);
    const res = await post("/api/scanner/scan-now", {}, "stranger");
    expect(res.status).toBe(409);
  });

  it("scans on demand", async () => {
    await post("/api/desk/state", desk);
    const res = await post("/api/scanner/scan-now", {});
    expect(res.status).toBe(200);
    expect((await res.json()).report.outcomes[0].symbol).toBe("SOL/INR");
  });

  it("rejects settings it can't use", async () => {
    const bad = await post("/api/desk/state", { ...desk, riskLimits: { maxOrderValueInr: -5, maxAllowedExposureFraction: 3 } });
    expect(bad.status).toBe(400);
  });
});

describe("server autopilot", () => {
  beforeEach(async () => {
    (await import("../../server/scanner/autopilot"))._resetServerAutopilot();
    (await import("../../server/guardian"))._resetGuardian();
  });

  const on = { ...desk, autopilot: true, tradingMode: "PAPER", trailProfile: "balanced" };

  it("opens what autopilot accepts, for the guardian to guard and the app to pick up", async () => {
    await post("/api/desk/state", on);
    const { runScanCycle, reportsSince } = await import("../../server/scanner/scannerService");
    await runScanCycle(now);
    const proposal = reportsSince("owner", 0)[0].newProposals[0];
    expect(proposal).toMatchObject({ symbol: "SOL/INR", status: "APPROVED" });

    const { daemonPositions } = await import("../../server/guardian");
    const opened = [...daemonPositions.values()];
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      userId: "owner",
      symbol: "SOL/INR",
      direction: "LONG",
      stopLoss: proposal.setup.stopLoss,
      takeProfit: proposal.setup.takeProfit,
      isSelfApproved: true,
      isLiveOrder: false,
      openedByServer: true,
      clientSeen: false,
      trailProfile: "balanced",
    });
    // Entered at the latest price (with no live tick, the last candle's close), sized within limits.
    expect(opened[0].entryPrice).toBe(proposal.setup.entryPrice);
    expect(opened[0].quantity * opened[0].entryPrice).toBeLessThanOrEqual(10000);

    // The next scan holds SOL already: nothing more is opened.
    await runScanCycle(now + 5 * MIN);
    expect(daemonPositions.size).toBe(1);
  });

  it("leaves proposals for the app when autopilot is off, stopped, or trading live", async () => {
    const { runScanCycle, reportsSince, _resetServerScanner } = await import("../../server/scanner/scannerService");
    const { daemonPositions } = await import("../../server/guardian");
    for (const settings of [
      { ...on, autopilot: false },
      { ...on, killSwitch: true },
      { ...on, failureState: { ...desk.failureState, globalKillSwitchActive: true } },
      { ...on, tradingMode: "LIVE_COINDCX" },
    ]) {
      _resetServerScanner();
      await post("/api/desk/state", settings);
      await runScanCycle(now);
      for (const p of reportsSince("owner", 0).flatMap((r) => r.newProposals)) expect(p.status).toBe("PENDING_APPROVAL");
      expect(daemonPositions.size).toBe(0);
    }
  });

  it("defers with the reason when a limit would be broken", async () => {
    // Three autopilot trades already opened (and closed) this hour.
    const guardian = await import("../../server/guardian");
    for (const id of ["x1", "x2", "x3"]) {
      guardian.daemonPositions.set(id, {
        id, userId: "owner", symbol: "ETH/INR", direction: "LONG", entryPrice: 100, currentPrice: 100, isSelfApproved: true,
        quantity: 1, stopLoss: 99, takeProfit: 101, openTime: new Date(now - 20 * MIN).toISOString(),
      });
    }
    guardian.evaluateDaemonPositions("ETH/INR", 101);
    expect(guardian.closedTradesFor("owner")).toHaveLength(3);

    await post("/api/desk/state", on);
    const { runScanCycle, reportsSince } = await import("../../server/scanner/scannerService");
    await runScanCycle(now);
    const proposal = reportsSince("owner", 0)[0].newProposals[0];
    expect(proposal.status).toBe("DEFERRED");
    expect(proposal.deferralReason).toMatch(/3 autonomous approvals\/hour/);
    expect(guardian.daemonPositions.size).toBe(0);
  });

  /** The guardian closes a SOL position at a loss, as it would with the app closed. */
  async function guardianLoss(id: string, symbol = "SOL/INR") {
    const guardian = await import("../../server/guardian");
    guardian.daemonPositions.set(id, {
      id, userId: "owner", symbol, direction: "LONG", entryPrice: 11700, currentPrice: 11700, isSelfApproved: true,
      quantity: 0.5, stopLoss: 11650, takeProfit: 12000, openTime: new Date(Date.now() - 10 * MIN).toISOString(),
    });
    guardian.evaluateDaemonPositions(symbol, 11600);
    expect(guardian.daemonPositions.has(id)).toBe(false);
  }

  it("doesn't reopen a coin the guardian just closed at a loss", async () => {
    await post("/api/desk/state", on);
    await guardianLoss("z1");
    const { runScanCycle, reportsSince } = await import("../../server/scanner/scannerService");
    await runScanCycle(now);
    // The scanner leaves the coin out for the cooldown (no proposal is made).
    expect(reportsSince("owner", 0)[0].newProposals.filter((p) => p.symbol === "SOL/INR")).toEqual([]);
    expect((await import("../../server/guardian")).daemonPositions.size).toBe(0);
  });

  it("pauses after three losses in a row, until the app starts a fresh count", async () => {
    await post("/api/desk/state", { ...on, lossStreak: 1 });
    // Two more losses on other coins while the app is closed.
    await guardianLoss("l1", "ETH/INR");
    await guardianLoss("l2", "BTC/INR");
    const { runScanCycle, reportsSince } = await import("../../server/scanner/scannerService");
    await runScanCycle(now);
    const proposal = reportsSince("owner", 0)[0].newProposals[0];
    expect(proposal.status).toBe("DEFERRED");
    expect(proposal.deferralReason).toMatch(/3 losses in a row/);
    expect((await import("../../server/guardian")).daemonPositions.size).toBe(0);

    // The app counted them and you turned the kill switch off: a fresh start.
    await new Promise((r) => setTimeout(r, 5));
    await post("/api/desk/state", { ...on, lossStreak: 0 });
    await runScanCycle(now + 5 * MIN);
    expect(reportsSince("owner", now).at(-1)!.newProposals[0].status).toBe("APPROVED");
  });

  it("counts the guardian's closes since the app's last update against the daily loss limit", async () => {
    const { serverDailyPnl } = await import("../../server/scanner/scannerService");
    const { setDeskState } = await import("../../server/scanner/deskState");
    const guardian = await import("../../server/guardian");
    const d = setDeskState("owner", { ...desk, dailyRealizedPnl: -100 }, now);
    // A close the app already counted, and one it hasn't heard of.
    guardian.daemonPositions.set("a", {
      id: "a", userId: "owner", symbol: "SOL/INR", direction: "LONG", entryPrice: 100, currentPrice: 100,
      quantity: 10, stopLoss: 95, takeProfit: 110, openTime: new Date(now - 10 * MIN).toISOString(),
    });
    guardian.evaluateDaemonPositions("SOL/INR", 94);
    const closed = guardian.closedTradesFor("owner");
    expect(closed).toHaveLength(1);
    const later = Date.parse(closed[0].closedAt);
    expect(serverDailyPnl("owner", { ...d, updatedAt: later - 1 }, later)).toBeCloseTo(-100 + closed[0].realizedPnl, 2);
    expect(serverDailyPnl("owner", { ...d, updatedAt: later }, later)).toBe(-100);
  });
});
