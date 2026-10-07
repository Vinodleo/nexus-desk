// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAILY_SCAN_AFTER_MS, SUMMARY_MINUTE_IST, US_CHECK_AT, deskDay, nextIstAt, nextNyWeekdayAt, nyOffsetMinutes } from "../../src/shared/deskDay";
import { US_CHECK_AT as SERVER_US_CHECK_AT } from "../../server/scanner/usBreakout";
import { DAILY_SCAN_AFTER_MS as SERVER_DAILY_AFTER } from "../../server/scanner/dailyCoins";
import { DeskDayCard, untilText } from "../../src/components/ledger/DeskDayCard";

// The desk's day in India time: each market's session and the server's
// scheduled checks, and when each next comes round.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const at = (iso: string) => Date.parse(iso);
// Wednesday 7 October 2026, 19:06 in India (13:36 UTC, 9:36 am in New York).
const WED = at("2026-10-07T13:36:00Z");

describe("the desk's day", () => {
  it("shares the server's check times", () => {
    expect(SERVER_US_CHECK_AT).toBe(US_CHECK_AT);
    expect(SERVER_DAILY_AFTER).toBe(DAILY_SCAN_AFTER_MS);
    expect(SUMMARY_MINUTE_IST).toBe(600);
  });

  it("knows New York's offset in summer time and winter", () => {
    expect(nyOffsetMinutes(WED)).toBe(-240);
    expect(nyOffsetMinutes(at("2026-11-10T12:00:00Z"))).toBe(-300);
  });

  it("places each session and check in India time, with when it next comes round", () => {
    const d = deskDay(WED);
    expect(d.minutes).toBe(19 * 60 + 6);
    expect(d.weekday).toBe(3);
    const ev = Object.fromEntries(d.events.map((e) => [e.id, e]));
    // The coin check: 00:10 UTC is 05:40 in India, next on Thursday.
    expect(ev["coin-check"]).toMatchObject({ at: 5 * 60 + 40, nextAt: at("2026-10-08T00:10:00Z") });
    // The US checks: 3:45 pm New York is 01:15 in India in summer time; today's is still to come.
    expect(ev["us-checks"]).toMatchObject({ at: 75, nextAt: at("2026-10-07T19:45:00Z") });
    // The US session, 19:00 to 01:30 in India, is open; it next opens on Thursday.
    expect(ev.us).toMatchObject({ at: 19 * 60, until: 90, open: true, nextAt: at("2026-10-08T13:30:00Z") });
    // NSE, 09:15 to 15:30, is shut for the day.
    expect(ev.nse).toMatchObject({ at: 555, until: 930, open: false, nextAt: at("2026-10-08T03:45:00Z") });
    // The weekly summary: Sunday 10:00 in India.
    expect(ev.summary).toMatchObject({ at: 600, nextAt: at("2026-10-11T04:30:00Z") });
  });

  it("moves the US times an hour later in India once New York leaves summer time", () => {
    const ev = Object.fromEntries(deskDay(at("2026-11-10T12:00:00Z")).events.map((e) => [e.id, e]));
    expect(ev.us).toMatchObject({ at: 20 * 60, until: 150 });
    expect(ev["us-checks"].at).toBe(135);
  });

  it("skips weekends, and finds the right hour across New York's change of clocks", () => {
    // Friday 30 October after the check: the next is Monday 2 November, 3:45 pm EST (20:45 UTC).
    expect(nextNyWeekdayAt(at("2026-10-30T20:00:00Z"), US_CHECK_AT)).toBe(at("2026-11-02T20:45:00Z"));
    // Saturday: NSE next opens on Monday.
    expect(nextIstAt(at("2026-10-10T06:00:00Z"), 555, [1, 2, 3, 4, 5])).toBe(at("2026-10-12T03:45:00Z"));
  });

  it("writes how long until each", () => {
    expect(untilText(23 * 60_000)).toBe("in 23 min");
    expect(untilText((6 * 60 + 9) * 60_000)).toBe("in 6 h 9 min");
    expect(untilText(3.6 * 24 * 60 * 60_000)).toBe("in 4 days");
  });
});

describe("the desk's day card", () => {
  it("lists each with its time and status, marks the next check, and says what the picked one does", () => {
    render(createElement(DeskDayCard, { now: WED }));
    expect(screen.getByTestId("dial-clock").textContent).toBe("19:06");
    expect(screen.getByTestId("day-coin-check").textContent).toBe("1 · Coin check05:40 every dayin 10 h 34 min");
    expect(screen.getByTestId("day-us-checks").textContent).toBe("2 · US checks01:15 on US weekdaysin 6 h 9 min");
    expect(screen.getByTestId("day-us").textContent).toBe("US market19:00 to 01:30, weekdaysopen now");
    expect(screen.getByTestId("day-nse").textContent).toBe("Indian stocks09:15 to 15:30, weekdaysopens in 14 h 9 min");
    expect(screen.getByTestId("day-summary").textContent).toBe("3 · Weekly summarySunday 10:00in 4 days");
    // The US checks come first: picked to start with, and their mark pulses.
    expect(screen.getByTestId("day-us-checks").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("dial-mark-us-checks").querySelector(".nx-ring")).not.toBeNull();
    expect(screen.getByTestId("dial-mark-coin-check").querySelector(".nx-ring")).toBeNull();
    expect(screen.getByTestId("day-about").textContent).toContain("US breakout, then funds breakout");
    // The US arc runs from 285° (19:00) round midnight to 22.5° (01:30).
    expect(screen.getByTestId("dial-us").style.background).toContain("0 22.5deg, transparent 0 285deg");

    fireEvent.click(screen.getByTestId("day-nse"));
    expect(screen.getByTestId("day-nse").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("day-about").textContent).toContain("entries 9:15 to 3:00");
    expect(screen.getByTestId("dial-nse").style.opacity).toBe("1");
    expect(screen.getByTestId("dial-us").style.opacity).toBe("0.35");
  });

  it("swings the hand round from midnight to the time", () => {
    vi.useFakeTimers();
    render(createElement(DeskDayCard, { now: WED }));
    expect(screen.getByTestId("dial-hand").style.transform).toBe("rotate(0deg)");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // 19:06 is 1,146 minutes into the day: 286.5°.
    expect(screen.getByTestId("dial-hand").style.transform).toBe("rotate(286.5deg)");
  });
});
