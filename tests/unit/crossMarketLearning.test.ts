// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { crossMarketPrior, exitEdgeFor, expectancyRows, judgedR, MIN_MARKET_TRADES, type ExpectancyTable } from "../../src/services/exitExpectancy";
import { conditionBreakdown, resultAfterSpread } from "../../src/services/conditionStats";
import { shadowFromSetup, type ShadowSignal } from "../../src/services/shadowTracker";
import { WhenSetupsWin } from "../../src/components/ledger/LedgerBreakdown";
import type { StrategySetup } from "../../src/types";

// Coins and stocks learn from each other: a trader is judged in one market
// together with their record in the other, and setups are broken down by the
// conditions they appeared in, both markets pooled.

afterEach(cleanup);

const rec = (trades: number, avgR: number) => ({ trades, totalR: trades * avgR, wins: 0, winR: 0, lossR: 0 });
const table = (byKey: ExpectancyTable["byKey"]): ExpectancyTable => ({ profile: "tight", measuredAt: 0, symbols: 10, byKey });

describe("judging a trader across markets", () => {
  // Sofia, from the screenshot: +0.22R on 3 coin setups (judged alone), −0.61R over 56 stock setups.
  const sofia = table({
    "crypto:Sofia Range Scalp": { trades: 3, totalR: 0.22 * 11, wins: 1, winR: 1.12, lossR: -0.46 },
    "nse:Sofia Range Scalp": rec(56, -0.61),
    "crypto:Filler": rec(MIN_MARKET_TRADES, 0),
  });

  it("leans on the other market's record: a few lucky coin setups don't outweigh a long losing stock record", () => {
    const prior = crossMarketPrior(sofia, "crypto", "Sofia Range Scalp");
    expect(prior).toBeCloseTo((56 * -0.61) / 64, 6);
    const judged = judgedR(sofia, "crypto", "Sofia Range Scalp");
    expect(judged).toBeCloseTo((0.22 * 11 + 8 * prior) / 11, 6);
    expect(judged).toBeLessThan(0);
    // So the scanner pauses her on coins.
    expect(exitEdgeFor(sofia, "SOL/INR", "Sofia Range Scalp")!.r).toBeCloseTo(judged, 9);
  });

  it("counts a good record elsewhere for half, and nothing when there's none", () => {
    const t = table({ "nse:Chen": rec(40, 0.5), "crypto:Chen": rec(0, 0), "crypto:New": rec(5, 0.2) });
    expect(crossMarketPrior(t, "crypto", "Chen")).toBeCloseTo(((40 * 0.5) / 48) * 0.5, 6);
    expect(crossMarketPrior(t, "crypto", "New")).toBe(0);
    expect(judgedR(t, "crypto", "New")).toBeCloseTo(1 / 13, 6);
  });

  it("shows what the other market adds in the table rows", () => {
    const row = expectancyRows(sofia).find((r) => r.market === "crypto" && r.trader === "Sofia Range Scalp")!;
    expect(row.otherMarketR).toBeLessThan(0);
    expect(row.judgedR).toBeLessThan(0);
  });
});

const T0 = Date.parse("2026-09-24T04:30:00Z"); // 10:00 IST
function shadow(over: Partial<ShadowSignal> = {}): ShadowSignal {
  return {
    id: String(Math.random()), symbol: "SOL/INR", direction: "LONG", setupName: "Chen", family: "trend_following", horizon: "intraday",
    kind: "proposed", entryPrice: 100, stopLoss: 98, takeProfit: 104, signalTime: T0, expiresAt: T0, status: "target", exitPrice: 104, r: 1,
    regime: "trending_bullish", setupFeatures: { adx: 32, rsi: 60, volumeSurgeRatio: 2, vwapDistancePercent: 0.1 }, ...over,
  };
}

describe("when setups win", () => {
  it("charges the spread on top of fees", () => {
    // 0.6% of ₹100 on a ₹2 stop: 0.3R.
    expect(resultAfterSpread(shadow(), 0.006)).toBeCloseTo(0.7, 9);
    expect(resultAfterSpread(shadow({ r: undefined }), 0.006)).toBeNull();
  });

  it("groups finished intraday setups by condition, coins and stocks together and each", () => {
    const list = [
      shadow({ r: 1 }),
      shadow({ r: -1, status: "stop", regime: "ranging_tight" }),
      shadow({ symbol: "SBIN", r: 0.5, btcChange1hPct: -1.2 }),
      shadow({ status: "open", r: undefined }),
      shadow({ horizon: "swing", r: 3 }),
    ];
    const out = conditionBreakdown(list, (s) => (s === "SOL/INR" ? 0.006 : 0.0002));
    expect(out.setups).toBe(3);
    const mood = out.groups.find((g) => g.id === "regime")!;
    const up = mood.rows.find((r) => r.label === "Trending up")!;
    expect(up.all.setups).toBe(2);
    expect(up.coins).toMatchObject({ setups: 1, winPct: 100 });
    expect(up.coins.avgR).toBeCloseTo(0.7, 9);
    expect(up.stocks.setups).toBe(1);
    expect(up.stocks.avgR).toBeCloseTo(0.5 - (0.0002 * 100) / 2, 9);
    expect(mood.rows.find((r) => r.label === "Quiet range")!.all).toMatchObject({ setups: 1, winPct: 0 });
    // Only setups that recorded Bitcoin's move count there.
    expect(out.groups.find((g) => g.id === "btc")!.rows).toEqual([
      expect.objectContaining({ label: "Falling (−0.5% or more)", all: expect.objectContaining({ setups: 1 }) }),
    ]);
    expect(out.groups.find((g) => g.id === "hour")!.rows[0].label).toBe("08:00–12:00");
  });

  it("records Bitcoin's last hour with each new setup", () => {
    const setup = { symbol: "SOL/INR", name: "Chen", family: "trend_following", direction: "LONG", entryPrice: 100, stopLoss: 98, takeProfit: 104, horizon: "intraday" } as StrategySetup;
    expect(shadowFromSetup(setup, "proposed", T0, { btcChange1hPct: -0.8123 }).btcChange1hPct).toBe(-0.812);
    expect(shadowFromSetup(setup, "proposed", T0, { btcChange1hPct: null }).btcChange1hPct).toBeUndefined();
  });

  it("shows each condition's result, flags an edge and what's too early, and switches market", () => {
    const many = (n: number, over: Partial<ShadowSignal>) => Array.from({ length: n }, () => shadow(over));
    const data = conditionBreakdown([...many(25, { r: 0.4 }), ...many(5, { regime: "ranging_tight", r: -1 }), ...many(3, { symbol: "SBIN", r: -0.5 })]);
    render(createElement(WhenSetupsWin, { data }));
    const mood = screen.getByLabelText("Market mood");
    expect(within(mood).getByText("Trending up").closest("li")!.textContent).toMatch(/28 setups · \d+% ahead · has an edge/);
    expect(within(mood).getByText("Quiet range").closest("li")!.textContent).toMatch(/too early/);
    fireEvent.click(screen.getByRole("button", { name: "Indian stocks" }));
    expect(within(screen.getByLabelText("Market mood")).getByText("Trending up").closest("li")!.textContent).toMatch(/3 setups · 0% ahead · too early/);
    expect(within(screen.getByLabelText("Market mood")).queryByText("Quiet range")).toBeNull();
  });
});
