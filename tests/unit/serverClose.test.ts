import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const { reportCloseToServer } = await import("../../src/services/serverClose");

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

// The app asks the guardian to close a trade by hand: it holds the trades, closes it and records it.

describe("reportCloseToServer", () => {
  beforeEach(() => apiFetch.mockReset());

  it("tells the guardian the price and why, and hands back its record", async () => {
    apiFetch.mockImplementation(() => json({ success: true, event: { positionId: "p1", exitPrice: 110 } }));
    expect(await reportCloseToServer("p1", 110, "MANUAL")).toEqual({ positionId: "p1", exitPrice: 110 });
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/daemon/close");
    expect(JSON.parse(init.body)).toEqual({ positionId: "p1", price: 110, reason: "MANUAL" });
  });

  it("says when the guardian had closed it already (its own exit, or another device's)", async () => {
    apiFetch.mockImplementation(() => json({ success: true, already: true, event: { positionId: "p1", exitPrice: 104, exitReason: "STOP_LOSS" } }));
    expect(await reportCloseToServer("p1", 110, "MANUAL")).toEqual({ positionId: "p1", exitPrice: 104, exitReason: "STOP_LOSS", already: true });
  });

  it("says when the guardian isn't holding it, and is null when it can't be reached or there's no price", async () => {
    apiFetch.mockImplementation(() => json({ success: false }, 404));
    expect(await reportCloseToServer("p1", 110, "STOP_LOSS")).toBe("not-held");
    apiFetch.mockImplementation(() => json({ success: false }, 500));
    expect(await reportCloseToServer("p1", 110, "STOP_LOSS")).toBeNull();
    apiFetch.mockImplementation(() => Promise.reject(new Error("offline")));
    expect(await reportCloseToServer("p1", 110, "STOP_LOSS")).toBeNull();
    apiFetch.mockReset();
    expect(await reportCloseToServer("p1", 0, "MANUAL")).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
