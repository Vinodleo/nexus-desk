import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorEvent } from "@sentry/node";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  setupExpressErrorHandler: vi.fn(),
  captureConsoleIntegration: vi.fn((o: unknown) => ({ name: "CaptureConsole", o })),
  onUnhandledRejectionIntegration: vi.fn((o: unknown) => ({ name: "OnUnhandledRejection", o })),
}));
vi.mock("@sentry/node", () => sentry);

const reports = await import("../../server/errorReports");
const { beforeSend, scrubEvent, scrubText, underCap, REPORTS_PER_MESSAGE_PER_HOUR, REPORTS_PER_DAY } = reports;

// The server's errors to Sentry: only with SENTRY_DSN, nothing private in
// them, and a message that keeps repeating sent only a few times.

const HOUR = 60 * 60 * 1000;
const JWT = "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJ1aWQtMTIzNDU2Nzg5MCJ9.c2lnbmF0dXJlLXBhcnQtaGVyZQ";

beforeEach(() => reports._resetErrorReports());

describe("what an error report holds", () => {
  it("masks tokens, keys, secrets and email addresses", () => {
    expect(scrubText(`Authorization: Bearer ${JWT}`)).toBe("Authorization: Bearer [hidden]");
    expect(scrubText(`token ${JWT} refused`)).toBe("token [token] refused");
    expect(scrubText("GET https://generativelanguage.googleapis.com/v1/models?key=AIzaSyA-123_abc&alt=json")).toBe(
      "GET https://generativelanguage.googleapis.com/v1/models?key=[hidden]&alt=json"
    );
    expect(scrubText("Error: login failed, totp=123456 pin=4321")).toBe("Error: login failed, totp=[hidden] pin=[hidden]");
    expect(scrubText('{"jwtToken":"abc.def","clientcode":"A1"}')).toBe('{"jwtToken":"[hidden]","clientcode":"A1"}');
    expect(scrubText("sent to owner.name+desk@gmail.com")).toBe("sent to [email]");
    expect(scrubText("signature 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBe("signature [hex]");
    expect(scrubText("api key AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMIK7MDENGbPxRfiCY")).toBe("api key [key]");
    // Ordinary messages stay as they are.
    expect(scrubText("[DailyCoins] Scan failed: Binance answered 451 for BTCUSDT")).toBe("[DailyCoins] Scan failed: Binance answered 451 for BTCUSDT");
  });

  it("leaves out the request's headers, cookies, body and query, and the user", () => {
    const event = {
      message: `Bearer ${JWT}`,
      request: { url: "https://nexus-desk-vinodleo.fly.dev/api/book?since=1&token=abc", headers: { authorization: `Bearer ${JWT}` }, cookies: { s: "x" }, data: { pin: "1234" }, query_string: "token=abc" },
      user: { id: "uid", email: "owner@gmail.com", ip_address: "1.2.3.4" },
      exception: { values: [{ type: "Error", value: "CoinDCX refused key=abcdef" }] },
      breadcrumbs: [{ message: "sent to owner@gmail.com", data: { url: "https://api.example.com/x?apikey=zzz" } }],
      extra: { arguments: [`Bearer ${JWT}`] },
    } as unknown as ErrorEvent;
    const sent = scrubEvent(event);
    expect(sent.request).toEqual({ url: "https://nexus-desk-vinodleo.fly.dev/api/book" });
    expect(sent.user).toBeUndefined();
    expect(sent.message).toBe("Bearer [hidden]");
    expect(sent.exception!.values![0].value).toBe("CoinDCX refused key=[hidden]");
    expect(sent.breadcrumbs).toEqual([{ message: "sent to [email]", data: { url: "https://api.example.com/x?apikey=[hidden]" } }]);
    expect(sent.extra).toEqual({ arguments: ["Bearer [hidden]"] });
  });
});

describe("how many go", () => {
  it("sends a message a few times an hour, then again after the hour", () => {
    const t = Date.parse("2026-10-09T06:00:00Z");
    for (let i = 0; i < REPORTS_PER_MESSAGE_PER_HOUR; i++) expect(underCap("[Quotes] fetch failed", t + i * 1000)).toBe(true);
    expect(underCap("[Quotes] fetch failed", t + 10 * 60 * 1000)).toBe(false);
    // Another message still goes.
    expect(underCap("[Backup] Failed: 403", t + 10 * 60 * 1000)).toBe(true);
    expect(underCap("[Quotes] fetch failed", t + HOUR + 5000)).toBe(true);
  });

  it("sends at most 100 a day in all", () => {
    const t = Date.parse("2026-10-09T06:00:00Z");
    for (let i = 0; i < REPORTS_PER_DAY; i++) expect(underCap(`message ${i}`, t + i)).toBe(true);
    expect(underCap("one more", t + 2 * HOUR)).toBe(false);
    expect(underCap("one more", t + 24 * HOUR + 1000)).toBe(true);
  });

  it("drops a report past the cap and masks the rest", () => {
    const report = () => ({ exception: { values: [{ type: "Error", value: "owner@gmail.com refused" }] } }) as unknown as ErrorEvent;
    for (let i = 0; i < REPORTS_PER_MESSAGE_PER_HOUR; i++) expect(beforeSend(report())!.exception!.values![0].value).toBe("[email] refused");
    expect(beforeSend(report())).toBeNull();
  });
});

describe("starting", () => {
  it("sends nothing without SENTRY_DSN", () => {
    expect(reports.startErrorReports({})).toBe(false);
    expect(reports.startErrorReports({ SENTRY_DSN: "  " })).toBe(false);
    reports.reportExpressErrors({} as never);
    reports.reportStarted();
    expect(reports.errorReportsOn()).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.setupExpressErrorHandler).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("with SENTRY_DSN, sends errors only (console.error too), masked, and still stops on an unhandled rejection", () => {
    const env = { SENTRY_DSN: "https://key@o1.ingest.us.sentry.io/2", NODE_ENV: "production", FLY_IMAGE_REF: "registry.fly.io/nexus-desk-vinodleo:deployment-1", FLY_MACHINE_ID: "m1" };
    expect(reports.startErrorReports(env)).toBe(true);
    expect(reports.startErrorReports(env)).toBe(true);
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const opts = sentry.init.mock.calls[0][0];
    expect(opts).toMatchObject({ dsn: env.SENTRY_DSN, environment: "production", release: env.FLY_IMAGE_REF, serverName: "m1", sendDefaultPii: false, beforeSend });
    expect(opts.tracesSampleRate).toBeUndefined();
    expect(sentry.captureConsoleIntegration).toHaveBeenCalledWith({ levels: ["error"] });
    expect(sentry.onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: "strict" });
    reports.reportExpressErrors({} as never);
    expect(sentry.setupExpressErrorHandler).toHaveBeenCalledTimes(1);
    reports.reportStarted();
    expect(sentry.captureMessage).toHaveBeenCalledWith("Nexus Desk server started (error reports on)", "info");
    expect(reports.errorReportsOn()).toBe(true);
  });
});
