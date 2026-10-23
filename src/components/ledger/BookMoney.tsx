import React from "react";
import type { HistoricalTrade } from "../../types";
import { marketOf } from "../../shared/marketLimits";
import { COIN_FEE_PER_SIDE } from "../../shared/tradeMath";
import { slowExitWords, strategyLabel } from "../../shared/tradeMessages";
import { Card } from "./ui";
import { EXIT_LABEL, formatMoney } from "./format";
import { RollingDigits } from "./motion";

// Book → Breakdown: where the money went (a waterfall from what the winners
// made, less what the losers lost and the fees, to what was kept), each
// strategy's result, and the win rate on a dial against the rate that
// breaks even.

/** What the period's trades made before fees (winners and losers apart), the fees, and what was kept. */
export function moneyFlow(trades: HistoricalTrade[]): { won: number; lost: number; fees: number; kept: number; coinFees: number } {
  let won = 0;
  let lost = 0;
  let fees = 0;
  let coinFees = 0;
  for (const t of trades) {
    const fee = t.feesPaid ?? 0;
    const gross = t.realizedPnl + fee;
    if (gross > 0) won += gross;
    else lost -= gross;
    fees += fee;
    if (marketOf(t.symbol) === "coins") coinFees += fee;
  }
  return { won, lost, fees, kept: won - lost - fees, coinFees };
}

const money = (n: number) => formatMoney(n, { decimals: 0 });
const pct = (n: number) => `${n.toFixed(2)}%`;

