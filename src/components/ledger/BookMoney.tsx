import React from "react";
import type { HistoricalTrade } from "../../types";
import { marketOf } from "../../shared/marketLimits";
import { isFundSymbol } from "../../shared/funds";
import { COIN_FEE_PER_SIDE } from "../../shared/tradeMath";
import { Card } from "./ui";
import { formatMoney } from "./format";

// Book → Breakdown: where the money went (a waterfall from what the winners
// made, less what the losers lost and the fees, to what was kept), each
// strategy's result, and the win rate on a gauge against the rate that
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
  const lo = Math.min(0, f.kept, f.won - f.lost - f.fees);
  const hi = Math.max(f.won, 0, f.kept);
  const y = (v: number) => (hi > lo ? ((v - lo) / (hi - lo)) * 84 + 4 : 4);
  const steps = [
    { k: "Won", from: 0, to: f.won, v: `+${money(f.won)}`, bar: "bg-gain", text: "text-gain" },
    { k: "Lost", from: f.won, to: f.won - f.lost, v: `−${money(f.lost)}`, bar: "bg-loss/75", text: "text-loss" },
    { k: "Fees", from: f.won - f.lost, to: f.won - f.lost - f.fees, v: `−${money(f.fees)}`, bar: "bg-warn", text: "text-warn" },
    {
      k: "Kept",
      from: 0,
      to: f.kept,
      v: formatMoney(f.kept, { signed: true, decimals: 0 }),
      bar: f.kept >= 0 ? "bg-accent" : "bg-loss",
      text: f.kept >= 0 ? "text-accent" : "text-loss",
    },
  ];
  const share = f.won > 0 ? Math.round((f.fees / f.won) * 100) : null;
  return (
    <Card aria-label="Where the money went" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">Where the money went</span>
        <span className="text-xs text-muted">
          {trades.length} {trades.length === 1 ? "trade" : "trades"}
        </span>
      </div>
      <div className="relative h-40 mt-1" aria-hidden="true" data-testid="waterfall">
        <span className="absolute inset-x-0 h-0 border-t-[1.5px] border-line nx-wf" style={{ bottom: pct(y(0)) }} />
        {steps.map((s, i) => {
          const down = s.to < s.from;
          const top = y(Math.max(s.from, s.to));
          return (
            <React.Fragment key={s.k}>
              <span
                data-testid={`wf-${s.k.toLowerCase()}`}
                className={`absolute w-[18%] rounded-lg nx-wf ${s.bar} ${down ? "nx-drop" : "nx-rise"}`}
                style={{
                  left: pct(i * 25 + 3.5),
                  bottom: pct(y(Math.min(s.from, s.to))),
                  height: pct(Math.max(0.8, Math.abs(y(s.to) - y(s.from)))),
                  animationDelay: `${150 + i * 220}ms`,
                }}
              />
              <span
                className={`absolute -translate-x-1/2 whitespace-nowrap text-[11px] font-bold tabular-nums nx-wf nx-fade-in ${s.text}`}
                style={{ left: pct(i * 25 + 12.5), bottom: pct(Math.min(90, top + 2)), animationDelay: `${400 + i * 220}ms` }}
              >
                {s.v}
              </span>
              {i < 3 && (
                <span
                  className="absolute w-[7%] h-0 border-t-[1.5px] border-dashed border-muted/50 nx-wf nx-fade-in"
                  style={{ left: pct(i * 25 + 21.5), bottom: pct(y(s.to)), animationDelay: `${350 + i * 220}ms` }}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="grid grid-cols-4 text-[11px] text-muted text-center" aria-hidden="true">
        {steps.map((s) => (
          <span key={s.k}>{s.k}</span>
        ))}
      </div>
      <p className="m-0 text-xs leading-relaxed" data-testid="waterfall-words">
        Winners made {money(f.won)} before fees, losers lost {money(f.lost)}, fees took {money(f.fees)}
        {share !== null ? ` (${share}% of what the winners made)` : ""}: {f.kept >= 0 ? "kept" : "down"} {money(Math.abs(f.kept))}.
        {f.coinFees > 0 && ` Coin trades paid ${money(f.coinFees)} of the fees: CoinDCX takes ${(COIN_FEE_PER_SIDE * 100).toFixed(2)}% each way.`}
      </p>
    </Card>
  );
};

/** A closed trade's strategy, in words. */
export function strategyOf(t: HistoricalTrade): string {
  if (t.strategy === "momentum") return "US momentum";
  if (t.strategy === "breakout") return isFundSymbol(t.symbol) ? "Funds breakout" : marketOf(t.symbol) === "coins" ? "Coin breakout" : "US breakout";
  if (t.timeframe === "1d") return "Daily traders";
  return "5-minute traders";
}

/** Each strategy's result after fees, as bars either side of zero, the best first. */
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
      <div className="text-sm font-semibold">By strategy, after fees</div>
      {rows.map(([name, v], i) => {
        const w = pct((Math.abs(v.net) / most) * 100);
        return (
          <div key={name} data-testid="strategy-row">
            <div className="flex items-baseline justify-between gap-2 text-[13px] mb-1.5">
              <span className="font-semibold">
                {name} <span className="font-normal text-muted">· {v.count} {v.count === 1 ? "trade" : "trades"}</span>
              </span>
              <span className={`font-bold tabular-nums ${v.net > 0 ? "text-gain" : v.net < 0 ? "text-loss" : "text-muted"}`}>
                {formatMoney(v.net, { signed: true, decimals: 0 })}
              </span>
            </div>
            <div className="flex items-center" aria-hidden="true">
              <span className="w-1/2 flex justify-end">
                {v.net < 0 && <span className="h-3 rounded-full bg-loss/75 nx-grow-left" style={{ width: w, animationDelay: `${i * 70}ms` }} />}
              </span>
              <span className="w-0.5 h-[18px] bg-line" />
              <span className="w-1/2 flex">
                {v.net > 0 && <span className="h-3 rounded-full bg-gain nx-grow" style={{ width: w, animationDelay: `${i * 70}ms` }} />}
              </span>
            </div>
          </div>
        );
      })}
    </Card>
  );
};

/** The win rate on a half dial: the needle swings to it, the arc fills, and a mark stands at the rate that breaks even. */
export const WinGauge: React.FC<{ winPct: number; breakEvenPct: number }> = ({ winPct, breakEvenPct }) => {
  const ahead = winPct >= breakEvenPct;
  const turn = (p: number) => `rotate(${(Math.max(0, Math.min(100, p)) * 1.8 - 90).toFixed(1)}deg)`;
  const ring = "radial-gradient(circle at center, transparent 79px, #000 80px, #000 104px, transparent 105px)";
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="relative w-[220px] h-[116px] overflow-hidden"
        role="meter"
        aria-label="Win rate against break-even"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={winPct}
      >
        <span
          data-testid="gauge-arc"
          className="absolute left-0 top-0 w-[220px] h-[220px] rounded-full nx-gauge"
          style={
            {
              "--nx-gauge": winPct,
              background: `conic-gradient(from -90deg, var(--nx-${ahead ? "gain" : "loss"}) 0 calc(var(--nx-gauge) * 1.8deg), var(--nx-inset) 0 180deg, transparent 0)`,
              WebkitMaskImage: ring,
              maskImage: ring,
            } as React.CSSProperties
          }
        />
        <span
          data-testid="gauge-break-even"
          className="absolute left-[109px] top-[2px] w-0.5 h-[34px] rounded-full bg-ink nx-fade-in"
          style={{ transform: turn(breakEvenPct), transformOrigin: "1px 108px", animationDelay: "500ms" }}
        />
        <span
          data-testid="gauge-needle"
          className="absolute left-[108px] top-6 w-1 h-[86px] rounded-full bg-ink nx-needle"
          style={{ transform: turn(winPct), transformOrigin: "2px 86px" }}
        />
        <span className="absolute left-[100px] top-[100px] w-5 h-5 rounded-full bg-ink ring-4 ring-surface" />
      </div>
      <div className="flex justify-between w-[220px] text-[11px] text-muted tabular-nums">
        <span className={`font-semibold ${ahead ? "text-gain" : "text-loss"}`}>won {winPct}%</span>
        <span>break-even {breakEvenPct}%</span>
      </div>
    </div>
  );
};
