// The server's scans over the last hour, for the Floor's heartbeat: when
// each ran, how many symbols it checked and how many trades it proposed.
// The server sends them with its scanner status; the app adds each scan it
// hears about live, and shows the hour as twelve 5-minute slots.

export interface ScanBeat {
  at: number;
  checked: number;
  proposed: number;
}

/** How far back the heartbeat looks. */
export const BEAT_WINDOW_MS = 60 * 60 * 1000;
/** A scan runs after each candle of this length closes. */
export const BEAT_SLOT_MS = 5 * 60 * 1000;
/** Slots shown: the last hour. */
export const BEAT_SLOTS = BEAT_WINDOW_MS / BEAT_SLOT_MS;

/** One scan report as a beat. */
export function beatOf(report: { at: number; outcomes: unknown[]; newProposals: unknown[] }): ScanBeat {
  return { at: report.at, checked: report.outcomes.length, proposed: report.newProposals.length };
}

/** The beats from the last hour, oldest first. */
export function recentBeats(reports: { at: number; outcomes: unknown[]; newProposals: unknown[] }[], now: number): ScanBeat[] {
  return reports.filter((r) => r.at > now - BEAT_WINDOW_MS && r.at <= now).map(beatOf).sort((a, b) => a.at - b.at);
}

/** `held` with `added` (a beat at the same time replaces the held one), from the last hour, oldest first. */
export function mergeBeats(held: ScanBeat[], added: ScanBeat[], now: number): ScanBeat[] {
  const byAt = new Map<number, ScanBeat>();
  for (const b of [...held, ...added]) byAt.set(b.at, b);
  return [...byAt.values()].filter((b) => b.at > now - BEAT_WINDOW_MS).sort((a, b) => a.at - b.at);
}

/**
 * The last hour as 5-minute slots, oldest first, the current slot last. Each
 * slot holds its scans merged into one (a retry for late candles, or a "scan
 * now", lands in the same slot: the most checked, and all proposed), or null
 * where no scan ran.
 */
export function beatSlots(beats: ScanBeat[], now: number, count: number = BEAT_SLOTS): { start: number; beat: ScanBeat | null }[] {
  const current = Math.floor(now / BEAT_SLOT_MS) * BEAT_SLOT_MS;
  const slots: { start: number; beat: ScanBeat | null }[] = [];
  for (let k = count - 1; k >= 0; k--) {
    const start = current - k * BEAT_SLOT_MS;
    const inSlot = beats.filter((b) => b.at >= start && b.at < start + BEAT_SLOT_MS);
    slots.push({
      start,
      beat:
        inSlot.length === 0
          ? null
          : {
              at: Math.max(...inSlot.map((b) => b.at)),
              checked: Math.max(...inSlot.map((b) => b.checked)),
              proposed: inSlot.reduce((a, b) => a + b.proposed, 0),
            },
    });
  }
  return slots;
}
