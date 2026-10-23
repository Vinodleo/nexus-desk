import React, { useState } from "react";
import { apiFetch } from "../../services/apiClient";
import {
  APPLY_ALERT_FROM,
  DEFAULT_UPI_CUTOFF,
  HOLD_DAYS,
  STRONG_OPEN,
  addDays,
  dayLabel,
  istDay,
  timeLabel,
  type IpoBids,
  type IpoPlan,
  type IpoRecord,
  type IpoSession,
} from "../../shared/ipo";
import { Card } from "./ui";
import { formatMoney, pnlTone } from "./format";
import { useLabFeed } from "./labFeed";
import { Fold, LabChip } from "./labUi";
import { when } from "./DailyCoinsCard";

// IPOs on NSE's main board (server/ipoTracker.ts, the rule in
// src/shared/ipo.ts): bidding now with how many times over each group has
// bid against the rule's bar, coming up, waiting to list or just listed
// with what the rule says to do and "I got shares" (its alerts then come to
// you), and the rule's paper record. Alerts only: you apply and sell.

interface IpoRow {
  symbol: string;
  name: string;
  opens: string;
  closes: string;
  priceLow: number | null;
  priceHigh: number | null;
  lotSize: number | null;
  lotEstimated?: boolean;
  /** When UPI approvals close on the last day (India minutes). */
  upiCutoff?: number;
  lotCost: number | null;
  bids: IpoBids | null;
  bidsError?: string | null;
  fits: boolean;
  fit: boolean | null;
  allotmentOn: string;
  listsOn: string;
  listedOn: string | null;
  open: number | null;
  openPct: number | null;
  plan: IpoPlan | null;
  held: boolean;
  /** The top of the band and the sessions since listing (absent from older servers). */
  issuePrice?: number | null;
  sessions?: IpoSession[];
}

export interface IpoView {
  rule: { qib: number; total: number };
  bidding: IpoRow[];
  upcoming: IpoRow[];
  recent: IpoRow[];
  record: { picked: IpoRecord; skipped: IpoRecord; rows: { symbol: string; name: string; listedOn: string; fit: boolean; pct: number; rupees: number }[] };
  lastCheckAt: number | null;
  lastError: string | null;
  nextAt: number;
}

/** A reply this card can show (an older server has no such route). */
export const isIpoView = (body: any): body is IpoView =>
  !!body && Array.isArray(body.bidding) && Array.isArray(body.upcoming) && Array.isArray(body.recent) && !!body.record?.picked;

const times = (x: number | null) => (x === null ? "–" : `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`);
const pct = (p: number) => `${p >= 0 ? "+" : "−"}${Math.abs(p * 100).toFixed(0)}%`;
const rupees = (x: number, signed = false) => formatMoney(x, { decimals: 0, signed });
const price = (x: number) => formatMoney(x, { decimals: x >= 100 || Number.isInteger(x) ? 0 : 2 });
const band = (r: IpoRow) =>
  r.priceLow !== null && r.priceHigh !== null && r.priceLow !== r.priceHigh ? `${price(r.priceLow)}–${price(r.priceHigh).replace("₹", "")}` : r.priceHigh !== null ? price(r.priceHigh) : "price to come";

/** Where `v` times sits on the bars' log scale, up to 200×, as a share of the width. */
const at = (v: number) => Math.min(100, (Math.log10(1 + Math.max(0, v)) / Math.log10(201)) * 100);

/** Times bid on a log scale up to 200×, with the rule's bar marked and named. */
const BidBar: React.FC<{ label: string; x: number | null; bar?: number; note?: string }> = ({ label, x, bar, note }) => {
  const met = bar === undefined || (x ?? 0) >= bar;
  return (
    <div className="flex flex-col gap-1 text-xs tabular-nums">
      <div className="flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span>
          <span className="font-semibold text-[13px]">{times(x)}</span>
          <span className="text-muted"> · {bar !== undefined ? `needs ${times(bar)}` : note}</span>
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-inset" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 rounded-full ${bar === undefined ? "bg-muted/60" : met ? "bg-gain" : "bg-warn"}`} style={{ width: `${at(x ?? 0)}%` }} />
        {bar !== undefined && <span className="absolute -top-[3px] -bottom-[3px] w-0.5 bg-ink/70" style={{ left: `${at(bar)}%` }} />}
      </div>
    </div>
  );
};

