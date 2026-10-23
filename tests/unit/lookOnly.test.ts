// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isViewerOwnRoute } from "../../src/shared/lookOnly";

// A look-only account (the server's VIEWER_EMAILS): the app sends nothing that
// would change the desk, and hides what would.

vi.mock("../../src/services/firebase", () => ({ auth: { currentUser: { getIdToken: async () => "token" } } }));
vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({ currentUser: { email: "friend@example.com" }, userRole: "commander", logout: vi.fn() }),
}));
vi.mock("../../src/hooks/usePWAInstall", () => ({ usePWAInstall: () => ({ isInstallable: false, isInstalled: false, install: vi.fn() }) }));

const { apiFetch, setLookOnly, LOOK_ONLY_TEXT } = await import("../../src/services/apiClient");
const { LookOnlyContext } = await import("../../src/context/LookOnly");
const { SettingsSheet } = await import("../../src/components/ledger/SettingsSheet");
const { cleanMarketLimits } = await import("../../src/shared/marketLimits");

afterEach(() => {
  cleanup();
  setLookOnly(false);
  vi.unstubAllGlobals();
});

const lookOnly = (el: ReactElement) => createElement(LookOnlyContext.Provider, { value: true }, el);

describe("the API client on a look-only account", () => {
  it("holds back anything that would change the desk, and still reads", async () => {
    const sent: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      sent.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("Authorization") });
      return new Response("{}");
    });
    setLookOnly(true);
    const refused = await apiFetch("/api/desk/state", { method: "POST", body: "{}" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ success: false, error: LOOK_ONLY_TEXT, code: "LOOK_ONLY" });
    await apiFetch("/api/book");
    expect(sent).toEqual([{ url: "/api/book", method: "GET", auth: "Bearer token" }]);
    // Its own alerts and IPOs still go: pop-ups, Telegram, "I got shares".
    await apiFetch("/api/push/subscribe", { method: "POST", body: "{}" });
    await apiFetch("/api/telegram/link", { method: "POST" });
    await apiFetch("/api/ipos/held", { method: "POST", body: "{}" });
    expect(sent.slice(1).map((s) => s.url)).toEqual(["/api/push/subscribe", "/api/telegram/link", "/api/ipos/held"]);
    // The owner's account sends as before.
    setLookOnly(false);
    await apiFetch("/api/desk/state", { method: "POST", body: "{}" });
    expect(sent.map((s) => s.method)).toEqual(["GET", "POST", "POST", "POST", "POST"]);
  });
});

describe("Settings on a look-only account", () => {
  const props = {
    isOpen: true, onClose: vi.fn(), tradingMode: "PAPER" as const, onTradingModeChange: vi.fn(), coinDcxStatus: null,
    coinDcxBalance: { totalInr: 0, loading: false } as any, onRefreshBalance: vi.fn(),
    dailyLossLimit: 2500, maxOpenPositions: 3,
    riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits: cleanMarketLimits(null) }, onRiskLimitsChange: vi.fn(),
    onOpenDeskBrief: vi.fn(), onOpenPhone: vi.fn(),
    notifications: { state: "off" as const, error: "", enable: vi.fn(), disable: vi.fn() },
    theme: "ivory" as const, onThemeChange: vi.fn(),
  };

  it("says so, and leaves out trading, limits, connections, the server, pop-ups and the brief", () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const { container } = render(lookOnly(createElement(SettingsSheet, props as any)));
    expect(screen.getByTestId("look-only-note").textContent).toContain("can't change anything");
    for (const gone of ["Trading", "Your limits", "Connections", "Server"]) expect(screen.queryByRole("region", { name: gone })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Trade pop-ups" })).toBeNull();
    // Its own IPO alerts: pop-ups on this phone (and Telegram once the server has a bot).
    expect(screen.getByRole("region", { name: "IPO alerts" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "IPO pop-ups" })).toBeTruthy();
    expect(container.textContent).not.toContain("Desk brief");
    // What's this phone's own stays: its theme, This phone and Sign out.
    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
    expect(container.textContent).toContain("This phone");
    expect(container.textContent).toContain("Sign out");
  });

  it("is all there for the owner", () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    render(createElement(SettingsSheet, props as any));
    expect(screen.queryByTestId("look-only-note")).toBeNull();
    expect(screen.getByRole("region", { name: "Trading" })).toBeTruthy();
  });
});

describe("a look-only account's own routes", () => {
  it("are its alerts and IPOs, nothing else", () => {
    for (const own of ["/api/push/subscribe", "/api/push/status", "/api/telegram", "/api/telegram/unlink", "/api/ipos", "/api/ipos/held?x=1"]) {
      expect(isViewerOwnRoute(own)).toBe(true);
    }
    for (const not of ["/api/desk/state", "/api/iposx", "/api/telegramx", "/api/execute-trade", "/api/pushy"]) expect(isViewerOwnRoute(not)).toBe(false);
  });
});
