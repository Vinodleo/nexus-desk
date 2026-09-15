const WebSocket = require('ws');
const url = 'ws://localhost:3000/ws/binance?streams=btcusdt@kline_1m';
const ws = new WebSocket(url);
ws.on('open', () => console.log('connected to local proxy'));
ws.on('message', (data) => {
  console.log('local proxy:', data.toString());
  ws.close();
});
ws.on('error', (err) => console.log('error local proxy', err));
ws.on('close', () => console.log('closed'));
