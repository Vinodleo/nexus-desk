// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Lab's "Traders over two years" card: the server's history replay, as
// far as it has got.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { HistoryCard } = await import("../../src/components/ledger/HistoryCard");

afterEach(cleanup);

const rec = (trades: number, wins: number, winR: number, lossR: number) => ({ trades, wins, winR, lossR, totalR: winR + lossR });
const view = (over: Record<string, unknown> = {}) => ({
  success: true,
  running: false,
  phase: "idle",
  current: null,
  finished: 3,
  total: 3,
  run: {
    startedAt: Date.parse("2026-10-01T10:00:00Z"),
    finishedAt: Date.parse("2026-10-01T16:00:00Z"),
    fromMs: Date.parse("2024-10-01T00:00:00Z"),
    toMs: Date.parse("2026-10-01T00:00:00Z"),
    markets: { crypto: { done: 2, failed: 1, skipped: 0 }, us: { done: 0, failed: 0, skipped: 0 }, nse: { done: 0, failed: 0, skipped: 0 } },
    setups: { count: 1234567, bytes: 52 * 1024 * 1024, full: false },
    problems: [{ symbol: "WIF/INR", note: "WIFUSDT isn't on Binance" }],
  },
  records: {
    tight: {
      "2026-Q2": { "crypto:Sofia Range Scalp": rec(10, 6, 3, -2), "crypto:Diego Aggressive Breakout": rec(10, 4, 2, -4) },
      "2026-Q3": { "crypto:Sofia Range Scalp": rec(10, 5, 2, -3) },
    },
    patient: { "2026-Q3": { "crypto:Sofia Range Scalp": rec(20, 12, 8, -4) } },
  },
  ...over,
});
const reply = (body: unknown) => new Response(JSON.stringify(body));

describe("Traders over two years", () => {
  it("shows each trader's result with your exits, by half-year, and every exit profile on the same setups", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view()));
    render(createElement(HistoryCard, { trailProfile: "tight" }));
    const list = await screen.findByTestId("history-traders");
    const rows = within(list).getAllByRole("listitem");
    // Best first: Sofia averages +0.00R over 20, Diego −0.20R over 10.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Sofia Range Scalp20 setups · 55% won · win +0.45R · loss −0.56R+0.00R"),
      expect.stringContaining("Diego Aggressive Breakout10 setups · 40% won · win +0.50R · loss −0.67R−0.20R"),
    ]);
    // One half-year here (Apr–Sep 2026): Sofia's +0.00, Diego's −0.20.
    expect(screen.getByText("Apr–Sep 2026")).toBeTruthy();
    const exits = screen.getByTestId("history-exits");
    expect(exits.textContent).toContain("Tight (yours)30 setups · 50% won · −0.07R");
    expect(exits.textContent).toContain("Patient20 setups · 60% won · +0.20R");
    expect(screen.getByTestId("history-status").textContent).toBe("1 Oct 2024 – 1 Oct 2026 · updated 1 Oct 2026");
    expect(screen.getByText(/WIF\/INR \(WIFUSDT isn't on Binance\)/)).toBeTruthy();
    expect(screen.getByTestId("history-setups").textContent).toBe("Setup details saved for machine learning: 12,34,567 setups (52.0 MB)");
    expect(screen.getByRole("tab", { name: "Coins · 2" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "US · 0" }));
    expect(screen.getByText("No results here.")).toBeTruthy();
  });

  it("switches to the slower trades: the same traders on hourly or daily candles", async () => {
    const slow = { "1h": { tight: { "2026-Q3": { "crypto:Marcus Swing Trend": rec(40, 18, 30, -20) } } }, "1d": {} };
    vi.mocked(apiFetch).mockResolvedValue(reply(view({ slow })));
    render(createElement(HistoryCard, { trailProfile: "tight" }));
    await screen.findByTestId("history-traders");
    expect(screen.getByTestId("history-timeframe").textContent).toMatch(/^As the desk trades today/);
    fireEvent.click(screen.getByRole("tab", { name: "1 hour" }));
    expect(screen.getByTestId("history-timeframe").textContent).toMatch(/^Slower: hourly candles, stops sized on them \(wider\), held up to 5 days/);
    const rows = within(screen.getByTestId("history-traders")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Marcus Swing Trend40 setups · 45% won · win +1.67R · loss −0.91R+0.25R")]);
    fireEvent.click(screen.getByRole("tab", { name: "1 day" }));
    expect(screen.getByText("No results here.")).toBeTruthy();
  });

  it("checks the coins against a list fixed in advance, and shows each market's own result on slower candles", async () => {
    const slow = { "1h": {}, "1d": { tight: { "2026-Q3": { "crypto:Marcus Swing Trend": rec(40, 21, 18, -8) } } } };
    const slowByMarket = {
      "BTC/INR": { "1d": { tight: rec(10, 6, 6, -2), patient: rec(10, 2, 1, -8) } },
      "PEPE/INR": { "1d": { tight: rec(10, 3, 2, -6) } },
      "WIF/INR": { "1d": { tight: rec(20, 12, 10, -4) } },
      // No setups with your trailing stop: left out.
      "ETH/INR": { "1d": { patient: rec(5, 3, 2, -1) } },
      "AAPL.US": { "1d": { tight: rec(5, 3, 2, -1) } },
    };
    vi.mocked(apiFetch).mockResolvedValue(reply(view({ slow, slowByMarket })));
    render(createElement(HistoryCard, { trailProfile: "tight" }));
    await screen.findByTestId("history-traders");
    // Not on 5-minute candles.
    expect(screen.queryByTestId("history-markets")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "1 day" }));
    const box = screen.getByTestId("history-markets");
    // Bitcoin and Pepe are on the fixed list (+0.40R and −0.40R), WIF is one of today's picks.
    expect(box.textContent).toContain("Coin check: a list fixed in advance against today's picks");
    expect(box.textContent).toContain("Fixed list · 2 coins20 setups · 45% won · +0.00R");
    expect(box.textContent).toContain("Today's picks · 1 coin20 setups · 60% won · +0.30R");
    expect(box.textContent).toContain("Each coin (3)");
    expect(within(box).getAllByRole("listitem", { hidden: true }).map((li) => li.textContent)).toEqual([
      "BTCfixed list10 setups · +0.40R",
      "WIF20 setups · +0.30R",
      "PEPEfixed list10 setups · −0.40R",
    ]);
    // US stocks: each stock, no coin check.
    fireEvent.click(screen.getByRole("tab", { name: "US · 0" }));
    const us = screen.getByTestId("history-markets");
    expect(us.textContent).not.toContain("Coin check");
    expect(us.textContent).toContain("Each stock (1)");
    expect(within(us).getAllByRole("listitem", { hidden: true }).map((li) => li.textContent)).toEqual(["AAPL5 setups · +0.20R"]);
  });

  it("shows nothing for a reply without results (an older server)", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ success: true, events: [] }));
    const { container } = render(createElement(HistoryCard, { trailProfile: "tight" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });

  it("shows progress while it runs, and can replay again once it's done", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply(view({ running: true, phase: "waiting_for_nse", current: "RELIANCE", finished: 40, total: 131 })));
    render(createElement(HistoryCard, { trailProfile: "tight" }));
    expect((await screen.findByTestId("history-status")).textContent).toBe("Replaying: 40 of 131 markets checked · waiting for NSE to close RELIANCE");
    expect(screen.queryByRole("button", { name: "Replay again" })).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(reply(view()));
    render(createElement(HistoryCard, { trailProfile: "tight" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replay again" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/history/run", { method: "POST" });
  });
});
