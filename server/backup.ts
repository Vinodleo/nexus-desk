import fs from "fs";
import path from "path";
import { gunzipSync, gzipSync } from "zlib";
import { deleteObject, getObject, putObject, s3ConfigFromEnv, type S3Config } from "./s3";

// Daily backups of the server's saved state, off this machine: every file at
// the top of the data folder (open positions, live-order records, desk
// settings, trade records, the strategies' checks and replay results), as one
// compressed file a day in a bucket (Fly's object storage, set up with
// `fly storage create`; server/s3.ts). Kept BACKUP_KEEP_DAYS days. The
// folders under it (downloaded candles, saved setups) aren't backed up: the
// replays download and rebuild them. Angel One's login tokens are left out:
// they're credentials, and renewed each day anyway.
//
// To restore a day, set RESTORE_BACKUP=YYYY-MM-DD on the server (docs/
// hosting.md): at start-up it puts that day's files back, keeping the ones it
// replaces in a folder beside them, and restarts to load them. It restores
// once: a marker file remembers which day it did.

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

/**
 * At start-up, when RESTORE_BACKUP names a day (YYYY-MM-DD) not restored
 * yet: puts that day's files back (the ones replaced kept aside in a
 * "before-restore-…" folder) and remembers it. True when it restored: the
 * server then restarts to load them.
 */
export async function restoreIfAsked(env: NodeJS.ProcessEnv = process.env, deps: BackupDeps = realDeps): Promise<boolean> {
  const wanted = env.RESTORE_BACKUP?.trim();
  if (!wanted) return false;
  const dir = deps.dir();
  const marker = path.join(dir, RESTORED_MARKER);
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === wanted) return false;
  const fail = (why: string) => {
    console.error(`[Backup] Couldn't restore ${wanted}: ${why}. Starting with the files as they are.`);
    return false;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wanted)) return fail("RESTORE_BACKUP should be a day, like 2026-10-05");
  const cfg = deps.config();
  if (!cfg) return fail("no backup bucket is set up");
  let bundle: BackupBundle;
  try {
    const body = await deps.get(cfg, backupKey(wanted));
    if (!body) return fail("there's no backup for that day");
    bundle = JSON.parse(gunzipSync(body).toString("utf8"));
    if (bundle?.version !== 1 || !bundle.files || typeof bundle.files !== "object") return fail("the backup isn't one this server can read");
  } catch (err: any) {
    return fail(err?.message || String(err));
  }
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
  fs.writeFileSync(marker, wanted, "utf8");
  console.log(`[Backup] Restored ${Object.keys(bundle.files).length} files from ${wanted} (the files they replaced are in ${aside}).`);
  return true;
}

/** For Settings: whether backups are set up, the last one, and the last failure. */
export function backupStatus(env: NodeJS.ProcessEnv = process.env) {
  return { configured: s3ConfigFromEnv(env) !== null, keepDays: BACKUP_KEEP_DAYS, ...status };
}

/** Checks hourly (first a few minutes after start) whether today's backup is due. */
export function startBackups(notify: BackupDeps["notify"]): void {
  loadStatus(dataDir());
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
