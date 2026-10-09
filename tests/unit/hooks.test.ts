// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonCloseEvent } from "../../src/services/daemonEvents";
import type { HistoricalTrade, Position } from "../../src/types";
import { deskMoney } from "../../src/shared/deskMoney";

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const { useServerCloseHandler } = await import("../../src/hooks/useServerCloseHandler");
const { noteGone, useGuardianSync } = await import("../../src/hooks/useGuardianSync");
const { useDailyTelemetry } = await import("../../src/hooks/useDailyTelemetry");
const { useCoinDcxAccount } = await import("../../src/hooks/useCoinDcxAccount");

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  apiFetch.mockReset();
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

const closeEvent = (over: Partial<DaemonCloseEvent> = {}): DaemonCloseEvent => ({
  id: "daemon-closed-1-pos-1",
  positionId: "pos-1",
  symbol: "BTC/INR",
  direction: "LONG",
  entryPrice: 1000,
  exitPrice: 1010,
  quantity: 1,
  moneyPlaced: 1000,
  grossPnl: 10,
  feesPaid: 1,
  realizedPnl: 9,
  realizedPnlPercent: 0.9,
  isWin: true,
  exitReason: "TAKE_PROFIT",
  closedAt: "2026-01-01T00:00:00Z",
  openedAt: "2026-01-01T00:00:00Z",
  ...over,
});

const position = (id: string) => ({ id, symbol: "BTC/INR" } as Position);

// A minimal browser book wired to the handler, as App does it; the money
// follows from the Book (useServerBook), from an anchor before these closes.
const anchor = { at: Date.parse("2025-12-31T00:00:00Z"), equity: 100000, allTimeRealizedPnl: -100, start: 100000 };
function useBook(initialTrades: HistoricalTrade[] = []) {
  const [activePositions, setActivePositions] = useState<Position[]>([position("pos-1"), position("pos-2")]);
  const [closedTrades, setClosedTrades] = useState<HistoricalTrade[]>(initialTrades);
  const closingPositionIds = useRef(new Set<string>());
  const closedTradesRef = useRef(closedTrades);
  closedTradesRef.current = closedTrades;
  const apply = useServerCloseHandler(closingPositionIds, closedTradesRef, { setActivePositions, setClosedTrades });
  const { equity, allTimeRealizedPnl } = deskMoney(anchor, closedTrades, "2026-01-01");
  return { apply, activePositions, closedTrades, equity, allTimeRealizedPnl, closingPositionIds };
}

describe("useServerCloseHandler", () => {
  it("applies a guardian close once: removes the position and records the trade, which the money counts", () => {
    const { result } = renderHook(() => useBook());
    let applied = false;
    act(() => { applied = result.current.apply(closeEvent()); });
    expect(applied).toBe(true);
    expect(result.current.activePositions.map((p) => p.id)).toEqual(["pos-2"]);
    expect(result.current.closedTrades).toHaveLength(1);
    expect(result.current.equity).toBe(100009);
    expect(result.current.allTimeRealizedPnl).toBe(-91);
  });

  it("records it once when the WebSocket and the poll both deliver the close", () => {
    const { result } = renderHook(() => useBook());
    act(() => { result.current.apply(closeEvent()); });
    let second = true;
    act(() => { second = result.current.apply(closeEvent()); });
    expect(second).toBe(false);
    expect(result.current.closedTrades).toHaveLength(1);
    expect(result.current.equity).toBe(100009);
  });

  it("leaves a close the browser is already making itself to the browser", () => {
    const { result } = renderHook(() => useBook());
    result.current.closingPositionIds.current.add("pos-1");
    act(() => { result.current.apply(closeEvent()); });
    expect(result.current.closedTrades).toHaveLength(0);
    expect(result.current.activePositions.map((p) => p.id)).toEqual(["pos-2"]);
  });

  it("doesn't record again a close already in the saved history (e.g. after reload)", () => {
    const saved = [{ id: "trade-x", positionId: "pos-1" } as HistoricalTrade];
    const { result } = renderHook(() => useBook(saved));
    act(() => { result.current.apply(closeEvent()); });
    expect(result.current.closedTrades).toHaveLength(1);
  });

  it("claims the position so a later browser-side close is a no-op", () => {
    const { result } = renderHook(() => useBook());
    act(() => { result.current.apply(closeEvent()); });
    expect(result.current.closingPositionIds.current.has("pos-1")).toBe(true);
  });
});

