// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade } from "../../src/types";

const apiFetch = vi.fn();
vi.mock("../../src/services/apiClient", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const { closesToUpload, uploadCloses } = await import("../../src/hooks/useBookUpload");

// The app uploads the closes the server's trade book may not hold.

const DAY = 24 * 60 * 60 * 1000;
const trade = (id: string, closedAtMs?: number) =>
  ({ id, positionId: id, symbol: "SOL/INR", direction: "LONG", entryPrice: 100, exitPrice: 101, quantity: 1, realizedPnl: 1, closedAtMs, autopsy: { long: "text" } }) as unknown as HistoricalTrade;
const ok = () => Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));

describe("uploading the app's closes to the trade book", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    localStorage.clear();
  });

  it("sends every close the first time, then those since a day before the last upload", () => {
    const t = Date.parse("2026-10-09T00:00:00Z");
    const trades = [trade("a", t - 3 * DAY), trade("b", t - DAY / 2), trade("c", t), trade("old")];
    expect(closesToUpload(trades, 0).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(closesToUpload(trades, t).map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("sends them in batches without the autopsy, and remembers once all are in", async () => {
    apiFetch.mockImplementation(ok);
    const trades = Array.from({ length: 150 }, (_, i) => trade(`t${i}`, 1_000 + i));
    expect(await uploadCloses(trades)).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(first.trades).toHaveLength(100);
    expect(first.trades[0]).not.toHaveProperty("autopsy");
    expect(localStorage.getItem("nexus_book_uploaded_until")).toBe("1149");
  });

  it("remembers nothing when a batch fails, so the next start sends them again", async () => {
    apiFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 503 })));
    expect(await uploadCloses([trade("x", 5_000)])).toBe(false);
    expect(localStorage.getItem("nexus_book_uploaded_until")).toBeNull();
  });
});
