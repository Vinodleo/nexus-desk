import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The trade book: every closed trade, kept for good on the server, the
// guardian's closes and the ones the app uploads.

let base: string;
let server: Server;
let dir: string;
let guardian: typeof import("../../server/guardian");
let tradeBook: typeof import("../../server/tradeBook");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-book-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  guardian = await import("../../server/guardian");
  tradeBook = await import("../../server/tradeBook");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { uid: "u1" };
    next();
  });
  app.use(tradeBook.router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const open = (id: string) =>
  guardian.daemonPositions.set(id, {
    id, userId: "u1", symbol: "SOL/INR", direction: "LONG", entryPrice: 100, currentPrice: 100,
    quantity: 1, stopLoss: 90, takeProfit: 200, openTime: new Date(Date.now() - 60_000).toISOString(),
  });
const book = async (since?: number) => (await (await fetch(`${base}/api/book${since ? `?since=${since}` : ""}`)).json()).trades as { positionId: string }[];
const upload = (trades: unknown[]) =>
  fetch(`${base}/api/book/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trades }) });
const appTrade = (positionId: string, closedAtMs: number, realizedPnl = 5) => ({
  id: `trade-closed-${positionId}`, positionId, symbol: "ETH/INR", direction: "LONG", entryPrice: 200, exitPrice: 205,
  quantity: 1, realizedPnl, closedAtMs, openedAtMs: closedAtMs - 3_600_000, exitReason: "TAKE_PROFIT", setupName: "Test",
  autopsy: { verdict: "kept on the phone" },
});

describe("the trade book", () => {
  it("holds every close the guardian records, past its 200", async () => {
    for (let i = 0; i < 205; i++) {
      open(`g-${i}`);
      guardian.closeServerPosition(`g-${i}`, 101, "MANUAL", { byApp: i % 2 === 0 });
    }
    expect(guardian.closedTradesFor("u1")).toHaveLength(200);
    expect(await book()).toHaveLength(205);
  });

  it("takes the app's older closes once each, and none it holds already", async () => {
    const t0 = Date.parse("2026-10-01T10:00:00Z");
    const res = await (await upload([appTrade("a-1", t0), appTrade("a-2", t0 + 1000), appTrade("g-0", t0 + 2000)])).json();
    expect(res).toMatchObject({ success: true, added: 2, held: 207 });
    // Uploaded again (the next start): nothing doubled.
    expect((await (await upload([appTrade("a-1", t0)])).json()).added).toBe(0);
    const all = await book();
    expect(all.filter((t) => t.positionId === "g-0")).toHaveLength(1);
    expect(all.find((t) => t.positionId === "a-1")).toMatchObject({ symbol: "ETH/INR", realizedPnl: 5, closedAt: new Date(t0).toISOString() });
    expect(all.find((t) => t.positionId === "a-1")).not.toHaveProperty("autopsy");
    // Newest first, and the ones after a time.
    expect((await book(t0 + 500)).map((t) => t.positionId)).not.toContain("a-1");
  });

  it("refuses a close without its time", async () => {
    expect((await upload([{ ...appTrade("a-3", 1), closedAtMs: undefined }])).status).toBe(400);
  });

  it("is kept on disk, and the guardian's kept closes go in at start-up", async () => {
    guardian.saveDaemonStateToDisk();
    const restart = () => {
      // As server.ts starts: the book, then the guardian.
      tradeBook._resetTradeBook();
      guardian._resetGuardian();
      tradeBook.loadTradeBook();
      guardian.loadDaemonStateFromDisk();
    };
    restart();
    expect(await book()).toHaveLength(207);
    // The first start with a book (none saved yet): the guardian's kept closes go in.
    fs.rmSync(path.join(dir, "trade_book.json"));
    restart();
    expect(await book()).toHaveLength(200);
  });
});
