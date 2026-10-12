import React from "react";
import type { Position, RiskCalculation } from "../../types";
import { Card } from "./ui";
import { formatMoney, formatPrice } from "./format";
import { atStop } from "./LedgerFloor";

// Book → Risk, first: three rings side by side (today's loss limit left, what
// every open stop hitting would take of it, and the money in trades), then
// each open trade's loss at its stop.

const money = (n: number) => formatMoney(n, { decimals: 0 });

/** What every open trade's stop hitting would make or lose together, before fees, and that loss's share of today's limit. */
export function allStops(positions: Position[], limit: number): { net: number; share: number } {
  const net = positions.reduce((s, p) => s + atStop(p), 0);
  return { net, share: limit > 0 ? Math.min(100, (Math.max(0, -net) / limit) * 100) : 0 };
}

const RING_R = 36;
const RING_C = 2 * Math.PI * RING_R;

/** One ring: it sweeps round to `pct` when shown and glides when it changes; the figure sits in its middle. */
const Ring: React.FC<{ pct: number; color: string; label: string; value: string; delayMs: number; testId: string }> = ({
  pct,
  color,
  label,
  value,
  delayMs,
  testId,
}) => {
  const f = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <div className="flex flex-col items-center gap-1.5 text-center min-w-0" data-testid={`${testId}-cell`}>
      <div className="relative w-[92px] h-[92px]">
        <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true" className="-rotate-90">
          <circle cx="46" cy="46" r={RING_R} fill="none" className="stroke-inset" strokeWidth="9" />
          <circle
            data-testid={testId}
            data-pct={(f * 100).toFixed(1)}
            cx="46"
            cy="46"
            r={RING_R}
            fill="none"
            stroke={color}
            strokeWidth="9"
            strokeLinecap="round"
            className="nx-ring-sweep"
            style={
              {
                "--nx-c": RING_C.toFixed(1),
                strokeDasharray: RING_C.toFixed(1),
                strokeDashoffset: (RING_C * (1 - f)).toFixed(1),
                animationDelay: `${delayMs}ms`,
                opacity: f > 0 ? 1 : 0,
              } as React.CSSProperties
            }
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center font-display text-lg tabular-nums">{Math.round(f * 100)}%</span>
      </div>
      <div className="text-xs font-semibold leading-tight">{label}</div>
      <div className="text-[11px] text-muted tabular-nums truncate max-w-full">{value}</div>
    </div>
  );
};

/** Three rings side by side: today's loss limit left, what every open stop hitting would take of it, and the money in trades. */
export const RiskGlance: React.FC<{ r: RiskCalculation; positions: Position[] }> = ({ r, positions }) => {
  const limit = r.hardDailyLossLimit;
  const left = Math.max(0, limit - r.currentDailyLoss);
  const stops = allStops(positions, limit);
  const inTrades = Math.max(0, r.portfolioExposureFraction) * 100;
  return (
    <section aria-label="Risk at a glance" className="bg-surface border border-line rounded-2xl px-2.5 py-4 grid grid-cols-3 gap-1">
      <Ring
        testId="ring-loss-left"
        pct={limit > 0 ? (left / limit) * 100 : 0}
        color="var(--nx-gain)"
        label="Loss limit left"
        value={`${money(left)} of ${money(limit)}`}
        delayMs={0}
      />
      <Ring
        testId="ring-all-stops"
        pct={stops.share}
        color="var(--nx-warn)"
        label="If every stop hit"
        value={positions.length === 0 ? "Nothing open" : formatMoney(stops.net, { signed: true, decimals: 0 })}
        delayMs={180}
      />
      <Ring
        testId="ring-in-trades"
        pct={inTrades}
        color="var(--nx-accent)"
        label="Money in trades"
        value={money(r.equity * Math.max(0, r.portfolioExposureFraction))}
        delayMs={360}
      />
    </section>
  );
};

/** Each open trade's result if its stop hit now, the biggest loss first, and all of them together. */
export const IfStopsHit: React.FC<{ positions: Position[]; limit: number }> = ({ positions, limit }) => {
  if (positions.length === 0) return null;
  const rows = positions.map((p) => ({ p, v: atStop(p) })).sort((a, b) => a.v - b.v);
  const biggest = Math.max(1, ...rows.map((x) => Math.max(0, -x.v)));
  const stops = allStops(positions, limit);
  return (
    <Card aria-label="If every stop hit now" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">If every stop hit now</h2>
        <span className={`text-sm font-bold tabular-nums ${stops.net < 0 ? "text-loss" : "text-gain"}`} data-testid="stops-total">
          {formatMoney(stops.net, { signed: true, decimals: 0 })}
        </span>
      </div>
      <p className="m-0 text-xs text-muted leading-relaxed" data-testid="stops-note">
        Each open trade at its stop, before fees{limit > 0 && stops.net < 0 ? `: ${Math.round(stops.share)}% of today's loss limit` : ""}. Stops
        seldom all hit on one day.
      </p>
      {rows.map(({ p, v }, i) => (
        <div key={p.id} data-testid="stop-row" className="flex items-center gap-2.5" title={`Stop ${formatPrice(p.stopLoss)}`}>
          <span className="w-[72px] shrink-0 text-[13px] font-bold truncate">{p.symbol.replace(/\.US$/, "").replace(/\/INR$/, "")}</span>
          <span className="flex-1 h-2 rounded-full bg-inset overflow-hidden" aria-hidden="true">
            {v < 0 && (
              <span
                className="block h-full rounded-full bg-loss/75 nx-grow"
                style={{ width: `${((-v / biggest) * 100).toFixed(1)}%`, animationDelay: `${300 + i * 70}ms` }}
              />
            )}
          </span>
          <span className={`w-[84px] shrink-0 text-right text-xs font-semibold tabular-nums ${v < 0 ? "text-loss" : "text-gain"}`}>
            {formatMoney(v, { signed: true, decimals: 0 })}
            {v >= 0 && <span className="block text-[10px] font-normal text-muted">locked in</span>}
          </span>
        </div>
      ))}
    </Card>
  );
};
