// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { breakoutVariants, momentumVariants, settingsResult, type SettingsCell } from "../../src/services/settingsTest";

// The Lab's settings test card: each strategy that trades, replayed at
// settings around its own, with the verdict.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { SettingsTestCard, verdictText } = await import("../../src/components/ledger/SettingsTestCard");

afterEach(cleanup);
const reply = (body: unknown) => new Response(JSON.stringify(body));
const cell = (id: string, avgR: number, trades = 50): SettingsCell => ({ id, trades, avgR, winPct: 35, yearsUp: 6, years: 9 });

// Coin breakout holds up: every nearby setting made money, doubled costs too.
const coins = settingsResult("breakout", [
  ...breakoutVariants().slice(0, 9).map((v, k) => cell(v.id, [0.4, 0.5, 0.3, 0.6, 0.87, 0.5, 0.2, 0.3, 0.1][k], k === 4 ? 476 : 50)),
  cell("stop-1.5", 0.6),
  cell("stop-3", 0.7),
  cell("costs-x2", 0.72),
]);
// US momentum is fragile: most nearby lose.
const momentum = settingsResult("momentum", [
  ...momentumVariants().slice(0, 9).map((v, k) => cell(v.id, [-0.2, -0.1, 0.05, -0.3, 0.26, -0.05, -0.1, 0.1, -0.2][k])),
  cell("costs-x2", 0.2),
]);

const dailyLong = {
  success: true,
  running: false,
  current: null,
  finished: 2,
  total: 2,
  run: null,
  records: {},
  byMarket: {},
  cohorts: {},
  classic: {},
  settings: { breakout: coins },
};
const stocksLong = {
  success: true,
  running: true,
  current: null,
  waitingForNse: false,
  finished: 0,
  total: 0,
  run: null,
  classic: {},
  cohorts: {},
  funds: {},
  settings: { us: { momentum } },
};

describe("the settings test card", () => {
  it("shows a strategy's grid with its own settings in the middle, the extra checks and the verdict", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => reply(path === "/api/daily-long" ? dailyLong : stocksLong));
    render(createElement(SettingsTestCard));
    expect(await screen.findByText("Holds up")).toBeTruthy();
    const own = screen.getByTestId("settings-cell-55/20");
    expect(own.getAttribute("aria-label")).toBe("buys above the high of 55 days, sells below the low of 20 days: +0.87R (its own settings)");
    expect(screen.getByTestId("settings-picked").textContent).toBe("Its own settings: 476 trades · 35% won · 6 of 9 years up · +0.87R a trade");
    expect(screen.getByTestId("settings-extra").textContent).toContain("Costs doubled");
    expect(screen.getByTestId("settings-verdict").textContent).toContain("All 8 nearby settings made money");
    // A tap on another setting gives its numbers.
    fireEvent.click(screen.getByTestId("settings-cell-70/30"));
    expect(screen.getByTestId("settings-picked").textContent).toBe("70 days / 30 days: 50 trades · 35% won · 6 of 9 years up · +0.10R a trade");
  });

  it("switches strategy, and says when one is still to run with its replay", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => reply(path === "/api/daily-long" ? dailyLong : stocksLong));
    render(createElement(SettingsTestCard));
    await screen.findByText("Holds up");
    fireEvent.click(screen.getByRole("button", { name: "Top 3" }));
    expect(screen.getByText("Fragile")).toBeTruthy();
    expect(screen.getByTestId("settings-verdict").textContent).toContain("Only 2 of 8 nearby settings made money");
    expect(screen.getByTestId("settings-cell-90/3").getAttribute("aria-label")).toContain("ranks the rise over 90 days, holds the top 3");
    fireEvent.click(screen.getByRole("button", { name: "Funds" }));
    expect(screen.getByText("Funds breakout: the replay is running; the test follows it.")).toBeTruthy();
  });

  it("says when doubled costs turn a strategy to a loss", () => {
    const thin = settingsResult("breakout", [
      ...breakoutVariants().slice(0, 9).map((v) => cell(v.id, 0.05)),
      cell("stop-1.5", 0.05),
      cell("stop-3", 0.05),
      cell("costs-x2", -0.02),
    ]);
    expect(thin.verdict).toBe("fragile");
    expect(verdictText(thin)).toContain("Doubled costs turn it to a loss");
  });
});
