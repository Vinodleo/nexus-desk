// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Lab's machine-learning test card: progress, then each market's verdict.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { MlTestCard } = await import("../../src/components/ledger/MlTestCard");

afterEach(cleanup);

const reply = (body: unknown) => new Response(JSON.stringify({ success: true, ...(body as object) }));
const stats = (trades: number, winPct: number, avgR: number, lowR: number) => ({ trades, winPct, avgR, lowR });
const done = {
  running: false,
  phase: "idle",
  trees: 0,
  error: null,
  ready: true,
  result: {
    ranAt: Date.parse("2026-10-02T06:00:00Z"),
    profile: "tight",
    periods: {
      trainFrom: Date.parse("2024-10-01T00:00:00Z"),
      validFrom: Date.parse("2026-01-01T00:00:00Z"),
      testFrom: Date.parse("2026-04-01T00:00:00Z"),
      testTo: Date.parse("2026-10-01T00:00:00Z"),
    },
    setups: { train: 1_100_000, trainUsed: 400_000, valid: 140_000, test: 300_000 },
    trees: 120,
    importance: [{ label: "time of day", share: 0.31 }, { label: "which trader", share: 0.22 }],
    markets: {
      crypto: { share: 0.1, everySetup: stats(20_000, 24, -0.17, -0.18), picks: stats(1500, 41, 0.09, 0.03), passed: true },
      nse: { share: 0.05, everySetup: stats(30_000, 37, -0.21, -0.22), picks: stats(800, 39, -0.12, -0.17), passed: false },
      us: null,
    },
  },
};

describe("the machine-learning test card", () => {
  it("shows each market's verdict on the months the model never saw, and what it relied on", async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(done));
    render(createElement(MlTestCard));
    const markets = await screen.findByTestId("ml-markets");
    expect(markets.textContent).toContain("CoinsPasses");
    expect(markets.textContent).toContain("Every setup: −0.17R over 20,000 trades");
    expect(markets.textContent).toContain("Its picks (the best 10%): +0.09R over 1,500 trades · 41% won · at worst about +0.03R");
    expect(markets.textContent).toContain("Indian stocksDoesn't pass");
    expect(markets.textContent).not.toContain("US stocks");
    expect(screen.getByTestId("ml-status").textContent).toBe(
      "Learned from Oct 2024 – Dec 2025 (4,00,000 setups), tuned on Jan 2026 – Mar 2026, judged on Apr 2026 – Sept 2026 (3,00,000 setups)."
    );
    expect(screen.getByTestId("ml-importance").textContent).toBe("What it relied on most: time of day 31%, which trader 22%.");
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/ml-test/run", { method: "POST" });
  });

  it("shows progress while it trains, why it couldn't run, and waits for the replay", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, running: true, phase: "training", trees: 42, result: null }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-status")).textContent).toBe("Training: 42 trees so far · it rests between steps, so it takes a while");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, error: "Too few saved setups in one of the periods.", result: null }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-status")).textContent).toBe("Couldn't run: Too few saved setups in one of the periods.");
    cleanup();

    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, ready: false, result: null }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-status")).textContent).toBe("Waits for the two-year replay to finish.");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
