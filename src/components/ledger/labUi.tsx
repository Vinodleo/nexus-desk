import React, { useState } from "react";
import { recordStats } from "../../services/historyReplay";
import type { TraderRecord } from "../../services/exitExpectancy";
import { rSigned } from "./LedgerBreakdown";

// Pieces the Lab's tabs share: one status chip for every verdict, a fold for
// the longer explanations and lists, and the bars its charts are drawn with.

export type LabStatus = "trading" | "paused" | "passes" | "fails" | "off";

/** Each status has its own sign as well as its colour, so it never rests on colour alone. */
const STATUS: Record<LabStatus, { icon: string; tone: string }> = {
  trading: { icon: "●", tone: "text-gain" },
  passes: { icon: "✓", tone: "text-gain" },
  paused: { icon: "‖", tone: "text-muted" },
  fails: { icon: "✕", tone: "text-loss" },
  off: { icon: "–", tone: "text-muted" },
};

export const LabChip: React.FC<{ status: LabStatus; children: React.ReactNode }> = ({ status, children }) => (
  <span className={`inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap ${STATUS[status].tone}`}>
    <span aria-hidden="true" className="text-[10px]">
      {STATUS[status].icon}
    </span>
    {children}
  </span>
);

/** A titled section that opens on a tap: the explanations and longer lists, out of the way. */
export const Fold: React.FC<{ title: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, children, className = "" }) => (
  <details className={`group ${className}`}>
    <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer min-h-8 flex items-center gap-1 text-xs font-semibold text-accent">
      {title}
      <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
        ›
      </span>
    </summary>
    <div className="mt-1 flex flex-col gap-1.5">{children}</div>
  </details>
);

/**
 * A bar from zero to `r` on a scale from `min` to `max` (in R), gains to the
 * right in the gain colour, losses to the left in the loss colour, with a
 * hairline at zero and a darker one at `mark` (the edge a strategy needs).
 */
export const SignedBar: React.FC<{ r: number; min: number; max: number; mark?: number; delayMs?: number }> = ({ r, min, max, mark, delayMs = 0 }) => {
  const at = (x: number) => ((Math.max(min, Math.min(max, x)) - min) / (max - min)) * 100;
  const zero = at(0);
  const left = Math.min(zero, at(r));
  const width = Math.max(Math.abs(at(r) - zero), 0.8);
  return (
    <div className="relative h-2" aria-hidden="true">
      <span className="absolute -top-[3px] -bottom-[3px] w-px bg-line" style={{ left: `${zero}%` }} />
      {mark !== undefined && <span className="absolute -top-[3px] -bottom-[3px] w-px bg-ink/50" style={{ left: `${at(mark)}%` }} />}
      <span
        className={`absolute inset-y-0 ${r >= 0 ? "bg-gain rounded-r nx-grow" : "bg-loss rounded-l nx-grow-left"}`}
        style={{ left: `${left}%`, width: `${width}%`, animationDelay: `${delayMs}ms` }}
      />
    </div>
  );
};

const CHART_H = 64;

/**
 * Average R a trade, year by year, as columns from a zero line (each chart on
 * its own scale), the best and worst year labelled. Tapping a year shows its
 * numbers underneath.
 */
