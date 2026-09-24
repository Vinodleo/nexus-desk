// Outbound requests for market data give up after a while, so a request
// CoinDCX never answers can't stall the scanner or the ticker for good.
// (Order placement keeps its own handling: a timed-out order's outcome is
// unknown, and liveExecution checks it by client order id.)

export const FETCH_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(url: string, init: RequestInit = {}, ms: number = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
}
