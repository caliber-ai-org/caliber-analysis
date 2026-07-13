#!/usr/bin/env node
/**
 * Transcript shipper — the detached worker the Stop hook spawns.
 *
 * Reads the session transcript past a per-session byte watermark, maps + redacts
 * the new lines, and POSTs them to the platform. The watermark advances ONLY on
 * a 2xx, so a failed ship is simply re-sent next turn; the server dedupes on
 * (org, session, message_uuid), making the whole pipeline at-least-once and
 * idempotent. Runs detached from Claude Code — its latency never touches a turn.
 *
 * Invoked as: node ship.mjs --transcript <jsonl-path> --session <session-id>
 * Exposes shipFromBuffer() so the unit tests can drive the batching logic.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { loadConfig, STATE_DIR, CAPTURE_LOG, CAPTURE_EPOCH } from "./config.mjs";
import { sliceCompleteLines, parseLines, mapLines } from "./transcript.mjs";
import { makeRepoResolver } from "./repo.mjs";
import { streamKey, legacyStreamKey } from "./discover.mjs";

const MAX_BATCH = 2000; // well under the server's per-request cap
/**
 * Byte ceiling for one POST. The line cap alone is not enough: 2,000 lines of a
 * transcript heavy with assistant messages is ~5.5MB, which cannot be uploaded and
 * ingested inside POST_TIMEOUT_MS — so the biggest sessions (the ones with the most
 * history to recover) timed out on every attempt and never shipped a byte.
 */
const MAX_BATCH_BYTES = 1024 * 1024;
/**
 * How long to wait for one POST. Generous ON PURPOSE.
 *
 * This was 4s, which protected nothing: the Stop hook spawns this shipper DETACHED
 * and unref'd and exits immediately (see bin/on-stop.mjs), and the sweeper runs from
 * launchd/systemd/schtasks. Nothing that ships is on a turn's critical path, so a
 * short timeout bought no responsiveness — it only decided whether a batch that was
 * ALREADY uploading got killed.
 *
 * And it killed real ones. A 1MB batch inside 4s needs ~250KB/s sustained, INCLUDING
 * the server's ingest time — so on a corporate or otherwise slow uplink the same
 * batch times out on every attempt, forever, and that machine's history never
 * recovers. Aborting also wastes the upload that was in flight; the server may well
 * have committed it (an aborted client does not roll back a transaction), so the
 * retry re-sends bytes that already landed. Idempotent, but pure waste.
 *
 * 30s is still well inside the sweeper's 90s per-run wall budget, so a genuinely
 * stuck POST costs at most a third of one run and is retried on the next.
 */
const POST_TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 100; // backlog-drain guard (≤200k lines/run)

