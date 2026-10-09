// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// End-to-end through the real App: a WebSocket tick past an open paper
// position's take-profit shows its price (the guardian on the server makes the
// exit), and the guardian's close records the trade. Exercises useLiveFeed ->
// markTick and the server-close wiring.

const apiFetch = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url === "/api/coindcx/status") {
    return new Response(JSON.stringify({ success: true, configured: false, keyMasked: null, liveRisk: {} }));
  }
  return new Response(JSON.stringify({ success: true, events: [], activePositions: [] }));
});
vi.mock("../../src/services/apiClient", () => ({
  apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init),
  authenticateSocket: vi.fn(),
}));

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { uid: "u1", email: "owner@example.com" },
    userProfile: { uid: "u1", email: "owner@example.com", displayName: "Owner", role: "commander", provider: "google", lastLoginAt: "" },
    userRole: "commander",
    loading: false,
    logSecurityAudit: vi.fn(),
    openAuthModal: vi.fn(),
    closeAuthModal: vi.fn(),
    authModalOpen: false,
    recentAudits: [],
    switchUserRole: vi.fn(),
    logout: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithEmail: vi.fn(),
    signUpWithEmail: vi.fn(),
    signInDemoOperator: vi.fn(),
  }),
}));

vi.mock("../../src/services/firebase", () => ({ auth: { currentUser: null }, db: {}, default: {} }));

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  constructor() {
    sockets.push(this);
  }
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

