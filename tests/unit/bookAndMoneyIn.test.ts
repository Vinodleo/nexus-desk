// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonEventToTrade, type DaemonCloseEvent } from "../../src/services/daemonEvents";
import { repairClosedTrades } from "../../src/services/storagePersistenceService";
import { LedgerBookTrades } from "../../src/components/ledger/LedgerBook";
import { LedgerFloor, moneyIn, type LedgerFloorProps } from "../../src/components/ledger/LedgerFloor";
import type { HistoricalTrade, Position } from "../../src/types";

afterEach(cleanup);

const trade = (over: Partial<HistoricalTrade> = {}): HistoricalTrade => ({
  id: "trade-closed-1790000000000", positionId: "p1", symbol: "SOL/INR", direction: "LONG", setupName: "Marcus Swing Trend",
  entryPrice: 100, exitPrice: 102, quantity: 10, moneyPlaced: 1000, realizedPnl: 18, realizedPnlPercent: 1.8, isWin: true,
  exitReason: "TAKE_PROFIT", openedAt: "10:00", closedAt: "10:20", openedAtMs: Date.now() - 20 * 60_000, closedAtMs: Date.now(),
  ...over,
} as HistoricalTrade);

describe("trades closed by the server guardian", () => {
  it("carry their close time, so the Book files them by day instead of at the bottom", () => {
    const ev: DaemonCloseEvent = {
      id: "daemon-closed-1-p9", positionId: "p9", symbol: "ETH/INR", direction: "LONG", entryPrice: 200000, exitPrice: 201000,
      quantity: 0.05, moneyPlaced: 10000, grossPnl: 50, feesPaid: 10, realizedPnl: 40, realizedPnlPercent: 0.4, isWin: true,
      exitReason: "TRAILING_STOP", closedAt: "2026-09-25T10:20:00.000Z", openedAt: "2026-09-25T10:00:00.000Z",
    };
    const t = daemonEventToTrade(ev);
    expect(t.closedAtMs).toBe(Date.parse("2026-09-25T10:20:00.000Z"));
    expect(t.openedAtMs).toBe(Date.parse("2026-09-25T10:00:00.000Z"));
    expect(t.closedAt).toMatch(/^\d{1,2}:\d{2}/); // a time, not the raw ISO string
  });
});

describe("repairing saved trades", () => {
  it("gives trades that shared an id their own, and fills in missing close times", () => {
    const iso = "2026-09-25T10:20:00.000Z";
    const repaired = repairClosedTrades([
      trade({ positionId: "a" }),
      trade({ positionId: "b" }), // closed on the same price update: same id
      trade({ id: "daemon-closed-x", positionId: "c", closedAtMs: undefined, closedAt: iso, openedAt: "2026-09-25T10:00:00.000Z" }),
    ]);
    expect(new Set(repaired.map((t) => t.id)).size).toBe(3);
    expect(repaired[0].id).toBe("trade-closed-1790000000000");
    expect(repaired[1].id).toBe("trade-closed-1790000000000-2");
    expect(repaired[2].closedAtMs).toBe(Date.parse(iso));
  });

  it("shows every one of them in the Book", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const trades = repairClosedTrades([trade({ positionId: "a", symbol: "SOL/INR" }), trade({ positionId: "b", symbol: "XRP/INR" })]);
    const { container } = render(createElement(LedgerBookTrades, { trades }));
    expect(container.textContent).toContain("2 trades");
    expect(container.textContent).toContain("SOL/INR");
    expect(container.textContent).toContain("XRP/INR");
  });
});

describe("money in open positions", () => {
  const position = (over: Partial<Position> = {}): Position => ({
    id: "p1", symbol: "SOL/INR", direction: "LONG", setupName: "t", entryPrice: 14000, currentPrice: 14100, quantity: 0.5,
    stopLoss: 13900, takeProfit: 14300, unrealizedPnl: 50, unrealizedPnlPercent: 0.7, openTime: new Date().toISOString(),
    expectedHoldingTimeMinutes: 30, metaConfidence: 0.6, ...over,
  });

  it("counts only what's still open after banking half", () => {
    expect(moneyIn(position())).toBe(7000);
    expect(moneyIn(position({ bankedQuantity: 0.25, bankedPrice: 14140 }))).toBe(3500);
  });

  it("shows each position's amount and the total in trades", () => {
    const props = {
      isLive: false, equity: 100000, dailyPnl: 0, allTimePnl: 0, autopilotOn: false, onAutopilotChange: vi.fn(),
      exposureFraction: 0.12, dailyLossLeft: 2500, stopped: false, onToggleStop: vi.fn(),
      positions: [position(), position({ id: "p2", symbol: "XRP/INR", entryPrice: 50, quantity: 100 })],
      onClosePosition: vi.fn(), guardianOnline: true, liveTradingEnabled: false, market: [], candleStatus: [],
      watching: { count: 25, fallback: false }, pendingProposals: 0, scan: { analyzed: 0, selected: 0, rejected: 0 },
      onOpenQueue: vi.fn(), onOpenSettings: vi.fn(),
    } as LedgerFloorProps;
    const { container } = render(createElement(LedgerFloor, props));
    const text = container.textContent ?? "";
    expect(text).toContain("Long · 0.5 · ₹7,000 in");
    expect(text).toContain("Long · 100 · ₹5,000 in");
    expect(text).toContain("In trades · 12.0%₹12,000");
  });
});
