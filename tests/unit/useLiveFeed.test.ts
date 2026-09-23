// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
const authenticateSocket = vi.fn();
vi.mock("../../src/services/apiClient", () => ({
  apiFetch: (url: string) => apiFetch(url),
  authenticateSocket: (ws: unknown) => authenticateSocket(ws),
}));

const { useLiveFeed } = await import("../../src/hooks/useLiveFeed");

class FakeSocket {
  static last: FakeSocket;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const handlers = () => ({ onTick: vi.fn(), onServerClose: vi.fn(), onLiveExitUpdate: vi.fn() });

describe("useLiveFeed", () => {
  it("authenticates on open and routes each message type", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const h = handlers();
    renderHook(() => useLiveFeed(h));
    const ws = FakeSocket.last;
    ws.onopen?.();
    expect(authenticateSocket).toHaveBeenCalledWith(ws);

    ws.emit({ type: "TICK", data: { "BTC/INR": 5 } });
    ws.emit({ type: "DAEMON_POSITION_CLOSED", data: { positionId: "p1" } });
    ws.emit({ type: "LIVE_EXIT_UPDATE", data: { status: "CLOSED" } });
    ws.emit({ type: "AUTH_OK" });
    expect(h.onTick).toHaveBeenCalledWith({ "BTC/INR": 5 });
    expect(h.onServerClose).toHaveBeenCalledWith({ positionId: "p1" });
    expect(h.onLiveExitUpdate).toHaveBeenCalledWith({ status: "CLOSED" });
  });

  it("always calls the latest handlers without reconnecting", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const first = handlers();
    const second = handlers();
    const { rerender } = renderHook(({ h }) => useLiveFeed(h), { initialProps: { h: first } });
    const ws = FakeSocket.last;
    rerender({ h: second });
    expect(FakeSocket.last).toBe(ws);
    ws.emit({ type: "TICK", data: { "BTC/INR": 6 } });
    expect(first.onTick).not.toHaveBeenCalled();
    expect(second.onTick).toHaveBeenCalledWith({ "BTC/INR": 6 });
  });

  it("feeds REST backstop prices through onTick and cleans up on unmount", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    apiFetch.mockImplementation(async () =>
      new Response(JSON.stringify([{ market: "BTCINR", last_price: "7" }, { market: "BTCUSDT", last_price: "0.1" }]))
    );
    const h = handlers();
    const { unmount } = renderHook(() => useLiveFeed(h));
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.onTick).toHaveBeenCalledWith({ "BTC/INR": 7, "BTC/USDT": 0.1 });
    const ws = FakeSocket.last;
    unmount();
    expect(ws.closed).toBe(true);
    apiFetch.mockClear();
    vi.advanceTimersByTime(20000);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
