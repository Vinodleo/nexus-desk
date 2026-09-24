// Scheduled market-moving events (US inflation, Fed decisions, jobs data)
// and the news pause around them: no new trades from shortly before until a
// little after, when prices jump and spreads widen. Shared by the server
// (which reads the calendar) and the app.

export interface MarketEvent {
  title: string;
  /** Currency the event is about, e.g. "USD". */
  country: string;
  /** Scheduled time, ms. */
  at: number;
  impact: string;
}

export const PAUSE_BEFORE_MS = 15 * 60 * 1000;
export const PAUSE_AFTER_MS = 30 * 60 * 1000;
/** Crypto moves most on US events. */
export const WATCHED_COUNTRIES = ["USD"];

/** Parses ForexFactory's weekly calendar export into high-impact events for the watched currencies. */
export function parseCalendar(raw: unknown, countries: string[] = WATCHED_COUNTRIES): MarketEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: MarketEvent[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    const title = typeof e?.title === "string" ? e.title.trim() : "";
    const country = typeof e?.country === "string" ? e.country.toUpperCase() : "";
    const impact = typeof e?.impact === "string" ? e.impact : "";
    const at = typeof e?.date === "string" ? Date.parse(e.date) : NaN;
    if (!title || !Number.isFinite(at) || impact !== "High" || !countries.includes(country)) continue;
    out.push({ title, country, at, impact });
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface EventWindow {
  /** Inside a news pause now. */
  active: boolean;
  /** What the pause is for, e.g. "USD CPI m/m". */
  headline?: string;
  /** When the pause ends (ms). */
  until?: number;
  /** The next pause coming up, if any. */
  next?: { headline: string; startsAt: number };
}

export function eventWindowAt(events: MarketEvent[], now: number = Date.now()): EventWindow {
  const label = (e: MarketEvent) => `${e.country} ${e.title}`;
  const current = events.filter((e) => now >= e.at - PAUSE_BEFORE_MS && now <= e.at + PAUSE_AFTER_MS);
  const upcoming = events.find((e) => e.at - PAUSE_BEFORE_MS > now);
  const next = upcoming ? { headline: label(upcoming), startsAt: upcoming.at - PAUSE_BEFORE_MS } : undefined;
  if (current.length === 0) return { active: false, ...(next ? { next } : {}) };
  return {
    active: true,
    headline: current.map(label).join(", "),
    until: Math.max(...current.map((e) => e.at + PAUSE_AFTER_MS)),
    ...(next ? { next } : {}),
  };
}
