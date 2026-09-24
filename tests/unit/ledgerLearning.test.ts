// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerLearning } from "../../src/components/ledger/LedgerLearning";
import { computeLearningBreakdowns } from "../../src/services/learningStats";
import type { ExperienceVector } from "../../src/types";

afterEach(cleanup);

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
    expect(container.textContent).not.toContain("Win rate by strategy");
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
    expect(container.textContent).toContain("0% → 100% (+100 pts)");
    expect(container.textContent).toContain("Win rate by strategy · your trades");
    expect(container.textContent).toContain("3 of 4 closed trades won (75%)");
    fireEvent.click(screen.getByRole("button", { name: /Model in use/ }));
    expect(p.onOpenLab).toHaveBeenCalled();
  });
});
