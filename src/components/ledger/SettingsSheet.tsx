import React, { useEffect, useState } from "react";
import { X, RefreshCw, ChevronRight, ChevronDown, Check, Lock, Minus, Plus, MessageSquare, Smartphone, Download } from "lucide-react";
import type { CoinDcxAccountBalance, CoinDcxServerStatus, TradingExecutionMode } from "../../types";
import { useAuth } from "../../context/AuthContext";
import { usePWAInstall } from "../../hooks/usePWAInstall";
import { HoldButton, RoundIconButton, Segmented, Switch } from "./ui";
import type { NotifyState } from "../../hooks/useTradeNotifications";
import type { RiskLimits } from "../../hooks/useRiskPolicy";
import {
  AMOUNT_CHOICES,
  BREAKOUT_TRADES_CHOICES,
  DEFAULT_BREAKOUT_TRADES,
  DEFAULT_FUNDS_TRADES,
  DEFAULT_MOMENTUM_TRADES,
  defaultRiskPerTrade,
  FUNDS_TRADES_CHOICES,
  marketOf,
  MAX_TRADES_CHOICES,
  MOMENTUM_TRADES_CHOICES,
  PAPER_MONEY_CHOICES,
  RISK_CHOICES,
  slotKindOf,
  type MarketKey,
  type MarketLimits,
} from "../../shared/marketLimits";
import { formatMoney } from "./format";
import type { ServerStatus } from "../../hooks/useServerStatus";
import { GrowBar, prefersReducedMotion, RollingDigits, usePresence, useShown, useSlideFrom } from "./motion";
import { builtAtText, checkForUpdate, type UpdateCheck } from "../../services/appUpdates";
import { THEMES, type ThemeId } from "../../services/theme";
import { reviewerSummary } from "../../services/reviewerSummary";
import { nseTakesEntries } from "../../shared/nse";
import { usTakesEntries } from "../../shared/usMarket";
import { coinProblemLine } from "../../shared/coinDcxCheck";
import { LiveTestCard } from "./LiveTestCard";
import { useTelegramLink } from "../../hooks/useTelegramLink";

export interface SettingsSheetProps {
  /** Pop-up notifications when a trade opens (this device). */
  notifications?: { state: NotifyState; error: string; enable: () => void; disable: () => void };
  isOpen: boolean;
  onClose: () => void;
  tradingMode: TradingExecutionMode;
  onTradingModeChange: (mode: TradingExecutionMode) => void;
  coinDcxStatus: CoinDcxServerStatus | null;
  coinDcxBalance: CoinDcxAccountBalance;
  onRefreshBalance: () => void;
  dailyLossLimit: number;
  /** What today's closed trades lost so far (the daily loss limit's use). */
  todayLoss?: number;
  /** The paper balance: what it last started at, what it is now, and starting it again at another amount. */
  paperMoney?: { start: number; equity: number; onRestart: (amountInr: number) => void };
  maxOpenPositions: number;
  riskLimits: RiskLimits;
  onRiskLimitsChange: (next: Partial<RiskLimits>) => void;
  /** The open trades: the slots each slower strategy uses now. */
  positions?: { symbol: string; strategy?: string }[];
  onOpenDeskBrief: () => void;
  /** This phone: the account, recent activity and the memory's cloud copy (ThisPhoneSheet). */
  onOpenPhone: () => void;
  /** The server's host status (null while loading or unreachable). */
  serverStatus?: ServerStatus | null;
  /** Where scanning runs, and when the server last scanned. */
  scanLocation?: "checking" | "server" | "browser";
  lastServerScanAt?: number;
  /** Where the gear was on screen when Settings was opened: it opens from there, and its ✕ sits on that spot. */
  from?: { left: number; top: number; width: number; height: number } | null;
  /** This device's colour theme, and choosing another. */
  theme?: ThemeId;
  /** `from` is the tapped theme's centre on screen: the new look grows from there. */
  onThemeChange?: (id: ThemeId, from?: { x: number; y: number }) => void;
}

/** The Backups row: whether daily off-site backups are on, the last one, and a failure. */
export function backupSummary(status: ServerStatus | null, now: number = Date.now()): { sub: string; badge: string; tone: string } {
  const b = status?.backup;
  if (!status || !b) return { sub: "Daily copies of the server's saved state, off the server", badge: "—", tone: "text-muted" };
  if (!b.configured) {
    // Some settings there but not all: name the ones the server can't see.
    const some = b.missing && b.missing.length > 0 && b.missing.length < 4;
    return some
      ? { sub: `The server can't see ${b.missing!.join(", ")}: run \`fly secrets deploy\` in Cloud Shell (docs/hosting.md)`, badge: "Off", tone: "text-warn" }
      : {
          sub: "The server sees no storage settings. If `fly secrets list` shows AWS_… and BUCKET_NAME, run `fly secrets deploy`; if not, `fly storage create -a nexus-desk-vinodleo` (docs/hosting.md)",
          badge: "Off",
          tone: "text-warn",
        };
  }
  if (b.lastError && (!b.lastAt || (b.lastErrorAt ?? 0) > b.lastAt)) return { sub: `Last try failed: ${b.lastError}. It tries again every hour.`, badge: "Failing", tone: "text-loss" };
  if (!b.lastAt) return { sub: "Set up; the first backup runs a few minutes after the server starts", badge: "On", tone: "text-gain" };
  return { sub: `Last ${formatSpan(now - b.lastAt)} ago, ${b.files} files · each kept ${b.keepDays} days`, badge: "On", tone: "text-gain" };
}

/** The CoinDCX check row: whether the coins held there match the live trades. */
export function coinDcxCheckSummary(status: ServerStatus | null, now: number = Date.now()): { sub: string; badge: string; tone: string } {
  const c = status?.coinDcxCheck;
  if (!status || !c) return { sub: "Daily: the coins at CoinDCX match the live trades", badge: "—", tone: "text-muted" };
  if (!c.configured) return { sub: "No CoinDCX keys on the server: needed only for live trading", badge: "Off", tone: "text-muted" };
  if (c.problems.length > 0) return { sub: c.problems.map(coinProblemLine).join(" · "), badge: "Mismatch", tone: "text-loss" };
  if (c.lastError && (!c.lastAt || (c.lastErrorAt ?? 0) > c.lastAt))
    return { sub: `Last check failed: ${c.lastError}. It tries again within the hour.`, badge: "Failing", tone: c.liveTrades > 0 ? "text-loss" : "text-warn" };
  if (!c.lastAt) return { sub: "Keys set; the first check runs a few minutes after the server starts", badge: "On", tone: "text-gain" };
  const what = c.trades === 0 ? "no live trades; the keys work" : `${c.trades} live trade${c.trades === 1 ? "" : "s"} (${c.coins.join(", ")}), coins match`;
  const extra = c.extras.length > 0 ? ` · also held outside the app: ${c.extras.map((e) => e.coin).join(", ")}` : "";
  return { sub: `Checked ${formatSpan(now - c.lastAt)} ago: ${what}${extra}`, badge: "OK", tone: "text-gain" };
}

