// @vitest-environment jsdom
import React, { useRef } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAY_SETTLE_MS, awayTier, formatAway, summarizeAway } from "../../src/services/awaySummary";
import { useAwayNotice } from "../../src/hooks/useAwayNotice";
import { AwayNotice, PILL_MS } from "../../src/components/ledger/AwayNotice";

// On unlocking the phone: the header badge glows after a short lock, a
// "Back online" pill after a longer one, and a "While you were away" card
// when trades opened or closed meanwhile.

const T0 = Date.parse("2026-09-25T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const closed = (id: string, at: number, pnl: number) => ({
  id: `t-${id}`, positionId: id, symbol: "SOL/INR", realizedPnl: pnl, exitReason: "TRAILING_STOP" as const,
  openedAt: iso(at - 60_000), closedAt: iso(at), openedByServer: true,
});
const open = (id: string, at: number, byServer = true) => ({ id, symbol: "ZEC/INR", openTime: iso(at), openedByServer: byServer });

describe("summing up the time away", () => {
  it("counts only what opened or closed while locked", () => {
    const s = summarizeAway(T0, T0 + 300_000, [open("o1", T0 + 10_000), open("o0", T0 - 1)], [
      closed("c1", T0 + 60_000, 42.1),
      closed("c2", T0 + 120_000, -12.05),
      closed("c0", T0 - 5_000, 999),
    ]);
    expect(s.awayMs).toBe(300_000);
    expect(s.opened).toEqual([{ id: "o1", symbol: "ZEC/INR", byServer: true }]);
    expect(s.closed.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(s.netPnl).toBe(30.05);
  });

  it("is quiet for a short lock, a pill for a long one, a card when anything traded", () => {
    expect(awayTier(summarizeAway(T0, T0 + 10_000, [], []))).toBe("glow");
    expect(awayTier(summarizeAway(T0, T0 + 324_000, [], []))).toBe("pill");
    expect(awayTier(summarizeAway(T0, T0 + 10_000, [open("o1", T0 + 1)], []))).toBe("card");
  });

  it("reads the time away plainly", () => {
    expect(formatAway(42_000)).toBe("42 s");
    expect(formatAway(324_000)).toBe("5 min 24 s");
    expect(formatAway(4_320_000)).toBe("1 h 12 min");
  });
});

describe("on unlocking", () => {
  beforeEach(() => vi.useFakeTimers({ now: T0 }));
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function setup(positions: any[] = [], trades: any[] = []) {
    return renderHook(() => {
      const p = useRef<any[]>(positions);
      const t = useRef<any[]>(trades);
      return { ...useAwayNotice(p, t), p, t };
    });
  }

  it("shows syncing at once, then a pill once the catch-up has landed", () => {
    const { result } = setup();
    act(() => result.current.onUnlock(324_000));
    expect(result.current.notice).toMatchObject({ phase: "syncing", awayMs: 324_000 });
    act(() => vi.advanceTimersByTime(AWAY_SETTLE_MS));
    expect(result.current.notice).toMatchObject({ phase: "pill" });
  });

  it("only glows the badge after a short lock", () => {
    const { result } = setup();
    act(() => result.current.onUnlock(8_000));
    expect(result.current.notice).toBeNull();
    act(() => vi.advanceTimersByTime(AWAY_SETTLE_MS));
    expect(result.current.notice).toBeNull();
    expect(result.current.glowKey).toBe(1);
  });

  it("opens the card for a trade the server closed while locked, even one that arrives after unlocking", () => {
    const { result } = setup();
    act(() => result.current.onUnlock(324_000));
    // The server's close lands over the socket a moment after unlocking.
    result.current.t.current = [closed("c1", T0 - 100_000, -178.28)];
    act(() => vi.advanceTimersByTime(AWAY_SETTLE_MS));
    expect(result.current.notice).toMatchObject({ phase: "card", summary: { netPnl: -178.28 } });
  });
});

describe("the notice", () => {
  beforeEach(() => vi.useFakeTimers({ now: T0 }));
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("the pill says it's back online and goes away by itself", () => {
    const onDismiss = vi.fn();
    render(React.createElement(AwayNotice, { notice: { id: 1, phase: "pill", summary: summarizeAway(T0, T0 + 60_000, [], []) }, onDismiss }));
    expect(screen.getByRole("status").textContent).toMatch(/Back online.*prices updated/);
    act(() => vi.advanceTimersByTime(PILL_MS));
    expect(onDismiss).not.toHaveBeenCalled();
    // Slides up, then goes.
    act(() => vi.advanceTimersByTime(300));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("the card lists what happened and the net result", () => {
    const onDismiss = vi.fn();
    const onOpenBook = vi.fn();
    const summary = summarizeAway(T0, T0 + 324_000, [open("o1", T0 + 1)], [closed("c1", T0 + 2, 42.1)]);
    render(React.createElement(AwayNotice, { notice: { id: 1, phase: "card", summary }, onDismiss, onOpenBook }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/Away 5 min 24 s/);
    expect(dialog.textContent).toMatch(/While you were away/);
    expect(dialog.textContent).toMatch(/Closed · Trailing stop/);
    expect(dialog.textContent).toMatch(/Bought by the server/);
    expect(dialog.textContent).toMatch(/from 1 closed trade(?!s)/);
    // The net result counts up to its value.
    act(() => vi.advanceTimersByTime(1000));
    expect(dialog.textContent).toMatch(/while you were away\+₹42\.10from/i);
    fireEvent.click(screen.getByText("See the Book"));
    expect(onOpenBook).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });
});
