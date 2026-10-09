import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { apiFetch } from "../services/apiClient";
import { daemonEventToTrade, type DaemonCloseEvent } from "../services/daemonEvents";
import {
  anchorAt,
  cleanAnchor,
  deskMoney,
  istDay,
  restartAnchor,
  sameAnchor,
  tradeKey,
  type DeskMoney,
  type MoneyAnchor,
} from "../shared/deskMoney";
import type { HistoricalTrade } from "../types";

// The Book and the money read from the server's trade book
// (server/tradeBook.ts): the closes this phone doesn't hold (made on another
// device, or by the server while the app was away) are taken in, and the
// money is worked out from the closes (src/shared/deskMoney.ts) instead of a
// running total, so it can't drift from the trades or differ between devices.

const ANCHOR_KEY = "nexus_money_anchor_v1";
/** The guardian's catch-up poll's last answer (useGuardianSync): every server close up to it is in the Book. */
const LAST_POLL_KEY = "nexus_last_daemon_poll";
const LOOK_EVERY_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Each start looks at a month of closes, or all since the anchor if it's older. */
const FIRST_LOOK_MS = 30 * DAY_MS;
/** A phone's first anchor is set this long before its last catch-up: a close after it that arrives later still counts. */
const ANCHOR_LAG_MS = 10 * 60 * 1000;

/** The anchor this phone holds; `sent` once the server has it. A restart replaces the server's; a first one doesn't. */
export interface HeldAnchor {
  anchor: MoneyAnchor;
  sent: boolean;
  restart?: boolean;
}

function loadHeld(): HeldAnchor | null {
  try {
    const raw = JSON.parse(localStorage.getItem(ANCHOR_KEY) ?? "null");
    const anchor = cleanAnchor(raw?.anchor);
    return anchor ? { anchor, sent: raw.sent === true, ...(raw.restart === true ? { restart: true } : {}) } : null;
  } catch {
    return null;
  }
}

function saveHeld(held: HeldAnchor): void {
  try {
    localStorage.setItem(ANCHOR_KEY, JSON.stringify(held));
  } catch {}
}

/**
 * This phone's first anchor: where its money stood (its running total, last
 * saved) a while before its last catch-up with the guardian. Closes after
 * that it already counted are taken back out; they count on top again.
 */
export function firstAnchor(saved: Pick<DeskMoney, "equity" | "allTimeRealizedPnl">, trades: HistoricalTrade[], start: number, now = Date.now()): MoneyAnchor {
  let lastPoll = 0;
  try {
    lastPoll = Number(localStorage.getItem(LAST_POLL_KEY)) || 0;
  } catch {}
  const at = Math.min(lastPoll > 0 ? lastPoll : now, now) - ANCHOR_LAG_MS;
  return anchorAt({ ...saved, cash: saved.equity, dailyRealizedPnl: 0 }, trades, at, start);
}

/**
 * What to do with the server's anchor: send this phone's (a restart not sent
 * yet, or any when the server has none), take the server's (another
 * device's first one or restart), or nothing.
 */
export function anchorStep(held: HeldAnchor, server: MoneyAnchor | null): { send: true } | { adopt: MoneyAnchor } | null {
  if ((held.restart && !held.sent) || !server) return { send: true };
  return held.sent && sameAnchor(held.anchor, server) ? null : { adopt: server };
}

/** The server's closes this Book doesn't hold, taken in (newest first); the same array if none. */
export function withBookTrades(prev: HistoricalTrade[], incoming: unknown[]): HistoricalTrade[] {
  const held = new Set(prev.map(tradeKey));
  const added: HistoricalTrade[] = [];
  for (const raw of incoming) {
    const t = raw as DaemonCloseEvent & { isSelfApproved?: boolean };
    if (!t || typeof t.symbol !== "string" || !Number.isFinite(t.realizedPnl) || !Number.isFinite(Date.parse(t.closedAt))) continue;
    const key = t.positionId || t.id;
    if (!key || held.has(key)) continue;
    held.add(key);
    added.push({ ...daemonEventToTrade(t), ...(t.isSelfApproved !== undefined ? { isSelfApproved: t.isSelfApproved } : {}) });
  }
  if (added.length === 0) return prev;
  return [...added, ...prev].sort((a, b) => (b.closedAtMs ?? 0) - (a.closedAtMs ?? 0));
}

