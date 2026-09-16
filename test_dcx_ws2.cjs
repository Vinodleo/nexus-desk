const { io } = require("socket.io-client");
const socket = io("wss://stream.coindcx.com", { transports: ['websocket'] });
socket.on("connect", () => {
  console.log("Connected SIO");
  socket.emit('join', { "channelName": "coindcx" });
  socket.emit('join', { "channelName": "B-BTC_INR" });
  socket.emit('join', { "channelName": "I-BTC_INR" });
});
socket.on("new-trade", (data) => console.log("trade:", data));
socket.on("ticker", (data) => console.log("ticker:", data));
socket.on("message", (data) => console.log("msg:", data));
setTimeout(() => { process.exit(0); }, 4000);
