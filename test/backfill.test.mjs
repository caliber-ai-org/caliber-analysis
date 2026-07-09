/**
 * Unit tests for the one-time historical backfill (discover last-week
 * transcripts, gate on the marker, ship via the shared shipper).
 *
 * Run: node --test test/backfill.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listRecentTranscripts,
  claimBackfill,
  runBackfill,
  BACKFILL_WINDOW_MS,
  BACKFILL_LOCK_STALE_MS,
} from "../lib/backfill.mjs";

const TEST_CONFIG = { endpoint: "http://x", email: "a@b.c", token: "t" };

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "caliber-backfill-"));
}

function touchMtime(path, mtimeMs) {
  utimesSync(path, new Date(), new Date(mtimeMs));
}

test("listRecentTranscripts finds top-level jsonl within the window, skips old + nested", () => {
  const root = tmpRoot();
  const proj = join(root, "-Users-me-app");
  const nested = join(proj, "sess-nested", "subagents");
  mkdirSync(nested, { recursive: true });

  const now = Date.now();
  const recent = join(proj, "sess-recent.jsonl");
  const old = join(proj, "sess-old.jsonl");
  const sub = join(nested, "agent-abc.jsonl");
  writeFileSync(recent, '{"uuid":"u1"}\n');
  writeFileSync(old, '{"uuid":"u2"}\n');
  writeFileSync(sub, '{"uuid":"u3"}\n');

  touchMtime(recent, now - 2 * 24 * 60 * 60 * 1000);
  touchMtime(old, now - 10 * 24 * 60 * 60 * 1000);
  touchMtime(sub, now - 1 * 24 * 60 * 60 * 1000);

  const found = listRecentTranscripts(root, now, BACKFILL_WINDOW_MS);
  assert.equal(found.length, 1);
  assert.equal(found[0].sessionId, "sess-recent");
  assert.equal(found[0].path, recent);
});

test("listRecentTranscripts sorts oldest-first and returns empty when projects dir missing", () => {
  const root = tmpRoot();
  const proj = join(root, "-proj");
  mkdirSync(proj, { recursive: true });
  const now = Date.now();
  const a = join(proj, "a.jsonl");
  const b = join(proj, "b.jsonl");
  writeFileSync(a, "{}\n");
  writeFileSync(b, "{}\n");
  touchMtime(a, now - 1000);
  touchMtime(b, now - 5000);

  const found = listRecentTranscripts(root, now);
  assert.deepEqual(
    found.map((f) => f.sessionId),
    ["b", "a"],
  );
  assert.deepEqual(listRecentTranscripts(join(root, "nope"), now), []);
});

test("claimBackfill: missing → yes; done → no; fresh lock → no; stale lock → yes", () => {
  const root = tmpRoot();
  const marker = join(root, "_backfill.json");
  const now = Date.now();

  assert.equal(claimBackfill(now, marker), true);
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).status, "in_progress");
  assert.equal(claimBackfill(now + 1000, marker), false);

  writeFileSync(marker, JSON.stringify({ status: "done", completedAt: new Date(now).toISOString() }));
  assert.equal(claimBackfill(now, marker), false);

  writeFileSync(
    marker,
    JSON.stringify({
      status: "in_progress",
      startedAt: new Date(now - BACKFILL_LOCK_STALE_MS - 1000).toISOString(),
    }),
  );
  assert.equal(claimBackfill(now, marker), true);
});

test("runBackfill ships each recent transcript once and writes a done marker", async () => {
  const root = tmpRoot();
  const proj = join(root, "-proj");
  mkdirSync(proj, { recursive: true });
  const marker = join(root, "_backfill.json");
  const now = Date.now();

  const t1 = join(proj, "s1.jsonl");
  const t2 = join(proj, "s2.jsonl");
  writeFileSync(t1, '{"uuid":"u1"}\n');
  writeFileSync(t2, '{"uuid":"u2"}\n');
  touchMtime(t1, now - 1000);
  touchMtime(t2, now - 2000);

  const calls = [];
  const shipOne = async (_cfg, path, sessionId) => {
    calls.push({ path, sessionId });
    return { shipped: 3, lastError: null };
  };

  const res = await runBackfill({
    config: TEST_CONFIG,
    now,
    projectsDir: root,
    markerPath: marker,
    shipOne,
  });

  assert.equal(res.ok, true);
  assert.equal(res.sessions, 2);
  assert.equal(res.shipped, 6);
  assert.equal(res.errors, 0);
  assert.deepEqual(
    calls.map((c) => c.sessionId),
    ["s2", "s1"],
  );

  const markerBody = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(markerBody.status, "done");
  assert.equal(markerBody.sessions, 2);
  assert.equal(markerBody.shipped, 6);

  const again = await runBackfill({
    config: TEST_CONFIG,
    now,
    projectsDir: root,
    markerPath: marker,
    shipOne,
  });
  assert.equal(again.reason, "skip");
  assert.equal(calls.length, 2);
});

test("runBackfill records per-session errors but still marks done", async () => {
  const root = tmpRoot();
  const proj = join(root, "-proj");
  mkdirSync(proj, { recursive: true });
  const marker = join(root, "_backfill.json");
  const now = Date.now();
  const t1 = join(proj, "s1.jsonl");
  writeFileSync(t1, '{"uuid":"u1"}\n');
  touchMtime(t1, now - 1000);

  const res = await runBackfill({
    config: TEST_CONFIG,
    now,
    projectsDir: root,
    markerPath: marker,
    shipOne: async () => {
      throw new Error("boom");
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.errors, 1);
  assert.equal(res.sessions, 1);
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).status, "done");
});

test("runBackfill skips when config is missing", async () => {
  const res = await runBackfill({ config: null });
  assert.equal(res.reason, "no-config");
});
