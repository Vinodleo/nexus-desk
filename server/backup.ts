import fs from "fs";
import path from "path";
import { gunzipSync, gzipSync } from "zlib";
import { deleteObject, getObject, listObjects, missingS3Settings, putObject, s3ConfigFromEnv, type S3Config } from "./s3";

// Daily backups of the server's saved state, off this machine: every file at
// the top of the data folder (open positions, live-order records, desk
// settings, trade records, the strategies' checks and replay results), as one
// compressed file a day in a bucket (Fly's object storage, set up with
// `fly storage create`; server/s3.ts). Kept BACKUP_KEEP_DAYS days. The
// folders under it (downloaded candles, saved setups) aren't backed up: the
// replays download and rebuild them. Angel One's login tokens are left out:
// they're credentials, and renewed each day anyway.
//
// To restore a day: Settings → Server → Restore a backup (owner's ask, 23
// Oct), or RESTORE_BACKUP=YYYY-MM-DD on the server (docs/hosting.md). Settings
// leaves a request and restarts the server; at start-up it puts that day's
// files back, keeping the ones it replaces in a folder beside them, and
// restarts again to load them. The request is taken once and what came of it
// kept for Settings; RESTORE_BACKUP restores once, a marker file remembering
// which day it did.

export const BACKUP_KEEP_DAYS = 30;
const PREFIX = "nexus-desk/backup-";
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A day's backup is due this long after the last one (a little under a day, so it doesn't drift later each day). */
const DUE_AFTER_MS = DAY_MS - 30 * 60 * 1000;
/** Credentials, renewed daily: not backed up. */
const SKIP = new Set(["angel_tokens.json"]);
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const STATUS_FILE = "backup_status.json";
const RESTORED_MARKER = ".restored";
/** A restore asked for in Settings, and what came of the last one (dot files: never backed up or restored). */
const REQUEST_FILE = ".restore_request.json";
const RESULT_FILE = ".restore_result.json";
const BACKUP_DAY = /^nexus-desk\/backup-(\d{4}-\d{2}-\d{2})\.json\.gz$/;

const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const backupKey = (day: string) => `${PREFIX}${day}.json.gz`;

/** One day's backup: each file's contents, as text when it's text. */
export interface BackupBundle {
  version: 1;
  createdAt: number;
  files: Record<string, { utf8?: string; base64?: string }>;
}

export interface BackupStatus {
  lastAt: number | null;
  lastKey: string | null;
  /** The compressed backup's size, and how many files it held. */
  lastBytes: number;
  files: number;
  lastError: string | null;
  lastErrorAt: number | null;
  /** The day a failure was last told by pop-up (once a day at most). */
  toldDay: string | null;
}

let status: BackupStatus = { lastAt: null, lastKey: null, lastBytes: 0, files: 0, lastError: null, lastErrorAt: null, toldDay: null };
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export interface BackupDeps {
  now: () => number;
  dir: () => string;
  config: () => S3Config | null;
  put: typeof putObject;
  get: typeof getObject;
  del: typeof deleteObject;
  list: typeof listObjects;
  /** Tells the owner (a pop-up) that backups are failing. */
  notify: (title: string, body: string) => void;
}

const realDeps: BackupDeps = {
  now: () => Date.now(),
  dir: dataDir,
  config: () => s3ConfigFromEnv(),
  put: putObject,
  get: getObject,
  del: deleteObject,
  list: listObjects,
  notify: () => {},
};

/** Every regular file at the top of the data folder, but credentials, files being written and markers. */
export function collectBackup(dir: string, now: number): BackupBundle {
  const files: BackupBundle["files"] = {};
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (SKIP.has(name) || name.startsWith(".") || name.endsWith(".tmp")) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const bytes = fs.readFileSync(full);
    const text = bytes.toString("utf8");
    files[name] = Buffer.from(text, "utf8").equals(bytes) ? { utf8: text } : { base64: bytes.toString("base64") };
  }
  return { version: 1, createdAt: now, files };
}

