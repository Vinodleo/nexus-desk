import fs from "fs";
import path from "path";
import { formatMoney } from "../src/components/ledger/format";
import { istParts, NSE_CLOSE, NSE_OPEN } from "../src/shared/nse";
import {
  APPLY_ALERT_FROM,
  APPLY_ALERT_LEAD,
  DEFAULT_UPI_CUTOFF,
  HOLD_DAYS,
  IPO_RULE,
  LISTING_TRADES_FROM,
  addDays,
  allotmentDay,
  dayLabel,
  expectedListing,
  fitsIpoRule,
  ipoPlan,
  ipoRecord,
  istDay,
  listingOpen,
  lotShares,
  timeLabel,
  type IpoBids,
  type IpoPlan,
  type IpoRecord,
  type IpoSession,
} from "../src/shared/ipo";
import { toClosedBars } from "../src/services/liveMarketStreamService";
import { fetchListingCandles, fetchListingQuote } from "./angelOne";
import type { PushMessage } from "./push";

// The IPO tracker (src/shared/ipo.ts has the rule): NSE's main-board issues
// bidding now and coming up, how many times over each group has bid, an
// alert on an issue's last bidding day when it fits the rule (apply before
// the UPI cutoff NSE's page gives), and from listing day, for whoever said they got shares, when to sell
// half or all of it, when the price goes under the listing day's low, and a
// week on. Every listed issue's result under the rule, one lot at the issue
// price, is kept as the rule's paper record. Alerts only: it applies for
// nothing and sells nothing. State in ipo.json.

/** An issue as the exchange lists it (main board only). */
export interface IpoListing {
  symbol: string;
  name: string;
  /** Bidding days, India time (YYYY-MM-DD). */
  opens: string;
  closes: string;
  priceLow: number | null;
  priceHigh: number | null;
  lotSize: number | null;
  /** How many times over the whole issue has been bid, when the list says. */
  times?: number | null;
  /** When UPI approvals close on the last day (India minutes), from the issue's page. */
  upiCutoff?: number | null;
}

/** What an issue's own page adds to the list: its lot and the last day's UPI cutoff. */
export interface IpoDetail {
  lotSize: number | null;
  upiCutoff: number | null;
}

/** Where the issues and their bids come from (NSE). */
export interface IpoSource {
  /** Main-board issues bidding now or opening soon. */
  issues(now: number): Promise<IpoListing[]>;
  /** How many times over each group has bid for an issue bidding now; null when not known. */
  bids(symbol: string, now: number): Promise<IpoBids | null>;
  /** The issue's lot and UPI cutoff. */
  detail(symbol: string, now: number): Promise<IpoDetail>;
}

/** A listed issue's prices (Angel One). */
export interface IpoPrices {
  /** Today's open, low and last price; null before it trades. */
  quote(symbol: string): Promise<{ open: number; low: number; ltp: number } | null>;
  /** Its completed daily sessions from `fromDay` on. */
  sessions(symbol: string, fromDay: string, now: number): Promise<IpoSession[]>;
}

/** An issue the tracker follows, from bidding until the rule has sold the lot. */
export interface TrackedIpo extends IpoListing {
  firstSeen: number;
  bids: IpoBids | null;
  /** Why the bids couldn't be read last time; null once they were. */
  bidsError?: string | null;
  /** The day the issue's page was last read (for its lot and UPI cutoff), once a day until both are known. */
  detailRead?: string | null;
  /** The rule's call on the last bids seen, once bidding is over (null while bidding). */
  fit: boolean | null;
  /** The apply alert went out. */
  alerted: boolean;
  listedOn: string | null;
  /** The listing open, once it has traded. */
  open: number | null;
  /** Completed sessions since listing, up to the rule's last sale. */
  sessions: IpoSession[];
  /** The day the sessions were last read (once a day, after the close). */
  sessionsRead: string | null;
  /** Finished: the rule sold the lot, or it never listed. */
  done: boolean;
  /** Whoever said they got shares, with the alerts sent them ("open", "stop", "week"). */
  holders: Record<string, string[]>;
}

interface IpoState {
  ipos: TrackedIpo[];
  lastCheckAt: number | null;
  lastListAt: number | null;
  /** The last time reading the issues failed, and why; cleared by the next success. */
  lastError: string | null;
}

