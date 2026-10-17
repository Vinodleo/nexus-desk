// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({ currentUser: { email: "owner@example.com" }, userRole: "commander", logout: vi.fn() }),
}));
vi.mock("../../src/hooks/usePWAInstall", () => ({ usePWAInstall: () => ({ isInstallable: false, isInstalled: false, install: vi.fn() }) }));
vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(async () => new Response("Not found", { status: 404 })), authenticateSocket: vi.fn() }));

import { SettingsSheet, backupSummary, coinDcxCheckSummary, errorReportsSummary, formatSpan, shortRupees, type SettingsSheetProps } from "../../src/components/ledger/SettingsSheet";
import { HOLD_MS } from "../../src/components/ledger/ui";
import { LINK_CHECK_MS } from "../../src/hooks/useTelegramLink";
import { apiFetch } from "../../src/services/apiClient";

import { cleanMarketLimits } from "../../src/shared/marketLimits";
afterEach(cleanup);

const props = (over: Partial<SettingsSheetProps> = {}): SettingsSheetProps => ({
  isOpen: true, onClose: vi.fn(), tradingMode: "PAPER", onTradingModeChange: vi.fn(), coinDcxStatus: null,
  coinDcxBalance: { totalInr: 0, loading: false } as any, onRefreshBalance: vi.fn(),
  dailyLossLimit: 2500, maxOpenPositions: 3,
  riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits: cleanMarketLimits(null) }, onRiskLimitsChange: vi.fn(),
  onOpenDeskBrief: vi.fn(), onOpenPhone: vi.fn(),
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
    expect(screen.getByTestId("server-uptime").textContent).toMatch(/^Running for3 daysA restart resets this/);
    expect(screen.getByTestId("server-state").textContent).toBe("Saved stateKeptOn a mounted volume");
    expect(screen.getByTestId("server-scanning").textContent).toBe("Scanning" + "On the server" + "Last scan 2 min ago");
    expect(container.querySelectorAll("[data-testid^=server-]")).toHaveLength(6);
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
    fireEvent.change(screen.getByLabelText("Coins: amount per trade"), { target: { value: "3000" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), coins: { amountPerTradeInr: 3000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 3, momentumTrades: 0, fundsTrades: 0 } },
    });
    fireEvent.change(screen.getByLabelText("Indian stocks: trades at once"), { target: { value: "4" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), stocks: { amountPerTradeInr: 5000, maxOpenTrades: 4, riskPerTradeInr: 50, breakoutTrades: 0, momentumTrades: 0, fundsTrades: 0 } },
    });
    fireEvent.change(screen.getByLabelText("US stocks: amount per trade"), { target: { value: "2000" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), us: { amountPerTradeInr: 2000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 3, momentumTrades: 3, fundsTrades: 3 } },
    });
    expect(screen.queryByLabelText("Largest trade")).toBeNull();
  });

  it("sets breakout 55/20's own slots for coins and US stocks (none for Indian stocks), and switches it off at none", () => {
    const onRiskLimitsChange = vi.fn();
    render(createElement(SettingsSheet, props({ onRiskLimitsChange })));
    expect(screen.getByLabelText("Coins: breakout trades at once")).toBeTruthy();
    expect(screen.getByLabelText("US stocks: breakout trades at once")).toBeTruthy();
    expect(screen.queryByLabelText("Indian stocks: breakout trades at once")).toBeNull();
    expect(screen.getAllByText("Up to ₹15,000 more")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Coins: breakout trades at once"), { target: { value: "5" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), coins: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 5, momentumTrades: 0, fundsTrades: 0 } },
    });
    fireEvent.change(screen.getByLabelText("US stocks: breakout trades at once"), { target: { value: "0" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), us: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 0, momentumTrades: 3, fundsTrades: 3 } },
    });
  });

  it("sets US momentum's own slots (US stocks only, up to its top 3), and switches it off at none", () => {
    const onRiskLimitsChange = vi.fn();
    render(createElement(SettingsSheet, props({ onRiskLimitsChange })));
    expect(screen.queryByLabelText("Coins: momentum trades at once")).toBeNull();
    expect(screen.queryByLabelText("Indian stocks: momentum trades at once")).toBeNull();
    const row = screen.getByLabelText("US stocks: momentum trades at once") as HTMLSelectElement;
    expect([...row.options].map((o) => o.textContent)).toEqual(["Off", "1", "2", "3"]);
    expect(screen.getByText("Its weekly top 3, up to ₹15,000 more")).toBeTruthy();
    fireEvent.change(row, { target: { value: "0" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), us: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 3, momentumTrades: 0, fundsTrades: 3 } },
    });
  });

  it("sets the funds' breakout slots (gold, bonds and the rest: US stocks only), and switches them off at none", () => {
    const onRiskLimitsChange = vi.fn();
    render(createElement(SettingsSheet, props({ onRiskLimitsChange })));
    expect(screen.queryByLabelText("Coins: funds breakout trades at once")).toBeNull();
    expect(screen.queryByLabelText("Indian stocks: funds breakout trades at once")).toBeNull();
    const row = screen.getByLabelText("US stocks: funds breakout trades at once") as HTMLSelectElement;
    expect([...row.options].map((o) => o.textContent)).toEqual(["Off", "1", "2", "3", "4", "5", "6"]);
    expect(screen.getByText("Gold, bond and other funds, up to ₹15,000 more")).toBeTruthy();
    fireEvent.change(row, { target: { value: "0" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), us: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 50, breakoutTrades: 3, momentumTrades: 3, fundsTrades: 0 } },
    });
  });

  it("sets the most a trade may lose, per market, and says when the amount caps it", () => {
    const onRiskLimitsChange = vi.fn();
    render(createElement(SettingsSheet, props({ onRiskLimitsChange })));
    // ₹50 of ₹5,000: a stop closer than 1% reaches the amount first.
    expect(screen.getAllByText("Sized to lose this at the stop; less if the stop is under 1% away")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Coins: most to lose per trade"), { target: { value: "150" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({
      marketLimits: { ...cleanMarketLimits(null), coins: { amountPerTradeInr: 5000, maxOpenTrades: 2, riskPerTradeInr: 150, breakoutTrades: 3, momentumTrades: 0, fundsTrades: 0 } },
    });
  });

  it("in Live mode, flags an amount above the server's cap per live order, and stocks as paper only", () => {
    const riskLimits = {
      maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1,
      marketLimits: { ...cleanMarketLimits(null), coins: { amountPerTradeInr: 10000, maxOpenTrades: 2 } },
    };
    const coinDcxStatus = { liveRisk: { enabled: true, maxOrderNotionalInr: 5000, maxDailyNotionalInr: 20000, maxDailyOrders: 10 } } as any;
    render(createElement(SettingsSheet, props({ tradingMode: "LIVE_COINDCX", riskLimits, coinDcxStatus })));
    expect(screen.getByText(/Above the server's ₹5,000 cap per live order: live orders this size are refused/)).toBeTruthy();
    expect(screen.getByText("The most one trade can cost · Angel One · paper only for now")).toBeTruthy();
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

describe("Settings: motion", () => {
  afterEach(() => vi.useRealTimers());

  it("opens as a circle from the gear, with its ✕ on the gear's spot, and closes back into it", () => {
    const from = { left: 330, top: 20, width: 44, height: 44 };
    const { rerender } = render(createElement(SettingsSheet, props({ from })));
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("nx-circle-in");
    expect(dialog.style.getPropertyValue("--nx-ox")).toBe("352px");
    expect(dialog.style.getPropertyValue("--nx-oy")).toBe("42px");
    const close = screen.getByRole("button", { name: "Close settings" });
    expect(close.className).toContain("nx-x-in");
    expect(close.style.left).toBe("330px");
    rerender(createElement(SettingsSheet, props({ from, isOpen: false })));
    expect(screen.getByRole("dialog").className).toContain("nx-circle-out");
    expect(screen.getByRole("button", { name: "Close settings" }).className).toContain("nx-x-out");
  });

  it("rises in as before when opened another way", () => {
    render(createElement(SettingsSheet, props()));
    expect(screen.getByRole("dialog").className).toContain("nx-page-in");
    expect(screen.getAllByRole("button", { name: "Close settings" })).toHaveLength(1);
  });

  it("slides one ring to the picked theme, and the mode pill to Live in amber with a notice", () => {
    const { rerender } = render(createElement(SettingsSheet, props({ theme: "ivory", onThemeChange: vi.fn() })));
    expect(screen.getByTestId("theme-ring").style.transform).toBe("translateX(calc(0 * (100% + 10px)))");
    rerender(createElement(SettingsSheet, props({ theme: "blush", onThemeChange: vi.fn() })));
    expect(screen.getByTestId("theme-ring").style.transform).toBe("translateX(calc(2 * (100% + 10px)))");
    expect(screen.getByTestId("mode-pill").className).toContain("bg-accent");
    expect(screen.queryByText(/Real orders on CoinDCX from now on/)).toBeNull();
    rerender(createElement(SettingsSheet, props({ tradingMode: "LIVE_COINDCX" })));
    expect(screen.getByTestId("mode-pill").className).toContain("bg-warn");
    expect(screen.getByTestId("mode-pill").style.transform).toBe("translateX(100%)");
    expect(screen.getByText(/Real orders on CoinDCX from now on/).className).toContain("nx-drop-down");
  });

  it("shimmers while the server's status loads, then shows Connected with a live dot", () => {
    const { rerender } = render(createElement(SettingsSheet, props({ serverStatus: null })));
    expect(screen.getAllByRole("status", { name: "Checking" }).length).toBeGreaterThanOrEqual(2);
    const status = {
      startedAt: 0, uptimeSec: 60, storage: { dir: "/data", kept: true, note: "" },
      angelOne: { configured: true, loggedIn: true, lastLoginAt: 0, lastError: null, stocksKnown: 50 },
      alpaca: { configured: true, accountStatus: "ACTIVE", lastError: null },
    };
    rerender(createElement(SettingsSheet, props({ serverStatus: status as any })));
    // Only CoinDCX's and Telegram's own checks (not given here) are still on their way.
    expect(screen.queryAllByRole("status", { name: "Checking" })).toHaveLength(2);
    expect(document.querySelectorAll(".nx-ring").length).toBeGreaterThanOrEqual(2);
  });

  it("rolls a changed amount's digits into place, with the phone's own picker on the figure", () => {
    const limits = cleanMarketLimits(null);
    const onRiskLimitsChange = vi.fn();
    const p = (marketLimits = limits) => props({ onRiskLimitsChange, riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits } });
    const { rerender } = render(createElement(SettingsSheet, p()));
    const figure = () => screen.getByLabelText("Coins: amount per trade").parentElement!;
    expect(figure().querySelector(".nx-odo .sr-only")!.textContent).toBe("₹5,000");
    rerender(createElement(SettingsSheet, p({ ...limits, coins: { ...limits.coins, amountPerTradeInr: 10000 } })));
    expect(figure().querySelector(".nx-odo .sr-only")!.textContent).toBe("₹10,000");
    // The 1 rolls in at the left: each digit is a strip slid to its value.
    const strips = [...figure().querySelectorAll<HTMLElement>(".nx-odo-strip")].map((s) => s.style.transform);
    expect(strips).toHaveLength(5);
    expect(strips[0]).toBe("translateY(-10%)");
    for (const zero of strips.slice(1)) expect(zero).toMatch(/^translateY\(-?0%\)$/);
    // The real dropdown is still there to tap.
    fireEvent.change(screen.getByLabelText("Coins: amount per trade"), { target: { value: "5000" } });
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({ marketLimits: limits });
  });

  it("shows Checking… then a tick when looking for updates", async () => {
    render(createElement(SettingsSheet, props()));
    const btn = screen.getByRole("button", { name: "Check for updates" });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ update: async () => {}, installing: null, waiting: null }) } });
    fireEvent.click(btn);
    expect(btn.textContent).toContain("Checking…");
    expect(await screen.findByText("Up to date")).toBeTruthy();
  });
});

