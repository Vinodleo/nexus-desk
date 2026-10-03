// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Lab's "Daily coin trades (paper)" card: the server's daily check, what
// it found and did, and which traders trade.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { DailyCoinsCard } = await import("../../src/components/ledger/DailyCoinsCard");

afterEach(cleanup);
const reply = (body: unknown) => new Response(JSON.stringify(body));
const traders = [
  { trader: "Sofia Range Scalp", trades: 145, avgR: 0.22, on: true },
  { trader: "Kenji Extreme Reversion", trades: 8, avgR: 0.28, on: false },
];

describe("Daily coin trades", () => {
  it("shows the last check, what it opened and why the rest waited, and each trader's daily record", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      reply({
        success: true,
        run: {
          at: Date.parse("2026-10-03T00:15:00Z"),
          day: "2026-10-03",
          coins: 34,
          failed: ["MON/INR"],
          picks: [
            { symbol: "AVAX/INR", trader: "Sofia Range Scalp", outcome: "opened" },
            { symbol: "LINK/INR", trader: "Sofia Range Scalp", outcome: "waiting", reason: "would exceed 2 open coin trades at once" },
            { symbol: "ETH/INR", trader: "Kenji Extreme Reversion", outcome: "paused", reason: "only 8 replayed setups (needs 10)" },
          ],
        },
        traders,
        recordSpan: "since 2017",
        coinSlots: { used: 2, max: 2, breakout: { used: 1, max: 3 } },
        nextAt: Date.parse("2026-10-04T00:10:00Z"),
      })
    );
    render(createElement(DailyCoinsCard));
    expect((await screen.findByTestId("daily-status")).textContent).toMatch(/^Last check .+ · 34 coins · next /);
    const picks = within(screen.getByTestId("daily-picks")).getAllByRole("listitem").map((li) => li.textContent);
    expect(picks).toEqual([
      "↑AVAX Sofia Range Scalpopened",
      "○LINK Sofia Range Scalpnot openedwould exceed 2 open coin trades at once",
      "‖ETH Kenji Extreme Reversionpausedonly 8 replayed setups (needs 10)",
    ]);
    expect(screen.getByText("Couldn't read: MON.")).toBeTruthy();
    // Both coin slots are taken: LINK waited for one, and the way to more is in Settings.
    expect(screen.getByTestId("daily-slots").textContent).toBe(
      "Coin slots: 2 of 2 in useLINK waited for a free slot. To take more, raise Settings → Coins: trades at once."
    );
    expect(screen.getByText("Which traders trade (1 of 2)", { exact: false, selector: "summary" })).toBeTruthy();
    // Breakout's own slots, apart from the traders'.
    expect(screen.getByTestId("daily-breakout-slots").textContent).toBe("Breakout slots: 1 of 3 in use");
    const record = screen.getByTestId("daily-traders").textContent;
    expect(record).toMatch(/^Daily record since 2017 with your trailing stop/);
    expect(screen.getByText(/Only traders whose daily record since 2017 is positive/)).toBeTruthy();
    expect(record).toContain("Sofia Range Scalp145 setups · +0.22R");
    expect(record).toContain("Kenji Extreme Reversion · paused8 setups · +0.28R");
  });

  it("says when the first check is before there's been one, and why nothing opened for a desk", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ success: true, run: null, traders, nextAt: Date.parse("2026-10-04T00:10:00Z") }));
    render(createElement(DailyCoinsCard));
    expect((await screen.findByTestId("daily-status")).textContent).toMatch(/^First check /);
    // An older server: the two-year record.
    expect(screen.getByTestId("daily-traders").textContent).toMatch(/^Daily record over two years with your trailing stop/);
    expect(screen.queryByTestId("daily-picks")).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(
      reply({ success: true, run: { at: 1, day: "2026-10-03", coins: 34, failed: [], picks: [], note: "Autopilot is off, so no daily trades were opened." }, traders, nextAt: 2 })
    );
    render(createElement(DailyCoinsCard));
    expect((await screen.findByTestId("daily-picks")).textContent).toBe("Autopilot is off, so no daily trades were opened.No setups that day.");
  });

  it("shows breakout 55/20's sales and its record since 2018 next to the traders", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      reply({
        success: true,
        run: {
          at: 1,
          day: "2026-10-03",
          coins: 34,
          failed: [],
          picks: [
            { symbol: "SOL/INR", trader: "Breakout 55/20", outcome: "opened" },
            { symbol: "XRP/INR", trader: "Breakout 55/20", outcome: "sold", reason: "closed below its 20-day low" },
          ],
        },
        traders,
        recordSpan: "since 2017",
        breakout: { trader: "Breakout 55/20", trades: 476, avgR: 0.98, on: true },
        nextAt: 2,
      })
    );
    render(createElement(DailyCoinsCard));
    const picks = within(await screen.findByTestId("daily-picks")).getAllByRole("listitem").map((li) => li.textContent);
    expect(picks).toEqual(["↑SOL Breakout 55/20opened", "↓XRP Breakout 55/20soldclosed below its 20-day low"]);
    expect(screen.getByTestId("daily-breakout").textContent).toBe("Breakout record since 2018Breakout 55/20476 trades · +0.98R");
    expect(screen.getByText(/it buys a close above the 55-day high and sells a\s+close below the 20-day low/)).toBeTruthy();
    cleanup();

    // No coin slots from an older server.
    expect(screen.queryByTestId("daily-slots")).toBeNull();
    // Paused; and before it has run (or an older server), no line.
    vi.mocked(apiFetch).mockResolvedValue(reply({ success: true, run: null, traders, breakout: { trader: "Breakout 55/20", trades: 476, avgR: -0.02, on: false }, nextAt: 2 }));
    render(createElement(DailyCoinsCard));
    expect((await screen.findByTestId("daily-breakout")).textContent).toBe("Breakout record since 2018Breakout 55/20 · paused476 trades · −0.02R");
    cleanup();
    vi.mocked(apiFetch).mockResolvedValue(reply({ success: true, run: null, traders, breakout: null, nextAt: 2 }));
    render(createElement(DailyCoinsCard));
    await screen.findByTestId("daily-status");
    expect(screen.queryByTestId("daily-breakout")).toBeNull();
  });

  it("shows nothing for an older server", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("Not found", { status: 404 }));
    const { container } = render(createElement(DailyCoinsCard));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
