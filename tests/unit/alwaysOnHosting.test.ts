import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Pieces that keep the server honest about running around the clock: where
// its saved state lives, whether the scanner's loop is alive, and saving the
// guardian only when something worth keeping changed.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-host-"));
vi.stubEnv("NEXUS_DATA_DIR", dir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("saved-state storage", () => {
  it("tells a mounted volume from the container's own disk", async () => {
    const { isMountPoint } = await import("../../server/hostStatus");
    expect(isMountPoint(dir)).toBe(false);
    expect(isMountPoint("/proc")).toBe(true);
  });

  it("counts Cloud Run's own disk as lost on restart, and a machine's disk as kept", async () => {
    const { storageStatus } = await import("../../server/hostStatus");
    expect(storageStatus({ K_SERVICE: "nexus-desk" }, dir)).toMatchObject({ kept: false, note: expect.stringMatching(/Cloud Run's temporary disk/) });
    expect(storageStatus({ K_SERVICE: "nexus-desk" }, "/proc")).toMatchObject({ kept: true, note: "On a mounted volume" });
    expect(storageStatus({}, dir)).toMatchObject({ kept: true, note: "On this machine's disk" });
  });
});

describe("scanner heartbeat", () => {
  it("reports the loop stalled after three candles without firing", async () => {
    const { scannerHeartbeat } = await import("../../server/scanner/scannerService");
    const now = Date.now();
    expect(scannerHeartbeat(now).stalled).toBe(false);
    expect(scannerHeartbeat(now + 16 * 60 * 1000).stalled).toBe(true);
  });
});

describe("guardian saves", () => {
  let guardian: typeof import("../../server/guardian");
  const file = path.join(dir, "daemon_positions_state.json");

  beforeAll(async () => {
    guardian = await import("../../server/guardian");
  });

  it("skips the disk for a tick that only moved the price, and saves when the guard changed", () => {
    vi.useFakeTimers();
    try {
      guardian.daemonPositions.set("p1", {
        id: "p1", symbol: "SOL/INR", direction: "LONG", entryPrice: 100, currentPrice: 100, quantity: 1,
        stopLoss: 95, takeProfit: 120, highestPrice: 105, lowestPrice: 95, atrAtEntry: 10, trailMode: "SCALP_TIGHT",
        openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 30,
      });
      guardian.evaluateDaemonPositions("SOL/INR", 100.2); // inside the old high and low: nothing to keep
      vi.advanceTimersByTime(11_000);
      expect(fs.existsSync(file)).toBe(false);

      guardian.evaluateDaemonPositions("SOL/INR", 106); // a new high
      vi.advanceTimersByTime(9_000);
      expect(fs.existsSync(file)).toBe(false); // waits 10 seconds, so a burst of ticks is one write
      vi.advanceTimersByTime(2_000);
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(saved.positions[0]).toMatchObject({ id: "p1", highestPrice: 106 });
    } finally {
      vi.useRealTimers();
      guardian.daemonPositions.clear();
    }
  });
});
