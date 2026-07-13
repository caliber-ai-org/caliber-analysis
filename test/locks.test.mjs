/**
 * Locks — the sweeper's bandwidth optimization.
 *
 * Worth restating, because it's the property that makes the whole design safe:
 * these locks are NOT what keeps the data correct. The server dedupes on
 * (org, session, message_uuid), so two processes shipping the same lines store
 * one copy. If every lock in here silently failed, we'd waste uploads and lose
 * nothing. That's why breaking a stale lock is safe, and why "couldn't lock"
 * always means "skip", never "retry until you can".
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { acquire, release, STALE_MS } from "../lib/locks.mjs";
import { STATE_DIR } from "../lib/config.mjs";

// The lock dir is derived from the real ~/.caliber path; make sure it exists and
// clean up only the keys this test creates.
const KEY = "test-lock-key";

beforeEach(() => {
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  const path = `${STATE_DIR}/${encodeURIComponent(KEY)}.lock`;
  rmSync(path, { force: true });
});

describe("locks", () => {
  test("first caller gets the lock, second is turned away", () => {
    const first = acquire(KEY);
    assert.ok(first, "first acquire should succeed");
    assert.equal(acquire(KEY), null, "a held lock must not be handed out twice");
    release(first);
  });

  test("releasing lets the next caller in", () => {
    const first = acquire(KEY);
    release(first);
    const second = acquire(KEY);
    assert.ok(second, "lock should be free after release");
    release(second);
  });

  test("breaks a lock left behind by a crashed process", () => {
    const held = acquire(KEY);
    assert.ok(held);

    // Same key, but far enough in the future that the existing lock is stale.
    // A crashed shipper must not wedge a stream forever.
    const later = acquire(KEY, Date.now() + STALE_MS + 1000);
    assert.ok(later, "a stale lock must be breakable");
    release(later);
  });

  test("release is idempotent and never throws on a missing file", () => {
    const path = acquire(KEY);
    release(path);
    assert.doesNotThrow(() => release(path));
    assert.doesNotThrow(() => release(null));
    assert.equal(existsSync(path), false);
  });
});