describe("useGuardianSync", () => {
  it("pushes positions and drops ones the guardian already closed", async () => {
    apiFetch.mockImplementation((url: string) =>
      url.startsWith("/api/daemon/sync-positions")
        ? json({ rejectedResurrections: ["pos-1"] })
        : json({ events: [], activePositions: [] })
    );
    const { result } = renderHook(() => {
      const [positions, setPositions] = useState<Position[]>([position("pos-1"), position("pos-2")]);
      useGuardianSync(positions, setPositions, () => false);
      return positions;
    });
    await waitFor(() => expect(result.current.map((p) => p.id)).toEqual(["pos-2"]));
    const syncCall = apiFetch.mock.calls.find(([u]) => u === "/api/daemon/sync-positions");
    expect(JSON.parse(syncCall![1].body).positions.map((p: Position) => p.id)).toEqual(["pos-1", "pos-2"]);
  });

  it("applies closes from the catch-up poll and remembers when it last polled", async () => {
    const applyServerClose = vi.fn(() => true);
    apiFetch.mockImplementation((url: string) =>
      url.startsWith("/api/daemon/closed-events") ? json({ events: [closeEvent()], activePositions: [] }) : json({})
    );
    renderHook(() => {
      const [positions, setPositions] = useState<Position[]>([]);
      useGuardianSync(positions, setPositions, applyServerClose);
    });
    await waitFor(() => expect(applyServerClose).toHaveBeenCalledWith(expect.objectContaining({ positionId: "pos-1" })));
    expect(Number(localStorage.getItem("nexus_last_daemon_poll"))).toBeGreaterThan(0);
  });

  it("restores guardian positions into an empty book only", async () => {
    apiFetch.mockImplementation((url: string) =>
      url.startsWith("/api/daemon/closed-events") ? json({ events: [], activePositions: [position("srv-1")] }) : json({})
    );
    const { result } = renderHook(() => {
      const [positions, setPositions] = useState<Position[]>([]);
      useGuardianSync(positions, setPositions, () => false);
      return positions;
    });
    await waitFor(() => expect(result.current.map((p) => p.id)).toEqual(["srv-1"]));
  });

  it("pushes nothing until the guardian has answered, so an empty book can't wipe its positions", async () => {
    // A new install or cleared storage: the book starts empty while the guardian holds a trade.
    apiFetch.mockImplementation((url: string) =>
      url.startsWith("/api/daemon/closed-events") ? json({ events: [], activePositions: [position("srv-1")] }) : json({})
    );
    renderHook(() => {
      const [positions, setPositions] = useState<Position[]>([]);
      useGuardianSync(positions, setPositions, () => false);
    });
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => u === "/api/daemon/sync-positions")).toBe(true));
    const urls = apiFetch.mock.calls.map(([u]) => u as string);
    const firstSync = urls.indexOf("/api/daemon/sync-positions");
    expect(urls.findIndex((u) => u.startsWith("/api/daemon/closed-events"))).toBeLessThan(firstSync);
    // Every push carries the guardian's trade: none is empty.
    for (const [u, init] of apiFetch.mock.calls) {
      if (u === "/api/daemon/sync-positions") expect(JSON.parse(init.body).positions.map((p: Position) => p.id)).toEqual(["srv-1"]);
    }
  });

  it("tells the guardian which positions left the book, and remembers them", async () => {
    apiFetch.mockImplementation((url: string) =>
      url.startsWith("/api/daemon/closed-events") ? json({ events: [], activePositions: [] }) : json({})
    );
    const { result } = renderHook(() => {
      const [positions, setPositions] = useState<Position[]>([position("pos-1"), position("pos-2")]);
      useGuardianSync(positions, setPositions, () => false);
      return setPositions;
    });
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => u === "/api/daemon/sync-positions")).toBe(true));
    const first = JSON.parse(apiFetch.mock.calls.find(([u]) => u === "/api/daemon/sync-positions")![1].body);
    expect(first.closedIds).toEqual([]);
    act(() => result.current((prev) => prev.filter((p) => p.id !== "pos-2"))); // closed in the app
    await waitFor(() => {
      const last = JSON.parse(apiFetch.mock.calls.filter(([u]) => u === "/api/daemon/sync-positions").at(-1)![1].body);
      expect(last.positions.map((p: Position) => p.id)).toEqual(["pos-1"]);
      expect(last.closedIds).toEqual(["pos-2"]);
    });
    expect(JSON.parse(localStorage.getItem("nexus_gone_positions")!).map(([id]: [string]) => id)).toEqual(["pos-2"]);
  });

  it("takes up a trade another device opened, but not one this book closed", async () => {
    localStorage.setItem("nexus_gone_positions", JSON.stringify([["closed-here", Date.now()]]));
    apiFetch.mockImplementation((url: string) =>
      url.startsWith("/api/daemon/closed-events")
        ? json({
            events: [],
            activePositions: [
              position("pos-1"),
              { ...position("other-device"), openedByServer: true, clientSeen: true },
              position("closed-here"),
            ],
          })
        : json({})
    );
    const { result } = renderHook(() => {
      const [positions, setPositions] = useState<Position[]>([position("pos-1")]);
      useGuardianSync(positions, setPositions, () => false);
      return positions;
    });
    await waitFor(() => expect(result.current.map((p) => p.id).sort()).toEqual(["other-device", "pos-1"]));
  });

  it("pushes nothing while the guardian can't be reached", async () => {
    apiFetch.mockImplementation(() => json({ error: "down" }, 503));
    renderHook(() => {
      const [positions, setPositions] = useState<Position[]>([position("pos-1")]);
      useGuardianSync(positions, setPositions, () => false);
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/daemon\/closed-events/)));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetch.mock.calls.some(([u]) => u === "/api/daemon/sync-positions")).toBe(false);
  });

  it("removes its focus and visibility listeners on unmount", () => {
    apiFetch.mockImplementation(() => json({}));
    const addDoc = vi.spyOn(document, "addEventListener");
    const removeDoc = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => {
      const [positions, setPositions] = useState<Position[]>([]);
      useGuardianSync(positions, setPositions, () => false);
    });
    const added = addDoc.mock.calls.find(([type]) => type === "visibilitychange")![1];
    unmount();
    expect(removeDoc).toHaveBeenCalledWith("visibilitychange", added);
  });
});

