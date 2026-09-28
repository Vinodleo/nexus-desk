import React, { useEffect, useRef, useState } from "react";
import { BEAT_SLOT_MS, beatSlots, type ScanBeat } from "../../shared/scanHeartbeat";
import { nextCandleFetchAt } from "../../services/liveMarketStreamService";

// The autopilot's heartbeat on the Floor: a ring that counts down to the
// server's next scan (just after each 5-minute candle closes) and pulses when
// a scan comes in, and the last hour of scans as bars, tall where a scan
// found a trade and flat where none ran. It re-renders itself each second,
// not the Floor.

/** A scan not in this long after it was due is shown as missed rather than running. */
export const SCANNING_GRACE_MS = 90_000;

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

/**
 * What the heartbeat shows at `now`: when the next scan is due, whether this
 * candle's scan is running (due, and not in yet), and the hour's slots. A
 * slot whose scan is still to come or running isn't shown as missed: the
 * hour ends at the slot before until the scan is in.
 */
export function heartbeatView(beats: ScanBeat[], lastScanAt: number, now: number) {
  const slotStart = Math.floor(now / BEAT_SLOT_MS) * BEAT_SLOT_MS;
  const due = nextCandleFetchAt(now - BEAT_SLOT_MS); // this candle's scan: just after the slot starts
  const inThisSlot = lastScanAt >= slotStart || beats.some((b) => b.at >= slotStart);
  const scanning = !inThisSlot && now >= due && now - due < SCANNING_GRACE_MS;
  const next = now < due ? due : due + BEAT_SLOT_MS;
  const settled = inThisSlot || now - due >= SCANNING_GRACE_MS;
  return { next, scanning, slots: beatSlots(beats, settled ? now : now - BEAT_SLOT_MS) };
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const ScanHeartbeat: React.FC<{ lastScanAt: number; scans: ScanBeat[]; now?: number }> = ({ lastScanAt, scans, now: fixedNow }) => {
  const [tick, setTick] = useState(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return setTick(fixedNow);
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [fixedNow]);
  const now = fixedNow ?? tick;

  // A pulse each time a newer scan comes in (not for the first one heard of).
  const seen = useRef(lastScanAt);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (seen.current > 0 && lastScanAt > seen.current) setPulse((k) => k + 1);
    seen.current = Math.max(seen.current, lastScanAt);
  }, [lastScanAt]);

  const { next, scanning, slots } = heartbeatView(scans, lastScanAt, now);
  // Bars there when the scans are first known stay put; each new one grows in.
  const firstShown = useRef<Set<number> | null>(null);
  if (firstShown.current === null && scans.length > 0) firstShown.current = new Set(slots.filter((s) => s.beat).map((s) => s.start));
  const ran = slots.filter((s) => s.beat).length;
  const found = slots.filter((s) => (s.beat?.proposed ?? 0) > 0).length;
  const left = Math.min(1, Math.max(0, (next - now) / BEAT_SLOT_MS));

  return (
    <div className="flex items-center gap-3" data-testid="scan-heartbeat">
      <div className="relative w-9 h-9 shrink-0" aria-hidden="true">
        <svg viewBox="0 0 36 36" className="block w-full h-full -rotate-90">
          <circle cx="18" cy="18" r={RING_R} fill="none" strokeWidth="3.5" className="stroke-line" />
          <circle
            data-testid="scan-ring"
            cx="18"
            cy="18"
            r={RING_R}
            fill="none"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={RING_C.toFixed(2)}
            strokeDashoffset={(RING_C * (1 - left)).toFixed(2)}
            className={`stroke-accent nx-countdown-ring${scanning ? " nx-pulse-slow" : ""}`}
          />
        </svg>
        {pulse > 0 && <span key={pulse} data-testid="scan-pulse" className="absolute inset-0 rounded-full border-2 border-accent nx-beat-pulse" />}
      </div>
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <div className="text-xs font-semibold tabular-nums">{scanning ? "Scanning now…" : `Next scan in ${mmss(next - now)}`}</div>
        <div
          role="img"
          aria-label={`Last hour: ${ran} of ${slots.length} scans ran, ${found} found ${found === 1 ? "a trade" : "trades"}`}
          className="flex items-end gap-[3px] h-5"
        >
          {slots.map(({ start, beat }) => {
            const size = !beat ? "h-1 bg-line" : beat.proposed === 0 ? "h-2 bg-muted/40" : beat.proposed === 1 ? "h-4 bg-accent" : "h-5 bg-accent";
            const fresh = beat && firstShown.current !== null && !firstShown.current.has(start);
            return (
              <span
                key={start}
                data-testid="scan-beat"
                title={beat ? `${clock(beat.at)} · ${beat.checked} checked · ${beat.proposed} proposed` : `${clock(start)} · no scan`}
                className={`flex-1 max-w-3 rounded-sm ${size}${fresh ? " nx-beat-in" : ""}`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};
