import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fetchWithTimeout } from "./http";
import type { RawBook } from "../src/shared/orderBook";

// Angel One SmartAPI: NSE stock candles, live prices and market depth for the
// server scanner and the position guardian. The server logs in by itself
// every day with your client code, PIN and a one-time code it makes from
// your TOTP key, so nobody has to log in by hand.
//
// Market data only: no orders are placed here. (Angel One accepts API orders
// only from a registered static IP; data works from anywhere.)
//
// Settings (environment): ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN,
// ANGEL_TOTP_SECRET.

const BASE = "https://apiconnect.angelone.in";
const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const TOKEN_FILE = path.join(DATA_DIR, "angel_tokens.json");
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type AngelInterval = "FIVE_MINUTE" | "ONE_HOUR";

// ---------- TOTP (RFC 6238: SHA-1, 30 seconds, 6 digits) ----------

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("ANGEL_TOTP_SECRET isn't a valid TOTP key (letters A-Z and digits 2-7).");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The one-time code for `secret` (base32) at `nowMs`. */
export function totp(secret: string, nowMs: number = Date.now(), digits: number = 6): string {
  const counter = Math.floor(nowMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

// ---------- settings and session ----------

interface Settings {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
}

function settings(): Settings | null {
  const { ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN, ANGEL_TOTP_SECRET } = process.env;
  if (!ANGEL_API_KEY || !ANGEL_CLIENT_CODE || !ANGEL_PIN || !ANGEL_TOTP_SECRET) return null;
  return { apiKey: ANGEL_API_KEY, clientCode: ANGEL_CLIENT_CODE, pin: ANGEL_PIN, totpSecret: ANGEL_TOTP_SECRET };
}

/** All four Angel One settings are present. */
export function angelConfigured(): boolean {
  return settings() !== null;
}

const istDay = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

let session: { jwt: string; day: string } | null = null;
let loginPromise: Promise<string> | null = null;
let lastError: string | null = null;
let lastLoginAt = 0;
/** After a failed login, wait this long before trying again (a wrong PIN shouldn't be retried every few seconds). */
const LOGIN_RETRY_MS = 5 * 60 * 1000;
let loginFailedAt = 0;

function headers(s: Settings, jwt?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": process.env.ANGEL_LOCAL_IP || "127.0.0.1",
    "X-ClientPublicIP": process.env.ANGEL_PUBLIC_IP || "127.0.0.1",
    "X-MACAddress": process.env.ANGEL_MAC_ADDRESS || "00:00:00:00:00:00",
    "X-PrivateKey": s.apiKey,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

interface AngelReply<T> {
  status?: boolean;
  message?: string;
  errorcode?: string;
  data?: T;
}

async function readReply<T>(res: Response): Promise<AngelReply<T>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as AngelReply<T>;
  } catch {
    return { status: false, message: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  }
}

async function login(now: number): Promise<string> {
  const s = settings();
  if (!s) throw new Error("Angel One isn't set up (ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN, ANGEL_TOTP_SECRET).");
  if (now - loginFailedAt < LOGIN_RETRY_MS) throw new Error(lastError ?? "Angel One login failed recently.");
  const res = await fetchWithTimeout(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST",
    headers: headers(s),
    body: JSON.stringify({ clientcode: s.clientCode, password: s.pin, totp: totp(s.totpSecret, now) }),
  });
  const reply = await readReply<{ jwtToken?: string }>(res);
  const jwt = reply.data?.jwtToken?.replace(/^Bearer\s+/i, "");
  if (!res.ok || !reply.status || !jwt) {
    loginFailedAt = now;
    lastError = `Angel One login failed: ${reply.message || `HTTP ${res.status}`}${reply.errorcode ? ` (${reply.errorcode})` : ""}`;
    throw new Error(lastError);
  }
  session = { jwt, day: istDay(now) };
  lastLoginAt = now;
  lastError = null;
  console.log("[AngelOne] Logged in.");
  return jwt;
}

/** A session for today, logging in if needed (one login at a time). */
async function sessionJwt(now: number = Date.now(), fresh = false): Promise<string> {
  if (!fresh && session && session.day === istDay(now)) return session.jwt;
  if (!loginPromise) loginPromise = login(now).finally(() => (loginPromise = null));
  return loginPromise;
}

// Angel One limits how often each kind of request may be made; calls of a
// kind are spaced out so the scanner stays under those limits.
const lastCallAt = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();
const GAP_MS: Record<string, number> = { historical: 400, quote: 150, search: 1100 };
/** After Angel One says a kind of request is coming too fast, none of that kind is sent for this long. */
const RATE_LIMIT_PAUSE_MS = 60_000;
const pausedUntil = new Map<string, number>();
/** A refused session is replaced by a new login at most this often. */
const RELOGIN_MIN_GAP_MS = 60_000;
let lastRelogin = 0;

/** Angel One's "slow down" reply (HTTP 403 "exceeding access rate", or 429). */
function isRateLimited(status: number, reply: { message?: string; errorcode?: string }): boolean {
  return status === 429 || /access rate|rate limit|too many/i.test(reply.message ?? "");
}

/** A session Angel One no longer accepts (an expired or invalid token), as opposed to any other refusal. */
function isSessionRefused(status: number, reply: { message?: string; errorcode?: string }): boolean {
  if (isRateLimited(status, reply)) return false;
  return status === 401 || /^AG800[123]$/.test(reply.errorcode ?? "") || /invalid token|token expired/i.test(reply.message ?? "");
}

function throttled<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(kind) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const wait = (lastCallAt.get(kind) ?? 0) + (GAP_MS[kind] ?? 0) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt.set(kind, Date.now());
    return fn();
  });
  queues.set(kind, next);
  return next;
}