export interface IpoDeps {
  now: () => number;
  dir: () => string;
  source: IpoSource;
  prices: IpoPrices;
  /** To everyone (the apply alert). */
  notifyAll: (message: PushMessage) => void;
  /** To one holder (listing-day and after). */
  notify: (uid: string, message: PushMessage) => void;
}

const STATE_FILE = "ipo.json";
const MIN = 60_000;
const CHECK_EVERY_MS = 15 * MIN;
const LIST_EVERY_MS = 30 * MIN;
/** Outside market days and hours the list is read about twice a day. */
const LIST_QUIET_MS = 12 * 60 * MIN;
const BIDS_EVERY_MS = 15 * MIN;
/** Bidding is over for the rule's call this long after the UPI cutoff, once the last day's book has closed. */
const BIDS_FINAL_AFTER = 45;
/** The day's session is complete for its daily candle a little after the close. */
const SESSION_DONE_AT = NSE_CLOSE + 15;
/** The week's alert goes from this time on the day it's due, so the rest is sold before the close. */
const WEEK_ALERT_AT = 15 * 60;
/** An issue that hasn't listed this long after it was due was withdrawn or delayed for good. */
const GIVE_UP_DAYS = 14;
/** Finished issues kept for the record. */
const KEEP_ISSUES = 300;

const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");

let state: IpoState = { ipos: [], lastCheckAt: null, lastListAt: null, lastError: null };
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function load(dir: string): void {
  try {
    const file = path.join(dir, STATE_FILE);
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved?.ipos)) state = { lastCheckAt: null, lastListAt: null, lastError: null, ...saved };
    }
  } catch (err) {
    console.warn("[IPO] Couldn't read the saved issues:", err);
  }
}

function save(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${STATE_FILE}.tmp`), JSON.stringify(state), "utf8");
    fs.renameSync(path.join(dir, `${STATE_FILE}.tmp`), path.join(dir, STATE_FILE));
  } catch (err) {
    console.warn("[IPO] Couldn't save:", err);
  }
}

// ---------- messages ----------

const times = (x: number | null) => (x === null ? "–" : `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`);
const pctText = (p: number) => `${p >= 0 ? "+" : "−"}${Math.abs(p * 100).toFixed(0)}%`;
const rupees = (x: number) => formatMoney(x, { decimals: 0 });
const price = (x: number) => formatMoney(x, { decimals: x >= 100 || Number.isInteger(x) ? 0 : 2 });

/** The issue price: the top of the band, where heavily bid issues are priced. */
export const issuePriceOf = (ipo: Pick<IpoListing, "priceHigh" | "priceLow">): number | null => ipo.priceHigh ?? ipo.priceLow;

/** The issue's lot: the exchange's, else about ₹15,000 of shares. */
export const lotOf = (ipo: Pick<IpoListing, "priceHigh" | "priceLow" | "lotSize">) => lotShares(ipo.lotSize, issuePriceOf(ipo));

/** When UPI approvals close on the issue's last day (India minutes). */
export const upiCutoffOf = (ipo: Pick<IpoListing, "upiCutoff">) => ipo.upiCutoff ?? DEFAULT_UPI_CUTOFF;

/** The last day's alert: it fits the rule, apply before the UPI cutoff. */
export function applyMessage(ipo: TrackedIpo): PushMessage {
  const p = issuePriceOf(ipo);
  const lot = lotOf(ipo);
  const lotText = p === null || !lot ? "" : lot.estimated ? ` One lot is about ${rupees(p * lot.shares)} at ${price(p)} a share.` : ` One lot is ${rupees(p * lot.shares)} (${lot.shares} shares at ${price(p)}).`;
  return {
    title: `Apply today: ${ipo.name} IPO`,
    body:
      `Institutions bid ${times(ipo.bids?.qib ?? null)}, the whole issue ${times(ipo.bids?.total ?? null)}, retail ${times(ipo.bids?.retail ?? null)}.${lotText} ` +
      `Apply and approve the UPI request by ${timeLabel(upiCutoffOf(ipo))}. Allotment ${dayLabel(allotmentDay(ipo.closes))}, listing ${dayLabel(expectedListing(ipo.closes))}.`,
    tag: `ipo-${ipo.symbol}`,
    url: "/",
  };
}

/** Listing day, at the open: sell half (strong open) or all of it. */
export function openMessage(ipo: TrackedIpo, open: number): PushMessage {
  const issue = issuePriceOf(ipo)!;
  const { pct, strong } = listingOpen(issue, open);
  return strong
    ? {
        title: `${ipo.name} listed ${pctText(pct)}: sell half`,
        body: `It opened at ${price(open)} against the ${price(issue)} issue price. Sell half now. Keep the rest while it stays above today's low, ${HOLD_DAYS} days at most: you'll get an alert for each.`,
        tag: `ipo-${ipo.symbol}`,
        url: "/",
      }
    : {
        title: `${ipo.name} listed ${pctText(pct)}: sell it all`,
        body: `It opened at ${price(open)} against the ${price(issue)} issue price, under the 10% that keeps half. Sell it all today.`,
        tag: `ipo-${ipo.symbol}`,
        url: "/",
      };
}

/** After listing day: the price went under the listing day's low. */
export function stopMessage(ipo: TrackedIpo, ltp: number | null, stop: number): PushMessage {
  return {
    title: `${ipo.name} fell below its listing-day low: sell the rest`,
    body: `${ltp !== null ? `${price(ltp)} now` : "It went"} under ${price(stop)} (the listing day's low). Sell the rest.`,
    tag: `ipo-${ipo.symbol}`,
    url: "/",
  };
}

