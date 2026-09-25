// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({ currentUser: { email: "owner@example.com" }, userRole: "commander", logout: vi.fn() }),
}));
vi.mock("../../src/hooks/usePWAInstall", () => ({ usePWAInstall: () => ({ isInstallable: false, isInstalled: false, install: vi.fn() }) }));

import { SettingsSheet, formatSpan, type SettingsSheetProps } from "../../src/components/ledger/SettingsSheet";

import { cleanMarketLimits } from "../../src/shared/marketLimits";
afterEach(cleanup);

const props = (over: Partial<SettingsSheetProps> = {}): SettingsSheetProps => ({
  isOpen: true, onClose: vi.fn(), tradingMode: "PAPER", onTradingModeChange: vi.fn(), coinDcxStatus: null,
  coinDcxBalance: { totalInr: 0, loading: false } as any, onRefreshBalance: vi.fn(), zerodhaStatus: "idle" as any,
  zerodhaError: "", onZerodhaConnect: vi.fn(), dailyLossLimit: 2500, maxOpenPositions: 3,
  riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits: cleanMarketLimits(null) }, onRiskLimitsChange: vi.fn(),
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

describe("Settings: trade size per market", () => {
  it("sets amount per trade and trades at once separately for coins, Indian stocks and US stocks", () => {
    const onRiskLimitsChange = vi.fn();
    render(createElement(SettingsSheet, props({ onRiskLimitsChange })));
    expect(screen.getByText("Up to ₹10,000 in coins at a time")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Coins: amount per trade"), { target: { value: "3000" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), coins: { amountPerTradeInr: 3000, maxOpenTrades: 2 } },
    });
    fireEvent.change(screen.getByLabelText("Indian stocks: trades at once"), { target: { value: "4" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), stocks: { amountPerTradeInr: 5000, maxOpenTrades: 4 } },
    });
    fireEvent.change(screen.getByLabelText("US stocks: amount per trade"), { target: { value: "2000" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), us: { amountPerTradeInr: 2000, maxOpenTrades: 2 } },
    });
    expect(screen.queryByLabelText("Largest trade")).toBeNull();
  });

  it("in Live mode, flags an amount above the server's cap per live order, and stocks as paper only", () => {
    const riskLimits = {
      maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1,
      marketLimits: { ...cleanMarketLimits(null), coins: { amountPerTradeInr: 10000, maxOpenTrades: 2 } },
    };
    const coinDcxStatus = { liveRisk: { enabled: true, maxOrderNotionalInr: 5000, maxDailyNotionalInr: 20000, maxDailyOrders: 10 } } as any;
    render(createElement(SettingsSheet, props({ tradingMode: "LIVE_COINDCX", riskLimits, coinDcxStatus })));
    expect(screen.getByText(/Above the server's ₹5,000 cap per live order: live orders this size are refused/)).toBeTruthy();
    expect(screen.getByText("Angel One · paper only for now")).toBeTruthy();
  });
});

describe("Settings: market rows say whether each market is being scanned", () => {
  const status = (over = {}) => ({
    startedAt: 0, uptimeSec: 60, storage: { dir: "/data", kept: true, note: "On a mounted volume" },
    angelOne: { configured: true, loggedIn: true, lastLoginAt: 0, lastError: null, stocksKnown: 50 },
    alpaca: { configured: true, accountStatus: "ACTIVE", lastError: null },
    fx: { usdInr: 95.82, at: 0, source: "ECB reference rate" },
    ...over,
  });
  afterEach(() => vi.useRealTimers());

  it("says the market is closed after hours, even when logged in", () => {
    // Thursday 21:30 IST = 12:00 New York: NSE closed, US open.
    vi.useFakeTimers({ now: Date.parse("2026-09-24T16:00:00Z"), toFake: ["Date"] });
    const text = render(createElement(SettingsSheet, props({ serverStatus: status() as any }))).container.textContent ?? "";
    expect(text).toContain("Market closed · scans the Nifty 50 from 9:15 to 3:00 IST on weekdays");
    expect(text).toContain("Scanning now, until 3:30 New York time");
  });

  it("says it's scanning during the session", () => {
    // Thursday 11:00 IST = 01:30 New York: NSE open, US closed.
    vi.useFakeTimers({ now: Date.parse("2026-09-24T05:30:00Z"), toFake: ["Date"] });
    const text = render(createElement(SettingsSheet, props({ serverStatus: status() as any }))).container.textContent ?? "";
    expect(text).toContain("Scanning now, until 3:00 IST · Nifty 50, 50 found");
    expect(text).toContain("Market closed · scans 9:30–3:30 New York time");
  });
});
