// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Lab's "US momentum, top 3 (paper)" card: the weekly check, this week's
// top 3 and SPY's guard, what it bought, kept and sold, momentum's slots, and
// the record that decides.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { UsMomentumCard } = await import("../../src/components/ledger/UsMomentumCard");

afterEach(cleanup);
const reply = (body: unknown) => new Response(JSON.stringify(body));
const view = (over: Record<string, unknown> = {}, run: Record<string, unknown> = {}) => ({
  success: true,
  run: {
    at: Date.parse("2026-10-09T19:46:00Z"),
    day: "2026-10-09",
    coins: 21,
    failed: ["HD.US"],
    marketUp: true,
    top: [
      { symbol: "AAPL.US", rise: 0.5 },
      { symbol: "NVDA.US", rise: 0.35 },
      { symbol: "JPM.US", rise: 0.25 },
    ],
    picks: [
      { symbol: "AAPL.US", trader: "Momentum, top 3", outcome: "opened" },
      { symbol: "LLY.US", trader: "Momentum, top 3", outcome: "sold", reason: "out of the top 3" },
      { symbol: "NVDA.US", trader: "Momentum, top 3", outcome: "kept", reason: "still in the top 3 (+35% over 90 sessions)" },
      { symbol: "JPM.US", trader: "Momentum, top 3", outcome: "waiting", reason: "would exceed 2 open US stock momentum trades at once" },
    ],
    ...run,
  },
  gate: { trader: "Momentum, top 3", trades: 341, avgR: 0.26, on: true },
  slots: { used: 2, max: 2 },
  nextAt: Date.parse("2026-10-16T19:45:00Z"),
  ...over,
});

describe("US momentum trades", () => {
  it("shows the last check, the week's top 3 under SPY's guard, what it bought, kept and sold, its slots and the record", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view()));
    render(createElement(UsMomentumCard));
    expect((await screen.findByTestId("momentum-status")).textContent).toMatch(/^Last check .+ · next /);
    expect(screen.getByTestId("momentum-top").textContent).toBe("SPY above its 200-day average: momentum holds this week's top 3.1. AAPL +50%2. NVDA +35%3. JPM +25%");
    expect(within(screen.getByTestId("momentum-picks")).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "↑AAPL Momentum, top 3opened",
      "↓LLY Momentum, top 3soldout of the top 3",
      "=NVDA Momentum, top 3keptstill in the top 3 (+35% over 90 sessions)",
      "○JPM Momentum, top 3not openedwould exceed 2 open US stock momentum trades at once",
    ]);
    expect(screen.getByText("Couldn't read: HD.")).toBeTruthy();
    // Momentum's own US slots: only its own full slots count as waiting for one.
    expect(screen.getByTestId("momentum-slots").textContent).toBe(
      "Momentum slots: 2 of 2 in useJPM waited for a free slot. To take more, raise Settings → US stocks: momentum trades at once."
    );
    expect(screen.getByTestId("momentum-record").textContent).toBe("Record since 2016: 341 trades · +0.26R●Trading");
    expect(screen.getByText(/rose over the last 90 trading days/)).toBeTruthy();
  });

  it("says when SPY is below its 200-day, when the first check is, paused or waiting for the stocks' replay, and shows nothing for an older server", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(view({}, { marketUp: false, top: [], picks: [] })));
    render(createElement(UsMomentumCard));
    expect((await screen.findByTestId("momentum-top")).textContent).toBe("SPY below its 200-day average: momentum holds nothing until it's back above.");
    expect(screen.getByText("Nothing to buy or sell that week.")).toBeTruthy();
    cleanup();

    // A check that stopped early (no prices) has no picks or guard to show.
    vi.mocked(apiFetch).mockResolvedValue(reply(view({}, { marketUp: undefined, top: undefined, picks: [], failed: [], note: "No USD/INR rate yet, so US prices couldn't be read." })));
    render(createElement(UsMomentumCard));
    expect((await screen.findByTestId("momentum-picks")).textContent).toContain("No USD/INR rate yet");
    expect(screen.queryByTestId("momentum-top")).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(reply(view({ run: null, gate: { trader: "Momentum, top 3", trades: 341, avgR: -0.02, on: false } })));
    render(createElement(UsMomentumCard));
    expect((await screen.findByTestId("momentum-status")).textContent).toMatch(/^First check /);
    expect(screen.getByTestId("momentum-record").textContent).toBe("Record since 2016: 341 trades · −0.02R‖Paused");
    cleanup();

    // Momentum switched off in Settings.
    vi.mocked(apiFetch).mockResolvedValue(reply(view({ slots: { used: 0, max: 0 } })));
    render(createElement(UsMomentumCard));
    expect((await screen.findByTestId("momentum-slots")).textContent).toBe("Momentum slots: off. Settings → US stocks: momentum trades at once turns them on.");
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(reply(view({ gate: null, slots: null })));
    render(createElement(UsMomentumCard));
    expect((await screen.findByTestId("momentum-record")).textContent).toBe("Waits for the stocks' replay since 2016 to finish.");
    expect(screen.queryByTestId("momentum-slots")).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValue(new Response("Not found", { status: 404 }));
    const { container } = render(createElement(UsMomentumCard));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
