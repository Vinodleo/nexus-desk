import React, { useEffect, useState } from "react";
import { X, RefreshCw, ChevronRight, Check } from "lucide-react";
import type { CoinDcxAccountBalance, CoinDcxServerStatus, TradingExecutionMode } from "../../types";
import type { ZerodhaStatus } from "../../hooks/useZerodhaConnection";
import { useAuth } from "../../context/AuthContext";
import { usePWAInstall } from "../../hooks/usePWAInstall";
import { RoundIconButton, Switch } from "./ui";
import type { NotifyState } from "../../hooks/useTradeNotifications";
import type { RiskLimits } from "../../hooks/useRiskPolicy";
import { AMOUNT_CHOICES, MAX_TRADES_CHOICES, type MarketKey, type MarketLimits } from "../../shared/marketLimits";
import { formatMoney } from "./format";
import type { ServerStatus } from "../../hooks/useServerStatus";
import { usePresence } from "./motion";
import { builtAtText, checkForUpdate, type UpdateCheck } from "../../services/appUpdates";
import { THEMES, type ThemeId } from "../../services/theme";

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
  zerodhaStatus: ZerodhaStatus;
  zerodhaError: string;
  onZerodhaConnect: () => void;
  dailyLossLimit: number;
  maxOpenPositions: number;
  riskLimits: RiskLimits;
  onRiskLimitsChange: (next: Partial<RiskLimits>) => void;
  onOpenDeskBrief: () => void;
  onOpenBackground: () => void;
  onOpenSecurity: () => void;
  /** The server's host status (null while loading or unreachable). */
  serverStatus?: ServerStatus | null;
  /** Where scanning runs, and when the server last scanned. */
  scanLocation?: "checking" | "server" | "browser";
  lastServerScanAt?: number;
  /** This device's colour theme, and choosing another. */
  theme?: ThemeId;
  onThemeChange?: (id: ThemeId) => void;
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

const selectClass =
  "min-h-9 rounded-full border border-line bg-surface px-3 text-[13px] font-semibold text-ink cursor-pointer";

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-xs font-semibold text-muted uppercase tracking-[0.08em] px-1">{children}</div>
);

const Group: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="bg-surface border border-line rounded-2xl px-3.5 [&>*:last-child]:border-b-0">{children}</div>
);

const Row: React.FC<{ label: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }> = ({ label, sub, children }) => (
  <div className="flex items-center justify-between gap-3 min-h-12 py-2 border-b border-line text-sm">
    <div className="min-w-0">
      <div>{label}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
    <div className="shrink-0 flex items-center gap-2 font-semibold tabular-nums">{children}</div>
  </div>
);

