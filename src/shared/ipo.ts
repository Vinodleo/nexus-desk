import {
  GST_RATE,
  IST_OFFSET_MS,
  NSE_BROKERAGE_CAP,
  NSE_BROKERAGE_MIN,
  NSE_BROKERAGE_RATE,
  NSE_DP_CHARGE,
  NSE_EXCHANGE_RATE,
  NSE_SEBI_RATE,
  NSE_STT_DELIVERY,
} from "./nse";

// IPOs on NSE's main board (owner's ask, 22 Oct; the Lab's IPO card,
// server/ipoTracker.ts). The desk doesn't apply for them or sell them: it
// says when. The rule: apply on the last bidding day to an issue the big
// institutions (QIBs) bid for many times over, and the issue as a whole
// too; on listing day sell half at the open if it opened strongly, else all
// of it; keep the rest at most a week, sold if the price falls below the
// listing day's low. Each listed issue's result under the rule, as if one
// lot was allotted at the issue price, is its paper record: the issues the
// rule picked against the ones it skipped.

/** How many times over each group bid for the shares set aside for it, as of `at`. */
export interface IpoBids {
  /** Qualified institutional buyers: mutual funds, banks, insurers, foreign funds. */
  qib: number | null;
  /** Non-institutional: wealthy investors bidding above ₹2 lakh. */
  nii: number | null;
  /** Retail: up to ₹2 lakh. */
  retail: number | null;
  total: number | null;
  at: number;
}

/** The rule: institutions bid at least `qib` times the shares for them, and the whole issue at least `total` times. */
export const IPO_RULE = { qib: 20, total: 10 } as const;

export function fitsIpoRule(bids: IpoBids | null | undefined): boolean {
  return !!bids && (bids.qib ?? 0) >= IPO_RULE.qib && (bids.total ?? 0) >= IPO_RULE.total;
}

/** SEBI sizes a main-board retail lot at about this much; used when the exchange's list doesn't give the lot. */
export const RETAIL_LOT_RUPEES = 15_000;

/** Shares in a lot: the exchange's figure, else about `RETAIL_LOT_RUPEES` at the issue price. */
export function lotShares(lotSize: number | null | undefined, issuePrice: number | null): { shares: number; estimated: boolean } | null {
  if (lotSize && lotSize > 0) return { shares: lotSize, estimated: false };
  if (!(issuePrice && issuePrice > 0)) return null;
  return { shares: Math.max(1, Math.floor(RETAIL_LOT_RUPEES / issuePrice)), estimated: true };
}

/** Opened at least this far above the issue price: sell half at the open and keep half. Under it, sell it all. */
export const STRONG_OPEN = 0.1;
/** The rest is sold, at the latest, on the first session this many days after listing. */
export const HOLD_DAYS = 7;
/** On the last bidding day, the apply alert goes from this time (India minutes) while the issue fits the rule. */
export const APPLY_ALERT_FROM = 14 * 60;
/** UPI approvals close at this time on the last day (India minutes) when NSE's page doesn't say: SEBI's 5 pm. */
export const DEFAULT_UPI_CUTOFF = 17 * 60;
/** The apply alert stops this long before the UPI cutoff: too little time left to apply. */
export const APPLY_ALERT_LEAD = 10;

/** "7 pm", "5:30 pm", from India minutes after midnight. */
export function timeLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}
/** Main-board listings start trading at 10 am, after an hour of pre-open bidding. */
export const LISTING_TRADES_FROM = 10 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `day` (YYYY-MM-DD) plus `n` calendar days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** `day` plus `n` weekdays (exchange holidays aren't known here). */
export function addWeekdays(day: string, n: number): string {
  let d = day;
  for (let left = n; left > 0; ) {
    d = addDays(d, 1);
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) left--;
  }
  return d;
}

/** "Thu 22 Oct". */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

