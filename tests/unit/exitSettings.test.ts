// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { simulateExit } from "../../src/services/exitComparison";
import { updateTrailingStop, type TrailState } from "../../src/shared/trailingStop";
import { applyTickToPosition } from "../../src/services/positionTick";
import { applyGuardianTick } from "../../server/guardianLogic";
import { stopSlip } from "../../src/components/ledger/LedgerBook";
import { ExitSettings } from "../../src/components/ledger/ExitSettings";
import type { HistoricalTrade, MarketBar, Position, StrategySetup } from "../../src/types";

afterEach(cleanup);

const FIVE = 5 * 60 * 1000;
const T0 = Math.floor(1_790_000_000_000 / FIVE) * FIVE;
// Candle i: [open, high, low, close]; the trade enters at candle 0's close (1000).
const candles = (rows: [number, number, number, number][]): MarketBar[] =>
  rows.map(([o, h, l, c], i) => ({ time: "", timestampMs: T0 + i * FIVE, open: o, high: h, low: l, close: c, volume: 1, atr: 5 }));
const setup = (over: Partial<StrategySetup> = {}) =>
  ({ symbol: "SOL/INR", name: "Sofia Range Scalp", family: "mean_reversion", direction: "LONG", entryPrice: 1000, stopLoss: 990, takeProfit: 1020, horizon: "intraday", ...over }) as StrategySetup;

describe("playing a setup out on candles", () => {
  it("stops out at the stop, or at the open when a candle gaps through it", () => {
    expect(simulateExit(setup(), candles([[1000, 1001, 999, 1000], [1000, 1002, 989, 995]]), 0, "tight")).toMatchObject({ reason: "STOP_LOSS", r: expect.closeTo(-1.1, 5) });
    const gap = simulateExit(setup(), candles([[1000, 1001, 999, 1000], [985, 986, 980, 982]]), 0, "tight")!;
    expect(gap.r).toBeCloseTo((-15 - 1) / 10, 5); // filled at the 985 open, not the 990 stop
  });

  it("checks the dip before the rise when a candle does both", () => {
    expect(simulateExit(setup(), candles([[1000, 1001, 999, 1000], [1000, 1025, 985, 1010]]), 0, "tight")!.reason).toBe("STOP_LOSS");
  });

  it("takes the target, with half banked at +1R on the way", () => {
    const r = simulateExit(setup({ takeProfit: 1030 }), candles([[1000, 1001, 999, 1000], [1000, 1011, 1000, 1010], [1010, 1031, 1009, 1030]]), 0, "fixed")!;
    expect(r.reason).toBe("TAKE_PROFIT");
    // Half at 1010 (+1R), half at 1030 (+3R): +2R less 0.1R fees.
    expect(r.r).toBeCloseTo(2 - 0.1, 5);
  });

  it("a tight trail takes a small win where a patient one rides to the target", () => {
    const path = candles([
      [1000, 1001, 999, 1000],
      [1000, 1009, 1000, 1008], // most of the way to +1R: tight starts trailing
      [1008, 1008, 1002, 1003], // pullback
      [1003, 1021, 1003, 1020], // then the target
    ]);
    const tight = simulateExit(setup(), path, 0, "tight")!;
    expect(tight.reason).toBe("TRAILING_STOP");
    // Patient rides to the target, where (a coin trade being a runner) its
    // stop locks; history ends there, so it's judged at the last price.
    const patient = simulateExit(setup(), path, 0, "patient")!;
    expect(patient.r).toBeGreaterThan(tight.r);
    expect(patient.r).toBeCloseTo((0.5 * 10 + 0.5 * 20) / 10 - 0.1, 5); // half at +1R, half at the 1020 target, less fees
  });

  it("lets a runner that reaches its target keep running, as the live guardian does", () => {
    const path = candles([
      [1000, 1001, 999, 1000],
      [1000, 1021, 1000, 1020], // the first target: the stop locks at 1020, the target moves out
      [1020, 1045, 1020, 1044], // runs on
      [1044, 1044, 1010, 1012], // and falls back to the locked stop
    ]);
    const r = simulateExit(setup(), path, 0, "tight")!;
    expect(r.reason).toBe("TRAILING_STOP");
    // Half banked at +1R; the rest left above the first target, never below it.
    expect(r.r).toBeGreaterThanOrEqual((0.5 * 10 + 0.5 * 20) / 10 - 0.1 - 1e-9);
  });

  it("closes at the time limit: 4 hours for a coin, 30 minutes for a stock", () => {
    const flat = (n: number) => candles(Array.from({ length: n }, () => [1000, 1003, 997, 1001] as [number, number, number, number]));
    // 48 five-minute candles after entry = 4 hours.
    const coin = simulateExit(setup(), flat(60), 0, "fixed")!;
    expect(coin.reason).toBe("EXPIRY_TIME");
    expect(simulateExit(setup({ symbol: "SBIN" }), flat(12), 0, "fixed")!.reason).toBe("EXPIRY_TIME");
  });

  it("judges a trade still open when history ends at the last price once it has run an hour, and leaves younger ones out", () => {
    const rising = candles(Array.from({ length: 20 }, (_, k) => [1000 + k, 1001 + k, 999 + k, 1000 + k] as [number, number, number, number]));
    // Still open after 19 candles (no stop, target or time limit reached): judged at the last close, 1019.
    const r = simulateExit(setup({ takeProfit: 1100 }), rising, 0, "fixed")!;
    expect(r.reason).toBe("EXPIRY_TIME");
    expect(r.r).toBeGreaterThan(0);
    expect(simulateExit(setup({ takeProfit: 1100 }), rising.slice(0, 8), 0, "fixed")).toBeNull();
  });
});

