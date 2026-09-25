import { describe, expect, it, vi } from "vitest";

// Approving a trade in the app prices it where it would really fill: the
// ask for a long. Coins read CoinDCX's book; stocks use the latest Angel One
// quote the server sent.

const book = vi.hoisted(() => ({ fetchLiveOrderBook: vi.fn() }));
vi.mock("../../src/services/orderBookService", () => book);
vi.mock("../../src/services/liveMarketStreamService", () => ({ liveMarketStream: { getLastPrice: () => 900 } }));
const { entryPriceNow } = await import("../../src/services/entryPriceNow");

describe("the price an approval opens at", () => {
  it("is a stock's ask (bid for a short) from a fresh quote, without reading a book", async () => {
    const quote = { bid: 904.9, ask: 905.1, at: Date.now() };
    expect(await entryPriceNow("SBIN", "LONG", 10000, quote)).toBe(905.1);
    expect(await entryPriceNow("SBIN", "SHORT", 10000, quote)).toBe(904.9);
    expect(book.fetchLiveOrderBook).not.toHaveBeenCalled();
  });

  it("falls back to the last trade for a stock without a fresh quote", async () => {
    expect(await entryPriceNow("SBIN", "LONG", 10000, { bid: 904.9, ask: 905.1, at: Date.now() - 60_000 })).toBe(900);
    expect(await entryPriceNow("SBIN", "LONG", 10000)).toBe(900);
  });

  it("is a coin's ask from CoinDCX's book", async () => {
    book.fetchLiveOrderBook.mockResolvedValue({ bids: [{ price: 99 }], asks: [{ price: 101 }] });
    expect(await entryPriceNow("SOL/INR", "LONG", 10000)).toBe(101);
  });
});
