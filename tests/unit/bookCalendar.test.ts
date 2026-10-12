// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade } from "../../src/types";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { LedgerBook, resultR } = await import("../../src/components/ledger/LedgerBook");
const { dayTotals, localDay, monthGrid, monthLine, monthName, monthOf, shortAmount } = await import("../../src/components/ledger/BookCalendar");

// Book → Trades: the month's total and line, its calendar of days, and each row's badge and R.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
/** Sets the phone's date (timers stay real). */
const today = (y: number, m: number, d: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(y, m - 1, d, 18));
};

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

describe("the month, its line and its days", () => {
  const OCT = 2026 * 12 + 9;

  it("runs the month's total from zero on the 1st through each close, held to today or the month's end", () => {
    expect(monthOf(noon(2026, 10, 6))).toBe(OCT);
    expect(monthName(OCT)).toBe("October 2026");
    const now = noon(2026, 10, 8);
    const oct = monthLine([...trades].reverse(), OCT, now)!;
    expect(oct.map((p) => p.total)).toEqual([0, 9420, 5210, 12090, 12090]);
    expect(oct[0].at).toBe(new Date(2026, 9, 1).getTime());
    expect(oct[1].symbol).toBe("ETH/INR");
    // This month's line ends now; a past month's at its end.
    expect(oct[oct.length - 1].at).toBe(now);
    const sep = monthLine(trades, OCT - 1, now)!;
    expect(sep.map((p) => p.total)).toEqual([0, -2310, -2310]);
    expect(sep[sep.length - 1].at).toBe(new Date(2026, 9, 1).getTime());
    expect(monthLine(trades, OCT + 1, now)).toBeNull();
  });

  it("adds each day's trades, lays a month out in weeks from Monday, and shortens a day's amount", () => {
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
    expect([640.4, -2140, 12500, -125000].map(shortAmount)).toEqual(["+640", "−2.1k", "+13k", "−1.3L"]);
  });

  it("opens on this month: its total, its line, and its days tinted by what they made", () => {
    render(createElement(LedgerBook, { trades, risk: null, now: noon(2026, 10, 8) }));
    expect(screen.getByTestId("calendar-month").textContent).toBe("October 2026");
    expect(screen.getByTestId("month-total").textContent).toBe("+₹12,090");
    expect(screen.getByTestId("month-total").className).toContain("text-gain");
    expect(screen.getByTestId("month-sub").textContent).toBe("3 trades · 2 won · after fees");
    // The line ends up, so it's drawn in the gain colour, the dot at its top.
    expect(screen.getByTestId("money-line").className).toBe("text-gain");
    expect(screen.getByTestId("money-line-dot").getAttribute("cy")).toBe("8");
    const day6 = screen.getByTestId("day-2026-10-06");
    expect(day6.getAttribute("data-tone")).toBe("gain");
    expect(day6.getAttribute("aria-label")).toBe("Tue 6 Oct: +₹2,670, 2 trades");
    expect(day6.textContent).toBe("6+2.7k");
    // A day without trades is not a button; September's days don't show in October.
    expect(screen.getByTestId("day-2026-10-01").tagName).toBe("SPAN");
    expect(screen.queryByTestId("day-2026-09-29")).toBeNull();
    // Only this month's trades are listed, each day with its total.
    expect(within(screen.getByRole("region", { name: "Closed trades" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByTestId("day-total").map((e) => e.textContent)).toEqual(["+₹2,670", "+₹9,420"]);
    expect(screen.queryByRole("button", { name: "Back to this month" })).toBeNull();
    // Nothing later than this month.
    expect((screen.getByRole("button", { name: "Later month" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the total at any point of the line under a finger", () => {
    // jsdom has no PointerEvent: a mouse event carries the finger's place.
    if (!("PointerEvent" in window)) (window as any).PointerEvent = class extends MouseEvent {};
    render(createElement(LedgerBook, { trades, risk: null, now: noon(2026, 10, 8) }));
    expect(screen.queryByTestId("line-scrub")).toBeNull();
    const line = screen.getByTestId("money-line").firstElementChild as HTMLElement;
    line.getBoundingClientRect = () => ({ left: 0, width: 350, top: 0, height: 110, right: 350, bottom: 110, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // From midnight on 1 Oct to noon on 8 Oct: noon on 6 Oct, the day's first close, is 5.5 of the 7.5 days along.
    fireEvent.pointerMove(line, { clientX: 350 * (5.5 / 7.5) });
    expect(screen.getByTestId("line-scrub").textContent).toBe("Tue 6 Oct · ETHMonth so far +₹5,210");
    fireEvent.pointerMove(line, { clientX: 0 });
    expect(screen.getByTestId("line-scrub").textContent).toBe("1 OctMonth so far ₹0");
    fireEvent.pointerMove(line, { clientX: 350 });
    expect(screen.getByTestId("line-scrub").textContent).toBe("TodayMonth so far +₹12,090");
    fireEvent.pointerLeave(line);
    expect(screen.queryByTestId("line-scrub")).toBeNull();
  });

  it("goes back to any month and forward to this one, its total rolling to the new figure", () => {
    render(createElement(LedgerBook, { trades, risk: null, now: noon(2026, 11, 20) }));
    expect(screen.getByTestId("calendar-month").textContent).toBe("November 2026");
    expect(screen.getByTestId("month-sub").textContent).toBe("No closed trades");
    expect(screen.queryByTestId("money-line")).toBeNull();
    // An empty month offers the last one with trades.
    expect(screen.getByText("No closed trades in November 2026.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to October 2026" }));
    expect(screen.getByTestId("calendar-month").textContent).toBe("October 2026");
    expect(screen.getByTestId("calendar-month").className).toContain("nx-tab-from-left");
    // Back one more to September: its one trade.
    fireEvent.click(screen.getByRole("button", { name: "Earlier month" }));
    expect(screen.getByTestId("calendar-month").textContent).toBe("September 2026");
    expect(screen.getByTestId("month-total").textContent).toBe("−₹2,310");
    expect(screen.getByTestId("month-sub").textContent).toBe("1 trade · 0 won · after fees");
    expect(screen.getByTestId("calendar-days").className).toContain("nx-tab-from-left");
    // Further back than any trade: any month.
    fireEvent.click(screen.getByRole("button", { name: "Earlier month" }));
    expect(screen.getByTestId("calendar-month").textContent).toBe("August 2026");
    fireEvent.click(screen.getByRole("button", { name: "Later month" }));
    expect(screen.getByTestId("calendar-days").className).toContain("nx-tab-from-right");
    fireEvent.click(screen.getByRole("button", { name: "Back to this month" }));
    expect(screen.getByTestId("calendar-month").textContent).toBe("November 2026");
    fireEvent.click(screen.getByRole("button", { name: "Later month" }));
    expect(screen.getByTestId("calendar-month").textContent).toBe("November 2026");
  });

  it("moves a month with a swipe sideways, but not past this one", () => {
    if (!("PointerEvent" in window)) (window as any).PointerEvent = class extends MouseEvent {};
    render(createElement(LedgerBook, { trades, risk: null, now: noon(2026, 10, 8) }));
    const swipe = (from: number, to: number) => {
      fireEvent.pointerDown(screen.getByTestId("calendar-days"), { clientX: from });
      fireEvent.pointerUp(screen.getByTestId("calendar-days"), { clientX: to });
    };
    swipe(250, 100);
    expect(screen.getByTestId("calendar-month").textContent).toBe("October 2026");
    swipe(100, 250);
    expect(screen.getByTestId("calendar-month").textContent).toBe("September 2026");
    // A small move is a tap, not a swipe.
    swipe(100, 120);
    expect(screen.getByTestId("calendar-month").textContent).toBe("September 2026");
    swipe(250, 100);
    expect(screen.getByTestId("calendar-month").textContent).toBe("October 2026");
  });

  it("shows only a tapped day's trades, until the day is tapped again or its chip cleared", () => {
    render(createElement(LedgerBook, { trades, risk: null, now: noon(2026, 10, 8) }));
    const list = () => screen.getByRole("region", { name: "Closed trades" });
    expect(within(list()).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("day-2026-10-06"));
    expect(screen.getByTestId("day-2026-10-06").getAttribute("aria-pressed")).toBe("true");
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
    expect(list().textContent).toContain("+₹6,880.00");
    expect(list().textContent).not.toContain("+₹9,420.00");
    expect(screen.getByRole("button", { name: "Show every day" }).textContent).toBe("6 Oct");
    // With Losses picked too: just the one.
    fireEvent.click(screen.getByRole("button", { name: "Losses" }));
    expect(screen.getByTestId("segment-thumb").style.transform).toBe("translateX(200%)");
    expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show every day" }));
    expect(screen.queryByRole("button", { name: "Show every day" })).toBeNull();
    expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByTestId("day-2026-10-02"));
    fireEvent.click(screen.getByTestId("day-2026-10-02"));
    expect(within(list()).getAllByRole("listitem")).toHaveLength(3);
  });

  it("badges each row with its strategy, and gives its result in R where the trade recorded its risk", () => {
    // Risked ₹70 on 0.035 ETH: ₹142.10 is +2.03R.
    const measured = trade("m", 142.1, noon(2026, 10, 6), { riskAtOpen: 70, highestPrice: 267000, lowestPrice: 264000 });
    expect(resultR(measured)).toBeCloseTo(2.03);
    expect(resultR(trades[0])).toBeNull();
    const breakout = trade("b", -900, noon(2026, 10, 5), { symbol: "NVDA.US", strategy: "breakout", exitReason: "TRAILING_STOP" });
    const fund = trade("f", 700, noon(2026, 10, 4), { symbol: "GLD.US", strategy: "breakout", exitReason: "STOP_LOSS" });
    render(createElement(LedgerBook, { trades: [measured, breakout, fund, { ...trades[1], id: "x" }], risk: null, now: noon(2026, 10, 8) }));
    expect(screen.getAllByTestId("row-r").map((e) => e.textContent)).toEqual(["+2.03R"]);
    expect(screen.getAllByTestId("row-badge").map((e) => e.textContent)).toEqual(["5m", "BO", "FD", "5m"]);
    // A breakout's own sale reads as the 20-day low, not a trailing stop.
    const list = screen.getByRole("region", { name: "Closed trades" }).textContent ?? "";
    expect(list).toContain("US breakout · Below its 20-day low");
    expect(list).toContain("Funds breakout · Stop loss");
  });
});
