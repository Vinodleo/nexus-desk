import React, { useEffect, useState } from "react";
import { X, RefreshCw, ChevronRight } from "lucide-react";
import type { CoinDcxAccountBalance, CoinDcxServerStatus, TradingExecutionMode } from "../../types";
import type { ZerodhaStatus } from "../../hooks/useZerodhaConnection";
import { useAuth } from "../../context/AuthContext";
import { usePWAInstall } from "../../hooks/usePWAInstall";
import { RoundIconButton, Switch } from "./ui";
import type { NotifyState } from "../../hooks/useTradeNotifications";
import { EXPOSURE_CHOICES, ORDER_VALUE_CHOICES, type RiskLimits } from "../../hooks/useRiskPolicy";
import { formatMoney } from "./format";
import type { ServerStatus } from "../../hooks/useServerStatus";

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

export const SettingsSheet: React.FC<SettingsSheetProps> = (props) => {
  const { currentUser, userRole, logout } = useAuth();
  const pwa = usePWAInstall();
  const [confirmLive, setConfirmLive] = useState(false);

  useEffect(() => {
    if (!props.isOpen) setConfirmLive(false);
  }, [props.isOpen]);

  useEffect(() => {
    if (!props.isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.isOpen, props.onClose]);

  if (!props.isOpen) return null;

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
    <div role="dialog" aria-modal="true" aria-label="Settings" className="fixed inset-0 z-50 bg-canvas text-ink font-ui overflow-y-auto">
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
          <Row label="Largest trade" sub="Most money in any one position">
            <select
              aria-label="Largest trade"
              value={props.riskLimits.maxOrderValueInr}
              onChange={(e) => props.onRiskLimitsChange({ maxOrderValueInr: Number(e.target.value) })}
              className={selectClass}
            >
              {ORDER_VALUE_CHOICES.map((v) => (
                <option key={v} value={v}>
                  {formatMoney(v, { decimals: 0 })}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Most in open trades" sub="Share of your equity across all positions">
            <select
              aria-label="Most in open trades"
              value={props.riskLimits.maxAllowedExposureFraction}
              onChange={(e) => props.onRiskLimitsChange({ maxAllowedExposureFraction: Number(e.target.value) })}
              className={selectClass}
            >
              {EXPOSURE_CHOICES.map((v) => (
                <option key={v} value={v}>
                  {Math.round(v * 100)}%
                </option>
              ))}
            </select>
          </Row>
          <Row label="Daily loss limit">
            <span>{formatMoney(props.dailyLossLimit, { decimals: 0 })}</span>
          </Row>
          <Row label="Max open positions">
            <span>{props.maxOpenPositions}</span>
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
