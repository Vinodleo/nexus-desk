// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// "Trade pop-ups" waited on the app's service worker with no limit: with no
// active worker it stayed on "Checking…", switch disabled, for good.

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../../src/services/apiClient", () => api);
const { useTradeNotifications, WORKER_WAIT_MS } = await import("../../src/hooks/useTradeNotifications");

function fakeBrowser(worker: { ready: Promise<unknown>; registration?: unknown; register?: () => Promise<unknown> }) {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: worker.ready,
      getRegistration: vi.fn(async () => worker.registration),
      register: vi.fn(worker.register ?? (async () => ({}))),
    },
  });
  (window as any).PushManager = function () {};
  (window as any).Notification = { permission: "default", requestPermission: vi.fn(async () => "granted") };
}

afterEach(() => {
  vi.useRealTimers();
  delete (window as any).PushManager;
  delete (window as any).Notification;
});

describe("trade pop-ups", () => {
  it("don't stay on Checking… when the app's worker never becomes ready: off, with why, switch usable", async () => {
    vi.useFakeTimers();
    fakeBrowser({ ready: new Promise(() => {}), registration: undefined });
    const { result } = renderHook(() => useTradeNotifications());
    expect(result.current.state).toBe("working");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKER_WAIT_MS + 10);
    });
    expect(result.current.state).toBe("off");
    expect(result.current.error).toMatch(/background worker isn't installed/);
  });

  it("say when the worker is still installing", async () => {
    vi.useFakeTimers();
    fakeBrowser({ ready: new Promise(() => {}), registration: { installing: {} } });
    const { result } = renderHook(() => useTradeNotifications());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKER_WAIT_MS + 10);
    });
    expect(result.current.error).toMatch(/still installing/);
  });

  it("show on when this phone is subscribed, even if the server doesn't answer the check", async () => {
    vi.useFakeTimers();
    const sub = { endpoint: "https://push.example/1", toJSON: () => ({}) };
    fakeBrowser({ ready: Promise.resolve({ pushManager: { getSubscription: async () => sub } }) });
    api.apiFetch.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useTradeNotifications());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(result.current.state).toBe("on");
  });

  it("register a missing worker when switched on, then subscribe", async () => {
    let activate!: (r: unknown) => void;
    const ready = new Promise((r) => (activate = r));
    const sub = { endpoint: "https://push.example/2", toJSON: () => ({ endpoint: "https://push.example/2" }) };
    const reg = { pushManager: { getSubscription: async () => null, subscribe: vi.fn(async () => sub) } };
    fakeBrowser({ ready, registration: undefined, register: async () => { activate(reg); return reg; } });
    api.apiFetch.mockImplementation(async (path: string) =>
      new Response(JSON.stringify(path === "/api/push/key" ? { publicKey: "BPk_-w" } : { ok: true }), { status: 200 })
    );
    const { result } = renderHook(() => useTradeNotifications());
    await act(async () => {
      await result.current.enable();
    });
    expect(result.current.error).toBe("");
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(reg.pushManager.subscribe).toHaveBeenCalled();
    expect(result.current.state).toBe("on");
    expect(result.current.error).toBe("");
  });
});
