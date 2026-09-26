import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeProposal } from "../../src/types";
import { swingWaitingMessage } from "../../src/shared/tradeMessages";

// A pop-up when a swing setup waits in the Queue: the autopilot never opens
// one, and a proposal waits only about ten minutes.

const sent: { uid: string; message: { title: string; body: string; tag?: string } }[] = [];
vi.mock("../../server/push", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../server/push")>();
  return {
    ...real,
    notifyUser: vi.fn(async (uid: string, message: { title: string; body: string; tag?: string }) => {
      sent.push({ uid, message });
      return 1;
    }),
  };
});

const now = Date.parse("2026-09-27T03:40:00Z");
const proposal = (symbol: string, over: Partial<TradeProposal> = {}, horizon: "swing" | "intraday" = "swing"): TradeProposal =>
  ({
    id: `p-${symbol}-${Math.random()}`,
    symbol,
    status: "DEFERRED",
    expiresAt: now + 9 * 60_000,
    setup: { symbol, name: "Marcus Swing Trend", direction: "LONG", entryPrice: 26.08, stopLoss: 25.6, takeProfit: 28.47, horizon },
    ...over,
  }) as unknown as TradeProposal;

beforeEach(async () => {
  sent.length = 0;
  (await import("../../server/scanner/swingAlerts"))._resetSwingAlerts();
});

describe("the swing pop-up", () => {
  it("says what to buy, the stop and target with their distance, how long it holds and how long it waits", () => {
    const m = swingWaitingMessage(proposal("ADA/INR"), now);
    expect(m.title).toBe("Swing trade waiting: buy ADA/INR");
    expect(m.body).toBe(
      "About ₹26.08 · stop ₹25.6 (−1.8%) · target ₹28.47 (+9.2%) · holds up to 3 days · Marcus Swing Trend · approve in the Queue within 9 min"
    );
    expect(m.tag).toBe("swing-ADA/INR");
  });
});

describe("which swing setups are announced", () => {
  it("only swing setups left waiting for you, each market and side once an hour", async () => {
    const { announceSwings } = await import("../../server/scanner/swingAlerts");
    announceSwings("owner", [
      proposal("ADA/INR"),
      proposal("SOL/INR", {}, "intraday"),
      proposal("BTC/INR", { status: "APPROVED" }),
      proposal("ETH/INR", { status: "PENDING_APPROVAL" }),
    ], now);
    expect(sent.map((s) => s.message.title)).toEqual(["Swing trade waiting: buy ADA/INR", "Swing trade waiting: buy ETH/INR"]);
    expect(sent.every((s) => s.uid === "owner")).toBe(true);

    // The next candle finds the same ADA setup: no second pop-up within the hour.
    announceSwings("owner", [proposal("ADA/INR")], now + 5 * 60_000);
    expect(sent).toHaveLength(2);
    // An hour on, it's announced again.
    announceSwings("owner", [proposal("ADA/INR")], now + 61 * 60_000);
    expect(sent).toHaveLength(3);
  });
});
