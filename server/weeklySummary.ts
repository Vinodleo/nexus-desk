import fs from "fs";
import path from "path";
import type { HistoricalTrade } from "../src/types";
import { paperScore, SCORECARD_FAIR_TRADES, type PaperStrategy } from "../src/services/paperScorecard";
import { formatMoney } from "../src/components/ledger/format";
import { closedTradesFor, daemonPositions, type DaemonClosedTrade, type DaemonPosition } from "./guardian";
import { scanningDesks } from "./scanner/deskState";
import { dailyCoinsView } from "./scanner/dailyCoins";
import { fundsBreakoutView, usBreakoutView } from "./scanner/usBreakout";
import { usMomentumView } from "./scanner/usMomentum";
import type { PushMessage } from "./push";

// A pop-up every Sunday at 10 am India time: the week's trades (closed,
// won, still open, what they made) and how each slower strategy's paper
// trades so far compare with its replay, as the Lab's scorecard judges them.
// From the trades the server closed (it keeps the last 200). A server that
// was down at 10 sends it when it's back, until Tuesday; a week with nothing
// open, closed or traded so far sends nothing.

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Sunday, 10:00 in India. */
const SEND_MINUTE_IST = 10 * 60;
/** A summary missed by more than this (server down) isn't sent late. */
const LATE_LIMIT_MS = 2 * DAY_MS;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const STATE_FILE = "weekly_summary.json";

/** The slower strategies, by the short names the pop-up uses. */
const STRATEGIES: { id: Exclude<PaperStrategy, "dailyCoins">; name: string }[] = [
  { id: "coinBreakout", name: "Coin breakout" },
  { id: "usBreakout", name: "US breakout" },
  { id: "fundsBreakout", name: "Funds breakout" },
  { id: "usMomentum", name: "US momentum" },
];

const rSigned = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

/** The most recent Sunday 10:00 India time at or before `now`, as a time and as its day. */
export function lastSendTime(now: number): { at: number; week: string } {
  const ist = now + IST_OFFSET_MS;
  const dayStart = Math.floor(ist / DAY_MS) * DAY_MS;
  const sinceSunday = new Date(dayStart).getUTCDay();
  let sendIst = dayStart - sinceSunday * DAY_MS + SEND_MINUTE_IST * 60 * 1000;
  if (sendIst > ist) sendIst -= 7 * DAY_MS;
  return { at: sendIst - IST_OFFSET_MS, week: new Date(sendIst).toISOString().slice(0, 10) };
}

/** Due: this week's hasn't gone yet, and it isn't more than two days late. */
export function summaryDue(now: number, lastWeek: string | null): boolean {
  const { at, week } = lastSendTime(now);
  return lastWeek !== week && now - at < LATE_LIMIT_MS;
}

/**
 * The pop-up for one desk: the week's closed trades (the 7 days to `now`),
 * the trades still open, and each slower strategy with trades so far against
 * its replay's average (`replays`, null without one). Null with nothing to say.
 */