describe("Settings: backups", () => {
  const status = (backup?: object) =>
    ({ startedAt: 0, uptimeSec: 60, cloudRun: null, storage: { dir: "/data", kept: true, note: "" }, scanner: { lastTickAt: 0, lastCycleDoneAt: 0, stalled: false }, backup }) as any;
  const on = { configured: true, keepDays: 30, lastAt: null, files: 0, lastBytes: 0, lastError: null, lastErrorAt: null };
  const now = Date.parse("2026-10-05T12:00:00Z");

  it("say whether daily backups are on, when the last was, and when they fail", () => {
    expect(backupSummary(status(), now)).toMatchObject({ badge: "—" });
    const none = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "BUCKET_NAME"];
    expect(backupSummary(status({ ...on, configured: false, missing: none }), now)).toEqual({
      sub: "The server sees no storage settings. If `fly secrets list` shows AWS_… and BUCKET_NAME, run `fly secrets deploy`; if not, `fly storage create -a nexus-desk-vinodleo` (docs/hosting.md)",
      badge: "Off",
      tone: "text-warn",
    });
    // Some there, some not: it names the ones the server can't see.
    expect(backupSummary(status({ ...on, configured: false, missing: ["AWS_ENDPOINT_URL_S3", "BUCKET_NAME"] }), now)).toEqual({
      sub: "The server can't see AWS_ENDPOINT_URL_S3, BUCKET_NAME: run `fly secrets deploy` in Cloud Shell (docs/hosting.md)", badge: "Off", tone: "text-warn",
    });
    expect(backupSummary(status(on), now)).toMatchObject({ badge: "On", sub: "Set up; the first backup runs a few minutes after the server starts" });
    const last = { ...on, lastAt: now - 3 * 60 * 60 * 1000, files: 18 };
    expect(backupSummary(status(last), now)).toEqual({ sub: "Last 3 h ago, 18 files · each kept 30 days", badge: "On", tone: "text-gain" });
    // A failure after the last success shows; one before it doesn't.
    expect(backupSummary(status({ ...last, lastError: "Upload refused (403 AccessDenied)", lastErrorAt: now - 60_000 }), now)).toEqual({
      sub: "Last try failed: Upload refused (403 AccessDenied). It tries again every hour.", badge: "Failing", tone: "text-loss",
    });
    expect(backupSummary(status({ ...last, lastError: "old", lastErrorAt: now - 5 * 60 * 60 * 1000 }), now).badge).toBe("On");
  });

  it("show in the Server section", () => {
    render(createElement(SettingsSheet, props({ serverStatus: status({ ...on, configured: false, missing: ["BUCKET_NAME"] }) })));
    expect(screen.getByText("Backups")).toBeTruthy();
    expect(screen.getByText("The server can't see BUCKET_NAME: run `fly secrets deploy` in Cloud Shell (docs/hosting.md)")).toBeTruthy();
  });
});

