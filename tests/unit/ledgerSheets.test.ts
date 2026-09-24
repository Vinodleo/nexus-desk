// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  value: {} as Record<string, any>,
}));
vi.mock("../../src/context/AuthContext", () => ({ useAuth: () => auth.value }));
vi.mock("../../src/services/apiClient", () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, configured: true, keyMasked: "ab…cd", liveRisk: { enabled: false } }))),
  authenticateSocket: vi.fn(),
}));
vi.mock("../../src/services/storagePersistenceService", () => ({
  syncToFirebase: vi.fn(async () => {}),
  syncFromFirebase: vi.fn(async () => false),
  hasLegacyExchangeKeys: vi.fn(async () => false),
  deleteLegacyExchangeKeys: vi.fn(async () => true),
}));

const { Sheet } = await import("../../src/components/ledger/Sheet");
const { LoginScreen } = await import("../../src/components/LoginScreen");
const { SecurityConsoleModal, auditLabel } = await import("../../src/components/SecurityConsoleModal");
const { BackgroundExecutionModal } = await import("../../src/components/BackgroundExecutionModal");
const { isOwner } = await import("../../src/shared/owner");
const storage = await import("../../src/services/storagePersistenceService");

afterEach(cleanup);
beforeEach(() => {
  auth.value = {
    currentUser: { uid: "u1", email: "vinoduppar007@gmail.com", displayName: "Vinod" },
    userProfile: { provider: "google" },
    userRole: "commander",
    loading: false,
    switchUserRole: vi.fn(),
    logout: vi.fn(),
    signInWithGoogle: vi.fn(),
    logSecurityAudit: vi.fn(),
    recentAudits: [{ id: "a1", action: "KILL_SWITCH_ENGAGED", details: "Emergency halt engaged", userId: "u1", userEmail: "", timestamp: "10:42" }],
  };
});

describe("Sheet", () => {
  it("closes on Escape and on the backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(createElement(Sheet, { isOpen: true, onClose, title: "Hello", children: "body" }));
    expect(screen.getByRole("dialog", { name: "Hello" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(container.querySelector('[aria-hidden="true"]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("owner check", () => {
  it("matches the owner's email regardless of case", () => {
    expect(isOwner("Vinoduppar007@gmail.com")).toBe(true);
    expect(isOwner("someone@example.com")).toBe(false);
    expect(isOwner(null)).toBe(false);
  });
});

describe("LoginScreen", () => {
  it("signs in with Google", () => {
    auth.value.currentUser = null;
    render(createElement(LoginScreen));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(auth.value.signInWithGoogle).toHaveBeenCalled();
  });

  it("turns away other accounts and offers to switch", () => {
    auth.value.currentUser = { uid: "x", email: "someone@example.com" };
    render(createElement(LoginScreen));
    expect(screen.getByText(/doesn't have access/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use a different account" }));
    expect(auth.value.logout).toHaveBeenCalled();
  });
});

describe("SecurityConsoleModal", () => {
  it("shows the account, switches role and lists activity", async () => {
    render(createElement(SecurityConsoleModal, { isOpen: true, onClose: vi.fn() }));
    expect(screen.getByText("vinoduppar007@gmail.com · google")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Trader/ }));
    expect(auth.value.switchUserRole).toHaveBeenCalledWith("trader");
    expect(screen.getByText("Kill switch engaged")).toBeTruthy();
    expect(await screen.findByText("Key ab…cd")).toBeTruthy();
  });

  it("asks before restoring from the cloud", async () => {
    render(createElement(SecurityConsoleModal, { isOpen: true, onClose: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: /^Restore$/ }));
    expect(storage.syncFromFirebase).not.toHaveBeenCalled();
    const confirm = screen.getAllByRole("button", { name: "Restore" });
    fireEvent.click(confirm[confirm.length - 1]);
    expect(storage.syncFromFirebase).toHaveBeenCalledWith("u1");
    expect(await screen.findByText("Couldn't restore from the cloud.")).toBeTruthy();
  });

  it("labels audit actions in plain words", () => {
    expect(auditLabel("CLOUD_SYNC_PUSH")).toBe("Cloud sync push");
  });
});

describe("BackgroundExecutionModal", () => {
  it("starts the desk and flips the device switches", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const p = {
      isOpen: true, onClose: vi.fn(), isPlaying: false, onTogglePlay: vi.fn(), onToggleWakeLock: vi.fn(),
      onToggleAudioKeepAlive: vi.fn(), onRequestNotifications: vi.fn(),
      status: {
        isSupported: true, isWorkerActive: false, isAudioKeepAliveActive: false, isWakeLockActive: true, wakeLockError: null,
        notificationsPermission: "default" as NotificationPermission, heartbeatCount: 0, lastHeartbeatTimestamp: null, totalReconciledCycles: 0,
      },
    };
    render(createElement(BackgroundExecutionModal, p));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(p.onTogglePlay).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Keep running when locked" }));
    expect(p.onToggleAudioKeepAlive).toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Keep the screen on" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(p.onRequestNotifications).toHaveBeenCalled();
  });
});
