import type { HistoricalTrade, Position } from "../../types";
import { istDay } from "../../shared/deskMoney";
import { DEFAULT_UPI_CUTOFF, timeLabel } from "../../shared/ipo";
import type { ServerStatus } from "../../hooks/useServerStatus";
import { exitWords, strategyOf } from "./BookMoney";
import { nextOnDesk, istClock, untilText } from "./FloorDesk";
import { allStops } from "./RiskGlance";
import { resultR } from "./LedgerBook";
import { formatMoney } from "./format";
import type { IpoView } from "./IpoCard";

// The desk brief (Settings → Desk → Desk brief, owner's ask, 23 Oct): the
// day in a headline and three figures, what needs the owner, what each
// strategy did today, what every stop hitting would take, and a few
// questions answered from the desk's own records. Worked out on the phone
// from what the app already holds, so it's there even when the commander
// (Gemini) isn't; its market note follows underneath.

export interface BriefInput {
  now: number;
  closed: readonly HistoricalTrade[];
  positions: readonly Position[];
  /** Today's result from closes (India's day), the daily loss limit and what today lost of it. */
  todayPnl: number;
  lossLimit: number;
  todayLoss: number;
  /** Trading stopped (Stop all, or the loss streak's pause). */
  stopped: boolean;
  /** The IPOs, when the Lab has read them. */
  ipos?: IpoView | null;
  /** The server's health, when Settings has read it. */
  server?: ServerStatus | null;
}

export interface BriefNeed {
  tone: "warn" | "danger";
  /** Said first, in bold. */
  lead: string;
  text: string;
}

export interface BriefLine {
  label: string;
  text: string;
  /** Today's closes in R after fees, summed; null when none closed today. */
  r: number | null;
  open: number;
}

export interface Brief {
  headline: string;
  todayPnl: number;
  open: number;
  /** Share of today's loss limit used, 0–100. */
  limitUsed: number;
  needs: BriefNeed[];
  lines: BriefLine[];
  stops: { net: number; left: number; share: number };
  answers: { question: string; answer: string }[];
}

