import React, { useEffect, useRef, useState } from "react";
import { Settings, Power, ShieldCheck, ShieldAlert, ChevronRight, AlertTriangle } from "lucide-react";
import type { Position } from "../../types";
import { useLiveTickers } from "../../hooks/useLiveTickers";
import { liveMarketStream, MIN_SIGNAL_BARS, type CandleStatus } from "../../services/liveMarketStreamService";
import { Card, RoundIconButton, SectionHeading, StatTile, Switch } from "./ui";
import { formatMoney, formatPct, formatPrice, pnlTone } from "./format";
import { Flash, GrowBar, Rolling, useAnimatedNumber, usePresenceList, type ListItemState } from "./motion";
import { isNseOpen } from "../../shared/nse";
import { isUsOpen } from "../../shared/usMarket";
import { SKIP_REASON_LABEL, type SkipCounts, type SkipReason } from "../../services/scanOutcome";
import type { EventWindow } from "../../shared/eventCalendar";
import { openQuantity } from "../../shared/exitRules";

/** The most common skip reasons, largest first, with their share of all skips. */
export function topSkipReasons(counts: SkipCounts | undefined, limit = 3): { reason: SkipReason; label: string; pct: number }[] {
  const entries = Object.entries(counts ?? {}) as [SkipReason, number][];
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (total === 0) return [];
  return entries
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, n]) => ({ reason, label: SKIP_REASON_LABEL[reason] ?? reason, pct: Math.round((n / total) * 100) }));
}

export interface FloorTicker {
  symbol: string;
  price: number;
  changePercent: number;
}

export interface CoinCoverage {
  count: number;
  /** True while it's the default list, before CoinDCX's most-traded list loads. */
  fallback: boolean;
}

export interface FloorScanSummary {
  analyzed: number;
  selected: number;
  rejected: number;
  /** Why coins were skipped today, counted by reason. */
  skipReasons?: SkipCounts;
}

export interface LedgerFloorProps {
  isLive: boolean;
  equity: number;
  dailyPnl: number;
  allTimePnl: number;
  autopilotOn: boolean;
  onAutopilotChange: (on: boolean) => void;
  /** Open notional as a share of equity (0.099 = 9.9%). */
  exposureFraction: number;
  dailyLossLeft: number;
  stopped: boolean;
  onToggleStop: () => void;
  positions: Position[];
  onClosePosition: (pos: Position) => void;
  /** null while the first guardian sync is still in flight. */
  guardianOnline: boolean | null;
  /** Bumped after a short phone lock: the header badge glows once to show prices are live again. */
  syncGlowKey?: number;
  /** Whether the server allows live orders at all (null until known). */
  liveTradingEnabled: boolean | null;
  /** Prices for the market line (BTC and ETH). Omit to follow the live stream. */
  market?: FloorTicker[];
  /** Whether the scanner has price candles for each coin. Omit to follow the live stream. */
  candleStatus?: CandleStatus[];
  /** How many coins the scanner covers, and whether it's the default list. Omit to follow the live stream. */
  watching?: CoinCoverage;
  /** Where scanning runs: on the server (even with the app closed) or in this browser. */
  scanLocation?: "checking" | "server" | "browser";
  /** The server's last scan, and when its autopilot last opened a position (ms; 0 if none). */
  lastServerScanAt?: number;
  lastServerOpenAt?: number;
  /** A scheduled-news pause now, or the next one. */
  eventWindow?: EventWindow;
  /** Today's loss limit in full, for the meter under "Daily loss left". */
  dailyLossLimit?: number;
  /** Trades closed today, oldest first: when (ms) and their P&L, for today's line. */
  todayCloses?: { at: number; pnl: number }[];
  pendingProposals: number;
  scan: FloorScanSummary;
  onOpenQueue: () => void;
  onOpenSettings: () => void;
}

function positionNote(p: Position): string {
  if (p.isLiveOrder) return "Live order on CoinDCX · guarded on the server";
  if (p.bankedQuantity) return `Half banked at +1R · ${Number((p.quantity - p.bankedQuantity).toFixed(8))} left on the trailing stop`;
  const isLong = p.direction === "LONG";
  const lockedIn = isLong ? p.stopLoss > p.entryPrice : p.stopLoss < p.entryPrice;
  if (p.trailActive && lockedIn) return `Trailing stop active · locked ${isLong ? "above" : "below"} entry`;
  if (p.trailActive) return "Trailing stop active";
  return "Guarded on the server if you close this tab";
}

