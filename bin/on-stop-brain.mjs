#!/usr/bin/env node
/**
 * Stop hook (brain) — the end-of-turn line. A Node port of the reference
 * yaniv-wiki/pipeline/turn_report.py. Fires when a turn finishes and emits ONLY what
 * changed since the last turn, as a {"systemMessage"} the user sees (never the model):
 *
 *   🧠 this turn: used fact-cc-schema, skipped 1 MCP call (~$0.09 est)
 *
 * On a turn where the brain did nothing new it prints nothing. It keeps a per-session
 * snapshot of what it has already announced so it speaks the delta, not the whole session
 * each turn. Runs ALONGSIDE the existing shipper Stop hook; both are independent and
 * non-blocking. Always exits 0 — a Stop hook that exits non-zero would block the turn from
 * ending, the opposite of a passive readout.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CALIBER_DIR } from "../lib/config.mjs";
import { sessionValue } from "../lib/value.mjs";
import { BRAIN_DIR } from "../lib/brain.mjs";

const SNAP_DIR = join(CALIBER_DIR, "turn-state");

function snapshot(sid) {
  try {
    return JSON.parse(readFileSync(join(SNAP_DIR, `${sid}.json`), "utf8"));
  } catch {
    return { announced: [] };
  }
}
function save(sid, snap) {
  try {
    mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(join(SNAP_DIR, `${sid}.json`), JSON.stringify(snap));
  } catch {
    /* ignore */
  }
}

const bail = setTimeout(() => process.exit(0), 2000);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  clearTimeout(bail);
  try {
    const input = JSON.parse(raw || "{}");
    const transcript = input.transcript_path || "";
    const sid = input.session_id || "";
    if (!transcript || !sid || !existsSync(transcript)) return process.exit(0);

    const v = sessionValue(transcript, BRAIN_DIR);
    const snap = snapshot(sid);
    const announced = new Set(snap.announced ?? []);
    const fresh = v.facts_substituted.filter((f) => !announced.has(f.page));
    if (fresh.length === 0) return process.exit(0); // nothing new this turn → silent

    const names = fresh.slice(0, 2).map((f) => f.page.replace(/\.md$/, "")).join(", ");
    const n = fresh.length;
    const usd = (v.tokens_saved / 1e6) * 3; // conservative default-model estimate
    const msg = `🧠 this turn: used ${names}, skipped ${n} MCP call${n === 1 ? "" : "s"} (~$${usd.toFixed(2)} est)`;

    save(sid, { announced: [...announced, ...fresh.map((f) => f.page)] });
    process.stdout.write(JSON.stringify({ systemMessage: msg }));
  } catch {
    /* a broken turn line must never disrupt the session */
  }
  process.exit(0);
});
process.stdin.on("error", () => {
  clearTimeout(bail);
  process.exit(0);
});
