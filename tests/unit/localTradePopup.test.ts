// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn() }));
import { showLocalTradePopup } from "../../src/hooks/useTradeNotifications";

// A trade the app closes itself pops up like the server's, with the same tag.

const msg = { title: "SOL/INR closed +₹42.1", body: "Trailing stop · sold 0.86 @ ₹11,650", tag: "close-p9", url: "/" };

function fakeBrowser(permission: NotificationPermission) {
  const showNotification = vi.fn(async () => {});
  const reg = { active: {}, showNotification };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(reg), getRegistration: async () => reg } });
  (window as any).PushManager = function () {};
  (window as any).Notification = { permission };
  return showNotification;
}

afterEach(() => {
  delete (window as any).PushManager;
  delete (window as any).Notification;
});

describe("showLocalTradePopup", () => {
  it("shows the pop-up through the service worker, tagged by the trade", async () => {
    const show = fakeBrowser("granted");
    await showLocalTradePopup(msg);
    expect(show).toHaveBeenCalledWith(msg.title, expect.objectContaining({ body: msg.body, tag: "close-p9", data: { url: "/" } }));
  });

  it("does nothing without permission", async () => {
    const show = fakeBrowser("default");
    await showLocalTradePopup(msg);
    expect(show).not.toHaveBeenCalled();
  });
});
