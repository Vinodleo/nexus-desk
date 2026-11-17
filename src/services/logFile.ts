import { indiaClock, indiaDay } from "../components/ledger/format";

// Settings → Server → Recent log → Download (owner's ask, 17 Nov): the
// server's log as a text file to send on, from the phone's share sheet where
// it has one (so it can go straight to a chat or Files), else as a download.
// The server masks keys, tokens and emails before it keeps a line.

export interface FileLogLine {
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

const LEVEL: Record<FileLogLine["level"], string> = { info: "INFO ", warn: "WARN ", error: "ERROR" };
const IST_MS = 5.5 * 60 * 60 * 1000;

/** The file's name, with the India day and time it was saved: "nexus-desk-log-2026-11-17-1120.txt". */
export function logFileName(now: number): string {
  const s = new Date(now + IST_MS).toISOString();
  return `nexus-desk-log-${s.slice(0, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}.txt`;
}

/** The lines (newest first, as the server gives them) as a text file, each with its India day and time. */
export function logFileText(lines: FileLogLine[], problems: boolean, now: number): string {
  const head = [
    `Nexus Desk server log (${problems ? "warnings and errors" : "all lines"})`,
    `Saved ${indiaDay(now)}, ${indiaClock(now)} India time · ${lines.length} line${lines.length === 1 ? "" : "s"}, newest first`,
    "Keys, tokens and emails are masked by the server.",
    "",
  ];
  const body = lines.map((l) => `${indiaDay(l.at)} ${indiaClock(l.at, true)}  ${LEVEL[l.level]}  ${l.text}`);
  return `${[...head, ...body].join("\n")}\n`;
}

export type SaveResult = "shared" | "downloaded" | "cancelled" | "needs-tap";

/**
 * Hands the file to the phone's share sheet, or downloads it. "needs-tap" when
 * the browser wants a fresh tap to share (Safari, after the log took a while
 * to read): call again from a tap.
 */
export async function saveTextFile(name: string, text: string): Promise<SaveResult> {
  const file = new File([text], name, { type: "text/plain" });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return "shared";
    } catch (err) {
      const why = (err as { name?: string })?.name;
      if (why === "AbortError") return "cancelled";
      if (why === "NotAllowedError") return "needs-tap";
      // Any other refusal: a download instead.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
