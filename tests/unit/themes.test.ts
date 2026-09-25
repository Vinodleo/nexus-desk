// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, act, screen } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({ currentUser: { email: "owner@example.com" }, userRole: "commander", logout: vi.fn() }),
}));
vi.mock("../../src/hooks/usePWAInstall", () => ({ usePWAInstall: () => ({ isInstallable: false, isInstalled: false, install: vi.fn() }) }));

import { SettingsSheet, type SettingsSheetProps } from "../../src/components/ledger/SettingsSheet";
import { cleanMarketLimits } from "../../src/shared/marketLimits";
import { THEMES, loadTheme } from "../../src/services/theme";
import { useTheme } from "../../src/hooks/useTheme";

// Settings → Appearance: Ivory (the default), Graphite (dark) and Blush (pink), per device.

const props = (over: Partial<SettingsSheetProps> = {}): SettingsSheetProps => ({
  isOpen: true, onClose: vi.fn(), tradingMode: "PAPER", onTradingModeChange: vi.fn(), coinDcxStatus: null,
  coinDcxBalance: { totalInr: 0, loading: false } as any, onRefreshBalance: vi.fn(), zerodhaStatus: "idle" as any,
  zerodhaError: "", onZerodhaConnect: vi.fn(), dailyLossLimit: 2500, maxOpenPositions: 3,
  riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits: cleanMarketLimits(null) }, onRiskLimitsChange: vi.fn(),
  onOpenDeskBrief: vi.fn(), onOpenBackground: vi.fn(), onOpenSecurity: vi.fn(),
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.head.innerHTML = '<meta name="theme-color" content="#F6F3EE">';
});
afterEach(cleanup);

describe("themes", () => {
  it("offers Ivory, Graphite and Blush, Ivory by default", () => {
    expect(THEMES.map((t) => t.name)).toEqual(["Ivory", "Graphite", "Blush"]);
    expect(loadTheme()).toBe("ivory");
    localStorage.setItem("nexus_theme", "neon");
    expect(loadTheme()).toBe("ivory");
  });

  it("shows a chosen theme straight away, with the status bar to match, and keeps it on this device", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("graphite"));
    expect(result.current.theme).toBe("graphite");
    expect(document.documentElement.dataset.theme).toBe("graphite");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#141311");
    expect(localStorage.getItem("nexus_theme")).toBe("graphite");
    expect(renderHook(() => useTheme()).result.current.theme).toBe("graphite");
  });

  it("is picked in Settings → Appearance", () => {
    const onThemeChange = vi.fn();
    render(createElement(SettingsSheet, props({ theme: "ivory", onThemeChange })));
    expect(screen.getByRole("button", { name: "Ivory theme" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Blush theme" }));
    expect(onThemeChange).toHaveBeenCalledWith("blush", expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  });

  it("has every colour token in every theme, and the page applies the saved one before drawing", () => {
    const css = readFileSync(resolve(__dirname, "../../src/index.css"), "utf8");
    const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
    const tokens = (b: string) => [...b.matchAll(/--nx-[a-z-]+/g)].map((m) => m[0]).sort();
    const base = tokens(block(":root {"));
    expect(tokens(block('html[data-theme="graphite"]'))).toEqual(base);
    expect(tokens(block('html[data-theme="blush"]'))).toEqual(base);
    const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
    expect(html).toContain('localStorage.getItem("nexus_theme")');
    expect(html).not.toMatch(/#F6F3EE\]/);
  });
});
