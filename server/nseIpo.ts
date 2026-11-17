import { fetchWithTimeout } from "./http";
import type { IpoBids } from "../src/shared/ipo";
import type { IpoDetail, IpoListing, IpoSource } from "./ipoTracker";

// NSE's IPO pages, read the way its website reads them (the IPO tracker's
// source): the issues bidding now, the ones coming up, how many times over
// each group has bid for one, and an issue's lot and UPI cutoff from its
// page. Checked against NSE's replies on 22 Oct 2026. NSE answers its data routes only with
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

/**
 * Group times-bid from NSE's category table (`/api/ipo-active-category`,
 * both exchanges' bids): institutions, wealthy investors, retail and the
 * whole issue. Its sub-rows (FIIs, mutual funds, "Individuals (Other than
 * RIIs)") carry no figure of their own, so a group's row is the first named
 * for it that does.
 */
export function bidsFrom(body: any, now: number): IpoBids | null {
  const rows: any[] = Array.isArray(body?.dataList) ? body.dataList : Array.isArray(body) ? body : [];
  const pick = (re: RegExp): number | null => {
    for (const r of rows) {
      const times = num(r?.noOfTotalMeant ?? r?.noOfTime);
      if (times !== null && re.test(String(r?.category ?? ""))) return times;
    }
    return null;
  };
  const bids: IpoBids = {
    qib: pick(/qualified institution/i),
    nii: pick(/^non institution/i),
    retail: pick(/^retail/i),
    total: pick(/^\s*total\b/i),
    at: now,
  };
  return bids.qib === null && bids.total === null ? null : bids;
}

/** India minutes from a time written like "7:00 PM" or "5 pm"; null without one. */
export function clockMinutes(s: unknown): number | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(String(s ?? ""));
  if (!m) return null;
  const h = Number(m[1]) % 12 + (m[3].toLowerCase() === "pm" ? 12 : 0);
  return h * 60 + Number(m[2] ?? 0);
}

/** The lot and the last day's UPI cutoff from an issue's page (`/api/ipo-detail`, its "Issue information" rows). */
export function detailFrom(body: any): IpoDetail {
  const rows: any[] = Array.isArray(body?.issueInfo?.dataList) ? body.issueInfo.dataList : [];
  const value = (re: RegExp) => rows.find((r) => re.test(String(r?.title ?? "")))?.value;
  const lot = /([\d,]+)\s*equity shares/i.exec(String(value(/^bid lot/i) ?? value(/^minimum order quantity/i) ?? ""));
  const lotSize = lot ? num(lot[1]) : null;
  return { lotSize: lotSize && lotSize > 0 ? lotSize : null, upiCutoff: clockMinutes(value(/cut-?off time for upi/i)) };
}

// NSE's list of every share listed on it (symbol, company, listing day), a
// plain file on its archive site, no cookies. An issue doesn't always trade
// under the symbol it was bid for (M. K. Sons Fine Jewels bid as MKSONS and
// trades as MKJEWELS, Nov 2026), so a listed issue is found by its name here.
const EQUITY_LIST_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
/** The list is read again after this long. */
const EQUITY_LIST_FOR_MS = 60 * 60 * 1000;
const EQUITY_LIST_TIMEOUT_MS = 30_000;

export interface ListedShare {
  symbol: string;
  name: string;
  /** India day (YYYY-MM-DD). */
  listedOn: string;
}

let equityList: { shares: ListedShare[]; at: number } | null = null;

/** One CSV line's fields (quoted fields may hold commas). */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** NSE's EQUITY_L.csv as shares (its header names the columns: SYMBOL, NAME OF COMPANY, DATE OF LISTING). */
export function listedShares(csv: string): ListedShare[] {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = csvFields(lines[0] ?? "").map((h) => h.toUpperCase());
  const col = { symbol: head.indexOf("SYMBOL"), name: head.indexOf("NAME OF COMPANY"), listed: head.indexOf("DATE OF LISTING") };
  if (col.symbol < 0 || col.name < 0 || col.listed < 0) throw new Error("NSE's list of listed shares came in a form the desk can't read");
  const out: ListedShare[] = [];
  for (const line of lines.slice(1)) {
    const f = csvFields(line);
    const symbol = (f[col.symbol] ?? "").toUpperCase();
    const listedOn = nseDay(f[col.listed]);
    if (symbol && listedOn && f[col.name]) out.push({ symbol, name: f[col.name], listedOn });
  }
  return out;
}

/** A company's name reduced for matching: "M.K. Sons Fine Jewels Limited" and "M. K. Sons Fine Jewels" are the same. */
export const companyKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(limited|ltd)\b\.?/g, " ")
    .replace(/[^a-z0-9]/g, "");

/** The symbol of the share listed under this company's name on or after `sinceDay` (the latest such); null when none. */
export function symbolForName(shares: ListedShare[], name: string, sinceDay: string): string | null {
  const key = companyKey(name);
  if (!key) return null;
  const found = shares.filter((s) => s.listedOn >= sinceDay && companyKey(s.name) === key).sort((a, b) => b.listedOn.localeCompare(a.listedOn));
  return found[0]?.symbol ?? null;
}

async function equityShares(now: number): Promise<ListedShare[]> {
  if (equityList && now - equityList.at < EQUITY_LIST_FOR_MS) return equityList.shares;
  const res = await fetchWithTimeout(EQUITY_LIST_URL, { headers: { "User-Agent": HEADERS["User-Agent"], Accept: "text/csv, */*" } }, EQUITY_LIST_TIMEOUT_MS);
  if (!res.ok) throw new Error(`NSE's list of listed shares: HTTP ${res.status}`);
  const shares = listedShares(await res.text());
  equityList = { shares, at: now };
  return shares;
}

export const nseIpoSource: IpoSource = {
  async listedSymbol(name, sinceDay, now) {
    return symbolForName(await equityShares(now), name, sinceDay);
  },
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
  async detail(symbol, now) {
    return detailFrom(await nseJson(`/api/ipo-detail?symbol=${encodeURIComponent(symbol)}&series=EQ`, now));
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
  equityList = null;
}