/** The Error reports row: whether the server's errors go to Sentry. */
export function errorReportsSummary(status: ServerStatus | null): { sub: string; badge: string; tone: string } {
  const e = status?.errorReports;
  if (!status || !e) return { sub: "The server's errors, sent to Sentry", badge: "—", tone: "text-muted" };
  if (!e.on) return { sub: "Off: set SENTRY_DSN on the server to send its errors to Sentry (docs/hosting.md)", badge: "Off", tone: "text-muted" };
  return { sub: "The server's errors go to Sentry (nexus-desk), without keys, tokens or emails", badge: "On", tone: "text-gain" };
}

/** "45 sec", "12 min", "3 h", "2 days". */
export function formatSpan(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} sec`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** A paper amount on a chip: "₹1L", "₹25L", "₹1Cr". */
export function shortRupees(n: number): string {
  if (n >= 1e7) return `₹${Number((n / 1e7).toFixed(2))}Cr`;
  if (n >= 1e5) return `₹${Number((n / 1e5).toFixed(2))}L`;
  return formatMoney(n, { decimals: 0 });
}

/** The choices, with the current value among them. */
const withCurrent = (choices: number[], current: number) => (choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b));

const rupees = (v: number) => formatMoney(v, { decimals: 0 });
/** The same figure with every digit 0: shown first, so the digits roll up to it. */
const zeroed = (s: string) => s.replace(/\d/g, "0");

/** A shimmering bar while the server's answer is on its way. */
const Checking: React.FC = () => <span role="status" aria-label="Checking" className="inline-block w-20 h-3.5 rounded bg-inset nx-shimmer" />;

const Label: React.FC<{ children: React.ReactNode; delay: number }> = ({ children, delay }) => (
  <h2 className="m-0 mt-2 px-1 text-xs font-bold text-muted uppercase tracking-[0.08em] nx-step-in" style={{ animationDelay: `${delay}ms` }}>
    {children}
  </h2>
);

const Group: React.FC<{ label: string; delay: number; className?: string; children: React.ReactNode }> = ({ label, delay, className = "px-4", children }) => (
  <section aria-label={label} className={`bg-surface border border-line rounded-[22px] nx-step-in ${className}`} style={{ animationDelay: `${delay + 40}ms` }}>
    {children}
  </section>
);

/** A status's tone as a dot: green when fine, amber or red when not, grey when off or unknown. */
const dotFor = (tone: string) => (tone === "text-gain" ? "bg-gain" : tone === "text-warn" ? "bg-warn" : tone === "text-loss" ? "bg-loss" : "bg-line");

/**
 * A figure stepped through its choices with − and +, its digits rolling to
 * each new value. Tapping the figure opens the phone's own picker of every
 * choice (the real select sits invisibly on top).
 */
const Stepper: React.FC<{ name: string; label: string; sub: React.ReactNode; value: number; choices: number[]; format: (v: number) => string; onChange: (v: number) => void }> = ({
  name,
  label,
  sub,
  value,
  choices,
  format,
  onChange,
}) => {
  const options = withCurrent(choices, value);
  const at = options.indexOf(value);
  return (
    <div className="py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="flex-1 min-w-0 text-sm font-semibold leading-snug">{name}</span>
        <button
          type="button"
          aria-label={`${label}: less`}
          disabled={at <= 0}
          onClick={() => onChange(options[at - 1])}
          className="w-[34px] h-[34px] shrink-0 rounded-full border border-line text-ink flex items-center justify-center cursor-pointer active:scale-90 transition-[transform,opacity] disabled:opacity-35 disabled:cursor-default"
        >
          <Minus className="w-3.5 h-3.5" strokeWidth={2.4} />
        </button>
        <span className="relative min-w-[84px] flex justify-center font-display text-xl tabular-nums">
          <RollingDigits text={format(value)} />
          <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} className="absolute inset-0 w-full opacity-0 cursor-pointer">
            {options.map((v) => (
              <option key={v} value={v}>
                {format(v)}
              </option>
            ))}
          </select>
        </span>
        <button
          type="button"
          aria-label={`${label}: more`}
          disabled={at >= options.length - 1}
          onClick={() => onChange(options[at + 1])}
          className="w-[34px] h-[34px] shrink-0 rounded-full bg-accent text-on-accent flex items-center justify-center cursor-pointer active:scale-90 transition-[transform,opacity] disabled:opacity-35 disabled:cursor-default"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2.4} />
        </button>
      </div>
      <div className="text-xs text-muted mt-1 leading-snug">{sub}</div>
    </div>
  );
};

/**
 * A slower strategy's own slots in a market: a square per slot, filled up to
 * how many it may hold, a dot in each one in use now; "Off" switches it off
 * there. Up to 6 squares; the count opens every choice (8 and 10 too).
 */
const Slots: React.FC<{
  title: string;
  name: string;
  what: string;
  value: number;
  choices: number[];
  inUse: number | null;
  sub: string;
  onChange: (v: number) => void;
}> = ({ title, name, what, value, choices, inUse, sub, onChange }) => {
  const squares = Math.min(6, Math.max(...choices));
  const used = inUse ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{name}</span>
        <span className={`relative inline-flex items-center gap-0.5 text-[13px] font-bold tabular-nums ${value === 0 ? "text-muted" : "text-accent"}`}>
          {value === 0 ? "Off" : `${value} slot${value === 1 ? "" : "s"}`}
          <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          <select
            aria-label={`${title}: ${what} trades at once`}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="absolute inset-0 w-full opacity-0 cursor-pointer"
          >
            {withCurrent(choices, value).map((v) => (
              <option key={v} value={v}>
                {v === 0 ? "Off" : String(v)}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div role="group" aria-label={`${title}: ${what} slots`} className="flex items-center gap-1.5">
        <button
          type="button"
          aria-pressed={value === 0}
          aria-label={`${title}: ${what} off`}
          onClick={() => onChange(0)}
          className={`h-[34px] px-3 shrink-0 rounded-[10px] border border-line text-xs font-bold cursor-pointer transition-colors ${value === 0 ? "bg-ink text-canvas" : "bg-surface text-muted"}`}
        >
          Off
        </button>
        {Array.from({ length: squares }, (_, k) => {
          const n = k + 1;
          const on = n <= value;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              aria-label={`${title}: ${n} ${what} slot${n === 1 ? "" : "s"}`}
              data-testid={`slot-square`}
              onClick={() => onChange(n)}
              className={`relative flex-1 max-w-[34px] aspect-square rounded-[10px] border-[1.5px] cursor-pointer transition-[background-color,border-color,transform] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                on ? "bg-accent border-accent scale-100" : "bg-inset border-line scale-[0.92]"
              }`}
              style={{ transitionDelay: `${n * 35}ms` }}
            >
              {n <= used && <span aria-hidden="true" data-testid="slot-in-use" className={`absolute left-1/2 top-1/2 w-2 h-2 -ml-1 -mt-1 rounded-full ${on ? "bg-on-accent" : "bg-muted"}`} />}
            </button>
          );
        })}
      </div>
      <div className="text-xs text-muted leading-snug">{sub}</div>
      {used > value && (
        <div className="text-xs text-warn leading-snug nx-badge-pop">
          {used} open now run to their exits;{" "}
          {value === 0 ? "it opens no new ones here." : value === 1 ? "a new one opens only once none are." : `a new one opens only once fewer than ${value} are.`}
        </div>
      )}
    </div>
  );
};

/**
 * Amount per trade, most to lose per trade and trades open at once for one
 * market, and the slower strategies' own slots there. Changeable any time,
 * paper or live; the server's autopilot uses them too.
 */
const MarketLimitRows: React.FC<{
  market: MarketKey;
  title: string;
  venue: string;
  limits: MarketLimits;
  onChange: (next: MarketLimits) => void;
  /** In Live mode, the server's cap per live order: a larger amount is flagged. */
  liveCapInr?: number;
  positions?: { symbol: string; strategy?: string }[];
}> = ({ market, title, venue, limits, onChange, liveCapInr, positions }) => {
  const mine = limits[market];
  const set = (patch: Partial<MarketLimits[MarketKey]>) => onChange({ ...limits, [market]: { ...mine, ...patch } });
  const overCap = liveCapInr !== undefined && mine.amountPerTradeInr > liveCapInr;
  const risk = mine.riskPerTradeInr ?? defaultRiskPerTrade(mine.amountPerTradeInr);
  // Breakout 55/20 trades coins and US stocks, on slots of its own.
  const breakoutHere = market !== "stocks";
  const breakout = mine.breakoutTrades ?? DEFAULT_BREAKOUT_TRADES[market];
  // Momentum, top 3, and breakout on the funds (gold, bonds and the rest, US-listed) trade US stocks only, on slots of their own too.
  const usOnly = market === "us";
  const momentum = mine.momentumTrades ?? DEFAULT_MOMENTUM_TRADES[market];
  const funds = mine.fundsTrades ?? DEFAULT_FUNDS_TRADES[market];
  // A stop closer than this (share of price) reaches the amount per trade first, so risks less.
  const fullRiskStopPct = (risk / mine.amountPerTradeInr) * 100;
  const inUse = (kind: "breakout" | "momentum" | "funds") =>
    positions ? positions.filter((p) => marketOf(p.symbol) === market && slotKindOf(p) === kind).length : null;
  // Every trade this market may hold at once, and the most they'd lose if every stop hit (never more than a trade's cost).
  const places = mine.maxOpenTrades + (breakoutHere ? breakout : 0) + (usOnly ? momentum + funds : 0);
  const atMost = mine.amountPerTradeInr * places;
  const ifStopsHit = Math.min(risk, mine.amountPerTradeInr) * places;
  return (
    <div className="flex flex-col">
      <Stepper
        name="Amount per trade"
        label={`${title}: amount per trade`}
        sub={
          overCap ? (
            <span className="text-loss">Above the server's {rupees(liveCapInr!)} cap per live order: live orders this size are refused</span>
          ) : (
            `The most one trade can cost · ${venue}`
          )
        }
        value={mine.amountPerTradeInr}
        choices={AMOUNT_CHOICES}
        format={rupees}
        onChange={(v) => set({ amountPerTradeInr: v })}
      />
      <Stepper
        name="Most to lose per trade"
        label={`${title}: most to lose per trade`}
        sub={
          fullRiskStopPct >= 100
            ? "More than the amount per trade: the amount decides the size"
            : `Sized to lose this at the stop; less if the stop is under ${Number(fullRiskStopPct.toFixed(1))}% away`
        }
        value={risk}
        choices={RISK_CHOICES}
        format={rupees}
        onChange={(v) => set({ riskPerTradeInr: v })}
      />
      <Stepper
        name="Trades at once"
        label={`${title}: trades at once`}
        sub={breakoutHere ? "5-minute and daily trades; the slower strategies have slots of their own" : "5-minute and daily trades"}
        value={mine.maxOpenTrades}
        choices={MAX_TRADES_CHOICES}
        format={String}
        onChange={(v) => set({ maxOpenTrades: v })}
      />
      {breakoutHere ? (
        <div className="border-t border-line mt-1.5 pt-3 flex flex-col gap-3.5">
          <div className="text-xs text-muted leading-snug">
            The slower strategies' own slots: other trades can't fill them.{positions ? " A dot is a slot in use now." : ""}
          </div>
          <Slots
            title={title}
            name="Breakout 55/20"
            what="breakout"
            value={breakout}
            choices={BREAKOUT_TRADES_CHOICES}
            inUse={inUse("breakout")}
            sub={breakout > 0 ? `Up to ${rupees(mine.amountPerTradeInr * breakout)} more` : "Breakout 55/20 doesn't trade here"}
            onChange={(v) => set({ breakoutTrades: v })}
          />
          {usOnly && (
            <Slots
              title={title}
              name="Momentum, top 3"
              what="momentum"
              value={momentum}
              choices={MOMENTUM_TRADES_CHOICES}
              inUse={inUse("momentum")}
              sub={momentum > 0 ? `Its weekly top 3, up to ${rupees(mine.amountPerTradeInr * momentum)} more` : "Momentum doesn't trade"}
              onChange={(v) => set({ momentumTrades: v })}
            />
          )}
          {usOnly && (
            <Slots
              title={title}
              name="Breakout on the funds"
              what="funds breakout"
              value={funds}
              choices={FUNDS_TRADES_CHOICES}
              inUse={inUse("funds")}
              sub={funds > 0 ? `Gold, bond and other funds, up to ${rupees(mine.amountPerTradeInr * funds)} more` : "Breakout doesn't trade the funds"}
              onChange={(v) => set({ fundsTrades: v })}
            />
          )}
        </div>
      ) : (
        <div className="border-t border-line mt-1.5 pt-3 text-xs text-muted leading-snug">
          Breakout, momentum and the funds don't trade Indian stocks, so there are no slots here.
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 mt-3.5">
        <div className="bg-inset rounded-[14px] px-3 py-2.5 min-w-0">
          <div className="text-[11px] text-muted">At most in trades</div>
          <div className="font-display text-xl tabular-nums mt-0.5" data-testid={`${market}-at-most`}>
            <RollingDigits text={rupees(atMost)} />
          </div>
          <div className="text-[11px] text-muted">
            {places} trade{places === 1 ? "" : "s"} at {rupees(mine.amountPerTradeInr)}
          </div>
        </div>
        <div className="bg-inset rounded-[14px] px-3 py-2.5 min-w-0">
          <div className="text-[11px] text-muted">If every stop hit</div>
          <div className="font-display text-xl tabular-nums mt-0.5 text-loss" data-testid={`${market}-if-stops-hit`}>
            <RollingDigits text={rupees(ifStopsHit)} />
          </div>
          <div className="text-[11px] text-muted">at most, before fees</div>
        </div>
      </div>
    </div>
  );
};

const MARKET_TABS = [
  { id: "coins", label: "Coins" },
  { id: "stocks", label: "India" },
  { id: "us", label: "US" },
] as const;
const MARKET_ORDER = MARKET_TABS.map((m) => m.id);
const MARKET_TITLE: Record<MarketKey, string> = { coins: "Coins", stocks: "Indian stocks", us: "US stocks" };

/** Each market's limits, one at a time. All three stay in the page; the one picked slides in. */
const LimitsCard: React.FC<{
  limits: MarketLimits;
  onChange: (next: MarketLimits) => void;
  isLive: boolean;
  liveCapInr?: number;
  positions?: { symbol: string; strategy?: string }[];
}> = ({ limits, onChange, isLive, liveCapInr, positions }) => {
  const [market, setMarket] = useState<MarketKey>("coins");
  const slide = useSlideFrom(market, MARKET_ORDER);
  const venue: Record<MarketKey, string> = {
    coins: "CoinDCX",
    stocks: isLive ? "Angel One · paper only for now" : "Angel One",
    us: "Alpaca · paper only · prices in ₹",
  };
  return (
    <div className="py-3.5 flex flex-col gap-2">
      <Segmented options={MARKET_TABS} value={market} onChange={setMarket} label="Market" />
      {MARKET_ORDER.map((m) => (
        <div key={m} hidden={m !== market} data-testid={`limits-${m}`} className={m === market ? slide : undefined}>
          <MarketLimitRows
            market={m}
            title={MARKET_TITLE[m]}
            venue={venue[m]}
            limits={limits}
            onChange={onChange}
            liveCapInr={m === "coins" ? liveCapInr : undefined}
            positions={positions}
          />
        </div>
      ))}
    </div>
  );
};

/** One connection: its initials on a tile with a status dot (pulsing while connected), what it does, and where it stands. */
const Connection: React.FC<{
  initials: string;
  name: string;
  sub: React.ReactNode;
  tone: "connected" | "ready" | "off" | "problem" | "checking";
  children?: React.ReactNode;
}> = ({ initials, name, sub, tone, children }) => (
  <div className="flex items-center gap-3 min-h-16 py-2.5">
    <span aria-hidden="true" className="relative w-10 h-10 shrink-0 rounded-xl bg-accent-soft text-accent text-xs font-bold tracking-[0.02em] flex items-center justify-center">
      {initials}
      <span className="absolute -right-0.5 -bottom-0.5 w-3 h-3">
        {tone === "connected" && <span className="absolute inset-0 rounded-full bg-gain nx-ring" />}
        <span
          data-testid={`${name} dot`}
          className={`absolute inset-0 rounded-full border-2 border-surface ${
            tone === "connected" || tone === "ready" ? "bg-gain" : tone === "problem" ? "bg-warn" : "bg-line"
          }`}
        />
      </span>
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-sm font-semibold">{name}</span>
      <span className="block text-xs text-muted leading-snug">{sub}</span>
    </span>
    <span className="shrink-0 flex items-center gap-1 text-[13px] font-semibold">{children}</span>
  </div>
);

/** A status in words, coloured by how it stands. */
const StatusWord: React.FC<{ tone: string; children: React.ReactNode }> = ({ tone, children }) => <span className={tone}>{children}</span>;

/** A small round-ended button at the end of a connection's row. */
const pillButton = "min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer disabled:opacity-60 inline-flex items-center gap-1.5";

/**
 * The server at a glance: a tile each, its state in a word and a dot. A tap
 * opens a tile across the row with the details; one with a problem stays open.
 */
const ServerTiles: React.FC<{ tiles: { id: string; label: string; value: string; detail: string; tone: string }[] }> = ({ tiles }) => {
  const [open, setOpen] = useState<string | null>(null);
  return (
    // Dense, so a tile opened across the row doesn't leave a hole before it.
    <div className="grid grid-cols-2 grid-flow-row-dense gap-2">
      {tiles.map((t) => {
        const problem = t.tone === "text-warn" || t.tone === "text-loss";
        const wide = problem || open === t.id;
        return (
          <button
            key={t.id}
            type="button"
            aria-expanded={wide}
            onClick={() => !problem && setOpen((o) => (o === t.id ? null : t.id))}
            data-testid={`server-${t.id}`}
            className={`min-w-0 text-left bg-surface border rounded-[18px] px-3.5 py-3 flex flex-col gap-1 cursor-pointer transition-colors ${wide ? "col-span-2" : ""} ${
              open === t.id ? "border-accent" : "border-line"
            }`}
          >
            <span className="flex items-center justify-between gap-1.5">
              <span className="text-xs text-muted">{t.label}</span>
              <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full ${dotFor(t.tone)}`} />
            </span>
            <span className={`font-display text-lg tabular-nums truncate ${problem ? t.tone : ""}`}>{t.value}</span>
            <span className={`nx-fold${wide ? " nx-fold-open" : ""}`}>
              <span>
                <span className="block pt-1 text-xs text-muted leading-relaxed">{t.detail}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
};

