import React, { useEffect, useState } from "react";
import type { HistoricalTrade, Position } from "../../types";
import {
  combineRecords,
  paperScore,
  PAPER_STRATEGIES,
  SCORECARD_FAIR_TRADES,
  SCORECARD_MIN_TRADES,
  type ExitKind,
  type PaperStrategy,
  type ReplayRecord,
} from "../../services/paperScorecard";
import { Card } from "./ui";
import { formatMoney } from "./format";
import { rSigned } from "./LedgerBreakdown";
import { useLabFeed } from "./labFeed";
import { LabChip, type LabStatus } from "./labUi";
import { isDailyCoinsView } from "./DailyCoinsCard";
import { isUsBreakoutView } from "./UsBreakoutCard";
import { isUsMomentumView } from "./UsMomentumCard";

// The Lab's scorecard (Records tab): each slower strategy's real paper
// trades so far next to what its replay expects (services/paperScorecard).
// It catches paper trading that doesn't behave like the replay long before
// the trades are enough to prove an edge.

type Gate = { trades: number; avgR: number; on?: boolean; wins?: number; winR?: number; lossR?: number };

/** A gate as a replay record, when the server sent its wins and the R won and lost. */
const asRecord = (g: Gate): ReplayRecord => ({ trades: g.trades, avgR: g.avgR, wins: g.wins ?? 0, winR: g.winR ?? 0, lossR: g.lossR ?? 0 });
const hasDetail = (g: Gate | null | undefined) => !!g && g.wins !== undefined;

const VERDICT: Record<"early" | "inLine" | "behind" | "ahead", { status: LabStatus; label: string }> = {
  early: { status: "off", label: "Too early" },
  inLine: { status: "passes", label: "In line" },
  behind: { status: "fails", label: "Behind the replay" },
  ahead: { status: "passes", label: "Ahead" },
};

/** How each strategy's exits read. */
const EXIT_WORDS = (strategy: PaperStrategy): Record<ExitKind, string> => ({
  stop: "at the stop",
  sale: strategy === "dailyCoins" ? "trailing stop" : strategy === "usMomentum" ? "sold at the weekly check" : "sold below the 20-day low",
  target: "at the target",
  time: "at the time limit",
  you: "closed by you",
});

const pct = (r: ReplayRecord) => Math.round((r.wins / r.trades) * 100);
const avgWin = (r: ReplayRecord) => (r.wins > 0 ? r.winR / r.wins : 0);
const avgLoss = (r: ReplayRecord) => (r.trades - r.wins > 0 ? r.lossR / (r.trades - r.wins) : 0);

/**
 * Each strategy on one line in R a trade: its replay as a ring, its paper
 * trades as a dot (gliding there from the ring when the tab is shown), and
 * once there are enough trades the shading of how far luck alone could put
 * it. Tap one for its numbers.
 */