describe("noteGone", () => {
  const DAY = 24 * 60 * 60 * 1000;
  it("notes positions that left the book, forgets ones back in it or older than a week", () => {
    const gone = new Map<string, number>([["old", 0], ["back", 5 * DAY]]);
    const at = 8 * DAY;
    expect(noteGone(gone, new Set(["a", "b"]), new Set(["a", "back"]), at)).toBe(true);
    expect([...gone]).toEqual([["b", at]]);
    expect(noteGone(gone, new Set(["a"]), new Set(["a"]), at)).toBe(false);
  });
});

describe("useDailyTelemetry", () => {
  it("resets the counters and fires onRollover when the IST day changes", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-01-01T18:00:00Z")); // 23:30 IST
    const onRollover = vi.fn();
    const { result } = renderHook(() => useDailyTelemetry(onRollover));
    act(() => result.current[1]((prev) => ({ ...prev, analyzedCount: 7 })));
    expect(result.current[0].analyzedCount).toBe(7);
    expect(onRollover).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T18:31:00Z")); // 00:01 IST next day
    act(() => { vi.advanceTimersByTime(10000); });
    expect(result.current[0].analyzedCount).toBe(0);
    expect(result.current[0].istDateString).toBe("2026-01-02");
    expect(onRollover).toHaveBeenCalled();
  });
});

describe("useCoinDcxAccount", () => {
  it("purges legacy browser-stored keys and loads the server status", async () => {
    localStorage.setItem("coindcx_api_key", "old");
    localStorage.setItem("coindcx_api_secret", "old");
    apiFetch.mockImplementation(() => json({ success: true, configured: true, keyMasked: "abcd...wxyz", liveRisk: {} }));
    const { result } = renderHook(() => useCoinDcxAccount(() => {}));
    await waitFor(() => expect(result.current.coinDcxStatus?.configured).toBe(true));
    expect(localStorage.getItem("coindcx_api_key")).toBeNull();
    expect(localStorage.getItem("coindcx_api_secret")).toBeNull();
  });

  it("switching to live persists the mode, fetches balances and warns", async () => {
    apiFetch.mockImplementation((url: string) =>
      url === "/api/coindcx/balances" ? json({ success: true, availableInr: 1234.5 }) : json({ success: false })
    );
    const notify = vi.fn();
    const { result } = renderHook(() => useCoinDcxAccount(notify));
    expect(result.current.tradingMode).toBe("PAPER");
    act(() => result.current.handleToggleTradingMode("LIVE_COINDCX"));
    await waitFor(() => expect(result.current.coinDcxBalance.availableInr).toBe(1234.5));
    expect(localStorage.getItem("nexus_trading_mode")).toBe("LIVE_COINDCX");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "WARNING" }));
  });
});

describe("loadStoredCapital", () => {
  it("repairs cash inflated by old guardian-close accounting", async () => {
    const { loadStoredCapital } = await import("../../src/services/storagePersistenceService");
    localStorage.setItem("nexus_agent_capital_inr_v4", JSON.stringify({ equity: 94483.96, cash: 373144.5, dailyRealizedPnl: 0, allTimeRealizedPnl: -5688.13 }));
    expect(loadStoredCapital().cash).toBe(94483.96);
  });
});
