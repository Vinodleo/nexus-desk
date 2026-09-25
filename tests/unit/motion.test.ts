// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnimatedNumber, useFlash, usePresence } from "../../src/components/ledger/motion";
import { LedgerFloor, trackPoint, type LedgerFloorProps } from "../../src/components/ledger/LedgerFloor";
import { BottomNavBar } from "../../src/components/BottomNavBar";
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

  it("holds a closed position in its place with its result, tinted, then slides it away", () => {
    const { container, rerender } = render(createElement(LedgerFloor, floor({ positions: [pos("sol"), pos("zec", { unrealizedPnl: -3 }), pos("eth")] })));
    rerender(createElement(LedgerFloor, floor({ positions: [pos("sol"), pos("eth")] })));
    const symbols = () => [...container.querySelectorAll("li")].map((li) => li.textContent?.match(/^(\w+)\/INR/)?.[1]);
    expect(symbols()).toEqual(["SOL", "ZEC", "ETH"]);
    const zec = rowOf(container, "ZEC/INR")!;
    expect(zec.className).toContain("nx-item-close");
    expect(zec.className).toContain("nx-item-close-loss");
    expect(zec.textContent).toContain("Closed");
    act(() => vi.advanceTimersByTime(700));
    expect(symbols()).toEqual(["SOL", "ZEC", "ETH"]);
    act(() => vi.advanceTimersByTime(700));
    expect(symbols()).toEqual(["SOL", "ETH"]);
  });

  it("shows where the price is between stop and target, and pops \"Half banked\" when half is banked", () => {
    const { container, rerender } = render(createElement(LedgerFloor, floor({ positions: [pos("sol", { initialStopLoss: 98 })] })));
    const marker = () => container.querySelector('[data-testid="position-marker"]') as HTMLElement;
    // Stop 98, target 104: 101 is half-way.
    expect(marker().style.left).toBe("50%");
    rerender(createElement(LedgerFloor, floor({ positions: [pos("sol", { initialStopLoss: 98, currentPrice: 102.5 })] })));
    expect(marker().style.left).toBe("75%");
    expect(container.textContent).not.toContain("Half banked ✓");
    rerender(createElement(LedgerFloor, floor({ positions: [pos("sol", { initialStopLoss: 98, currentPrice: 102.5, bankedQuantity: 0.5 })] })));
    expect(container.textContent).toContain("Half banked ✓");
    act(() => vi.advanceTimersByTime(3400));
    expect(container.textContent).not.toContain("Half banked ✓");
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

describe("the tabs", () => {
  it("slide in from the side they sit on in the bar, and not on first show", async () => {
    const { useTabSlide } = await import("../../src/components/BottomNavBar");
    const { result, rerender } = renderHook(({ tab }) => useTabSlide(tab), { initialProps: { tab: "floor" as any } });
    expect(result.current).toBeUndefined();
    rerender({ tab: "book" });
    expect(result.current).toBe("nx-tab-from-right");
    // Other re-renders keep it, so the slide isn't restarted.
    rerender({ tab: "book" });
    expect(result.current).toBe("nx-tab-from-right");
    rerender({ tab: "queue" });
    expect(result.current).toBe("nx-tab-from-left");
  });

  it("the bar's indicator moves to the picked tab, and its icon bounces", async () => {
    const { BottomNavBar } = await import("../../src/components/BottomNavBar");
    const bar = (activeTab: any) => createElement(BottomNavBar, { activeTab, onTabChange: () => {}, pendingQueueCount: 2 });
    const { rerender, getByTestId, getByRole } = render(bar("floor"));
    expect(getByTestId("tab-indicator").style.transform).toBe("translateX(0%)");
    rerender(bar("book"));
    expect(getByTestId("tab-indicator").style.transform).toBe("translateX(200%)");
    expect(getByRole("button", { name: "Book" }).querySelector(".nx-tab-bounce")).not.toBeNull();
    expect(getByRole("button", { name: "Floor" }).querySelector(".nx-tab-bounce")).toBeNull();
    expect(getByRole("button", { name: "Queue, 2 waiting" }).querySelector(".nx-badge-pop")?.textContent).toBe("2");
  });
});

describe("the trade line", () => {
  it("runs from the original stop (0) to the target (1), either way round", () => {
    const long = { direction: "LONG" as const, stopLoss: 99, initialStopLoss: 98, takeProfit: 104 };
    expect(trackPoint(long, 98)).toBe(0);
    expect(trackPoint(long, 101)).toBeCloseTo(0.5);
    expect(trackPoint(long, 110)).toBe(1);
    const short = { direction: "SHORT" as const, stopLoss: 102, takeProfit: 96 };
    expect(trackPoint(short, 99)).toBeCloseTo(0.5);
    expect(trackPoint({ direction: "LONG" as const, stopLoss: 100, takeProfit: 100 }, 100)).toBeNull();
  });
});

describe("the tab bar", () => {
  it("bumps the Book tab each time a trade closes, not when the app opens", () => {
    const bar = (bookBumpKey: number) => createElement(BottomNavBar, { activeTab: "floor", onTabChange: vi.fn(), pendingQueueCount: 0, bookBumpKey });
    const { rerender } = render(bar(0));
    expect(screen.getByTestId("tab-icon-book").className).not.toContain("nx-tab-bounce");
    rerender(bar(1));
    const first = screen.getByTestId("tab-icon-book");
    expect(first.className).toContain("nx-tab-bounce");
    rerender(bar(2));
    // A new element, so the bump plays again.
    expect(screen.getByTestId("tab-icon-book")).not.toBe(first);
  });
});

describe("a theme change", () => {
  it("grows the new look as a circle from the tapped theme with the browser's page transition, where it has one", async () => {
    const { useTheme } = await import("../../src/hooks/useTheme");
    const start = vi.fn((cb: () => void) => {
      cb();
      return { ready: Promise.resolve() };
    });
    (document as any).startViewTransition = start;
    document.documentElement.dataset.theme = "ivory";
    const { result } = renderHook(() => useTheme());
    const animate = vi.fn();
    (document.documentElement as any).animate = animate;
    await act(async () => result.current.setTheme("graphite", { x: 120, y: 300 }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(
      { clipPath: [expect.stringContaining("circle(0px at 120px 300px)"), expect.stringMatching(/^circle\(\d+(\.\d+)?px at 120px 300px\)$/)] },
      expect.objectContaining({ pseudoElement: "::view-transition-new(root)" })
    );
    expect(document.documentElement.dataset.theme).toBe("graphite");
    expect(result.current.theme).toBe("graphite");
    // No colour fading (light into dark looked muddy half-way).
    expect(document.documentElement.classList.contains("nx-theme-fade")).toBe(false);
    delete (document as any).startViewTransition;
    // Without it, the theme just switches.
    act(() => result.current.setTheme("blush"));
    expect(document.documentElement.dataset.theme).toBe("blush");
  });
});

describe("the Floor's top", () => {
  it("shows which markets are open, with the next opening time for a closed one, and pulses a market that opens", async () => {
    const { MarketChips } = await import("../../src/components/ledger/LedgerFloor");
    // Thursday 21:30 IST: India closed, US open.
    const evening = Date.parse("2026-09-24T16:00:00Z");
    const { rerender } = render(createElement(MarketChips, { now: evening }));
    expect(screen.getByTestId("market-coins").textContent).toBe("Coins · 24/7");
    expect(screen.getByTestId("market-us").getAttribute("data-open")).toBe("true");
    expect(screen.getByTestId("market-india").getAttribute("data-open")).toBe("false");
    expect(screen.getByTestId("market-india").textContent).toMatch(/^India · Fri /);
    expect(screen.getByTestId("market-india").querySelector(".nx-ring-once")).toBeNull();
    // Friday 9:15 IST: India opens while on screen.
    rerender(createElement(MarketChips, { now: Date.parse("2026-09-25T03:46:00Z") }));
    expect(screen.getByTestId("market-india").textContent).toBe("India · open");
    expect(screen.getByTestId("market-india").querySelector(".nx-ring-once")).not.toBeNull();
  });

  it("draws today's P&L through the day, ending where it stands now", async () => {
    const { TodayLine } = await import("../../src/components/ledger/LedgerFloor");
    const now = new Date(2026, 8, 25, 20, 0).getTime();
    const at = (h: number) => new Date(2026, 8, 25, h, 0).getTime();
    const { container } = render(createElement(TodayLine, { closes: [{ at: at(10), pnl: 120 }, { at: at(19), pnl: -800 }], openPnl: -20, now }));
    const path = container.querySelector("path")!;
    expect(path.closest(".nx-reveal")).not.toBeNull();
    expect(path.getAttribute("d")!.split("L")).toHaveLength(4);
    // The "now" dot sits in the chart's own box (not beside the labels below it).
    const dot = screen.getByTestId("today-dot");
    expect(dot.parentElement!.className).toContain("h-14");
    expect(dot.parentElement!.contains(screen.getByText("Now"))).toBe(false);
    expect(container.querySelector('[data-testid="today-line"]')!.className).toContain("text-loss");
    // Nothing closed and nothing open: no line.
    const empty = render(createElement(TodayLine, { closes: [], openPnl: 0, now }));
    expect(empty.container.querySelector("svg")).toBeNull();
  });

  it("drains the loss-limit meter, amber when little is left", () => {
    const { container, rerender } = render(createElement(LedgerFloor, floor({ dailyLossLeft: 2000, dailyLossLimit: 2500 })));
    const bar = () => container.querySelector('[data-testid="loss-meter"] > div') as HTMLElement;
    expect(bar().style.width).toBe("80%");
    expect(bar().className).toContain("bg-accent");
    rerender(createElement(LedgerFloor, floor({ dailyLossLeft: 500, dailyLossLimit: 2500 })));
    expect(bar().style.width).toBe("20%");
    expect(bar().className).toContain("bg-warn");
  });
});
