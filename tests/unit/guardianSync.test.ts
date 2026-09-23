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
