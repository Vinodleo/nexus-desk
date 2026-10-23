import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The server's recent log for Settings → Server → Recent log: every console
// line kept on the volume, masked, the older ones moved aside, read newest
// first.

let dir: string;
let log: typeof import("../../server/serverLog");

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-log-"));
  vi.stubEnv("NEXUS_DATA_DIR", dir);
  vi.resetModules();
  log = await import("../../server/serverLog");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the server's log", () => {
  it("keeps each line with its time and level, masked like the error reports, newest first", () => {
    log.recordLine("info", ["[Scanner] Cycle done in %d ms", 812], 1000);
    log.recordLine("warn", ["[Auth] owner@example.com signed in with Bearer abc.def.ghi"], 2000);
    log.recordLine("error", ["[Backup] Failed:", new Error("Upload refused (403 AccessDenied)")], 3000);
    const lines = log.readLog(10);
    expect(lines.map((l) => [l.at, l.level])).toEqual([[3000, "error"], [2000, "warn"], [1000, "info"]]);
    expect(lines[2].text).toBe("[Scanner] Cycle done in 812 ms");
    expect(lines[1].text).toBe("[Auth] [email] signed in with Bearer [hidden]");
    expect(lines[0].text).toContain("[Backup] Failed: Error: Upload refused (403 AccessDenied)");
    // Only the problems, and only so many.
    expect(log.readLog(10, true).map((l) => l.level)).toEqual(["error", "warn"]);
    expect(log.readLog(1).map((l) => l.at)).toEqual([3000]);
    // On the volume, under a folder (not in the daily backup).
    expect(fs.existsSync(path.join(dir, "logs", "server.log"))).toBe(true);
  });

  it("moves a full file aside and starts a new one, reading both, two at most", () => {
    const long = "word ".repeat(200);
    let at = 0;
    while (!fs.existsSync(path.join(dir, "logs", "server.log.1"))) log.recordLine("info", [`${++at} ${long}`], at);
    const firstMoved = at;
    log.recordLine("info", ["after the move"], ++at);
    const lines = log.readLog(5000);
    expect(lines[0].text).toBe("after the move");
    expect(lines[lines.length - 1].text.startsWith("1 ")).toBe(true);
    expect(lines).toHaveLength(firstMoved + 1);
    // A second move drops the oldest file.
    while (fs.statSync(path.join(dir, "logs", "server.log")).size <= log.LOG_MAX_BYTES) log.recordLine("info", [`${++at} ${long}`], at);
    log.recordLine("info", ["after the second move"], ++at);
    expect(log.readLog(5000).some((l) => l.text.startsWith("1 "))).toBe(false);
  });

  it("cuts a very long line, skips a line it can't read, and never stops the server when the disk fails", () => {
    log.recordLine("info", ["y ".repeat(log.MAX_LINE_CHARS)], 1);
    fs.appendFileSync(path.join(dir, "logs", "server.log"), "not json\n");
    expect(log.readLog(10).map((l) => l.text.length)).toEqual([log.MAX_LINE_CHARS]);
    fs.rmSync(path.join(dir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "logs"), "a file where the folder was");
    log._resetServerLog();
    expect(() => log.recordLine("error", ["can't be kept"], 2)).not.toThrow();
    expect(log.readLog(10)).toEqual([]);
  });

  it("keeps every console line once started, still printing it", () => {
    const printed: string[] = [];
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const m of ["log", "info", "warn", "error"] as const) console[m] = (...a: unknown[]) => void printed.push(`${m}:${a.join(" ")}`);
    try {
      log.startServerLog();
      console.log("hello");
      console.warn("careful");
      console.error("broken");
      expect(printed).toEqual(["log:hello", "warn:careful", "error:broken"]);
      expect(log.readLog(10).map((l) => `${l.level}:${l.text}`)).toEqual(["error:broken", "warn:careful", "info:hello"]);
    } finally {
      Object.assign(console, saved);
    }
  });

  it("is read by the owner from /api/server-log", async () => {
    log.recordLine("info", ["one"], 1);
    log.recordLine("warn", ["two"], 2);
    const { router } = await import("../../server/routes/serverLog");
    const app = express();
    app.use(router);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(`${base}/api/server-log`)).json()).toEqual({
        success: true,
        lines: [{ at: 2, level: "warn", text: "two" }, { at: 1, level: "info", text: "one" }],
      });
      expect((await (await fetch(`${base}/api/server-log?problems=1&limit=1`)).json()).lines.map((l: { text: string }) => l.text)).toEqual(["two"]);
      expect((await fetch(`${base}/api/server-log?limit=9999`)).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
