import { describe, expect, it } from "vitest";
import { trimTicker } from "../../server/routes/coindcx";

describe("price list for the app", () => {
  it("keeps INR and USDT markets with only the fields the app reads", () => {
    const full = [
      { market: "BTCINR", last_price: "5000000", change_24_hour: "1.2", bid: "4999000", ask: "5001000", volume: "123", high: "1", low: "1", timestamp: 1 },
      { market: "SOLUSDT", last_price: "140.5", bid: "140", ask: "141" },
      { market: "ETHBTC", last_price: "0.05", change_24_hour: "0.1" },
      { market: "XRPINR" },
    ];
    expect(trimTicker(full)).toEqual([
      { market: "BTCINR", last_price: "5000000", change_24_hour: "1.2" },
      { market: "SOLUSDT", last_price: "140.5" },
    ]);
  });
});
