// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), authenticateSocket: vi.fn() }));

import { useServerScanner, type DeskSettings, type ServerScanReport } from "../../src/hooks/useServerScanner";

const desk: DeskSettings = {
  equity: 100000,
  riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1 },
  dailyRealizedPnl: 0,
  autopilot: true,
  tradingMode: "PAPER",
  trailProfile: "tight",
  killSwitch: false,
  lossStreak: 0,
  scanning: true,
  failureState: {
    simulateAgentTimeout: false, simulateStaleMarketData: false, simulateDailyLossBreach: false,
    simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false, globalKillSwitchActive: false,
  },
  quarantines: {},
  promotedModel: null,
};
const report = (at: number): ServerScanReport => ({ at, outcomes: [{ symbol: "SOL/INR", proposed: false, reason: "no_setup" }], newProposals: [] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  localStorage.clear();
  apiFetch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("useServerScanner", () => {
  it("hands over each server scan once, oldest first, and says the server is scanning", async () => {
    const now = Date.now();
    apiFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/scanner/reports")) return json({ status: { running: true, lastScanAt: now }, reports: [report(now - 1000), report(now - 2000)] });
      if (url === "/api/scanner/shadows") return json({ shadows: [] });
      return json({ success: true, status: { running: true, lastScanAt: now } });
    });
    const onReport = vi.fn();
    const { result } = renderHook(() => useServerScanner(desk, onReport));
    await waitFor(() => expect(result.current.location).toBe("server"));
    expect(onReport.mock.calls.map(([r]) => r.at)).toEqual([now - 2000, now - 1000]);

    // The same report again, over the socket: ignored. A newer one: taken.
    act(() => result.current.handleLiveReport(report(now - 1000)));
    act(() => result.current.handleLiveReport(report(now)));
    expect(onReport).toHaveBeenCalledTimes(3);
    // Next time it only asks for what's newer.
    expect(localStorage.getItem("nexus_last_server_report_at")).toBe(String(now));
  });

  it("sends the desk settings", async () => {
    apiFetch.mockImplementation(async () => json({ status: { running: false }, reports: [] }));
    renderHook(() => useServerScanner(desk, vi.fn()));
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => u === "/api/desk/state")).toBe(true), { timeout: 3000 });
    const [, init] = apiFetch.mock.calls.find(([u]) => u === "/api/desk/state")!;
    expect(JSON.parse(init.body)).toEqual(desk);
  });

  it("sends the settings again when the server says it doesn't have them", async () => {
    apiFetch.mockImplementation(async (u: string) =>
      u.startsWith("/api/scanner/reports") ? json({ status: { running: false, hasDesk: false }, reports: [] }) : json({ success: true, status: { running: true } })
    );
    renderHook(() => useServerScanner(desk, vi.fn()));
    // Once from the poll's answer, straight away (not only after the 1s debounce).
    await waitFor(() => expect(apiFetch.mock.calls.filter(([u]) => u === "/api/desk/state").length).toBeGreaterThanOrEqual(1), { timeout: 500 });
  });

  it("falls back to scanning in the browser when the server isn't scanning or can't be reached", async () => {
    apiFetch.mockImplementation(async () => json({ status: { running: false, lastScanAt: 0 }, reports: [] }));
    const { result } = renderHook(() => useServerScanner(desk, vi.fn()));
    await waitFor(() => expect(result.current.location).toBe("browser"));

    apiFetch.mockImplementation(async () => {
      throw new Error("offline");
    });
    const second = renderHook(() => useServerScanner(desk, vi.fn()));
    await waitFor(() => expect(second.result.current.location).toBe("browser"));
  });
});
