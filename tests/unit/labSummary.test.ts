// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Lab's answers first: what's trading (Today), every coin strategy side
// by side and year by year (Records), from the routes the cards below read.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { LabSummary } = await import("../../src/components/ledger/LabSummary");
const { StrategyRecords } = await import("../../src/components/ledger/LabDesk");
const { StrategyLineup, yearsOf } = await import("../../src/components/ledger/StrategyLineup");
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
  "/api/us-breakout": { success: true, run: null, gate: { trader: "Breakout 55/20", trades: 554, avgR: 0.39, on: true }, slots: { used: 0, max: 2 }, nextAt: 0 },
  "/api/us-momentum": { success: true, run: null, gate: { trader: "Momentum, top 3", trades: 341, avgR: 0.26, on: true }, slots: { used: 0, max: 3 }, nextAt: 0 },
  "/api/funds-breakout": { success: true, run: null, gate: { trader: "Breakout 55/20", trades: 443, avgR: 0.54, on: true }, slots: { used: 0, max: 3 }, nextAt: 0 },
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
  "/api/stocks-long": {
    success: true, running: false, current: null, waitingForNse: false, finished: 3, total: 3, run: null, cohorts: {}, funds: {},
    classic: {
      // US breakout up in 2016 and 2024, down in 2022; momentum up in 2016 only.
      us: {
        "2016-Q1": { breakout: rec(5, 3, 6, -2), momentum: rec(4, 2, 4, -1) },
        "2022-Q3": { breakout: rec(5, 1, 1, -4), momentum: rec(4, 1, 1, -3) },
        "2024-Q2": { breakout: rec(5, 3, 5, -1) },
      },
      // Funds breakout up in 2022.
      funds: { "2022-Q1": { breakout: rec(6, 3, 6, -2) } },
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
      // Coin, US and funds breakout and US momentum are the deck of strategies above it.
      "Daily traders●1 of 2 trading+0.22R a trade since 2017, all together · 153 setups›",
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

describe("every strategy, side by side", () => {
  const rows = () => within(screen.getByTestId("lab-ranking")).getAllByRole("listitem").map((li) => li.textContent);

  it("ranks each market's strategies by their average a trade, with whether each trades now", async () => {
    render(createElement(StrategyRecords, { trailProfile: "tight" }));
    await within(await screen.findByTestId("lab-ranking")).findByText("5-minute traders, all together");
    expect(rows()).toEqual([
      "Moving averages 50/200+1.00Rsince 2018 · 2 trades · 50% won–Not traded",
      "Breakout 55/20+0.10Rsince 2018 · 10 trades · 30% won●Trading",
      "Momentum, top 3+0.00Rsince 2018 · 3 trades · 33% won–Not traded",
      "Daily traders, all together−0.15Rsince 2018 · 20 setups · 25% won●1 of 2 trading",
      // Coins aren't scanned on 5-minute candles.
      "5-minute traders, all together−0.20Rtwo years · 20 setups · 25% won–Not traded",
    ]);
    // The markets with records, a switch between them: India has none here.
    const market = screen.getByRole("group", { name: "Market" });
    expect(within(market).getAllByRole("button").map((b) => b.textContent)).toEqual(["Coins", "US", "Funds"]);
    fireEvent.click(within(market).getByRole("button", { name: "US" }));
    expect(rows()).toEqual([
      "Breakout 55/20+0.33Rsince 2016 · 15 trades · 47% won●Trading",
      "Momentum, top 3+0.13Rsince 2016 · 8 trades · 38% won●Trading",
    ]);
    fireEvent.click(within(market).getByRole("button", { name: "Funds" }));
    expect(rows()).toEqual(["Breakout 55/20+0.67Rsince 2016 · 6 trades · 50% won●Trading"]);
    // Each bar runs from zero: the funds' +0.67R, on a scale from −0.26R to +0.70R.
    const bar = screen.getByTestId("ranking-bar");
    const lo = -0.25 * 1.05;
    const hi = (4 / 6) * 1.05;
    expect(bar.style.left).toBe(`${((-lo / (hi - lo)) * 100).toFixed(2)}%`);
  });

  it("says when the coin records are from the old fee, with breakout and the daily traders paused until they replay", async () => {
    const waiting: Record<string, unknown> = {
      ...routes,
      "/api/daily-coins": { ...(routes["/api/daily-coins"] as object), traders: [], breakout: null, recordSpan: null },
      "/api/daily-long": { ...(routes["/api/daily-long"] as object), stale: true },
    };
    vi.mocked(apiFetch).mockImplementation(async (path: string) => new Response(JSON.stringify(waiting[path] ?? null), { status: waiting[path] ? 200 : 404 }));
    render(createElement(StrategyRecords, { trailProfile: "tight" }));
    await within(await screen.findByTestId("lab-ranking")).findByText("5-minute traders, all together");
    expect(screen.getByTestId("lab-ranking-stale").textContent).toBe(
      "Since 2018: From the old 0.05% coin fee: it replays with CoinDCX's real 0.59% once the other background work is done. Nothing trades on these meanwhile."
    );
    expect(rows()).toContain("Breakout 55/20+0.10Rsince 2018 · 10 trades · 30% won‖Paused");
    expect(rows()).toContain("Daily traders, all together−0.15Rsince 2018 · 20 setups · 25% won‖Paused");
    cleanup();
    render(createElement(LabSummary));
    const summary = await screen.findByTestId("lab-summary");
    await screen.findByText("Machine-learning filter");
    expect(summary.textContent).toContain("Coin breakout and daily traders‖Pausedwaiting for the replay since 2017 to finish: its records decide");
    expect(summary.textContent).not.toContain("Coin breakout 55/20");
  });

  it("shows the daily traders as switched off (your call) in both cards", async () => {
    const off: Record<string, unknown> = {
      ...routes,
      "/api/daily-coins": {
        ...(routes["/api/daily-coins"] as Record<string, unknown>),
        traders: [{ trader: "Sofia Range Scalp", trades: 145, avgR: 0.22, on: false }],
        dailyTradersOff: true,
      },
    };
    vi.mocked(apiFetch).mockImplementation(async (path: string) => new Response(JSON.stringify(off[path] ?? null), { status: off[path] ? 200 : 404 }));
    render(createElement(StrategyRecords, { trailProfile: "tight" }));
    await within(await screen.findByTestId("lab-ranking")).findByText("5-minute traders, all together");
    expect(rows()).toContain("Daily traders, all together−0.15Rsince 2018 · 20 setups · 25% won–Switched off");
    cleanup();
    render(createElement(LabSummary));
    const summary = await screen.findByTestId("lab-summary");
    await screen.findByText("Machine-learning filter");
    expect(summary.textContent).toContain("Daily traders–Switched off+0.22R a trade since 2017");
    expect(summary.textContent).not.toContain("Coin breakout 55/20");
  });

  it("draws the picked strategy year by year, and gives a year's figure on a tap", async () => {
    render(createElement(StrategyRecords, { trailProfile: "tight" }));
    await within(await screen.findByTestId("lab-ranking")).findByText("5-minute traders, all together");
    // The best first: moving averages, only in 2022.
    const years = () => screen.getByRole("region", { name: "Year by year" });
    expect(years().textContent).toContain("Coins · Moving averages 50/200");
    expect(screen.getByTestId("years-up").textContent).toBe("1 of 1 years up · tap a year for its average");
    expect(screen.getByTestId("ranking-maTrend").getAttribute("aria-pressed")).toBe("true");
    // Breakout: +0.75R in 2018, −0.33R in 2022; each column against the bigger year.
    fireEvent.click(screen.getByTestId("ranking-breakout"));
    expect(screen.getByTestId("ranking-breakout").getAttribute("aria-pressed")).toBe("true");
    expect(years().textContent).toContain("Coins · Breakout 55/20");
    expect(screen.getByTestId("years-up").textContent).toBe("1 of 2 years up · tap a year for its average");
    const cols = screen.getAllByTestId("year-column");
    expect([cols[0].style.top, cols[0].style.height]).toEqual(["4%", "46%"]);
    expect([cols[1].style.top, cols[1].style.height]).toEqual(["50%", `${((1 / 3 / 0.75) * 46).toFixed(1)}%`]);
    const y2022 = within(years()).getByRole("button", { name: "2022: −0.33R a trade over 6 trades" });
    fireEvent.click(y2022);
    expect(screen.getByTestId("year-tip").textContent).toBe("−0.33R");
    expect(cols[0].style.opacity).toBe("0.35");
    // A second tap puts it away.
    fireEvent.click(y2022);
    expect(screen.queryByTestId("year-tip")).toBeNull();
    // Another market starts on its best strategy.
    fireEvent.click(within(screen.getByRole("group", { name: "Market" })).getByRole("button", { name: "US" }));
    expect(years().textContent).toContain("US · Breakout 55/20");
    expect(screen.getByTestId("years-up").textContent).toBe("2 of 3 years up · tap a year for its average");
  });
});

describe("the deck of strategies", () => {
  it("shows each slower strategy's record and years, the one in front first, and moves on a tap, a dot or a swipe", async () => {
    const onOpen = vi.fn();
    render(createElement(StrategyLineup, { onOpen }));
    const coin = await screen.findByTestId("lineup-coin-breakout");
    await screen.findByTestId("lineup-us-momentum");
    // Coin breakout, US breakout, funds breakout, US momentum, in that order.
    expect([...screen.getByTestId("lineup-deck").children].map((s) => s.getAttribute("data-testid"))).toEqual([
      "lineup-slot-coin-breakout", "lineup-slot-us-breakout", "lineup-slot-funds-breakout", "lineup-slot-us-momentum",
    ]);
    expect(coin.textContent).toContain("COINS · DAILY");
    expect(coin.textContent).toContain("Trading on paper");
    expect(coin.textContent).toContain("a trade on average, replayed since 2018 · 476 trades");
    // The front card's average rolls up from zero; the others wait at zero.
    await waitFor(() => expect(coin.querySelector(".sr-only")?.textContent).toBe("+0.98R"));
    expect(screen.getByTestId("lineup-us-breakout").querySelector(".sr-only")?.textContent).toBe("+0.00R");
    // Its years, from the replay since 2017: up in 2018, down in 2022.
    await waitFor(() => expect(within(coin).getByTestId("lineup-years").textContent).toBe("20181 of 2 years up2022"));
    expect(coin.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByTestId("lineup-us-breakout").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("lineup-slot-coin-breakout").style.transform).toBe("none");
    expect(screen.getByTestId("lineup-slot-us-breakout").style.transform).toContain("translateX(88%)");

    fireEvent.click(screen.getByRole("button", { name: "Next strategy" }));
    const us = screen.getByTestId("lineup-us-breakout");
    expect(us.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByTestId("lineup-slot-coin-breakout").style.transform).toContain("translateX(-88%)");
    await waitFor(() => expect(us.querySelector(".sr-only")?.textContent).toBe("+0.39R"));
    expect(within(us).getByTestId("lineup-years").textContent).toBe("20162 of 3 years up2024");

    fireEvent.click(screen.getByRole("button", { name: "US momentum, top 3" }));
    const momentum = screen.getByTestId("lineup-us-momentum");
    expect(momentum.getAttribute("aria-hidden")).toBe("false");
    expect(momentum.textContent).toContain("US STOCKS · WEEKLY");
    expect(within(momentum).getByTestId("lineup-years").textContent).toBe("20161 of 2 years up2022");
    expect((screen.getByRole("button", { name: "Next strategy" }) as HTMLButtonElement).disabled).toBe(true);

    // A swipe right goes back one. (jsdom has no PointerEvent: a mouse event carries the finger's place.)
    if (!("PointerEvent" in window)) (window as any).PointerEvent = class extends MouseEvent {};
    const deck = screen.getByTestId("lineup-deck");
    fireEvent.pointerDown(deck, { clientX: 100 });
    fireEvent.pointerUp(deck, { clientX: 220 });
    expect(screen.getByTestId("lineup-funds-breakout").getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByTestId("lineup-funds-breakout").textContent).toContain("16 funds: gold, silver, bonds");

    fireEvent.click(within(screen.getByTestId("lineup-funds-breakout")).getByRole("button", { name: "See its records ›" }));
    expect(onOpen).toHaveBeenCalledWith("records");
  });

  it("says when a strategy is paused, and shows nothing without answers", async () => {
    const paused: Record<string, unknown> = {
      "/api/us-breakout": { ...(routes["/api/us-breakout"] as Record<string, unknown>), gate: { trader: "Breakout 55/20", trades: 554, avgR: 0.05, on: false } },
    };
    vi.mocked(apiFetch).mockImplementation(async (path: string) => new Response(JSON.stringify(paused[path] ?? null), { status: paused[path] ? 200 : 404 }));
    render(createElement(StrategyLineup));
    const us = await screen.findByTestId("lineup-us-breakout");
    expect(us.textContent).toContain("‖Paused");
    // No yearly records loaded: no years drawn.
    expect(within(us).queryByTestId("lineup-years")).toBeNull();
    cleanup();
    vi.mocked(apiFetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
    const { container } = render(createElement(StrategyLineup));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });

  it("counts each replayed year with trades, oldest first", () => {
    expect(yearsOf(undefined, "breakout")).toEqual([]);
    expect(
      yearsOf({ "2019-Q4": { breakout: rec(2, 1, 3, -1) }, "2018-Q1": { breakout: rec(2, 0, 0, -2) }, "2018-Q3": { breakout: rec(2, 2, 2, 0) }, "2020-Q1": { maTrend: rec(1, 1, 1, 0) } }, "breakout")
    ).toEqual([
      { year: "2018", r: 0 },
      { year: "2019", r: 1 },
    ]);
  });
});