/** A week on: sell the rest. */
export function weekMessage(ipo: TrackedIpo, ltp: number | null): PushMessage {
  const issue = issuePriceOf(ipo)!;
  return {
    title: `${ipo.name}: a week since listing, sell the rest`,
    body: ltp !== null ? `${price(ltp)} now, ${pctText(ltp / issue - 1)} on the ${price(issue)} issue price. Sell the rest today.` : "Sell the rest today.",
    tag: `ipo-${ipo.symbol}`,
    url: "/",
  };
}

// ---------- the check ----------

const isWeekday = (weekday: number) => weekday >= 1 && weekday <= 5;

function fresh(listing: IpoListing, now: number): TrackedIpo {
  return { ...listing, firstSeen: now, bids: null, fit: null, alerted: false, listedOn: null, open: null, sessions: [], sessionsRead: null, done: false, holders: {} };
}

/** The issues as the exchange lists them now, merged into the ones followed (new ones added; dates, prices and lots updated). */
function mergeListings(listings: IpoListing[], now: number): void {
  for (const l of listings) {
    const known = state.ipos.find((i) => i.symbol === l.symbol);
    if (!known) state.ipos.push(fresh(l, now));
    else if (known.fit === null)
      Object.assign(known, { name: l.name, opens: l.opens, closes: l.closes, priceLow: l.priceLow, priceHigh: l.priceHigh, lotSize: l.lotSize ?? known.lotSize, times: l.times ?? known.times ?? null });
  }
}

/** The rule's lot under its sessions so far (null before listing day is over, or without a price and lot). */
export function planOf(ipo: TrackedIpo): IpoPlan | null {
  const issue = issuePriceOf(ipo);
  const lot = lotOf(ipo);
  if (issue === null || !lot) return null;
  return ipoPlan(issue, lot.shares, ipo.sessions);
}

async function holderAlerts(deps: IpoDeps, ipo: TrackedIpo, today: string, minutes: number): Promise<void> {
  const uids = Object.keys(ipo.holders).filter((uid) => !ipo.holders[uid].includes("done"));
  if (uids.length === 0 || ipo.open === null || ipo.listedOn === null) return;
  const issue = issuePriceOf(ipo);
  if (issue === null) return;
  const { strong } = listingOpen(issue, ipo.open);
  const stop = ipo.sessions[0]?.day === ipo.listedOn ? ipo.sessions[0].low : null;
  const weekDue = today >= addDays(ipo.listedOn, HOLD_DAYS) && minutes >= WEEK_ALERT_AT;
  let ltp: number | null = null;
  if (today !== ipo.listedOn && strong && (stop !== null || weekDue)) {
    try {
      ltp = (await deps.prices.quote(ipo.symbol))?.ltp ?? null;
    } catch (err: any) {
      console.warn(`[IPO] Couldn't read ${ipo.symbol}'s price:`, err?.message ?? err);
    }
  }
  // A dip under the stop between two looks still shows in the day's low: the rule's own sale says so after the close.
  const ruled = planOf(ipo);
  const ruledStop = ruled?.held === 0 && ruled.sales[ruled.sales.length - 1].why === "stop";
  for (const uid of uids) {
    const sent = ipo.holders[uid];
    if (!sent.includes("open")) {
      deps.notify(uid, openMessage(ipo, ipo.open));
      sent.push("open");
      if (!strong) sent.push("done");
      continue;
    }
    if (!strong || today === ipo.listedOn) continue;
    if (stop !== null && ((ltp !== null && ltp < stop) || ruledStop)) {
      deps.notify(uid, stopMessage(ipo, ltp, stop));
      sent.push("stop", "done");
    } else if (weekDue) {
      deps.notify(uid, weekMessage(ipo, ltp));
      sent.push("week", "done");
    }
  }
}