export const PaperScorecard: React.FC<{ trades: HistoricalTrade[]; positions: Position[]; active?: boolean }> = ({ trades, positions, active = true }) => {
  const dc = useLabFeed("/api/daily-coins", isDailyCoinsView);
  const us = useLabFeed("/api/us-breakout", isUsBreakoutView);
  const momentum = useLabFeed("/api/us-momentum", isUsMomentumView);
  const funds = useLabFeed("/api/funds-breakout", isUsBreakoutView);
  // Each paper dot starts on its replay's ring and glides to where paper stands, each time the tab is shown.
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!active) return setGo(false);
    const t = setTimeout(() => setGo(true), 120);
    return () => clearTimeout(t);
  }, [active]);
  const [open, setOpen] = useState<PaperStrategy | null>(null);
  if (!dc && !us && !momentum && !funds) return null;

  const replays: Record<PaperStrategy, { record: ReplayRecord; detail: boolean } | null> = {
    coinBreakout: dc?.breakout ? { record: asRecord(dc.breakout), detail: hasDetail(dc.breakout) } : null,
    usBreakout: us?.gate ? { record: asRecord(us.gate), detail: hasDetail(us.gate) } : null,
    fundsBreakout: funds?.gate ? { record: asRecord(funds.gate), detail: hasDetail(funds.gate) } : null,
    usMomentum: momentum?.gate ? { record: asRecord(momentum.gate), detail: hasDetail(momentum.gate) } : null,
    // The daily traders that trade now, together.
    dailyCoins: (() => {
      const on = (dc?.traders ?? []).filter((t) => t.on);
      const record = combineRecords(on.map(asRecord));
      return record ? { record, detail: on.every(hasDetail) } : null;
    })(),
  };
  const rows = PAPER_STRATEGIES.map(({ id, name }) => {
    const replay = replays[id];
    return { id, name, replay, score: paperScore(id, trades, positions, replay?.record ?? null) };
  });
  // One scale for every row, from −1R to +1R at least, with room either side.
  const marks = rows.flatMap((r) => [r.replay?.record.avgR ?? 0, r.score.avgR ?? 0]);
  const lo = Math.floor(Math.min(-1, ...marks) - 0.25);
  const hi = Math.ceil(Math.max(1, ...marks) + 0.25);
  const at = (r: number) => `${(((Math.max(lo, Math.min(hi, r)) - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  const ticks = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).filter((r) => r > lo && r < hi);

  return (
    <Card aria-label="Paper trades against the replay" className="flex flex-col gap-3">
      <div>
        <h2 className="m-0 text-sm font-semibold">Paper against the replay</h2>
        <p className="m-0 mt-0.5 text-xs text-muted leading-snug">
          Each slower strategy's real paper trades so far (the dot) against what its replay expects (the ring), in R a trade. Ten trades
          are mostly luck; it takes about {SCORECARD_FAIR_TRADES} to tell. Tap one for its numbers.
        </p>
      </div>
      <div className="relative h-3.5 text-[10px] text-muted tabular-nums" aria-hidden="true">
        {ticks.map((r) => (
          <span key={r} className="absolute -translate-x-1/2" style={{ left: at(r) }}>
            {r === 0 ? "0" : `${r > 0 ? "+" : "−"}${Math.abs(r)}R`}
          </span>
        ))}
      </div>
      <ul className="m-0 p-0 list-none flex flex-col">
        {rows.map(({ id, name, replay, score }) => {
          const verdict = VERDICT[score.verdict];
          const exits = Object.entries(score.exits).map(([kind, n]) => {
            const words = EXIT_WORDS(id)[kind as ExitKind];
            return kind === "stop" && score.gapped > 0 ? `${n} ${words} (${score.gapped} gapped past it)` : `${n} ${words}`;
          });
          const paper = score.avgR;
          const dotAt = paper === null ? null : go || !replay ? paper : replay.record.avgR;
          const isOpen = open === id;
          const label =
            paper === null
              ? `${name}: no closed paper trades${replay ? `; the replay expects ${rSigned(replay.record.avgR)} a trade` : ""}`
              : `${name}: paper ${rSigned(paper)} over ${score.closed} closed${replay ? `, replay ${rSigned(replay.record.avgR)}` : ""}`;
          const head = (
            <>
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold">{name}</span>
                <LabChip status={verdict.status}>
                  {score.verdict === "early" && score.closed > 0 ? `${verdict.label} · ${score.closed} of ${SCORECARD_MIN_TRADES}` : verdict.label}
                </LabChip>
              </span>
              <span role="img" aria-label={label} className="relative block h-[18px]" data-testid={`score-${id}-track`}>
                <span className="absolute inset-x-0 top-2 h-0.5 rounded-full bg-inset" />
                <span className="absolute top-0.5 w-px h-3.5 bg-muted" style={{ left: at(0) }} />
                {replay && score.band !== null && (
                  <span
                    className="absolute top-1 h-2.5 rounded-full bg-muted/15"
                    style={{ left: at(replay.record.avgR - score.band), width: `calc(${at(replay.record.avgR + score.band)} - ${at(replay.record.avgR - score.band)})` }}
                  />
                )}
                {replay && dotAt !== null && (
                  <span
                    className={`absolute top-2 h-0.5 nx-glide-left ${paper! >= 0 ? "bg-gain/50" : "bg-loss/50"}`}
                    style={{
                      left: replay.record.avgR < dotAt ? at(replay.record.avgR) : at(dotAt),
                      width: `calc(${at(Math.max(replay.record.avgR, dotAt))} - ${at(Math.min(replay.record.avgR, dotAt))})`,
                    }}
                  />
                )}
                {replay && (
                  <span
                    data-testid={`score-${id}-replay`}
                    className="absolute top-0.5 w-3.5 h-3.5 -ml-[7px] rounded-full border-[2.5px] border-ink bg-surface"
                    style={{ left: at(replay.record.avgR) }}
                  />
                )}
                {dotAt !== null && (
                  <span
                    data-testid={`score-${id}-paper`}
                    className={`absolute top-[3px] w-3 h-3 -ml-1.5 rounded-full shadow-[0_0_0_3px_var(--nx-surface)] nx-glide-left ${paper! >= 0 ? "bg-gain" : "bg-loss"}`}
                    style={{ left: at(dotAt) }}
                  />
                )}
              </span>
              <span className="flex justify-between gap-2 text-[11px] text-muted tabular-nums">
                <span>{paper === null ? (score.open > 0 ? `${score.open} open, none closed yet` : "No paper trades yet") : `Paper ${rSigned(paper)} · ${score.closed} closed`}</span>
                {replay && <span>Replay {rSigned(replay.record.avgR)}</span>}
              </span>
            </>
          );
          return (
            <li key={id} className="py-2.5 border-b border-line last:border-b-0 flex flex-col" data-testid={`score-${id}`}>
              {score.closed === 0 ? (
                <div className="flex flex-col gap-1.5">
                  {head}
                  <span className="text-xs text-muted">
                    {replay ? `The replay expects ${rSigned(replay.record.avgR)} a trade${replay.detail ? `, ${pct(replay.record)}% won` : ""}.` : ""}
                  </span>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : id)}
                    className="w-full flex flex-col gap-1.5 text-left cursor-pointer"
                  >
                    {head}
                  </button>
                  <div className={`nx-fold${isOpen ? " nx-fold-open" : ""}`} inert={!isOpen}>
                    <div>
                      <div className="pt-2 flex flex-col gap-1">
                        <div className="text-xs text-muted tabular-nums">
                          {score.open} open · {score.winPct}% won{replay?.detail ? ` (replay ${pct(replay.record)}%)` : ""} · P&L{" "}
                          {formatMoney(score.pnl, { signed: true, decimals: 0 })}
                        </div>
                        <div className="text-xs text-muted tabular-nums">
                          Average win {score.avgWinR !== null ? rSigned(score.avgWinR) : "—"}
                          {replay?.detail ? ` (replay ${rSigned(avgWin(replay.record))})` : ""} · average loss{" "}
                          {score.avgLossR !== null ? rSigned(score.avgLossR) : "—"}
                          {replay?.detail ? ` (replay ${rSigned(avgLoss(replay.record))})` : ""}
                        </div>
                        <div className="text-xs text-muted">Exits: {exits.join(" · ")}.</div>
                        {score.band !== null && (
                          <div className="text-[11px] text-muted">The shading is how far luck alone could put it from the replay.</div>
                        )}
                        {score.verdict !== "early" && score.closed < SCORECARD_FAIR_TRADES && (
                          <div className="text-[11px] text-muted">Under {SCORECARD_FAIR_TRADES} trades, luck still decides most of it.</div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
};