/** The bars' scale: 1×, 10× and 100× where they fall. */
const BidScale: React.FC = () => (
  <div className="relative h-3 text-[10px] text-muted tabular-nums" aria-hidden="true">
    {[1, 10, 100].map((v) => (
      <span key={v} className="absolute -translate-x-1/2" style={{ left: `${at(v)}%` }}>
        {v}×
      </span>
    ))}
  </div>
);

/** India's minutes past midnight now. */
const indiaMinutes = (now: number) => Math.floor(((now + 330 * 60_000) % 86_400_000) / 60_000);

/** The time left to apply on the last day, as a ring that empties from 2 pm to the UPI cutoff. */
export const CountdownRing: React.FC<{ cutoff: number; now: number; fits?: boolean }> = ({ cutoff, now, fits = true }) => {
  const left = Math.max(0, cutoff - indiaMinutes(now));
  const window = Math.max(1, cutoff - APPLY_ALERT_FROM);
  const share = Math.min(1, left / window);
  const R = 30;
  const C = 2 * Math.PI * R;
  const text = left >= 60 ? `${Math.floor(left / 60)}h ${left % 60}m` : `${left}m`;
  return (
    <div className="relative w-[76px] h-[76px] shrink-0" role="img" aria-label={`${text} left to apply, until ${timeLabel(cutoff)}`} data-testid="ipo-countdown">
      <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true" className="-rotate-90">
        <circle cx="38" cy="38" r={R} fill="none" className="stroke-inset" strokeWidth="7" />
        <circle cx="38" cy="38" r={R} fill="none" className={!fits ? "stroke-muted" : share < 0.25 ? "stroke-loss" : "stroke-gain"} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${share * C} ${C}`} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-display text-[15px] font-semibold tabular-nums">{text}</span>
        <span className="text-[10px] text-muted mt-0.5">to {timeLabel(cutoff)}</span>
      </span>
    </div>
  );
};

/** An issue's road: bidding, allotment, listing and the rule's sale, each filled once it's past. */
export function ipoSteps(r: IpoRow, today: string): { label: string; sub: string; done: boolean; now: boolean }[] {
  const listing = r.listedOn ?? r.listsOn;
  const sold = !!r.plan?.result;
  return [
    { label: "Bid", sub: `${dayLabel(r.opens).slice(0, 3)}–${dayLabel(r.closes).slice(0, 3)}`, done: today > r.closes, now: today >= r.opens && today <= r.closes },
    { label: "Allotment", sub: dayLabel(r.allotmentOn), done: today > r.allotmentOn, now: today === r.allotmentOn },
    { label: "Listing", sub: dayLabel(listing), done: !!r.listedOn && today > r.listedOn, now: today === listing },
    {
      label: "Sell",
      sub: sold ? "done" : r.listedOn ? `by ${dayLabel(addDays(r.listedOn, HOLD_DAYS))}` : "10 am open",
      done: sold,
      now: !!r.listedOn && !sold && today >= r.listedOn,
    },
  ];
}

const Steps: React.FC<{ r: IpoRow; today: string }> = ({ r, today }) => (
  <ol className="m-0 p-0 list-none grid grid-cols-4 gap-1" aria-label="Its road" data-testid={`ipo-steps-${r.symbol}`}>
    {ipoSteps(r, today).map((s) => (
      <li key={s.label} className="flex flex-col gap-1 min-w-0" aria-current={s.now ? "step" : undefined}>
        <span className={`h-1 rounded-full ${s.done ? "bg-gain" : s.now ? "bg-accent" : "bg-line"}`} aria-hidden="true" />
        <span className={`text-[11px] font-bold ${s.now ? "text-accent" : ""}`}>{s.label}</span>
        <span className="text-[10px] text-muted truncate">{s.sub}</span>
      </li>
    ))}
  </ol>
);

/**
 * The price since listing, a point a session (the listing open, then each
 * close), against the issue price and the listing day's low (under it the
 * rest is sold), with the rule's sales marked.
 */
export const PricePath: React.FC<{ r: IpoRow }> = ({ r }) => {
  const sessions = r.sessions ?? [];
  const issue = r.issuePrice ?? null;
  if (sessions.length === 0 || issue === null) return null;
  const points = [sessions[0].open, ...sessions.map((x) => x.close)];
  const stop = r.plan?.stop ?? null;
  const all = [...points, issue, ...(stop !== null ? [stop] : [])];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const W = 300;
  const H = 84;
  const y = (v: number) => 6 + (1 - (v - lo) / Math.max(hi - lo, 1e-9)) * (H - 12);
  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const up = points[points.length - 1] >= issue;
  const saleAt = (day: string, why: string) => (why === "open" || why === "weak-open" ? 0 : Math.max(0, sessions.findIndex((x) => x.day === day)) + 1);
  return (
    <div className="flex flex-col gap-1.5">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Price since listing: ${points.length} points, last ${price(points[points.length - 1])} against the ${price(issue)} issue price`} data-testid={`ipo-path-${r.symbol}`} className="block h-[84px] overflow-visible">
        <line x1="0" x2={W} y1={y(issue)} y2={y(issue)} className="stroke-muted" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        {stop !== null && <line x1="0" x2={W} y1={y(stop)} y2={y(stop)} className="stroke-loss" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
        <polyline fill="none" className={up ? "stroke-gain" : "stroke-loss"} strokeWidth="2" vectorEffect="non-scaling-stroke" points={points.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
        {(r.plan?.sales ?? []).map((sale) => (
          <circle key={`${sale.day}-${sale.why}`} cx={x(saleAt(sale.day, sale.why))} cy={y(sale.price)} r="3.5" className="fill-accent" />
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted tabular-nums" aria-hidden="true">
        <span className="flex items-center gap-1">
          <span className="w-3 border-t border-dashed border-muted" />
          issue {price(issue)}
        </span>
        {stop !== null && (
          <span className="flex items-center gap-1">
            <span className="w-3 border-t border-dashed border-loss" />
            listing day's low {price(stop)}
          </span>
        )}
        {(r.plan?.sales.length ?? 0) > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            sold
          </span>
        )}
      </div>
    </div>
  );
};

/** What the rule did with the lot, or does next, in a line. */
export function planText(r: IpoRow, today: string): string {
  const p = r.plan;
  if (r.listedOn === null || r.open === null) {
    return today <= r.allotmentOn
      ? `Allotment ${dayLabel(r.allotmentOn)}, listing ${dayLabel(r.listsOn)}.`
      : `Listing ${dayLabel(r.listsOn)}, trading from 10 am.`;
  }
  const opened = `Listed ${dayLabel(r.listedOn)} at ${price(r.open)} (${pct(r.openPct ?? 0)}).`;
  if (!p) return `${opened} ${(r.openPct ?? 0) >= STRONG_OPEN ? "Sell half; keep the rest above today's low." : "Sell it all today."}`;
  if (p.result) {
    const how = p.sales.map((s) => (s.why === "open" ? `half at ${price(s.price)}` : s.why === "weak-open" ? `all at ${price(s.price)}` : s.why === "stop" ? `the rest at ${price(s.price)} (under the low)` : `the rest at ${price(s.price)} (a week on)`));
    return `${opened} The rule sold ${how.join(", ")}: ${rupees(p.result.rupees, true)} a lot (${pct(p.result.pct)}).`;
  }
  return `${opened} Half sold at the open; the rest is sold under ${price(p.stop!)} or on ${dayLabel(addDays(r.listedOn, HOLD_DAYS))}.`;
}

/** The rule's record one way (picked or skipped): its average a lot, big, over how many listed and made money. */
const RecordTile: React.FC<{ label: string; rec: IpoRecord; testId: string }> = ({ label, rec, testId }) => (
  <div className="min-w-0 rounded-[16px] bg-inset p-3 flex flex-col gap-0.5 tabular-nums" data-testid={testId}>
    <span className="text-xs text-muted">{label}</span>
    {rec.count === 0 ? (
      <span className="text-[13px] text-muted">none listed yet</span>
    ) : (
      <>
        <span className={`font-display text-xl font-semibold ${pnlTone(rec.avgRupees)}`}>{pct(rec.avgPct)} avg</span>
        <span className="text-[11px] text-muted">
          {rec.count} listed · {rec.won} made money · {rupees(rec.avgRupees, true)} a lot
        </span>
      </>
    )}
  </div>
);

export const IpoCard: React.FC = () => {
  const view = useLabFeed("/api/ipos", isIpoView, () => true, 5 * 60_000);
  // "I got shares" as the server last took it, until the feed's next look.
  const [heldNow, setHeldNow] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!view) return null;
  const now = Date.now();
  const today = istDay(now);

  const hold = async (symbol: string, held: boolean) => {
    setBusy(symbol);
    setError(null);
    try {
      const res = await apiFetch("/api/ipos/held", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, held }),
      });
      const data = await res.json();
      if (data?.success) setHeldNow((h) => ({ ...h, [symbol]: held }));
      else setError(data?.error || "The server didn't take it.");
    } catch (err: any) {
      setError(err?.message || "Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  };

  const nothing = view.bidding.length === 0 && view.upcoming.length === 0 && view.recent.length === 0;
  return (
    <Card aria-label="IPOs" className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-semibold">IPOs</div>
        <div className="text-xs tabular-nums text-muted" data-testid="ipo-status">
          NSE main board · alerts only{view.lastCheckAt ? ` · last look ${when(view.lastCheckAt)}` : ""}
        </div>
      </div>
      {view.lastError && (
        <p className="m-0 text-xs text-warn-ink bg-warn-soft rounded-lg px-2 py-1.5" data-testid="ipo-error">
          Couldn't read NSE: {view.lastError}
        </p>
      )}
      {nothing && <p className="m-0 text-xs text-muted">No main-board IPOs bidding or coming up.</p>}

      {view.bidding.map((r) => {
        const lastDay = r.closes === today;
        const cutoffMin = r.upiCutoff ?? DEFAULT_UPI_CUTOFF;
        const cutoff = timeLabel(cutoffMin);
        const counting = lastDay && indiaMinutes(now) < cutoffMin;
        return (
          <section
            key={r.symbol}
            className="rounded-[18px] border border-line p-3.5 flex flex-col gap-3"
            aria-label={`${r.name} IPO`}
            data-testid={`ipo-bidding-${r.symbol}`}
          >
            <div className="flex items-center gap-3">
              {counting && <CountdownRing cutoff={cutoffMin} now={now} fits={r.fits} />}
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[15px] font-bold">{r.name}</span>
                  <LabChip status={r.fits ? "passes" : "paused"}>{r.fits ? "Fits the rule" : "Not yet"}</LabChip>
                </div>
                <div className="text-xs tabular-nums text-muted">
                  {lastDay ? `Closes today, ${cutoff}` : `Closes ${dayLabel(r.closes)}`} · {band(r)}
                  {r.lotCost !== null ? ` · lot ${r.lotEstimated ? "about " : ""}${rupees(r.lotCost)}` : ""}
                </div>
                {lastDay && r.fits && counting && (
                  <p className="m-0 text-[13px] font-semibold text-gain">Apply and approve the UPI request by {cutoff} today.</p>
                )}
              </div>
            </div>
            {r.bids ? (
              <div className="flex flex-col gap-2">
                <BidScale />
                <BidBar label="Institutions" x={r.bids.qib} bar={view.rule.qib} />
                <BidBar label="Whole issue" x={r.bids.total} bar={view.rule.total} />
                <BidBar label="Retail" x={r.bids.retail} note="a lottery above 1×" />
              </div>
            ) : (
              <div className="text-xs text-muted">{r.bidsError ? `Bids not read: ${r.bidsError}` : "Bids not read yet."}</div>
            )}
            <Steps r={r} today={today} />
          </section>
        );
      })}

      {view.recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold">Allotment and listing</div>
          {view.recent.map((r) => {
            const finished = !!r.plan?.result;
            const held = heldNow[r.symbol] ?? r.held;
            return (
              <section
                key={r.symbol}
                className="rounded-[18px] border border-line p-3.5 flex flex-col gap-2.5"
                aria-label={`${r.name} listing`}
                data-testid={`ipo-recent-${r.symbol}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[15px] font-bold">{r.name}</span>
                  {r.openPct !== null ? (
                    <span className={`font-display text-lg font-semibold tabular-nums ${pnlTone(r.openPct)}`}>{pct(r.openPct)}</span>
                  ) : (
                    <LabChip status={r.fit ? "passes" : "off"}>{r.fit ? "Rule: apply" : "Rule: skip"}</LabChip>
                  )}
                </div>
                <PricePath r={r} />
                <p className="m-0 text-xs leading-relaxed tabular-nums" data-testid={`ipo-plan-${r.symbol}`}>
                  {planText(r, today)}
                </p>
                <Steps r={r} today={today} />
                {!finished && (
                  <button
                    type="button"
                    aria-pressed={held}
                    disabled={busy === r.symbol}
                    onClick={() => void hold(r.symbol, !held)}
                    className={`self-start min-h-9 px-3 rounded-full text-xs font-semibold cursor-pointer border ${
                      held ? "bg-accent text-on-accent border-accent" : "border-line text-ink"
                    } disabled:opacity-60`}
                  >
                    {held ? "✓ I got shares: alerts on" : "I got shares"}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}
      {error && (
        <p className="m-0 text-xs text-loss" role="alert">
          {error}
        </p>
      )}

      {view.upcoming.length > 0 && (
        <div className="flex flex-col">
          <div className="text-xs font-semibold mb-1">Coming up</div>
          {/* One issue a row: its name and price band on top, its bidding days under it. */}
          <ul className="m-0 p-0 list-none [&>*+*]:border-t [&>*+*]:border-line">
            {view.upcoming.map((r) => (
              <li key={r.symbol} className="py-2 flex flex-col gap-0.5 text-xs tabular-nums" data-testid={`ipo-upcoming-${r.symbol}`}>
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 font-medium">{r.name}</span>
                  <span className="shrink-0 text-muted" data-testid={`ipo-upcoming-band-${r.symbol}`}>
                    {band(r)}
                  </span>
                </span>
                <span className="text-muted" data-testid={`ipo-upcoming-days-${r.symbol}`}>
                  {dayLabel(r.opens)} to {dayLabel(r.closes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-semibold">The rule on paper (one lot each)</div>
        <div className="grid grid-cols-2 gap-2">
          <RecordTile label="Rule picked" rec={view.record.picked} testId="ipo-record-picked" />
          <RecordTile label="Rule skipped" rec={view.record.skipped} testId="ipo-record-skipped" />
        </div>
        {view.record.rows.length > 0 && (
          <Fold title="Each listed issue">
            {view.record.rows.map((x) => (
              <div key={x.symbol} className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
                <span>
                  {x.name} <span className="text-muted">· {dayLabel(x.listedOn)} · {x.fit ? "picked" : "skipped"}</span>
                </span>
                <span className={`font-semibold ${pnlTone(x.rupees)}`}>
                  {pct(x.pct)} · {rupees(x.rupees, true)}
                </span>
              </div>
            ))}
          </Fold>
        )}
      </div>

      <Fold title="How the IPO rule works">
        <p className="m-0 text-xs text-muted leading-relaxed">
          Apply on the last bidding day to an issue the big institutions (QIBs: mutual funds, banks, insurers) bid {view.rule.qib}× or more
          for, and the whole issue {view.rule.total}× or more. The alert comes from 2 pm that day, before UPI approvals close (the time NSE's page gives, 5 pm if it doesn't). You
          apply and approve the UPI request yourself: the money is only blocked until allotment.
        </p>
        <p className="m-0 text-xs text-muted leading-relaxed">
          Tap "I got shares" once you're allotted. On listing day it opens at 10 am: if it's {Math.round(STRONG_OPEN * 100)}% or more above the
          issue price, sell half and keep the rest; under that, sell it all. The rest is sold if the price goes under the listing day's low,
          and {HOLD_DAYS} days after listing at the latest. An alert comes for each.
        </p>
        <p className="m-0 text-xs text-muted leading-relaxed">
          The record follows every main-board issue as if one lot was allotted at the top of its price band (about ₹15,000 of shares
          where NSE's list doesn't give the lot), after Angel One's selling
          charges and before tax (a sale within a year is taxed at 20%). Picked against skipped shows whether the rule is worth following.
          SME issues are left out. Prices: NSE for the issues and bids, Angel One after listing.
        </p>
      </Fold>
    </Card>
  );
};
