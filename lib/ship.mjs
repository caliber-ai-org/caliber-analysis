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
import { join } from "node:path";
import { loadConfig, STATE_DIR, CAPTURE_LOG } from "./config.mjs";
import { sliceCompleteLines, parseLines, mapLines } from "./transcript.mjs";

const MAX_BATCH = 2000; // well under the server's per-request cap
const POST_TIMEOUT_MS = 4000;
const MAX_ITERATIONS = 100; // backlog-drain guard (≤200k lines/run)

function logLine(entry) {
  try {
    appendFileSync(CAPTURE_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // logging must never throw into the worker
  }
}

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function statePathFor(sessionId) {
  return join(STATE_DIR, encodeURIComponent(sessionId) + ".json");
}

function readOffset(statePath) {
  try {
    const v = JSON.parse(readFileSync(statePath, "utf8")).offset;
    return Number.isInteger(v) && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
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
export async function shipFromBuffer(buf, startOffset, sessionId, post) {
  let offset = buf.length < startOffset ? 0 : startOffset; // file rotated → re-ship
  let shipped = 0;
  for (let i = 0; i < MAX_ITERATIONS && offset < buf.length; i++) {
    const { lines, consumedBytes } = sliceCompleteLines(
      buf.subarray(offset).toString("utf8"),
      MAX_BATCH,
    );
    if (lines.length === 0) break; // only a partial trailing line so far
    const messages = mapLines(parseLines(lines), sessionId);
    if (messages.length > 0) {
      const result = await post(messages);
      if (!result.ok) return { offset, shipped, lastError: result }; // retry next turn
      shipped += messages.length;
    }
    offset += consumedBytes;
  }
  return { offset, shipped, lastError: null };
}

async function main() {
  const config = loadConfig();
  if (!config) process.exit(0); // not onboarded / opted out → silent

  const transcriptPath = argOf("--transcript");
  const sessionId = argOf("--session");
  if (!transcriptPath || !sessionId || !existsSync(transcriptPath)) process.exit(0);

  mkdirSync(STATE_DIR, { recursive: true });
  const statePath = statePathFor(sessionId);
  const startOffset = readOffset(statePath);

  const buf = readFileSync(transcriptPath);
  if (buf.length === startOffset) process.exit(0); // nothing new (the common case)

  const { offset, shipped, lastError } = await shipFromBuffer(
    buf,
    startOffset,
    sessionId,
    (messages) => postBatch(config, messages),
  );

  if (offset !== startOffset) writeFileSync(statePath, JSON.stringify({ offset }));
  if (shipped > 0) logLine({ ok: true, session: sessionId, shipped, offset });
  if (lastError) logLine({ ok: false, session: sessionId, error: lastError });

  process.exit(0);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("ship.mjs")) {
  main().catch((err) => {
    logLine({ ok: false, fatal: String(err?.message || err) });
    process.exit(0); // never surface a non-zero exit to the hook chain
  });
}
