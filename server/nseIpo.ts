import { fetchWithTimeout } from "./http";
import type { IpoBids } from "../src/shared/ipo";
import type { IpoListing, IpoSource } from "./ipoTracker";

// NSE's IPO pages, read the way its website reads them (the IPO tracker's
// source): the issues bidding now, the ones coming up, and how many times
// over each group has bid for one. NSE answers its data routes only with
// the cookies its home page sets, so those are fetched first and kept until
// it refuses them. SME issues are left out (main board only).

const BASE = "https://www.nseindia.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-IN,en;q=0.9",
  Referer: `${BASE}/market-data/all-upcoming-issues-ipo`,
};
/** NSE's cookies are taken again after this long, or as soon as it refuses them. */
const COOKIES_FOR_MS = 20 * 60 * 1000;

let cookies: { header: string; at: number } | null = null;
/** A visit to the page under way, shared by the requests waiting on its cookies. */
let visiting: Promise<string> | null = null;

async function visit(now: number): Promise<string> {
  const res = await fetchWithTimeout(`${BASE}/market-data/all-upcoming-issues-ipo`, { headers: { ...HEADERS, Accept: "text/html" } });
  const set = res.headers.getSetCookie?.() ?? [];
  const header = set.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  if (!res.ok || !header) throw new Error(`NSE's site answered ${res.status} without cookies`);
  cookies = { header, at: now };
  return header;
}

function cookieHeader(now: number, fresh = false): Promise<string> {
  if (!fresh && cookies && now - cookies.at < COOKIES_FOR_MS) return Promise.resolve(cookies.header);
  visiting ??= visit(now).finally(() => (visiting = null));
  return visiting;
}

async function nseJson(pathname: string, now: number): Promise<unknown> {
  const get = async (fresh: boolean) =>
    fetchWithTimeout(`${BASE}${pathname}`, { headers: { ...HEADERS, Cookie: await cookieHeader(now, fresh) } });
  let res = await get(false);
  if (res.status === 401 || res.status === 403) res = await get(true);
  const text = await res.text();
  if (!res.ok) throw new Error(`NSE ${pathname.split("?")[0]}: HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`NSE ${pathname.split("?")[0]}: not JSON (${text.slice(0, 80)})`);
  }
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** NSE's "21-Oct-2026" as "2026-10-21"; null when it isn't a date. */
export function nseDay(s: unknown): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(s ?? "").trim());
  const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
  return m && month ? `${m[3]}-${month}-${m[1].padStart(2, "0")}` : null;
}

/** A price band as NSE writes it ("Rs.95 to Rs.100", "95-100", "Rs.100"): low and high. */
export function priceBand(s: unknown): { low: number | null; high: number | null } {
  const nums = String(s ?? "")
    .replace(/,/g, "")
    .match(/\d+(\.\d+)?/g)
    ?.map(Number)
    .filter((n) => n > 0);
  if (!nums || nums.length === 0) return { low: null, high: null };
  return { low: Math.min(...nums), high: Math.max(...nums) };
}

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
};

/** An SME issue (left out: main board only). */
export const isSmeRow = (row: any): boolean => String(row?.series ?? "").toUpperCase() === "SME" || /\bsme\b/i.test(String(row?.issueType ?? ""));

/** An issue row from NSE's lists, or null for an SME issue or one it can't read. */
export function listingFrom(row: any): IpoListing | null {
  if (!row || typeof row !== "object" || isSmeRow(row)) return null;
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9&-]{1,20}$/.test(symbol)) return null;
  const opens = nseDay(row.issueStartDate);
  const closes = nseDay(row.issueEndDate);
  if (!opens || !closes) return null;
  const band = priceBand(row.priceBand ?? row.issuePrice);
  return {
    symbol,
    name: String(row.companyName ?? symbol).replace(/\s+(Limited|Ltd\.?)$/i, "").trim() || symbol,
    opens,
    closes,
    priceLow: band.low,
    priceHigh: band.high,
    lotSize: num(row.lotSize ?? row.minBidQuantity ?? row.marketLot),
    times: num(row.noOfTime),
  };
}

/** Group times-bid from NSE's category table: institutions, wealthy investors, retail and the whole issue. */
export function bidsFrom(body: any, now: number): IpoBids | null {
  const rows: any[] = Array.isArray(body?.dataList) ? body.dataList : Array.isArray(body) ? body : [];
  const pick = (re: RegExp): number | null => {
    const row = rows.find((r) => re.test(String(r?.category ?? r?.categoryName ?? "")));
    return row ? num(row.noOfTotalMeant ?? row.noOfTime ?? row.times ?? row.subscription) : null;
  };
  const bids: IpoBids = {
    qib: pick(/qualified institution|\bqibs?\b/i),
    nii: pick(/non.?institution|\bniis?\b|\bhnis?\b/i),
    retail: pick(/retail|\brii/i),
    total: pick(/^\s*total\b/i),
    at: now,
  };
  return bids.qib === null && bids.total === null ? null : bids;
}

export const nseIpoSource: IpoSource = {
  async issues(now) {
    const [current, upcoming] = await Promise.all([nseJson("/api/ipo-current-issue", now), nseJson("/api/all-upcoming-issues?category=ipo", now)]);
    const rows = [...(Array.isArray(current) ? current : []), ...(Array.isArray(upcoming) ? upcoming : [])];
    const seen = new Set<string>();
    const out: IpoListing[] = [];
    for (const row of rows) {
      const l = listingFrom(row);
      if (l && !seen.has(l.symbol)) {
        seen.add(l.symbol);
        out.push(l);
      }
    }
    // A change on NSE's side shows in the card instead of an empty list.
    const main = rows.filter((r) => !isSmeRow(r)).length;
    if (main > 0 && out.length === 0) throw new Error(`NSE listed ${main} main-board issues in a form the desk can't read`);
    return out;
  },
  async bids(symbol, now) {
    const body: any = await nseJson(`/api/ipo-active-category?symbol=${encodeURIComponent(symbol)}`, now);
    const bids = bidsFrom(body, now);
    if (!bids && Array.isArray(body?.dataList) && body.dataList.length > 0) throw new Error("NSE's bids came in a form the desk can't read");
    return bids;
  },
};

/** Test hook. */
export function _resetNseIpo(): void {
  cookies = null;
  visiting = null;
}