const LinkRow: React.FC<{ label: string; sub?: string; onClick: () => void }> = ({ label, sub, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full flex items-center justify-between gap-3 min-h-12 py-2 border-b border-line text-sm text-left cursor-pointer"
  >
    <span className="min-w-0">
      <span className="block">{label}</span>
      {sub && <span className="block text-xs text-muted mt-0.5">{sub}</span>}
    </span>
    <ChevronRight className="w-4 h-4 text-muted shrink-0" />
  </button>
);

/** Which build this is, and a button to look for a newer one (it installs and reloads by itself). */
const AppVersionRow: React.FC = () => {
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
      : "Updates install by themselves when the app is opened";
  return (
    <Row label={`Version · built ${builtAtText()}`} sub={sub}>
      <button
        type="button"
        disabled={state === "checking" || state === "updating"}
        onClick={async () => {
          setState("checking");
          setState(await checkForUpdate(true));
        }}
        className="min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer hover:bg-inset disabled:opacity-60"
      >
        Check for updates
      </button>
    </Row>
  );
};

/**
 * Amount per trade and trades open at once, for one market. Changeable any
 * time, paper or live; the server's autopilot uses them too.
 */
const MarketLimitRows: React.FC<{
  market: MarketKey;
  title: string;
  venue: string;
  limits: MarketLimits;
  onChange: (next: MarketLimits) => void;
  /** In Live mode, the server's cap per live order: a larger amount is flagged. */
  liveCapInr?: number;
}> = ({ market, title, venue, limits, onChange, liveCapInr }) => {
  const mine = limits[market];
  const set = (patch: Partial<MarketLimits[MarketKey]>) => onChange({ ...limits, [market]: { ...mine, ...patch } });
  const overCap = liveCapInr !== undefined && mine.amountPerTradeInr > liveCapInr;
  const withCurrent = (choices: number[], current: number) => (choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b));
  return (
    <>
      <Row
        label={`${title}: amount per trade`}
        sub={
          overCap ? (
            <span className="text-loss">
              Above the server's {formatMoney(liveCapInr!, { decimals: 0 })} cap per live order: live orders this size are refused
            </span>
          ) : (
            venue
          )
        }
      >
        <select
          aria-label={`${title}: amount per trade`}
          value={mine.amountPerTradeInr}
          onChange={(e) => set({ amountPerTradeInr: Number(e.target.value) })}
          className={selectClass}
        >
          {withCurrent(AMOUNT_CHOICES, mine.amountPerTradeInr).map((v) => (
            <option key={v} value={v}>
              {formatMoney(v, { decimals: 0 })}
            </option>
          ))}
        </select>
      </Row>
      <Row
        label={`${title}: trades at once`}
        sub={`Up to ${formatMoney(mine.amountPerTradeInr * mine.maxOpenTrades, { decimals: 0 })} in ${title.toLowerCase()} at a time`}
      >
        <select
          aria-label={`${title}: trades at once`}
          value={mine.maxOpenTrades}
          onChange={(e) => set({ maxOpenTrades: Number(e.target.value) })}
          className={selectClass}
        >
          {withCurrent(MAX_TRADES_CHOICES, mine.maxOpenTrades).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
};

export const SettingsSheet: React.FC<SettingsSheetProps> = (props) => {
  const { currentUser, userRole, logout } = useAuth();
  const pwa = usePWAInstall();
  const [confirmLive, setConfirmLive] = useState(false);
  // Slides up when opened and back down when closed.
  const presence = usePresence(props.isOpen);

  useEffect(() => {
    if (!props.isOpen) setConfirmLive(false);
  }, [props.isOpen]);

  useEffect(() => {
    if (!props.isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.isOpen, props.onClose]);

  if (!presence.mounted) return null;

  const isLive = props.tradingMode === "LIVE_COINDCX";
  const status = props.coinDcxStatus;
  const liveRisk = status?.liveRisk;

  const pickMode = (mode: TradingExecutionMode) => {
    if (mode === props.tradingMode) return;
    if (mode === "LIVE_COINDCX" && !confirmLive) {
      setConfirmLive(true);
      return;
    }
    setConfirmLive(false);
    props.onTradingModeChange(mode);
  };

  const zerodhaLabel =
    props.zerodhaStatus === "connected"
      ? "Connected"
      : props.zerodhaStatus === "connecting"
      ? "Connecting…"
      : props.zerodhaStatus === "error"
      ? "Try again"
      : "Connect";

  return (
    <div role="dialog" aria-modal="true" aria-label="Settings" className={`fixed inset-0 z-50 bg-canvas text-ink font-ui overflow-y-auto ${
        presence.leaving ? "nx-page-out pointer-events-none" : "nx-page-in"
      }`}>
      <div className="max-w-lg mx-auto px-5 pt-4 pb-10 flex flex-col gap-4">
        <header className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="m-0 font-display text-[26px] font-semibold">Settings</h1>
            <div className="text-[13px] text-muted truncate">
              {currentUser?.email ? `Signed in as ${currentUser.email}` : "Not signed in"}
            </div>
          </div>
          <RoundIconButton label="Close settings" onClick={props.onClose}>
            <X className="w-[18px] h-[18px]" strokeWidth={1.6} />
          </RoundIconButton>
        </header>

        <Label>Trading</Label>
        <Group>
          <Row label="Mode" sub={isLive ? "Orders go to CoinDCX" : "Orders stay in the paper book"}>
            <div className="flex p-0.5 rounded-full bg-inset border border-line" role="group" aria-label="Trading mode">
              {(["PAPER", "LIVE_COINDCX"] as const).map((m) => {
                const on = props.tradingMode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    onClick={() => pickMode(m)}
                    className={`min-h-9 px-3.5 rounded-full text-[13px] font-semibold cursor-pointer transition-colors ${
                      on ? (m === "PAPER" ? "bg-accent text-on-accent" : "bg-warn text-on-accent") : "text-muted"
                    }`}
                  >
                    {m === "PAPER" ? "Paper" : "Live"}
                  </button>
                );
              })}
            </div>
          </Row>
          {confirmLive && (
            <div className="py-3 border-b border-line text-xs leading-relaxed text-warn-ink bg-warn-soft -mx-3.5 px-3.5">
              Live mode sends real orders to CoinDCX with your money.{" "}
              {liveRisk && !liveRisk.enabled && "The server currently blocks live orders, so nothing will be sent until LIVE_TRADING_ENABLED is set. "}
              <button type="button" onClick={() => pickMode("LIVE_COINDCX")} className="font-semibold underline cursor-pointer">
                Switch to live
              </button>
            </div>
          )}
          <Row label="Live orders on server" sub="Set by LIVE_TRADING_ENABLED">
            <span className={liveRisk?.enabled ? "text-warn" : "text-muted"}>
              {liveRisk ? (liveRisk.enabled ? "Allowed" : "Blocked") : "Unknown"}
            </span>
          </Row>
          {typeof liveRisk?.maxOrderNotionalInr === "number" && (
            <Row label="Server cap per live order" sub={`${formatMoney(liveRisk.maxDailyNotionalInr, { decimals: 0 })} a day · ${liveRisk.maxDailyOrders} orders`}>
              <span>{formatMoney(liveRisk.maxOrderNotionalInr, { decimals: 0 })}</span>
            </Row>
          )}
          <MarketLimitRows
            market="coins"
            title="Coins"
            venue="CoinDCX"
            limits={props.riskLimits.marketLimits}
            onChange={(marketLimits) => props.onRiskLimitsChange({ marketLimits })}
            liveCapInr={isLive && typeof liveRisk?.maxOrderNotionalInr === "number" ? liveRisk.maxOrderNotionalInr : undefined}
          />
          <MarketLimitRows
            market="stocks"
            title="Indian stocks"
            venue={isLive ? "Angel One · paper only for now" : "Angel One"}
            limits={props.riskLimits.marketLimits}
            onChange={(marketLimits) => props.onRiskLimitsChange({ marketLimits })}
          />
          <MarketLimitRows
            market="us"
            title="US stocks"
            venue="Alpaca · paper only · prices in ₹"
            limits={props.riskLimits.marketLimits}
            onChange={(marketLimits) => props.onRiskLimitsChange({ marketLimits })}
          />
          <Row label="Daily loss limit">
            <span>{formatMoney(props.dailyLossLimit, { decimals: 0 })}</span>
          </Row>
        </Group>

        <Label>Connections</Label>
        <Group>
          <Row
            label="CoinDCX"
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
                <span className="text-gain">Connected</span>
                <button
                  type="button"
                  aria-label="Refresh CoinDCX balance"
                  onClick={props.onRefreshBalance}
                  className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:bg-inset cursor-pointer"
                >
                  <RefreshCw className={`w-4 h-4 ${props.coinDcxBalance.loading ? "animate-spin" : ""}`} />
                </button>
              </>
            ) : (
              <span className="text-muted">{status ? "Not set up" : "Checking…"}</span>
            )}
          </Row>
          <Row label="Zerodha Kite" sub={props.zerodhaStatus === "error" ? props.zerodhaError : "Indian equities"}>
            {props.zerodhaStatus === "connected" ? (
              <span className="text-gain">Connected</span>
            ) : (
              <button
                type="button"
                onClick={props.onZerodhaConnect}
                disabled={props.zerodhaStatus === "connecting"}
                className="min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer disabled:opacity-60"
              >
                {zerodhaLabel}
              </button>
            )}
          </Row>
        </Group>

        {props.notifications && (
          <>
            <Label>Notifications</Label>
            <Group>
              <Row
                label="Trade pop-ups"
                sub={
                  props.notifications.error ||
                  {
                    unsupported: "This browser can't show them. On iPhone, add the app to your home screen first.",
                    blocked: "Blocked for this site: allow notifications in your browser's site settings.",
                    off: "A pop-up on this phone when a trade opens, even with the app closed",
                    on: "On for this phone: a pop-up when a trade opens, even with the app closed",
                    working: "Checking…",
                  }[props.notifications.state]
                }
              >
                <Switch
                  checked={props.notifications.state === "on"}
                  onChange={(on) => (on ? props.notifications!.enable() : props.notifications!.disable())}
                  label="Trade pop-ups"
                  disabled={["unsupported", "blocked", "working"].includes(props.notifications.state)}
                />
              </Row>
            </Group>
          </>
        )}

        {props.theme && props.onThemeChange && (
          <>
            <Label>Appearance</Label>
            <Group>
              <div className="py-3">
                <div className="text-sm">Theme</div>
                <div className="text-xs text-muted mt-0.5">On this phone. Your other devices keep their own.</div>
                <div className="grid grid-cols-3 gap-2.5 mt-3" role="group" aria-label="Theme">
                  {THEMES.map((t) => {
                    const on = props.theme === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={on}
                        aria-label={`${t.name} theme`}
                        onClick={() => props.onThemeChange!(t.id)}
                        className={`relative flex flex-col gap-1.5 p-1.5 rounded-[14px] border-2 bg-surface text-left cursor-pointer transition-colors ${
                          on ? "border-accent" : "border-transparent"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="flex flex-col gap-1.5 h-14 rounded-[9px] p-2 border"
                          style={{ background: t.swatch.canvas, borderColor: t.swatch.line }}
                        >
                          <span className="block h-2 w-4/5 rounded-[3px] border" style={{ background: t.swatch.surface, borderColor: t.swatch.line }} />
                          <span className="block h-2 w-1/2 rounded-[3px] border" style={{ background: t.swatch.surface, borderColor: t.swatch.line }} />
                          <span className="block h-2 w-5 rounded-full" style={{ background: t.swatch.accent }} />
                        </span>
                        <span className="px-0.5">
                          <span className="block text-xs font-semibold">{t.name}</span>
                          <span className="block text-[11px] text-muted">{t.hint}</span>
                        </span>
                        {on && (
                          <span className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-accent text-on-accent flex items-center justify-center">
                            <Check className="w-3 h-3" strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Group>
          </>
        )}

        <Label>Server</Label>
        <Group>
          <Row label="Running for" sub="A restart resets this. On an always-on host it keeps growing.">
            <span>{props.serverStatus ? formatSpan(props.serverStatus.uptimeSec * 1000) : "—"}</span>
          </Row>
          <Row label="Saved state" sub={props.serverStatus?.storage.note ?? "Guardian positions, settings and tracked setups"}>
            {props.serverStatus ? (
              <span className={props.serverStatus.storage.kept ? "text-gain" : "text-warn"}>
                {props.serverStatus.storage.kept ? "Kept" : "Lost on restart"}
              </span>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Row>
          <Row
            label="Alpaca"
            sub={
              !props.serverStatus?.alpaca?.configured
                ? "US stocks (paper): add ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY on the server"
                : props.serverStatus.alpaca.lastError ??
                  `US stocks scanned 9:30–3:30 New York time (7:00 pm–1:00 am IST, 8:00 pm–2:00 am in winter)${
                    props.serverStatus.fx ? ` · $1 = ${formatMoney(props.serverStatus.fx.usdInr)}` : ""
                  }`
            }
          >
            {!props.serverStatus?.alpaca?.configured ? (
              <span className="text-muted">Not set up</span>
            ) : props.serverStatus.alpaca.lastError ? (
              <span className="text-warn">Problem</span>
            ) : (
              <span className="text-gain">{props.serverStatus.alpaca.accountStatus === "ACTIVE" ? "Connected" : "Ready"}</span>
            )}
          </Row>
          <Row
            label="Angel One"
            sub={
              !props.serverStatus?.angelOne?.configured
                ? "Indian stocks: add the ANGEL_* settings on the server (see docs/hosting.md)"
                : props.serverStatus.angelOne.lastError ??
                  (props.serverStatus.angelOne.loggedIn
                    ? `Nifty 50 stocks scanned 9:15–3:00 IST · ${props.serverStatus.angelOne.stocksKnown} found`
                    : "Logs in by itself when NSE opens")
            }
          >
            {!props.serverStatus?.angelOne?.configured ? (
              <span className="text-muted">Not set up</span>
            ) : props.serverStatus.angelOne.lastError ? (
              <span className="text-warn">Problem</span>
            ) : (
              <span className="text-gain">{props.serverStatus.angelOne.loggedIn ? "Connected" : "Ready"}</span>
            )}
          </Row>
          <Row
            label="Scanning"
            sub={
              props.scanLocation === "server"
                ? props.lastServerScanAt
                  ? `Last scan ${formatSpan(Date.now() - props.lastServerScanAt)} ago`
                  : "After every 5-minute candle"
                : props.scanLocation === "browser"
                ? "Only while this app is open"
                : "Checking…"
            }
          >
            <span className={props.scanLocation === "server" ? "text-gain" : "text-muted"}>
              {props.scanLocation === "server" ? "On the server" : props.scanLocation === "browser" ? "In this browser" : "—"}
            </span>
          </Row>
        </Group>

        <Label>Desk</Label>
        <Group>
          <LinkRow label="Desk brief" sub="Ask the commander to explain the book" onClick={props.onOpenDeskBrief} />
          <LinkRow label="Run in the background" sub="Keep this device awake while trading" onClick={props.onOpenBackground} />
          <LinkRow label="Security and access" sub={`Role: ${userRole}`} onClick={props.onOpenSecurity} />
          {pwa.isInstallable && !pwa.isInstalled && (
            <LinkRow label="Install the app" sub="Add Nexus Desk to your home screen" onClick={() => void pwa.install()} />
          )}
          <AppVersionRow />
        </Group>

        {currentUser && (
          <button
            type="button"
            onClick={() => void logout()}
            className="min-h-12 rounded-full border border-line bg-surface text-loss font-semibold text-sm cursor-pointer"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  );
};
