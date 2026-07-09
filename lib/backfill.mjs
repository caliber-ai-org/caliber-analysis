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
 * Exposes listRecentTranscripts / claimBackfill / runBackfill for tests.
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
import { loadConfig, STATE_DIR, CAPTURE_LOG } from "./config.mjs";
import { shipTranscriptFile } from "./ship.mjs";
import { makeRepoResolver } from "./repo.mjs";

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

function isFreshLock(marker, now) {
  if (!marker || marker.status !== "in_progress") return false;
  const started = Date.parse(marker.startedAt || "");
  return Number.isFinite(started) && now - started < BACKFILL_LOCK_STALE_MS;
}

/**
 * Best-effort claim of the backfill lock. Returns true when this caller should
 * run the pass. Not atomic across processes — duplicate workers are harmless
 * because per-session watermarks make re-ships no-ops.
 */
export function claimBackfill(now = Date.now(), markerPath = BACKFILL_MARKER) {
  const marker = readMarker(markerPath);
  if (marker?.status === "done" || isFreshLock(marker, now)) return false;
  writeMarker({ status: "in_progress", startedAt: new Date(now).toISOString() }, markerPath);
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
    // Missing/unreadable projects dir — Claude Code never used, or best-effort skip.
    return out;
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
      out.push({ path, sessionId, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

/**
 * Run one backfill pass. Claims the lock, ships recent transcripts, marks done.
 * `shipOne` is injectable so unit tests don't hit the network.
 */
export async function runBackfill({
  config,
  now = Date.now(),
  windowMs = BACKFILL_WINDOW_MS,
  projectsDir = PROJECTS_DIR,
  markerPath = BACKFILL_MARKER,
  shipOne,
} = {}) {
  if (!config) return { ok: false, reason: "no-config" };
  if (!claimBackfill(now, markerPath)) return { ok: false, reason: "skip" };

  const startedAt = new Date(now).toISOString();
  const transcripts = listRecentTranscripts(projectsDir, now, windowMs);
  // One resolver for the whole pass — cwd→repo lookups memoize across sessions.
  if (!shipOne) {
    const repoFor = makeRepoResolver();
    shipOne = (cfg, path, sessionId) => shipTranscriptFile(cfg, path, sessionId, { repoFor });
  }
  let shipped = 0;
  let errors = 0;

  for (const t of transcripts) {
    try {
      const result = await shipOne(config, t.path, t.sessionId);
      shipped += result.shipped || 0;
      if (result.lastError) errors += 1;
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
  // failed offsets, and the live Stop hook will finish those.
  writeMarker(
    {
      status: "done",
      startedAt,
      completedAt: new Date().toISOString(),
      sessions: transcripts.length,
      shipped,
      errors,
    },
    markerPath,
  );

  logLine({
    ok: errors === 0,
    backfill: true,
    sessions: transcripts.length,
    shipped,
    errors,
  });

  return { ok: true, sessions: transcripts.length, shipped, errors };
}

async function main() {
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
