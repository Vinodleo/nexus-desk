// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade } from "../../src/types";

// The traders' records replay setups on candles; paper trades are real
// fills. Side by side, per trader and market, they show whether the replay
// is too kind.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { MIN_REAL_TRADES, TraderRecord, realByTrader, replayVsReal } = await import("../../src/components/ledger/LedgerBreakdown");

afterEach(cleanup);

const NOW = Date.parse("2026-10-02T06:00:00Z");
/** A closed paper trade that risked ₹10 and made `pnl` (so `pnl / 10` R). */
const trade = (setupName: string, pnl: number, over: Partial<HistoricalTrade> = {}): HistoricalTrade =>
  ({
    id: `t-${Math.random()}`, symbol: "SOL/INR", direction: "LONG", setupName, entryPrice: 100, exitPrice: 100, quantity: 10, moneyPlaced: 1000,
    realizedPnl: pnl, realizedPnlPercent: 0, isWin: pnl > 0, exitReason: "STOP_LOSS", openedAt: "", closedAt: "", closedAtMs: NOW - 60_000,
    riskAtOpen: 10, ...over,
  }) as HistoricalTrade;

const row = (trader: string, avgR: number, market = "crypto") => ({
  market, trader, trades: 40, winPct: 30, avgWinR: 1, avgLossR: -0.5, avgR, judgedR: avgR, otherMarketR: 0,
});
const table = { profile: "tight", measuredAt: NOW, symbols: 20, since: NOW - 3 * 86_400_000, recordDays: 30, minMarketTrades: 30,
  rows: [row("Marcus Swing Trend", 0.3), row("Priya Momentum Scalp", 0.1)] };

describe("real paper trades by trader", () => {
  it("average each trader's result in R per market, over the span the records cover", () => {
    const real = realByTrader(
      [
        trade("Marcus Swing Trend", 20),
        trade("Marcus Swing Trend", -10),
        trade("Marcus Swing Trend", 15, { symbol: "SBIN" }), // another market
        trade("Marcus Swing Trend", 50, { riskAtOpen: undefined }), // no risk recorded
        trade("Marcus Swing Trend", 50, { closedAtMs: NOW - 10 * 86_400_000 }), // before the records
      ],
      table.since
    );
    expect(real.get("crypto:Marcus Swing Trend")).toEqual({ trades: 2, avgR: 0.5 });
    expect(real.get("nse:Marcus Swing Trend")).toEqual({ trades: 1, avgR: 1.5 });
    expect(real.size).toBe(2);
  });

  it("set against the replay for the same traders, weighted by real trades", () => {
    const real = new Map([
      ["crypto:Marcus Swing Trend", { trades: 3, avgR: -0.2 }],
      ["crypto:Priya Momentum Scalp", { trades: 1, avgR: 0.6 }],
    ]);
    const vs = replayVsReal(table.rows as any, real)!;
    expect(vs.trades).toBe(4);
    expect(vs.realR).toBeCloseTo((3 * -0.2 + 0.6) / 4, 6);
    expect(vs.replayR).toBeCloseTo((3 * 0.3 + 0.1) / 4, 6);
    expect(replayVsReal(table.rows as any, new Map())).toBeNull();
  });
});

describe("the card", () => {
  it("shows each trader's real result, and says when real fills do worse than the replay", () => {
    // Marcus: +0.30R in the replay, −0.20R on 10 real trades.
    const trades = Array.from({ length: MIN_REAL_TRADES }, (_, i) => trade("Marcus Swing Trend", i < 3 ? 10 : -7));
    render(createElement(TraderRecord, { table: table as any, trades }));
    expect(screen.getByText(/real −0\.19R over 10/)).toBeTruthy();
    expect(screen.getByTestId("replay-vs-real").textContent).toBe(
      "Your paper trades here: −0.19R each over 10, against +0.30R in the replay for the same traders. Real fills do worse: these records look kinder than trading is."
    );
  });

  it("waits for enough real trades before judging the replay", () => {
    render(createElement(TraderRecord, { table: table as any, trades: [trade("Marcus Swing Trend", 10)] }));
    expect(screen.getByTestId("replay-vs-real").textContent).toBe(
      `1 real paper trade here so far; the replay and real fills are compared from ${MIN_REAL_TRADES}.`
    );
  });
});