/**
 * A SmartAPI call. Logs in again (at most once a minute) if the session was
 * refused. When Angel One says requests are coming too fast, that kind of
 * request pauses for a minute instead: logging in again then only adds to
 * the count, and gets the login itself refused (as happened at the open).
 */
async function call<T>(kind: string, pathname: string, body: unknown): Promise<T> {
  const s = settings();
  if (!s) throw new Error("Angel One isn't set up.");
  const paused = pausedUntil.get(kind) ?? 0;
  if (Date.now() < paused) throw new Error(`Angel One asked to slow down; ${kind} requests resume in ${Math.ceil((paused - Date.now()) / 1000)}s.`);
  const attempt = async (fresh: boolean) => {
    const jwt = await sessionJwt(Date.now(), fresh);
    const res = await throttled(kind, () =>
      fetchWithTimeout(`${BASE}${pathname}`, { method: "POST", headers: headers(s, jwt), body: JSON.stringify(body) })
    );
    return { res, reply: await readReply<T>(res) };
  };
  let { res, reply } = await attempt(false);
  if (isSessionRefused(res.status, reply) && Date.now() - lastRelogin >= RELOGIN_MIN_GAP_MS) {
    lastRelogin = Date.now();
    session = null;
    ({ res, reply } = await attempt(true));
  }
  if (isRateLimited(res.status, reply)) {
    pausedUntil.set(kind, Date.now() + RATE_LIMIT_PAUSE_MS);
    lastError = `Angel One asked to slow down (${kind} requests); pausing them for a minute.`;
  }
  if (!res.ok || reply.status === false || reply.data === undefined || reply.data === null) {
    throw new Error(`Angel One ${pathname.split("/").pop()}: ${reply.message || `HTTP ${res.status}`}${reply.errorcode ? ` (${reply.errorcode})` : ""}`);
  }
  // Working again: an earlier problem no longer applies.
  lastError = null;
  return reply.data;
}

// ---------- instrument tokens ----------

let tokens: Record<string, string> | null = null;

function loadTokens(): Record<string, string> {
  if (tokens) return tokens;
  try {
    tokens = fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) : {};
  } catch {
    tokens = {};
  }
  return tokens!;
}

function saveTokens(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens ?? {}), "utf8");
  } catch (err) {
    console.warn("[AngelOne] Couldn't save stock tokens:", err);
  }
}

/** Symbols Angel One doesn't list on NSE (checked this run), so they aren't searched for again. */
const unknownSymbols = new Set<string>();

/** Lookups under way, so the scanner and the price poll don't search for the same stock twice. */
const searching = new Map<string, Promise<string | null>>();

/** Angel One's token for an NSE stock ("SBIN" → "3045"), or null if it isn't listed. Kept on disk. */
export async function tokenFor(symbol: string): Promise<string | null> {
  const known = loadTokens()[symbol];
  if (known) return known;
  if (unknownSymbols.has(symbol)) return null;
  let pending = searching.get(symbol);
  if (!pending) {
    pending = searchToken(symbol).finally(() => searching.delete(symbol));
    searching.set(symbol, pending);
  }
  return pending;
}

