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
        nextAt: Date.parse("2026-10-04T00:10:00Z"),
      })
    );
    render(createElement(DailyCoinsCard));
    expect((await screen.findByTestId("daily-status")).textContent).toMatch(/^Last check .+ · 34 coins · next /);
    const picks = within(screen.getByTestId("daily-picks")).getAllByRole("listitem").map((li) => li.textContent);
    expect(picks).toEqual([
      "AVAX Sofia Range Scalpopened",
      "LINK Sofia Range Scalpnot openedwould exceed 2 open coin trades at once",
      "ETH Kenji Extreme Reversionpausedonly 8 replayed setups (needs 10)",
    ]);
    expect(screen.getByText("Couldn't read: MON.")).toBeTruthy();
    const record = screen.getByTestId("daily-traders").textContent;
    expect(record).toContain("Sofia Range Scalp145 setups · +0.22R");
    expect(record).toContain("Kenji Extreme Reversion · paused8 setups · +0.28R");
  });

  it("says when the first check is before there's been one, and why nothing opened for a desk", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply({ success: true, run: null, traders, nextAt: Date.parse("2026-10-04T00:10:00Z") }));
    render(createElement(DailyCoinsCard));
    expect((await screen.findByTestId("daily-status")).textContent).toMatch(/^First check /);
    expect(screen.queryByTestId("daily-picks")).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(
      reply({ success: true, run: { at: 1, day: "2026-10-03", coins: 34, failed: [], picks: [], note: "Autopilot is off, so no daily trades were opened." }, traders, nextAt: 2 })
    );
    render(createElement(DailyCoinsCard));
    expect((await screen.findByTestId("daily-picks")).textContent).toBe("Autopilot is off, so no daily trades were opened.No setups that day.");
  });

  it("shows nothing for an older server", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("Not found", { status: 404 }));
    const { container } = render(createElement(DailyCoinsCard));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
