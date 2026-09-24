import fs from "fs";
import path from "path";

// Facts about where the server is running, so you can check the always-on
// setup works: how long it's been up (a restart resets it) and whether the
// state it saves survives a restart.

export const STARTED_AT = Date.now();
export const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");

/** True when `dir` is its own mount (a volume, a Cloud Storage bucket), not the container's own disk. */
export function isMountPoint(dir: string): boolean {
  try {
    const parent = path.dirname(path.resolve(dir));
    return fs.statSync(dir).dev !== fs.statSync(parent).dev;
  } catch {
    return false;
  }
}

export interface StorageStatus {
  dir: string;
  /** Saved state survives the server restarting or being redeployed. */
  kept: boolean;
  note: string;
}

export function storageStatus(env: NodeJS.ProcessEnv = process.env, dir: string = DATA_DIR): StorageStatus {
  const mounted = isMountPoint(dir);
  if (env.K_SERVICE) {
    // Cloud Run's own disk is memory: gone whenever the instance is replaced.
    return mounted
      ? { dir, kept: true, note: "On a mounted volume" }
      : { dir, kept: false, note: "On Cloud Run's temporary disk: lost when the server restarts or is redeployed" };
  }
  return mounted
    ? { dir, kept: true, note: "On a mounted volume" }
    : { dir, kept: true, note: "On this machine's disk" };
}

export function hostStatus(now: number = Date.now()) {
  return {
    startedAt: STARTED_AT,
    uptimeSec: Math.round((now - STARTED_AT) / 1000),
    cloudRun: process.env.K_SERVICE ? { service: process.env.K_SERVICE, revision: process.env.K_REVISION ?? "" } : null,
    storage: storageStatus(),
  };
}

/** Logs once at start-up when saved state won't survive a restart. */
export function warnIfStateIsTemporary(): void {
  const s = storageStatus();
  if (!s.kept) {
    console.warn(
      `[Host] ${s.note}. Guardian positions, desk settings and tracked setups in ${s.dir} will be lost. Mount a volume and set NEXUS_DATA_DIR (see docs/hosting.md).`
    );
  }
}
