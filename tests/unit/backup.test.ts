import fs from "fs";
import os from "os";
import path from "path";
import { gunzipSync } from "zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteObject, getObject, listObjects, missingS3Settings, putObject, s3ConfigFromEnv, signObjectRequest, type S3Config } from "../../server/s3";
import * as backup from "../../server/backup";

// Daily backups of the server's saved state to an S3 bucket (Fly's object
// storage), and putting a day back at start-up when asked.

const cfg: S3Config = { endpoint: "https://fly.storage.tigris.dev", region: "auto", bucket: "nexus-backups", accessKeyId: "tid_EXAMPLEKEY", secretAccessKey: "tsec_EXAMPLESECRET/abc+def" };
const DAY = 24 * 60 * 60 * 1000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-backup-"));
  backup._resetBackups();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => vi.restoreAllMocks());

describe("S3 requests", () => {
  it("are signed exactly as AWS's own library signs them (Signature Version 4)", () => {
    // The same requests signed by botocore (AWS's Python library) at the same moment.
    const now = new Date(Date.UTC(2026, 9, 5, 21, 30, 15));
    const signature = (r: { headers: Record<string, string> }) => r.headers.authorization.split("Signature=")[1];
    const put = signObjectRequest(cfg, "PUT", "nexus-desk/backup-2026-10-05.json.gz", Buffer.from("hello backup"), now, { "content-type": "application/gzip" });
    expect(put.url).toBe("https://fly.storage.tigris.dev/nexus-backups/nexus-desk/backup-2026-10-05.json.gz");
    expect(put.headers.authorization).toContain("Credential=tid_EXAMPLEKEY/20261005/auto/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,");
    expect(signature(put)).toBe("05a7a57db44ed1e076a826616d45aa715645a8b6ce8b89741a3164f67b609aec");
    expect(signature(signObjectRequest(cfg, "GET", "nexus-desk/backup-2026-10-05.json.gz", undefined, now))).toBe("f224e44f29ca359f248d8f0a1c14ffbd391c7a15ed9ba72926bb9927d6afda6f");
    // Odd characters in a key are encoded as S3 expects.
    expect(signature(signObjectRequest(cfg, "DELETE", "nexus-desk/backup 2026(x).json.gz", undefined, now))).toBe("73d171fdcc27c074c24ac2f536cde51913db7425fb59e7c2f992f49c16c293d9");
    // fetch sets the Host header itself.
    expect(put.headers.host).toBeUndefined();
  });

  it("list a bucket's objects, signed as AWS's own library signs them, a page at a time", async () => {
    const now = new Date(Date.UTC(2026, 9, 5, 21, 30, 15));
    const signature = (r: { headers: Record<string, string> }) => r.headers.authorization.split("Signature=")[1];
    // The same listings signed by botocore at the same moment.
    const list = signObjectRequest(cfg, "GET", "", undefined, now, {}, { "list-type": "2", prefix: "nexus-desk/backup-" });
    expect(list.url).toBe("https://fly.storage.tigris.dev/nexus-backups?list-type=2&prefix=nexus-desk%2Fbackup-");
    expect(signature(list)).toBe("7f3b12733c3b49500e96f233b645a737aeed695473b66297fdfd1dd3ad04afe0");
    const next = signObjectRequest(cfg, "GET", "", undefined, now, {}, { prefix: "nexus-desk/backup-", "list-type": "2", "continuation-token": "abc+def=" });
    expect(next.url).toBe("https://fly.storage.tigris.dev/nexus-backups?continuation-token=abc%2Bdef%3D&list-type=2&prefix=nexus-desk%2Fbackup-");
    expect(signature(next)).toBe("5ccf214283de9a8698678c002f05ce742c702ce8078f73e6efb3d5a9269efb04");

    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const entry = (key: string, size: number, at: string) => `<Contents><Key>${key}</Key><LastModified>${at}</LastModified><Size>${size}</Size></Contents>`;
      return new Response(
        urls.length === 1
          ? `<ListBucketResult>${entry("nexus-desk/backup-2026-10-04.json.gz", 1200, "2026-10-04T03:10:00.000Z")}<IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`
          : `<ListBucketResult>${entry("nexus-desk/backup-2026-10-05.json.gz", 1300, "2026-10-05T03:10:00.000Z")}<IsTruncated>false</IsTruncated></ListBucketResult>`
      );
    });
    expect(await listObjects(cfg, "nexus-desk/backup-")).toEqual([
      { key: "nexus-desk/backup-2026-10-04.json.gz", bytes: 1200, at: Date.parse("2026-10-04T03:10:00Z") },
      { key: "nexus-desk/backup-2026-10-05.json.gz", bytes: 1300, at: Date.parse("2026-10-05T03:10:00Z") },
    ]);
    expect(urls[1]).toContain("continuation-token=tok%261&");
    vi.stubGlobal("fetch", async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    await expect(listObjects(cfg, "x")).rejects.toThrow("Listing refused (403 AccessDenied)");
  });

  it("read the bucket from what `fly storage create` sets, and nothing until it's all there", () => {
    const env = { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev/", BUCKET_NAME: "nexus-backups" };
    expect(s3ConfigFromEnv(env)).toEqual({ endpoint: "https://fly.storage.tigris.dev", region: "auto", bucket: "nexus-backups", accessKeyId: "a", secretAccessKey: "b" });
    expect(s3ConfigFromEnv({ ...env, BUCKET_NAME: "" })).toBeNull();
    // What Settings names when backups are off: the settings this server can't see, never their values.
    expect(missingS3Settings({ ...env, BUCKET_NAME: " ", AWS_SECRET_ACCESS_KEY: undefined })).toEqual(["AWS_SECRET_ACCESS_KEY", "BUCKET_NAME"]);
    expect(missingS3Settings(env)).toEqual([]);
    expect(backup.backupStatus({ ...env, BUCKET_NAME: "" })).toMatchObject({ configured: false, missing: ["BUCKET_NAME"] });
  });

  it("upload, download and delete, saying why S3 refused", async () => {
    const calls: Array<[string, string]> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([init.method!, url]);
      if (url.endsWith("missing")) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      if (url.endsWith("denied")) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      return new Response(init.method === "GET" ? "stored" : "", { status: 200 });
    });
    await putObject(cfg, "a/b", Buffer.from("x"));
    expect((await getObject(cfg, "a/b"))!.toString()).toBe("stored");
    expect(await getObject(cfg, "missing")).toBeNull();
    await deleteObject(cfg, "missing");
    await expect(putObject(cfg, "denied", Buffer.from("x"))).rejects.toThrow("Upload refused (403 AccessDenied)");
    expect(calls[0]).toEqual(["PUT", "https://fly.storage.tigris.dev/nexus-backups/a/b"]);
  });
});