/** India's day (YYYY-MM-DD) at `ms`. */
export const istDay = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Allotment is due the working day after bidding closes, and listing two after that (SEBI's T+3). */
export const allotmentDay = (closes: string) => addWeekdays(closes, 1);
export const expectedListing = (closes: string) => addWeekdays(closes, 3);

/** One session's prices after listing. */
export interface IpoSession {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A sale the rule makes: at the open (half, or all on a weak open), below the listing day's low, or a week on. */
export interface IpoSale {
  day: string;
  price: number;
  shares: number;
  why: "open" | "weak-open" | "stop" | "week";
}

/** What the rule did with one lot over the sessions so far. */
export interface IpoPlan {
  open: number;
  /** The listing open against the issue price (0.25 is 25% up). */
  openPct: number;
  strong: boolean;
  /** The listing day's low: the rest is sold if the price goes under it. Null on a weak open (nothing kept). */
  stop: number | null;
  /** The rest is sold on the first session on or after this day. */
  sellBy: string;
  sales: IpoSale[];
  /** Shares still held. */
  held: number;
  /** Once every share is sold: the lot's result after sale costs, in rupees and as a share of what it cost. */
  result: { rupees: number; pct: number } | null;
}

/** The listing open against the issue price, and whether it was strong enough to keep half. */
export function listingOpen(issuePrice: number, open: number): { pct: number; strong: boolean } {
  const pct = open / issuePrice - 1;
  return { pct, strong: pct >= STRONG_OPEN };
}

/**
 * A sale's charges at Angel One (delivery): brokerage, STT, exchange and
 * SEBI charges, the depository's charge, and GST. Allotment itself costs
 * nothing.
 */
export function ipoSaleCosts(value: number): number {
  if (!(value > 0)) return 0;
  const brokerage = Math.max(NSE_BROKERAGE_MIN, Math.min(NSE_BROKERAGE_CAP, value * NSE_BROKERAGE_RATE));
  const exchange = value * NSE_EXCHANGE_RATE;
  const sebi = value * NSE_SEBI_RATE;
  const stt = value * NSE_STT_DELIVERY;
  return brokerage + exchange + sebi + stt + NSE_DP_CHARGE + GST_RATE * (brokerage + exchange + sebi + NSE_DP_CHARGE);
}

/**
 * The rule on one lot over its completed sessions (listing day first): half
 * at the listing open when it opened strongly (all of it otherwise); the
 * rest at the next session's open if that's under the listing day's low,
 * else at that low if the session went under it, else at the close of the
 * first session a week on. Null before the listing day's session is over.
 */
export function ipoPlan(issuePrice: number, lot: number, sessions: IpoSession[]): IpoPlan | null {
  const days = [...sessions].sort((a, b) => a.day.localeCompare(b.day));
  const first = days[0];
  if (!first || !(issuePrice > 0) || !(lot > 0)) return null;
  const { pct, strong } = listingOpen(issuePrice, first.open);
  const sellBy = addDays(first.day, HOLD_DAYS);
  const sales: IpoSale[] = [];
  let held = lot;
  if (!strong) {
    sales.push({ day: first.day, price: first.open, shares: lot, why: "weak-open" });
    held = 0;
  } else {
    const half = Math.floor(lot / 2);
    if (half > 0) sales.push({ day: first.day, price: first.open, shares: half, why: "open" });
    held = lot - half;
    const stop = first.low;
    for (const s of days.slice(1)) {
      const sale: IpoSale | null =
        s.open < stop
          ? { day: s.day, price: s.open, shares: held, why: "stop" }
          : s.low < stop
            ? { day: s.day, price: stop, shares: held, why: "stop" }
            : s.day >= sellBy
              ? { day: s.day, price: s.close, shares: held, why: "week" }
              : null;
      if (sale) {
        sales.push(sale);
        held = 0;
        break;
      }
    }
  }
  const cost = issuePrice * lot;
  const result =
    held === 0
      ? (() => {
          const rupees = sales.reduce((a, s) => a + s.shares * (s.price - issuePrice) - ipoSaleCosts(s.shares * s.price), 0);
          return { rupees, pct: rupees / cost };
        })()
      : null;
  return { open: first.open, openPct: pct, strong, stop: strong ? first.low : null, sellBy, sales, held, result };
}

/** What a holder should do now, by the rule, from the listing's prices so far (`stop` once the listing day is over). */
export type HolderStep = "wait" | "sell-all" | "sell-half" | "hold" | "sell-rest-stop" | "sell-rest-week" | "done";

export function holderStep(o: {
  issuePrice: number;
  /** The listing open; null before it has traded. */
  open: number | null;
  /** The listing day's low, once that day is over. */
  stop: number | null;
  listedOn: string | null;
  today: string;
  /** The last price, when known. */
  ltp: number | null;
  /** India minutes now. */
  minutes: number;
}): HolderStep {
  if (o.open === null || o.listedOn === null) return "wait";
  const { strong } = listingOpen(o.issuePrice, o.open);
  if (o.today === o.listedOn) return strong ? "sell-half" : "sell-all";
  if (!strong) return "done";
  if (o.stop !== null && o.ltp !== null && o.ltp < o.stop) return "sell-rest-stop";
  if (o.today >= addDays(o.listedOn, HOLD_DAYS)) return "sell-rest-week";
  return "hold";
}

/** Group results in one line: how many, how many made money, the average result per lot. */
export interface IpoRecord {
  count: number;
  won: number;
  /** Average share of the lot's cost made, after sale costs. */
  avgPct: number;
  /** Average rupees per lot. */
  avgRupees: number;
}

export function ipoRecord(results: { rupees: number; pct: number }[]): IpoRecord {
  const n = results.length;
  return {
    count: n,
    won: results.filter((r) => r.rupees > 0).length,
    avgPct: n > 0 ? results.reduce((a, r) => a + r.pct, 0) / n : 0,
    avgRupees: n > 0 ? results.reduce((a, r) => a + r.rupees, 0) / n : 0,
  };
}
