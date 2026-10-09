// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Position } from "../../src/types";
import { TradeTicket, ticketFor, ticketKind, ticketWhy } from "../../src/components/ledger/TradeTicket";
import { US_FEE_RATE_PER_SIDE } from "../../src/shared/usMarket";

// The ticket a newly opened trade unfolds into: what was bought and why, and
// on paper the free cash it took.

afterEach(cleanup);

const qqq: Position = {
  id: "q1", symbol: "QQQ.US", direction: "LONG", setupName: "Breakout 55/20", strategy: "breakout", entryPrice: 72812, currentPrice: 72812,
  quantity: 1.3732, stopLoss: 71029, initialStopLoss: 71029, takeProfit: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0,
  openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 525600, metaConfidence: 0.6, openedByServer: true,
};
const nvda: Position = { ...qqq, id: "n1", symbol: "NVDA.US", entryPrice: 23073, currentPrice: 23073, quantity: 4.3339, stopLoss: 22034, initialStopLoss: 22034 };
const sol: Position = { ...qqq, id: "s1", symbol: "SOL/INR", entryPrice: 14000, currentPrice: 14000, quantity: 0.5, stopLoss: 13000, initialStopLoss: 13000, isLiveOrder: true };

describe("a trade's ticket", () => {
  it("takes the trade's cost from the free cash on paper, and has none live", () => {
    // ₹72,812 × 1.3732 = ₹99,985.44, and Alpaca's fees to open it.
    expect(ticketFor(qqq, "server", { money: 1_000_000, freeBefore: 800_008 }).cash).toEqual({
      money: 1_000_000, before: 800_008, after: 800_008 - 72812 * 1.3732 * (1 + US_FEE_RATE_PER_SIDE),
    });
    expect(ticketFor(qqq, "server", { money: 1_000_000, freeBefore: 50_000 }).cash?.after).toBe(0);
    expect(ticketFor(sol, "server", { money: 1_000_000, freeBefore: 800_000 }).cash).toBeUndefined();
    expect(ticketFor(qqq, "you").cash).toBeUndefined();
  });

  it("names the kind of trade and says why the slower strategies took it", () => {
    expect(ticketKind(qqq)).toBe("Funds breakout 55/20");
    expect(ticketKind(nvda)).toBe("US breakout 55/20");
    expect(ticketKind({ ...sol, isLiveOrder: false })).toBe("Coin breakout 55/20");
    expect(ticketKind({ ...nvda, strategy: "momentum" })).toBe("US momentum, top 3");
    expect(ticketKind({ ...nvda, strategy: undefined, setupName: "Nora Opening Range" })).toBe("Nora Opening Range");
    expect(ticketWhy(nvda)).toContain("above its 55-day high at the 3:45 pm New York check");
    expect(ticketWhy(sol)).toContain("closed above its 55-day high at the daily check");
    expect(ticketWhy({ ...nvda, strategy: "momentum" })).toContain("SPY above its 200-day average");
    expect(ticketWhy({ ...nvda, strategy: undefined })).toBeNull();
  });

  it("shows the first trade with its numbers and the free cash it took, then the next, then closes", () => {
    const onNext = vi.fn();
    const onDone = vi.fn();
    const onOpenFloor = vi.fn();
    const tickets = [ticketFor(qqq, "server", { money: 1_000_000, freeBefore: 800_008 }), ticketFor(nvda, "server", { money: 1_000_000, freeBefore: 700_023 })];
    const { rerender } = render(createElement(TradeTicket, { tickets, onNext, onDone, onOpenFloor }));
    const ticket = screen.getByRole("dialog", { name: "QQQ.US" });
    expect(ticket.textContent).toContain("TRADE OPENED");
    expect(ticket.textContent).toContain("Funds breakout 55/20 · by the server");
    expect(screen.getByTestId("ticket-stamp").textContent).toBe("PAPER");
    expect(ticket.textContent).toContain("Price₹72,812");
    expect(ticket.textContent).toContain("Shares1.3732");
    expect(ticket.textContent).toContain("Money in it₹99,985");
    expect(ticket.textContent).toContain("Stop₹71,029");
    // 1.3732 × ₹1,783 = ₹2,448 lost at the stop.
    expect(ticket.textContent).toContain("At the stop, before fees−₹2,448");
    expect(screen.getByTestId("ticket-cash").textContent).toContain("Free cash₹8,00,008 → ₹7,00,018");
    expect(screen.getByTestId("ticket-cash").textContent).toContain("₹99,990 is tied up in this trade until it closes.");
    // The bar drains from 80% free to 70%.
    const drain = ticket.querySelector(".nx-ticket-drain") as HTMLElement;
    expect(drain.style.width).toBe("70%");
    expect(drain.style.getPropertyValue("--nx-from")).toBe("80.0%");

    fireEvent.click(screen.getByRole("button", { name: "Next (1 more)" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    rerender(createElement(TradeTicket, { tickets: tickets.slice(1), onNext, onDone, onOpenFloor }));
    expect(screen.getByRole("dialog", { name: "NVDA.US" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "See it on the Floor" }));
    expect(onOpenFloor).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDone).toHaveBeenCalledTimes(2);
    rerender(createElement(TradeTicket, { tickets: [], onNext, onDone, onOpenFloor }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stamps a live trade LIVE, with no paper cash", () => {
    render(createElement(TradeTicket, { tickets: [ticketFor(sol, "autopilot")], onNext: vi.fn(), onDone: vi.fn(), onOpenFloor: vi.fn() }));
    expect(screen.getByTestId("ticket-stamp").textContent).toBe("LIVE");
    expect(screen.queryByTestId("ticket-cash")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Coin breakout 55/20 · by the autopilot");
    expect(screen.getByRole("dialog").textContent).toContain("Quantity0.5");
  });
});
