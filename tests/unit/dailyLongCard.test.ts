// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Lab's "Coins on daily candles since 2017" card: year by year, trader
// by trader, by trailing stop and coin by coin.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { DailyLongCard } = await import("../../src/components/ledger/DailyLongCard");

afterEach(cleanup);
const reply = (body: unknown) => new Response(JSON.stringify(body));
const rec = (trades: number, wins: number, winR: number, lossR: number) => ({ trades, wins, winR, lossR, totalR: winR + lossR });
const view = (over: Record<string, unknown> = {}) => ({
  success: true,
  running: false,
  current: null,
  finished: 3,
  total: 3,
  run: {
    startedAt: Date.parse("2026-10-03T10:00:00Z"),
    finishedAt: Date.parse("2026-10-03T12:00:00Z"),
    fromMs: Date.parse("2017-08-01T00:00:00Z"),
    toMs: Date.parse("2026-10-03T00:00:00Z"),
    done: 2,
    problems: [{ symbol: "BTG/INR", note: "BTGUSDT isn't on Binance" }],
  },
  records: {
    tight: {
      "2018-Q1": { "crypto:Sofia Range Scalp": rec(10, 2, 3, -5) },
      "2018-Q4": { "crypto:Marcus Swing Trend": rec(10, 3, 4, -3) },
      "2022-Q2": { "crypto:Sofia Range Scalp": rec(20, 10, 12, -6), "us:Sofia Range Scalp": rec(99, 99, 99, 0) },
    },
    patient: { "2022-Q2": { "crypto:Sofia Range Scalp": rec(20, 12, 16, -4) } },
  },
  byMarket: { "BTC/INR": { tight: rec(25, 10, 12, -8) }, "LUNA/INR": { tight: rec(15, 5, 7, -6), patient: rec(3, 1, 1, -1) } },
  cohorts: { "2018": ["BTC", "XRP"], "2022": ["BTC", "LUNA"] },
  ...over,
});

describe("Coins on daily candles since 2017", () => {
  it("shows each year, each trader, each trailing stop and each coin, with your trailing stop", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view()));
    render(createElement(DailyLongCard, { trailProfile: "tight" }));
    const years = await screen.findByTestId("daily-long-years");
    // 2018: −1R over 20 setups; 2022: +6R over 20 (US records left out); all: +5R over 40.
    expect(years.textContent).toBe(
      "Every trader together, year by year" + "201820 setups · 25% won · −0.05R" + "202220 setups · 50% won · +0.30R" + "All years40 setups · 38% won · +0.13R"
    );
    expect(screen.getByTestId("daily-long-traders").textContent).toBe(
      "Each trader, all years" + "Sofia Range Scalp30 setups · +0.13R" + "Marcus Swing Trend10 setups · +0.10R"
    );
    const exits = screen.getByTestId("daily-long-exits").textContent;
    expect(exits).toContain("Tight (yours)40 setups · 38% won · +0.13R");
    expect(exits).toContain("Patient20 setups · 60% won · +0.60R");
    expect(within(screen.getByTestId("daily-long-coins")).getAllByRole("listitem", { hidden: true }).map((li) => li.textContent)).toEqual([
      "BTC25 setups · +0.16R",
      "LUNA15 setups · +0.07R",
    ]);
    expect(screen.getByTestId("daily-long-cohorts").textContent).toBe("2018 BTC, XRP2022 BTC, LUNALater years use the last list.");
    expect(screen.getByText(/BTG \(BTGUSDT isn't on Binance\)/)).toBeTruthy();
    expect(screen.getByTestId("daily-long-status").textContent).toBe("1 Aug 2017 – 3 Oct 2026 · 2 coins · updated 3 Oct 2026");
  });

  it("shows its progress while it runs, and nothing for an older server", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view({ running: true, current: "LUNA/INR", finished: 12, total: 46, records: {}, byMarket: {} })));
    render(createElement(DailyLongCard, { trailProfile: "tight" }));
    expect((await screen.findByTestId("daily-long-status")).textContent).toBe("Replaying: 12 of 46 coins checked · LUNA");
    expect(screen.getByText("No results yet.")).toBeTruthy();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(reply({ success: true, events: [] }));
    const { container } = render(createElement(DailyLongCard, { trailProfile: "tight" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