/** A fake bucket: what's stored under each key. */
function bucket() {
  const stored = new Map<string, Buffer>();
  const deleted: string[] = [];
  const notes: string[] = [];
  const deps = (now: number, over: Partial<backup.BackupDeps> = {}): backup.BackupDeps => ({
    now: () => now,
    dir: () => dir,
    config: () => cfg,
    put: async (_c, key, body) => void stored.set(key, body),
    get: async (_c, key) => stored.get(key) ?? null,
    del: async (_c, key) => void deleted.push(key),
    list: async (_c, prefix) => [...stored].filter(([key]) => key.startsWith(prefix)).map(([key, body], i) => ({ key, bytes: body.length, at: 1_000 + i })),
    notify: (title, body) => void notes.push(`${title}: ${body}`),
    ...over,
  });
  return { stored, deleted, notes, deps };
}

function writeState() {
  fs.writeFileSync(path.join(dir, "daemon_positions_state.json"), JSON.stringify({ positions: [{ id: "p1" }] }));
  fs.writeFileSync(path.join(dir, "desk_state.json"), JSON.stringify({ u: { equity: 100000 } }));
  // Left out: Angel One's login tokens, a file being written, a marker, and the downloaded folders.
  fs.writeFileSync(path.join(dir, "angel_tokens.json"), "{\"jwt\":\"secret\"}");
  fs.writeFileSync(path.join(dir, "desk_state.json.tmp"), "half");
  fs.writeFileSync(path.join(dir, ".restored"), "2026-01-01");
  fs.mkdirSync(path.join(dir, "history_setups"));
  fs.writeFileSync(path.join(dir, "history_setups", "BTC.csv.gz"), "big");
}