/** Which build this is, and a button to look for a newer one (it installs and reloads by itself). */
const AppVersionCard: React.FC<{ delay: number }> = ({ delay }) => {
  const [state, setState] = useState<"idle" | "checking" | UpdateCheck>("idle");
  const sub =
    state === "checking"
      ? "Checking…"
      : state === "updating"
      ? "New version found · the app reloads in a moment"
      : state === "latest"
      ? "You're on the latest version"
      : state === "unavailable"
      ? "Couldn't check right now"
      : `Built ${builtAtText()}`;
  return (
    <Group label="Version" delay={delay} className="px-4 py-3.5 flex items-center gap-3">
      <span aria-hidden="true" className="w-10 h-10 shrink-0 rounded-xl bg-accent text-on-accent font-display text-lg font-semibold flex items-center justify-center">
        N
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold">Version</span>
        <span className="block text-xs text-muted">{sub}</span>
      </span>
      <button
        type="button"
        disabled={state === "checking" || state === "updating"}
        onClick={async () => {
          setState("checking");
          setState(await checkForUpdate(true));
        }}
        className={`min-h-[38px] px-3.5 shrink-0 rounded-full text-[13px] font-bold cursor-pointer inline-flex items-center gap-1.5 transition-colors disabled:cursor-default ${
          state === "latest" ? "bg-gain-soft text-gain" : "bg-accent-soft text-accent"
        }`}
      >
        {state === "checking" || state === "updating" ? (
          <>
            <RefreshCw className="w-3.5 h-3.5 motion-safe:animate-spin" />
            {state === "checking" ? "Checking…" : "Updating…"}
          </>
        ) : state === "latest" ? (
          <span key="latest" className="nx-tick-in inline-flex items-center gap-1">
            <Check className="w-3.5 h-3.5" strokeWidth={2.6} />
            Up to date
          </span>
        ) : state === "unavailable" ? (
          "Try again"
        ) : (
          "Check for updates"
        )}
      </button>
    </Group>
  );
};

