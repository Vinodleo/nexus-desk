// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ROUND_TRIP_FEE, resolveShadow, shadowFromSetup, shadowStore, summarizeShadows, type ShadowSignal } from "../../src/services/shadowTracker";
import { SkippedSetups } from "../../src/components/ledger/LedgerLearning";
import type { MarketBar } from "../../src/types";

afterEach(cleanup);

const FIVE = 5 * 60 * 1000;
const T0 = Math.floor(1_790_000_000_000 / FIVE) * FIVE;
const setup: any = { symbol: "SOL/INR", name: "Trend", family: "trend_following", direction: "LONG", entryPrice: 1000, stopLoss: 990, takeProfit: 1020 };
const signal = (kind: ShadowSignal["kind"] = "low_confidence") => shadowFromSetup(setup, kind, T0, { confidence: 0.55 });
const bar = (i: number, low: number, high: number, close = (low + high) / 2): MarketBar => ({
  time: "", timestampMs: T0 + i * FIVE, open: close, high, low, close, volume: 1,
});

describe("resolveShadow", () => {
  it("records a target hit, after fees", () => {
    const s = resolveShadow(signal(), [bar(-1, 900, 1100), bar(0, 998, 1005), bar(1, 1001, 1021)]);
    expect(s.status).toBe("target");
    expect(s.r).toBeCloseTo((20 - 1000 * ROUND_TRIP_FEE) / 10); // 1.9R
  });

  it("records a stop hit, and counts a candle that touched both as the stop", () => {
    expect(resolveShadow(signal(), [bar(0, 989, 1005)]).status).toBe("stop");
    const both = resolveShadow(signal(), [bar(0, 985, 1025)]);
    expect(both.status).toBe("stop");
    expect(both.r).toBeCloseTo((-10 - 1) / 10);
  });

  it("closes an intraday signal at the 30-minute limit", () => {
    const bars = Array.from({ length: 8 }, (_, i) => bar(i, 995, 1008, 1004));
    const s = resolveShadow(signal(), bars);
    expect(s.status).toBe("expired");
    expect(s.exitPrice).toBe(1004);
    expect(s.r).toBeCloseTo((4 - 1) / 10);
  });

  it("stays open while it's still running", () => {
    expect(resolveShadow(signal(), [bar(0, 995, 1008)], T0 + FIVE).status).toBe("open");
  });
});

describe("summaries and storage", () => {
  const done = (kind: ShadowSignal["kind"], status: ShadowSignal["status"], r: number, i: number): ShadowSignal => ({
    ...shadowFromSetup(setup, kind, T0 + i * FIVE), status, r,
  });

  it("groups by kind, proposed first, with target rate and average R", () => {
    const rows = summarizeShadows([
      done("low_confidence", "target", 1.9, 1),
      done("low_confidence", "stop", -1.1, 2),
      done("proposed", "target", 2, 3),
      { ...signal("low_confidence"), id: "open-one" },
    ]);
    expect(rows[0]).toMatchObject({ kind: "proposed", tracked: 1, resolved: 1, targetPct: 100, avgR: 2 });
    expect(rows[1]).toMatchObject({ kind: "low_confidence", tracked: 3, resolved: 2, targetPct: 50 });
    expect(rows[1].avgR).toBeCloseTo(0.4);
  });

  it("keeps one record per setup per candle", () => {
    shadowStore._reset();
    shadowStore.add([signal(), signal()]);
    shadowStore.add([signal()]);
    expect(shadowStore.all()).toHaveLength(1);
    shadowStore.resolve(() => [bar(0, 998, 1021)]);
    expect(shadowStore.all()[0].status).toBe("target");
  });
});

describe("SkippedSetups card", () => {
  it("shows rates once enough setups have finished, and dashes before", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...shadowFromSetup(setup, "low_confidence", T0 + i * FIVE), status: "target" as const, r: 1.9 }));
    const { container } = render(createElement(SkippedSetups, { shadows: [...many, { ...shadowFromSetup(setup, "proposed", T0), status: "stop" as const, r: -1.1 }] }));
    const text = container.textContent ?? "";
    expect(text).toContain("Chance of a win too low");
    expect(text).toContain("5 of 5 finished");
    expect(text).toContain("100%");
    expect(text).toContain("+1.90R");
    expect(text).toContain("1 of 1 finished"); // proposed: too few for numbers
  });
});