describe("Settings: the CoinDCX check", () => {
  const status = (coinDcxCheck?: object) =>
    ({ startedAt: 0, uptimeSec: 60, cloudRun: null, storage: { dir: "/data", kept: true, note: "" }, scanner: { lastTickAt: 0, lastCycleDoneAt: 0, stalled: false }, coinDcxCheck }) as any;
  const on = { configured: true, lastAt: null, lastTriedAt: null, trades: 0, coins: [], problems: [], extras: [], lastError: null, lastErrorAt: null, liveTrades: 0 };
  const now = Date.parse("2026-10-05T12:00:00Z");
  const checked = { ...on, lastAt: now - 2 * 60 * 60 * 1000, lastTriedAt: now - 2 * 60 * 60 * 1000 };

  it("says whether the coins at CoinDCX match the live trades", () => {
    expect(coinDcxCheckSummary(status(), now)).toMatchObject({ badge: "—" });
    expect(coinDcxCheckSummary(status({ ...on, configured: false }), now)).toEqual({ sub: "No CoinDCX keys on the server: needed only for live trading", badge: "Off", tone: "text-muted" });
    expect(coinDcxCheckSummary(status(on), now)).toMatchObject({ badge: "On", sub: "Keys set; the first check runs a few minutes after the server starts" });
    expect(coinDcxCheckSummary(status(checked), now)).toEqual({ sub: "Checked 2 h ago: no live trades; the keys work", badge: "OK", tone: "text-gain" });
    expect(coinDcxCheckSummary(status({ ...checked, trades: 1, coins: ["BTC"], extras: [{ coin: "ETH", held: 0.01 }] }), now)).toEqual({
      sub: "Checked 2 h ago: 1 live trade (BTC), coins match · also held outside the app: ETH", badge: "OK", tone: "text-gain",
    });
  });

  it("shows a mismatch and a failed check", () => {
    const problems = [
      { coin: "BTC", kind: "missing", expected: 0.002, held: 0.0012, positions: ["p1"] },
      { coin: "SOL", kind: "fee", expected: 1, held: 0.996, positions: ["p2"] },
    ];
    expect(coinDcxCheckSummary(status({ ...checked, trades: 2, problems }), now)).toEqual({
      sub: "BTC: CoinDCX has 0.0012, the live trades hold 0.002 · SOL: 0.4% under the live trade's 1 (likely the fee); close it at CoinDCX",
      badge: "Mismatch",
      tone: "text-loss",
    });
    const failing = { ...checked, lastError: "CoinDCX answered 401", lastErrorAt: now - 60_000 };
    expect(coinDcxCheckSummary(status(failing), now)).toEqual({ sub: "Last check failed: CoinDCX answered 401. It tries again within the hour.", badge: "Failing", tone: "text-warn" });
    expect(coinDcxCheckSummary(status({ ...failing, liveTrades: 1 }), now).tone).toBe("text-loss");
  });

  it("shows in the Server section", () => {
    render(createElement(SettingsSheet, props({ serverStatus: status({ ...on, configured: false }) })));
    expect(screen.getByText("CoinDCX check")).toBeTruthy();
    expect(screen.getByText("No CoinDCX keys on the server: needed only for live trading")).toBeTruthy();
  });
});

