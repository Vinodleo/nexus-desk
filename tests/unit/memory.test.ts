import { afterEach, describe, expect, it, vi } from "vitest";

// Node's heap has a limit of its own, about half the machine's memory: near
// it Node stalls, then dies with no error to report. Background work stops
// itself first, and the server tells Sentry, naming the work running.

const memory = await import("../../server/memory");
const { backgroundWorkRunning, waitForOtherWork } = await import("../../server/history/historyJob");

const MB = 1024 * 1024;
const LIMIT = 256 * MB;
const reading = (share: number, at = Date.now()) => ({ heapUsed: share * LIMIT, heapLimit: LIMIT, at });

afterEach(() => memory._resetMemory());

describe("Node's memory", () => {
  it("counts as tight only when what's left after a recent full clean-up is past the share", () => {
    const now = Date.now();
    expect(memory.memoryTight(0.8, now, null)).toBe(false);
    expect(memory.memoryTight(0.8, now, reading(0.85, now - 1000))).toBe(true);
    expect(memory.memoryTight(0.8, now, reading(0.7, now))).toBe(false);
    // A clean-up long ago says nothing about now: none since means no pressure.
    expect(memory.memoryTight(0.8, now, reading(0.95, now - 11 * 60 * 1000))).toBe(false);
  });

  it("stops background work past 80% of the limit, saying which and why", () => {
    memory._resetMemory(reading(0.85));
    expect(() => memory.stopIfMemoryTight("the stock replay since 2016")).toThrow(
      "Stopped the stock replay since 2016 to keep the server safe: Node's memory is at 218 of 256 MB; it carries on later."
    );
    memory._resetMemory(reading(0.79));
    expect(() => memory.stopIfMemoryTight("the stock replay since 2016")).not.toThrow();
  });

  it("tells Sentry past 75%, naming the background work running, at most once an hour", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = Date.now();
    memory.noteMajorGc(reading(0.7, t), () => ["the two-year replay"]);
    expect(error).not.toHaveBeenCalled();
    memory.noteMajorGc(reading(0.78, t + 1), () => ["the two-year replay", "the machine-learning test (5m)"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/^\[Memory\] Node's memory is at 200 of 256 MB \(78%, the machine \d+ MB\)\. Running: the two-year replay, the machine-learning test \(5m\)\.$/);
    // Once an hour at most.
    memory.noteMajorGc(reading(0.9, t + 30 * 60 * 1000), () => []);
    expect(error).toHaveBeenCalledTimes(1);
    memory.noteMajorGc(reading(0.9, t + 61 * 60 * 1000), () => []);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[1][0]).toContain("Running: no background work.");
    // Each clean-up's reading is what the background work's brake goes by.
    expect(() => memory.stopIfMemoryTight("the coin replay since 2017", t + 61 * 60 * 1000)).toThrow(/Stopped the coin replay since 2017/);
  });

  it("names the background work running", () => {
    let busy = true;
    waitForOtherWork(() => busy, "the stock replay since 2016");
    waitForOtherWork(() => false, "the coin replay since 2017");
    waitForOtherWork(() => busy, () => "the machine-learning test (daily)");
    expect(backgroundWorkRunning()).toEqual(["the stock replay since 2016", "the machine-learning test (daily)"]);
    busy = false;
    expect(backgroundWorkRunning()).toEqual([]);
  });

  it("watches Node's full clean-ups from the start", () => {
    expect(() => memory.startMemoryWatch(() => [])).not.toThrow();
  });
});