describe("the daily backup", () => {
  const now = Date.parse("2026-10-05T03:00:00Z");

  it("saves the top-level state files as one compressed file a day, and drops the one 30 days old", async () => {
    writeState();
    const b = bucket();
    expect(await backup.runBackup(b.deps(now))).toBe("done");
    expect([...b.stored.keys()]).toEqual(["nexus-desk/backup-2026-10-05.json.gz"]);
    const bundle: backup.BackupBundle = JSON.parse(gunzipSync(b.stored.get("nexus-desk/backup-2026-10-05.json.gz")!).toString());
    expect(Object.keys(bundle.files)).toEqual(["daemon_positions_state.json", "desk_state.json"]);
    expect(JSON.parse(bundle.files["desk_state.json"].utf8!)).toEqual({ u: { equity: 100000 } });
    expect(b.deleted).toEqual(["nexus-desk/backup-2026-09-05.json.gz", "nexus-desk/backup-2026-09-04.json.gz", "nexus-desk/backup-2026-09-03.json.gz"]);
    // Shown in Settings, and kept across a restart.
    expect(backup.backupStatus({ ...process.env, AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_ENDPOINT_URL_S3: "https://x", BUCKET_NAME: "y" })).toMatchObject({
      configured: true, keepDays: 30, lastAt: now, lastKey: "nexus-desk/backup-2026-10-05.json.gz", files: 2, lastError: null,
    });
    backup._resetBackups();
    backup._loadBackupStatus(dir);
    expect(backup.backupStatus()).toMatchObject({ lastAt: now, files: 2 });
  });

  it("is due about a day after the last, and does nothing until a bucket is set up", async () => {
    const s = backup.backupStatus();
    expect(backup.backupDue(s, now)).toBe(true);
    expect(backup.backupDue({ ...s, lastAt: now }, now + 20 * 60 * 60 * 1000)).toBe(false);
    expect(backup.backupDue({ ...s, lastAt: now }, now + 23.5 * 60 * 60 * 1000)).toBe(true);
    const b = bucket();
    expect(await backup.runBackup(b.deps(now, { config: () => null }))).toBe("off");
    expect(b.stored.size).toBe(0);
    expect(backup.backupStatus({}).configured).toBe(false);
  });

  it("says so once a day when a backup fails, and tries again", async () => {
    writeState();
    const b = bucket();
    const failing = b.deps(now, { put: async () => Promise.reject(new Error("Upload refused (403 AccessDenied)")) });
    expect(await backup.runBackup(failing)).toBe("failed");
    expect(await backup.runBackup({ ...failing, now: () => now + 60 * 60 * 1000 })).toBe("failed");
    expect(b.notes).toEqual(["Backup failed: Today's backup of the server's data didn't save (Upload refused (403 AccessDenied)). It tries again every hour."]);
    expect(backup.backupStatus()).toMatchObject({ lastAt: null, lastError: "Upload refused (403 AccessDenied)" });
    expect(backup.backupDue(backup.backupStatus(), now + 2 * 60 * 60 * 1000)).toBe(true);
    expect(await backup.runBackup(b.deps(now + 2 * 60 * 60 * 1000))).toBe("done");
    expect(backup.backupStatus()).toMatchObject({ lastError: null });
  });
});

