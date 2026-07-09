#!/usr/bin/env node
/**
 * One-time historical backfill — ships the last week of local Claude Code
 * transcripts so a freshly installed tenant already has data to analyze.
 *
 * Triggered detached from SessionStart (same fire-and-forget pattern as the
 * Stop shipper). Discovers top-level `*.jsonl` files under
 * `~/.claude/projects/<project>/` whose mtime falls inside the window, then
 * reuses the normal watermarked shipper so already-captured sessions are
 * no-ops and a mid-run failure simply resumes next session. A marker under
 * capture-state records completion (and a short in-progress lock) so we only
 * scan once.
 *
 * Invoked as: node backfill.mjs
 * Exposes listRecentTranscripts / shouldRunBackfill / runBackfill for tests.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, STATE_DIR, CAPTURE_LOG, CALIBER_DIR } from "./config.mjs";
import { shipTranscriptFile } from "./ship.mjs";

export const BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // one week
export const BACKFILL_LOCK_STALE_MS = 30 * 60 * 1000; // abandon a dead lock after 30m
export const BACKFILL_MARKER = join(STATE_DIR, "_backfill.json");
export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

function logLine(entry) {
  try {
    appendFileSync(CAPTURE_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // logging must never throw into the worker
  }
}

function readMarker(path = BACKFILL_MARKER) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeMarker(marker, path = BACKFILL_MARKER) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker));
}

/**
 * True when a backfill pass should start: never completed, and no fresh
 * in-progress lock (stale locks are treated as abandoned).
 */
export function shouldRunBackfill(now = Date.now(), markerPath = BACKFILL_MARKER) {
  const marker = readMarker(markerPath);
  if (!marker) return true;
  if (marker.status === "done") return false;
  if (marker.status === "in_progress") {
    const started = Date.parse(marker.startedAt || "");
    if (Number.isFinite(started) && now - started < BACKFILL_LOCK_STALE_MS) return false;
  }
  return true; // pending, failed, or stale lock → try again
}

/**
 * Atomically (best-effort) claim the backfill lock before spawning the worker.
 * SessionStart calls this so two concurrent sessions don't both kick off a
 * scan. Returns true when this caller owns the pass.
 */
export function claimBackfill(now = Date.now(), markerPath = BACKFILL_MARKER, windowMs = BACKFILL_WINDOW_MS) {
  if (!shouldRunBackfill(now, markerPath)) return false;
  writeMarker(
    {
      status: "in_progress",
      startedAt: new Date(now).toISOString(),
      windowDays: windowMs / (24 * 60 * 60 * 1000),
    },
    markerPath,
  );
  return true;
}

/**
 * Top-level session transcripts under `projectsDir` whose mtime is within the
 * lookback window. Skips nested subagent JSONL (those ride along in the main
 * transcript the same way the Stop hook captures them). Sorted oldest-first.
 */
export function listRecentTranscripts(
  projectsDir = PROJECTS_DIR,
  now = Date.now(),
  windowMs = BACKFILL_WINDOW_MS,
) {
  const cutoff = now - windowMs;
  const out = [];
  let projects;
  try {
    projects = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out; // Claude Code never used on this machine
  }
  for (const ent of projects) {
    if (!ent.isDirectory()) continue;
    const dir = join(projectsDir, ent.name);
    let files;
    try {
      files = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const path = join(dir, f.name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const sessionId = f.name.slice(0, -".jsonl".length);
      if (!sessionId) continue;
      out.push({ path, sessionId, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

/**
 * Run one backfill pass. Returns a summary; never throws. `shipOne` is
 * injectable so unit tests don't hit the network.
 */
export async function runBackfill({
  config,
  now = Date.now(),
  windowMs = BACKFILL_WINDOW_MS,
  projectsDir = PROJECTS_DIR,
  markerPath = BACKFILL_MARKER,
  shipOne = (cfg, path, sessionId) => shipTranscriptFile(cfg, path, sessionId),
  /** When true (CLI entry), claim the lock here. SessionStart claims before spawn. */
  claim = true,
} = {}) {
  if (!config) return { ok: false, reason: "no-config" };

  const existing = readMarker(markerPath);
  let startedAt = existing?.startedAt || new Date(now).toISOString();

  if (claim) {
    // Direct CLI / test path: claim unless a fresh lock already belongs to us
    // (SessionStart wrote it moments ago) or a prior pass finished.
    if (existing?.status === "done") return { ok: false, reason: "skip" };
    const freshLock =
      existing?.status === "in_progress" &&
      Number.isFinite(Date.parse(existing.startedAt || "")) &&
      now - Date.parse(existing.startedAt) < BACKFILL_LOCK_STALE_MS;
    if (!freshLock) {
      if (!claimBackfill(now, markerPath, windowMs)) return { ok: false, reason: "skip" };
      startedAt = new Date(now).toISOString();
    }
  } else if (existing?.status === "done") {
    return { ok: false, reason: "skip" };
  }

  const transcripts = listRecentTranscripts(projectsDir, now, windowMs);
  let sessions = 0;
  let shipped = 0;
  let errors = 0;

  for (const t of transcripts) {
    try {
      const result = await shipOne(config, t.path, t.sessionId);
      sessions += 1;
      shipped += result?.shipped || 0;
      if (result?.lastError) errors += 1;
    } catch (err) {
      errors += 1;
      logLine({
        ok: false,
        backfill: true,
        session: t.sessionId,
        error: String(err?.message || err),
      });
    }
  }

  // Mark done even when some sessions errored — per-session watermarks hold
  // failed offsets, and the live Stop hook will finish those. Re-scanning the
  // whole tree every SessionStart would be wasteful once we've walked it once.
  const completedAt = new Date().toISOString();
  writeMarker(
    {
      status: "done",
      startedAt,
      completedAt,
      windowDays: windowMs / (24 * 60 * 60 * 1000),
      sessions,
      shipped,
      errors,
    },
    markerPath,
  );

  logLine({
    ok: errors === 0,
    backfill: true,
    sessions,
    shipped,
    errors,
    considered: transcripts.length,
  });

  return { ok: true, sessions, shipped, errors, considered: transcripts.length };
}

async function main() {
  // Ensure ~/.caliber exists even before loadConfig (marker writes need it).
  try {
    mkdirSync(CALIBER_DIR, { recursive: true });
  } catch {
    // ignore
  }
  const config = loadConfig();
  if (!config) process.exit(0);
  await runBackfill({ config });
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("backfill.mjs")) {
  main().catch((err) => {
    logLine({ ok: false, backfill: true, fatal: String(err?.message || err) });
    process.exit(0);
  });
}
