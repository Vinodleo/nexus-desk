// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Server → Restore a backup: pick a day, hold to restore, and the
// card waits while the server restarts until it says how it went.

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({ currentUser: { email: "owner@example.com" }, userRole: "commander", logout: vi.fn() }),
}));
vi.mock("../../src/hooks/usePWAInstall", () => ({ usePWAInstall: () => ({ isInstallable: false, isInstalled: false, install: vi.fn() }) }));
vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));

const { apiFetch } = await import("../../src/services/apiClient");
const { RestoreBackup, indiaWhen, SHOWN_BACKUPS } = await import("../../src/components/ledger/RestoreBackup");
const { RESTORE_CHECK_MS } = await import("../../src/hooks/useBackups");
const { HOLD_MS } = await import("../../src/components/ledger/ui");
const { SettingsSheet } = await import("../../src/components/ledger/SettingsSheet");
const { cleanMarketLimits } = await import("../../src/shared/marketLimits");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const days = [
  { day: "2026-10-23", bytes: 412 * 1024, at: Date.parse("2026-10-23T10:40:00Z") },
  { day: "2026-10-22", bytes: 2.5 * 1024 * 1024, at: Date.parse("2026-10-22T10:39:00Z") },
];
/** What the fake server answers: the list, a restore's request, and whether it's up. */
let server: { up: boolean; restore: unknown; post: (body: any) => Response };

beforeEach(() => {
  vi.useFakeTimers();
  server = { up: true, restore: null, post: () => json({ success: true, day: "2026-10-22", requestedAt: 555 }) };
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (!server.up) throw new TypeError("Failed to fetch");
    if (path === "/api/backups/restore") return server.post(JSON.parse(String(init?.body)));
    if (path === "/api/backups") return json({ success: true, configured: true, days, restore: server.restore, pending: null });
    return new Response("Not found", { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});
const openCard = async () => {
  render(createElement(RestoreBackup));
  fireEvent.click(screen.getByRole("button", { name: "Restore a backup" }));
  await flush();
};
const hold = async (name: string) => {
  fireEvent.pointerDown(screen.getByRole("button", { name }), { pointerType: "touch", pointerId: 1 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HOLD_MS);
  });
};

describe("restoring a backup from Settings", () => {
  it("says when each backup was made, in India time", () => {
    expect(indiaWhen(Date.parse("2026-10-23T10:40:00Z"))).toBe("Fri 23 Oct, 4:10 pm");
    expect(indiaWhen(Date.parse("2026-10-22T18:35:00Z"))).toBe("Fri 23 Oct, 12:05 am");
  });

  it("lists the backups, restores the one picked only when held, and waits for the server to come back", async () => {
    await openCard();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Fri 23 Oct, 4:10 pm412 KB", "Thu 22 Oct, 4:09 pm2.5 MB"]);
    // Nothing to hold until one is picked.
    expect(screen.queryByRole("button", { name: /Hold to restore/ })).toBeNull();
    fireEvent.click(radios[1]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    await hold("Hold to restore Thu 22 Oct, 4:09 pm");
    expect(vi.mocked(apiFetch).mock.calls.find(([p]) => p === "/api/backups/restore")![1]!.body).toBe(JSON.stringify({ day: "2026-10-22" }));
    expect(screen.getByRole("status").textContent).toContain("Restoring Thu 22 Oct, 4:09 pm: the server is restarting");

    // Down while it restarts: still waiting.
    server.up = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTORE_CHECK_MS);
    });
    expect(screen.getByRole("status").textContent).toContain("the server is restarting");
    // Back, with this restore's result.
    server.up = true;
    server.restore = { day: "2026-10-22", requestedAt: 555, at: 999, ok: true, files: 21, error: null };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTORE_CHECK_MS);
    });
    expect(screen.getByRole("status").textContent).toContain("Restored Thu 22 Oct, 4:09 pm (21 files). Reload the app to see it.");
    expect(screen.getByRole("button", { name: "Reload the app" })).toBeTruthy();
  });

  it("shows the newest week first, and the older ones on asking", async () => {
    const many = Array.from({ length: 10 }, (_, k) => ({ day: `2026-10-${String(23 - k).padStart(2, "0")}`, bytes: 1024, at: Date.parse(`2026-10-${String(23 - k).padStart(2, "0")}T10:40:00Z`) }));
    vi.mocked(apiFetch).mockImplementation(async () => json({ success: true, configured: true, days: many, restore: null, pending: null }));
    await openCard();
    expect(screen.getAllByRole("radio")).toHaveLength(SHOWN_BACKUPS);
    fireEvent.click(screen.getByRole("button", { name: "Show 3 older" }));
    expect(screen.getAllByRole("radio")).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
  });

  it("says why when the server won't restore, or the restore failed", async () => {
    server.post = () => json({ success: false, error: "There's no backup for that day." }, 404);
    await openCard();
    fireEvent.click(screen.getAllByRole("radio")[0]);
    await hold("Hold to restore Fri 23 Oct, 4:10 pm");
    expect(screen.getByRole("alert").textContent).toBe("There's no backup for that day.");
    // Still on the list, to pick again.
    expect(screen.getAllByRole("radio")).toHaveLength(2);

    server.post = () => json({ success: true, day: "2026-10-23", requestedAt: 777 });
    await hold("Hold to restore Fri 23 Oct, 4:10 pm");
    server.restore = { day: "2026-10-23", requestedAt: 777, at: 999, ok: false, files: 0, error: "Download refused (503 SlowDown)" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESTORE_CHECK_MS);
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Couldn't restore Fri 23 Oct, 4:10 pm: Download refused (503 SlowDown). The server started with its files as they were."
    );
  });

  it("is in Settings → Server only when backups are set up", async () => {
    const props = {
      isOpen: true, onClose: vi.fn(), tradingMode: "PAPER" as const, onTradingModeChange: vi.fn(), coinDcxStatus: null,
      coinDcxBalance: { totalInr: 0, loading: false } as any, onRefreshBalance: vi.fn(),
      dailyLossLimit: 2500, maxOpenPositions: 3,
      riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits: cleanMarketLimits(null) }, onRiskLimitsChange: vi.fn(),
      onOpenDeskBrief: vi.fn(), onOpenPhone: vi.fn(),
    };
    const status = (configured: boolean) => ({
      startedAt: 0, uptimeSec: 60, cloudRun: { service: "nexus-desk", revision: "r1" },
      storage: { dir: "/data", kept: true, note: "On a mounted volume" },
      scanner: { lastTickAt: 0, lastCycleDoneAt: 0, stalled: false },
      backup: { configured, keepDays: 30, lastAt: null, files: 0, lastBytes: 0, lastError: null, lastErrorAt: null },
    });
    const { rerender } = render(createElement(SettingsSheet, { ...props, serverStatus: status(false) as any }));
    expect(screen.queryByRole("button", { name: "Restore a backup" })).toBeNull();
    rerender(createElement(SettingsSheet, { ...props, serverStatus: status(true) as any }));
    expect(screen.getByRole("button", { name: "Restore a backup" })).toBeTruthy();
  });
});
