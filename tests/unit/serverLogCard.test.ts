// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Server → Recent log: the server's latest lines, newest first, by
// day in India time, warnings and errors standing out or shown alone.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { ServerLog } = await import("../../src/components/ledger/ServerLog");
const { LOG_REFRESH_MS } = await import("../../src/hooks/useServerLog");
const { indiaClock, indiaDay } = await import("../../src/components/ledger/format");
const { logFileName, logFileText } = await import("../../src/services/logFile");
const { LOG_DOWNLOAD_LINES } = await import("../../src/shared/serverLog");

const lines = [
  { at: Date.parse("2026-10-23T11:00:05Z"), level: "error", text: "[Backup] Failed: Upload refused (403 AccessDenied)" },
  { at: Date.parse("2026-10-23T10:40:00Z"), level: "warn", text: "[IPO] Couldn't read NSE's issues: timeout" },
  { at: Date.parse("2026-10-22T18:00:00Z"), level: "info", text: "Self-Learning Trading Bot v2.0 Server running on port 3000" },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: string) =>
    new Response(JSON.stringify({ success: true, lines: url.includes("problems=1") ? lines.slice(0, 2) : lines }))
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

describe("the server's recent log in Settings", () => {
  it("says a moment's day and time in India", () => {
    expect(indiaDay(Date.parse("2026-10-22T18:35:00Z"))).toBe("Fri 23 Oct");
    expect(indiaClock(Date.parse("2026-10-23T10:40:05Z"))).toBe("4:10 pm");
    expect(indiaClock(Date.parse("2026-10-23T10:40:05Z"), true)).toBe("4:10:05 pm");
    expect(indiaClock(Date.parse("2026-10-22T18:30:00Z"))).toBe("12:00 am");
  });

  it("reads nothing until opened, then shows the lines newest first under their day, problems standing out", async () => {
    render(createElement(ServerLog));
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Recent log" }));
    await flush();
    expect(apiFetch).toHaveBeenCalledWith("/api/server-log?limit=200");
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Fri 23 Oct4:30:05 pm [Backup] Failed: Upload refused (403 AccessDenied)",
      "4:10:00 pm [IPO] Couldn't read NSE's issues: timeout",
      "Thu 22 Oct11:30:00 pm Self-Learning Trading Bot v2.0 Server running on port 3000",
    ]);
    expect(items.map((li) => li.querySelector("[data-level]")!.className.match(/text-(ink|warn|loss)/)![0])).toEqual(["text-loss", "text-warn", "text-ink"]);
  });

  it("shows warnings and errors alone, looks again on a tap and every so often while open", async () => {
    render(createElement(ServerLog));
    fireEvent.click(screen.getByRole("button", { name: "Recent log" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Warnings and errors" }));
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith("/api/server-log?limit=200&problems=1");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const calls = vi.mocked(apiFetch).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Look again" }));
    await flush();
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(calls + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_REFRESH_MS);
    });
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(calls + 2);
    // Closed: no more looking.
    fireEvent.click(screen.getByRole("button", { name: "Recent log" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_REFRESH_MS * 3);
    });
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(calls + 2);
  });

  it("says when there's nothing, or the log can't be read", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, lines: [] })));
    render(createElement(ServerLog));
    fireEvent.click(screen.getByRole("button", { name: "Recent log" }));
    await flush();
    expect(screen.getByText("Nothing logged yet.")).toBeTruthy();
    vi.mocked(apiFetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
    fireEvent.click(screen.getByRole("button", { name: "Look again" }));
    await flush();
    expect(screen.getByText("Couldn't read the server's log.")).toBeTruthy();
  });

  it("downloads the lines shown as a text file, each with its day and time in India", async () => {
    const saved = Date.parse("2026-11-17T05:50:00Z"); // 11:20 am in India
    expect(logFileName(saved)).toBe("nexus-desk-log-2026-11-17-1120.txt");
    expect(logFileText(lines.slice(0, 2) as never, true, saved)).toBe(
      [
        "Nexus Desk server log (warnings and errors)",
        "Saved Tue 17 Nov, 11:20 am India time · 2 lines, newest first",
        "Keys, tokens and emails are masked by the server.",
        "",
        "Fri 23 Oct 4:30:05 pm  ERROR  [Backup] Failed: Upload refused (403 AccessDenied)",
        "Fri 23 Oct 4:10:00 pm  WARN   [IPO] Couldn't read NSE's issues: timeout",
        "",
      ].join("\n"),
    );

    // No share sheet (a computer): a download, every line the server keeps of the ones shown.
    const created: Blob[] = [];
    const clicked: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), "blob:log"), revokeObjectURL: () => {} }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    render(createElement(ServerLog));
    fireEvent.click(screen.getByRole("button", { name: "Recent log" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Warnings and errors" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/server-log?limit=${LOG_DOWNLOAD_LINES}&problems=1`);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toMatch(/^nexus-desk-log-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/);
    expect(created[0].type).toBe("text/plain");
    expect(screen.getByRole("status").textContent).toBe(`Saved as ${clicked[0]}.`);
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("hands it to the phone's share sheet, asking for a tap when the browser wants one", async () => {
    const shared: File[][] = [];
    let refuse = true;
    const share = vi.fn(async (data: ShareData) => {
      if (refuse) {
        refuse = false;
        throw Object.assign(new Error("needs a tap"), { name: "NotAllowedError" });
      }
      shared.push(data.files ?? []);
    });
    Object.assign(navigator, { share, canShare: () => true });
    try {
      render(createElement(ServerLog));
      fireEvent.click(screen.getByRole("button", { name: "Recent log" }));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      await flush();
      expect(apiFetch).toHaveBeenLastCalledWith(`/api/server-log?limit=${LOG_DOWNLOAD_LINES}`);
      // Safari wanted a fresh tap: one to save it.
      fireEvent.click(screen.getByRole("button", { name: "Save or send the log" }));
      await flush();
      expect(shared).toHaveLength(1);
      expect(shared[0][0].name).toMatch(/^nexus-desk-log-.*\.txt$/);
      expect(screen.queryByRole("button", { name: "Save or send the log" })).toBeNull();
    } finally {
      delete (navigator as { share?: unknown }).share;
      delete (navigator as { canShare?: unknown }).canShare;
    }
  });

  it("says when the log can't be read to save it", async () => {
    render(createElement(ServerLog));
    fireEvent.click(screen.getByRole("button", { name: "Recent log" }));
    await flush();
    vi.mocked(apiFetch).mockImplementation(async () => new Response("Not found", { status: 404 }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Couldn't read the log to save it.");
  });
});
