// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade } from "../../src/types";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { LedgerBook, resultR } = await import("../../src/components/ledger/LedgerBook");
const { dayTotals, localDay, monthGrid, moneyLine } = await import("../../src/components/ledger/BookCalendar");

// Book → Trades: the money line, the calendar of days, and each row's R and move line.

afterEach(cleanup);

/** Noon on a day on this machine's calendar. */
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
function trade(id: string, pnl: number, closedAtMs: number, over: Partial<HistoricalTrade> = {}): HistoricalTrade {
  return {
    id, symbol: "ETH/INR", direction: "LONG", setupName: "Breakout", entryPrice: 265000, exitPrice: 266000, quantity: 0.035,
    moneyPlaced: 9275, feesPaid: 9.3, realizedPnl: pnl, realizedPnlPercent: pnl / 92.75, isWin: pnl > 0,
    exitReason: pnl > 0 ? "TAKE_PROFIT" : "STOP_LOSS", openedAt: "", closedAt: "", closedAtMs, openedAtMs: closedAtMs - 60_000, ...over,
  };
}

// 29 Sep: −₹2,310. 2 Oct: +₹9,420. 6 Oct: −₹4,210 and +₹6,880.
const trades = [
  trade("h", -2310, noon(2026, 9, 29)),
  trade("e", 9420, noon(2026, 10, 2)),
  trade("a", -4210, noon(2026, 10, 6)),
  trade("b", 6880, noon(2026, 10, 6) + 60_000),
];

describe("the money line and the days", () => {
  it("runs the total after each closed trade from zero, oldest first", () => {
    expect(moneyLine(trades.slice(0, 1))).toBeNull();
    expect(moneyLine([...trades].reverse())!.map((p) => p.total)).toEqual([0, -2310, 7110, 2900, 9780]);
  });

  it("adds each day's trades, and lays a month out in weeks from Monday", () => {
    expect(localDay(noon(2026, 10, 6))).toBe("2026-10-06");
    const days = dayTotals(trades);
    expect(days.get("2026-10-06")).toEqual({ net: 2670, count: 2 });
    expect(days.get("2026-09-29")).toEqual({ net: -2310, count: 1 });
    // October 2026 starts on a Thursday: from Monday 28 Sep to Sunday 1 Nov.
    const oct = monthGrid(2026, 9);
    expect(oct).toHaveLength(35);
    expect(oct[0]).toEqual({ key: "2026-09-28", day: 28, inMonth: false });
    expect(oct[3]).toEqual({ key: "2026-10-01", day: 1, inMonth: true });
    expect(oct[34]).toEqual({ key: "2026-11-01", day: 1, inMonth: false });
    // February 2027 starts on a Monday and fills four weeks exactly.
    expect(monthGrid(2027, 1)).toHaveLength(28);
  });

  it("draws the line in the summary, and tints each day by what it made", () => {
    render(createElement(LedgerBook, { trades, risk: null }));
    const line = screen.getByTestId("money-line");
    // It ends up, so it's drawn in the gain colour, the dot at the top.
    expect(line.className).toBe("text-gain");
    expect(screen.getByTestId("money-line-dot").style.top).toBe(`${(4 / 72) * 100}%`);
    // Opens on the month of the latest trade.
    expect(screen.getByTestId("calendar-month").textContent).toBe("October 2026");
    expect(screen.getByTestId("day-2026-10-06").getAttribute("data-tone")).toBe("gain");
    expect(screen.getByTestId("day-2026-10-06").getAttribute("aria-label")).toBe("6 Oct: +₹2,670, 2 trades");
    expect(screen.getByTestId("day-2026-09-29").getAttribute("data-tone")).toBe("loss");
    // A day without trades is not a button.
    expect(screen.getByTestId("day-2026-10-01").tagName).toBe("SPAN");
    expect((screen.getByRole("button", { name: "Later month" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Earlier month" }));
    expect(screen.getByTestId("calendar-month").textContent).toBe("September 2026");
    expect((screen.getByRole("button", { name: "Earlier month" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows only a tapped day's trades, until the day is tapped again or its chip cleared", () => {
    render(createElement(LedgerBook, { trades, risk: null }));
    const list = () => screen.getByRole("region", { name: "Closed trades" });
    expect(within(list()).getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByTestId("day-2026-10-06"));
    expect(screen.getByTestId("day-2026-10-06").getAttribute("aria-pressed")).toBe("true");
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
    expect(list().textContent).toContain("+₹6,880.00");
    expect(list().textContent).not.toContain("+₹9,420.00");
    expect(screen.getByRole("button", { name: "Show every day" }).textContent).toBe("6 Oct ✕");
    // With Losses picked too: just the one.
    fireEvent.click(screen.getByRole("button", { name: "Losses" }));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show every day" }));
    expect(screen.queryByRole("button", { name: "Show every day" })).toBeNull();
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByTestId("day-2026-10-02"));
    fireEvent.click(screen.getByTestId("day-2026-10-02"));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(4);
  });

  it("gives each row its result in R and its move line, where the trade recorded them", () => {
    // Risked ₹70 on 0.035 ETH (₹2,000 a coin is 1R): went to +1R, down to −0.5R, closed at +0.5R; ₹142.10 is +2.03R.
    const measured = trade("m", 142.1, noon(2026, 10, 6), { riskAtOpen: 70, highestPrice: 267000, lowestPrice: 264000 });
    expect(resultR(measured)).toBeCloseTo(2.03);
    expect(resultR(trades[0])).toBeNull();
    render(createElement(LedgerBook, { trades: [measured, trades[0]], risk: null }));
    expect(screen.getAllByTestId("row-r").map((e) => e.textContent)).toEqual(["+2.03R"]);
    expect(screen.getAllByTestId("row-move")).toHaveLength(1);
    // From −1R (the stop) to +1R: the close at +0.5R is three-quarters along.
    expect(screen.getByTestId("row-move-exit").style.left).toBe("75%");
  });
});
