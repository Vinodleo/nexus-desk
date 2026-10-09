import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Drives the real guardian router over HTTP. The guardian is the only copy of
// the open trades: the app opens one with its order (openAppPosition), sees
// them on its catch-up (closed-events), and asks for a close by hand.

let base: string;
let server: Server;
let dir: string;
let guardian: typeof import("../../server/guardian");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-guardian-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  guardian = await import("../../server/guardian");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { uid: String(req.headers["x-test-uid"] || "u1") };
    next();
  });
  app.use(guardian.router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const trade = (id: string, symbol = "SOL/INR") => ({
  id,
  symbol,
  direction: "LONG" as const,
  entryPrice: 100,
  currentPrice: 100,
  quantity: 2,
  stopLoss: 90,
  takeProfit: 100_000,
  openTime: new Date().toISOString(),
  expectedHoldingTimeMinutes: 525_600,
});
const lookAs = async (uid: string) =>
  (await (await fetch(`${base}/api/daemon/closed-events`, { headers: { "x-test-uid": uid } })).json()) as {
    activePositions: { id: string }[];
    events: { positionId: string }[];
  };

describe("the guardian holds the open trades", () => {
  it("has no push of the app's open trades any more", async () => {
    const res = await fetch(`${base}/api/daemon/sync-positions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positions: [trade("pushed")] }),
    });
    expect(res.status).toBe(404);
    expect(guardian.daemonPositions.has("pushed")).toBe(false);
  });

  it("shows each user their own trades: the app's and the server's autopilot's", async () => {
    expect(guardian.openAppPosition("u2", trade("app-1"))).toBe("taken");
    guardian.openServerPosition("u2", { ...trade("srv-1", "ETH/INR"), isSelfApproved: true });
    guardian.openServerPosition("u3", trade("other-user"));
    expect((await lookAs("u2")).activePositions.map((p) => p.id).sort()).toEqual(["app-1", "srv-1"]);
    expect(guardian.daemonPositions.get("srv-1")).toMatchObject({ openedByServer: true });
  });

  it("takes an app's open once, never its claim to be the server's, and refuses a second paper trade in a symbol held", () => {
    expect(guardian.openAppPosition("u2", { ...trade("app-1"), stopLoss: 50 })).toBe("taken");
    expect(guardian.daemonPositions.get("app-1")!.stopLoss).toBe(90); // already held: as it is
    expect(guardian.openAppPosition("u2", { ...trade("app-2", "BTC/INR"), openedByServer: true })).toBe("taken");
    expect(guardian.daemonPositions.get("app-2")!.openedByServer).toBeUndefined();
    expect(guardian.openAppPosition("u2", trade("app-3", "ETH/INR"))).toBe("held");
    expect(guardian.daemonPositions.has("app-3")).toBe(false);
    expect(guardian.openAppPosition("u4", trade("app-1"))).toBe("skipped"); // someone else's id
  });

  it("keeps a daily or breakout mark the app sent with its order", () => {
    expect(guardian.openAppPosition("u5", { ...trade("app-daily", "ADA/INR"), timeframe: "1d", strategy: "breakout" })).toBe("taken");
    expect(guardian.daemonPositions.get("app-daily")).toMatchObject({ timeframe: "1d", strategy: "breakout" });
  });

  it("exits at its stop on the next tick, and the app sees the close", async () => {
    guardian.evaluateDaemonPositions("SOL/INR", 89);
    const seen = await lookAs("u2");
    expect(seen.activePositions.map((p) => p.id)).not.toContain("app-1");
    expect(seen.events.find((e) => e.positionId === "app-1")).toMatchObject({ exitReason: "STOP_LOSS" });
    // Closed: an order re-sent with it can't bring it back.
    expect(guardian.openAppPosition("u2", trade("app-1"))).toBe("refused");
  });
});

describe("closes the app asks for (by hand)", () => {
  const close = (positionId: string, price: number, reason = "MANUAL", uid = "u6") =>
    fetch(`${base}/api/daemon/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-uid": uid },
      body: JSON.stringify({ positionId, price, reason }),
    });

  it("closes the position at the app's price and records it, once", async () => {
    guardian.openAppPosition("u6", trade("c-1"));
    const res = await (await close("c-1", 110)).json();
    expect(res).toMatchObject({ success: true, event: { positionId: "c-1", exitPrice: 110, exitReason: "MANUAL", reportedByApp: true } });
    expect(guardian.daemonPositions.has("c-1")).toBe(false);
    expect(guardian.closedTradesFor("u6").filter((t) => t.positionId === "c-1")).toHaveLength(1);
    // Asked again: the same record, not a second one.
    const again = await (await close("c-1", 111)).json();
    expect(again).toMatchObject({ success: true, already: true, event: { exitPrice: 110 } });
    expect(guardian.closedTradesFor("u6").filter((t) => t.positionId === "c-1")).toHaveLength(1);
  });

  it("answers 404 for a position it never held, or someone else's", async () => {
    expect((await close("nope", 100)).status).toBe(404);
    guardian.openAppPosition("u6", trade("c-3", "XRP/INR"));
    expect((await close("c-3", 100, "MANUAL", "someone-else")).status).toBe(404);
    expect(guardian.daemonPositions.has("c-3")).toBe(true);
  });
});
