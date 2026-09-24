import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Drives the real guardian router over HTTP: the browser syncs a position,
// then tightens (and later tries to loosen) its stop, and a price tick shows
// which stop the guardian actually enforces.

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

const position = (stopLoss: number) => ({
  id: "pos-1",
  symbol: "BTC/INR",
  direction: "LONG",
  entryPrice: 1000,
  quantity: 1,
  stopLoss,
  takeProfit: 1100,
  openTime: new Date().toISOString(),
  expectedHoldingTimeMinutes: 60,
});

const sync = (stopLoss: number) =>
  fetch(`${base}/api/daemon/sync-positions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ positions: [position(stopLoss)] }),
  });

const guardedStop = async () => {
  const state = await (await fetch(`${base}/api/daemon/state`)).json();
  return state.activePositions.find((p: { id: string }) => p.id === "pos-1")?.stopLoss;
};

describe("guardian sync keeps the most protective stop", () => {
  it("starts with the browser's stop", async () => {
    expect((await sync(990)).status).toBe(200);
    expect(await guardedStop()).toBe(990);
  });

  it("adopts a tighter stop from the browser (this was ignored before)", async () => {
    await sync(1005);
    expect(await guardedStop()).toBe(1005);
  });

  it("refuses to loosen it again", async () => {
    await sync(980);
    expect(await guardedStop()).toBe(1005);
  });

  it("exits at the tightened stop on the next tick", async () => {
    guardian.evaluateDaemonPositions("BTC/INR", 1004);
    const res = await (await fetch(`${base}/api/daemon/closed-events`)).json();
    expect(res.activePositions).toHaveLength(0);
    expect(res.events[0]).toMatchObject({ positionId: "pos-1", exitPrice: 1004 });
    expect(["TRAILING_STOP", "STOP_LOSS"]).toContain(res.events[0].exitReason);
  });
});

describe("positions the server's autopilot opened", () => {
  const syncAs = (positions: unknown[], uid = "u2") =>
    fetch(`${base}/api/daemon/sync-positions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-uid": uid },
      body: JSON.stringify({ positions }),
    });
  const opened = {
    id: "srv-1",
    symbol: "SOL/INR",
    direction: "LONG" as const,
    entryPrice: 100,
    currentPrice: 100,
    quantity: 2,
    stopLoss: 98,
    takeProfit: 104,
    openTime: new Date().toISOString(),
    isSelfApproved: true,
  };

  it("aren't dropped by a sync from an app that hasn't picked them up yet", async () => {
    guardian.openServerPosition("u2", opened);
    expect((await syncAs([])).status).toBe(200);
    expect(guardian.daemonPositions.get("srv-1")).toMatchObject({ openedByServer: true, clientSeen: false });
  });

  it("are the app's once it syncs them back, and leave when it closes them", async () => {
    await syncAs([{ ...opened, userId: "u2", openedByServer: true, clientSeen: false }]);
    expect(guardian.daemonPositions.get("srv-1")).toMatchObject({ openedByServer: true, clientSeen: true });
    await syncAs([]);
    expect(guardian.daemonPositions.has("srv-1")).toBe(false);
  });

  it("are dropped when the app opened the same coin itself (the same signal, twice)", async () => {
    guardian.openServerPosition("u2", { ...opened, id: "srv-dup" });
    await syncAs([{ ...opened, id: "app-own" }]);
    expect(guardian.daemonPositions.has("srv-dup")).toBe(false);
    expect(guardian.daemonPositions.has("app-own")).toBe(true);
    await syncAs([]);
  });

  it("can't be claimed by the app for a position the server didn't open", async () => {
    await syncAs([{ ...opened, id: "fake-1", openedByServer: true, clientSeen: false }]);
    expect(guardian.daemonPositions.get("fake-1")?.openedByServer).toBeUndefined();
    await syncAs([]);
    expect(guardian.daemonPositions.has("fake-1")).toBe(false);
  });
});
