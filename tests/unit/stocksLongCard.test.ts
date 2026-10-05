// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Lab's "Stocks on daily candles since 2016" card: the classic
// strategies on US and Indian stocks, against the edge a strategy needs.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { StocksLongCard } = await import("../../src/components/ledger/StocksLongCard");

afterEach(cleanup);
const reply = (body: unknown) => new Response(JSON.stringify(body));
const rec = (trades: number, wins: number, winR: number, lossR: number) => ({ trades, wins, winR, lossR, totalR: winR + lossR });
const view = (over: Record<string, unknown> = {}) => ({
  success: true,
  running: false,
  current: null,
  waitingForNse: false,
  finished: 66,
  total: 66,
  run: {
    startedAt: 0,
    finishedAt: Date.parse("2026-10-04T06:00:00Z"),
    fromMs: Date.UTC(2015, 0, 1),
    toMs: Date.parse("2026-10-03T00:00:00Z"),
    done: ["us", "nse"],
    problems: [
      { symbol: "GE.US", note: "Only 120 days of candles" },
      { symbol: "HDFC", note: "HDFC isn't listed at Angel One" },
    ],
    adjusted: [{ symbol: "RELIANCE", count: 1 }],
  },
  classic: {
    // Breakout +1.00R in 2016 and −0.60R in 2020 (+0.20R over 20); moving averages +0.80R over 5; momentum −0.50R over 4.
    us: {
      "2016-Q2": { breakout: rec(10, 3, 15, -5) },
      "2020-Q1": { breakout: rec(10, 2, 2, -8), maTrend: rec(5, 2, 6, -2), momentum: rec(4, 1, 1, -3) },
    },
    nse: { "2018-Q1": { breakout: rec(10, 2, 1, -9) } },
  },
  cohorts: { us: { "2016": ["AAPL", "GE"] }, nse: { "2016": ["TCS", "HDFC"] } },
  funds: { us: "SPY", nse: "NIFTYBEES" },
  ...over,
});

describe("Stocks on daily candles since 2016", () => {
  it("ranks the classic strategies on US stocks against the bar, with the best one year by year, then India's", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view()));
    render(createElement(StocksLongCard));
    const ranking = await screen.findByTestId("stocks-ranking");
    // Moving averages lead, but on 5 trades: under the 10 a strategy needs.
    expect(within(ranking).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Moving averages 50/200+0.80R5 trades · 40% won✕Below the bar",
      "Breakout 55/20+0.20R20 trades · 25% won✓Above the bar",
      "Momentum, top 3−0.50R4 trades · 25% won✕Below the bar",
    ]);
    expect(screen.getByTestId("stocks-years").textContent).toContain("Best: Moving averages 50/2001 of 1 years up");
    expect(screen.getByTestId("stocks-table").textContent).toBe("Breakout50/200Top 3" + "2016+1.00——" + "2020−0.60+0.80−0.50");
    expect(screen.getByTestId("stocks-status").textContent).toBe("2016 – 3 Oct 2026 · updated 4 Oct 2026");
    expect(screen.getByTestId("stocks-problems").textContent).toBe("Not replayed: GE (Only 120 days of candles).");
    expect(screen.getByText(/SPY is above its own/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "India" }));
    expect(within(screen.getByTestId("stocks-ranking")).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Breakout 55/20−0.80R10 trades · 20% won✕Below the bar",
    ]);
    expect(screen.getByTestId("stocks-problems").textContent).toBe("Not replayed: HDFC (HDFC isn't listed at Angel One).");
    expect(screen.getByTestId("stocks-adjusted").textContent).toBe("Splits and bonus issues adjusted: RELIANCE (1).");
    expect(screen.getByTestId("stocks-cohorts").textContent).toBe("2016 TCS, HDFCLater years use the last list.");
    expect(screen.getByText(/NIFTYBEES is above its own/)).toBeTruthy();
  });

  it("shows the funds of gold, bonds and the rest on a tab of their own, without a share-market guard", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      reply(
        view({
          classic: { ...view().classic, funds: { "2022-Q1": { breakout: rec(12, 5, 14, -5) } } },
          cohorts: { ...view().cohorts, funds: { "2016": ["GLD", "TLT"] } },
          funds: { us: "SPY", nse: "NIFTYBEES", funds: "SPY" },
          run: { ...view().run, problems: [...view().run.problems, { symbol: "TLT.US", note: "Only 100 days of candles" }] },
        })
      )
    );
    render(createElement(StocksLongCard));
    await screen.findByTestId("stocks-ranking");
    // US doesn't list the fund's problem.
    expect(screen.getByTestId("stocks-problems").textContent).toBe("Not replayed: GE (Only 120 days of candles).");
    fireEvent.click(screen.getByRole("tab", { name: "Funds" }));
    expect(within(screen.getByTestId("stocks-ranking")).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Breakout 55/20+0.75R12 trades · 42% won✓Above the bar",
    ]);
    expect(screen.getByTestId("stocks-cohorts").textContent).toBe("GLD (gold), TLT (long US government bonds). The same funds every year.");
    expect(screen.getByTestId("stocks-problems").textContent).toBe("Not replayed: TLT (Only 100 days of candles).");
    expect(screen.getByText(/Holds a fund while its 50-day average is above its 200-day; or until/)).toBeTruthy();
    expect(screen.getByText(/No share-market guard/)).toBeTruthy();
  });

  it("shows its progress while it runs, and nothing for an older server", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      reply(view({ running: true, current: "RELIANCE", waitingForNse: true, finished: 40, total: 66, classic: {}, run: { ...view().run, finishedAt: null } }))
    );
    render(createElement(StocksLongCard));
    expect((await screen.findByTestId("stocks-status")).textContent).toBe("Replaying: 40 of 66 stocks checked · waiting for NSE to close before RELIANCE");
    expect(screen.getByText("No results here yet.")).toBeTruthy();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(new Response("Not found", { status: 404 }));
    const { container } = render(createElement(StocksLongCard));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
