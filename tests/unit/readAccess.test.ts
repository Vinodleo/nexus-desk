// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Desk: Read access: the accounts that may look at the desk, added and
// removed from the app (the server's list), never shown to a look-only one.

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({ currentUser: { email: "owner@example.com" }, userRole: "commander", logout: vi.fn() }),
}));
vi.mock("../../src/hooks/usePWAInstall", () => ({ usePWAInstall: () => ({ isInstallable: false, isInstalled: false, install: vi.fn() }) }));
vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));

const { apiFetch } = await import("../../src/services/apiClient");
const { SettingsSheet } = await import("../../src/components/ledger/SettingsSheet");
const { LookOnlyContext } = await import("../../src/context/LookOnly");
const { cleanMarketLimits } = await import("../../src/shared/marketLimits");

const props = {
  isOpen: true, onClose: vi.fn(), tradingMode: "PAPER" as const, onTradingModeChange: vi.fn(), coinDcxStatus: null,
  coinDcxBalance: { totalInr: 0, loading: false } as any, onRefreshBalance: vi.fn(),
  dailyLossLimit: 2500, maxOpenPositions: 3,
  riskLimits: { maxOrderValueInr: 10000, maxAllowedExposureFraction: 0.1, marketLimits: cleanMarketLimits(null) }, onRiskLimitsChange: vi.fn(),
  onOpenDeskBrief: vi.fn(), onOpenPhone: vi.fn(),
};

/** The server's list, as the fake server holds it. */
let list: { email: string; signedIn: boolean }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  list = [{ email: "friend@example.com", signedIn: true }];
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    const email = init?.body ? JSON.parse(String(init.body)).email : "";
    if (path === "/api/viewers" && init?.method === "POST") {
      if (email === "owner@example.com") return json({ success: false, error: "That's the owner's account: it has the whole desk already.", code: "NOT_ADDED" }, 400);
      list = [...list, { email: email.toLowerCase(), signedIn: false }];
    } else if (path === "/api/viewers/remove") {
      list = list.filter((v) => v.email !== email);
    } else if (path !== "/api/viewers") {
      return new Response("Not found", { status: 404 });
    }
    return json({ success: true, viewers: list, max: 20 });
  });
});
afterEach(cleanup);

const posted = (path: string) => vi.mocked(apiFetch).mock.calls.filter(([p, i]) => p === path && i?.method === "POST").map(([, i]) => JSON.parse(String(i!.body)));

describe("Settings: Desk: Read access", () => {
  it("lists who has read access and whether each has signed in", async () => {
    render(createElement(SettingsSheet, props));
    expect((await screen.findByTestId("viewer-friend@example.com")).textContent).toContain("Has signed in");
  });

  it("adds an email", async () => {
    render(createElement(SettingsSheet, props));
    await screen.findByTestId("viewer-friend@example.com");
    fireEvent.change(screen.getByRole("textbox", { name: "Email to let look" }), { target: { value: " New@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByTestId("viewer-new@example.com")).textContent).toContain("Hasn't signed in yet");
    expect(posted("/api/viewers")).toEqual([{ email: "New@Example.com" }]);
    expect((screen.getByRole("textbox", { name: "Email to let look" }) as HTMLInputElement).value).toBe("");
  });

  it("says why the server wouldn't add one, and keeps what was typed", async () => {
    render(createElement(SettingsSheet, props));
    await screen.findByTestId("viewer-friend@example.com");
    fireEvent.change(screen.getByRole("textbox", { name: "Email to let look" }), { target: { value: "owner@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That's the owner's account: it has the whole desk already.");
    expect((screen.getByRole("textbox", { name: "Email to let look" }) as HTMLInputElement).value).toBe("owner@example.com");
  });

  it("removes one only once asked again, and Keep leaves it", async () => {
    render(createElement(SettingsSheet, props));
    fireEvent.click(await screen.findByRole("button", { name: "Remove friend@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(posted("/api/viewers/remove")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove friend@example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByTestId("viewers-empty").textContent).toBe("No one else can look at your desk."));
    expect(posted("/api/viewers/remove")).toEqual([{ email: "friend@example.com" }]);
  });

  it("isn't there on a server without the list", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
    render(createElement(SettingsSheet, props));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([p]) => p === "/api/viewers")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Desk: Read access" })).toBeNull());
  });

  it("isn't there, nor asked for, on a look-only account", () => {
    render(createElement(LookOnlyContext.Provider, { value: true }, createElement(SettingsSheet, props)));
    expect(screen.queryByRole("region", { name: "Desk: Read access" })).toBeNull();
    expect(vi.mocked(apiFetch).mock.calls.some(([p]) => String(p).startsWith("/api/viewers"))).toBe(false);
  });
});