beforeAll(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("Worker", class { postMessage() {} terminate() {} addEventListener() {} onmessage = null; });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  URL.createObjectURL = () => "blob:stub";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(cleanup);

describe("App live ticks", () => {
  it("shows a tick's price on an open trade but leaves its exit to the server's guardian, whose close records it", async () => {
    const opened = new Date().toISOString();
    localStorage.setItem(
      "nexus_agent_positions_inr_v5",
      JSON.stringify([
        {
          id: "pos-tp", symbol: "BTC/INR", direction: "LONG", setupName: "Test", entryPrice: 1000, currentPrice: 1000,
          quantity: 1, stopLoss: 990, takeProfit: 1010, initialTakeProfit: 1010, unrealizedPnl: 0,
          unrealizedPnlPercent: 0, openTime: opened, expectedHoldingTimeMinutes: 30, metaConfidence: 0.6,
          trailMode: "SCALP_TIGHT", atrAtEntry: 5, signalPrice: 998,
        },
      ])
    );
    const { default: App } = await import("../../src/App");
    await act(async () => {
      render(createElement(App));
    });

    await act(async () => {
      for (const ws of sockets) ws.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "TICK", data: { "BTC/INR": 1012 } }) }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    // Past its target on this phone's price: shown, not closed here.
    let positions = JSON.parse(localStorage.getItem("nexus_agent_positions_inr_v5") || "[]");
    expect(positions.find((p: { id: string }) => p.id === "pos-tp")).toMatchObject({ currentPrice: 1012, unrealizedPnl: 12, takeProfit: 1010 });
    expect(apiFetch.mock.calls.some(([url]) => url === "/api/daemon/close")).toBe(false);

    // The guardian closes it.
    const closed = {
      id: "daemon-closed-pos-tp", positionId: "pos-tp", symbol: "BTC/INR", direction: "LONG", entryPrice: 1000, exitPrice: 1012,
      quantity: 1, moneyPlaced: 1000, grossPnl: 12, feesPaid: 11.8, realizedPnl: 0.2, realizedPnlPercent: 0.02, isWin: true,
      exitReason: "TAKE_PROFIT", closedAt: new Date().toISOString(), openedAt: opened, highestPrice: 1012, lowestPrice: 1000, signalPrice: 998,
    };
    await act(async () => {
      for (const ws of sockets) ws.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "DAEMON_POSITION_CLOSED", data: closed }) }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    positions = JSON.parse(localStorage.getItem("nexus_agent_positions_inr_v5") || "[]");
    const trades = JSON.parse(localStorage.getItem("nexus_agent_closed_trades_inr_v4") || "[]");
    expect(positions.find((p: { id: string }) => p.id === "pos-tp")).toBeUndefined();
    const trade = trades.find((t: { positionId: string }) => t.positionId === "pos-tp");
    expect(trade).toMatchObject({ exitReason: "TAKE_PROFIT", exitPrice: 1012, highestPrice: 1012, lowestPrice: 1000, signalPrice: 998 });
  }, 30000);

  it("closes a trade by hand only once the server has: one it can't reach stays open", async () => {
    const opened = new Date().toISOString();
    localStorage.setItem(
      "nexus_agent_positions_inr_v5",
      JSON.stringify([
        {
          id: "pos-hand", symbol: "ETH/INR", direction: "LONG", setupName: "Test", entryPrice: 1000, currentPrice: 1005,
          quantity: 1, stopLoss: 990, takeProfit: 1100, initialTakeProfit: 1100, unrealizedPnl: 5,
          unrealizedPnlPercent: 0.5, openTime: opened, expectedHoldingTimeMinutes: 30, metaConfidence: 0.6,
        },
      ])
    );
    const usual = apiFetch.getMockImplementation()!;
    let reachable = false;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== "/api/daemon/close") return usual(url, init);
      if (!reachable) throw new Error("offline");
      return new Response(JSON.stringify({ success: true, event: {
        id: "daemon-closed-pos-hand", positionId: "pos-hand", symbol: "ETH/INR", direction: "LONG", entryPrice: 1000, exitPrice: 1005,
        quantity: 1, moneyPlaced: 1000, grossPnl: 5, feesPaid: 11.8, realizedPnl: -6.8, realizedPnlPercent: -0.68, isWin: false,
        exitReason: "MANUAL", closedAt: new Date().toISOString(), openedAt: opened, reportedByApp: true,
      } }));
    });
    try {
      const { default: App } = await import("../../src/App");
      await act(async () => {
        render(createElement(App));
      });
      const hold = async () => {
        await act(async () => {
          fireEvent.keyDown(screen.getByRole("button", { name: /Hold to close/ }), { key: "Enter" });
          await new Promise((r) => setTimeout(r, 900));
        });
      };
      const stored = () => JSON.parse(localStorage.getItem("nexus_agent_positions_inr_v5") || "[]") as { id: string }[];
      const recorded = () =>
        (JSON.parse(localStorage.getItem("nexus_agent_closed_trades_inr_v4") || "[]") as { positionId: string }[]).filter((t) => t.positionId === "pos-hand");

      // The server can't be reached: still open, nothing recorded.
      await hold();
      expect(stored().map((p) => p.id)).toContain("pos-hand");
      expect(recorded()).toHaveLength(0);
      expect(document.body.textContent).toContain("ETH/INR not closed");

      // It answers: closed and recorded once.
      reachable = true;
      await hold();
      expect(stored().map((p) => p.id)).not.toContain("pos-hand");
      expect(recorded()).toHaveLength(1);
      expect(recorded()[0]).toMatchObject({ exitReason: "MANUAL", exitPrice: 1005 });
    } finally {
      apiFetch.mockImplementation(usual);
    }
  }, 30000);

  it("unfolds a ticket when the server opens a trade, and puts it away on Got it", async () => {
    const { default: App } = await import("../../src/App");
    await act(async () => {
      render(createElement(App));
    });
    const opened = {
      id: "srv-eth", symbol: "ETH/INR", direction: "LONG", setupName: "Breakout 55/20", strategy: "breakout", entryPrice: 200000, currentPrice: 200000,
      quantity: 0.05, stopLoss: 190000, initialStopLoss: 190000, takeProfit: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0,
      openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 525600, metaConfidence: 0.6, openedByServer: true,
    };
    await act(async () => {
      for (const ws of sockets) ws.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "POSITION_OPENED", data: opened }) }));
    });
    const ticket = screen.getByRole("dialog", { name: "ETH/INR" });
    expect(ticket.textContent).toContain("Coin breakout 55/20 · by the server");
    // A paper desk: the ticket shows what it took from the free cash, ₹10,000 and CoinDCX's ₹59 to open it.
    expect(screen.getByTestId("ticket-cash").textContent).toContain("₹10,059 is tied up in this trade until it closes.");
    await act(async () => {
      screen.getByRole("button", { name: "Got it" }).click();
    });
    expect(screen.queryByRole("dialog", { name: "ETH/INR" })).toBeNull();
  }, 30000);
});
