import { IST_OFFSET_MS, NSE_CLOSE, NSE_OPEN, isNseOpen, istParts } from "./nse";
import { US_CLOSE, US_OPEN, isUsOpen, nyParts } from "./usMarket";

// The desk's day in India time (the Lab's "The desk's day" dial): when each
// market is open and when the server's scheduled checks run, with the next
// time each comes round. The check times live here so the server and the
// dial use the same ones.

/** 3:45 pm New York: the US checks (US breakout, then funds breakout; US momentum too on the week's last session). */
export const US_CHECK_AT = 15 * 60 + 45;
/** The daily coin check runs this long after the 00:00 UTC daily close. */
export const DAILY_SCAN_AFTER_MS = 10 * 60 * 1000;
/** The weekly summary goes out on Sunday at 10 am India time. */
export const SUMMARY_MINUTE_IST = 10 * 60;

const MIN = 60_000;
const DAY = 1440 * MIN;
const IST_MIN = IST_OFFSET_MS / MIN;
const wrap = (m: number) => ((m % 1440) + 1440) % 1440;

/** New York's offset from UTC at a moment, in minutes: −240 in summer time, −300 in winter. */
export function nyOffsetMinutes(ms: number): number {
  const d = nyParts(ms).minutes - wrap(Math.floor(ms / MIN));
  return d > 720 ? d - 1440 : d <= -720 ? d + 1440 : d;
}

/** The next time after `now` that New York's clock reads `minute` on a weekday (holidays aren't known here). */
export function nextNyWeekdayAt(now: number, minute: number): number {
  for (let d = 0; d <= 8; d++) {
    const probe = now + d * DAY;
    let at = Date.parse(`${nyParts(probe).day}T00:00:00Z`) + (minute - nyOffsetMinutes(probe)) * MIN;
    // A change of the clocks between midnight and `minute` moves it by an hour.
    const off = nyParts(at).minutes - minute;
    if (Math.abs(off) <= 60) at -= off * MIN;
    const { weekday } = nyParts(at);
    if (at > now && weekday >= 1 && weekday <= 5) return at;
  }
  return now + 7 * DAY;
}

/** The next time after `now` that India's clock reads `minute`, on a day `days` allows (0 Sunday to 6 Saturday). */
export function nextIstAt(now: number, minute: number, days: readonly number[] = [0, 1, 2, 3, 4, 5, 6]): number {
  const dayStart = Math.floor((now + IST_OFFSET_MS) / DAY) * DAY - IST_OFFSET_MS;
  for (let d = 0; d <= 8; d++) {
    const at = dayStart + d * DAY + minute * MIN;
    if (at > now && days.includes(new Date(at + IST_OFFSET_MS).getUTCDay())) return at;
  }
  return now + 7 * DAY;
}

export type DeskEventId = "coin-check" | "us-checks" | "us" | "nse" | "summary";

export interface DeskEvent {
  id: DeskEventId;
  /** Where it sits on the dial, in India-time minutes after midnight: a check's time, or a session's start and end. */
  at: number;
  until?: number;
  /** A session: open now. */
  open?: boolean;
  /** When it next comes round (a session: when it next opens). */
  nextAt: number;
}

/** The desk's day at `now`: India's time and weekday, and each market session and scheduled check on the dial. */
export function deskDay(now: number): { minutes: number; weekday: number; events: DeskEvent[] } {
  const ist = istParts(now);
  const ny = nyOffsetMinutes(now);
  const nyToIst = (m: number) => wrap(m - ny + IST_MIN);
  const weekdays = [1, 2, 3, 4, 5];
  const coinCheck = Math.floor(now / DAY) * DAY + DAILY_SCAN_AFTER_MS;
  return {
    minutes: ist.minutes,
    weekday: ist.weekday,
    events: [
      { id: "coin-check", at: wrap(DAILY_SCAN_AFTER_MS / MIN + IST_MIN), nextAt: coinCheck > now ? coinCheck : coinCheck + DAY },
      { id: "us-checks", at: nyToIst(US_CHECK_AT), nextAt: nextNyWeekdayAt(now, US_CHECK_AT) },
      { id: "us", at: nyToIst(US_OPEN), until: nyToIst(US_CLOSE), open: isUsOpen(now), nextAt: nextNyWeekdayAt(now, US_OPEN) },
      { id: "nse", at: NSE_OPEN, until: NSE_CLOSE, open: isNseOpen(now), nextAt: nextIstAt(now, NSE_OPEN, weekdays) },
      { id: "summary", at: SUMMARY_MINUTE_IST, nextAt: nextIstAt(now, SUMMARY_MINUTE_IST, [0]) },
    ],
  };
}
