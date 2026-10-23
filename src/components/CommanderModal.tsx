import React, { useMemo, useState } from "react";
import { AlertTriangle, CircleCheck, Loader2 } from "lucide-react";
import { Sheet } from "./ledger/Sheet";
import { deskBrief, type BriefInput } from "./ledger/deskBrief";
import { useLabFeed } from "./ledger/labFeed";
import { isIpoView } from "./ledger/IpoCard";
import { formatMoney, indiaClock, indiaDay, pnlTone } from "./ledger/format";

interface CommanderModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The commander's (Gemini's) note on the market, and whether it's still being written. */
  summaryText?: string;
  isLoading?: boolean;
  /** What the brief is worked out from (the app's own records). */
  desk: Omit<BriefInput, "now" | "ipos">;
}

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="m-0 mt-1 text-xs font-bold text-muted uppercase tracking-[0.08em]">{children}</h3>
);

const Tile: React.FC<{ label: string; children: React.ReactNode; testId: string }> = ({ label, children, testId }) => (
  <div className="min-w-0 bg-surface border border-line rounded-[18px] p-3 flex flex-col gap-0.5" data-testid={testId}>
    <span className="text-xs text-muted">{label}</span>
    {children}
  </div>
);

const rText = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}R`;

// The desk brief (owner's ask, 23 Oct): the day in a headline and three
// figures, what needs you, what each strategy did today, what every stop
// hitting would take, questions answered from the desk's own records
// (deskBrief), and the commander's market note underneath. It can't open or
// close trades.
export const CommanderModal: React.FC<CommanderModalProps> = ({ isOpen, onClose, summaryText, isLoading = false, desk }) => {
  const ipos = useLabFeed("/api/ipos", isIpoView);
  const [asked, setAsked] = useState<string | null>(null);
  // Worked out when it opens (and when what it reads changes while open).
  const now = useMemo(() => Date.now(), [isOpen, desk, ipos]);
  const brief = useMemo(() => deskBrief({ ...desk, ipos, now }), [desk, ipos, now]);
  const answer = brief.answers.find((a) => a.question === asked);

  return (
    <Sheet
      isOpen={isOpen}
      onClose={() => {
        setAsked(null);
        onClose();
      }}
      title="Desk brief"
      subtitle={`${indiaDay(now)} · ${indiaClock(now)} · it can't open or close trades`}
      footer={
        <button type="button" onClick={onClose} className="w-full min-h-12 rounded-full bg-accent text-on-accent font-semibold cursor-pointer">
          Done
        </button>
      }
    >
      <p className="m-0 font-display text-[28px] leading-tight font-semibold" data-testid="brief-headline">
        {brief.headline}
      </p>

      <div className="grid grid-cols-3 gap-2 tabular-nums">
        <Tile label="Today" testId="brief-today">
          <span className={`font-display text-xl font-semibold ${pnlTone(brief.todayPnl)}`}>{formatMoney(brief.todayPnl, { decimals: 0, signed: true })}</span>
        </Tile>
        <Tile label="Open trades" testId="brief-open">
          <span className="font-display text-xl font-semibold">{brief.open}</span>
        </Tile>
        <Tile label="Loss limit used" testId="brief-limit">
          <span className="font-display text-xl font-semibold">{Math.round(brief.limitUsed)}%</span>
          <span className="block h-1 mt-1 rounded-full bg-inset overflow-hidden" aria-hidden="true">
            <span className={`block h-full rounded-full ${brief.limitUsed >= 80 ? "bg-loss" : "bg-accent"}`} style={{ width: `${brief.limitUsed}%` }} />
          </span>
        </Tile>
      </div>

      <section aria-label="Needs you" className="flex flex-col gap-2">
        <SectionLabel>Needs you</SectionLabel>
        {brief.needs.length === 0 ? (
          <div className="bg-surface border border-line rounded-2xl px-3.5 py-3 flex items-center gap-2.5 text-sm" data-testid="brief-calm">
            <CircleCheck className="w-5 h-5 shrink-0 text-gain" strokeWidth={1.8} />
            Nothing: no IPO to apply for, and the server is fine.
          </div>
        ) : (
          brief.needs.map((n) => (
            <div
              key={n.lead}
              data-testid="brief-need"
              className={`rounded-2xl px-3.5 py-3 flex items-start gap-2.5 text-sm leading-snug border ${
                n.tone === "danger" ? "bg-danger-soft border-danger-line text-ink" : "bg-warn-soft border-warn/30 text-warn-ink"
              }`}
            >
              <AlertTriangle className={`w-5 h-5 shrink-0 ${n.tone === "danger" ? "text-loss" : "text-warn"}`} strokeWidth={1.8} />
              <span>
                <strong>{n.lead}</strong> {n.text}
              </span>
            </div>
          ))
        )}
      </section>

      {brief.lines.length > 0 && (
        <section aria-label="What each strategy did" className="flex flex-col gap-2">
          <SectionLabel>What each strategy did today</SectionLabel>
          <ul className="m-0 p-0 list-none bg-surface border border-line rounded-[22px] px-3.5 [&>li+li]:border-t [&>li+li]:border-line">
            {brief.lines.map((l) => (
              <li key={l.label} className="py-3 flex items-start gap-2.5" data-testid="brief-line">
                <span className="shrink-0 mt-0.5 text-[11px] font-bold text-accent bg-accent-soft rounded-full px-2 py-0.5">{l.label}</span>
                <span className="flex-1 min-w-0 text-sm leading-snug">{l.text}</span>
                <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${l.r === null ? "text-muted" : pnlTone(l.r)}`}>
                  {l.r === null ? `${l.open} open` : rText(l.r)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {brief.open > 0 && (
        <section aria-label="If every stop hit" className="flex flex-col gap-2">
          <SectionLabel>If every stop hit</SectionLabel>
          <div className="bg-surface border border-line rounded-[22px] p-3.5 flex flex-col gap-2 tabular-nums" data-testid="brief-stops">
            <div className="flex items-baseline justify-between gap-2">
              <span className={`font-display text-[22px] font-semibold ${pnlTone(brief.stops.net)}`}>{formatMoney(brief.stops.net, { decimals: 0, signed: true })}</span>
              <span className="text-[13px] text-muted">of {formatMoney(brief.stops.left, { decimals: 0 })} left today</span>
            </div>
            <span className="block h-2 rounded-full bg-inset overflow-hidden" aria-hidden="true">
              <span className="block h-full rounded-full bg-loss/80" style={{ width: `${brief.stops.share}%` }} />
            </span>
            <span className="text-[13px] text-muted leading-snug">Before fees. The server watches every stop, day and night.</span>
          </div>
        </section>
      )}

      <section aria-label="Ask about it" className="flex flex-col gap-2">
        <SectionLabel>Ask about it</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {brief.answers.map((a) => (
            <button
              key={a.question}
              type="button"
              aria-pressed={asked === a.question}
              onClick={() => setAsked((q) => (q === a.question ? null : a.question))}
              className={`min-h-10 px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer ${
                asked === a.question ? "bg-accent text-on-accent border-accent" : "bg-surface border-line text-ink"
              }`}
            >
              {a.question}
            </button>
          ))}
        </div>
        {answer && (
          <p className="m-0 bg-surface border border-line rounded-2xl px-3.5 py-3 text-sm leading-relaxed" data-testid="brief-answer">
            {answer.answer}
          </p>
        )}
      </section>

      <section aria-label="The market" className="flex flex-col gap-2">
        <SectionLabel>The market, from the commander</SectionLabel>
        {isLoading ? (
          <div className="flex items-center gap-2.5 py-1 text-sm text-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            Writing the note…
          </div>
        ) : (
          <p className="m-0 text-sm leading-relaxed whitespace-pre-line text-muted" data-testid="brief-market">
            {summaryText || "The commander's note isn't available right now. Trading, risk checks and the guardian don't depend on it."}
          </p>
        )}
      </section>
    </Sheet>
  );
};