async function searchToken(symbol: string): Promise<string | null> {
  const found = await call<{ tradingsymbol?: string; symboltoken?: string }[]>("search", "/rest/secure/angelbroking/order/v1/searchScrip", {
    exchange: "NSE",
    searchscrip: symbol,
  });
  const match = (Array.isArray(found) ? found : []).find((r) => r.tradingsymbol === `${symbol}-EQ`);
  if (!match?.symboltoken) {
    unknownSymbols.add(symbol);
    console.warn(`[AngelOne] ${symbol} isn't listed on NSE at Angel One; skipping it.`);
    return null;
  }
  loadTokens()[symbol] = match.symboltoken;
  saveTokens();
  return match.symboltoken;
}

/** Tokens for several symbols; unlisted ones are left out. */
export async function tokensFor(symbols: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of symbols) {
    try {
      const t = await tokenFor(s);
      if (t) out.set(s, t);
    } catch (err: any) {
      lastError = err?.message ?? String(err);
    }
  }
  return out;
}

// ---------- candles, prices, depth ----------

const istStamp = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");

/**
 * Candles for an NSE stock between two times, oldest first, as
 * [time, open, high, low, close, volume] (time in ISO with +05:30).
 */
export async function fetchStockCandles(symbol: string, interval: AngelInterval, fromMs: number, toMs: number): Promise<unknown[]> {
  const token = await tokenFor(symbol);
  if (!token) throw new Error(`${symbol} isn't listed at Angel One`);
  const data = await call<unknown[]>("historical", "/rest/secure/angelbroking/historical/v1/getCandleData", {
    exchange: "NSE",
    symboltoken: token,
    interval,
    fromdate: istStamp(fromMs),
    todate: istStamp(toMs),
  });
  return Array.isArray(data) ? data : [];
}

interface QuoteRow {
  symbolToken?: string;
  ltp?: number;
  depth?: { buy?: { price?: number; quantity?: number }[]; sell?: { price?: number; quantity?: number }[] };
}

async function quotes(symbols: string[], mode: "LTP" | "FULL"): Promise<{ symbol: string; row: QuoteRow }[]> {
  const bySymbol = await tokensFor(symbols);
  const byToken = new Map([...bySymbol.entries()].map(([s, t]) => [t, s]));
  const all = [...bySymbol.values()];
  const out: { symbol: string; row: QuoteRow }[] = [];
  // Up to 50 stocks per request.
  for (let i = 0; i < all.length; i += 50) {
    const data = await call<{ fetched?: QuoteRow[] }>("quote", "/rest/secure/angelbroking/market/v1/quote/", {
      mode,
      exchangeTokens: { NSE: all.slice(i, i + 50) },
    });
    for (const row of data.fetched ?? []) {
      const symbol = row.symbolToken ? byToken.get(String(row.symbolToken)) : undefined;
      if (symbol) out.push({ symbol, row });
    }
  }
  return out;
}

/** Latest traded price per stock. */
export async function fetchStockPrices(symbols: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  for (const { symbol, row } of await quotes(symbols, "LTP")) {
    const ltp = Number(row.ltp);
    if (ltp > 0) prices[symbol] = ltp;
  }
  return prices;
}

/** The best five bids and offers for a stock, as an order book. */
export async function fetchStockDepth(symbol: string, now: number = Date.now()): Promise<RawBook | null> {
  const [q] = await quotes([symbol], "FULL");
  const levels = (side?: { price?: number; quantity?: number }[]) =>
    (side ?? []).map((l) => [Number(l.price), Number(l.quantity)] as [number, number]).filter(([p, q]) => p > 0 && q > 0);
  const bids = levels(q?.row.depth?.buy).sort((a, b) => b[0] - a[0]);
  const asks = levels(q?.row.depth?.sell).sort((a, b) => a[0] - b[0]);
  return bids.length > 0 && asks.length > 0 ? { bids, asks, fetchedAt: now } : null;
}

/** For the status page. */
export function angelStatus() {
  return {
    configured: angelConfigured(),
    loggedIn: !!session && session.day === istDay(Date.now()),
    lastLoginAt,
    lastError,
    stocksKnown: Object.keys(loadTokens()).length,
  };
}

/** Test hook: request spacing in ms (0 for tests). */
export function _setAngelGaps(ms: number): void {
  for (const k of Object.keys(GAP_MS)) GAP_MS[k] = ms;
}

/** Test hook. */
export function _resetAngelOne(): void {
  session = null;
  loginPromise = null;
  lastError = null;
  lastLoginAt = 0;
  loginFailedAt = 0;
  tokens = null;
  unknownSymbols.clear();
  searching.clear();
  lastCallAt.clear();
  queues.clear();
  pausedUntil.clear();
  lastRelogin = 0;
}
