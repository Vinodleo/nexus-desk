import v8 from "v8";
import { PerformanceObserver, constants } from "perf_hooks";

// Node keeps the server's objects in a heap with a limit of its own, about
// half the machine's memory (some 256 MB of Fly's 512): near it Node spends
// its time clearing memory and the scanner stalls, then it dies and Fly
// restarts it, with no error to report (16 Oct 2026, 4:18–4:48 am India time).
// So the background work (the replays, the machine-learning test) stops itself
// before that and carries on later (stopIfMemoryTight, from each one's rest),
// and the server tells Sentry when its memory gets close, naming the work
// running (startMemoryWatch).
//
// What counts is what's still in use after Node's last full clean-up (a
// major GC): between clean-ups the heap also holds garbage, so its size then
// says little.

/** Background work stops itself past this share of Node's heap limit. */
export const HEAP_STOP_SHARE = 0.8;
/** The server tells Sentry past this share, at most once an hour. */
export const HEAP_WARN_SHARE = 0.75;
/** A clean-up older than this says nothing about now (none since: no pressure). */
const FRESH_MS = 10 * 60 * 1000;
const WARN_EVERY_MS = 60 * 60 * 1000;
const MB = 1024 * 1024;

export interface HeapAfterGc {
  /** Still in use just after the clean-up (bytes). */
  heapUsed: number;
  /** Node's heap limit (bytes). */
  heapLimit: number;
  at: number;
}

let lastGc: HeapAfterGc | null = null;
let lastWarnedAt = -Infinity;
let observer: PerformanceObserver | null = null;

const mb = (bytes: number) => Math.round(bytes / MB);

/** Whether the heap after the last clean-up (if recent) is past `share` of Node's limit. */
export function memoryTight(share = HEAP_STOP_SHARE, now = Date.now(), gc = lastGc): boolean {
  return !!gc && now - gc.at < FRESH_MS && gc.heapUsed > share * gc.heapLimit;
}

/** For background work's rest: stops it (an error its job logs, then retries later) when memory is tight. */
export function stopIfMemoryTight(work: string, now = Date.now()): void {
  if (!memoryTight(HEAP_STOP_SHARE, now)) return;
  const gc = lastGc!;
  throw new Error(`Stopped ${work} to keep the server safe: Node's memory is at ${mb(gc.heapUsed)} of ${mb(gc.heapLimit)} MB; it carries on later.`);
}

/** After each full clean-up: remembers what's left, and tells Sentry (console.error) once an hour when it's close to the limit. */
export function noteMajorGc(gc: HeapAfterGc, running: () => string[]): void {
  lastGc = gc;
  if (!memoryTight(HEAP_WARN_SHARE, gc.at, gc) || gc.at - lastWarnedAt < WARN_EVERY_MS) return;
  lastWarnedAt = gc.at;
  const work = running();
  console.error(
    `[Memory] Node's memory is at ${mb(gc.heapUsed)} of ${mb(gc.heapLimit)} MB (${Math.round((gc.heapUsed / gc.heapLimit) * 100)}%, the machine ${mb(process.memoryUsage().rss)} MB). Running: ${
      work.length > 0 ? work.join(", ") : "no background work"
    }.`
  );
}

/** Watches Node's full clean-ups for the rest of the server's life. */
export function startMemoryWatch(running: () => string[]): void {
  if (observer) return;
  observer = new PerformanceObserver((list) => {
    if (!list.getEntries().some((e) => (e as { detail?: { kind?: number } }).detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR)) return;
    const heap = v8.getHeapStatistics();
    noteMajorGc({ heapUsed: heap.used_heap_size, heapLimit: heap.heap_size_limit, at: Date.now() }, running);
  });
  observer.observe({ entryTypes: ["gc"] });
}

/** Test hooks. */
export function _resetMemory(gc: HeapAfterGc | null = null): void {
  lastGc = gc;
  lastWarnedAt = -Infinity;
}