export function weeklySummaryMessage(
  trades: DaemonClosedTrade[],
  open: Pick<DaemonPosition, "symbol" | "strategy" | "timeframe" | "isLiveOrder">[],
  replays: Partial<Record<PaperStrategy, number | null>>,
  now: number
): PushMessage | null {
  const week = trades.filter((t) => now - Date.parse(t.closedAt) < 7 * DAY_MS && Date.parse(t.closedAt) <= now);
  const pnl = week.reduce((a, t) => a + t.realizedPnl, 0);
  const won = week.filter((t) => t.realizedPnl > 0).length;
  const live = week.filter((t) => t.isLiveOrder).length + open.filter((p) => p.isLiveOrder).length;

  const scores = STRATEGIES.map(({ id, name }) => {
    const replay = replays[id];
    return { name, replay, score: paperScore(id, trades as unknown as HistoricalTrade[], open, replay === null || replay === undefined ? null : { avgR: replay }) };
  }).filter(({ score }) => score.closed > 0 || score.open > 0);
  if (week.length === 0 && open.length === 0 && scores.length === 0) return null;

  const parts: string[] = [];
  parts.push(
    week.length > 0
      ? `${week.length} closed (${won} won), ${open.length} still open.`
      : `No trades closed; ${open.length} open.`
  );
  // A strategy clearly behind its replay first: that's what to look at.
  const behind = scores.filter(({ score }) => score.verdict === "behind");
  for (const { name } of behind) parts.push(`${name} is behind its replay: see the Lab's scorecard.`);
  for (const { name, replay, score } of scores) {
    if (score.closed === 0) {
      parts.push(`${name}: ${score.open} open, none closed yet.`);
      continue;
    }
    const verdict = { early: "", inLine: ", in line", behind: ", behind", ahead: ", ahead" }[score.verdict];
    const vs = replay === null || replay === undefined ? "" : ` (replay ${rSigned(replay)}${verdict})`;
    parts.push(`${name}: ${score.closed} closed so far, ${rSigned(score.avgR!)} a trade${vs}.`);
  }
  if (scores.length > 0 && scores.every(({ score }) => score.verdict === "early"))
    parts.push(`Too early to judge: it takes about ${SCORECARD_FAIR_TRADES} trades each.`);

  const where = live > 0 ? "" : " on paper";
  return {
    title: week.length > 0 ? `Your week${where}: ${formatMoney(pnl, { signed: true, decimals: 0 })}` : `Your week${where}: nothing closed`,
    body: parts.join(" "),
    tag: "weekly-summary",
    url: "/",
  };
}

export interface WeeklySummaryDeps {
  now: () => number;
  dir: () => string;
  desks: () => string[];
  trades: (uid: string) => DaemonClosedTrade[];
  open: (uid: string) => DaemonPosition[];
  replays: (uid: string) => Partial<Record<PaperStrategy, number | null>>;
  notify: (uid: string, message: PushMessage) => void;
}

const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");

const realDeps: Omit<WeeklySummaryDeps, "notify"> = {
  now: () => Date.now(),
  dir: dataDir,
  desks: () => scanningDesks().map(([uid]) => uid),
  trades: closedTradesFor,
  open: (uid) => [...daemonPositions.values()].filter((p) => p.userId === uid),
  replays: (uid) => ({
    coinBreakout: dailyCoinsView(uid).breakout?.avgR ?? null,
    usBreakout: usBreakoutView(uid).gate?.avgR ?? null,
    fundsBreakout: fundsBreakoutView(uid).gate?.avgR ?? null,
    usMomentum: usMomentumView(uid).gate?.avgR ?? null,
  }),
};

let lastWeek: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function load(dir: string): void {
  try {
    const file = path.join(dir, STATE_FILE);
    if (fs.existsSync(file)) lastWeek = JSON.parse(fs.readFileSync(file, "utf8"))?.lastWeek ?? null;
  } catch {}
}

function save(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${STATE_FILE}.tmp`), JSON.stringify({ lastWeek }), "utf8");
    fs.renameSync(path.join(dir, `${STATE_FILE}.tmp`), path.join(dir, STATE_FILE));
  } catch {}
}

/** Sends each desk its summary if this week's is due. True when it sent (or had nothing to say). */
export function runWeeklySummary(deps: WeeklySummaryDeps): boolean {
  const now = deps.now();
  if (!summaryDue(now, lastWeek)) return false;
  for (const uid of deps.desks()) {
    const message = weeklySummaryMessage(deps.trades(uid), deps.open(uid), deps.replays(uid), now);
    if (message) deps.notify(uid, message);
  }
  lastWeek = lastSendTime(now).week;
  save(deps.dir());
  return true;
}

/** Looks every half hour whether the week's summary is due. */
export function startWeeklySummary(notify: WeeklySummaryDeps["notify"]): void {
  load(dataDir());
  const deps = { ...realDeps, notify };
  const check = () => {
    timer = setTimeout(check, CHECK_EVERY_MS);
    try {
      runWeeklySummary(deps);
    } catch (err) {
      console.error("[WeeklySummary] Couldn't send:", err);
    }
  };
  timer = setTimeout(check, 60 * 1000);
}

/** Test hooks. */
export function _resetWeeklySummary(dir?: string): void {
  lastWeek = null;
  if (timer) clearTimeout(timer);
  timer = null;
  if (dir) load(dir);
}
