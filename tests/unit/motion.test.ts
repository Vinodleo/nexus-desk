// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnimatedNumber, useFlash, usePresence } from "../../src/components/ledger/motion";
import { LedgerFloor, type LedgerFloorProps } from "../../src/components/ledger/LedgerFloor";
import { Sheet } from "../../src/components/ledger/Sheet";
import type { Position } from "../../src/types";

// Motion on the Floor and sheets: figures glide to new values, prices flash
// when they move, positions slide in and fold away, sheets slide out.

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a gliding number", () => {
  it("starts where it is and glides to each new value", () => {
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v, 400), { initialProps: { v: 100 } });
    expect(result.current).toBe(100);
    rerender({ v: 200 });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBeGreaterThan(100);
    expect(result.current).toBeLessThan(200);
    act(() => vi.advanceTimersByTime(400));
    expect(result.current).toBe(200);
  });

  it("jumps straight there with reduced motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v), { initialProps: { v: 1 } });
    rerender({ v: 5 });
    expect(result.current).toBe(5);
    vi.unstubAllGlobals();
  });
});

describe("a flash", () => {
  it("says which way the value moved, and replays on each move", () => {
    const { result, rerender } = renderHook(({ v }) => useFlash(v), { initialProps: { v: 10 } });
    expect(result.current.dir).toBeNull();
    rerender({ v: 11 });
    expect(result.current).toEqual({ dir: "up", key: 1 });
    rerender({ v: 9 });
    expect(result.current).toEqual({ dir: "down", key: 2 });
    rerender({ v: 9 });
    expect(result.current.key).toBe(2);
  });
});

describe("presence", () => {
  it("stays mounted a moment after closing, to animate out", () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open, 200), { initialProps: { open: true } });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, leaving: true });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.mounted).toBe(false);
  });

  it("a sheet slides out before it goes", () => {
    const sheet = (isOpen: boolean) => createElement(Sheet, { isOpen, onClose: () => {}, title: "Brief", children: "hi" });
    const { rerender } = render(sheet(true));
    expect(screen.getByRole("dialog").className).toContain("nx-sheet-in");
    rerender(sheet(false));
    expect(screen.getByRole("dialog").className).toContain("nx-sheet-out");
    act(() => vi.advanceTimersByTime(250));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

const pos = (id: string, over: Partial<Position> = {}): Position => ({
  id, symbol: `${id.toUpperCase()}/INR`, direction: "LONG", setupName: "t", entryPrice: 100, currentPrice: 101,
  quantity: 1, stopLoss: 98, takeProfit: 104, unrealizedPnl: 1, unrealizedPnlPercent: 1,
  openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 30, metaConfidence: 0.6, ...over,
});

const floor = (over: Partial<LedgerFloorProps> = {}): LedgerFloorProps => ({
  isLive: false, equity: 1000, dailyPnl: 0, allTimePnl: 0,
  autopilotOn: true, onAutopilotChange: vi.fn(), exposureFraction: 0, dailyLossLeft: 2500,
  stopped: false, onToggleStop: vi.fn(), positions: [], onClosePosition: vi.fn(),
  guardianOnline: true, liveTradingEnabled: false, market: [], candleStatus: [],
  pendingProposals: 0, scan: { analyzed: 0, selected: 0, rejected: 0 }, onOpenQueue: vi.fn(), onOpenSettings: vi.fn(),
  ...over,
});

const rowOf = (container: HTMLElement, symbol: string) =>
  [...container.querySelectorAll("li")].find((li) => li.textContent?.includes(symbol)) as HTMLElement | undefined;

describe("the Floor", () => {
  it("slides a new position in, but not the ones already there on first show", () => {
    const { container, rerender } = render(createElement(LedgerFloor, floor({ positions: [pos("sol")] })));
    expect(rowOf(container, "SOL/INR")!.className).not.toContain("nx-item-enter");
    rerender(createElement(LedgerFloor, floor({ positions: [pos("sol"), pos("zec")] })));
    expect(rowOf(container, "ZEC/INR")!.className).toContain("nx-item-enter");
  });

  it("folds a closed position away in its place, then removes it", () => {
    const { container, rerender } = render(createElement(LedgerFloor, floor({ positions: [pos("sol"), pos("zec"), pos("eth")] })));
    rerender(createElement(LedgerFloor, floor({ positions: [pos("sol"), pos("eth")] })));
    const symbols = () => [...container.querySelectorAll("li")].map((li) => li.textContent?.match(/^(\w+)\/INR/)?.[1]);
    expect(symbols()).toEqual(["SOL", "ZEC", "ETH"]);
    expect(rowOf(container, "ZEC/INR")!.className).toContain("nx-item-leave");
    act(() => vi.advanceTimersByTime(400));
    expect(symbols()).toEqual(["SOL", "ETH"]);
  });

  it("flashes the price green when it ticks up and red when it ticks down", () => {
    const { container, rerender } = render(createElement(LedgerFloor, floor({ positions: [pos("sol")] })));
    const flash = () => rowOf(container, "SOL/INR")!.querySelector("[data-flash]")?.getAttribute("data-flash");
    expect(flash()).toBeUndefined();
    rerender(createElement(LedgerFloor, floor({ positions: [pos("sol", { currentPrice: 102 })] })));
    expect(flash()).toBe("up");
    rerender(createElement(LedgerFloor, floor({ positions: [pos("sol", { currentPrice: 100.5 })] })));
    expect(flash()).toBe("down");
    expect(rowOf(container, "SOL/INR")!.textContent).toContain("Now 100.50");
  });

  it("rolls equity to its new value", () => {
    const { container, rerender } = render(createElement(LedgerFloor, floor({ equity: 1000 })));
    rerender(createElement(LedgerFloor, floor({ equity: 1100 })));
    act(() => vi.advanceTimersByTime(100));
    const mid = container.textContent ?? "";
    expect(mid).not.toContain("₹1,100.00");
    act(() => vi.advanceTimersByTime(500));
    expect(container.textContent).toContain("₹1,100.00");
  });
});
