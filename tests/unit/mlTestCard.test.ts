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
    expect((await screen.findByTestId("ml-progress")).textContent).toBe("Training: 42 trees so far · it rests between steps, so it takes a while");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();

    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, error: "Too few saved setups in one of the periods.", result: null }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-progress")).textContent).toBe("Couldn't run: Too few saved setups in one of the periods.");
    cleanup();

    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, ready: false, result: null }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-status")).textContent).toBe("Waits for the two-year replay to finish.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the daily coin test's verdict on the latest year, above the 5-minute one", async () => {
    const dailyResult = {
      ...done.result,
      periods: {
        trainFrom: Date.parse("2017-08-01T00:00:00Z"),
        validFrom: Date.parse("2024-10-01T00:00:00Z"),
        testFrom: Date.parse("2025-10-01T00:00:00Z"),
        testTo: Date.parse("2026-10-01T00:00:00Z"),
      },
      setups: { train: 30_000, trainUsed: 30_000, valid: 4000, test: 4000 },
      importance: [{ label: "Bitcoin's last 30 days", share: 0.4 }],
      markets: { crypto: { share: 0.5, everySetup: stats(1100, 23, 0.07, 0.02), picks: stats(560, 28, 0.15, 0.06), passed: true }, nse: null, us: null },
    };
    vi.mocked(apiFetch).mockResolvedValue(reply({ ...done, daily: { ready: true, result: dailyResult } }));
    render(createElement(MlTestCard));
    const daily = await screen.findByTestId("ml-daily");
    expect(daily.textContent).toMatch(/^Daily coin trades since 2017/);
    expect(screen.getByTestId("ml-daily-status").textContent).toBe(
      "Learned from Aug 2017 – Sept 2024 (30,000 setups), tuned on Oct 2024 – Sept 2025, judged on Oct 2025 – Sept 2026 (4,000 setups)."
    );
    expect(screen.getByTestId("ml-daily-markets").textContent).toBe(
      "CoinsPassesEvery setup: +0.07R over 1,100 tradesIts picks (the best 50%): +0.15R over 560 trades · 28% won · at worst about +0.06R"
    );
    expect(screen.getByTestId("ml-daily-importance").textContent).toBe("What it relied on most: Bitcoin's last 30 days 40%.");
    // First the verdict, its picks against every setup, and each market's 5-minute picks; the numbers above sit under "Details".
    expect(screen.getByTestId("ml-verdict").textContent).toBe(
      "Can a model pick the better daily coin setups? On the latest year, which it never saw, its picks averaged +0.15R a trade against +0.07R for every setup. It decides nothing live."
    );
    expect(screen.getByTestId("ml-compare").textContent).toBe("Every setup1,100 trades+0.07R" + "Its picks560 trades+0.15R");
    expect(screen.getByTestId("ml-five-minute").textContent).toBe("Coins+0.09R✓Passes" + "India−0.12R✕No");
    expect(screen.getByText("Details", { exact: false, selector: "summary" })).toBeTruthy();
    // The 5-minute verdict below, as before.
    expect(screen.getByText("5-minute trades over two years")).toBeTruthy();
    expect(screen.getByTestId("ml-markets").textContent).toContain("CoinsPasses");
    cleanup();

    // Running the daily test; then waiting for the replay since 2017.
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, running: true, testing: "daily", phase: "training", trees: 7, daily: { ready: false, result: null } }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-progress")).textContent).toBe("Daily coins: Training: 7 trees so far · it rests between steps, so it takes a while");
    expect(screen.getByTestId("ml-daily-status").textContent).toBe("Waits for the replay since 2017 to finish.");
  });

  it("shows the breakout test: every trade against its picks and the ones it would skip, per market, and whether skipping adds profit", async () => {
    const verdict = (every: number, picks: number, skipped: number, passed: boolean, from: number) => ({
      fromYear: from, toYear: 2025, every: stats(260, 30, every, every - 0.3), picks: stats(130, 35, picks, picks - 0.4), skipped: stats(130, 25, skipped, skipped - 0.4),
      importance: [{ label: "volatility (ATR)", share: 0.4 }], passed,
    });
    const breakout = { ready: true, result: { ranAt: 0, markets: { coins: verdict(0.98, 1.1, 0.86, false, 2022), us: verdict(0.39, 0.7, -0.6, true, 2020) } } };
    vi.mocked(apiFetch).mockResolvedValue(reply({ ...done, breakout }));
    render(createElement(MlTestCard));
    const coins = await screen.findByTestId("ml-breakout-coins");
    expect(coins.textContent).toBe(
      "Coins judged 2022–2025✕Doesn't pass" + "Every trade260 trades+0.98R" + "Its picks130 trades+1.10R" + "Skipped130 trades+0.86R" +
        "The trades it skips still made +0.86R a trade: skipping them would cost profit."
    );
    expect(screen.getByTestId("ml-breakout-us").textContent).toContain("US stocks judged 2020–2025✓Passes");
    expect(screen.getByTestId("ml-breakout-us").textContent).toContain("The trades it skips clearly lost: skipping them would add profit.");
    cleanup();

    // Before the replays have saved their breakout trades; then too few years; then running.
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, breakout: { ready: false, result: null } }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-breakout-status")).textContent).toBe("Waits for the replays to save their breakout trades.");
    cleanup();
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, breakout: { ready: true, result: { ranAt: 0, markets: { coins: null, us: null } } } }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-breakout-status")).textContent).toBe("Too few years of breakout trades to judge yet.");
    cleanup();
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, running: true, testing: "breakout", phase: "judging", breakout: { ready: true, result: null } }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-progress")).textContent).toBe(
      "Breakout and momentum trades: Judging year by year · it rests between steps, so it takes a while"
    );
  });

  it("shows the funds' tests (gold, bonds and the rest) beside the markets that trade, marked as not traded", async () => {
    const verdict = (passed: boolean) => ({
      fromYear: 2020, toYear: 2025, every: stats(300, 35, 0.2, 0.05), picks: stats(150, 40, 0.5, 0.2), skipped: stats(150, 30, -0.3, -0.5),
      importance: [], passed,
    });
    const breakout = { ready: true, result: { ranAt: 0, markets: { coins: null, us: null, funds: verdict(true) }, momentum: { markets: { funds: verdict(false) } } } };
    vi.mocked(apiFetch).mockResolvedValue(reply({ ...done, breakout }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-breakout-funds")).textContent).toContain("Gold, bond and other funds (not traded) judged 2020–2025✓Passes");
    expect(screen.getByTestId("ml-momentum-funds").textContent).toContain("Gold, bond and other funds (not traded) judged 2020–2025✕Doesn't pass");
  });

  it("shows momentum's test the same way, coins marked as not traded", async () => {
    const verdict = (every: number, picks: number, skipped: number, passed: boolean, from: number) => ({
      fromYear: from, toYear: 2025, every: stats(200, 40, every, every - 0.3), picks: stats(100, 45, picks, picks - 0.4), skipped: stats(100, 35, skipped, skipped - 0.4),
      importance: [{ label: "rise over 90 days", share: 0.4 }], passed,
    });
    const momentum = { markets: { coins: verdict(0.11, 0.2, 0.02, false, 2022), us: verdict(0.26, 0.6, -0.5, true, 2020) } };
    const breakout = { ready: true, result: { ranAt: 0, markets: { coins: null, us: null }, momentum } };
    vi.mocked(apiFetch).mockResolvedValue(reply({ ...done, breakout }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-momentum-coins")).textContent).toBe(
      "Coins (not traded) judged 2022–2025✕Doesn't pass" + "Every trade200 trades+0.11R" + "Its picks100 trades+0.20R" + "Skipped100 trades+0.02R" +
        "The trades it skips still made +0.02R a trade: skipping them would cost profit."
    );
    expect(screen.getByTestId("ml-momentum-us").textContent).toContain("US stocks judged 2020–2025✓Passes");
    expect(screen.getByTestId("ml-breakout-status").textContent).toBe("Too few years of breakout trades to judge yet.");
    cleanup();

    // A verdict from before momentum was tested, or one with none of its trades saved: it waits for the replays to save them.
    const waits = "Waits for the replays to save their momentum trades.";
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, breakout: { ready: true, result: { ranAt: 0, markets: { coins: null, us: null } } } }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-momentum-status")).textContent).toBe(waits);
    cleanup();
    const unsaved = { savedAt: { coins: null, us: null }, markets: { coins: null, us: null } };
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, breakout: { ready: true, result: { ranAt: 0, ...unsaved, savedAt: { coins: 1, us: null }, momentum: unsaved } } }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-momentum-status")).textContent).toBe(waits);
    expect(screen.getByTestId("ml-breakout-status").textContent).toBe("Too few years of breakout trades to judge yet.");
    cleanup();
    // Never run: ready once either strategy's trades are saved.
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, breakout: { ready: true, result: null } }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-momentum-status")).textContent).toBe("Ready to run.");
    cleanup();
    vi.mocked(apiFetch).mockResolvedValueOnce(reply({ ...done, breakout: { ready: false, result: null } }));
    render(createElement(MlTestCard));
    expect((await screen.findByTestId("ml-momentum-status")).textContent).toBe(waits);
  });
});
