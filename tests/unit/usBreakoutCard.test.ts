// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Lab's "US breakout 55/20 (paper)" card: the 3:45 pm New York check,
// what it bought and sold, the US slots, and the record that decides.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { UsBreakoutCard } = await import("../../src/components/ledger/UsBreakoutCard");

afterEach(cleanup);
const reply = (body: unknown) => new Response(JSON.stringify(body));
const view = (over: Record<string, unknown> = {}) => ({
  success: true,
  run: {
    at: Date.parse("2026-10-05T19:46:00Z"),
    day: "2026-10-05",
    coins: 20,
    failed: ["HD.US"],
    picks: [
      { symbol: "AAPL.US", trader: "Breakout 55/20", outcome: "opened" },
      { symbol: "MSFT.US", trader: "Breakout 55/20", outcome: "sold", reason: "closed below its 20-day low" },
      { symbol: "NVDA.US", trader: "Breakout 55/20", outcome: "waiting", reason: "would exceed 2 open US stock breakout trades at once" },
    ],
  },
  gate: { trader: "Breakout 55/20", trades: 554, avgR: 0.39, on: true },
  slots: { used: 2, max: 2 },
  nextAt: Date.parse("2026-10-06T19:45:00Z"),
  ...over,
});

describe("US breakout trades", () => {
  it("shows the last check, what it bought and sold, the US slots and the record", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view()));
    render(createElement(UsBreakoutCard));
    expect((await screen.findByTestId("us-status")).textContent).toMatch(/^Last check .+ · 20 stocks · next /);
    expect(within(screen.getByTestId("us-picks")).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "↑AAPL Breakout 55/20opened",
      "↓MSFT Breakout 55/20soldclosed below its 20-day low",
      "○NVDA Breakout 55/20not openedwould exceed 2 open US stock breakout trades at once",
    ]);
    expect(screen.getByText("Couldn't read: HD.")).toBeTruthy();
    // Breakout's own US slots.
    expect(screen.getByTestId("us-slots").textContent).toBe(
      "Breakout slots: 2 of 2 in useNVDA waited for a free slot. To take more, raise Settings → US stocks: breakout trades at once."
    );
    expect(screen.getByTestId("us-record").textContent).toBe("Record since 2016: 554 trades · +0.39R●Trading");
    expect(screen.getByText(/at 3:45 pm New York/)).toBeTruthy();
  });

  it("says when the first check is, paused or waiting for the stocks' replay, and shows nothing for an older server", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view({ run: null, gate: { trader: "Breakout 55/20", trades: 554, avgR: -0.02, on: false } })));
    render(createElement(UsBreakoutCard));
    expect((await screen.findByTestId("us-status")).textContent).toMatch(/^First check /);
    expect(screen.getByTestId("us-record").textContent).toBe("Record since 2016: 554 trades · −0.02R‖Paused");
    cleanup();

    // Breakout switched off in Settings.
    vi.mocked(apiFetch).mockResolvedValue(reply(view({ slots: { used: 0, max: 0 } })));
    render(createElement(UsBreakoutCard));
    expect((await screen.findByTestId("us-slots")).textContent).toBe("Breakout slots: off. Settings → US stocks: breakout trades at once turns them on.");
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(reply(view({ gate: null, slots: null })));
    render(createElement(UsBreakoutCard));
    expect((await screen.findByTestId("us-record")).textContent).toBe("Waits for the stocks' replay since 2016 to finish.");
    expect(screen.queryByTestId("us-slots")).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(new Response("Not found", { status: 404 }));
    const { container } = render(createElement(UsBreakoutCard));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