function loadStatus(dir: string): void {
  try {
    const file = path.join(dir, STATUS_FILE);
    if (fs.existsSync(file)) status = { ...status, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {}
}

function saveStatus(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${STATUS_FILE}.tmp`), JSON.stringify(status), "utf8");
    fs.renameSync(path.join(dir, `${STATUS_FILE}.tmp`), path.join(dir, STATUS_FILE));
  } catch {}
}

/** A backup is due: never made, or the last one about a day ago. */
export const backupDue = (s: BackupStatus, now: number) => s.lastAt === null || now - s.lastAt >= DUE_AFTER_MS;

/** Makes today's backup and drops the one that's BACKUP_KEEP_DAYS old. "off" without a bucket. */
export async function runBackup(deps: BackupDeps = realDeps): Promise<"done" | "off" | "failed"> {
  const cfg = deps.config();
  if (!cfg || running) return "off";
  running = true;
  const now = deps.now();
  const day = isoDay(now);
  try {
    const bundle = collectBackup(deps.dir(), now);
    const body = gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"));
    await deps.put(cfg, backupKey(day), body, "application/gzip");
    // The day that's now too old, and the two before it in case a day's delete was missed.
    for (let k = BACKUP_KEEP_DAYS; k < BACKUP_KEEP_DAYS + 3; k++) await deps.del(cfg, backupKey(isoDay(now - k * DAY_MS))).catch(() => undefined);
    status = { ...status, lastAt: now, lastKey: backupKey(day), lastBytes: body.length, files: Object.keys(bundle.files).length, lastError: null, lastErrorAt: null };
    console.log(`[Backup] Saved ${status.files} files (${Math.round(body.length / 1024)} KB) as ${status.lastKey}.`);
    return "done";
  } catch (err: any) {
    status = { ...status, lastError: err?.message || String(err), lastErrorAt: now };
    console.error("[Backup] Failed:", err);
    if (status.toldDay !== day) {
      status.toldDay = day;
      deps.notify("Backup failed", `Today's backup of the server's data didn't save (${status.lastError}). It tries again every hour.`);
    }
    return "failed";
  } finally {
    saveStatus(deps.dir());
    running = false;
  }
}

/** A day's backup from the bucket: the bundle, or why it can't be had. */
async function readBundle(day: string, deps: BackupDeps): Promise<BackupBundle | string> {
  const cfg = deps.config();
  if (!cfg) return "no backup bucket is set up";
  try {
    const body = await deps.get(cfg, backupKey(day));
    if (!body) return "there's no backup for that day";
    const bundle = JSON.parse(gunzipSync(body).toString("utf8"));
    if (bundle?.version !== 1 || !bundle.files || typeof bundle.files !== "object") return "the backup isn't one this server can read";
    return bundle;
  } catch (err: any) {
    return err?.message || String(err);
  }
}

/** Puts a day's files back (the ones replaced kept aside in a "before-restore-…" folder): how many, or why not. */
async function restoreDay(day: string, deps: BackupDeps): Promise<{ files: number; aside: string } | string> {
  const bundle = await readBundle(day, deps);
  if (typeof bundle === "string") return bundle;
  const dir = deps.dir();
  // What's there now is kept aside, in case.
  fs.mkdirSync(dir, { recursive: true });
  const aside = path.join(dir, `before-restore-${new Date(deps.now()).toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(aside, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!name.startsWith(".") && fs.statSync(full).isFile()) fs.copyFileSync(full, path.join(aside, name));
  }
  for (const [name, file] of Object.entries(bundle.files)) {
    // Only plain file names: nothing written outside the data folder.
    if (name !== path.basename(name) || name.startsWith(".")) continue;
    const bytes = file.utf8 !== undefined ? Buffer.from(file.utf8, "utf8") : Buffer.from(file.base64 ?? "", "base64");
    fs.writeFileSync(path.join(dir, `${name}.tmp`), bytes);
    fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, name));
  }
  console.log(`[Backup] Restored ${Object.keys(bundle.files).length} files from ${day} (the files they replaced are in ${aside}).`);
  return { files: Object.keys(bundle.files).length, aside };
}

/** What came of the last restore asked for in Settings. */
export interface RestoreResult {
  day: string;
  /** When it was asked for, and when it was done or failed (ms). */
  requestedAt: number;
  at: number;
  ok: boolean;
  files: number;
  error: string | null;
}

const readJson = <T>(file: string): T | null => {
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

/**
 * At start-up, puts a day's backup back when asked: by Settings (a request
 * file, taken once whatever comes of it, so a failing restore can't loop) or
 * by RESTORE_BACKUP naming a day not restored yet. True when it restored: the
 * server then restarts to load the files.
 */
export async function restoreIfAsked(env: NodeJS.ProcessEnv = process.env, deps: BackupDeps = realDeps): Promise<boolean> {
  const dir = deps.dir();
  const requestFile = path.join(dir, REQUEST_FILE);
  const request = readJson<{ day?: unknown; requestedAt?: unknown }>(requestFile);
  if (fs.existsSync(requestFile)) {
    fs.rmSync(requestFile, { force: true });
    const day = typeof request?.day === "string" ? request.day : "";
    const requestedAt = typeof request?.requestedAt === "number" ? request.requestedAt : 0;
    let done: Awaited<ReturnType<typeof restoreDay>>;
    try {
      done = /^\d{4}-\d{2}-\d{2}$/.test(day) ? await restoreDay(day, deps) : "the request didn't name a day";
    } catch (err: any) {
      done = err?.message || String(err);
    }
    const result: RestoreResult =
      typeof done === "string"
        ? { day, requestedAt, at: deps.now(), ok: false, files: 0, error: done }
        : { day, requestedAt, at: deps.now(), ok: true, files: done.files, error: null };
    try {
      fs.writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify(result), "utf8");
    } catch {}
    if (!result.ok) console.error(`[Backup] Couldn't restore ${day}: ${result.error}. Starting with the files as they are.`);
    return result.ok;
  }

  const wanted = env.RESTORE_BACKUP?.trim();
  if (!wanted) return false;
  const marker = path.join(dir, RESTORED_MARKER);
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === wanted) return false;
  const fail = (why: string) => {
    console.error(`[Backup] Couldn't restore ${wanted}: ${why}. Starting with the files as they are.`);
    return false;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wanted)) return fail("RESTORE_BACKUP should be a day, like 2026-10-05");
  const done = await restoreDay(wanted, deps);
  if (typeof done === "string") return fail(done);
  fs.writeFileSync(marker, wanted, "utf8");
  return true;
}

