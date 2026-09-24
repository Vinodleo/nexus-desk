import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The server reads the calendar, keeps upcoming high-impact US events, and
// tells the app whether a news pause is on.

const calendar = vi.fn();
let base: string;
let server: Server;

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (/faireconomy/.test(String(url)) ? calendar() : realFetch(url, init)));
  const { router } = await import("../../server/routes/scanner");
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { uid: "owner" };
    next();
  });
  app.use(router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  (await import("../../server/eventCalendar"))._resetEvents();
  calendar.mockReset();
});

describe("GET /api/events", () => {
  it("lists upcoming high-impact US events and whether a pause is on", async () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString(); // inside the 15-minute lead-in
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    calendar.mockResolvedValue(
      new Response(
        JSON.stringify([
          { title: "CPI m/m", country: "USD", date: soon, impact: "High" },
          { title: "FOMC Statement", country: "USD", date: tomorrow, impact: "High" },
          { title: "Old news", country: "USD", date: past, impact: "High" },
          { title: "Retail Sales", country: "USD", date: tomorrow, impact: "Medium" },
        ])
      )
    );
    const body = await (await fetch(`${base}/api/events`)).json();
    expect(body.events.map((e: { title: string }) => e.title)).toEqual(["CPI m/m", "FOMC Statement"]);
    expect(body.window).toMatchObject({ active: true, headline: "USD CPI m/m", next: { headline: "USD FOMC Statement" } });
  });

  it("has no pause when the calendar can't be read", async () => {
    calendar.mockResolvedValue(new Response("down", { status: 503 }));
    const body = await (await fetch(`${base}/api/events`)).json();
    expect(body).toMatchObject({ events: [], window: { active: false } });
  });
});
