// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Lab's answers first: what's trading (Today), every coin strategy side
// by side and year by year (Records), from the routes the cards below read.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { LabSummary, StrategyRanking, YearByYear } = await import("../../src/components/ledger/LabSummary");
const { labGet } = await import("../../src/components/ledger/labFeed");

afterEach(cleanup);
const rec = (trades: number, wins: number, winR: number, lossR: number) => ({ trades, wins, winR, lossR, totalR: winR + lossR });

const routes: Record<string, unknown> = {
  "/api/daily-coins": {
    success: true,
    run: null,
    traders: [
      { trader: "Sofia Range Scalp", trades: 145, avgR: 0.22, on: true },
      { trader: "Kenji Extreme Reversion", trades: 8, avgR: 0.28, on: false },
    ],
    recordSpan: "since 2017",
    breakout: { trader: "Breakout 55/20", trades: 476, avgR: 0.98, on: true },
    coinSlots: { used: 2, max: 2 },
    nextAt: 0,
  },
  "/api/scanner/exit-edge": {
    success: true,
    table: {
      profile: "tight", measuredAt: 0, symbols: 30, since: Date.parse("2026-09-27T00:00:00Z"), recordDays: 30, minMarketTrades: 20,
      rows: [
        { market: "crypto", trader: "Amara Confirmed Breakout", trades: 15, winPct: 40, avgWinR: 1, avgLossR: -0.5, avgR: 0.1, judgedR: 0.1 },
        { market: "crypto", trader: "Priya Momentum Scalp", trades: 15, winPct: 30, avgWinR: 1, avgLossR: -0.6, avgR: -0.1, judgedR: -0.1 },
        // Too few US setups to judge yet: not held back.
        { market: "us", trader: "Ravi Late-Day Momentum", trades: 5, winPct: 20, avgWinR: 1, avgLossR: -0.5, avgR: -0.3, judgedR: -0.3 },
      ],
    },
  },
  "/api/ml-test": {
    success: true, running: false, phase: "idle", trees: 0, error: null, ready: true, result: null,
    daily: {
      ready: true,
      result: {
        ranAt: 0, profile: "tight", periods: { trainFrom: 0, validFrom: 0, testFrom: 0, testTo: 0 }, setups: { train: 0, trainUsed: 0, valid: 0, test: 0 },
        trees: 50, importance: [],
        markets: {
          crypto: { share: 0.5, everySetup: { trades: 1100, winPct: 23, avgR: 0.14, lowR: 0.1 }, picks: { trades: 560, winPct: 27, avgR: 0.05, lowR: 0.01 }, passed: false },
          nse: null,
          us: null,
        },
      },
    },
  },
  "/api/daily-long": {
    success: true, running: false, current: null, finished: 3, total: 3, run: null, byMarket: {}, cohorts: {},
    // Sofia: +0.10R in 2018, −0.40R in 2022.
    records: { tight: { "2018-Q2": { "crypto:Sofia Range Scalp": rec(10, 3, 6, -5) }, "2022-Q1": { "crypto:Sofia Range Scalp": rec(10, 2, 2, -6) } } },
    // Breakout +0.75R in 2018 and −0.33R in 2022 (+0.10R over 10); the others only in 2022.
    classic: {
      "2018-Q2": { breakout: rec(4, 1, 6, -3) },
      "2022-Q1": { breakout: rec(6, 2, 3, -5), maTrend: rec(2, 1, 3, -1), momentum: rec(3, 1, 2, -2) },
    },
  },
  "/api/history": {
    success: true, running: false, phase: "idle", current: null, finished: 1, total: 1, run: null,
    // 5-minute coin trades over two years: −0.20R (the US one doesn't count).
    records: { tight: { "2026-Q2": { "crypto:Sofia Range Scalp": rec(20, 5, 4, -8), "us:Ravi Late-Day Momentum": rec(10, 9, 9, 0) } } },
  },
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string) => new Response(JSON.stringify(routes[path] ?? null), { status: routes[path] ? 200 : 404 }));
});

describe("What's trading", () => {
  it("says what trades now and on what record, and opens the tab with the details", async () => {
    const onOpen = vi.fn();
    render(createElement(LabSummary, { onOpen }));
    const list = await screen.findByTestId("lab-summary");
    await screen.findByText("Machine-learning filter");
    expect([...list.children].map((r) => r.textContent)).toEqual([
      // Sofia's +0.22R over 145 and Kenji's +0.28R over 8, together.
      "Daily traders●1 of 2 trading+0.22R a trade since 2017, all together · 153 setups›",
      "Breakout 55/20●Trading+0.98R a trade since 2018 · 476 trades›",
      "5-minute traders●2 of 3 tradingeach trader in each market, with your exits · since 27 Sept›",
      "Machine-learning filter✕Doesn't passits picks +0.05R against +0.14R for every setup · not used live›",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Daily traders/ }));
    expect(onOpen).toHaveBeenLastCalledWith("records");
    fireEvent.click(screen.getByRole("button", { name: /Machine-learning filter/ }));
    expect(onOpen).toHaveBeenLastCalledWith("tests");
    // The 5-minute traders' details are in the Book, not here.
    expect(screen.queryByRole("button", { name: /5-minute traders/ })).toBeNull();
  });

  it("reads each route once however many cards want it, and shows nothing without answers", async () => {
    const [a, b] = await Promise.all([labGet("/api/daily-coins"), labGet("/api/daily-coins")]);
    expect(a).toBe(b);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    // Once answered, the next read asks again.
    await labGet("/api/daily-coins");
    expect(apiFetch).toHaveBeenCalledTimes(2);

    vi.mocked(apiFetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
    const { container } = render(createElement(LabSummary));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});

describe("Coin strategies, side by side", () => {
  it("ranks every coin strategy by its average a trade, with whether it trades now", async () => {
    render(createElement(StrategyRanking, { trailProfile: "tight" }));
    const list = await screen.findByTestId("lab-ranking");
    await within(list).findByText("5-minute traders, all together");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Moving averages 50/200+1.00Rsince 2018 · 2 trades · 50% won–Not traded",
      "Breakout 55/20+0.10Rsince 2018 · 10 trades · 30% won●Trading",
      "Momentum, top 3+0.00Rsince 2018 · 3 trades · 33% won–Not traded",
      "Daily traders, all together−0.15Rsince 2018 · 20 setups · 25% won●1 of 2 trading",
      "5-minute traders, all together−0.20Rtwo years · 20 setups · 25% won●1 of 2 trading",
    ]);
  });

  it("draws breakout's and the daily traders' years, and gives a year's numbers on a tap", async () => {
    render(createElement(YearByYear, { trailProfile: "tight" }));
    const breakout = await screen.findByTestId("years-breakout");
    expect(breakout.textContent).toContain("Breakout 55/201 of 2 years up");
    const traders = screen.getByTestId("years-traders");
    expect(traders.textContent).toContain("Daily traders, all together1 of 2 years up");
    fireEvent.click(within(breakout).getByRole("button", { name: "2022: −0.33R a trade over 6 trades" }));
    expect(breakout.textContent).toContain("2022 · 6 trades · 33% won · −0.33R");
    fireEvent.click(within(traders).getByRole("button", { name: "2018: +0.10R a setup over 10 setups" }));
    expect(traders.textContent).toContain("2018 · 10 setups · 30% won · +0.10R");
    // A second tap puts it away.
    fireEvent.click(within(traders).getByRole("button", { name: "2018: +0.10R a setup over 10 setups" }));
    expect(traders.textContent).toContain("Tap a year for its numbers.");
  });
});
