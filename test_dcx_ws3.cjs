const { io } = require("socket.io-client");
const socket = io("wss://stream.coindcx.com", { transports: ['websocket'] });
socket.on("connect", () => {
  socket.emit('join', { "channelName": "coindcx" });
});
socket.on("ticker", (data) => {
  console.log("ticker:", data.substring(0, 100));
  process.exit(0);
});
setTimeout(() => { process.exit(0); }, 3000);
