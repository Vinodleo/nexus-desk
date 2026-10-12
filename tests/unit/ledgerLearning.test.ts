// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { LedgerLearning, LearningPlan, SkippedSetups, planProgress, PLAN_DAYS } = await import("../../src/components/ledger/LedgerLearning");
import { computeLearningBreakdowns, learningWindow, rollingWinRates } from "../../src/services/learningStats";
import type { ConditionBreakdown } from "../../src/services/conditionStats";
import type { ShadowSignal } from "../../src/services/shadowTracker";
import type { ExperienceVector } from "../../src/types";

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
  try {
    localStorage.clear();
  } catch {}
});

function exp(i: number, win: boolean, over: Partial<ExperienceVector> = {}): ExperienceVector {
  return {
    id: `exp-live-${i}`, timestamp: "", symbol: "BTC/INR", setupName: "t", family: "trend_following", regime: "trending_bullish",
    features: { adx: 30, rsi: 50, volatilityRatio: 1, volumeSurgeRatio: 1.5, vwapDist: 0 }, metaConfidence: 0.6,
    decision: "TRADE", outcome: win ? "WIN" : "LOSS", pnl: win ? 100 : -80, tags: [], ...over,
  };
}
const seeded = (i: number): ExperienceVector => ({ ...exp(i, true), id: `exp-${i}`, family: "mean_reversion" });

describe("computeLearningBreakdowns", () => {
  it("counts real trades only, by family, regime and decision quality", () => {
    const b = computeLearningBreakdowns([
      exp(1, true, { postClassification: "good_decision_good_outcome" }),
      exp(2, false, { postClassification: "good_decision_bad_outcome" }),
      exp(3, true, { family: "mean_reversion", regime: "ranging_tight" }),
      seeded(4),
      seeded(5),
    ]);
    expect(b.byFamily).toEqual([
      { key: "trend_following", trades: 2, wins: 1, winRatePct: 50 },
      { key: "mean_reversion", trades: 1, wins: 1, winRatePct: 100 },
    ]);
    expect(b.byRegime.map((r) => r.key)).toEqual(["trending_bullish", "ranging_tight"]);
    expect(b.decisions).toEqual({ goodCallGoodResult: 1, goodCallBadLuck: 1, badCallLuckyWin: 0, badCallBadResult: 0 });
  });
});

const props = (experiences: ExperienceVector[]) => ({
  experiences, autopilotTrades: 4, autopilotWins: 3, promotedLabModel: null, onOpenLab: vi.fn(),
});

describe("LedgerLearning", () => {
  it("says how many real trades it still needs before measuring anything", () => {
    const { container } = render(createElement(LedgerLearning, props([exp(1, true), seeded(2), seeded(3)])));
    expect(container.textContent).toContain("1 your real trades");
    expect(container.textContent).toContain("2 seeded examples");
    expect(container.textContent).toContain("It needs 10; you have 1 so far.");
    expect(container.textContent).not.toContain("Is it getting better?");
    // A single trade's win rate would read as 100% or 0%, so wait for enough.
    expect(container.textContent).not.toContain("Win rate, your trades");
  });

  it("shows measured learning once there are enough real trades", () => {
    // Stored newest first: 6 recent wins, then 6 early losses.
    const list = [
      ...Array.from({ length: 6 }, (_, i) => exp(100 + i, true)),
      ...Array.from({ length: 6 }, (_, i) => exp(i, false)),
    ];
    const p = props(list);
    const { container } = render(createElement(LedgerLearning, p));
    expect(container.textContent).toContain("Is it getting better?");
    expect(screen.getByTestId("improving-change").textContent).toBe("+100 pts");
    expect(screen.getByTestId("improving-windows").textContent).toBe("First 6 trades 0%Last 6 100%");
    // The win rate over the last 10, after each of the 12 trades: 6 losses, then wins climbing to 6 of 10.
    expect(screen.getByTestId("win-rate-line")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Win rate, your trades" }).textContent).toContain("Trend following50% of 12");
    // The autopilot's record and the model are with every setup.
    fireEvent.click(screen.getByRole("tab", { name: "Every setup" }));
    expect(container.textContent).toContain("3 of 4 closed trades won (75%)");
    fireEvent.click(screen.getByRole("button", { name: /Model in use/ }));
    expect(p.onOpenLab).toHaveBeenCalled();
  });
});

describe("the win rate, trade by trade", () => {
  it("is the last 10 trades' win rate after each real trade, oldest first, fewer at the start", () => {
    // Newest first: W W L, then the oldest L.
    const list = [exp(4, true), exp(3, true), exp(2, false), exp(1, false), seeded(9)];
    expect(rollingWinRates(list)).toEqual([0, 0, 1 / 3, 2 / 4]);
    expect(rollingWinRates(list, 2)).toEqual([0, 0, 0.5, 1]);
    expect(learningWindow(12)).toBe(6);
    expect(learningWindow(100)).toBe(30);
  });
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 12, 12);
const row = (setups: number) => ({ label: "x", all: { setups, winPct: 50, avgR: 0 }, coins: { setups: 0, winPct: 0, avgR: 0 }, stocks: { setups: 0, winPct: 0, avgR: 0 }, us: { setups: 0, winPct: 0, avgR: 0 } });
const conditions = (ready: number, of: number, daysAgo: number): ConditionBreakdown =>
  ({ setups: 500, since: NOW - daysAgo * DAY, groups: [{ id: "g", title: "G", rows: Array.from({ length: of }, (_, i) => row(i < ready ? 25 : 8)) }] }) as any;

describe("the learning plan", () => {
  it("counts the days of setups gathered and the condition rows with enough of them", () => {
    expect(planProgress(null, NOW)).toBeNull();
    expect(planProgress(conditions(14, 40, 11.5), NOW)).toEqual({ day: 12, ready: 14, rows: 40, filtersReady: false });
    // Most rows ready: the first step can be built.
    expect(planProgress(conditions(21, 40, 26), NOW)!.filtersReady).toBe(true);
  });

  it("shows where the plan stands, and each step's guardrails on a tap", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, table: null, conditions: conditions(14, 40, 11.5) })));
    render(createElement(LearningPlan, { now: NOW }));
    const progress = screen.getByTestId("plan-progress");
    await vi.waitFor(() => expect(progress.textContent).toBe(`Day 12 of about ${PLAN_DAYS}14 of 40 condition rows ready`));
    expect(screen.getByTestId("plan-0").textContent).toContain("Gathering dataNow");
    expect(screen.getByTestId("plan-1").textContent).toContain("Condition filtersNext");
    expect(screen.getByTestId("plan-3").textContent).toContain("More money for proven tradersLater");
    const step = screen.getByRole("button", { name: /Self-tuning traders/ });
    expect(step.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(step);
    expect(step.getAttribute("aria-expanded")).toBe("true");
    expect(step.nextElementSibling!.className).toContain("nx-fold-open");
    cleanup();

    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, table: null, conditions: conditions(30, 40, 26) })));
    render(createElement(LearningPlan, { now: NOW }));
    await vi.waitFor(() => expect(screen.getByTestId("plan-1").textContent).toContain("Condition filtersReady to build"));
    expect(screen.getByTestId("plan-0").textContent).toContain("Gathering dataDone");
  });
});