const money = (n: number, signed = false) => formatMoney(n, { decimals: 0, signed });
const rText = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}R`;
const shortSymbol = (s: string) => s.replace(/\/INR$|\.US$/, "");
const names = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const closedAt = (t: HistoricalTrade) => t.closedAtMs ?? Date.parse(t.closedAt);
const openedAt = (p: Position) => Date.parse(p.openTime);

/** The order strategies are told in: the slower ones first. */
const ORDER = ["Coin breakout", "US breakout", "Funds breakout", "US momentum", "Daily traders", "5-minute traders"];

function heldFor(t: HistoricalTrade): string {
  const mins = t.holdingDurationMinutes ?? (t.openedAtMs && t.closedAtMs ? Math.round((t.closedAtMs - t.openedAtMs) / 60000) : null);
  if (mins === null || mins < 0) return "";
  if (mins < 60) return ` after ${Math.max(1, mins)} min`;
  const h = Math.round(mins / 60);
  return h < 48 ? ` after ${h} h` : ` after ${Math.round(h / 24)} days`;
}

/** What one strategy did today: bought, sold (how and in R) and still holds. */
function lineFor(label: string, closes: HistoricalTrade[], open: Position[], today: string): BriefLine {
  const bought = open.filter((p) => istDay(openedAt(p)) === today).map((p) => shortSymbol(p.symbol));
  const holds = open.filter((p) => istDay(openedAt(p)) !== today).map((p) => shortSymbol(p.symbol));
  const rs = closes.map(resultR).filter((r): r is number => r !== null);
  const parts: string[] = [];
  if (bought.length) parts.push(`Bought ${names(bought)}`);
  for (const t of closes) {
    const r = resultR(t);
    parts.push(`Sold ${shortSymbol(t.symbol)} (${exitWords(t).toLowerCase()})${r !== null ? ` at ${rText(r)}` : ` for ${money(t.realizedPnl, true)}`}`);
  }
  if (holds.length) parts.push(`${parts.length ? "holds" : "Holds"} ${names(holds)}`);
  return { label, text: `${parts.join("; ")}.`, r: rs.length ? rs.reduce((a, b) => a + b, 0) : null, open: open.length };
}

export function deskBrief(input: BriefInput): Brief {
  const { now } = input;
  const today = istDay(now);
  const closesToday = input.closed.filter((t) => istDay(closedAt(t)) === today);
  const openedToday = input.positions.filter((p) => istDay(openedAt(p)) === today);
  const limitUsed = input.lossLimit > 0 ? Math.min(100, (input.todayLoss / input.lossLimit) * 100) : 0;

  const headline = input.stopped
    ? "Trading is stopped"
    : closesToday.length === 0 && openedToday.length === 0
      ? "A quiet day so far"
      : input.todayPnl > 0
        ? `Up ${money(input.todayPnl)} today`
        : input.todayPnl < 0
          ? `Down ${money(-input.todayPnl)} today`
          : "Even so far today";

  // What needs the owner, the most pressing first.
  const needs: BriefNeed[] = [];
  if (input.stopped) needs.push({ tone: "danger", lead: "Trading is stopped.", text: "No new trades open until you resume it on the Floor. The stops are still watched." });
  if (!input.stopped && limitUsed >= 80)
    needs.push({ tone: "danger", lead: `${Math.round(limitUsed)}% of today's loss limit is used.`, text: "One more loss may stop new trades until tomorrow." });
  const nowMin = Math.round(((now + 330 * 60_000) % 86_400_000) / 60_000);
  for (const ipo of input.ipos?.bidding ?? []) {
    const cutoff = ipo.upiCutoff ?? DEFAULT_UPI_CUTOFF;
    if (ipo.fits && ipo.closes === today && nowMin < cutoff)
      needs.push({ tone: "warn", lead: `${ipo.name} fits the IPO rule.`, text: `Apply and approve the UPI request by ${timeLabel(cutoff)}.` });
  }
  const backup = input.server?.backup;
  if (backup?.configured && backup.lastError && (!backup.lastAt || (backup.lastErrorAt ?? 0) > backup.lastAt))
    needs.push({ tone: "warn", lead: "The last backup failed.", text: "Settings → Server → Backups says why; it tries again every hour." });
  if (input.server?.scanner.stalled) needs.push({ tone: "danger", lead: "The scanner has stopped.", text: "Settings → Server → Recent log shows what it wrote last." });

  // Each strategy with anything open or closed today.
  const labels = new Set<string>([...closesToday.map(strategyOf), ...input.positions.map((p) => strategyOf(p))]);
  const lines = [...labels]
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    .map((label) =>
      lineFor(
        label,
        closesToday.filter((t) => strategyOf(t) === label).sort((a, b) => closedAt(a) - closedAt(b)),
        input.positions.filter((p) => strategyOf(p) === label),
        today
      )
    );

  const stops = allStops([...input.positions], input.lossLimit);
  const left = Math.max(0, input.lossLimit - input.todayLoss);

  // A few questions answered from the desk's own records.
  const answers: Brief["answers"] = [];
  const lastClose = [...input.closed].filter((t) => now - closedAt(t) < 3 * 86_400_000).sort((a, b) => closedAt(b) - closedAt(a))[0];
  if (lastClose) {
    const r = resultR(lastClose);
    answers.push({
      question: `Why did ${shortSymbol(lastClose.symbol)} sell?`,
      answer: `${exitWords(lastClose)}${heldFor(lastClose)}. It ${r !== null ? `ended at ${rText(r)}, ` : ""}${lastClose.realizedPnl >= 0 ? "kept" : "lost"} ${money(Math.abs(lastClose.realizedPnl))} after ${money(lastClose.feesPaid ?? 0)} fees (${strategyOf(lastClose).toLowerCase()}).`,
    });
  }
  const next = nextOnDesk(now, 3);
  if (next.length)
    answers.push({
      question: "What's next?",
      answer: next.map((s) => `${s.title} ${untilText(s.at, now)} (${istClock(s.at).day} ${istClock(s.at).time} ${istClock(s.at).half})`).join("; ") + ".",
    });
  answers.push({
    question: "How much is at risk?",
    answer:
      input.positions.length === 0
        ? "Nothing is open, so nothing is at risk."
        : stops.net >= 0
          ? `Every open stop is past break-even: if they all hit, the desk keeps ${money(stops.net)} before fees.`
          : `If every stop hit, the desk would lose ${money(-stops.net)} before fees: ${Math.round(stops.share)}% of today's ${money(input.lossLimit)} limit, with ${money(left)} of it left.`,
  });

  return { headline, todayPnl: input.todayPnl, open: input.positions.length, limitUsed, needs, lines, stops: { net: stops.net, left, share: stops.share }, answers };
}