export const YearColumns: React.FC<{ title: string; years: { year: string; rec: TraderRecord }[]; unit: string; testId?: string }> = ({
  title,
  years,
  unit,
  testId,
}) => {
  const [picked, setPicked] = useState<string | null>(null);
  const shown = years.filter((y) => y.rec.trades > 0).map((y) => ({ ...y, stats: recordStats(y.rec) }));
  if (shown.length === 0) return null;
  const values = shown.map((y) => y.stats.avgR);
  const top = Math.max(...values, 0);
  const bottom = Math.min(...values, 0);
  const span = top - bottom || 1;
  const zeroY = (top / span) * CHART_H;
  const best = values.indexOf(Math.max(...values));
  const worst = values.indexOf(Math.min(...values));
  const up = values.filter((v) => v > 0).length;
  const pick = shown.find((y) => y.year === picked);
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold">{title}</span>
        <span className="text-muted tabular-nums">
          {up} of {shown.length} years up
        </span>
      </div>
      <div className="relative" style={{ height: CHART_H + 40 }}>
        <div className="absolute inset-x-0 flex gap-[2px]" style={{ top: 12, height: CHART_H }}>
          {shown.map((y, k) => {
            const v = y.stats.avgR;
            const h = Math.max((Math.abs(v) / span) * CHART_H, 1.5);
            const dim = pick && pick.year !== y.year;
            return (
              <button
                key={y.year}
                type="button"
                onClick={() => setPicked(picked === y.year ? null : y.year)}
                aria-pressed={pick?.year === y.year}
                aria-label={`${y.year}: ${rSigned(v)} a ${unit.replace(/s$/, "")} over ${y.stats.trades} ${unit}`}
                className="relative flex-1 h-full cursor-pointer"
              >
                <span
                  className={`absolute inset-x-[3px] transition-opacity ${v >= 0 ? "bg-gain rounded-t nx-rise" : "bg-loss rounded-b nx-drop"} ${dim ? "opacity-35" : ""}`}
                  style={{ ...(v >= 0 ? { top: zeroY - h, height: h } : { top: zeroY, height: h }), animationDelay: `${k * 40}ms` }}
                />
                {(k === best || k === worst) && (
                  <span
                    className="absolute inset-x-[-6px] text-center text-[10px] font-semibold tabular-nums text-ink"
                    style={v >= 0 ? { top: zeroY - h - 13 } : { top: zeroY + h + 1 }}
                  >
                    {rSigned(v).replace("R", "")}
                  </span>
                )}
              </button>
            );
          })}
          <span className="absolute inset-x-0 h-px bg-line pointer-events-none" style={{ top: zeroY }} />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex gap-[2px] text-[10px] text-muted tabular-nums" aria-hidden="true">
          {shown.map((y) => (
            <span key={y.year} className={`flex-1 text-center ${pick?.year === y.year ? "text-ink font-semibold" : ""}`}>
              '{y.year.slice(2)}
            </span>
          ))}
        </div>
      </div>
      <div className="text-xs tabular-nums min-h-4" aria-live="polite">
        {pick ? (
          <span>
            <span className="font-semibold">{pick.year}</span>
            <span className="text-muted">
              {" "}
              · {pick.stats.trades} {unit} · {pick.stats.winPct}% won ·{" "}
            </span>
            <span className={`font-semibold ${pick.stats.avgR >= 0 ? "text-gain" : "text-loss"}`}>{rSigned(pick.stats.avgR)}</span>
          </span>
        ) : (
          <span className="text-muted">Tap a year for its numbers.</span>
        )}
      </div>
    </div>
  );
};

/** A few results side by side as bars on one scale (from zero), each with its number: "every setup" against "its picks". */
export const CompareBars: React.FC<{ rows: { label: string; sub?: string; r: number; strong?: boolean }[]; testId?: string }> = ({ rows, testId }) => {
  const min = Math.min(0, ...rows.map((x) => x.r)) * 1.1;
  const max = Math.max(0, ...rows.map((x) => x.r)) * 1.1 || 1;
  return (
    <div className="flex flex-col gap-2 p-2.5 rounded-xl bg-inset" data-testid={testId}>
      {rows.map((x, k) => (
        <div key={x.label} className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 min-w-0">
            <span className={x.strong ? "font-semibold" : "text-muted"}>{x.label}</span>
            {x.sub && <span className="block text-[10px] text-muted tabular-nums leading-snug">{x.sub}</span>}
          </span>
          <span className="flex-1 min-w-0">
            <SignedBar r={x.r} min={min} max={max} delayMs={k * 80} />
          </span>
          <span className={`w-14 shrink-0 text-right tabular-nums ${x.strong ? "font-semibold" : ""}`}>{rSigned(x.r)}</span>
        </div>
      ))}
    </div>
  );
};
