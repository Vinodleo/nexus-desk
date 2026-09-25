// The USD/INR rate US stock prices are converted at, so the desk (amounts
// per trade, P&L, the daily loss limit) stays in rupees. The ECB's daily
// reference rate (via Frankfurter, free, no key), refreshed every few hours;
// USD_INR_RATE on the server overrides it. Without a rate, US stocks aren't
// priced (nothing is guessed).

const REFRESH_MS = 6 * 60 * 60 * 1000;
/** A rate outside this is a bad reply, not the market. */
const SANE = { min: 50, max: 200 };
const SOURCES = [
  "https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR",
  "https://api.frankfurter.app/latest?from=USD&to=INR",
];

let rate: { value: number; at: number; source: string } | null = null;
let lastTry = 0;

function envRate(): number | null {
  const v = Number(process.env.USD_INR_RATE);
  return Number.isFinite(v) && v >= SANE.min && v <= SANE.max ? v : null;
}

/** Fetches a fresh rate if the held one is old; keeps the last good one when the source is down. */
export async function refreshUsdInr(now: number = Date.now()): Promise<number | null> {
  const fixed = envRate();
  if (fixed !== null) {
    rate = { value: fixed, at: now, source: "USD_INR_RATE" };
    return fixed;
  }
  if (rate && now - rate.at < REFRESH_MS) return rate.value;
  // Don't hammer the source when it's down: at most one try every 10 minutes.
  if (now - lastTry < 10 * 60 * 1000) return rate?.value ?? null;
  lastTry = now;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { rates?: { INR?: number } };
      const value = Number(body?.rates?.INR);
      if (value >= SANE.min && value <= SANE.max) {
        rate = { value, at: now, source: "ECB reference rate" };
        return value;
      }
    } catch {
      // Try the next source.
    }
  }
  return rate?.value ?? null;
}

/** The rate in use now (null until one is known). */
export function usdInr(): number | null {
  return envRate() ?? rate?.value ?? null;
}

export function fxStatus() {
  return rate ? { usdInr: rate.value, at: rate.at, source: rate.source } : null;
}

/** Test hook. */
export function _setUsdInr(value: number | null, now: number = Date.now()): void {
  rate = value === null ? null : { value, at: now, source: "test" };
  lastTry = 0;
}