/** One pass: the list, the bids, the apply alert, listing, holders' alerts and the sessions for the record. */
export async function runIpoCheck(deps: IpoDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = deps.now();
    const { day: today, weekday, minutes } = istParts(now);
    const marketDay = isWeekday(weekday);

    // The exchange's list: every half hour on market days, else twice a day.
    const listDue = state.lastListAt === null || now - state.lastListAt >= (marketDay && minutes >= 9 * 60 && minutes <= 18 * 60 ? LIST_EVERY_MS : LIST_QUIET_MS);
    if (listDue) {
      try {
        mergeListings(await deps.source.issues(now), now);
        state.lastListAt = now;
        state.lastError = null;
      } catch (err: any) {
        state.lastError = err?.message ?? String(err);
        console.warn("[IPO] Couldn't read NSE's issues:", state.lastError);
      }
    }

    for (const ipo of state.ipos) {
      if (ipo.done) continue;

      // Bidding: the book every 15 minutes, the alert on the last day.
      if (ipo.fit === null) {
        const bidding = today >= ipo.opens && today <= ipo.closes && marketDay && minutes >= 9 * 60;
        if (bidding && (!ipo.bids || now - ipo.bids.at >= BIDS_EVERY_MS)) {
          try {
            ipo.bids = (await deps.source.bids(ipo.symbol, now)) ?? ipo.bids;
            ipo.bidsError = null;
          } catch (err: any) {
            ipo.bidsError = err?.message ?? String(err);
            console.warn(`[IPO] Couldn't read ${ipo.symbol}'s bids:`, ipo.bidsError);
          }
        }
        // The issue's page, for its lot and the last day's UPI cutoff: once a day until both are known.
        if (today >= ipo.opens && marketDay && minutes >= 9 * 60 && ipo.detailRead !== today && (ipo.lotSize == null || ipo.upiCutoff == null)) {
          try {
            const d = await deps.source.detail(ipo.symbol, now);
            ipo.lotSize ??= d.lotSize;
            ipo.upiCutoff ??= d.upiCutoff;
            ipo.detailRead = today;
          } catch (err: any) {
            console.warn(`[IPO] Couldn't read ${ipo.symbol}'s page:`, err?.message ?? err);
          }
        }
        const cutoff = upiCutoffOf(ipo);
        if (today === ipo.closes && !ipo.alerted && minutes >= APPLY_ALERT_FROM && minutes <= cutoff - APPLY_ALERT_LEAD && fitsIpoRule(ipo.bids)) {
          deps.notifyAll(applyMessage(ipo));
          ipo.alerted = true;
        }
        if (today > ipo.closes || (today === ipo.closes && minutes >= cutoff + BIDS_FINAL_AFTER)) {
          ipo.fit = fitsIpoRule(ipo.bids);
          // Never bid for (withdrawn, or no figure for its book at all): nothing for the rule to judge.
          if (!ipo.bids && ipo.times == null) ipo.done = true;
        }
        continue;
      }

      // Listing: the open from the day's quote, during the session. Past the
      // expected day, an earlier session (a server down at the listing) comes first.
      const due = expectedListing(ipo.closes);
      if (ipo.listedOn === null && today >= due && marketDay && minutes >= LISTING_TRADES_FROM && minutes < NSE_CLOSE) {
        try {
          const q = await deps.prices.quote(ipo.symbol);
          if (q && q.open > 0) {
            const earlier = today > due ? (await deps.prices.sessions(ipo.symbol, due, now)).filter((s) => s.day < today) : [];
            ipo.listedOn = earlier[0]?.day ?? today;
            ipo.open = earlier[0]?.open ?? q.open;
            if (earlier.length > 0) ipo.sessions = earlier;
          }
        } catch (err: any) {
          console.warn(`[IPO] Couldn't read ${ipo.symbol}'s price:`, err?.message ?? err);
        }
      }

      // After the close: the completed sessions, for the record (and the listing, if the server missed the open).
      if (today >= due && ipo.sessionsRead !== today && (minutes >= SESSION_DONE_AT || !marketDay) && planOf(ipo)?.held !== 0) {
        try {
          const sessions = await deps.prices.sessions(ipo.symbol, ipo.listedOn ?? due, now);
          // Today's candle can come a little after the close: until it has, look again at the next check.
          if (!marketDay || sessions.some((s) => s.day === today)) ipo.sessionsRead = today;
          if (sessions.length > 0) {
            ipo.listedOn ??= sessions[0].day;
            ipo.open ??= sessions[0].open;
            const plan = ipoPlan(issuePriceOf(ipo) ?? 0, lotOf(ipo)?.shares ?? 0, sessions);
            const lastSale = plan?.held === 0 ? plan.sales[plan.sales.length - 1].day : null;
            ipo.sessions = lastSale ? sessions.filter((s) => s.day <= lastSale) : sessions;
          }
        } catch (err: any) {
          console.warn(`[IPO] Couldn't read ${ipo.symbol}'s sessions:`, err?.message ?? err);
        }
      }

      if (marketDay && minutes >= NSE_OPEN && minutes < NSE_CLOSE) await holderAlerts(deps, ipo, today, minutes);

      const plan = planOf(ipo);
      const holdersDone = Object.values(ipo.holders).every((sent) => sent.includes("done"));
      if ((plan?.result && holdersDone) || (ipo.listedOn === null && today > addDays(due, GIVE_UP_DAYS))) ipo.done = true;
      // Without a price and lot there's no record to keep: finished once a week on.
      if (!plan && ipo.listedOn !== null && today > addDays(ipo.listedOn, HOLD_DAYS + 3) && holdersDone) ipo.done = true;
    }

    if (state.ipos.length > KEEP_ISSUES) state.ipos = state.ipos.slice(-KEEP_ISSUES);
    state.lastCheckAt = now;
    save(deps.dir());
  } finally {
    running = false;
  }
}

