// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade } from "../../src/types";

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const { useServerBook, withBookTrades, withOwnClose } = await import("../../src/hooks/useServerBook");

// The Book and the money read from the server's trade book.

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const NOW = Date.parse("2026-10-09T06:00:00Z"); // 11:30 India time
const MIN = 60_000;

const phoneTrade = (positionId: string, closedAtMs: number, realizedPnl: number): HistoricalTrade =>
  ({ id: `trade-closed-${positionId}`, positionId, symbol: "SOL/INR", realizedPnl, closedAtMs }) as HistoricalTrade;
const bookTrade = (positionId: string, closedAtMs: number, realizedPnl: number) => ({
  id: `daemon-closed-${positionId}`, positionId, symbol: "SOL/INR", direction: "LONG", entryPrice: 100, exitPrice: 101,
  quantity: 1, moneyPlaced: 100, grossPnl: realizedPnl, feesPaid: 0, realizedPnl, realizedPnlPercent: 1, isWin: realizedPnl > 0,
  exitReason: "TRAILING_STOP", closedAt: new Date(closedAtMs).toISOString(), openedAt: new Date(closedAtMs - 60 * MIN).toISOString(),
});

interface Server {
  anchor: unknown;
  trades: unknown[];
  failAnchor?: boolean;
}
const sent: { anchor: unknown; keep?: boolean }[] = [];
function serve(server: Server) {
  apiFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/book/anchor") {
      if (server.failAnchor) return json({ success: false }, 500);
      const body = JSON.parse(String(init!.body));
      sent.push(body);
      if (!(body.keep && server.anchor)) server.anchor = body.anchor;
      return json({ success: true, anchor: server.anchor });
    }
    if (url.startsWith("/api/book?")) return json({ success: true, trades: server.trades, bookedUntil: Date.now(), anchor: server.anchor });
    return json({});
  });
}

function useDesk(initial: HistoricalTrade[], saved = { equity: 100_000, allTimeRealizedPnl: 0 }, start = 100_000) {
  const [trades, setTrades] = useState(initial);
  return { trades, ...useServerBook(trades, setTrades, saved, start) };
}

beforeEach(() => {
  apiFetch.mockReset();
  sent.length = 0;
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("the money from the trade book", () => {
  it("keeps this phone's money as it was when it first moves over, and gives the server its anchor", async () => {
    // Last caught up with the guardian 30 minutes ago; it closed a trade itself 5 minutes ago (in its total already).
    localStorage.setItem("nexus_last_daemon_poll", String(NOW - 30 * MIN));
    const own = phoneTrade("own", NOW - 5 * MIN, 250);
    const server: Server = { anchor: null, trades: [] };
    serve(server);
    const { result } = renderHook(() => useDesk([own], { equity: 101_250, allTimeRealizedPnl: 1_250 }));
    expect(result.current.money).toMatchObject({ equity: 101_250, allTimeRealizedPnl: 1_250, dailyRealizedPnl: 250 });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ keep: true, anchor: { at: NOW - 40 * MIN, equity: 101_000, allTimeRealizedPnl: 1_000, start: 100_000 } });
    expect(result.current.money.equity).toBe(101_250);
  });

  it("counts on top a trade the server closed while the app was away (after its last catch-up)", async () => {
    localStorage.setItem("nexus_last_daemon_poll", String(NOW - 3 * 60 * MIN));
    const server: Server = { anchor: null, trades: [bookTrade("away", NOW - 2 * 60 * MIN, -400)] };
    serve(server);
    const { result } = renderHook(() => useDesk([], { equity: 100_000, allTimeRealizedPnl: 0 }));
    await waitFor(() => expect(result.current.trades).toHaveLength(1));
    expect(result.current.money).toMatchObject({ equity: 99_600, allTimeRealizedPnl: -400, dailyRealizedPnl: -400 });
  });

  it("takes the anchor another device set, and the closes it made", async () => {
    const theirs = { at: NOW - 24 * 60 * MIN, equity: 150_000, allTimeRealizedPnl: 50_000, start: 100_000 };
    const server: Server = { anchor: theirs, trades: [bookTrade("theirs", NOW - 60 * MIN, 1_000)] };
    serve(server);
    const { result } = renderHook(() => useDesk([phoneTrade("mine", NOW - 10 * MIN, 500)]));
    await waitFor(() => expect(result.current.money.equity).toBe(151_500));
    expect(server.anchor).toEqual(theirs);
    expect(result.current.trades.map((t) => t.positionId)).toEqual(["mine", "theirs"]);
    expect(JSON.parse(localStorage.getItem("nexus_money_anchor_v1")!)).toEqual({ anchor: theirs, sent: true });
  });

  it("starts paper money again on the server; a restart that couldn't be sent isn't undone by the server's older anchor", async () => {
    const older = { at: NOW - 24 * 60 * MIN, equity: 150_000, allTimeRealizedPnl: 50_000, start: 100_000 };
    const server: Server = { anchor: older, trades: [], failAnchor: true };
    serve(server);
    const { result } = renderHook(() => useDesk([]));
    await waitFor(() => expect(result.current.money.equity).toBe(150_000));
    act(() => result.current.restart(1_000_000));
    expect(result.current.money).toMatchObject({ equity: 1_000_000, allTimeRealizedPnl: 0 });
    expect(result.current.paperStart).toBe(1_000_000);
    // The next look: the server still has the older one; this phone sends its restart again.
    server.failAnchor = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ keep: false, anchor: { equity: 1_000_000, start: 1_000_000 } }));
    expect(server.anchor).toMatchObject({ equity: 1_000_000 });
    expect(result.current.money.equity).toBe(1_000_000);
  });
});

describe("taking in the trade book's closes", () => {
  it("adds those the Book lacks once each, newest first, and leaves the Book as it is when there are none", () => {
    const mine = phoneTrade("p1", NOW - 10 * MIN, 5);
    const prev = [mine];
    const next = withBookTrades(prev, [bookTrade("p1", NOW - 10 * MIN, 5), bookTrade("p2", NOW - 5 * MIN, -3), bookTrade("p2", NOW - 5 * MIN, -3), { junk: 1 }]);
    expect(next.map((t) => t.positionId)).toEqual(["p2", "p1"]);
    expect(next[0]).toMatchObject({ realizedPnl: -3, closedAtMs: NOW - 5 * MIN, exitReason: "TRAILING_STOP" });
    expect(withBookTrades(next, [bookTrade("p2", NOW - 5 * MIN, -3)])).toBe(next);
  });

  it("puts the phone's own close in place of the server's copy that came in first: one trade, counted once", () => {
    const fromBook = withBookTrades([], [bookTrade("p1", NOW - MIN, 5)]);
    const own = phoneTrade("p1", NOW - MIN, 5);
    const next = withOwnClose(fromBook, own);
    expect(next).toEqual([own]);
  });
});