/** Won rises from zero, what was lost and the fees step it down, and what's kept stands from zero. */
export const MoneyWaterfall: React.FC<{ trades: HistoricalTrade[] }> = ({ trades }) => {
  if (trades.length === 0) return null;
  const f = moneyFlow(trades);
  const wins = trades.filter((t) => t.realizedPnl > 0).length;
  const lo = Math.min(0, f.kept, f.won - f.lost - f.fees);
  const hi = Math.max(f.won, 0, f.kept);
  const y = (v: number) => (hi > lo ? ((v - lo) / (hi - lo)) * 84 + 4 : 4);
  const keptTone = f.kept >= 0 ? "text-gain" : "text-loss";
  const steps = [
    { k: "Won", label: "Won before fees", from: 0, to: f.won, v: `+${money(f.won)}`, bar: "bg-gain", text: "text-gain" },
    { k: "Lost", label: "Lost before fees", from: f.won, to: f.won - f.lost, v: `−${money(f.lost)}`, bar: "bg-loss/75", text: "text-loss" },
    { k: "Fees", label: "Fees", from: f.won - f.lost, to: f.won - f.lost - f.fees, v: `−${money(f.fees)}`, bar: "bg-warn", text: "text-warn" },
    { k: "Kept", label: "Kept", from: 0, to: f.kept, v: formatMoney(f.kept, { signed: true, decimals: 0 }), bar: f.kept >= 0 ? "bg-accent" : "bg-loss", text: keptTone },
  ];
  const share = f.won > 0 ? Math.round((f.fees / f.won) * 100) : null;
  return (
    <Card aria-label="Where the money went" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">Where the money went</h2>
        <span className="text-xs text-muted">
          {trades.length} {trades.length === 1 ? "trade" : "trades"}, {wins} won
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-muted">Kept</span>
        <span data-testid="wf-kept-total" className={`font-display text-[30px] leading-tight tabular-nums ${keptTone}`}>
          <RollingDigits text={formatMoney(f.kept, { signed: true, decimals: 0 })} />
        </span>
      </div>
      <div className="relative h-[150px]" aria-hidden="true" data-testid="waterfall">
        <span className="absolute inset-x-0 h-0 border-t border-line nx-wf" style={{ bottom: pct(y(0)) }} />
        {steps.map((s, i) => {
          const down = s.to < s.from;
          return (
            <React.Fragment key={s.k}>
              <span
                data-testid={`wf-${s.k.toLowerCase()}`}
                className={`absolute w-[18%] rounded-lg nx-wf ${s.bar} ${down ? "nx-drop" : "nx-rise"}`}
                style={{
                  left: pct(i * 25 + 3.5),
                  bottom: pct(y(Math.min(s.from, s.to))),
                  height: pct(Math.max(0.8, Math.abs(y(s.to) - y(s.from)))),
                  animationDelay: `${150 + i * 160}ms`,
                }}
              />
              {i < 3 && (
                <span
                  className="absolute w-[7%] h-0 border-t-[1.5px] border-dashed border-muted/50 nx-wf nx-fade-in"
                  style={{ left: pct(i * 25 + 21.5), bottom: pct(y(s.to)), animationDelay: `${350 + i * 160}ms` }}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="grid grid-cols-4 gap-1 text-center tabular-nums">
        {steps.map((s) => (
          <div key={s.k}>
            <div className={`text-xs font-bold ${s.text}`}>{s.v}</div>
            <div className="text-[10px] text-muted leading-tight">{s.label}</div>
          </div>
        ))}
      </div>
      {share !== null && (
        <p className="m-0 text-xs text-muted leading-relaxed" data-testid="waterfall-words">
          Fees took {money(f.fees)}, {share}% of what the winners made before fees.
          {f.coinFees > 0 && ` Coin trades paid ${money(f.coinFees)} of them: CoinDCX takes ${(COIN_FEE_PER_SIDE * 100).toFixed(2)}% each way.`}
        </p>
      )}
    </Card>
  );
};

/** A closed trade's strategy, in words. */
export function strategyOf(t: Pick<HistoricalTrade, "strategy" | "symbol" | "timeframe">): string {
  return strategyLabel(t);
}

const BADGE: Record<string, string> = {
  "US breakout": "BO",
  "Funds breakout": "FD",
  "US momentum": "T3",
  "Coin breakout": "CB",
  "Daily traders": "1d",
  "5-minute traders": "5m",
};

/** A closed trade's strategy in two letters, for the Book's row badge. */
export const strategyBadge = (t: HistoricalTrade): string => BADGE[strategyOf(t)] ?? "5m";

/** How a closed trade ended, in words (a slower strategy's own sale in its own, as its pop-up says it). */
export function exitWords(t: Pick<HistoricalTrade, "exitReason" | "strategy">): string {
  return slowExitWords(t.exitReason, t.strategy) ?? EXIT_LABEL[t.exitReason] ?? t.exitReason;
}

/** Each strategy's result after fees, as bars either side of zero, the best first; they glide as the period changes. */
export const ByStrategy: React.FC<{ trades: HistoricalTrade[] }> = ({ trades }) => {
  const by = new Map<string, { net: number; count: number }>();
  for (const t of trades) {
    const k = strategyOf(t);
    const v = by.get(k) ?? { net: 0, count: 0 };
    by.set(k, { net: v.net + t.realizedPnl, count: v.count + 1 });
  }
  const rows = [...by.entries()].sort((a, b) => b[1].net - a[1].net);
  if (rows.length === 0) return null;
  const most = Math.max(1, ...rows.map(([, v]) => Math.abs(v.net)));
  return (
    <Card aria-label="By strategy" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">By strategy</h2>
        <span className="text-xs text-muted">after fees</span>
      </div>
      {rows.map(([name, v], i) => {
        // Half the track either side of the middle, the biggest result filling its half.
        const w = (Math.abs(v.net) / most) * 50;
        return (
          <div key={name} data-testid="strategy-row" className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-semibold">
                {name} <span className="font-normal text-muted">· {v.count} {v.count === 1 ? "trade" : "trades"}</span>
              </span>
              <span className={`font-bold tabular-nums ${v.net > 0 ? "text-gain" : v.net < 0 ? "text-loss" : "text-muted"}`}>
                {formatMoney(v.net, { signed: true, decimals: 0 })}
              </span>
            </div>
            <div className="relative h-2 rounded-full bg-inset" aria-hidden="true">
              <span className="absolute left-1/2 -top-[3px] -bottom-[3px] w-px bg-muted" />
              <span
                data-testid="strategy-bar"
                className={`absolute inset-y-0 rounded-full nx-glide-left ${v.net >= 0 ? "bg-gain nx-grow" : "bg-loss nx-grow-left"}`}
                style={{ left: pct(v.net >= 0 ? 50 : 50 - w), width: pct(w), animationDelay: `${i * 90}ms` }}
              />
            </div>
          </div>
        );
      })}
    </Card>
  );
};

const ARC = Math.PI * 90;
const turn = (p: number) => `rotate(${(Math.max(0, Math.min(100, p)) * 1.8 - 90).toFixed(1)}deg)`;

/**
 * The win rate on a half dial: the arc fills to it and the needle swings up
 * to it, with a mark at the rate that breaks even. Both glide as the period
 * changes.
 */
export const WinGauge: React.FC<{ winPct: number; breakEvenPct: number }> = ({ winPct, breakEvenPct }) => {
  const ahead = winPct >= breakEvenPct;
  const f = Math.max(0, Math.min(100, winPct)) / 100;
  return (
    <svg
      width="220"
      height="124"
      viewBox="0 0 220 124"
      role="meter"
      aria-label="Win rate against break-even"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={winPct}
      className="block overflow-visible"
    >
      <path d="M20 112 A90 90 0 0 1 200 112" fill="none" className="stroke-inset" strokeWidth="16" strokeLinecap="round" />
      <path
        data-testid="gauge-arc"
        d="M20 112 A90 90 0 0 1 200 112"
        fill="none"
        stroke={`var(--nx-${ahead ? "gain" : "loss"})`}
        strokeWidth="16"
        strokeLinecap="round"
        className="nx-arc"
        style={{ strokeDasharray: `${(f * ARC).toFixed(1)} 400` }}
      />
      <line
        data-testid="gauge-break-even"
        x1="110"
        y1="6"
        x2="110"
        y2="38"
        className="stroke-ink nx-mark"
        strokeWidth="2.5"
        strokeLinecap="round"
        style={{ transformOrigin: "110px 112px", transform: turn(breakEvenPct) }}
      />
      <g data-testid="gauge-needle" className="nx-needle" style={{ transformOrigin: "110px 112px", transform: turn(winPct) }}>
        <line x1="110" y1="112" x2="110" y2="40" className="stroke-ink" strokeWidth="3" strokeLinecap="round" />
      </g>
      <circle cx="110" cy="112" r="7" className="fill-ink" />
    </svg>
  );
};

/** The win rate card: the dial, the rate, and what breaks even with these wins and losses. */
export const WinRate: React.FC<{ winPct: number; breakEvenPct: number | null; avgWin: number; avgLoss: number; avgR: number | null }> = ({
  winPct,
  breakEvenPct,
  avgWin,
  avgLoss,
  avgR,
}) => (
  <Card aria-label="Win rate" className="flex flex-col items-center gap-1">
    <h2 className="m-0 self-start text-sm font-semibold">Win rate</h2>
    {breakEvenPct !== null && <WinGauge winPct={winPct} breakEvenPct={breakEvenPct} />}
    <div className="font-display text-[28px] tabular-nums" data-testid="win-rate">
      <RollingDigits text={`${winPct}%`} /> won
    </div>
    <p className="m-0 text-xs text-muted text-center leading-relaxed" data-testid="win-rate-note">
      {breakEvenPct !== null && `Breaks even at ${breakEvenPct}% with these wins and losses (the mark on the dial)${winPct >= breakEvenPct ? "" : ": the wins are too small for the losses"}. `}
      Average win {money(avgWin)}, average loss {money(avgLoss)}
      {avgR !== null ? `; ${avgR >= 0 ? "+" : "−"}${Math.abs(avgR).toFixed(2)}R a trade.` : "."}
    </p>
  </Card>
);
