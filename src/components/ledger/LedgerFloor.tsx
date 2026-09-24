import React, { useEffect, useState } from "react";
import { Settings, Power, ShieldCheck, ShieldAlert, ChevronRight } from "lucide-react";
import type { Position } from "../../types";
import { useLiveTickers } from "../../hooks/useLiveTickers";
import { Card, RoundIconButton, SectionHeading, StatTile, Switch } from "./ui";
import { formatMoney, formatPct, formatPrice, pnlTone } from "./format";

export interface FloorTicker {
  symbol: string;
  price: number;
  changePercent: number;
}

export interface FloorScanSummary {
  analyzed: number;
  selected: number;
  rejected: number;
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
  /** Whether the server allows live orders at all (null until known). */
  liveTradingEnabled: boolean | null;
  /** Headline price for the status line. Omit to follow the live stream (ETH/INR). */
  ticker?: FloorTicker | null;
  pendingProposals: number;
  scan: FloorScanSummary;
  onOpenQueue: () => void;
  onOpenSettings: () => void;
}

function positionNote(p: Position): string {
  if (p.isLiveOrder) return "Live order on CoinDCX · guarded on the server";
  const isLong = p.direction === "LONG";
  const lockedIn = isLong ? p.stopLoss > p.entryPrice : p.stopLoss < p.entryPrice;
  if (p.trailActive && lockedIn) return `Trailing stop active · locked ${isLong ? "above" : "below"} entry`;
  if (p.trailActive) return "Trailing stop active";
  return "Guarded on the server if you close this tab";
}

const TickerText: React.FC<{ ticker: FloorTicker | null }> = ({ ticker }) =>
  ticker ? (
    <>
      {" · "}
      {ticker.symbol.split("/")[0]} {formatPrice(ticker.price)}{" "}
      <span className={pnlTone(ticker.changePercent)}>{formatPct(ticker.changePercent)}</span>
    </>
  ) : null;

// Subscribes to the price stream here, not in App, so a tick re-renders
// only this line.
const LiveTickerText: React.FC = () => {
  const tickers = useLiveTickers();
  const t = tickers.find((x) => x.symbol === "ETH/INR") ?? tickers.find((x) => x.symbol.endsWith("/INR"));
  return <TickerText ticker={t ? { symbol: t.symbol, price: t.price, changePercent: t.changePercent } : null} />;
};

const PositionRow: React.FC<{ position: Position; onClose: (p: Position) => void }> = ({ position: p, onClose }) => {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const tone = pnlTone(p.unrealizedPnl);
  return (
    <li className="flex flex-col gap-2 py-3.5 border-b border-line">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="text-base font-semibold">{p.symbol}</span>{" "}
          <span className="text-xs text-muted">
            {p.direction === "LONG" ? "Long" : "Short"} · {p.quantity}
          </span>
        </div>
        <div className={`font-display text-xl tabular-nums whitespace-nowrap ${tone}`}>
          {formatMoney(p.unrealizedPnl, { signed: true })}
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted tabular-nums">
        <span>Entry {formatPrice(p.entryPrice)}</span>
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

  const whole = formatMoney(Math.trunc(equity), { decimals: 0 });
  const paise = Math.abs(equity % 1).toFixed(2).slice(1); // ".96"
  const openPnl = positions.reduce((acc, p) => acc + (p.unrealizedPnl || 0), 0);

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
            className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isLive ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent"
            }`}
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
            Today <strong className={pnlTone(dailyPnl)}>{formatMoney(dailyPnl, { signed: true })}</strong>
          </span>
          <span>
            All time <strong className={pnlTone(allTimePnl)}>{formatMoney(allTimePnl, { signed: true })}</strong>
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
                ? "Approves trades within your limits"
                : "Off · you approve every trade"}
            </div>
          </div>
          <Switch checked={props.autopilotOn} onChange={props.onAutopilotChange} label="Autopilot" disabled={props.stopped} />
        </div>
        <div className="flex gap-2">
          <StatTile label="Exposure" value={`${(props.exposureFraction * 100).toFixed(1)}%`} />
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
              <span className={`text-[13px] tabular-nums ${pnlTone(openPnl)}`}>{formatMoney(openPnl, { signed: true })}</span>
            ) : undefined
          }
        />
        {positions.length === 0 ? (
          <p className="text-sm text-muted py-4 m-0 border-b border-line">
            No open positions. {props.autopilotOn ? "Autopilot will open trades that pass every check." : "Approved proposals appear here."}
          </p>
        ) : (
          <ul className="list-none m-0 p-0">
            {positions.map((p) => (
              <PositionRow key={p.id} position={p} onClose={props.onClosePosition} />
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
        <span className="tabular-nums">
          {guardianText}
          {liveText && ` · ${liveText}`}
          {props.ticker !== undefined ? <TickerText ticker={props.ticker} /> : <LiveTickerText />}
        </span>
      </div>

      <div className="text-xs text-muted tabular-nums">
        Scanner today: {props.scan.analyzed} checked · {props.scan.selected} proposed · {props.scan.rejected} skipped
      </div>
    </div>
  );
};
