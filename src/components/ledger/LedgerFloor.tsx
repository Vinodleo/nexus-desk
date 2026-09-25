import React, { useEffect, useState } from "react";
import { Settings, Power, ShieldCheck, ShieldAlert, ChevronRight, AlertTriangle } from "lucide-react";
import type { Position } from "../../types";
import { useLiveTickers } from "../../hooks/useLiveTickers";
import { liveMarketStream, MIN_SIGNAL_BARS, type CandleStatus } from "../../services/liveMarketStreamService";
import { Card, RoundIconButton, SectionHeading, StatTile, Switch } from "./ui";
import { formatMoney, formatPct, formatPrice, pnlTone } from "./format";
import { Flash, Rolling, useAnimatedNumber, usePresenceList, type ListItemState } from "./motion";
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

/** Money in a position: its entry price times the quantity still open. */
export const moneyIn = (p: Position) => p.entryPrice * openQuantity(p);

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

  const tone = pnlTone(p.unrealizedPnl);
  return (
    <li className={`nx-item${state === "enter" ? " nx-item-enter" : state === "leave" ? " nx-item-leave" : ""}`} aria-hidden={state === "leave" || undefined}>
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
          <span className="text-xs text-muted">{positionNote(p)}</span>
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
  const rows = usePresenceList(positions, (p) => p.id);
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
      </section>

      <Card aria-label="Autopilot" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Autopilot</div>
            <div className="text-xs text-muted">
              {props.stopped
                ? "Stopped · no new trades until you resume"
                : props.autopilotOn
                ? props.scanLocation === "server" && !props.isLive
                  ? "Approves trades within your limits · runs on the server, even with the app closed"
                  : "Approves trades within your limits"
                : "Off · you approve every trade"}
            </div>
            {props.autopilotOn && !props.stopped && props.scanLocation === "server" && !props.isLive && (
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
          <StatTile
            label="Daily loss left"
            value={formatMoney(Math.max(0, props.dailyLossLeft), { decimals: 0 })}
            valueClassName={props.dailyLossLeft <= 0 ? "text-loss" : ""}
          />
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