const MARKET_SYMBOLS = ["BTC/INR", "ETH/INR"];

/** BTC and ETH with their 24-hour change: context, not part of the guardian's status. */
const MarketLine: React.FC<{ tickers: FloorTicker[] }> = ({ tickers }) => {
  const shown = MARKET_SYMBOLS.map((s) => tickers.find((t) => t.symbol === s)).filter((t): t is FloorTicker => !!t);
  if (shown.length === 0) return null;
  return (
    <div className="text-xs text-muted tabular-nums">
      {shown.map((t, i) => (
        <React.Fragment key={t.symbol}>
          {i > 0 && " · "}
          {t.symbol.split("/")[0]} {formatPrice(t.price)}{" "}
          <span className={pnlTone(t.changePercent)}>{formatPct(t.changePercent)}</span>
        </React.Fragment>
      ))}
      <span> in 24h</span>
    </div>
  );
};

// Subscribes to the price stream here, not in App, so a tick re-renders
// only this line.
const LiveMarketLine: React.FC = () => {
  const tickers = useLiveTickers();
  return <MarketLine tickers={tickers.map((t) => ({ symbol: t.symbol, price: t.price, changePercent: t.changePercent }))} />;
};

/** A warning when some coins have no price candles, with CoinDCX's reason. */
const CandleWarning: React.FC<{ status: CandleStatus[] }> = ({ status }) => {
  const missing = status.filter((s) => s.bars < MIN_SIGNAL_BARS && s.checkedAt > 0);
  if (missing.length === 0) return null;
  const reason = missing.find((s) => s.error)?.error;
  return (
    <div role="status" className="flex gap-2.5 p-3 rounded-xl bg-warn-soft text-warn-ink text-xs leading-relaxed">
      <AlertTriangle className="w-4 h-4 shrink-0 text-warn mt-px" strokeWidth={1.8} />
      <span>
        <strong>
          No price candles for {missing.length} of {status.length} coins
        </strong>{" "}
        ({missing.map((s) => s.symbol.split("/")[0]).join(", ")}), so the scanner can't check them.
        {reason && <span className="block mt-1 break-words opacity-80">{reason}</span>}
      </span>
    </div>
  );
};

const LiveCandleWarning: React.FC = () => {
  const [status, setStatus] = useState<CandleStatus[]>(() => liveMarketStream.getCandleStatus());
  useEffect(() => liveMarketStream.subscribe(() => setStatus(liveMarketStream.getCandleStatus())), []);
  return <CandleWarning status={status} />;
};

const WHERE: Record<string, string> = {
  server: " · scanned on the server, even with the app closed",
  browser: " · scanned in this browser while it's open",
};

const Coverage: React.FC<{ watching: CoinCoverage; scanLocation?: string }> = ({ watching, scanLocation }) => (
  <div>
    {watching.fallback
      ? `Watching ${watching.count} default coins until CoinDCX's most-traded list loads`
      : `Watching CoinDCX's ${watching.count} most-traded coins, updated hourly`}
    {scanLocation ? WHERE[scanLocation] ?? "" : ""}
  </div>
);

