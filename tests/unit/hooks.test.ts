// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonCloseEvent } from "../../src/services/daemonEvents";
import type { HistoricalTrade, Position } from "../../src/types";

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const { useServerCloseHandler } = await import("../../src/hooks/useServerCloseHandler");
const { useGuardianSync } = await import("../../src/hooks/useGuardianSync");
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

// A minimal browser book wired to the handler, as App does it.
function useBook(initialTrades: HistoricalTrade[] = []) {
  const [activePositions, setActivePositions] = useState<Position[]>([position("pos-1"), position("pos-2")]);
  const [closedTrades, setClosedTrades] = useState<HistoricalTrade[]>(initialTrades);
  const [equity, setEquity] = useState(100000);
  const [cash, setCash] = useState(99000);
  const [dailyRealizedPnl, setDailyRealizedPnl] = useState(0);
  const closingPositionIds = useRef(new Set<string>());
  const closedTradesRef = useRef(closedTrades);
  closedTradesRef.current = closedTrades;
  const apply = useServerCloseHandler(closingPositionIds, closedTradesRef, {
    setActivePositions, setClosedTrades, setEquity, setCash, setDailyRealizedPnl,
  });
  return { apply, activePositions, closedTrades, equity, cash, dailyRealizedPnl, closingPositionIds };
}

describe("useServerCloseHandler", () => {
  it("applies a guardian close once: removes the position, records the trade, credits P&L", () => {
    const { result } = renderHook(() => useBook());
    let applied = false;
    act(() => { applied = result.current.apply(closeEvent()); });
    expect(applied).toBe(true);
    expect(result.current.activePositions.map((p) => p.id)).toEqual(["pos-2"]);
    expect(result.current.closedTrades).toHaveLength(1);
    expect(result.current.equity).toBe(100009);
    expect(result.current.cash).toBe(100009); // 99000 + 1000 placed + 9
    expect(result.current.dailyRealizedPnl).toBe(9);
  });

  it("credits only once when the WebSocket and the poll both deliver the close", () => {
    const { result } = renderHook(() => useBook());
    act(() => { result.current.apply(closeEvent()); });
    let second = true;
    act(() => { second = result.current.apply(closeEvent()); });
    expect(second).toBe(false);
    expect(result.current.equity).toBe(100009);
    expect(result.current.dailyRealizedPnl).toBe(9);
    expect(result.current.closedTrades).toHaveLength(1);
  });

  it("does not credit a close the browser is already making itself", () => {
    const { result } = renderHook(() => useBook());
    result.current.closingPositionIds.current.add("pos-1");
    act(() => { result.current.apply(closeEvent()); });
    expect(result.current.equity).toBe(100000);
    expect(result.current.activePositions.map((p) => p.id)).toEqual(["pos-2"]);
  });

  it("does not re-credit a close already in the saved history (e.g. after reload)", () => {
    const saved = [{ id: "trade-x", positionId: "pos-1" } as HistoricalTrade];
    const { result } = renderHook(() => useBook(saved));
    act(() => { result.current.apply(closeEvent()); });
    expect(result.current.equity).toBe(100000);
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
