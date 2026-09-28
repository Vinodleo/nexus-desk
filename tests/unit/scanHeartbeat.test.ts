// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { beatSlots, mergeBeats, recentBeats } from "../../src/shared/scanHeartbeat";
import { ScanHeartbeat, heartbeatView } from "../../src/components/ledger/ScanHeartbeat";

// The autopilot's heartbeat: a countdown to the server's next scan (just
// after each 5-minute candle closes) and the last hour of scans.

afterEach(cleanup);

const MIN = 60_000;
/** A candle close; the server's scan for it is due 8 seconds later. */
const T = Date.UTC(2026, 8, 28, 9, 0, 0);
const DUE = 8000;
const beat = (at: number, proposed = 0, checked = 48) => ({ at, checked, proposed });
/** Scans in the eleven slots before T, two of them finding a trade. */
const hour = Array.from({ length: 11 }, (_, i) => beat(T - (11 - i) * 5 * MIN + DUE, i === 3 || i === 7 ? 1 : 0));

describe("the heartbeat's hour", () => {
  it("is twelve 5-minute slots, oldest first: missed ones empty, a retry merged into its slot", () => {
    const beats = [beat(T - 55 * MIN + DUE), beat(T - 10 * MIN + DUE, 1), beat(T - 10 * MIN + 28_000, 1, 3), beat(T + DUE)];
    const slots = beatSlots(beats, T + 2 * MIN);
    expect(slots).toHaveLength(12);
    expect(slots[0].start).toBe(T - 55 * MIN);
    expect(slots[11].start).toBe(T);
    expect(slots[0].beat).toMatchObject({ checked: 48, proposed: 0 });
    // The main scan and the retry for late candles: the most checked, and every trade proposed.
    expect(slots[9].beat).toEqual({ at: T - 10 * MIN + 28_000, checked: 48, proposed: 2 });
    expect(slots.filter((s) => s.beat === null)).toHaveLength(9);
  });

  it("keeps the last hour, and counts a scan heard twice once", () => {
    const held = [beat(T - 70 * MIN), beat(T - 5 * MIN)];
    expect(mergeBeats(held, [beat(T - 5 * MIN, 1), beat(T)], T + MIN)).toEqual([beat(T - 5 * MIN, 1), beat(T)]);
    const reports = [
      { at: T - 61 * MIN, outcomes: [1], newProposals: [] },
      { at: T, outcomes: [1, 2, 3], newProposals: [1] },
    ];
    expect(recentBeats(reports, T + MIN)).toEqual([{ at: T, checked: 3, proposed: 1 }]);
  });
});

describe("the countdown", () => {
  it("runs to just after the next candle closes, without calling the coming scan missed", () => {
    const v = heartbeatView(hour, T - 5 * MIN + DUE, T + 3000);
    expect(v.next).toBe(T + DUE);
    expect(v.scanning).toBe(false);
    // The slot whose scan is still to come isn't shown yet: the hour ends at the last one.
    expect(v.slots[11].start).toBe(T - 5 * MIN);
  });

  it("says the scan is running once it's due and not in yet, then shows it", () => {
    expect(heartbeatView(hour, T - 5 * MIN + DUE, T + 20_000).scanning).toBe(true);
    const done = heartbeatView([...hour, beat(T + DUE, 1)], T + DUE, T + 20_000);
    expect(done.scanning).toBe(false);
    expect(done.next).toBe(T + 5 * MIN + DUE);
    expect(done.slots[11]).toMatchObject({ start: T, beat: { proposed: 1 } });
  });

  it("shows a scan that never came as missed", () => {
    const v = heartbeatView(hour, T - 5 * MIN + DUE, T + 2 * MIN);
    expect(v.scanning).toBe(false);
    expect(v.slots[11]).toEqual({ start: T, beat: null });
    expect(v.next).toBe(T + 5 * MIN + DUE);
  });
});

describe("the heartbeat on screen", () => {
  it("shows the countdown and the hour, pulses when a newer scan comes in, and grows its bar in", () => {
    const scans = [...hour, beat(T + DUE)];
    const { rerender } = render(createElement(ScanHeartbeat, { lastScanAt: T + DUE, scans, now: T + 68_000 }));
    expect(screen.getByText("Next scan in 4:00")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Last hour: 12 of 12 scans ran, 2 found trades");
    // Four of the five minutes left: the ring is four-fifths full.
    expect(Number(screen.getByTestId("scan-ring").getAttribute("stroke-dashoffset"))).toBeCloseTo(2 * Math.PI * 15 * 0.2, 1);
    // No pulse for the scan already there when shown, and no bar grows in.
    expect(screen.queryByTestId("scan-pulse")).toBeNull();
    expect(screen.getAllByTestId("scan-beat").some((b) => b.className.includes("nx-beat-in"))).toBe(false);

    const next = T + 5 * MIN + DUE;
    rerender(createElement(ScanHeartbeat, { lastScanAt: next, scans: [...scans, beat(next, 1)], now: next + 12_000 }));
    expect(screen.getByTestId("scan-pulse")).toBeTruthy();
    const beats = screen.getAllByTestId("scan-beat");
    expect(beats[11].className).toContain("nx-beat-in");
    expect(beats[11].className).toContain("bg-accent");
    expect(beats[10].className).not.toContain("nx-beat-in");
  });

  it("says when the scan is running", () => {
    render(createElement(ScanHeartbeat, { lastScanAt: T - 5 * MIN + DUE, scans: hour, now: T + 20_000 }));
    expect(screen.getByText("Scanning now…")).toBeTruthy();
    expect(screen.getByTestId("scan-ring").getAttribute("class")).toContain("nx-pulse-slow");
  });
});
