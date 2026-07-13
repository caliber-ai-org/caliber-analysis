/**
 * Advisory per-stream locks, so the sweeper and the Stop hook don't ship the
 * same bytes at the same time.
 *
 * THIS IS A BANDWIDTH OPTIMIZATION, NOT A CORRECTNESS MECHANISM. Do not add
 * logic that depends on the lock being held. Correctness comes from the server:
 * every line carries a uuid and the receiver upserts ON CONFLICT DO NOTHING, so
 * two processes shipping the same lines simply produce one stored copy. The
 * worst a lost race can do is waste an upload and briefly regress a watermark,
 * which the next run re-ships and the server de-dupes again.
 *
 * Given that, the lock is deliberately crude: an O_EXCL file that goes stale on
 * a timer. A crashed process leaves a lock behind; we break it after STALE_MS
 * rather than tracking liveness, because the cost of being wrong is a duplicate
 * POST, not corrupted data.
 */

import { writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.mjs";

/** A lock older than this is assumed abandoned. Longer than any real ship. */
export const STALE_MS = 120_000;

function lockPath(key) {
  return join(STATE_DIR, encodeURIComponent(key) + ".lock");
}

/**
 * Try to take the lock. Returns the path on success, null if someone else holds
 * it. Never throws — an unwritable state dir means "don't lock", not "crash".
 */
export function acquire(key, now = Date.now()) {
  const path = lockPath(key);
  try {
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return path;
  } catch (err) {
    if (err?.code !== "EEXIST") return null;
  }

  // Held. Break it only if it's older than a plausible ship.
  try {
    const stat = statSync(path);
    if (now - stat.mtimeMs < STALE_MS) return null;
    unlinkSync(path);
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return path;
  } catch {
    return null; // lost the race to break it — fine, skip this stream
  }
}

/** Drop the lock. Idempotent; safe to call on a path that's already gone. */
export function release(path) {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // already released or never existed
  }
}
