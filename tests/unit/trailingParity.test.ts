// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), authenticateSocket: vi.fn() }));

import { applyTickToPosition } from "../../src/services/positionTick";
import { applyGuardianTick } from "../../server/guardianLogic";
import { mergeGuardState } from "../../src/shared/trailingStop";
import { adoptGuardianState, useGuardianSync } from "../../src/hooks/useGuardianSync";
import type { Position } from "../../src/types";

const position = (over: Partial<Position> = {}): Position => ({
  id: "p", symbol: "SOL/INR", direction: "LONG", setupName: "t", entryPrice: 1000, currentPrice: 1000, quantity: 2,
  stopLoss: 990, takeProfit: 1020, initialTakeProfit: 1020, unrealizedPnl: 0, unrealizedPnlPercent: 0,
  openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 30, metaConfidence: 0.6, atrAtEntry: 5,
  highestPrice: 1000, lowestPrice: 1000, trailActive: false, trailMode: "TREND_RUNNER", family: "trend_following", ...over,
});

/** Runs the same prices through the browser book and the server guardian. */
function bothSides(start: Position, path: number[]) {
  let app: Position = { ...start };
  const srv: any = { ...start };
  let appExit: string | null = null;
  let srvExit: string | null = null;
  const steps: { app: [number, number] | null; srv: [number, number] | null }[] = [];
  path.forEach((price, i) => {
    if (!appExit) {
      const out = applyTickToPosition(app, price, new Map(), i + 1);
      if (out.kind === "exit") appExit = `${out.reason}@${price}`;
      else app = out.position;
    }
    if (!srvExit) {
      const r = applyGuardianTick(srv, price);
      if (r) srvExit = `${r}@${price}`;
    }
    steps.push({ app: appExit ? null : [app.stopLoss, app.takeProfit], srv: srvExit ? null : [srv.stopLoss, srv.takeProfit] });
  });
  return { appExit, srvExit, steps };
}

describe("the app and the server guardian trail the same way", () => {
  it("lets a trend trade run past its first target on both sides", () => {
    const r = bothSides(position(), [1005, 1010, 1015, 1021, 1026, 1030, 1024, 1019]);
    // Past 1020 the stop locks there and the target moves to 1050, so neither side
    // takes profit at 1021 (the server used to, closing the trade first).
    expect(r.steps[3].srv).toEqual([1020, 1050]);
    expect(r.appExit).toBe("TRAILING_STOP@1019");
    expect(r.srvExit).toBe("TRAILING_STOP@1019");
  });

  it("starts trailing a trend trade at a 0.8% gain on both sides", () => {
    const r = bothSides(position({ atrAtEntry: 10, takeProfit: 1040, initialTakeProfit: 1040 }), [1004, 1008, 1009, 1005, 1001]);
    expect(r.steps[1].srv).toEqual([1002, 1040]);
    expect(r.appExit).toBe("TRAILING_STOP@1001");
    expect(r.srvExit).toBe("TRAILING_STOP@1001");
  });

  it("agrees on every tick across random paths, both directions, both modes", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let n = 0; n < 500; n++) {
      const short = rand() < 0.5;
      const runner = rand() < 0.5;
      const start = position({
        direction: short ? "SHORT" : "LONG",
        stopLoss: short ? 1010 : 990,
        takeProfit: short ? 975 : 1025,
        initialTakeProfit: short ? 975 : 1025,
        trailMode: runner ? "TREND_RUNNER" : "SCALP_TIGHT",
        family: runner ? "trend_following" : "mean_reversion",
        atrAtEntry: 3 + rand() * 8,
      });
      let price = 1000;
      const path = Array.from({ length: 40 }, () => (price = price * (1 + (rand() - 0.5) * 0.008)));
      const r = bothSides(start, path);
      expect(r.srvExit).toBe(r.appExit);
      r.steps.forEach((s, i) => {
        if (s.app && s.srv) {
          expect(s.srv[0]).toBeCloseTo(s.app[0], 9);
          expect(s.srv[1]).toBeCloseTo(s.app[1], 9);
        }
        expect(Boolean(s.app)).toBe(Boolean(s.srv));
        void i;
      });
    }
  });
});

describe("keeping the two copies in step", () => {
  it("a sync from the app can't pull back an extended target or loosen the stop", () => {
    const server = { stopLoss: 1020, takeProfit: 1050, highestPrice: 1030, trailActive: true };
    const app = { stopLoss: 1002, takeProfit: 1020, highestPrice: 1015, trailActive: true };
    expect(mergeGuardState("LONG", 1000, server, app)).toMatchObject({ stopLoss: 1020, takeProfit: 1050, highestPrice: 1030 });
    // Mirror for a short.
    expect(mergeGuardState("SHORT", 1000, { stopLoss: 980, takeProfit: 950 }, { stopLoss: 998, takeProfit: 980 })).toMatchObject({
      stopLoss: 980,
      takeProfit: 950,
    });
  });

  it("the reopened app takes up what the guardian moved while it slept", () => {
    const stale = position({ stopLoss: 1002, takeProfit: 1020, highestPrice: 1015, trailActive: true });
    const other = position({ id: "q" });
    const next = adoptGuardianState([stale, other], [{ id: "p", stopLoss: 1020, takeProfit: 1050, highestPrice: 1030, lowestPrice: 1000, trailActive: true }]);
    expect(next[0]).toMatchObject({ stopLoss: 1020, takeProfit: 1050, highestPrice: 1030 });
    expect(next[1]).toBe(other);
    // Nothing new: the same array back, so React doesn't re-render.
    expect(adoptGuardianState(next, [{ id: "p", stopLoss: 1010, takeProfit: 1050, highestPrice: 1030, lowestPrice: 1000, trailActive: true }])).toBe(next);
  });
});

describe("syncing to the guardian", () => {
  afterEach(() => vi.useRealTimers());

  it("sends at once when positions open or close, and at most every 1.5s for price moves", async () => {
    vi.useFakeTimers();
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ success: true, events: [] })));
    const syncs = () => apiFetch.mock.calls.filter(([u]) => u === "/api/daemon/sync-positions").length;
    let positions = [position()];
    const { rerender } = renderHook(() => useGuardianSync(positions, vi.fn(), vi.fn()));
    expect(syncs()).toBe(1); // first position: at once
    for (let i = 1; i <= 10; i++) {
      positions = [position({ currentPrice: 1000 + i })]; // ten price ticks
      rerender();
    }
    expect(syncs()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(syncs()).toBe(2); // one sync for all ten
    const last = JSON.parse(apiFetch.mock.calls.filter(([u]) => u === "/api/daemon/sync-positions").at(-1)![1].body);
    expect(last.positions[0].currentPrice).toBe(1010); // with the latest prices
    positions = []; // closed
    rerender();
    expect(syncs()).toBe(3);
  });
});