describe("restoring a day at start-up", () => {
  const day1 = Date.parse("2026-10-05T03:00:00Z");

  it("puts that day's files back, keeps the ones it replaced aside, and does it once", async () => {
    writeState();
    const b = bucket();
    await backup.runBackup(b.deps(day1));
    // Things went wrong after: the positions file was lost, the desk changed.
    fs.rmSync(path.join(dir, "daemon_positions_state.json"));
    fs.writeFileSync(path.join(dir, "desk_state.json"), JSON.stringify({ u: { equity: 1 } }));

    expect(await backup.restoreIfAsked({ RESTORE_BACKUP: "2026-10-05" }, b.deps(day1 + DAY))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon_positions_state.json"), "utf8"))).toEqual({ positions: [{ id: "p1" }] });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "desk_state.json"), "utf8"))).toEqual({ u: { equity: 100000 } });
    const aside = fs.readdirSync(dir).find((n) => n.startsWith("before-restore-"))!;
    expect(JSON.parse(fs.readFileSync(path.join(dir, aside, "desk_state.json"), "utf8"))).toEqual({ u: { equity: 1 } });
    // Angel One's tokens weren't in the backup and are left as they are.
    expect(fs.readFileSync(path.join(dir, "angel_tokens.json"), "utf8")).toBe("{\"jwt\":\"secret\"}");
    // After the restart it loads them, without restoring again.
    expect(await backup.restoreIfAsked({ RESTORE_BACKUP: "2026-10-05" }, b.deps(day1 + DAY))).toBe(false);
    expect(await backup.restoreIfAsked({}, b.deps(day1 + DAY))).toBe(false);
  });

  it("starts with the files as they are when the day isn't there, isn't a day, or there's no bucket; and never writes outside the data folder", async () => {
    const b = bucket();
    for (const [env, over] of [
      [{ RESTORE_BACKUP: "2026-10-04" }, {}],
      [{ RESTORE_BACKUP: "yesterday" }, {}],
      [{ RESTORE_BACKUP: "2026-10-05" }, { config: () => null }],
    ] as const) {
      expect(await backup.restoreIfAsked(env, b.deps(day1, over))).toBe(false);
    }
    expect(fs.readdirSync(dir)).toEqual([]);

    const { gzipSync } = await import("zlib");
    const evil: backup.BackupBundle = { version: 1, createdAt: day1, files: { "../outside.json": { utf8: "x" }, "desk_state.json": { utf8: "{}" } } };
    b.stored.set(backup.backupKey("2026-10-05"), gzipSync(JSON.stringify(evil)));
    expect(await backup.restoreIfAsked({ RESTORE_BACKUP: "2026-10-05" }, b.deps(day1))).toBe(true);
    expect(fs.existsSync(path.join(dir, "..", "outside.json"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "desk_state.json"), "utf8")).toBe("{}");
  });
});

describe("restoring a day from Settings", () => {
  const day1 = Date.parse("2026-10-05T03:00:00Z");

  it("lists the days there's a backup for, newest first", async () => {
    const b = bucket();
    writeState();
    await backup.runBackup(b.deps(day1));
    await backup.runBackup(b.deps(day1 + DAY));
    b.stored.set("nexus-desk/other.txt", Buffer.from("x"));
    expect((await backup.listBackups(b.deps(day1 + DAY)))!.map((d) => d.day)).toEqual(["2026-10-06", "2026-10-05"]);
    expect(await backup.listBackups(b.deps(day1, { config: () => null }))).toBeNull();
  });

  it("checks the backup, leaves the request for the restart, and puts the day back at start-up once, saying how it went", async () => {
    writeState();
    const b = bucket();
    await backup.runBackup(b.deps(day1));
    fs.writeFileSync(path.join(dir, "desk_state.json"), JSON.stringify({ u: { equity: 1 } }));

    const asked = await backup.requestRestore("2026-10-05", b.deps(day1 + DAY));
    expect(asked).toEqual({ ok: true, requestedAt: day1 + DAY });
    expect(backup.restoreState(dir)).toEqual({ last: null, pending: "2026-10-05" });
    // Nothing changes until the restart.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "desk_state.json"), "utf8"))).toEqual({ u: { equity: 1 } });
    // One at a time.
    expect(await backup.requestRestore("2026-10-05", b.deps(day1 + DAY))).toMatchObject({ ok: false, status: 409 });

    // The restart: put back, the replaced files kept aside, the request taken.
    expect(await backup.restoreIfAsked({}, b.deps(day1 + DAY + 60_000))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "desk_state.json"), "utf8"))).toEqual({ u: { equity: 100000 } });
    const aside = fs.readdirSync(dir).find((n) => n.startsWith("before-restore-"))!;
    expect(JSON.parse(fs.readFileSync(path.join(dir, aside, "desk_state.json"), "utf8"))).toEqual({ u: { equity: 1 } });
    expect(backup.restoreState(dir)).toEqual({
      last: { day: "2026-10-05", requestedAt: day1 + DAY, at: day1 + DAY + 60_000, ok: true, files: 2, error: null },
      pending: null,
    });
    // The next start loads the files, without restoring again.
    expect(await backup.restoreIfAsked({}, b.deps(day1 + DAY + 120_000))).toBe(false);
    // The request and its result are never in a backup, so a restore can't bring one back.
    expect(Object.keys(backup.collectBackup(dir, day1).files).sort()).toEqual(["backup_status.json", "daemon_positions_state.json", "desk_state.json"]);
  });

  it("takes a request that fails only once, so the server starts as it was and can't loop", async () => {
    const b = bucket();
    writeState();
    await backup.runBackup(b.deps(day1));
    expect((await backup.requestRestore("2026-10-05", b.deps(day1))).ok).toBe(true);
    // The bucket can't be read by the time it restarts.
    const broken = b.deps(day1 + 1000, { get: async () => { throw new Error("Download refused (503 SlowDown)"); } });
    expect(await backup.restoreIfAsked({}, broken)).toBe(false);
    expect(backup.restoreState(dir)).toMatchObject({ last: { day: "2026-10-05", ok: false, error: "Download refused (503 SlowDown)" }, pending: null });
    expect(await backup.restoreIfAsked({}, b.deps(day1 + 2000))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "desk_state.json"), "utf8"))).toEqual({ u: { equity: 100000 } });
  });

  it("refuses what it can't do before restarting anything", async () => {
    const b = bucket();
    expect(await backup.requestRestore("yesterday", b.deps(day1))).toMatchObject({ ok: false, status: 400 });
    expect(await backup.requestRestore("2026-10-04", b.deps(day1))).toEqual({ ok: false, status: 404, error: "There's no backup for that day." });
    expect(await backup.requestRestore("2026-10-04", b.deps(day1, { config: () => null }))).toMatchObject({ ok: false, status: 409 });
    b.stored.set(backup.backupKey("2026-10-03"), Buffer.from("not gzip"));
    expect(await backup.requestRestore("2026-10-03", b.deps(day1))).toMatchObject({ ok: false, status: 502 });
    expect(backup.restoreState(dir)).toEqual({ last: null, pending: null });
  });

  it("restarts a moment after answering, the server's way", () => {
    vi.useFakeTimers();
    try {
      const restart = vi.fn();
      backup.setRestart(restart);
      backup.restartForRestore(1500);
      vi.advanceTimersByTime(1499);
      expect(restart).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