// ---------- holders and the view ----------

/** Marks (or unmarks) that this user got shares in an issue whose bidding is over and isn't finished. False if there's no such issue. */
export function setHolding(uid: string, symbol: string, held: boolean, dir: string = dataDir()): boolean {
  const ipo = state.ipos.find((i) => i.symbol === symbol);
  if (!ipo || ipo.fit === null || ipo.done) return false;
  if (held) ipo.holders[uid] ??= [];
  else delete ipo.holders[uid];
  save(dir);
  return true;
}

export interface IpoRow {
  symbol: string;
  name: string;
  opens: string;
  closes: string;
  priceLow: number | null;
  priceHigh: number | null;
  lotSize: number | null;
  /** The lot isn't the exchange's figure but about ₹15,000 of shares. */
  lotEstimated: boolean;
  /** When UPI approvals close on the last day (India minutes). */
  upiCutoff: number;
  /** One lot at the issue price. */
  lotCost: number | null;
  bids: IpoBids | null;
  bidsError: string | null;
  fits: boolean;
  /** The rule's call once bidding is over. */
  fit: boolean | null;
  allotmentOn: string;
  listsOn: string;
  listedOn: string | null;
  open: number | null;
  openPct: number | null;
  plan: IpoPlan | null;
  /** This user said they got shares. */
  held: boolean;
}

export interface IpoView {
  rule: typeof IPO_RULE;
  /** Bidding now (opened, not closed). */
  bidding: IpoRow[];
  /** Opening later. */
  upcoming: IpoRow[];
  /** Bidding over: waiting to list, or listed and the rule's lot not yet sold (or sold in the last week). */
  recent: IpoRow[];
  /** Every listed issue's result under the rule: the ones it picked and the ones it skipped. */
  record: { picked: IpoRecord; skipped: IpoRecord; rows: { symbol: string; name: string; listedOn: string; fit: boolean; pct: number; rupees: number }[] };
  lastCheckAt: number | null;
  lastError: string | null;
  nextAt: number;
}

