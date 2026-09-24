// CoinDCX's candles for INR markets come only in 1m, 15m, 1h and 1d (any
// other interval is rejected with a 422). The scanner works on 5-minute
// candles, so those are built here from 1-minute ones: real INR trades and
// volume, combined five at a time.

const MINUTE_MS = 60 * 1000;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function readCandle(c: unknown): Candle | null {
  if (!c || typeof c !== "object") return null;
  const r = c as Record<string, unknown>;
  const candle = {
    time: Number(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume) || 0,
  };
  return Number.isFinite(candle.time) && candle.close > 0 ? candle : null;
}

/**
 * Combines 1-minute candles into `minutes`-minute candles aligned to the
 * clock (e.g. :00, :05, :10). Input and output are newest first, as CoinDCX
 * returns them; the newest output candle may still be forming, as with
 * CoinDCX's own. The oldest bucket is dropped if its first minute is
 * missing (it would be a partial candle), and a bucket with no trades at
 * all becomes a flat candle at the previous close with zero volume, so the
 * series has no gaps.
 */
export function aggregateMinuteCandles(raw: unknown[], minutes: number): Candle[] {
  const bucketMs = minutes * MINUTE_MS;
  const ones = raw
    .map(readCandle)
    .filter((c): c is Candle => c !== null)
    .sort((a, b) => a.time - b.time);
  if (ones.length === 0) return [];

  const buckets = new Map<number, Candle>();
  for (const c of ones) {
    const start = Math.floor(c.time / bucketMs) * bucketMs;
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, { ...c, time: start });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }

  const starts = [...buckets.keys()].sort((a, b) => a - b);
  // A first bucket that doesn't start with its first minute is partial.
  if (ones[0].time > starts[0]) starts.shift();
  if (starts.length === 0) return [];

  const out: Candle[] = [];
  for (let t = starts[0]; t <= starts[starts.length - 1]; t += bucketMs) {
    const b = buckets.get(t);
    if (b) {
      out.push(b);
    } else {
      const prev = out[out.length - 1].close;
      out.push({ time: t, open: prev, high: prev, low: prev, close: prev, volume: 0 });
    }
  }
  return out.reverse();
}
