import { useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";
import { eventWindowAt, type EventWindow, type MarketEvent } from "../shared/eventCalendar";

const RELOAD_MS = 30 * 60_000;
const TICK_MS = 30_000;

/**
 * Whether a scheduled-news pause is on now, and the next one: the server's
 * calendar, rechecked against the clock every 30 seconds.
 */
export function useEventWindow(): EventWindow {
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch("/api/events");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && Array.isArray(body?.events)) setEvents(body.events as MarketEvent[]);
      } catch {}
    };
    void load();
    const reload = setInterval(load, RELOAD_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(reload);
      clearInterval(tick);
    };
  }, []);

  return eventWindowAt(events, now);
}
