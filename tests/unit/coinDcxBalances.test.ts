import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The CoinDCX balance the app shows (Settings → Connections) and trades
// against in live mode. CoinDCX's docs: `balance` is what's free to use,
// `locked_balance` what open orders hold, and the total is the two together.

describe("GET /api/coindcx/balances", () => {
  let base: string;
  let server: Server;
  const upstream = vi.fn();

  beforeAll(async () => {
    vi.stubEnv("COINDCX_API_KEY", "key");
    vi.stubEnv("COINDCX_API_SECRET", "secret");
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).startsWith("https://api.coindcx.com") ? upstream(String(url)) : realFetch(url, init)
    );
    const { router } = await import("../../server/routes/coindcx");
    const app = express();
    app.use(router);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("counts the money open orders hold in the total, and only the free part as available", async () => {
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { currency: "INR", balance: "8000.5", locked_balance: "2000" },
        { currency: "USDT", balance: 10, locked_balance: 2.5 },
        { currency: "BTC", balance: 0.001, locked_balance: 0 },
      ]))
    );
    const body = await (await fetch(`${base}/api/coindcx/balances`)).json();
    expect(upstream.mock.calls[0][0]).toBe("https://api.coindcx.com/exchange/v1/users/balances");
    expect(body).toMatchObject({ success: true, totalInr: 10000.5, availableInr: 8000.5, lockedInr: 2000, totalUsdt: 12.5, availableUsdt: 10, lockedUsdt: 2.5 });
  });

  it("shows nothing for a currency not held", async () => {
    upstream.mockResolvedValueOnce(new Response(JSON.stringify([{ currency: "BTC", balance: 0.001, locked_balance: 0 }])));
    const body = await (await fetch(`${base}/api/coindcx/balances`)).json();
    expect(body).toMatchObject({ totalInr: 0, availableInr: 0, lockedInr: 0, totalUsdt: 0, availableUsdt: 0, lockedUsdt: 0 });
  });
});
