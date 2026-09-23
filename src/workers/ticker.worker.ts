// Web Worker for reliable, un-throttled background heartbeat timer
// Modern mobile/desktop browsers do NOT throttle Web Workers when the tab is in the background or minimized.

let timerId: any = null;
const TICK_INTERVAL_MS = 1000; // 1-second background tick

self.onmessage = (event: MessageEvent) => {
  const { command } = event.data;

  if (command === "START") {
    if (!timerId) {
      timerId = setInterval(() => {
        self.postMessage({ type: "TICK", timestamp: Date.now() });
      }, TICK_INTERVAL_MS);
    }
  } else if (command === "STOP") {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
  }
};