const LinkRow: React.FC<{ label: string; sub?: string; icon: React.ReactNode; onClick: () => void }> = ({ label, sub, icon, onClick }) => (
  <button type="button" onClick={onClick} className="w-full flex items-center gap-3 min-h-[60px] py-2 border-t border-line first:border-t-0 text-left cursor-pointer">
    <span aria-hidden="true" className="w-9 h-9 shrink-0 rounded-[11px] bg-inset text-ink flex items-center justify-center">
      {icon}
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-sm font-semibold">{label}</span>
      {sub && <span className="block text-xs text-muted">{sub}</span>}
    </span>
    <ChevronRight className="w-4 h-4 text-muted shrink-0" />
  </button>
);

export const SettingsSheet: React.FC<SettingsSheetProps> = (props) => {
  const { currentUser, logout } = useAuth();
  const pwa = usePWAInstall();
  const [confirmLive, setConfirmLive] = useState(false);
  // Live tapped while it's locked: it shakes (a or b, so each tap plays again) and says why.
  const [shake, setShake] = useState(0);
  // A new paper amount picked, waiting for a hold; the last one, kept for the fold while it closes; the one just started.
  const [paperPick, setPaperPick] = useState<number | null>(null);
  const [lastPick, setLastPick] = useState<number | null>(null);
  const [restarted, setRestarted] = useState<number | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const telegram = useTelegramLink(props.isOpen);
  // Opens as a circle from the gear (and closes back into it); without the
  // gear's place, or with reduced motion, it rises and fades as before.
  const origin = props.from ?? null;
  const circle = !!origin && !prefersReducedMotion();
  const presence = usePresence(props.isOpen, circle ? 320 : 220);
  // The money rolls up from zeros once the page has opened.
  const shown = useShown(300);

  useEffect(() => {
    if (!props.isOpen) {
      setConfirmLive(false);
      setShake(0);
      setPaperPick(null);
      setRestarted(null);
      setTestOpen(false);
    }
  }, [props.isOpen]);

  useEffect(() => {
    if (!props.isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.isOpen, props.onClose]);

  useEffect(() => {
    if (restarted === null) return;
    const t = setTimeout(() => setRestarted(null), 4000);
    return () => clearTimeout(t);
  }, [restarted]);

  if (!presence.mounted) return null;

  const isLive = props.tradingMode === "LIVE_COINDCX";
  const status = props.coinDcxStatus;
  const liveRisk = status?.liveRisk;
  // Live stays locked until the server takes live orders (LIVE_TRADING_ENABLED): the owner sets that before going live.
  const liveLocked = !isLive && liveRisk?.enabled !== true;

  const pickMode = (mode: TradingExecutionMode) => {
    if (mode === props.tradingMode) return;
    if (mode === "LIVE_COINDCX" && liveLocked) {
      setShake((n) => n + 1);
      return;
    }
    if (mode === "LIVE_COINDCX" && !confirmLive) {
      setConfirmLive(true);
      return;
    }
    setConfirmLive(false);
    props.onTradingModeChange(mode);
  };

  const pickPaper = (v: number) => {
    setRestarted(null);
    if (paperPick === v || v === props.paperMoney?.start) {
      setPaperPick(null);
      return;
    }
    setPaperPick(v);
    setLastPick(v);
  };

  const server = props.serverStatus ?? null;
  const backup = backupSummary(server);
  const dcxCheck = coinDcxCheckSummary(server);
  const errors = errorReportsSummary(server);
  const reviewer = reviewerSummary(server);
  const equity = props.paperMoney ? rupees(props.paperMoney.equity) : "";
  const limitText = rupees(props.dailyLossLimit);
  const lossShare = props.todayLoss !== undefined && props.dailyLossLimit > 0 ? props.todayLoss / props.dailyLossLimit : 0;
  const shownPick = paperPick ?? lastPick;

  return (
    <>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className={`fixed inset-0 z-50 bg-canvas text-ink font-ui overflow-y-auto ${
        circle
          ? presence.leaving
            ? "nx-circle-out pointer-events-none"
            : "nx-circle-in"
          : presence.leaving
          ? "nx-page-out pointer-events-none"
          : "nx-page-in"
      }`}
      style={
        circle && origin
          ? ({ "--nx-ox": `${origin.left + origin.width / 2}px`, "--nx-oy": `${origin.top + origin.height / 2}px` } as React.CSSProperties)
          : undefined
      }
    >
      <div className="max-w-lg mx-auto px-5 pt-4 pb-10 flex flex-col gap-2.5">
        <header className="flex items-center justify-between gap-3 min-h-11">
          <div className="min-w-0">
            <h1 className="m-0 font-display text-[26px] font-semibold">Settings</h1>
            <div className="text-[13px] text-muted truncate">
              {currentUser?.email ? `Signed in as ${currentUser.email}` : "Not signed in"}
            </div>
          </div>
          {circle ? (
            // The ✕ sits on the gear's spot (below), fixed there while the page scrolls.
            <span className="w-11 h-11 shrink-0" aria-hidden="true" />
          ) : (
            <RoundIconButton label="Close settings" onClick={props.onClose}>
              <X className="w-[18px] h-[18px]" strokeWidth={1.6} />
            </RoundIconButton>
          )}
        </header>

        <Label delay={80}>Trading</Label>
        <Group label="Trading" delay={80}>
          <div className="py-3 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Mode</span>
                <span className="block text-xs text-muted">{isLive ? "Orders go to CoinDCX" : "Orders stay in the paper book"}</span>
              </span>
              <div className="relative grid grid-cols-2 p-[3px] rounded-full bg-inset border border-line shrink-0" role="group" aria-label="Trading mode">
                {/* The pill slides across, blue for Paper, amber for Live. */}
                <span
                  aria-hidden="true"
                  data-testid="mode-pill"
                  className={`nx-mode-pill absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-full ${isLive ? "bg-warn" : "bg-accent"}`}
                  style={{ transform: `translateX(${isLive ? 100 : 0}%)` }}
                />
                {(["PAPER", "LIVE_COINDCX"] as const).map((m) => {
                  const on = props.tradingMode === m;
                  const locked = m === "LIVE_COINDCX" && liveLocked;
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={on}
                      onClick={() => pickMode(m)}
                      data-testid={m === "LIVE_COINDCX" ? "mode-live" : "mode-paper"}
                      className={`relative min-h-9 min-w-[76px] px-3 rounded-full text-[13px] font-semibold cursor-pointer transition-colors inline-flex items-center justify-center gap-1 ${
                        on ? "text-on-accent" : "text-muted"
                      } ${locked && shake > 0 ? (shake % 2 ? "nx-shake-a" : "nx-shake-b") : ""}`}
                    >
                      {locked && <Lock aria-hidden="true" className="w-3 h-3" strokeWidth={2.4} />}
                      {m === "PAPER" ? "Paper" : "Live"}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className={`nx-fold${liveLocked && shake > 0 ? " nx-fold-open" : ""}`} inert={!(liveLocked && shake > 0)}>
              <div>
                <div role="status" data-testid="live-locked" className="flex gap-2.5 px-3 py-2.5 rounded-[14px] bg-warn-soft text-warn-ink text-xs leading-relaxed">
                  <Lock aria-hidden="true" className="w-4 h-4 shrink-0 mt-px" strokeWidth={2} />
                  <span>
                    Live trading stays off until you say so.{" "}
                    {liveRisk
                      ? "The server blocks live orders until LIVE_TRADING_ENABLED is set (docs/going-live.md)."
                      : "The server hasn't said yet whether it takes live orders."}
                  </span>
                </div>
              </div>
            </div>
            {isLive && (
              <div className="nx-drop-down px-3 py-2.5 rounded-[14px] bg-warn-soft text-warn-ink text-xs leading-relaxed">
                Real orders on CoinDCX from now on, within your limits.
              </div>
            )}
            {confirmLive && (
              <div className="nx-drop-down px-3 py-2.5 rounded-[14px] bg-warn-soft text-warn-ink text-xs leading-relaxed">
                Live mode sends real orders to CoinDCX with your money.{" "}
                <button type="button" onClick={() => pickMode("LIVE_COINDCX")} className="font-semibold underline cursor-pointer">
                  Switch to live
                </button>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span>Live orders on the server · set by LIVE_TRADING_ENABLED</span>
              <span className={`inline-flex items-center gap-1.5 font-semibold shrink-0 ${liveRisk?.enabled ? "text-warn" : ""}`}>
                <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full ${liveRisk?.enabled ? "bg-warn" : "bg-muted"}`} />
                {liveRisk ? (liveRisk.enabled ? "Allowed" : "Blocked") : "Unknown"}
              </span>
            </div>
            {typeof liveRisk?.maxOrderNotionalInr === "number" && (
              <div className="flex items-center justify-between gap-3 text-xs text-muted">
                <span>
                  Server cap per live order · {rupees(liveRisk.maxDailyNotionalInr)} a day · {liveRisk.maxDailyOrders} orders
                </span>
                <span className="font-semibold text-ink tabular-nums shrink-0">{rupees(liveRisk.maxOrderNotionalInr)}</span>
              </div>
            )}
          </div>

          {!isLive && props.paperMoney && (
            <div className="py-3.5 border-t border-line flex flex-col gap-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">Paper money</span>
                <span className="text-xs text-muted">pick one to start again at</span>
              </div>
              <div className="font-display text-[34px] leading-none tabular-nums" data-testid="paper-equity">
                <RollingDigits text={shown ? equity : zeroed(equity)} />
              </div>
              <div role="group" aria-label="Start again at" className="flex gap-1.5">
                {withCurrent(PAPER_MONEY_CHOICES, props.paperMoney.start).map((v) => {
                  const picked = paperPick === v;
                  const current = props.paperMoney!.start === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={picked}
                      aria-label={`Start again at ${rupees(v)}${current ? " (the start now)" : ""}`}
                      onClick={() => pickPaper(v)}
                      className={`flex-1 min-w-0 min-h-9 rounded-xl border text-[13px] font-bold tabular-nums cursor-pointer transition-[transform,background-color,color] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                        picked ? "bg-accent text-on-accent border-transparent scale-105" : current ? "bg-inset text-accent border-accent" : "bg-inset text-ink border-transparent"
                      }`}
                    >
                      {shortRupees(v)}
                    </button>
                  );
                })}
              </div>
              <div className={`nx-fold${paperPick !== null ? " nx-fold-open" : ""}`} inert={paperPick === null} data-testid="paper-money-confirm">
                <div>
                  <HoldButton
                    label={`Hold to start again at ${rupees(shownPick ?? 0)}`}
                    keepHoldingLabel="Keep holding to start again"
                    onHold={() => {
                      if (paperPick === null) return;
                      props.paperMoney!.onRestart(paperPick);
                      setRestarted(paperPick);
                      setPaperPick(null);
                    }}
                    className="w-full min-h-12 mt-0.5 rounded-[14px] border-[1.5px] border-accent text-accent text-sm font-bold"
                    fillClassName="bg-accent-soft"
                  />
                  <p className="m-0 mt-2 text-xs text-muted leading-relaxed">
                    Starts the paper balance again at {rupees(shownPick ?? 0)}, and the all-time P&L from zero. Trades, records and open trades
                    stay, and today's result still counts. Set each market's amount and most to lose per trade below to match.
                  </p>
                </div>
              </div>
              {restarted !== null && (
                <div role="status" className="nx-badge-pop flex items-center gap-2 px-3 py-2 rounded-xl bg-gain-soft text-gain text-[13px] font-semibold">
                  <Check aria-hidden="true" className="w-4 h-4" strokeWidth={2.4} />
                  Started again at {rupees(restarted)}
                </div>
              )}
            </div>
          )}

          <div className="py-3.5 border-t border-line flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold">Daily loss limit</span>
              <span className="font-display text-xl tabular-nums" data-testid="loss-limit">
                <RollingDigits text={shown ? limitText : zeroed(limitText)} />
              </span>
            </div>
            {props.todayLoss !== undefined && (
              <>
                <div className="h-2.5 rounded-full bg-inset overflow-hidden" data-testid="loss-used">
                  <GrowBar fraction={shown ? lossShare : 0} className="bg-loss" delayMs={200} />
                </div>
                <div className="flex justify-between gap-2 text-xs text-muted tabular-nums">
                  <span>Lost today {rupees(props.todayLoss)}</span>
                  <span>{rupees(Math.max(0, props.dailyLossLimit - props.todayLoss))} left</span>
                </div>
              </>
            )}
            <div className="text-xs text-muted leading-snug">2.5% of your money, at least ₹2,500: no new trades once a day loses this.</div>
          </div>
        </Group>

        <Label delay={140}>Your limits</Label>
        <Group label="Your limits" delay={140}>
          <LimitsCard
            limits={props.riskLimits.marketLimits}
            onChange={(marketLimits) => props.onRiskLimitsChange({ marketLimits })}
            isLive={isLive}
            liveCapInr={isLive && typeof liveRisk?.maxOrderNotionalInr === "number" ? liveRisk.maxOrderNotionalInr : undefined}
            positions={props.positions}
          />
        </Group>

        <Label delay={200}>Connections</Label>
        <Group label="Connections" delay={200} className="px-4 [&>*+*]:border-t [&>*+*]:border-line">
          <div>
            <Connection
              initials="DCX"
              name="CoinDCX"
              tone={status?.configured ? "connected" : status ? "off" : "checking"}
              sub={
                status?.configured
                  ? props.coinDcxBalance.totalInr > 0
                    ? `${formatMoney(props.coinDcxBalance.totalInr)} · key ${status.keyMasked ?? ""}`
                    : `Key ${status.keyMasked ?? ""}`
                  : "Add API keys on the server"
              }
            >
              {status?.configured ? (
                <>
                  <StatusWord tone="text-gain">Connected</StatusWord>
                  <button
                    type="button"
                    aria-label="Refresh CoinDCX balance"
                    onClick={props.onRefreshBalance}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:bg-inset cursor-pointer"
                  >
                    <RefreshCw className={`w-4 h-4 ${props.coinDcxBalance.loading ? "animate-spin" : ""}`} />
                  </button>
                  <button
                    type="button"
                    aria-label="Test live order"
                    aria-expanded={testOpen}
                    onClick={() => setTestOpen((o) => !o)}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-muted hover:bg-inset cursor-pointer"
                  >
                    <ChevronDown className={`w-4 h-4 nx-chevron${testOpen ? " nx-chevron-open" : ""}`} />
                  </button>
                </>
              ) : status ? (
                <StatusWord tone="text-muted">Not set up</StatusWord>
              ) : (
                <Checking />
              )}
            </Connection>
            {status?.configured && (
              <div className={`nx-fold${testOpen ? " nx-fold-open" : ""}`} inert={!testOpen} data-testid="live-test-fold">
                <div>
                  <div className="mb-3 px-3 rounded-[14px] bg-inset">
                    <LiveTestCard active={props.isOpen && testOpen} />
                  </div>
                </div>
              </div>
            )}
          </div>
          <Connection
            initials="A"
            name="Alpaca"
            tone={!server ? "checking" : !server.alpaca?.configured ? "off" : server.alpaca.lastError ? "problem" : server.alpaca.accountStatus === "ACTIVE" ? "connected" : "ready"}
            sub={
              !server?.alpaca?.configured
                ? "US stocks (paper): add ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY on the server"
                : server.alpaca.lastError ??
                  `${
                    usTakesEntries()
                      ? "Scanning now, until 3:30 New York time"
                      : "Market closed · scans 9:30–3:30 New York time (7:00 pm–1:00 am IST, 8:00 pm–2:00 am in winter)"
                  }${server.fx ? ` · $1 = ${formatMoney(server.fx.usdInr)}` : ""}`
            }
          >
            {!server ? (
              <Checking />
            ) : !server.alpaca?.configured ? (
              <StatusWord tone="text-muted">Not set up</StatusWord>
            ) : server.alpaca.lastError ? (
              <StatusWord tone="text-warn">Problem</StatusWord>
            ) : server.alpaca.accountStatus === "ACTIVE" ? (
              <StatusWord tone="text-gain">Connected</StatusWord>
            ) : (
              <StatusWord tone="text-gain">Ready</StatusWord>
            )}
          </Connection>
          <Connection
            initials="AO"
            name="Angel One"
            tone={!server ? "checking" : !server.angelOne?.configured ? "off" : server.angelOne.lastError ? "problem" : server.angelOne.loggedIn ? "connected" : "ready"}
            sub={
              !server?.angelOne?.configured
                ? "Indian stocks: add the ANGEL_* settings on the server (see docs/hosting.md)"
                : server.angelOne.lastError ??
                  (nseTakesEntries()
                    ? `Scanning now, until 3:00 IST · Nifty 50, ${server.angelOne.stocksKnown} found`
                    : "Market closed · scans the Nifty 50 from 9:15 to 3:00 IST on weekdays")
            }
          >
            {!server ? (
              <Checking />
            ) : !server.angelOne?.configured ? (
              <StatusWord tone="text-muted">Not set up</StatusWord>
            ) : server.angelOne.lastError ? (
              <StatusWord tone="text-warn">Problem</StatusWord>
            ) : server.angelOne.loggedIn ? (
              <StatusWord tone="text-gain">Connected</StatusWord>
            ) : (
              <StatusWord tone="text-gain">Ready</StatusWord>
            )}
          </Connection>
          <Connection
            initials="G"
            name="Gemini reviewer"
            tone={
              reviewer.badge === "checking"
                ? "checking"
                : reviewer.badge === "off"
                ? "off"
                : reviewer.badge === "problem" || reviewer.badge === "limit"
                ? "problem"
                : reviewer.badge === "working"
                ? "connected"
                : "ready"
            }
            sub={reviewer.sub}
          >
            {reviewer.badge === "checking" ? (
              <Checking />
            ) : reviewer.badge === "off" ? (
              <StatusWord tone="text-muted">Not set up</StatusWord>
            ) : reviewer.badge === "problem" ? (
              <StatusWord tone="text-warn">Problem</StatusWord>
            ) : reviewer.badge === "limit" ? (
              <StatusWord tone="text-warn">Limit reached</StatusWord>
            ) : reviewer.badge === "working" ? (
              <StatusWord tone="text-gain">Connected</StatusWord>
            ) : (
              <StatusWord tone="text-gain">Ready</StatusWord>
            )}
          </Connection>
          {telegram.state !== null && (
            <Connection
              initials="TG"
              name="Telegram"
              tone={!telegram.state ? "checking" : telegram.state.linked ? "connected" : "off"}
              sub={
                telegram.note ??
                (!telegram.state || !telegram.state.configured ? (
                  "Every pop-up in Telegram too: make a bot with @BotFather, then set TELEGRAM_BOT_TOKEN on the server (docs/hosting.md)"
                ) : telegram.state.linked ? (
                  <>
                    Linked: every pop-up comes here too ·{" "}
                    <button type="button" onClick={() => void telegram.unlink()} disabled={telegram.busy} className="underline cursor-pointer text-muted">
                      Unlink
                    </button>
                  </>
                ) : telegram.url ? (
                  "Tap Start in Telegram to finish linking…"
                ) : (
                  "Every pop-up in Telegram too, so none is missed"
                ))
              }
            >
              {!telegram.state ? (
                <Checking />
              ) : !telegram.state.configured ? (
                <StatusWord tone="text-muted">Not set up</StatusWord>
              ) : telegram.state.linked ? (
                <button type="button" onClick={() => void telegram.test()} disabled={telegram.busy} className={pillButton}>
                  Test
                </button>
              ) : telegram.url ? (
                <a href={telegram.url} target="_blank" rel="noopener noreferrer" className={`${pillButton} border-accent text-accent no-underline`}>
                  Open Telegram
                </a>
              ) : (
                <button type="button" onClick={() => void telegram.link()} disabled={telegram.busy} className={pillButton}>
                  Link
                </button>
              )}
            </Connection>
          )}
        </Group>

        <Label delay={260}>Server</Label>
        <section aria-label="Server" className="nx-step-in" style={{ animationDelay: "300ms" }}>
          <ServerTiles
            tiles={[
              {
                id: "uptime",
                label: "Running for",
                value: server ? formatSpan(server.uptimeSec * 1000) : "—",
                detail: "A restart resets this. On an always-on host it keeps growing.",
                tone: server ? "text-gain" : "text-muted",
              },
              {
                id: "scanning",
                label: "Scanning",
                value: props.scanLocation === "server" ? "On the server" : props.scanLocation === "browser" ? "In this browser" : "—",
                detail:
                  props.scanLocation === "server"
                    ? props.lastServerScanAt
                      ? `Last scan ${formatSpan(Date.now() - props.lastServerScanAt)} ago`
                      : "After every 5-minute candle"
                    : props.scanLocation === "browser"
                    ? "Only while this app is open"
                    : "Checking…",
                tone: props.scanLocation === "server" ? "text-gain" : "text-muted",
              },
              { id: "backups", label: "Backups", value: backup.badge, detail: backup.sub, tone: backup.tone },
              { id: "coindcx", label: "CoinDCX check", value: dcxCheck.badge, detail: dcxCheck.sub, tone: dcxCheck.tone },
              { id: "errors", label: "Error reports", value: errors.badge, detail: errors.sub, tone: errors.tone },
              {
                id: "state",
                label: "Saved state",
                value: server ? (server.storage.kept ? "Kept" : "Lost on restart") : "—",
                detail: server?.storage.note ?? "Guardian positions, settings and tracked setups",
                tone: server ? (server.storage.kept ? "text-gain" : "text-warn") : "text-muted",
              },
            ]}
          />
        </section>

        {(props.notifications || (props.theme && props.onThemeChange)) && (
          <>
            <Label delay={320}>Pop-ups and look</Label>
            <Group label="Pop-ups and look" delay={320} className="px-4 [&>*+*]:border-t [&>*+*]:border-line">
              {props.notifications && (
                <div className="flex items-center gap-3 min-h-16 py-2.5">
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold">Trade pop-ups</span>
                    <span className="block text-xs text-muted leading-snug">
                      {props.notifications.error ||
                        {
                          unsupported: "This browser can't show them. On iPhone, add the app to your home screen first.",
                          blocked: "Blocked for this site: allow notifications in your browser's site settings.",
                          off: "A pop-up on this phone when a trade opens, even with the app closed",
                          on: "On for this phone: a pop-up when a trade opens, even with the app closed",
                          working: "Checking…",
                        }[props.notifications.state]}
                    </span>
                  </span>
                  <Switch
                    checked={props.notifications.state === "on"}
                    onChange={(on) => (on ? props.notifications!.enable() : props.notifications!.disable())}
                    label="Trade pop-ups"
                    disabled={["unsupported", "blocked", "working"].includes(props.notifications.state)}
                  />
                </div>
              )}
              {props.theme && props.onThemeChange && (
                <div className="py-3.5">
                  <div className="text-sm font-semibold">Theme</div>
                  <div className="text-xs text-muted">On this phone. Your other devices keep their own.</div>
                  <div className="relative grid grid-cols-3 gap-2.5 mt-3" role="group" aria-label="Theme">
                    {/* One ring that slides to the picked theme; its tick pops in each time. */}
                    <span
                      aria-hidden="true"
                      data-testid="theme-ring"
                      className="nx-segment-pill absolute top-0 left-0 h-full rounded-[16px] border-2 border-accent pointer-events-none z-10"
                      style={{
                        viewTransitionName: "nx-theme-ring",
                        width: "calc((100% - 20px) / 3)",
                        transform: `translateX(calc(${Math.max(0, THEMES.findIndex((t) => t.id === props.theme))} * (100% + 10px)))`,
                      }}
                    >
                      <span key={props.theme} className="nx-badge-pop absolute -top-1.5 -right-1.5 w-[22px] h-[22px] rounded-full bg-accent text-on-accent flex items-center justify-center">
                        <Check className="w-3 h-3" strokeWidth={3} />
                      </span>
                    </span>
                    {THEMES.map((t) => {
                      const on = props.theme === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          aria-pressed={on}
                          aria-label={`${t.name} theme`}
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            props.onThemeChange!(t.id, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
                          }}
                          className="relative flex flex-col gap-1.5 p-1.5 rounded-[16px] border-2 border-transparent bg-surface text-left cursor-pointer"
                        >
                          {/* A little screen in the theme's colours: a title, a card, its accent. */}
                          <span aria-hidden="true" className="flex flex-col gap-1.5 h-[72px] rounded-[11px] p-2 border" style={{ background: t.swatch.canvas, borderColor: t.swatch.line }}>
                            <span className="block h-1.5 w-1/2 rounded-full" style={{ background: t.swatch.accent, opacity: 0.85 }} />
                            <span className="flex-1 flex items-end p-1.5 rounded-[7px] border" style={{ background: t.swatch.surface, borderColor: t.swatch.line }}>
                              <span className="block h-1.5 w-3/4 rounded-full" style={{ background: t.swatch.accent }} />
                            </span>
                          </span>
                          <span className="px-0.5">
                            <span className={`block text-xs font-semibold ${on ? "text-ink" : "text-muted"}`}>{t.name}</span>
                            <span className="block text-[11px] text-muted">{t.hint}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </Group>
          </>
        )}

        <Label delay={380}>Desk</Label>
        <Group label="Desk" delay={380}>
          <LinkRow label="Desk brief" sub="Ask the commander to explain the book" icon={<MessageSquare className="w-[17px] h-[17px]" strokeWidth={1.8} />} onClick={props.onOpenDeskBrief} />
          <LinkRow label="This phone" sub="Your account, recent activity and the memory's cloud copy" icon={<Smartphone className="w-[17px] h-[17px]" strokeWidth={1.8} />} onClick={props.onOpenPhone} />
          {pwa.isInstallable && !pwa.isInstalled && (
            <LinkRow label="Install the app" sub="Add Nexus Desk to your home screen" icon={<Download className="w-[17px] h-[17px]" strokeWidth={1.8} />} onClick={() => void pwa.install()} />
          )}
        </Group>

        <div className="mt-2">
          <AppVersionCard delay={420} />
        </div>

        {currentUser && (
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-2 min-h-12 rounded-full border border-line bg-surface text-loss font-semibold text-sm cursor-pointer"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
    {circle && origin && (
      <button
        type="button"
        aria-label="Close settings"
        onClick={props.onClose}
        className={`fixed z-[51] rounded-full border border-line bg-surface text-ink flex items-center justify-center cursor-pointer ${
          presence.leaving ? "nx-x-out pointer-events-none" : "nx-x-in"
        }`}
        style={{ left: origin.left, top: origin.top, width: origin.width, height: origin.height }}
      >
        <X className="w-[18px] h-[18px]" strokeWidth={1.6} />
      </button>
    )}
    </>
  );
};
