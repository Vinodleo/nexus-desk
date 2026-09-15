const WebSocket = require('ws');
const url = 'wss://ais-dev-ixwqjsd6wk2pwux2qxatjp-827994110842.asia-southeast1.run.app/ws/binance?streams=btcusdt@kline_1m';
const ws = new WebSocket(url);
ws.on('open', () => console.log('connected to remote proxy'));
ws.on('message', (data) => {
  console.log('remote proxy:', data.toString());
  ws.close();
});
ws.on('error', (err) => console.log('error remote proxy', err));
ws.on('close', () => console.log('closed'));
