// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Connections → Test live order: a real ₹200 buy only after a
// second tap, then Sell, with the result in plain words.

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../src/services/apiClient", () => ({ apiFetch: api.fetch, authenticateSocket: vi.fn() }));

const { LiveTestCard } = await import("../../src/components/ledger/LiveTestCard");

const json = (body: unknown) => new Response(JSON.stringify(body));
const report = (over: object = {}) => ({ success: true, keys: true, liveEnabled: true, markets: ["SOLINR", "BTCINR"], amountInr: 200, run: null, ...over });
const bought = { positionId: "p", market: "SOLINR", coin: "SOL", status: "BOUGHT", quantity: 0.01, boughtAt: "", buyOrderId: "b1", buyPrice: 20010, coinReceived: 0.01, inrSpent: 200.1 };

afterEach(cleanup);
beforeEach(() => api.fetch.mockReset());

const show = async () => {
  render(createElement(LiveTestCard, { active: true }));
  await act(async () => {});
};

describe("the test live order card", () => {
  it("can't buy while live orders are blocked on the server", async () => {
    api.fetch.mockResolvedValue(json(report({ liveEnabled: false })));
    await show();
    expect(screen.getByText(/Live orders are blocked on the server \(LIVE_TRADING_ENABLED\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Buy ₹200" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("buys only after a second tap, on the coin picked", async () => {
    api.fetch.mockResolvedValueOnce(json(report())).mockResolvedValueOnce(json({ success: true, run: bought }));
    await show();
    fireEvent.change(screen.getByLabelText("Coin to test"), { target: { value: "SOLINR" } });
    fireEvent.click(screen.getByRole("button", { name: "Buy ₹200" }));
    // Nothing sent yet: it asks first.
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Buys ₹200 of SOL at CoinDCX with your money, now\./)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, buy" }));
    });
    expect(api.fetch).toHaveBeenLastCalledWith("/api/live/test-order", expect.objectContaining({ method: "POST", body: JSON.stringify({ market: "SOLINR" }) }));
    expect(screen.getByText("Bought 0.01 SOL at ₹20,010.00 (₹200.10 spent with the fee).")).toBeTruthy();
    expect(screen.getByText("CoinDCX holds all 0.01: the fee came out of rupees, so sales of the whole quantity work.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sell it" })).toBeTruthy();
  });

  it("sells, and shows what came back", async () => {
    api.fetch
      .mockResolvedValueOnce(json(report({ run: bought })))
      .mockResolvedValueOnce(json({ success: true, run: { ...bought, status: "SOLD", sellPrice: 19990, inrReceived: 199.9 } }));
    await show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sell it" }));
    });
    expect(api.fetch).toHaveBeenLastCalledWith("/api/live/test-order/sell", expect.objectContaining({ method: "POST" }));
    expect(screen.getByText("Sold at ₹19,990.00: ₹199.90 back.")).toBeTruthy();
    // Sold: it can be run again.
    expect(screen.getByRole("button", { name: "Buy ₹200" })).toBeTruthy();
  });

  it("shows the server's refusal", async () => {
    api.fetch
      .mockResolvedValueOnce(json(report()))
      .mockResolvedValueOnce(json({ success: false, error: "CoinDCX has ₹100.00; the test needs about ₹205 (₹200 and the fee)." }));
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Buy ₹200" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, buy" }));
    });
    expect(screen.getByText("CoinDCX has ₹100.00; the test needs about ₹205 (₹200 and the fee).")).toBeTruthy();
  });

  it("shows nothing on a server without the test", async () => {
    api.fetch.mockResolvedValue(new Response("{}", { status: 404 }));
    const { container } = render(createElement(LiveTestCard, { active: true }));
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });
});