/** One day's backup in the bucket. */
export interface BackupDay {
  day: string;
  bytes: number;
  /** When it was saved (ms). */
  at: number;
}

/** The days there's a backup for, newest first; null without a bucket. */
export async function listBackups(deps: BackupDeps = realDeps): Promise<BackupDay[] | null> {
  const cfg = deps.config();
  if (!cfg) return null;
  const days: BackupDay[] = [];
  for (const o of await deps.list(cfg, PREFIX)) {
    const day = BACKUP_DAY.exec(o.key)?.[1];
    if (day) days.push({ day, bytes: o.bytes, at: o.at });
  }
  return days.sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * Settings asks for a day to be put back: checks the backup is there and
 * readable, then leaves the request for the restart (restartForRestore).
 */
export async function requestRestore(
  day: string,
  deps: BackupDeps = realDeps
): Promise<{ ok: true; requestedAt: number } | { ok: false; status: number; error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, status: 400, error: "That isn't a day." };
  if (!deps.config()) return { ok: false, status: 409, error: "Backups aren't set up on the server." };
  const dir = deps.dir();
  if (fs.existsSync(path.join(dir, REQUEST_FILE))) return { ok: false, status: 409, error: "A restore is already waiting for the server to restart." };
  const bundle = await readBundle(day, deps);
  if (typeof bundle === "string") {
    const missing = bundle === "there's no backup for that day";
    return { ok: false, status: missing ? 404 : 502, error: missing ? "There's no backup for that day." : `Couldn't read that backup: ${bundle}.` };
  }
  const requestedAt = deps.now();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REQUEST_FILE), JSON.stringify({ day, requestedAt }), "utf8");
  console.log(`[Backup] Restore of ${day} asked for in Settings: restarting to put it back.`);
  return { ok: true, requestedAt };
}

/** The last restore asked for in Settings, and one waiting for the restart (null if none). */
export function restoreState(dir: string = dataDir()): { last: RestoreResult | null; pending: string | null } {
  return { last: readJson<RestoreResult>(path.join(dir, RESULT_FILE)), pending: readJson<{ day?: string }>(path.join(dir, REQUEST_FILE))?.day ?? null };
}

/** Restarts the server so the request is taken at start-up (server.ts saves the state in memory first). */
let restart: () => void = () => process.exit(1);
export function setRestart(fn: () => void): void {
  restart = fn;
}
/** A moment after answering the app, so the answer gets out first. */
export function restartForRestore(delayMs = 1500): void {
  setTimeout(() => restart(), delayMs);
}

/** For Settings: whether backups are set up, the last one, and the last failure. */
export function backupStatus(env: NodeJS.ProcessEnv = process.env) {
  return { configured: s3ConfigFromEnv(env) !== null, missing: missingS3Settings(env), keepDays: BACKUP_KEEP_DAYS, ...status, restore: restoreState().last };
}

/** Checks hourly (first a few minutes after start) whether today's backup is due. */
export function startBackups(notify: BackupDeps["notify"]): void {
  loadStatus(dataDir());
  const missing = missingS3Settings();
  if (missing.length > 0) console.warn(`[Backup] Off: this server can't see ${missing.join(", ")} (fly secrets list; see docs/hosting.md).`);
  const deps = { ...realDeps, notify };
  const check = () => {
    timer = setTimeout(check, CHECK_EVERY_MS);
    if (backupDue(status, Date.now())) void runBackup(deps);
  };
  timer = setTimeout(check, FIRST_CHECK_MS);
}

/** Test hooks. */
export function _resetBackups(): void {
  status = { lastAt: null, lastKey: null, lastBytes: 0, files: 0, lastError: null, lastErrorAt: null, toldDay: null };
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
export function _loadBackupStatus(dir: string): void {
  loadStatus(dir);
}
