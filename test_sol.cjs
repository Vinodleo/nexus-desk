const { io } = require("socket.io-client");
const socket = io("wss://stream.coindcx.com", { transports: ['websocket'] });
socket.on("connect", () => {
  socket.emit('join', { "channelName": "I-SOL_INR" });
  socket.emit('join', { "channelName": "B-SOL_INR" });
});
socket.on("new-trade", (data) => {
  console.log("trade:", data);
  process.exit(0);
});
setTimeout(() => { process.exit(0); }, 10000);
