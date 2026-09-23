import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyTickToPosition, priceForPosition, type SuspectTick } from "../../src/services/positionTick";
import type { Position } from "../../src/types";
import { legacyTick } from "./legacyPositionTick";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// Small deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomPosition(r: () => number, i: number): Position {
  const long = r() < 0.5;
  const entry = 100 + r() * 900;
  const stopDist = entry * (0.003 + r() * 0.02);
  const tpDist = stopDist * (1 + r() * 3);
  const trailModes = [undefined, "SCALP_TIGHT", "TREND_RUNNER"] as const;
  const families = [undefined, "trend_following", "breakout_confirmation", "mean_reversion"] as const;
  return {
    id: `pos-${i}`,
    symbol: r() < 0.9 ? "BTC/INR" : "ETH/INR",
    direction: long ? "LONG" : "SHORT",
    setupName: "t",
    entryPrice: entry,
    currentPrice: entry,
    quantity: 1 + Math.floor(r() * 5),
    stopLoss: long ? entry - stopDist : entry + stopDist,
    takeProfit: long ? entry + tpDist : entry - tpDist,
    initialTakeProfit: r() < 0.8 ? (long ? entry + tpDist : entry - tpDist) : undefined,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    openTime: new Date().toISOString(),
    expectedHoldingTimeMinutes: r() < 0.3 ? 4320 : 30,
    metaConfidence: 0.6,
    highestPrice: r() < 0.5 ? entry : undefined,
    lowestPrice: r() < 0.5 ? entry : undefined,
    trailActive: false,
    atrAtEntry: r() < 0.8 ? entry * (0.002 + r() * 0.01) : undefined,
    family: families[Math.floor(r() * families.length)] as Position["family"],
    trailMode: trailModes[Math.floor(r() * trailModes.length)],
  } as Position;
}

const FIELDS = ["stopLoss", "takeProfit", "highestPrice", "lowestPrice", "trailActive"] as const;

describe("applyTickToPosition matches the original inline logic", () => {
  it("across 2,000 random price paths", () => {
    const r = rng(42);
    let exitsCompared = 0;
    let stepsCompared = 0;

    for (let path = 0; path < 2000; path++) {
      const start = randomPosition(r, path);
      let legacyPos: Position = { ...start };
      let newPos: Position = { ...start };
      const legacyPending = { current: new Map<string, number>() };
      const newPending = new Map<string, SuspectTick>();
      let price = start.entryPrice;

      for (let step = 0; step < 60; step++) {
        const roll = r();
        if (roll < 0.03) price *= r() < 0.5 ? 0.6 : 1.5; // implausible spike
        else price *= 1 + (r() - 0.5) * 0.01;
        const prices: Record<string, number> =
          r() < 0.05 ? { "BTC/USDT": price / 83.5, "ETH/USDT": price / 83.5 } : r() < 0.05 ? {} : { [start.symbol]: price };

        const legacy = legacyTick([legacyPos], prices, legacyPending);
        const out = applyTickToPosition(newPos, priceForPosition(newPos, prices), newPending, step);

        // Same exit decision
        expect(out.kind === "exit").toBe(legacy.exits.length === 1);
        expect([...newPending.entries()].map(([k, v]) => [k, v.price])).toEqual([...legacyPending.current.entries()]);

        if (out.kind === "exit") {
          const le = legacy.exits[0];
          expect(out.reason).toBe(le.reason);
          expect(out.price).toBeCloseTo(le.price, 6);
          for (const f of FIELDS) expect(out.position[f]).toEqual(le.pos[f]);
          exitsCompared++;
          break;
        }

        // The state each version carries into the next tick: the old code
        // returned the (mutated-in-place) previous array when "unchanged";
        // App returns the new copy only when changed.
        legacyPos = legacy.changed ? legacy.pushed[0] : legacyPos;
        newPos = out.kind === "updated" && out.changed ? out.position : newPos;

        for (const f of FIELDS) expect(newPos[f]).toEqual(legacyPos[f]);
        expect(newPos.currentPrice).toBeCloseTo(legacyPos.currentPrice, 3);
        stepsCompared++;
      }
    }

    // Make sure the paths actually exercised both outcomes.
    expect(exitsCompared).toBeGreaterThan(300);
    expect(stepsCompared).toBeGreaterThan(10000);
  });
});

describe("applyTickToPosition", () => {
  const base = (): Position =>
    ({
      id: "p", symbol: "BTC/INR", direction: "LONG", entryPrice: 1000, currentPrice: 1000, quantity: 2,
      stopLoss: 990, takeProfit: 1030, initialTakeProfit: 1030, atrAtEntry: 5, trailMode: "SCALP_TIGHT",
      expectedHoldingTimeMinutes: 30, trailActive: false,
    }) as Position;

  it("never mutates the position it's given", () => {
    const p = base();
    const snapshot = JSON.stringify(p);
    applyTickToPosition(p, 1012, new Map(), 1);
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it("holds a >25% tick until a second one confirms it", () => {
    const pending = new Map<string, SuspectTick>();
    expect(applyTickToPosition(base(), 1400, pending, 1).kind).toBe("rejected");
    expect(pending.get("p")).toEqual({ price: 1400, tickSeq: 1 });
    expect(applyTickToPosition(base(), 1405, pending, 2).kind).toBe("exit"); // confirmed: past TP
    expect(pending.has("p")).toBe(false);
  });

  it("can't be confirmed by re-applying the same tick batch (React dev double-invoke)", () => {
    const pending = new Map<string, SuspectTick>();
    expect(applyTickToPosition(base(), 1400, pending, 7).kind).toBe("rejected");
    expect(applyTickToPosition(base(), 1400, pending, 7).kind).toBe("rejected");
    expect(applyTickToPosition(base(), 1401, pending, 8).kind).toBe("exit");
  });

  it("uses the USDT pair when the INR price is missing", () => {
    expect(priceForPosition({ symbol: "BTC/INR" }, { "BTC/USDT": 10 })).toBe(835);
    expect(priceForPosition({ symbol: "BTC/INR" }, {})).toBeUndefined();
  });

  it("computes unrealized P&L on the updated copy", () => {
    const out = applyTickToPosition(base(), 1005, new Map(), 1);
    expect(out.kind).toBe("updated");
    if (out.kind === "updated") {
      expect(out.position.unrealizedPnl).toBe(10);
      expect(out.position.unrealizedPnlPercent).toBeCloseTo(0.5, 6);
    }
  });
});
