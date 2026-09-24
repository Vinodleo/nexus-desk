import { fetchWithTimeout } from "./http";
import { eventWindowAt, parseCalendar, type EventWindow, type MarketEvent } from "../src/shared/eventCalendar";

// This week's high-impact economic events, from ForexFactory's public
// calendar export. Read every few hours (it changes rarely, and they ask
// callers to cache); if it can't be read, the last copy is kept, and with
// none there's simply no news pause.

const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;

let cache: { events: MarketEvent[]; at: number; ok: boolean } | null = null;
let inFlight: Promise<MarketEvent[]> | null = null;

export async function getEvents(now: number = Date.now()): Promise<MarketEvent[]> {
  if (cache && now - cache.at < (cache.ok ? REFRESH_MS : RETRY_MS)) return cache.events;
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const res = await fetchWithTimeout(CALENDAR_URL);
        if (!res.ok) throw new Error(`calendar returned ${res.status}`);
        const events = parseCalendar(await res.json());
        cache = { events, at: Date.now(), ok: true };
      } catch (err: any) {
        console.warn(`[Events] ${err?.message || err}; ${cache?.events.length ? "keeping the last calendar" : "no news pause until it loads"}`);
        cache = { events: cache?.events ?? [], at: Date.now(), ok: false };
      }
      return cache!.events;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export async function currentEventWindow(now: number = Date.now()): Promise<EventWindow> {
  return eventWindowAt(await getEvents(now), now);
}

/** Test hook. */
export function _resetEvents(): void {
  cache = null;
  inFlight = null;
}
