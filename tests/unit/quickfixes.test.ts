import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCoinDcxTicker, resetTickerCache, TICKER_TTL_MS } from "../../server/coindcxTicker";

describe("getCoinDcxTicker", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetTickerCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([{ market: "BTCINR", last_price: "1000" }])));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shares one request between concurrent callers", async () => {
    const [a, b, c] = await Promise.all([getCoinDcxTicker(), getCoinDcxTicker(), getCoinDcxTicker()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("serves from cache inside the TTL and refetches after it", async () => {
    const t0 = Date.now();
    await getCoinDcxTicker(t0);
    await getCoinDcxTicker(t0 + TICKER_TTL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getCoinDcxTicker(t0 + TICKER_TTL_MS + 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't cache failures", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("oops", { status: 503 }));
    await expect(getCoinDcxTicker()).rejects.toThrow(/503/);
    await expect(getCoinDcxTicker()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Gemini model configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the built-in cascade and honours GEMINI_MODELS", async () => {
    const { geminiModels } = await import("../../server/routes/agents");
    expect(geminiModels()).toEqual(["gemini-3.8-flash", "gemini-3.1-flash-lite"]);
    vi.stubEnv("GEMINI_MODELS", " model-a , model-b ,");
    expect(geminiModels()).toEqual(["model-a", "model-b"]);
  });

  it("recognises a rejected model name but not quota or timeouts", async () => {
    const { isModelUnavailableError } = await import("../../server/routes/agents");
    expect(isModelUnavailableError({ status: 404 })).toBe(true);
    expect(isModelUnavailableError(new Error("models/gemini-x is not found for API version v1beta"))).toBe(true);
    expect(isModelUnavailableError({ status: 429, message: "quota exceeded" })).toBe(false);
    expect(isModelUnavailableError(new Error("AI Agent request timed out after 4500ms"))).toBe(false);
  });
});
