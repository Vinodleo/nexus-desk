// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The installed app is usually resumed, not relaunched, so it looks for a
// new version itself; this checks the asking, not the service worker.

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

function fakeWorker(found: boolean, fail = false) {
  const reg: any = { installing: null, waiting: null };
  reg.update = vi.fn(async () => {
    if (fail) throw new Error("offline");
    if (found) reg.installing = {};
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => reg } });
  return reg;
}

describe("looking for a new version", () => {
  it("says when one was found and is installing", async () => {
    fakeWorker(true);
    const { checkForUpdate } = await import("../../src/services/appUpdates");
    expect(await checkForUpdate(true)).toBe("updating");
  });

  it("says when this is the latest, or that it couldn't check", async () => {
    fakeWorker(false);
    let m = await import("../../src/services/appUpdates");
    expect(await m.checkForUpdate(true)).toBe("latest");
    vi.resetModules();
    fakeWorker(false, true);
    m = await import("../../src/services/appUpdates");
    expect(await m.checkForUpdate(true)).toBe("unavailable");
  });

  it("asks at most once a minute unless asked from Settings", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const reg = fakeWorker(false);
    const { checkForUpdate } = await import("../../src/services/appUpdates");
    await checkForUpdate();
    await checkForUpdate();
    expect(reg.update).toHaveBeenCalledTimes(1);
    await checkForUpdate(true);
    expect(reg.update).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_000_000 + 61_000);
    await checkForUpdate();
    expect(reg.update).toHaveBeenCalledTimes(3);
  });

  it("names the build it's running", async () => {
    const { builtAtText } = await import("../../src/services/appUpdates");
    expect(builtAtText("")).toBe("development build");
    expect(builtAtText("2026-09-25T08:35:00Z")).toMatch(/Sep/);
    expect(builtAtText("2026-09-25T08:35:00Z")).toMatch(/25/);
  });
});