function rowOf(ipo: TrackedIpo, uid: string): IpoRow {
  const issue = issuePriceOf(ipo);
  const lot = lotOf(ipo);
  return {
    symbol: ipo.symbol,
    name: ipo.name,
    opens: ipo.opens,
    closes: ipo.closes,
    priceLow: ipo.priceLow,
    priceHigh: ipo.priceHigh,
    lotSize: lot?.shares ?? null,
    lotEstimated: lot?.estimated ?? false,
    upiCutoff: upiCutoffOf(ipo),
    lotCost: issue !== null && lot ? issue * lot.shares : null,
    // Without the book by group, the list's figure for the whole issue.
    bids: ipo.bids ?? (ipo.times != null ? { qib: null, nii: null, retail: null, total: ipo.times, at: ipo.firstSeen } : null),
    bidsError: ipo.bidsError ?? null,
    fits: fitsIpoRule(ipo.bids),
    fit: ipo.fit,
    allotmentOn: allotmentDay(ipo.closes),
    listsOn: ipo.listedOn ?? expectedListing(ipo.closes),
    listedOn: ipo.listedOn,
    open: ipo.open,
    openPct: ipo.open !== null && issue !== null ? listingOpen(issue, ipo.open).pct : null,
    plan: planOf(ipo),
    held: uid in ipo.holders,
  };
}

export function ipoView(uid: string, now: number = Date.now()): IpoView {
  const today = istParts(now).day;
  const rows = state.ipos.map((i) => ({ ipo: i, row: rowOf(i, uid) }));
  const finished = rows.filter(({ row }) => row.plan?.result && row.fit !== null);
  const result = (r: IpoRow) => r.plan!.result!;
  const lastSale = (r: IpoRow) => r.plan!.sales[r.plan!.sales.length - 1].day;
  return {
    rule: IPO_RULE,
    bidding: rows.filter(({ ipo }) => ipo.fit === null && today >= ipo.opens).map(({ row }) => row),
    upcoming: rows.filter(({ ipo }) => ipo.fit === null && today < ipo.opens).map(({ row }) => row).sort((a, b) => a.opens.localeCompare(b.opens)),
    // Bidding over and not given up on: until a week after the rule's last sale, or while a holder's alerts are due.
    recent: rows
      .filter(({ ipo, row }) => {
        if (ipo.fit === null || (ipo.done && ipo.listedOn === null)) return false;
        return !row.plan?.result || today <= addDays(lastSale(row), 7) || (row.held && !ipo.done);
      })
      .map(({ row }) => row),
    record: {
      picked: ipoRecord(finished.filter(({ row }) => row.fit).map(({ row }) => result(row))),
      skipped: ipoRecord(finished.filter(({ row }) => !row.fit).map(({ row }) => result(row))),
      rows: finished
        .map(({ row }) => ({ symbol: row.symbol, name: row.name, listedOn: row.listedOn!, fit: !!row.fit, pct: result(row).pct, rupees: result(row).rupees }))
        .sort((a, b) => b.listedOn.localeCompare(a.listedOn)),
    },
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    nextAt: (state.lastCheckAt ?? now) + CHECK_EVERY_MS,
  };
}

// ---------- prices (Angel One) ----------

/** Daily candles (getCandleData rows) as the sessions that are over by `now`: today's once the close is past. */
export function completedSessions(raw: unknown, now: number): IpoSession[] {
  const { day: today, minutes } = istParts(now);
  return toClosedBars(raw, 0, Number.POSITIVE_INFINITY)
    .map((b) => ({ day: istDay(b.timestampMs!), open: b.open, high: b.high, low: b.low, close: b.close }))
    .filter((s) => s.day < today || (s.day === today && minutes >= SESSION_DONE_AT));
}

export const angelIpoPrices: IpoPrices = {
  quote: (symbol) => fetchListingQuote(symbol),
  sessions: async (symbol, fromDay, now) => completedSessions(await fetchListingCandles(symbol, Date.parse(`${fromDay}T00:00:00+05:30`), now), now),
};

// ---------- start ----------

/** Checks every 15 minutes (first a couple of minutes after start). */
export function startIpoTracker(deps: Omit<IpoDeps, "now" | "dir">): void {
  load(dataDir());
  const full: IpoDeps = { now: () => Date.now(), dir: dataDir, ...deps };
  const check = () => {
    timer = setTimeout(check, CHECK_EVERY_MS);
    runIpoCheck(full).catch((err) => console.warn("[IPO] Check failed:", err?.message ?? err));
  };
  timer = setTimeout(check, 2 * MIN);
}

/** Test hooks. */
export function _resetIpoTracker(dir?: string): void {
  state = { ipos: [], lastCheckAt: null, lastListAt: null, lastError: null };
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  if (dir) load(dir);
}
export const _ipoState = () => state;
