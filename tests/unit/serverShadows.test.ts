import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ShadowSignal } from "../../src/services/shadowTracker";

// The server follows every setup in every market, so it keeps a week of
// them for "When setups win", not just the newest 1,500 a phone keeps.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-shadows-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.parse("2026-09-27T06:00:00Z");
const HOUR = 60 * 60 * 1000;
const shadow = (i: number, hoursAgo: number, status: ShadowSignal["status"] = "target"): ShadowSignal =>
  ({
    id: `s${i}`, symbol: "SOL/INR", direction: "LONG", setupName: "Chen Conservative Trend", family: "trend_pullback", horizon: "intraday",
    kind: "proposed", entryPrice: 100, stopLoss: 98, takeProfit: 104, signalTime: now - hoursAgo * HOUR, status,
  }) as unknown as ShadowSignal;

describe("the server's followed setups", () => {
  it("keep a week's worth, well past the 1,500 a phone keeps", async () => {
    const { keepServerShadows } = await import("../../server/scanner/scannerService");
    // Three days of setups, 100 an hour.
    const days = Array.from({ length: 7200 }, (_, i) => shadow(i, i / 100));
    const kept = keepServerShadows([], days, now);
    expect(kept).toHaveLength(7200);
    expect(kept[0].signalTime).toBeGreaterThan(kept[kept.length - 1].signalTime);
  });

  it("drop finished ones older than a week, but not one still open", async () => {
    const { keepServerShadows } = await import("../../server/scanner/scannerService");
    const kept = keepServerShadows([shadow(1, 8 * 24), shadow(2, 8 * 24, "open"), shadow(3, 6 * 24)], [shadow(4, 0)], now);
    expect(kept.map((s) => s.id)).toEqual(["s4", "s3", "s2"]);
  });

  it("stop at the cap, keeping the newest", async () => {
    const { keepServerShadows, SERVER_MAX_SHADOWS } = await import("../../server/scanner/scannerService");
    const many = Array.from({ length: SERVER_MAX_SHADOWS + 10 }, (_, i) => shadow(i, i / 1000));
    const kept = keepServerShadows([], many, now);
    expect(kept).toHaveLength(SERVER_MAX_SHADOWS);
    expect(kept[0].id).toBe("s0");
  });

  it("send the phone only the newest 1,500, while When setups win counts them all", async () => {
    const { keepServerShadows, loadScannerState, saveScannerState, shadowsFor, shadowsForDevice } = await import("../../server/scanner/scannerService");
    // Saved on disk as the server would, then read back after a restart.
    fs.writeFileSync(path.join(dataDir, "scanner_shadows.json"), JSON.stringify({ owner: keepServerShadows([], Array.from({ length: 4000 }, (_, i) => shadow(i, i / 100)), now) }));
    loadScannerState();
    expect(shadowsFor("owner")).toHaveLength(4000);
    expect(shadowsForDevice("owner")).toHaveLength(1500);
    expect(shadowsForDevice("owner")[0].id).toBe("s0");
    saveScannerState();
    expect(Object.values(JSON.parse(fs.readFileSync(path.join(dataDir, "scanner_shadows.json"), "utf8")))[0]).toHaveLength(4000);
  });
});
