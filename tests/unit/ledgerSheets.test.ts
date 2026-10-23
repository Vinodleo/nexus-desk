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
const { ThisPhoneSheet, auditLabel, activityOf, activityTime } = await import("../../src/components/ledger/ThisPhoneSheet");
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

  it("shows the opening screen's N tile above the button", () => {
    auth.value.currentUser = null;
    render(createElement(LoginScreen));
    expect(screen.getByTestId("login-tile").textContent).toBe("N");
    expect(screen.getByRole("heading", { name: "Nexus Desk" })).toBeTruthy();
  });

  it("turns away other accounts and offers to switch", () => {
    auth.value.currentUser = { uid: "x", email: "someone@example.com" };
    render(createElement(LoginScreen));
    expect(screen.getByText(/doesn't have access/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use a different account" }));
    expect(auth.value.logout).toHaveBeenCalled();
  });

  it("says it's trying again, not that there's no access, when the desk couldn't be reached", () => {
    auth.value.currentUser = { uid: "x", email: "friend@example.com" };
    render(createElement(LoginScreen, { unreachable: true }));
    expect(screen.getByText(/Couldn't reach the desk to check/).textContent).toBe("Couldn't reach the desk to check friend@example.com. Trying again…");
    expect(screen.queryByText(/doesn't have access/)).toBeNull();
    expect(screen.getByRole("button", { name: "Use a different account" })).toBeTruthy();
  });
});

describe("ThisPhoneSheet", () => {
  it("shows the account, says the server trades, and lists activity in plain words", async () => {
    render(createElement(ThisPhoneSheet, { isOpen: true, onClose: vi.fn(), popups: "on" }));
    expect(screen.getByRole("dialog", { name: "This phone" })).toBeTruthy();
    expect(screen.getByText("vinoduppar007@gmail.com · Google")).toBeTruthy();
    expect(screen.getByText(/The server does the trading/)).toBeTruthy();
    expect(screen.getByText("Stopped all trading")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
    expect(await screen.findByText("On the server only")).toBeTruthy();
    // No roles, wake lock or silent audio any more.
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(auth.value.logout).toHaveBeenCalled();
  });

  it("offers everything back on a phone left on a narrower role, and says nothing on the owner's", () => {
    auth.value.userRole = "auditor";
    render(createElement(ThisPhoneSheet, { isOpen: true, onClose: vi.fn() }));
    expect(screen.getByText("look only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow everything again" }));
    expect(auth.value.switchUserRole).toHaveBeenCalledWith("commander");
    cleanup();
    auth.value.userRole = "commander";
    render(createElement(ThisPhoneSheet, { isOpen: true, onClose: vi.fn() }));
    expect(screen.queryByRole("button", { name: "Allow everything again" })).toBeNull();
  });

  it("asks before bringing the memory back from the cloud", async () => {
    render(createElement(ThisPhoneSheet, { isOpen: true, onClose: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: /Bring back/ }));
    expect(storage.syncFromFirebase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(storage.syncFromFirebase).toHaveBeenCalledWith("u1");
    expect(await screen.findByText("Couldn't bring it back from the cloud.")).toBeTruthy();
  });

  it("labels activity in plain words, with the day it happened", () => {
    expect(auditLabel("CLOUD_SYNC_PUSH")).toBe("Cloud sync push");
    expect(activityOf({ action: "KILL_SWITCH_DISENGAGED", details: "" })).toEqual({ label: "Resumed trading", tone: "gain" });
    expect(activityOf({ action: "DECISION_MODE_CHANGED", details: "Operational mode switched to AUTO_WITHIN_LIMITS" }).label).toBe("Autopilot on");
    expect(activityOf({ action: "DECISION_MODE_CHANGED", details: "Operational mode switched to MANUAL" }).label).toBe("Autopilot off");
    expect(activityOf({ action: "SOMETHING_NEW", details: "" }).label).toBe("Something new");
    const at = new Date(2026, 9, 12, 9, 41).getTime();
    expect(activityTime({ id: `audit-${at}-ab12`, timestamp: "09:41:00" })).toBe("12 Oct, 9:41 am");
    expect(activityTime({ id: "a1", timestamp: "10:42" })).toBe("10:42");
  });
});