describe("Settings: error reports", () => {
  const status = (errorReports?: object) =>
    ({ startedAt: 0, uptimeSec: 60, cloudRun: null, storage: { dir: "/data", kept: true, note: "" }, scanner: { lastTickAt: 0, lastCycleDoneAt: 0, stalled: false }, errorReports }) as any;

  it("say whether the server's errors go to Sentry", () => {
    expect(errorReportsSummary(null)).toMatchObject({ badge: "—" });
    expect(errorReportsSummary(status())).toMatchObject({ badge: "—" });
    expect(errorReportsSummary(status({ on: false }))).toEqual({
      sub: "Off: set SENTRY_DSN on the server to send its errors to Sentry (docs/hosting.md)", badge: "Off", tone: "text-muted",
    });
    expect(errorReportsSummary(status({ on: true }))).toMatchObject({ badge: "On", tone: "text-gain" });
  });

  it("show in the Server section", () => {
    render(createElement(SettingsSheet, props({ serverStatus: status({ on: true }) })));
    expect(screen.getByText("Error reports")).toBeTruthy();
    expect(screen.getByText("The server's errors go to Sentry (nexus-desk), without keys, tokens or emails")).toBeTruthy();
  });
});

describe("Settings: paper money", () => {
  afterEach(() => vi.useRealTimers());

  it("shortens amounts for the chips", () => {
    expect(shortRupees(100_000)).toBe("₹1L");
    expect(shortRupees(2_500_000)).toBe("₹25L");
    expect(shortRupees(150_000)).toBe("₹1.5L");
    expect(shortRupees(10_000_000)).toBe("₹1Cr");
    expect(shortRupees(50_000)).toBe("₹50,000");
  });

  it("starts the paper balance again at a picked amount only when held, on paper only", () => {
    vi.useFakeTimers();
    const onRestart = vi.fn();
    const paperMoney = { start: 100_000, equity: 101_250, onRestart };
    render(createElement(SettingsSheet, props({ paperMoney, dailyLossLimit: 2_500 })));
    // The money rolls up from zeros once the page has opened.
    const equity = () => screen.getByTestId("paper-equity").querySelector(".sr-only")!.textContent;
    expect(equity()).toBe("₹0,00,000");
    act(() => vi.advanceTimersByTime(400));
    expect(equity()).toBe("₹1,01,250");
    const chips = within(screen.getByRole("group", { name: "Start again at" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["₹1L", "₹2L", "₹5L", "₹10L", "₹25L"]);
    expect(chips[0].getAttribute("aria-label")).toBe("Start again at ₹1,00,000 (the start now)");
    // Folded away until an amount is picked.
    const fold = screen.getByTestId("paper-money-confirm");
    expect(fold.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start again at ₹10,00,000" }));
    expect(fold.className).toContain("nx-fold-open");
    expect(fold.hasAttribute("inert")).toBe(false);
    expect(fold.textContent).toContain("Starts the paper balance again at ₹10,00,000");
    const hold = screen.getByRole("button", { name: "Hold to start again at ₹10,00,000" });
    // A tap or a short press doesn't start it again.
    fireEvent.click(hold);
    fireEvent.pointerDown(hold);
    act(() => vi.advanceTimersByTime(HOLD_MS / 2));
    fireEvent.pointerUp(hold);
    expect(onRestart).not.toHaveBeenCalled();
    fireEvent.pointerDown(hold);
    act(() => vi.advanceTimersByTime(HOLD_MS + 10));
    expect(onRestart).toHaveBeenCalledWith(1_000_000);
    expect(screen.getByText("Started again at ₹10,00,000").getAttribute("role")).toBe("status");
    expect(fold.className).not.toContain("nx-fold-open");
    // Picked and then tapped again: nothing changes.
    fireEvent.click(screen.getByRole("button", { name: "Start again at ₹5,00,000" }));
    fireEvent.click(screen.getByRole("button", { name: "Start again at ₹5,00,000" }));
    expect(fold.className).not.toContain("nx-fold-open");
    expect(onRestart).toHaveBeenCalledTimes(1);
    // Larger trade sizes to choose from.
    const amounts = [...(screen.getByLabelText("Coins: amount per trade") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(amounts).toContain("₹1,00,000");
    const risks = [...(screen.getByLabelText("Coins: most to lose per trade") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(risks).toContain("₹10,000");
    cleanup();

    render(createElement(SettingsSheet, props({ paperMoney, tradingMode: "LIVE_COINDCX" })));
    expect(screen.queryByTestId("paper-equity")).toBeNull();
  });

  it("shows the daily loss limit with what today lost of it", () => {
    vi.useFakeTimers();
    render(createElement(SettingsSheet, props({ dailyLossLimit: 12_811, todayLoss: 1_840 })));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId("loss-limit").querySelector(".sr-only")!.textContent).toBe("₹12,811");
    expect(screen.getByText("Lost today ₹1,840")).toBeTruthy();
    expect(screen.getByText("₹10,971 left")).toBeTruthy();
    expect((screen.getByTestId("loss-used").firstElementChild as HTMLElement).style.width).toBe(`${(1_840 / 12_811) * 100}%`);
  });
});

describe("Settings: Live stays locked until the server takes live orders", () => {
  it("shakes and says why when Live is tapped while the server blocks live orders", () => {
    const onTradingModeChange = vi.fn();
    const { rerender } = render(createElement(SettingsSheet, props({ onTradingModeChange, coinDcxStatus: { liveRisk: { enabled: false } } as any })));
    const live = screen.getByTestId("mode-live");
    const note = screen.getByTestId("live-locked");
    expect(note.closest(".nx-fold")!.className).not.toContain("nx-fold-open");
    fireEvent.click(live);
    expect(onTradingModeChange).not.toHaveBeenCalled();
    expect(live.className).toContain("nx-shake-a");
    expect(note.closest(".nx-fold")!.className).toContain("nx-fold-open");
    expect(note.textContent).toBe("Live trading stays off until you say so. The server blocks live orders until LIVE_TRADING_ENABLED is set (docs/going-live.md).");
    expect(screen.queryByText("Switch to live")).toBeNull();
    // Each tap shakes again.
    fireEvent.click(live);
    expect(live.className).toContain("nx-shake-b");
    // No answer from the server yet: locked too.
    rerender(createElement(SettingsSheet, props({ onTradingModeChange, coinDcxStatus: null })));
    fireEvent.click(screen.getByTestId("mode-live"));
    expect(onTradingModeChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("live-locked").textContent).toContain("The server hasn't said yet whether it takes live orders.");
  });

  it("asks before switching once the server takes live orders, and goes back to Paper with a tap", () => {
    const onTradingModeChange = vi.fn();
    const { rerender } = render(createElement(SettingsSheet, props({ onTradingModeChange, coinDcxStatus: { liveRisk: { enabled: true } } as any })));
    fireEvent.click(screen.getByTestId("mode-live"));
    expect(onTradingModeChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("mode-live").className).not.toContain("nx-shake");
    fireEvent.click(screen.getByText("Switch to live"));
    expect(onTradingModeChange).toHaveBeenCalledWith("LIVE_COINDCX");
    // Live already, and the server blocking again: Paper is still a tap away.
    rerender(createElement(SettingsSheet, props({ onTradingModeChange, tradingMode: "LIVE_COINDCX", coinDcxStatus: { liveRisk: { enabled: false } } as any })));
    fireEvent.click(screen.getByTestId("mode-paper"));
    expect(onTradingModeChange).toHaveBeenLastCalledWith("PAPER");
  });
});

describe("Settings: your limits, one market at a time", () => {
  const shownMarkets = () => ["coins", "stocks", "us"].filter((m) => !screen.getByTestId(`limits-${m}`).hidden);

  it("shows the picked market's limits, sliding in from its side", () => {
    render(createElement(SettingsSheet, props()));
    expect(shownMarkets()).toEqual(["coins"]);
    fireEvent.click(screen.getByRole("button", { name: "US" }));
    expect(shownMarkets()).toEqual(["us"]);
    expect(screen.getByTestId("limits-us").className).toContain("nx-tab-from-right");
    fireEvent.click(screen.getByRole("button", { name: "India" }));
    expect(screen.getByTestId("limits-stocks").className).toContain("nx-tab-from-left");
    expect(screen.getByTestId("limits-stocks").textContent).toContain("Breakout, momentum and the funds don't trade Indian stocks");
  });

  it("steps each figure through its choices, stopping at the ends", () => {
    const onRiskLimitsChange = vi.fn();
    const limits = cleanMarketLimits(null);
    const p = (marketLimits = limits) => props({ onRiskLimitsChange, riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits } });
    const { rerender } = render(createElement(SettingsSheet, p()));
    fireEvent.click(screen.getByRole("button", { name: "Coins: amount per trade: more" }));
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({ marketLimits: { ...limits, coins: { ...limits.coins, amountPerTradeInr: 10000 } } });
    fireEvent.click(screen.getByRole("button", { name: "Coins: amount per trade: less" }));
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({ marketLimits: { ...limits, coins: { ...limits.coins, amountPerTradeInr: 3000 } } });
    fireEvent.click(screen.getByRole("button", { name: "Coins: trades at once: more" }));
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({ marketLimits: { ...limits, coins: { ...limits.coins, maxOpenTrades: 3 } } });
    rerender(createElement(SettingsSheet, p({ ...limits, coins: { ...limits.coins, amountPerTradeInr: 200000, maxOpenTrades: 1 } })));
    expect((screen.getByRole("button", { name: "Coins: amount per trade: more" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Coins: trades at once: less" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds up the most each market may hold and lose at once, slots included", () => {
    const limits = cleanMarketLimits(null);
    const marketLimits = { ...limits, stocks: { ...limits.stocks, riskPerTradeInr: 7500 } };
    render(createElement(SettingsSheet, props({ riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits } })));
    const figure = (id: string) => screen.getByTestId(id).querySelector(".sr-only")!.textContent;
    // Coins: 2 trades at once and breakout's 3, at ₹5,000 and ₹50 each.
    expect(figure("coins-at-most")).toBe("₹25,000");
    expect(figure("coins-if-stops-hit")).toBe("₹250");
    expect(screen.getByTestId("limits-coins").textContent).toContain("5 trades at ₹5,000");
    // US: 2, and breakout's, momentum's and the funds' 3 each.
    expect(figure("us-at-most")).toBe("₹55,000");
    expect(figure("us-if-stops-hit")).toBe("₹550");
    // India: no slots; a trade never loses more than it cost.
    expect(figure("stocks-at-most")).toBe("₹10,000");
    expect(figure("stocks-if-stops-hit")).toBe("₹10,000");
  });

  it("sets slots by tapping squares, with a dot in each one in use and a note when fewer than are open", () => {
    const onRiskLimitsChange = vi.fn();
    const limits = cleanMarketLimits(null);
    const positions = [
      { symbol: "SOL/INR", strategy: "breakout" }, { symbol: "AVAX/INR", strategy: "breakout" }, { symbol: "BTC/INR" },
      { symbol: "AAPL.US", strategy: "breakout" }, { symbol: "META.US", strategy: "momentum" }, { symbol: "GLD.US", strategy: "breakout" },
    ];
    const p = (marketLimits = limits) => props({ onRiskLimitsChange, positions, riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits } });
    const { rerender } = render(createElement(SettingsSheet, p()));
    const coins = screen.getByTestId("limits-coins");
    expect(within(coins).getAllByTestId("slot-square")).toHaveLength(6);
    expect(within(coins).getAllByTestId("slot-in-use")).toHaveLength(2);
    const us = screen.getByTestId("limits-us");
    expect(within(us).getAllByTestId("slot-in-use")).toHaveLength(3);
    // Momentum holds its top 3 at most: 3 squares.
    expect(within(screen.getByRole("group", { name: "US stocks: momentum slots", hidden: true })).getAllByTestId("slot-square")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Coins: 5 breakout slots" }));
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({ marketLimits: { ...limits, coins: { ...limits.coins, breakoutTrades: 5 } } });
    fireEvent.click(screen.getByRole("button", { name: "Coins: breakout off" }));
    expect(onRiskLimitsChange).toHaveBeenLastCalledWith({ marketLimits: { ...limits, coins: { ...limits.coins, breakoutTrades: 0 } } });
    expect(coins.textContent).not.toContain("open now run to their exits");
    rerender(createElement(SettingsSheet, p({ ...limits, coins: { ...limits.coins, breakoutTrades: 1 } })));
    expect(screen.getByTestId("limits-coins").textContent).toContain("2 open now run to their exits; a new one opens only once none are.");
    rerender(createElement(SettingsSheet, p({ ...limits, coins: { ...limits.coins, breakoutTrades: 0 } })));
    expect(screen.getByTestId("limits-coins").textContent).toContain("2 open now run to their exits; it opens no new ones here.");
  });
});

describe("Settings: server tiles and the test live order", () => {
  it("opens a server tile across the row on a tap, and keeps one with a problem open", () => {
    const status = {
      startedAt: 0, uptimeSec: 3 * 86400, storage: { dir: "/data", kept: true, note: "On a mounted volume" },
      backup: { configured: true, keepDays: 30, lastAt: 1, files: 18, lastBytes: 0, lastError: "Upload refused", lastErrorAt: Date.now() },
    };
    render(createElement(SettingsSheet, props({ serverStatus: status as any })));
    const uptime = screen.getByTestId("server-uptime");
    expect(uptime.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(uptime);
    expect(uptime.getAttribute("aria-expanded")).toBe("true");
    expect(uptime.className).toContain("col-span-2");
    fireEvent.click(uptime);
    expect(uptime.getAttribute("aria-expanded")).toBe("false");
    const backups = screen.getByTestId("server-backups");
    expect(backups.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(backups);
    expect(backups.getAttribute("aria-expanded")).toBe("true");
    expect(backups.textContent).toContain("Failing");
  });

  it("folds the test live order under CoinDCX, loading it only when opened", async () => {
    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch).mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, keys: true, liveEnabled: false, amountInr: 200, markets: ["SOLINR"], run: null }), { status: 200 })
    );
    const coinDcxStatus = { configured: true, keyMasked: "••••7Q2", liveRisk: { enabled: false } } as any;
    render(createElement(SettingsSheet, props({ coinDcxStatus })));
    const fold = screen.getByTestId("live-test-fold");
    expect(fold.hasAttribute("inert")).toBe(true);
    expect(apiFetch).not.toHaveBeenCalledWith("/api/live/test-order");
    fireEvent.click(screen.getByRole("button", { name: "Test live order" }));
    expect(fold.className).toContain("nx-fold-open");
    expect(await within(fold).findByText(/Live orders are blocked on the server/)).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith("/api/live/test-order");
  });
});

describe("Settings: Connections", () => {
  it("lists the connections the desk uses, and no Zerodha (never used; removed)", () => {
    render(createElement(SettingsSheet, props()));
    const group = within(screen.getByRole("region", { name: "Connections" }));
    for (const name of ["CoinDCX", "Alpaca", "Angel One", "Gemini reviewer"]) expect(group.getByText(name)).toBeTruthy();
    expect(group.queryByText(/Zerodha/)).toBeNull();
  });
});

describe("Settings: Telegram", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("links Telegram from a link to the bot, sees it linked, and sends a test", async () => {
    let linked = false;
    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch).mockImplementation(async (url: string) =>
      url === "/api/telegram"
        ? json({ success: true, configured: true, linked, linking: !linked })
        : url === "/api/telegram/link"
          ? json({ success: true, url: "https://t.me/nexus_desk_bot?start=abc123" })
          : url === "/api/telegram/test"
            ? json({ success: true })
            : new Response("Not found", { status: 404 })
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(createElement(SettingsSheet, props()));
      const row = () => screen.getByText("Telegram").parentElement!;
      fireEvent.click(await screen.findByRole("button", { name: "Link" }));
      // A real link to the bot, so the phone opens Telegram from the tap itself.
      const open = await screen.findByRole("link", { name: "Open Telegram" });
      expect(open.getAttribute("href")).toBe("https://t.me/nexus_desk_bot?start=abc123");
      expect(open.getAttribute("target")).toBe("_blank");
      expect(row().textContent).toContain("Tap Start in Telegram");

      // Start tapped in Telegram: it looks again and sees it linked.
      linked = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LINK_CHECK_MS);
      });
      expect(row().textContent).toContain("Linked: every pop-up comes here too");
      expect(screen.getByTestId("Telegram dot").className).toContain("bg-gain");
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
      expect(await screen.findByText("Sent: look in Telegram.")).toBeTruthy();
      expect(apiFetch).toHaveBeenCalledWith("/api/telegram/test", { method: "POST" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says how to set it up without a bot on the server, and stays out of the way on a server without it", async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => (url === "/api/telegram" ? json({ success: true, configured: false, linked: false, linking: false }) : new Response("Not found", { status: 404 })));
    const { unmount } = render(createElement(SettingsSheet, props()));
    expect(await screen.findByText(/set TELEGRAM_BOT_TOKEN on the server/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    unmount();
    vi.mocked(apiFetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
    render(createElement(SettingsSheet, props()));
    await waitForQuiet();
    expect(screen.queryByText("Telegram")).toBeNull();
  });
});

/** Lets pending requests settle. */
const waitForQuiet = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
