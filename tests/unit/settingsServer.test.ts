// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({ currentUser: { email: "owner@example.com" }, userRole: "commander", logout: vi.fn() }),
}));
vi.mock("../../src/hooks/usePWAInstall", () => ({ usePWAInstall: () => ({ isInstallable: false, isInstalled: false, install: vi.fn() }) }));

import { SettingsSheet, formatSpan, type SettingsSheetProps } from "../../src/components/ledger/SettingsSheet";

afterEach(cleanup);

const props = (over: Partial<SettingsSheetProps> = {}): SettingsSheetProps => ({
  isOpen: true, onClose: vi.fn(), tradingMode: "PAPER", onTradingModeChange: vi.fn(), coinDcxStatus: null,
  coinDcxBalance: { totalInr: 0, loading: false } as any, onRefreshBalance: vi.fn(), zerodhaStatus: "idle" as any,
  zerodhaError: "", onZerodhaConnect: vi.fn(), dailyLossLimit: 2500, maxOpenPositions: 3,
  riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1 }, onRiskLimitsChange: vi.fn(),
  onOpenDeskBrief: vi.fn(), onOpenBackground: vi.fn(), onOpenSecurity: vi.fn(),
  ...over,
});

describe("Settings: Server", () => {
  it("formats spans of time", () => {
    expect(formatSpan(45_000)).toBe("45 sec");
    expect(formatSpan(12 * 60_000)).toBe("12 min");
    expect(formatSpan(5 * 3600_000)).toBe("5 h");
    expect(formatSpan(3 * 86400_000)).toBe("3 days");
  });

  it("shows how long the server has run, whether its state is kept, and where scanning runs", () => {
    const status = {
      startedAt: 0, uptimeSec: 3 * 86400, cloudRun: { service: "nexus-desk", revision: "r1" },
      storage: { dir: "/data", kept: true, note: "On a mounted volume" },
      scanner: { lastTickAt: 0, lastCycleDoneAt: 0, stalled: false },
    };
    const { container } = render(
      createElement(SettingsSheet, props({ serverStatus: status, scanLocation: "server", lastServerScanAt: Date.now() - 2 * 60_000 }))
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Running for.*keeps growing\.3 days/);
    expect(text).toContain("Saved stateOn a mounted volumeKept");
    expect(text).toContain("Last scan 2 min ago");
    expect(text).toContain("On the server");
  });

  it("warns when saved state won't survive a restart", () => {
    const status = {
      startedAt: 0, uptimeSec: 120, cloudRun: { service: "nexus-desk", revision: "r1" },
      storage: { dir: "/app/data", kept: false, note: "On Cloud Run's temporary disk: lost when the server restarts or is redeployed" },
      scanner: { lastTickAt: 0, lastCycleDoneAt: 0, stalled: false },
    };
    const { container } = render(createElement(SettingsSheet, props({ serverStatus: status, scanLocation: "browser" })));
    expect(container.textContent).toContain("Lost on restart");
    expect(container.textContent).toContain("Only while this app is open");
  });
});

describe("trade pop-ups", () => {
  it("switch on and off from Settings, and say why when they can't", () => {
    const enable = vi.fn();
    const disable = vi.fn();
    const { rerender } = render(createElement(SettingsSheet, props({ notifications: { state: "off", error: "", enable, disable } })));
    const toggle = screen.getByRole("switch", { name: "Trade pop-ups" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(enable).toHaveBeenCalled();

    rerender(createElement(SettingsSheet, props({ notifications: { state: "on", error: "", enable, disable } })));
    fireEvent.click(screen.getByRole("switch", { name: "Trade pop-ups" }));
    expect(disable).toHaveBeenCalled();

    rerender(createElement(SettingsSheet, props({ notifications: { state: "blocked", error: "", enable, disable } })));
    expect(screen.getByText(/allow notifications in your browser's site settings/)).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Trade pop-ups" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
