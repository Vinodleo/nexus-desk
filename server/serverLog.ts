import fs from "fs";
import path from "path";
import { format } from "util";
import { scrubText } from "./errorReports";

// The server's recent log, for Settings → Server → Recent log (owner's ask,
// 23 Oct), in place of `fly logs` in Cloud Shell: every console line, masked
// like the error reports (tokens, keys and emails), kept on the volume
// (logs/server.log, a JSON line each; past LOG_MAX_BYTES it becomes
// server.log.1 and a new one starts), so the lines before a restart or a
// crash are there too. A folder, so not in the daily backup.

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  at: number;
  level: LogLevel;
  text: string;
}

/** A log file's size before it's moved aside: two of them at most, about a megabyte. */
export const LOG_MAX_BYTES = 512 * 1024;
/** The longest line kept (a long stack trace is cut). */
export const MAX_LINE_CHARS = 4000;

const logDir = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "logs");
const FILE = "server.log";

let bytes: number | null = null;
let writing = false;

/** Keeps one line (masked), moving the file aside once it's full. Never throws, never logs. */
export function recordLine(level: LogLevel, args: unknown[], now: number = Date.now()): void {
  if (writing) return;
  writing = true;
  try {
    const dir = logDir();
    const file = path.join(dir, FILE);
    if (bytes === null) {
      fs.mkdirSync(dir, { recursive: true });
      bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    }
    if (bytes > LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
      bytes = 0;
    }
    const line = `${JSON.stringify({ at: now, level, text: scrubText(format(...args)).slice(0, MAX_LINE_CHARS) })}\n`;
    fs.appendFileSync(file, line);
    bytes += Buffer.byteLength(line);
  } catch {
    // A full or missing disk mustn't stop the server: the line is just not kept.
  } finally {
    writing = false;
  }
}

/** The latest lines, newest first; with `problems`, only warnings and errors. */
export function readLog(limit: number, problems = false): LogLine[] {
  const dir = logDir();
  const lines: LogLine[] = [];
  for (const name of [`${FILE}.1`, FILE]) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      try {
        const l = JSON.parse(raw);
        if (typeof l?.at === "number" && typeof l.text === "string" && ["info", "warn", "error"].includes(l.level)) lines.push(l);
      } catch {}
    }
  }
  const kept = problems ? lines.filter((l) => l.level !== "info") : lines;
  return kept.slice(-limit).reverse();
}

let started = false;

/** Keeps every console line from now on (loaded first, by server/instrument.ts). */
export function startServerLog(): void {
  if (started) return;
  started = true;
  const wrap = (method: "log" | "info" | "warn" | "error", level: LogLevel) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      recordLine(level, args);
      original(...args);
    };
  };
  wrap("log", "info");
  wrap("info", "info");
  wrap("warn", "warn");
  wrap("error", "error");
}

/** Test hook. */
export function _resetServerLog(): void {
  bytes = null;
  writing = false;
}
