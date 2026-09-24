// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Renders the real App with only its outside world stubbed: Firebase auth,
// our /api calls, the live price stream and browser APIs jsdom lacks. It
// catches wiring mistakes (hook order, undefined values at runtime, props)
// that the typecheck can't.

const apiFetch = vi.fn(async (url: string) => {
  if (url === "/api/coindcx/status") {
    return new Response(JSON.stringify({ success: true, configured: false, keyMasked: null, liveRisk: {} }));
  }
  return new Response(JSON.stringify({ success: true, events: [], activePositions: [] }));
});
vi.mock("../../src/services/apiClient", () => ({
  apiFetch: (url: string) => apiFetch(url),
  authenticateSocket: vi.fn(),
}));

vi.mock("../../src/context/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { uid: "u1", email: "owner@example.com" },
    userProfile: { uid: "u1", email: "owner@example.com", displayName: "Owner", role: "commander", provider: "google", lastLoginAt: "" },
    userRole: "commander",
    loading: false,
    logSecurityAudit: vi.fn(),
    openAuthModal: vi.fn(),
    closeAuthModal: vi.fn(),
    authModalOpen: false,
    recentAudits: [],
    switchUserRole: vi.fn(),
    logout: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithEmail: vi.fn(),
    signUpWithEmail: vi.fn(),
    signInDemoOperator: vi.fn(),
  }),
}));

vi.mock("../../src/services/firebase", () => ({ auth: { currentUser: null }, db: {}, default: {} }));

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

beforeAll(() => {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("Worker", class { postMessage() {} terminate() {} addEventListener() {} onmessage = null; });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  // The first click arms an audio keep-alive; jsdom has no media playback.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  URL.createObjectURL = () => "blob:stub";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(cleanup);

describe("App smoke test", () => {
  it("renders the desk and reaches the server for guardian sync and CoinDCX status", async () => {
    const errors: unknown[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
    const { default: App } = await import("../../src/App");

    await act(async () => {
      render(createElement(App));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(document.body.textContent?.length).toBeGreaterThan(100);
    // Opens on the Floor, in the Private Ledger design.
    expect(document.body.textContent).toContain("Paper equity");
    expect(document.body.textContent).toContain("Open positions");

    // Settings opens over it, and every other tab still renders.
    await act(async () => {
      screen.getByRole("button", { name: "Settings" }).click();
    });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: "Close settings" }).click();
    });
    for (const tab of ["Queue", "Book", "Learning", "Lab", "Floor"]) {
      await act(async () => {
        within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: new RegExp(`^${tab}`) }).click();
      });
    }
    expect(document.body.textContent).toContain("Paper equity");
    const called = apiFetch.mock.calls.map(([u]) => u);
    expect(called).toContain("/api/coindcx/status");
    expect(called).toContain("/api/daemon/sync-positions");
    expect(called.some((u) => u.startsWith("/api/daemon/closed-events"))).toBe(true);
    // React reports render crashes and bad hook usage via console.error.
    const reactErrors = errors.filter((a) => String((a as unknown[])[0]).match(/Error|Warning: (Invalid hook|Rendered (more|fewer) hooks)/));
    expect(reactErrors).toEqual([]);
    errorSpy.mockRestore();
    void screen;
  }, 30000);
});