export function logLine(entry) {
  try {
    appendFileSync(CAPTURE_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // logging must never throw into the worker
  }
}

export function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

export function statePathFor(key) {
  return join(STATE_DIR, encodeURIComponent(key) + ".json");
}

/**
 * Where to resume shipping this stream — 0 when the stream must be RE-CAPTURED.
 *
 * A watermark written by an older capture epoch is not trustworthy: it says the
 * file was shipped, but not that it was shipped correctly (epoch 2 exists because
 * ingest was dropping 19–57% of every file's lines). Returning 0 makes the next run
 * re-read the file from the start, which is the only way lines already past the
 * watermark are ever recovered.
 *
 * It fires exactly ONCE per stream: the new epoch is stamped by writeOffset as soon
 * as the re-ship makes any progress, so the following run resumes from the advancing
 * offset instead of starting over. If the re-ship makes NO progress (the server is
 * down), nothing is written, the old epoch survives, and it is simply retried — so
 * an interrupted recapture converges rather than looping from zero forever.
 */
export function readOffset(statePath) {
  try {
    const { offset, epoch } = JSON.parse(readFileSync(statePath, "utf8"));
    if (epoch !== CAPTURE_EPOCH) return 0; // stale epoch (or none) → re-capture
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export function writeOffset(statePath, offset) {
  writeFileSync(statePath, JSON.stringify({ offset, epoch: CAPTURE_EPOCH }));
}

async function postBatch(config, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.endpoint}/api/ingest/claude-code/transcript`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ email: config.email, messages }),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drains a transcript buffer from `startOffset`, shipping in capped batches via
 * `post(messages)`. Returns the new offset (advanced only over shipped bytes).
 * Pure except for `post` — the unit tests pass a fake.
 */
export async function shipFromBuffer(buf, startOffset, sessionId, post, repoFor = () => null) {
  let offset = buf.length < startOffset ? 0 : startOffset; // file rotated → re-ship
  let shipped = 0;
  for (let i = 0; i < MAX_ITERATIONS && offset < buf.length; i++) {
    const { lines, offsets, consumedBytes } = sliceCompleteLines(
      buf.subarray(offset).toString("utf8"),
      MAX_BATCH,
      MAX_BATCH_BYTES,
    );
    if (lines.length === 0) break; // only a partial trailing line so far
    // `offset` is where this chunk starts in the file, so chunk-relative offsets
    // become absolute file offsets — the total order a restore needs.
    const messages = mapLines(parseLines(lines, offsets, offset), sessionId, repoFor);
    if (messages.length > 0) {
      const result = await post(messages);
      if (!result.ok) return { offset, shipped, lastError: result }; // retry next turn
      shipped += messages.length;
    }
    offset += consumedBytes;
  }
  return { offset, shipped, lastError: null };
}

/**
 * Ship one transcript file past its watermark. The single code path used by BOTH
 * the Stop hook (one session, now) and the sweeper (every stream on disk), so the
 * two cannot drift in how they batch, redact, or advance the watermark.
 *
 * `key` names the byte stream, not the session: a session's main transcript and
 * each of its subagent files are separate append-only files with separate
 * watermarks. `sessionId` is what the lines are attributed to — several streams
 * can share one.
 *
 * Returns { shipped, bytes, error } — bytes is what this call consumed, which is
 * how the sweeper enforces its budget.
 */
export async function shipFile(
  config,
  { key, legacyKey, path, sessionId },
  repoFor = makeRepoResolver()
) {
  if (!existsSync(path)) return { shipped: 0, bytes: 0, error: null };

  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = statePathFor(key);

  // Adopt the pre-streamKey watermark once, if this stream has no new-key state yet.
  // Without this, correcting the key would look exactly like "never shipped" and
  // every laptop would re-send its entire history a second time. A legacy watermark
  // that overshoots the file (the clobbered-by-a-worktree-stub case that forced the
  // key change) is handled downstream: shipFromBuffer treats offset > size as a
  // rotated file and re-ships from 0.
  let startOffset = readOffset(statePath);
  let adopted = false;
  if (legacyKey && !existsSync(statePath)) {
    const legacy = readOffset(statePathFor(legacyKey));
    // Only a REAL legacy watermark is worth migrating. Treating "no legacy state" as
    // an adoption would persist offset 0 on a failed first ship, turning "nothing was
    // written, so retry from the start" into a written watermark — a distinction the
    // 500-path depends on.
    if (legacy > 0) {
      startOffset = legacy;
      adopted = true;
    }
  }

  const buf = readFileSync(path);
  if (buf.length === startOffset) {
    // Already at EOF. Still persist an ADOPTED watermark: without it the new-key
    // state file never gets written, so this stream looks unshipped on every run and
    // the sweeper re-reads the whole file (68MB, for the biggest) forever.
    if (adopted) writeOffset(statePath, startOffset);
    return { shipped: 0, bytes: 0, error: null }; // the common case
  }

  const { offset, shipped, lastError } = await shipFromBuffer(
    buf,
    startOffset,
    sessionId,
    (messages) => postBatch(config, messages),
    repoFor,
  );

  // Only on a 2xx — a failed ship is simply re-sent next run. This is also what
  // stamps the current epoch, so a re-capture resets a stream exactly once.
  // `adopted` forces the write even when nothing moved, so the migrated watermark
  // lands under the new key instead of being re-derived from the legacy one forever.
  if (offset !== startOffset || adopted) writeOffset(statePath, offset);
  if (shipped > 0) logLine({ ok: true, key, session: sessionId, shipped, offset });
  if (lastError) logLine({ ok: false, key, session: sessionId, error: lastError });

  return { shipped, bytes: Math.max(0, offset - startOffset), error: lastError };
}

async function main() {
  const config = loadConfig();
  if (!config) process.exit(0); // not onboarded / opted out → silent

  const transcriptPath = argOf("--transcript");
  const sessionId = argOf("--session");
  if (!transcriptPath || !sessionId) process.exit(0);

  // The key must identify the FILE. A session resumed in a git worktree gets a
  // transcript with the SAME session id in that worktree's project directory, and
  // keying on the session id alone let those files clobber each other's watermark.
  const project = basename(dirname(transcriptPath));
  await shipFile(config, {
    key: streamKey(project, sessionId),
    legacyKey: legacyStreamKey(sessionId),
    path: transcriptPath,
    sessionId,
  });
  process.exit(0);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("ship.mjs")) {
  main().catch((err) => {
    logLine({ ok: false, fatal: String(err?.message || err) });
    process.exit(0); // never surface a non-zero exit to the hook chain
  });
}