describe("the Learning tab's two parts", () => {
  it("moves between your trades and every setup, and remembers the one picked", () => {
    render(createElement(LedgerLearning, props([exp(1, true)])));
    const pill = screen.getByTestId("learning-tab-pill");
    expect(pill.style.transform).toBe("translateX(0%)");
    expect(screen.getByRole("region", { name: "Memory" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Every setup" }));
    expect(pill.style.transform).toBe("translateX(100%)");
    expect(screen.queryByRole("region", { name: "Memory" })).toBeNull();
    expect(screen.getByRole("region", { name: "How accurate the win chance is" })).toBeTruthy();
    cleanup();
    render(createElement(LedgerLearning, props([exp(1, true)])));
    expect(screen.getByRole("tab", { name: "Every setup" }).getAttribute("aria-selected")).toBe("true");
  });

  it("explains each kind of call on a tap", () => {
    const list = Array.from({ length: 10 }, (_, i) => exp(i, i < 5, { postClassification: i < 5 ? "good_decision_good_outcome" : "bad_decision_bad_outcome" }));
    render(createElement(LedgerLearning, props(list)));
    const card = screen.getByRole("region", { name: "Decision vs outcome" });
    expect(card.textContent).toContain("5Good callgood result");
    fireEvent.click(screen.getByRole("button", { name: /Bad call\s*bad result/ }));
    expect(screen.getByTestId("decision-note").textContent).toBe("A weak setup that lost. These are the ones the desk learns from.");
  });
});

const shadow = (kind: string, r: number, confidence = 0.62): ShadowSignal =>
  ({ id: `${kind}-${Math.random()}`, kind, status: r > 0 ? "target" : "stop", r, confidence, scorer: "rules", foundAt: 0 }) as any;

describe("every setup", () => {
  it("flags a skip reason that did as well as the proposed setups", () => {
    const shadows = [
      ...Array.from({ length: 5 }, () => shadow("proposed", 0.5)),
      ...Array.from({ length: 5 }, () => shadow("wide_spread", 0.8)),
      ...Array.from({ length: 5 }, () => shadow("low_confidence", -0.4)),
    ];
    render(createElement(SkippedSetups, { shadows }));
    expect(screen.getByTestId("skip-wide_spread").textContent).toContain("Costing trades?");
    expect(screen.getByTestId("skip-low_confidence").textContent).not.toContain("Costing trades?");
    expect(screen.getByTestId("skip-proposed").textContent).not.toContain("Costing trades?");
    cleanup();
    // Skipped setups that lost no more than losing proposed ones cost nothing.
    render(createElement(SkippedSetups, { shadows: [...Array.from({ length: 5 }, () => shadow("proposed", -0.6)), ...Array.from({ length: 5 }, () => shadow("wide_spread", -0.3))] }));
    expect(screen.getByTestId("skip-wide_spread").textContent).not.toContain("Costing trades?");
  });
});
