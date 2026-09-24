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
