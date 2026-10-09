import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// An order the app sends to open a trade carries the position: the guardian
// guards it from then on, without waiting for the app's next push.

const placeLiveEntry = vi.fn();
vi.mock("../../server/liveEntry", () => ({ placeLiveEntry: (...a: unknown[]) => placeLiveEntry(...a) }));

let base: string;
let server: Server;
let dir: string;
let guardian: typeof import("../../server/guardian");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-execute-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  guardian = await import("../../server/guardian");
  const { router } = await import("../../server/routes/trading");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { uid: "u1" };
    next();
  });
  app.use(router);
  app.use(guardian.router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const position = (id: string, symbol = "SOL/INR") => ({
  id,
  symbol,
  direction: "LONG",
  entryPrice: 100,
  currentPrice: 100,
  quantity: 1,
  stopLoss: 95,
  takeProfit: 110,
  openTime: new Date().toISOString(),
  expectedHoldingTimeMinutes: 60,
});
const order = (body: Record<string, unknown>) =>
  fetch(`${base}/api/execute-trade`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const paper = (p: ReturnType<typeof position> | undefined, over: Record<string, unknown> = {}) =>
  order({ symbol: "SOL/INR", side: "LONG", quantity: 1, price: 100, isPaperTrade: true, positionId: p?.id, ...(p ? { position: p } : {}), ...over });

describe("opening a trade from the app", () => {
  it("puts a paper trade in the guardian with its order", async () => {
    const res = await (await paper(position("o-1"))).json();
    expect(res).toMatchObject({ success: true, mode: "PAPER" });
    expect(guardian.daemonPositions.get("o-1")).toMatchObject({ userId: "u1", symbol: "SOL/INR", entryPrice: 100, isLiveOrder: false });
  });

  it("takes nothing from an older app that sends no position, or one that doesn't match the order", async () => {
    const before = guardian.daemonPositions.size;
    expect((await paper(undefined)).status).toBe(200);
    expect((await paper(position("o-2", "ETH/INR"))).status).toBe(200);
    expect(guardian.daemonPositions.size).toBe(before);
  });

  it("doesn't bring back a trade the guardian already closed", async () => {
    guardian.closeServerPosition("o-1", 104, "MANUAL");
    await paper(position("o-1"));
    expect(guardian.daemonPositions.has("o-1")).toBe(false);
  });

  it("puts a live trade in at the price and size CoinDCX filled", async () => {
    placeLiveEntry.mockResolvedValueOnce({ ok: true, orderId: "cdx-1", executedPrice: 101, quantity: 0.9, data: {} });
    const res = await order({ symbol: "SOL/INR", side: "LONG", quantity: 1, price: 100, isPaperTrade: false, confirmLiveOrder: true, positionId: "o-3", position: position("o-3") });
    expect((await res.json()).success).toBe(true);
    expect(guardian.daemonPositions.get("o-3")).toMatchObject({ entryPrice: 101, currentPrice: 101, quantity: 0.9 });
  });
});
