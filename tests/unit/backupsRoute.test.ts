import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Server → Restore a backup: the days there's a backup for, and
// putting one back, the server restarting only once it has said yes.

const backup = vi.hoisted(() => ({
  listBackups: vi.fn(),
  requestRestore: vi.fn(),
  restartForRestore: vi.fn(),
  restoreState: vi.fn(() => ({ last: null, pending: null })),
  backupStatus: vi.fn(() => ({ configured: true })),
}));
vi.mock("../../server/backup", () => backup);

let base: string;
let server: Server;

beforeAll(async () => {
  const { router } = await import("../../server/routes/backups");
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());
beforeEach(() => {
  backup.listBackups.mockReset();
  backup.requestRestore.mockReset();
  backup.restartForRestore.mockReset();
});

const restore = async (body: unknown) => {
  const res = await fetch(`${base}/api/backups/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

describe("the backups", () => {
  it("lists the days, the last restore and one waiting", async () => {
    backup.listBackups.mockResolvedValue([{ day: "2026-10-22", bytes: 1200, at: 1 }]);
    backup.restoreState.mockReturnValueOnce({ last: { day: "2026-10-20", ok: true } as any, pending: null });
    expect(await (await fetch(`${base}/api/backups`)).json()).toEqual({
      success: true,
      configured: true,
      days: [{ day: "2026-10-22", bytes: 1200, at: 1 }],
      restore: { day: "2026-10-20", ok: true },
      pending: null,
    });
    backup.listBackups.mockRejectedValue(new Error("Listing refused (403 AccessDenied)"));
    const failed = await fetch(`${base}/api/backups`);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("Couldn't list the backups: Listing refused (403 AccessDenied)");
  });

  it("restarts to restore only once the server has taken the request", async () => {
    backup.requestRestore.mockResolvedValue({ ok: true, requestedAt: 123 });
    expect(await restore({ day: "2026-10-22" })).toEqual({ status: 200, body: { success: true, day: "2026-10-22", requestedAt: 123 } });
    expect(backup.requestRestore).toHaveBeenCalledWith("2026-10-22");
    expect(backup.restartForRestore).toHaveBeenCalledOnce();

    backup.restartForRestore.mockClear();
    backup.requestRestore.mockResolvedValue({ ok: false, status: 404, error: "There's no backup for that day." });
    expect(await restore({ day: "2026-10-01" })).toEqual({ status: 404, body: { success: false, error: "There's no backup for that day." } });
    expect((await restore({ day: "yesterday" })).status).toBe(400);
    expect(backup.restartForRestore).not.toHaveBeenCalled();
  });
});
