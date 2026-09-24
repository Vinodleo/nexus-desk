// Standard technical indicators computed from price bars, using Wilder's
// smoothing (the definitions most charting platforms use). Each function
// returns one value per bar, `undefined` until there's enough history.

export interface OHLC {
  high: number;
  low: number;
  close: number;
}

export const DEFAULT_PERIOD = 14;

/** True range of each bar (the first bar has no previous close, so it's high − low). */
export function trueRanges(bars: OHLC[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
}

/**
 * Average True Range. The first value (at index `period`) is the simple
 * average of the first `period` true ranges after bar 0; after that,
 * ATR = (previous ATR × (period − 1) + true range) / period.
 */
export function averageTrueRange(bars: OHLC[], period = DEFAULT_PERIOD): (number | undefined)[] {
  const tr = trueRanges(bars);
  const out: (number | undefined)[] = new Array(bars.length).fill(undefined);
  if (bars.length <= period) return out;
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i];
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

export interface DirectionalIndex {
  adx: (number | undefined)[];
  plusDI: (number | undefined)[];
  minusDI: (number | undefined)[];
}

/**
 * Average Directional Index with +DI / −DI. DI values start at index
 * `period`; ADX, the smoothed average of DX, starts at index 2 × period − 1.
 */
export function directionalIndex(bars: OHLC[], period = DEFAULT_PERIOD): DirectionalIndex {
  const n = bars.length;
  const adx: (number | undefined)[] = new Array(n).fill(undefined);
  const plusDI: (number | undefined)[] = new Array(n).fill(undefined);
  const minusDI: (number | undefined)[] = new Array(n).fill(undefined);
  if (n <= period) return { adx, plusDI, minusDI };

  const tr = trueRanges(bars);
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  // Wilder's running sums over the first `period` bars after bar 0.
  let trS = 0;
  let plusS = 0;
  let minusS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    plusS += plusDM[i];
    minusS += minusDM[i];
  }

  const dx: number[] = [];
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      plusS = plusS - plusS / period + plusDM[i];
      minusS = minusS - minusS / period + minusDM[i];
    }
    const pdi = trS > 0 ? (100 * plusS) / trS : 0;
    const mdi = trS > 0 ? (100 * minusS) / trS : 0;
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const sum = pdi + mdi;
    dx.push(sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0);

    const k = dx.length; // DX values so far
    if (k === period) {
      adx[i] = dx.reduce((a, b) => a + b, 0) / period;
    } else if (k > period) {
      adx[i] = ((adx[i - 1] as number) * (period - 1) + dx[k - 1]) / period;
    }
  }
  return { adx, plusDI, minusDI };
}
