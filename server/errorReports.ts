import * as Sentry from "@sentry/node";
import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/node";

// Error reports to Sentry (the owner's "nexus-desk" project): the server's
// crashes, unhandled rejections, errors that reach Express, and every
// console.error, so a failing check or job shows up without a screenshot.
// Only with SENTRY_DSN set (a Fly secret); without it nothing is sent.
// Errors only (no tracing). Nothing private leaves: no request headers,
// cookies or bodies (the Firebase token travels in a header), and tokens,
// keys and email addresses are masked in every message. A message that keeps
// repeating is sent a few times an hour at most, and at most 100 reports go a
// day, so one stuck job can't use up the free plan's monthly allowance (5,000).
// An unhandled promise rejection still stops the server, as it did before
// (Fly starts it again), once it's reported.

/** At most this many reports of one message an hour. */
export const REPORTS_PER_MESSAGE_PER_HOUR = 5;
/** At most this many reports a day in all. */
export const REPORTS_PER_DAY = 100;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let enabled = false;
const sentAt = new Map<string, number[]>();
let daySent: number[] = [];

/** Masks what shouldn't leave the server: bearer tokens, JWTs, long keys, secrets as name=value or in JSON, email addresses. */
export function scrubText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [hidden]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[token]")
    .replace(/(\b(?:key|token|secret|signature|apikey|api_key|access_token|password|pin|totp)=)[^&\s"',]+/gi, "$1[hidden]")
    .replace(/("(?:key|token|secret|signature|apikey|api_key|access_token|password|pin|totp|jwtToken|refreshToken|feedToken)"\s*:\s*")[^"]*"/gi, '$1[hidden]"')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[hex]")
    .replace(/\b[A-Za-z0-9]{40,}\b/g, "[key]");
}

/** Data masked the same way; dropped if it can't be. */
function scrubData<T>(data: T): T | undefined {
  try {
    return JSON.parse(scrubText(JSON.stringify(data)));
  } catch {
    return undefined;
  }
}

const scrubCrumb = (b: Breadcrumb): Breadcrumb => ({
  ...b,
  ...(b.message ? { message: scrubText(b.message) } : {}),
  ...(b.data ? { data: scrubData(b.data) } : {}),
});

/** The report as sent: no request headers, cookies, body or query, and every message masked. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.url) event.request.url = scrubText(event.request.url.split("?")[0]);
  }
  delete event.user;
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrubText(ex.value);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubCrumb);
  if (event.extra) event.extra = scrubData(event.extra);
  return event;
}

/** Whether a report of this message may go now (a few an hour of each, and 100 a day in all). */
export function underCap(key: string, now = Date.now()): boolean {
  daySent = daySent.filter((t) => now - t < DAY_MS);
  const recent = (sentAt.get(key) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= REPORTS_PER_MESSAGE_PER_HOUR || daySent.length >= REPORTS_PER_DAY) {
    sentAt.set(key, recent);
    return false;
  }
  daySent.push(now);
  recent.push(now);
  sentAt.set(key, recent);
  if (sentAt.size > 500) sentAt.delete(sentAt.keys().next().value!);
  return true;
}

const keyOf = (event: ErrorEvent, hint?: EventHint) =>
  (event.exception?.values?.[0]?.value ?? event.logentry?.message ?? event.message ?? String(hint?.originalException ?? "")).slice(0, 200);

/** What Sentry runs on each report before sending it: dropped past the cap, else masked. */
export function beforeSend(event: ErrorEvent, hint?: EventHint): ErrorEvent | null {
  if (!underCap(keyOf(event, hint))) return null;
  return scrubEvent(event);
}

/** Starts the error reports when SENTRY_DSN is set; whether they're on. */
export function startErrorReports(env: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn || enabled) return enabled;
  Sentry.init({
    dsn,
    environment: env.NODE_ENV === "production" ? "production" : "development",
    release: env.FLY_IMAGE_REF || undefined,
    serverName: env.FLY_MACHINE_ID || undefined,
    sendDefaultPii: false,
    integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] }), Sentry.onUnhandledRejectionIntegration({ mode: "strict" })],
    beforeSend,
  });
  enabled = true;
  return true;
}

export const errorReportsOn = () => enabled;

/** Sends the Express app's errors (after every route). */
export function reportExpressErrors(app: Parameters<typeof Sentry.setupExpressErrorHandler>[0]): void {
  if (enabled) Sentry.setupExpressErrorHandler(app);
}

/** One note at start-up, so it's plain the reports reach Sentry after a deploy. */
export function reportStarted(): void {
  if (enabled) Sentry.captureMessage("Nexus Desk server started (error reports on)", "info");
}

/** Test hook. */
export function _resetErrorReports(): void {
  sentAt.clear();
  daySent = [];
}
