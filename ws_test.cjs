const WebSocket = require('ws');
const url = 'wss://stream.binance.com:443/stream?streams=btcusdt@kline_1m';
const ws = new WebSocket(url);
ws.on('open', () => console.log('connected to 443 stream'));
ws.on('error', (err) => console.log('error', err));
ws.on('close', () => console.log('closed'));
setTimeout(() => ws.close(), 3000);