describe("trail profiles", () => {
  const state = (profile: string): TrailState => ({
    direction: "LONG", entryPrice: 1000, stopLoss: 990, takeProfit: 1020, initialTakeProfit: 1020, atrAtEntry: 5, family: "mean_reversion", trailProfile: profile,
  });

  it("start trailing at different gains, and 'fixed' never does", () => {
    const at = (profile: string, price: number) => {
      const s = state(profile);
      updateTrailingStop(s, price);
      return s.stopLoss;
    };
    expect(at("tight", 1006)).toBeGreaterThan(990); // 0.6%
    expect(at("balanced", 1006)).toBe(990);
    expect(at("balanced", 1012)).toBeGreaterThan(990); // 60% of the way
    expect(at("fixed", 1019)).toBe(990);
  });

  it("are applied the same way by the app and the server guardian", () => {
    let seed = 5;
    const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (const profile of ["balanced", "patient", "fixed"]) {
      for (let n = 0; n < 100; n++) {
        let app = { id: "p", symbol: "SOL/INR", direction: "LONG", setupName: "t", entryPrice: 1000, currentPrice: 1000, quantity: 1, stopLoss: 990, takeProfit: 1025,
          initialTakeProfit: 1025, unrealizedPnl: 0, unrealizedPnlPercent: 0, openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 30,
          metaConfidence: 0.6, atrAtEntry: 4, trailProfile: profile, family: rand() < 0.5 ? "trend_following" : "mean_reversion" } as Position;
        const srv: any = { ...app };
        let price = 1000;
        let appExit: string | null = null;
        let srvExit: string | null = null;
        for (let i = 0; i < 30 && !appExit; i++) {
          price *= 1 + (rand() - 0.47) * 0.006;
          const out = applyTickToPosition(app, price, new Map(), i + 1);
          if (out.kind === "exit") appExit = out.reason;
          else app = out.position;
          srvExit = applyGuardianTick(srv, price);
          if (!appExit) expect(srv.stopLoss).toBeCloseTo(app.stopLoss, 9);
        }
        expect(srvExit).toBe(appExit);
      }
    }
  });
});

describe("stop versus fill in the Book", () => {
  const t = (over: Partial<HistoricalTrade>) => ({ direction: "LONG", exitReason: "TRAILING_STOP", stopAtExit: 450.9, fillAtExit: 448.36, ...over }) as HistoricalTrade;
  it("shows how far past the stop a fast move sold", () => {
    expect(stopSlip(t({}))!.pct).toBeCloseTo(0.563, 2);
    expect(stopSlip(t({ fillAtExit: 451 }))!.pct).toBe(0);
    expect(stopSlip(t({ direction: "SHORT", stopAtExit: 100, fillAtExit: 101 }))!.pct).toBeCloseTo(1, 5);
    expect(stopSlip(t({ exitReason: "TAKE_PROFIT" }))).toBeNull();
    expect(stopSlip(t({ stopAtExit: undefined }))).toBeNull();
  });
});

describe("the Lab's trailing-stop card", () => {
  it("compares the settings and switches the one in use", async () => {
    const onChange = vi.fn();
    const onCompare = vi.fn(async () => ({
      coins: 8,
      results: [
        { profile: "tight" as const, label: "Tight", trades: 400, winPct: 64, avgWinR: 0.4, avgLossR: -0.9, expectancyR: -0.07, totalR: -28 },
        { profile: "balanced" as const, label: "Balanced", trades: 400, winPct: 55, avgWinR: 0.8, avgLossR: -0.85, expectancyR: 0.06, totalR: 24 },
      ],
    }));
    render(createElement(ExitSettings, { profile: "tight", onChange, onCompare }));
    fireEvent.click(screen.getByRole("button", { name: "Compare on history" }));
    await waitFor(() => expect(screen.getByRole("table", { name: "Exit settings compared" })).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Balancedbest/);
    expect(text).toContain("+0.06R");
    expect(text).toContain("400 trades the panel would have taken on 8 coins");
    fireEvent.click(screen.getByRole("button", { name: "Use this" }));
    expect(onChange).toHaveBeenCalledWith("balanced");
  });
});
