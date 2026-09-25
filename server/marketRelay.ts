import io from "socket.io-client";
import { daemonPositions, evaluateDaemonPositions } from "./guardian";
import { getCoinUniverse } from "./coinUniverse";
import { DEFAULT_COINS } from "../src/shared/coinUniverse";
import { broadcast, currentPrices } from "./realtime";
import { freshQuote } from "./quotes";

// Streams live CoinDCX prices into currentPrices, the position guardian and
// every authenticated WebSocket client.
export function startCoinDcxRelay() {
  // Connect to Binance live ticker stream
  // We use the same CoinDCX Polling logic for the top ticker tape

  // High-Frequency CoinDCX Socket.io Relay
  // CoinDCX's streaming server (per its published AsyncAPI spec) only
  // speaks the Socket.IO v2 wire protocol — package.json now pins
  // socket.io-client to 2.4.0 to match.
  // Public market channels must be of the form <EXCHANGE>-<BASE>_<QUOTE>@<topic> (e.g. I-BTC_INR@prices);
  // a bare "I-BTC_INR" with no @topic matches nothing server-side.
  const dcxSocket = io("wss://stream.coindcx.com", {
    transports: ["websocket"],
    reconnection: true
  });

  function normalizeCoinDCXSymbol(s: string) {
    let sym = s.replace(/^[A-Za-z]+-/, ''); // strip exchange prefix: I-, B-, HB-, KC-
    if (sym.includes('_')) {
      sym = sym.replace('_INR', '/INR').replace('_USDT', '/USDT').replace('_', '/');
    } else {
      sym = sym.replace('INR', '/INR').replace('USDT', '/USDT');
    }
    return sym;
  }

  // Coins we stream prices for: the scanner's universe (CoinDCX's most traded
  // INR coins, refreshed hourly) plus any coin the guardian holds a position
  // in. Channels are only ever added, so a coin that drops out of the top
  // list keeps its stops guarded.
  const tracked = new Set<string>(DEFAULT_COINS.map(c => `${c}/INR`));

  // Symbols we've had to fall back away from real data for — surfaced here
  // so it's obvious in the server log which pairs, if any, aren't actually
  // getting live CoinDCX data rather than failing silently.
  const staleSymbols = new Set<string>(tracked);

  function joinChannels(symbol: string) {
    const pair = `I-${symbol.split("/")[0]}_INR`;
    dcxSocket.emit("join", { channelName: `${pair}@prices` });
    dcxSocket.emit("join", { channelName: `${pair}@trades` });
  }

  async function refreshTracked() {
    const universe = await getCoinUniverse();
    const wanted = [...universe.coins.map(c => c.symbol), ...[...daemonPositions.values()].map(p => p.symbol)];
    for (const sym of wanted) {
      if (tracked.has(sym) || !/^[A-Z0-9]{1,15}\/INR$/.test(sym)) continue;
      tracked.add(sym);
      staleSymbols.add(sym);
      if (dcxSocket.connected) joinChannels(sym);
    }
  }
  setInterval(() => void refreshTracked(), 10 * 60 * 1000);

  dcxSocket.on("connect", () => {
    console.log("[CoinDCX WS] connected — joining channels");
    tracked.forEach(joinChannels);
    void refreshTracked();

    // Log once, 10s after connecting, which tracked symbols never received
    // a single real tick — the concrete symptom the "fix the currencies
    // that aren't live" ask was about.
    setTimeout(() => {
      if (staleSymbols.size > 0) {
        console.warn(`[CoinDCX WS] No real ticks received yet for: ${Array.from(staleSymbols).join(", ")}`);
      } else {
        console.log("[CoinDCX WS] Real ticks confirmed for all tracked symbols.");
      }
    }, 10000);
  });

  dcxSocket.on("connect_error", (err: any) => {
    console.error("[CoinDCX WS] connect_error:", err?.message || err);
  });

  function broadcastRealTick(rawSymbol: string, rawPrice: any, source: string) {
    const price = parseFloat(rawPrice);
    if (!rawSymbol || Number.isNaN(price)) return;
    const sym = normalizeCoinDCXSymbol(rawSymbol);
    if (!tracked.has(sym)) return; // ignore pairs we don't trade

    if (staleSymbols.has(sym)) {
      console.log(`[CoinDCX WS] First real tick for ${sym} via ${source}: ${price}`);
      staleSymbols.delete(sym);
    }

    currentPrices[sym] = price;

    // The guardian judges positions on the order book's bid/ask while it's
    // fresh (server/quotes); trade prints, which jump between the two, only
    // when it isn't.
    if (!freshQuote(sym)) evaluateDaemonPositions(sym, price);

    broadcast({ type: 'TICK', data: { [sym]: price }, is24h: source === 'price-change' });
  }

  dcxSocket.on("price-change", (data: any) => {
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      const inner = typeof payload.data === 'string' ? JSON.parse(payload.data) : (payload.data || payload);
      const rawSym = inner?.s || inner?.symbol || inner?.market;
      const rawPrice = inner?.p ?? inner?.c ?? inner?.price;
      if (rawSym && rawPrice !== undefined) {
        broadcastRealTick(rawSym, rawPrice, 'price-change');
      } else {
        console.warn('[CoinDCX WS] price-change payload shape unrecognized:', JSON.stringify(inner).slice(0, 200));
      }
    } catch (e) { console.warn('[CoinDCX WS] price-change parse error', e); }
  });

  dcxSocket.on("new-trade", (data: any) => {
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      const innerData = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data;
      if (innerData && innerData.s && innerData.p) {
        broadcastRealTick(innerData.s, innerData.p, 'new-trade');
      }
    } catch(e) {}
  });
}
