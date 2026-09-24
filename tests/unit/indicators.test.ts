import { describe, expect, it } from "vitest";
import { averageTrueRange, directionalIndex, trueRanges } from "../../src/services/indicators";
import { decorateBarsWithIndicators } from "../../src/services/marketDataService";
import type { MarketBar } from "../../src/types";

const bar = (close: number, high: number, low: number, i: number): MarketBar => ({
  time: String(i), timestampMs: i * 300000, open: close, high, low, close, volume: 100,
});

describe("true range and ATR", () => {
  it("uses gaps from the previous close", () => {
    const tr = trueRanges([
      { high: 10, low: 9, close: 9.5 },
      { high: 12, low: 11, close: 11.5 }, // gap up: range 1, but 2.5 above prev close
    ]);
    expect(tr).toEqual([1, 2.5]);
  });

  it("equals a constant range once warmed up, and is undefined before", () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ high: 101, low: 99, close: 100 }));
    const atr = averageTrueRange(bars, 14);
    expect(atr[13]).toBeUndefined();
    expect(atr[14]).toBeCloseTo(2);
    expect(atr[29]).toBeCloseTo(2);
  });
});

describe("ADX", () => {
  it("is high with +DI above -DI in a steady uptrend", () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({ high: 101 + i, low: 99 + i, close: 100.5 + i }));
    const { adx, plusDI, minusDI } = directionalIndex(bars, 14);
    expect(adx[26]).toBeUndefined();
    expect(adx[27]).toBeDefined(); // first ADX at 2 × period − 1
    expect(adx[59]!).toBeGreaterThan(60);
    expect(plusDI[59]!).toBeGreaterThan(minusDI[59]!);
  });

  it("is low when price just chops sideways", () => {
    const bars = Array.from({ length: 60 }, (_, i) => {
      const c = 100 + (i % 2 === 0 ? 1 : -1);
      return { high: c + 1, low: c - 1, close: c };
    });
    const { adx } = directionalIndex(bars, 14);
    expect(adx[59]!).toBeLessThan(20);
  });
});

describe("decorateBarsWithIndicators", () => {
  it("is deterministic (ADX used to include a sine wave and random noise)", () => {
    const bars = Array.from({ length: 80 }, (_, i) => bar(100 + Math.sin(i / 5) * 3, 101 + Math.sin(i / 5) * 3, 99 + Math.sin(i / 5) * 3, i));
    const a = decorateBarsWithIndicators(bars);
    const b = decorateBarsWithIndicators(bars);
    expect(a.map((x) => x.adx)).toEqual(b.map((x) => x.adx));
    expect(a[79].atr).toBeCloseTo(averageTrueRange(bars)[79]!, 3);
  });

  it("restarts VWAP at each UTC day", () => {
    const day = 24 * 60 * 60 * 1000;
    const bars: MarketBar[] = [
      { time: "a", timestampMs: day - 300000, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { time: "b", timestampMs: day, open: 20, high: 20, low: 20, close: 20, volume: 1 },
    ];
    const out = decorateBarsWithIndicators(bars);
    expect(out[0].vwap).toBe(10);
    expect(out[1].vwap).toBe(20); // new day: only its own bar
  });
});
