// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { fetchServerDeskControls, loadDeskControls, saveDeskControls } from "../../src/services/deskControls";

// Autopilot and "Stop all" survive a reload: a stopped desk stays stopped.

beforeEach(() => {
  localStorage.clear();
  apiFetch.mockReset();
});

describe("desk controls", () => {
  it("are kept on this device", () => {
    expect(loadDeskControls()).toBeNull();
    saveDeskControls({ autopilot: false, killSwitch: true });
    expect(loadDeskControls()).toEqual({ autopilot: false, killSwitch: true });
    localStorage.setItem("nexus_desk_controls_v1", JSON.stringify({ autopilot: "yes" }));
    expect(loadDeskControls()).toBeNull();
  });

  it("come from the server on a device that has none", async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ success: true, desk: { autopilot: true, killSwitch: true, updatedAt: 1 } })));
    expect(await fetchServerDeskControls()).toEqual({ autopilot: true, killSwitch: true });
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ success: true, desk: null })));
    expect(await fetchServerDeskControls()).toBeNull();
    apiFetch.mockRejectedValue(new Error("offline"));
    expect(await fetchServerDeskControls()).toBeNull();
  });
});