// Holds the count and flag as plain values so price ticks don't re-render it.
const LiveCoverage: React.FC<{ scanLocation?: string }> = ({ scanLocation }) => {
  const read = () => liveMarketStream.getUniverseInfo();
  const [count, setCount] = useState(() => read().count);
  const [fallback, setFallback] = useState(() => read().fallback);
  useEffect(
    () =>
      liveMarketStream.subscribe(() => {
        const info = read();
        setCount(info.count);
        setFallback(info.fallback);
      }),
    []
  );
  return <Coverage watching={{ count, fallback }} scanLocation={scanLocation} />;
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** "2:15 PM", or "24 Sep, 2:15 PM" for an earlier day. */
const clockText = (ms: number, now = Date.now()) =>
  new Date(ms).toDateString() === new Date(now).toDateString()
    ? clock(ms)
    : `${new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" })}, ${clock(ms)}`;
/** "just now", "4 min ago", "2 h ago". */
const agoText = (ms: number, now = Date.now()) => {
  const mins = Math.max(0, Math.round((now - ms) / 60000));
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};
/** Show the next pause this far ahead. */
const NEXT_PAUSE_NOTICE_MS = 2 * 60 * 60 * 1000;

/** A news pause in force, or one coming up within two hours. */
export const NewsPause: React.FC<{ window: EventWindow; now?: number }> = ({ window: w, now = Date.now() }) => {
  if (w.active) {
    return (
      <div role="status" className="flex gap-2.5 p-3 rounded-xl bg-warn-soft text-warn-ink text-xs leading-relaxed">
        <AlertTriangle className="w-4 h-4 shrink-0 text-warn mt-px" strokeWidth={1.8} />
        <span>
          <strong>News pause until {clock(w.until ?? now)}</strong> for {w.headline}. No new trades; open positions stay guarded.
        </span>
      </div>
    );
  }
  if (w.next && w.next.startsAt - now <= NEXT_PAUSE_NOTICE_MS) {
    return (
      <div className="text-xs text-muted">
        News pause from {clock(w.next.startsAt)} for {w.next.headline}
      </div>
    );
  }
  return null;
};

/** The next time `isOpen` turns true after `now` (5-minute steps, up to a week); null if not found. */
export function nextOpenAt(isOpen: (ms: number) => boolean, now: number = Date.now()): number | null {
  const step = 5 * 60 * 1000;
  for (let t = Math.ceil(now / step) * step; t < now + 7 * 24 * 60 * 60 * 1000; t += step) if (isOpen(t)) return t;
  return null;
}

/** "9:15 AM" today, "Mon 9:15 AM" on another day. */
const openText = (ms: number, now: number) =>
  new Date(ms).toDateString() === new Date(now).toDateString()
    ? clock(ms)
    : `${new Date(ms).toLocaleDateString([], { weekday: "short" })} ${clock(ms)}`;

const MARKETS: { id: string; label: string; isOpen: (ms: number) => boolean }[] = [
  { id: "coins", label: "Coins", isOpen: () => true },
  { id: "india", label: "India", isOpen: isNseOpen },
  { id: "us", label: "US", isOpen: isUsOpen },
];

/**
 * Which markets are open now: a filled dot when open, a hollow one with the
 * next opening time when closed. A market that opens while this is on
 * screen pulses a ring a few times.
 */
export const MarketChips: React.FC<{ now?: number }> = ({ now: fixedNow }) => {
  const [tick, setTick] = useState(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return setTick(fixedNow);
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [fixedNow]);
  const now = fixedNow ?? tick;
  const wasOpen = useRef<Record<string, boolean> | null>(null);
  const opened = useRef<Record<string, number>>({});
  const open = Object.fromEntries(MARKETS.map((m) => [m.id, m.isOpen(now)]));
  if (wasOpen.current) {
    for (const m of MARKETS) if (open[m.id] && !wasOpen.current[m.id]) opened.current[m.id] = (opened.current[m.id] ?? 0) + 1;
  }
  wasOpen.current = open;
  return (
    <div aria-label="Markets" className="flex flex-wrap gap-1.5">
      {MARKETS.map((m) => {
        const on = open[m.id];
        const next = on || m.id === "coins" ? null : nextOpenAt(m.isOpen, now);
        const text = m.id === "coins" ? "24/7" : on ? "open" : next ? openText(next, now) : "closed";
        return (
          <span
            key={m.id}
            data-testid={`market-${m.id}`}
            data-open={on}
            className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-full border border-line transition-colors ${
              on ? "bg-surface text-ink" : "text-muted"
            }`}
          >
            <span className="relative w-2 h-2">
              {on && opened.current[m.id] && (
                <span key={opened.current[m.id]} aria-hidden="true" className="absolute inset-0 rounded-full bg-gain nx-ring-once" />
              )}
              <span className={`absolute inset-0 rounded-full border-[1.5px] transition-colors ${on ? "bg-gain border-gain" : "border-muted"}`} />
            </span>
            {m.label} · {text}
          </span>
        );
      })}
    </div>
  );
};

/**
 * Today's P&L through the day: 0 at midnight, a step at each close, and
 * where it stands now with the open trades. Draws itself when shown; the
 * "now" dot pulses.
 */
export const TodayLine: React.FC<{ closes: { at: number; pnl: number }[]; openPnl: number; now?: number }> = ({ closes, openPnl, now = Date.now() }) => {
  const start = new Date(now).setHours(0, 0, 0, 0);
  const pts: [number, number][] = [[start, 0]];
  let sum = 0;
  for (const c of closes) {
    if (c.at < start || c.at > now) continue;
    sum += c.pnl;
    pts.push([c.at, sum]);
  }
  pts.push([now, sum + openPnl]);
  if (pts.length < 3 && openPnl === 0) return null;
  const W = 300;
  const H = 56;
  const values = pts.map(([, v]) => v);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const x = (t: number) => ((t - start) / Math.max(1, now - start)) * W;
  const y = (v: number) => 4 + (1 - (v - lo) / span) * (H - 8);
  const d = pts.map(([t, v], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const end = pts[pts.length - 1][1];
  const tone = end >= 0 ? "text-gain" : "text-loss";
  return (
    <div className={tone} data-testid="today-line">
      {/* The chart and its "now" dot share this box, so the dot sits on the line's end. The dot stays inside the
          right edge; the labels sit below, clear of it. */}
      <div className="relative h-14 pr-1.5">
        <div className="h-full nx-reveal">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full h-full" aria-label="Today's P&L through the day">
            <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="stroke-line" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
            <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <span
          data-testid="today-dot"
          className="absolute right-0 w-2.5 h-2.5 -mt-[5px] rounded-full bg-current"
          style={{ top: `${(y(end) / H) * 100}%` }}
        >
          <span aria-hidden="true" className="absolute inset-0 rounded-full bg-current nx-ring" />
        </span>
      </div>
      <div className="flex justify-between text-[11px] text-muted mt-1.5">
        <span>Midnight</span>
        <span>Now</span>
      </div>
    </div>
  );
};

/** Money in a position: its entry price times the quantity still open. */
export const moneyIn = (p: Position) => p.entryPrice * openQuantity(p);

/**
 * Where `price` sits on a trade's line from its original stop to its target,
 * 0 (stop) to 1 (target), clamped; null when the line has no length.
 */
export function trackPoint(p: Pick<Position, "direction" | "stopLoss" | "initialStopLoss" | "takeProfit">, price: number): number | null {
  const lo = p.initialStopLoss ?? p.stopLoss;
  const hi = p.takeProfit;
  const span = p.direction === "LONG" ? hi - lo : lo - hi;
  if (!(span > 0) || !Number.isFinite(price)) return null;
  const f = (p.direction === "LONG" ? price - lo : lo - price) / span;
  return Math.max(0, Math.min(1, f));
}

/** How long a closed trade stays on the Floor while it animates away. */
const CLOSE_ANIMATION_MS = 1300;

/** How long a "Half banked" tag stays up after half is banked. */
const BANKED_TAG_MS = 3300;

/**
 * The trade's line from stop to target: where the price is now (the marker
 * glides as it moves), the run from entry in green or red, the entry and
 * +1R ticks, and the stop once it has trailed up.
 */
const PositionTrack: React.FC<{ position: Position; bankedKey: number }> = ({ position: p, bankedKey }) => {
  const now = trackPoint(p, p.currentPrice);
  const entry = trackPoint(p, p.entryPrice);
  if (now === null || entry === null) return null;
  const risk = Math.abs(p.entryPrice - (p.initialStopLoss ?? p.stopLoss));
  const oneR = trackPoint(p, p.direction === "LONG" ? p.entryPrice + risk : p.entryPrice - risk);
  const stop = trackPoint(p, p.stopLoss);
  const up = now >= entry;
  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
  return (
    <div className="relative h-5" aria-hidden="true" data-testid="position-track">
      <div className="absolute inset-x-0 top-2 h-1 rounded-full bg-line" />
      <div
        className={`absolute top-2 h-1 rounded-full nx-glide-left ${up ? "bg-gain" : "bg-loss"}`}
        style={{ left: pct(Math.min(entry, now)), width: pct(Math.abs(now - entry)) }}
      />
      <div className="absolute top-[3px] w-0.5 h-3.5 -ml-px bg-muted" style={{ left: pct(entry) }} />
      {oneR !== null && oneR < 1 && <div className="absolute top-[3px] w-0.5 h-3.5 -ml-px bg-line" style={{ left: pct(oneR) }} />}
      {stop !== null && stop > 0.001 && <div className="absolute top-[3px] w-0.5 h-3.5 -ml-px bg-loss" style={{ left: pct(stop) }} />}
      <div
        data-testid="position-marker"
        className={`absolute top-[3px] w-3.5 h-3.5 -ml-[7px] rounded-full border-2 border-surface nx-glide-left ${up ? "bg-gain" : "bg-loss"}`}
        style={{ left: pct(now) }}
      />
      {bankedKey > 0 && oneR !== null && (
        <span
          key={bankedKey}
          className="nx-tag-pop absolute -top-5 whitespace-nowrap text-[11px] font-bold px-2 py-px rounded-full bg-surface border border-line text-gain"
          style={{ left: pct(oneR) }}
        >
          Half banked ✓
        </span>
      )}
    </div>
  );
};

const PositionRow: React.FC<{ position: Position; onClose: (p: Position) => void; state?: ListItemState }> = ({
  position: p,
  onClose,
  state = "stay",
}) => {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  // "Half banked" pops up when half is banked while this row is on screen.
  const banked = (p.bankedQuantity ?? 0) > 0;
  const wasBanked = useRef(banked);
  const [bankedKey, setBankedKey] = useState(0);
  useEffect(() => {
    if (banked && !wasBanked.current) setBankedKey((k) => k + 1);
    wasBanked.current = banked;
  }, [banked]);
  useEffect(() => {
    if (bankedKey === 0) return;
    const t = setTimeout(() => setBankedKey(0), BANKED_TAG_MS);
    return () => clearTimeout(t);
  }, [bankedKey]);

  const tone = pnlTone(p.unrealizedPnl);
  const closing = state === "leave";
  return (
    <li
      className={`nx-item${
        state === "enter" ? " nx-item-enter" : closing ? ` nx-item-close ${p.unrealizedPnl >= 0 ? "nx-item-close-gain" : "nx-item-close-loss"}` : ""
      }`}
      aria-hidden={closing || undefined}
    >
      <div className="flex flex-col gap-2 py-3.5 border-b border-line">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <span className="text-base font-semibold">{p.symbol}</span>{" "}
            <span className="text-xs text-muted">
              {p.direction === "LONG" ? "Long" : "Short"} · {p.quantity} · {formatMoney(moneyIn(p), { decimals: 0 })} in
            </span>
            {p.openedByServer && (
              <div className="text-xs text-accent">Opened by the server at {clock(Date.parse(p.openTime))}</div>
            )}
          </div>
          <Flash value={p.currentPrice} className={`font-display text-xl tabular-nums whitespace-nowrap px-1 -mx-1 ${tone}`}>
            <Rolling value={p.unrealizedPnl} format={(n) => formatMoney(n, { signed: true })} />
          </Flash>
        </div>
        <PositionTrack position={p} bankedKey={bankedKey} />
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted tabular-nums">
          <span>Entry {formatPrice(p.entryPrice)}</span>
          <Flash value={p.currentPrice} className="px-1 -mx-1 text-ink">
            Now {formatPrice(p.currentPrice)}
          </Flash>
          <span>Stop {formatPrice(p.stopLoss)}</span>
          <span>Target {formatPrice(p.takeProfit)}</span>
          <span className={tone}>{formatPct(p.unrealizedPnlPercent)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className={`text-xs ${closing ? `font-semibold ${tone}` : "text-muted"}`}>{closing ? "Closed" : positionNote(p)}</span>
          <button
            type="button"
            onClick={() => {
              if (confirming) {
                setConfirming(false);
                onClose(p);
              } else {
                setConfirming(true);
              }
            }}
            className={`shrink-0 min-h-[36px] px-3 -mr-1 rounded-full text-xs font-semibold cursor-pointer transition-colors ${
              confirming ? "bg-danger-soft text-loss border border-danger-line" : "text-accent hover:bg-accent-soft"
            }`}
          >
            {confirming ? "Tap again to close" : "Close"}
          </button>
        </div>
      </div>
    </li>
  );
};

export const LedgerFloor: React.FC<LedgerFloorProps> = (props) => {
  const {
    isLive,
    equity,
    dailyPnl,
    allTimePnl,
    positions,
  } = props;

  // Equity and P&L glide to new values; positions animate in and out.
  const shownEquity = Math.round(useAnimatedNumber(equity) * 100) / 100;
  const whole = formatMoney(Math.trunc(shownEquity), { decimals: 0 });
  const paise = Math.abs(shownEquity % 1).toFixed(2).slice(1); // ".96"
  const openPnl = positions.reduce((acc, p) => acc + (p.unrealizedPnl || 0), 0);
  // A closed trade holds its result for a moment, then slides away (nx-item-close).
  const rows = usePresenceList(positions, (p) => p.id, CLOSE_ANIMATION_MS);
  const signedMoney = (n: number) => formatMoney(n, { signed: true });

  const guardianText =
    props.guardianOnline === null ? "Guardian connecting" : props.guardianOnline ? "Guardian online" : "Guardian unreachable";
  const liveText =
    props.liveTradingEnabled === null ? null : props.liveTradingEnabled ? "live trading on" : "live trading off";

  return (
    <div className="font-ui text-ink flex flex-col gap-[18px] pb-4 select-none">
      <header className="flex items-center justify-between pt-1">
        <h1 className="m-0 font-display text-[22px] font-semibold">Nexus Desk</h1>
        <div className="flex items-center gap-2">
          <span
            key={props.syncGlowKey ?? 0}
            className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isLive ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent"
            }${props.syncGlowKey ? " nx-glow" : ""}`}
          >
            {isLive ? "Live" : "Paper"}
          </span>
          <RoundIconButton label="Settings" onClick={props.onOpenSettings}>
            <Settings className="w-[18px] h-[18px]" strokeWidth={1.6} />
          </RoundIconButton>
        </div>
      </header>

      <MarketChips />

      <section aria-label="Account" className="flex flex-col gap-1.5">
        <div className="text-[13px] text-muted">{isLive ? "CoinDCX equity" : "Paper equity"}</div>
        <div className="font-display text-[46px] leading-[1.05] tracking-[-0.01em] tabular-nums">
          {whole}
          <span className="text-muted">{paise}</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] tabular-nums">
          <span>
            Today <strong className={pnlTone(dailyPnl)}><Rolling value={dailyPnl} format={signedMoney} /></strong>
          </span>
          <span>
            All time <strong className={pnlTone(allTimePnl)}><Rolling value={allTimePnl} format={signedMoney} /></strong>
          </span>
        </div>
        {props.todayCloses && <TodayLine closes={props.todayCloses} openPnl={openPnl} />}
      </section>

      <Card aria-label="Autopilot" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Autopilot</div>
            <div className="text-xs text-muted">
              {props.stopped
                ? "Stopped · no new trades until you resume"
                : props.autopilotOn && props.isLive
                ? props.liveTradingEnabled
                  ? "Live · places real CoinDCX orders from the server within your limits, even with the app closed. Coins only: stock trades wait for you."
                  : "Live orders are blocked on the server, so live trades wait for you to approve them."
                : props.autopilotOn
                ? props.scanLocation === "server" && !props.isLive
                  ? "Approves trades within your limits · runs on the server, even with the app closed"
                  : "Approves trades within your limits"
                : "Off · you approve every trade"}
            </div>
            {props.autopilotOn && !props.stopped && props.scanLocation === "server" && (!props.isLive || props.liveTradingEnabled === true) && (
              <div className="text-xs text-muted tabular-nums" aria-label="Server autopilot">
                Server: last scan {props.lastServerScanAt ? agoText(props.lastServerScanAt) : "pending"} · last trade{" "}
                {props.lastServerOpenAt ? clockText(props.lastServerOpenAt) : "none yet"}
              </div>
            )}
          </div>
          <Switch checked={props.autopilotOn} onChange={props.onAutopilotChange} label="Autopilot" disabled={props.stopped} />
        </div>
        <div className="flex gap-2">
          <StatTile
            label={`In trades · ${(props.exposureFraction * 100).toFixed(1)}%`}
            value={formatMoney(props.positions.reduce((a, p) => a + moneyIn(p), 0), { decimals: 0 })}
          />
          <div className="flex-1 basis-0 min-w-0 bg-inset rounded-[10px] px-2.5 py-2">
            <div className="text-[11px] text-muted">Daily loss left</div>
            <div className={`font-display text-lg tabular-nums truncate ${props.dailyLossLeft <= 0 ? "text-loss" : ""}`}>
              {formatMoney(Math.max(0, props.dailyLossLeft), { decimals: 0 })}
            </div>
            {props.dailyLossLimit !== undefined && props.dailyLossLimit > 0 && (
              <div className="h-1 mt-1 rounded-full bg-line overflow-hidden" data-testid="loss-meter">
                <GrowBar
                  fraction={props.dailyLossLeft / props.dailyLossLimit}
                  className={props.dailyLossLeft / props.dailyLossLimit <= 0.25 ? "bg-warn" : "bg-accent"}
                />
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={props.onToggleStop}
            aria-pressed={props.stopped}
            className={`flex-1 basis-0 min-h-11 rounded-[10px] border text-[13px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
              props.stopped
                ? "bg-accent text-on-accent border-accent"
                : "bg-danger-soft text-loss border-danger-line hover:brightness-95"
            }`}
          >
            <Power className="w-4 h-4" strokeWidth={1.8} />
            {props.stopped ? "Resume" : "Stop all"}
          </button>
        </div>
      </Card>

      {props.pendingProposals > 0 && (
        <button
          type="button"
          onClick={props.onOpenQueue}
          className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-accent-soft text-accent text-sm font-semibold cursor-pointer text-left"
        >
          <span>
            {props.pendingProposals} {props.pendingProposals === 1 ? "proposal" : "proposals"} waiting for you
          </span>
          <ChevronRight className="w-4 h-4 shrink-0" />
        </button>
      )}

      <section aria-label="Open positions" className="flex flex-col">
        <SectionHeading
          title="Open positions"
          right={
            positions.length > 0 ? (
              <span className={`text-[13px] tabular-nums ${pnlTone(openPnl)}`}><Rolling value={openPnl} format={signedMoney} /></span>
            ) : undefined
          }
        />
        {rows.length === 0 ? (
          <p className="text-sm text-muted py-4 m-0 border-b border-line">
            No open positions. {props.autopilotOn ? "Autopilot will open trades that pass every check." : "Approved proposals appear here."}
          </p>
        ) : (
          <ul className="list-none m-0 p-0">
            {rows.map(({ item: p, key, state }) => (
              <PositionRow key={key} position={p} onClose={props.onClosePosition} state={state} />
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-start gap-2.5 text-xs text-muted leading-relaxed">
        <span className={`shrink-0 ${props.guardianOnline === false ? "text-loss" : "text-gain"}`}>
          {props.guardianOnline === false ? (
            <ShieldAlert className="w-4 h-4" strokeWidth={1.8} />
          ) : (
            <ShieldCheck className="w-4 h-4" strokeWidth={1.8} />
          )}
        </span>
        <span>
          {guardianText}
          {liveText && ` · ${liveText}`}
        </span>
      </div>

      {props.market !== undefined ? <MarketLine tickers={props.market} /> : <LiveMarketLine />}

      {props.candleStatus !== undefined ? <CandleWarning status={props.candleStatus} /> : <LiveCandleWarning />}

      {props.eventWindow && <NewsPause window={props.eventWindow} />}

      <section aria-label="Scanner today" className="flex flex-col gap-1.5 text-xs text-muted tabular-nums">
        {props.watching !== undefined ? (
          <Coverage watching={props.watching} scanLocation={props.scanLocation} />
        ) : (
          <LiveCoverage scanLocation={props.scanLocation} />
        )}
        <div>
          Scanner today: {props.scan.analyzed} checked · {props.scan.selected} proposed · {props.scan.rejected} skipped
        </div>
        {topSkipReasons(props.scan.skipReasons).map((r) => (
          <div key={r.reason} className="flex items-center gap-2">
            <div className="w-16 h-1 rounded-full bg-line overflow-hidden shrink-0" aria-hidden="true">
              <div className="h-full bg-muted" style={{ width: `${r.pct}%` }} />
            </div>
            <span>
              {r.label} · {r.pct}%
            </span>
          </div>
        ))}
      </section>
    </div>
  );
};
