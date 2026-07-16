#!/usr/bin/env node
/**
 * One-time (background) quality backfill, kicked off by brain-setup. It fills the "before"
 * side of the friction trend from the person's session history — WITHOUT any model call, so
 * it costs no Claude quota. For every settled main transcript it computes the deterministic
 * quality (friction, corrections, turns, tool-calls) plus used/saved from the current brain,
 * and pushes ONLY quality up (no pages). The distill daemon then handles pages + quality for
 * sessions going forward; the push endpoint's idempotent (org, session_id) upsert makes any
 * overlap harmless.
 *
 * Bounded to the most recent MAX_SESSIONS so a laptop with years of history doesn't hammer
 * the endpoint; the ledger stops it re-pushing on a re-run.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, CALIBER_DIR } from "../lib/config.mjs";
import { listMainTranscripts } from "../lib/discover.mjs";
import { sessionQuality } from "../lib/quality.mjs";
import { sessionValue } from "../lib/value.mjs";
import { BRAIN_DIR, pushBrain } from "../lib/brain.mjs";

const DISTILL_STATE = join(CALIBER_DIR, "distill-state");
const LEDGER = join(DISTILL_STATE, "ledger.json");
const LOG = join(CALIBER_DIR, "capture.log");
const SETTLE_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 500;

function log(msg, extra) {
  try {
    mkdirSync(CALIBER_DIR, { recursive: true });
    writeFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), src: "backfill-quality", msg, ...extra }) + "\n", { flag: "a" });
  } catch { /* ignore */ }
}
function readLedger() { try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return {}; } }
function writeLedger(l) { try { mkdirSync(DISTILL_STATE, { recursive: true }); writeFileSync(LEDGER, JSON.stringify(l)); } catch { /* ignore */ } }

function parseLines(path) {
  const out = [];
  let txt;
  try { txt = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o === "object") out.push(o); } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const config = loadConfig();
  if (!config) return;
  const now = Date.now();
  const ledger = readLedger();

  const sessions = listMainTranscripts()
    .filter((s) => now - s.mtimeMs >= SETTLE_MS)
    .filter((s) => (ledger[s.key]?.qualityMtime ?? 0) < s.mtimeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SESSIONS);

  let pushed = 0;
  for (const s of sessions) {
    const lines = parseLines(s.path);
    if (!lines.length) { ledger[s.key] = { ...ledger[s.key], qualityMtime: s.mtimeMs }; continue; }
    const quality = sessionQuality(lines);
    const v = sessionValue(s.path, BRAIN_DIR);
    quality.brainPagesUsed = v.used.length;
    quality.callsSaved = v.calls_saved;
    const res = await pushBrain(config, { sessionId: s.sessionId, pages: [], retires: [], quality });
    if (res) { pushed++; ledger[s.key] = { ...ledger[s.key], qualityMtime: s.mtimeMs }; writeLedger(ledger); }
  }
  log("backfill complete", { candidates: sessions.length, pushed });
}

main().catch((e) => { log("backfill threw", { error: String(e) }); process.exit(0); });