/** This phone's own close, in place of the server's copy if the trade book's came in first. */
export function withOwnClose(prev: HistoricalTrade[], trade: HistoricalTrade): HistoricalTrade[] {
  const key = tradeKey(trade);
  return [trade, ...prev.filter((t) => tradeKey(t) !== key)];
}

/**
 * The money from the closes, and the closes the server's book has that this
 * Book doesn't: looked at on start, every minute, and when the app comes
 * back. `saved` is the running total this phone kept before (its first
 * anchor); `savedStart` what paper money last started at here.
 */
export function useServerBook(
  closedTrades: HistoricalTrade[],
  setClosedTrades: Dispatch<SetStateAction<HistoricalTrade[]>>,
  saved: Pick<DeskMoney, "equity" | "allTimeRealizedPnl">,
  savedStart: number
) {
  const [held, setHeldState] = useState<HeldAnchor>(() => {
    const kept = loadHeld();
    if (kept) return kept;
    const first: HeldAnchor = { anchor: firstAnchor(saved, closedTrades, savedStart), sent: false };
    saveHeld(first);
    return first;
  });
  const heldRef = useRef(held);
  const setHeld = useCallback((next: HeldAnchor) => {
    heldRef.current = next;
    saveHeld(next);
    setHeldState(next);
  }, []);

  // Today's P&L counts India's day: looked at each minute.
  const [today, setToday] = useState(() => istDay(Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setToday(istDay(Date.now())), 60_000);
    return () => clearInterval(timer);
  }, []);

  const money = useMemo(() => deskMoney(held.anchor, closedTrades, today), [held, closedTrades, today]);

  // Sends this phone's anchor; takes the one the server answers with (a
  // first one doesn't replace one another device set), unless it changed meanwhile.
  const send = useCallback(
    async (h: HeldAnchor) => {
      try {
        const res = await apiFetch("/api/book/anchor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anchor: h.anchor, keep: !h.restart }),
        });
        if (!res.ok) return;
        const anchor = cleanAnchor((await res.json()).anchor);
        if (anchor && heldRef.current === h) setHeld({ anchor, sent: true });
      } catch {}
    },
    [setHeld]
  );

  useEffect(() => {
    let stopped = false;
    let bookedSince = 0;
    const fetchBook = async (query: string) => {
      const res = await apiFetch(`/api/book?${query}`);
      return res.ok ? res.json() : null;
    };
    const look = async () => {
      try {
        let data;
        if (bookedSince > 0) {
          data = await fetchBook(`bookedSince=${bookedSince}`);
        } else {
          const since = Math.max(0, Math.min(Date.now() - FIRST_LOOK_MS, heldRef.current.anchor.at));
          data = await fetchBook(`since=${since}`);
          const server = cleanAnchor(data?.anchor);
          // Another device's anchor from before what was asked for: every close since it counts.
          if (data && server && server.at < since) {
            const older = await fetchBook(`since=${server.at}`);
            if (older) data = { ...data, trades: [...(data.trades ?? []), ...(older.trades ?? [])] };
          }
        }
        if (!data || stopped) return;
        if (Array.isArray(data.trades) && data.trades.length > 0) setClosedTrades((prev) => withBookTrades(prev, data.trades));
        if (Number.isFinite(data.bookedUntil)) bookedSince = data.bookedUntil;
        const h = heldRef.current;
        const step = anchorStep(h, cleanAnchor(data.anchor));
        if (step && "adopt" in step) setHeld({ anchor: step.adopt, sent: true });
        else if (step) await send(h);
      } catch {}
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void look();
    };
    void look();
    const timer = setInterval(look, LOOK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setClosedTrades, setHeld, send]);

  /** Paper money starts again at `amount` (Settings → Paper money), on every device. */
  const restart = useCallback(
    (amount: number) => {
      const next: HeldAnchor = { anchor: restartAnchor(amount, Date.now()), sent: false, restart: true };
      setHeld(next);
      void send(next);
    },
    [setHeld, send]
  );

  return { money, paperStart: held.anchor.start, restart };
}
