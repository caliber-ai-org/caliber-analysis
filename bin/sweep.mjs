#!/usr/bin/env node
/**
 * The sweeper — runs every 5 minutes, ships whatever the Stop hook missed.
 *
 * The Stop hook alone is not enough. It only fires when a turn ends, so:
 *   - a long-running turn ships nothing until it finishes,
 *   - a session that crashes or is abandoned mid-turn loses its tail,
 *   - subagent transcripts (a separate temp file) are never read at all,
 *   - and nothing that predates the install is ever captured.
 *
 * This closes all four. It walks every transcript on disk — main threads AND
 * subagent task files — and ships anything past its watermark, reusing shipFile()
 * so batching, redaction, and the 2xx-gated watermark are identical to the hook's.
 *
 * RACING THE STOP HOOK IS SAFE. Both may ship the same lines; the server dedupes
 * on (org, session, message_uuid), so a duplicate POST stores nothing. The locks
 * below exist only to avoid wasting the upload. Correctness never depends on them.
 *
 * Modes:
 *   sweep.mjs                       full sweep (the timer)
 *   sweep.mjs --session <id> --tasks-only
 *                                   just this session's subagent files — called by
 *                                   the Stop hook while the temp dir still exists
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, STATE_DIR, CALIBER_DIR } from "../lib/config.mjs";
import { shipFile, statePathFor, readOffset, logLine, argOf } from "../lib/ship.mjs";
import { discoverAll, listAgentTranscripts } from "../lib/discover.mjs";
import { acquire, release } from "../lib/locks.mjs";
import { makeRepoResolver } from "../lib/repo.mjs";

/**
 * Per-run budget. A first run on a laptop with years of history has ~450MB to
 * upload; sending it in one burst would hammer the ingest endpoint (rate-limited
 * at 120 req/min/org) and saturate the user's uplink. Bounded like this, a full
 * backfill drains over a couple of hours in the background and nobody notices.
 */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 40;
const MAX_WALL_MS = 90_000;

/** Files touched this recently are "live" and get shipped before any backfill. */
const RECENT_MS = 24 * 60 * 60 * 1000;

const SWEEP_STATE = join(CALIBER_DIR, "sweep-state.json");

/** Same log file and envelope as the Stop-hook shipper — one place to look. */
function log(entry) {
  logLine({ sweep: true, ...entry });
}

function readState() {
  try {
    return JSON.parse(readFileSync(SWEEP_STATE, "utf8"));
  } catch {
    return { backfillDone: false };
  }
}

function writeState(state) {
  try {
    mkdirSync(CALIBER_DIR, { recursive: true });
    writeFileSync(SWEEP_STATE, JSON.stringify(state));
  } catch {
    // a lost cursor just means we re-scan next run — harmless
  }
}

/** Streams with unshipped bytes — the watermark vs. the size discovery already stat'd. */
function pending(streams) {
  return streams.filter((s) => {
    const offset = readOffset(statePathFor(s.key));
    // A file smaller than its watermark was rotated/truncated → re-ship from 0.
    return s.size !== offset;
  });
}

/**
 * A run's budget. Shared across BOTH passes (live, then backfill) — a per-pass
 * budget would let one run ship twice the cap, which is exactly the burst this
 * is here to prevent.
 */
function newBudget() {
  return { startedAt: Date.now(), files: 0, bytes: 0, shipped: 0, deferred: 0, halted: false };
}

function exhausted(budget) {
  return (
    budget.halted ||
    budget.files >= MAX_FILES ||
    budget.bytes >= MAX_BYTES ||
    Date.now() - budget.startedAt > MAX_WALL_MS
  );
}

async function shipEach(config, streams, budget, repoFor) {
  let handled = 0;
  for (const stream of streams) {
    if (exhausted(budget)) {
      budget.deferred += streams.length - handled;
      return;
    }
    handled += 1;
    const lock = acquire(stream.key);
    if (!lock) continue; // the Stop hook has it — it'll ship; we'd only duplicate
    try {
      const result = await shipFile(config, stream, repoFor);
      budget.files += 1;
      budget.bytes += result.bytes;
      budget.shipped += result.shipped;
      // A failed POST means the endpoint is down or we're rate-limited. Pushing
      // the rest of the queue at it now would only make that worse.
      if (result.error) {
        budget.halted = true;
        budget.deferred += streams.length - handled;
        return;
      }
    } finally {
      release(lock);
    }
  }
}

async function main() {
  const config = loadConfig();
  if (!config) return; // not onboarded / opted out → silent, always

  mkdirSync(STATE_DIR, { recursive: true });

  // Stop-hook mode: capture THIS session's subagent runs as soon as the turn ends,
  // rather than waiting up to 5 minutes for the timer. They're durable on disk, so
  // this is about latency, not about racing a cleanup.
  const repoFor = makeRepoResolver();
  const only = argOf("--session");
  if (only && process.argv.includes("--tasks-only")) {
    const streams = pending(listAgentTranscripts().filter((s) => s.sessionId === only));
    if (streams.length === 0) return;
    const budget = newBudget();
    await shipEach(config, streams, budget, repoFor);
    if (budget.shipped > 0) {
      log({ mode: "tasks", session: only, files: budget.files, shipped: budget.shipped });
    }
    return;
  }

  // Only one sweeper at a time. A second one would just contend for the same
  // per-stream locks and re-read the same files.
  const sweepLock = acquire("_sweeper");
  if (!sweepLock) return;

  try {
    const budget = newBudget();
    const state = readState();
    // discoverAll(), not a hand-rolled concat: it carries the try/catch that keeps
    // a moved/missing subagent temp dir from taking main-thread capture down with it.
    const all = discoverAll();
    const now = Date.now();

    // Live work first, always. A backfill of years of history must never starve
    // the session the user is sitting in right now.
    const recent = pending(all.filter((s) => now - s.mtimeMs <= RECENT_MS)).sort(
      (a, b) => b.mtimeMs - a.mtimeMs,
    );
    await shipEach(config, recent, budget, repoFor);

    // Then backfill, oldest first, sharing the same budget — so a run can never
    // exceed the cap by doing both passes.
    const older = state.backfillDone
      ? []
      : pending(all.filter((s) => now - s.mtimeMs > RECENT_MS)).sort(
          (a, b) => a.mtimeMs - b.mtimeMs,
        );

    await shipEach(config, older, budget, repoFor);

    // Backfill is done once nothing old has unshipped bytes AND we weren't cut
    // short by the budget (otherwise "empty" just means "we stopped early").
    const backfillDone = state.backfillDone || (older.length === 0 && !exhausted(budget));
    if (backfillDone && !state.backfillDone) log({ backfill: "complete" });

    if (budget.shipped > 0 || budget.deferred > 0) {
      // Never let a bounded run read as "captured everything" — say what we left.
      log({
        files: budget.files,
        shipped: budget.shipped,
        bytes: budget.bytes,
        deferred: budget.deferred,
        backfillPending: !backfillDone,
      });
    }
    writeState({
      ...state,
      backfillDone,
      ...(backfillDone && !state.backfillDone
        ? { backfillCompletedAt: new Date().toISOString() }
        : {}),
      lastRunAt: new Date().toISOString(),
    });
  } finally {
    release(sweepLock);
  }
}

main()
  .catch((err) => log({ ok: false, fatal: String(err?.message || err) }))
  .finally(() => process.exit(0)); // never surface a non-zero exit to a scheduler
