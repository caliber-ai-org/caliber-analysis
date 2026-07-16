#!/usr/bin/env node
/**
 * The on-laptop distiller daemon. Installed by `brain-setup`, runs ~every 15 min on the OS
 * scheduler. Off the session hot path, robust to how a session ended (it reads settled
 * transcripts off disk — window-close and Ctrl+C included), and bounded so it never bursts
 * the user's Claude quota.
 *
 * For each SETTLED main session past the ledger it computes quality (always, deterministic)
 * and — if the gate passes and the session is post-activation — spends ONE `claude -p` call
 * to distill it, writes the pages into the local brain, and pushes pages + quality up.
 *
 * RUNAWAY BOUNDS: own lock (long stale) so two daemon ticks can't overlap `claude -p`;
 * MAX_PER_RUN model calls per tick; MAX_PER_HOUR in llm.mjs; distill only main transcripts;
 * ledger so each session is distilled once; the gate + sentinel so it never distills itself.
 */
import { openSync, closeSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync, rmSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, CALIBER_DIR } from "../lib/config.mjs";
import { listMainTranscripts } from "../lib/discover.mjs";
import { extractEvidence } from "../lib/extract.mjs";
import { verdict } from "../lib/gate.mjs";
import { sessionQuality } from "../lib/quality.mjs";
import { applyPlan } from "../lib/apply.mjs";
import { buildDistillPrompt, DISTILL_SCHEMA } from "../lib/distiller.mjs";
import { ask, RateLimited, LLMError } from "../lib/llm.mjs";
import { readLocalPages, mergePages, writeLocalBrain } from "../lib/store.mjs";
import { sessionValue } from "../lib/value.mjs";
import { BRAIN_DIR, pushBrain, pullBrain, activateBrain, brainActivatedAt, noteLocalPages } from "../lib/brain.mjs";

const DISTILL_STATE = join(CALIBER_DIR, "distill-state");
const LEDGER = join(DISTILL_STATE, "ledger.json");
const LOCK = join(DISTILL_STATE, ".distiller.lock");
const LOG = join(CALIBER_DIR, "capture.log");

const SETTLE_MS = 15 * 60 * 1000;     // a transcript idle this long is "complete"
const LOCK_STALE_MS = 20 * 60 * 1000; // > max distill wall budget, so ticks can't overlap
const MAX_PER_RUN = 3;                // model calls per tick (MAX_PER_HOUR is the hourly cap)
const MAX_RELEVANT_PAGES = 40;
const MAX_RELEVANT_CHARS = 40_000;

function log(msg, extra) {
  try {
    mkdirSync(CALIBER_DIR, { recursive: true });
    writeFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), src: "distill", msg, ...extra }) + "\n", { flag: "a" });
  } catch {
    /* ignore */
  }
}

function acquireLock() {
  mkdirSync(DISTILL_STATE, { recursive: true });
  try {
    const fd = openSync(LOCK, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(LOCK);
        const fd = openSync(LOCK, "wx");
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        return true;
      }
    } catch {
      /* someone else took it */
    }
    return false;
  }
}
function releaseLock() {
  try { rmSync(LOCK); } catch { /* ignore */ }
}

function readLedger() {
  try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return {}; }
}
function writeLedger(l) {
  try { writeFileSync(LEDGER, JSON.stringify(l)); } catch { /* ignore */ }
}

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

/** Cheap sentinel skip: a distiller's own child transcript starts with the internal marker. */
function isDistillerChild(path) {
  try {
    const head = readFileSync(path, "utf8").slice(0, 4000);
    return head.includes("[[CALIBER-BRAIN-INTERNAL");
  } catch {
    return false;
  }
}

function buildIndex(pages) {
  if (!pages.length) return "(the brain is empty — this is the person's first learning)";
  return pages.map((p) => `- ${p.slug} · ${p.pageClass} · ${p.scope}${p.repo ? `:${p.repo}` : ""} · ${p.description}`).join("\n");
}
function buildRelevant(pages, repo) {
  const ranked = [...pages].sort((a, b) => {
    const rank = (p) => (p.repo === repo ? 0 : p.scope === "global" ? 1 : 2);
    return rank(a) - rank(b);
  });
  const chunks = [];
  let chars = 0;
  for (const p of ranked.slice(0, MAX_RELEVANT_PAGES)) {
    const chunk = `### ${p.slug} (${p.pageClass})\n${p.description}\n\n${p.body}\n`;
    if (chars + chunk.length > MAX_RELEVANT_CHARS) break;
    chunks.push(chunk);
    chars += chunk.length;
  }
  return chunks.join("\n---\n") || "(no existing pages)";
}
function evidenceText(e) {
  const L = [`human turns: ${e.humanTurns.length}`];
  if (e.corrections.length) {
    L.push(`\nCorrections (${e.corrections.length}):`);
    for (const c of e.corrections.slice(0, 8)) {
      L.push(`- "${c.said.slice(0, 300)}"`);
      if (c.afterClaudeSaid) L.push(`  (Claude had said: ...${c.afterClaudeSaid.slice(-280)})`);
    }
  }
  if (e.interrupts) L.push(`\nInterrupts: ${e.interrupts}`);
  if (e.snapBacks.length) { L.push(`\nSnap-backs (${e.snapBacks.length}):`); for (const s of e.snapBacks.slice(0, 6)) L.push(`- "${s.said.slice(0, 160)}"`); }
  if (e.confirmations.length) { L.push(`\nConfirmations (${e.confirmations.length}):`); for (const c of e.confirmations.slice(0, 6)) L.push(`- "${c.said.slice(0, 200)}"`); }
  const tools = Object.entries(e.toolsUsed).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (tools.length) L.push(`\nTools used: ${tools.map(([t, n]) => `${t}×${n}`).join(", ")}`);
  return L.join("\n");
}

async function main() {
  const config = loadConfig();
  if (!config) return; // not onboarded — stay silent
  if (!acquireLock()) { log("another distiller tick holds the lock; skipping"); return; }

  try {
    let activatedAt = brainActivatedAt();
    if (!activatedAt) {
      // This daemon exists only because setup ran (consent given). If activation never
      // stamped (a transient setup-time failure), heal it: stamp it now (idempotent) and
      // refresh the manifest so brainActivatedAt() picks it up.
      const stamped = await activateBrain(config);
      if (stamped) { await pullBrain(config).catch(() => null); activatedAt = brainActivatedAt() || stamped; }
    }
    if (!activatedAt) { log("brain not activated yet (activation not confirmed); skipping distill"); return; }
    const activatedMs = Date.parse(activatedAt);
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    const ledger = readLedger();
    const candidates = listMainTranscripts()
      .filter((s) => now - s.mtimeMs >= SETTLE_MS)                 // settled
      .filter((s) => s.mtimeMs > activatedMs)                     // forward-only
      .filter((s) => (ledger[s.key]?.distilledMtime ?? 0) < s.mtimeMs) // not done at this mtime
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let calls = 0;
    for (const s of candidates) {
      if (calls >= MAX_PER_RUN) break;
      if (isDistillerChild(s.path)) { ledger[s.key] = { distilledMtime: s.mtimeMs }; continue; }

      const lines = parseLines(s.path);
      if (!lines.length) { ledger[s.key] = { distilledMtime: s.mtimeMs }; continue; }

      const e = extractEvidence(lines);
      const gate = verdict(e);

      // Quality always (fills the trend); used/saved from the local brain dir.
      const quality = sessionQuality(lines);
      const v = sessionValue(s.path, BRAIN_DIR);
      quality.brainPagesUsed = v.used.length;
      quality.callsSaved = v.calls_saved;

      let writes = [];
      let retires = [];
      if (gate.pass) {
        try {
          const pages = readLocalPages(BRAIN_DIR);
          const prompt = buildDistillPrompt({
            repo: e.repo || "unknown",
            title: e.aiTitle || "(untitled session)",
            evidenceText: evidenceText(e),
            index: buildIndex(pages),
            relevant: buildRelevant(pages, e.repo),
          });
          const plan = ask(prompt, DISTILL_SCHEMA, { attended: false });
          calls++;
          if (plan && !plan.trivial && Array.isArray(plan.ops) && plan.ops.length) {
            const applied = applyPlan(plan, { today });
            writes = applied.writes;
            retires = applied.retires;
            if (writes.length || retires.length) {
              const merged = mergePages(pages, writes, retires);
              const nowSlugs = writeLocalBrain(BRAIN_DIR, merged, today);
              noteLocalPages(writes.map((w) => `${w.slug}.md`));
              log("distilled", { session: s.sessionId, wrote: writes.length, retired: retires.length, pages: nowSlugs.length });
            }
            if (applied.skipped.length) log("ops dropped by guards", { session: s.sessionId, skipped: applied.skipped });
          }
        } catch (err) {
          if (err instanceof RateLimited) { log("rate-limited; stopping this tick", { why: String(err.message) }); break; }
          log("distill call failed; quality-only for this session", { session: s.sessionId, error: err instanceof LLMError ? String(err.message) : String(err) });
        }
      }

      await pushBrain(config, { sessionId: s.sessionId, pages: writes, retires, quality });
      ledger[s.key] = { distilledMtime: s.mtimeMs };
      writeLedger(ledger);
    }
    if (candidates.length) log("tick complete", { candidates: candidates.length, distilled: calls });
  } finally {
    releaseLock();
  }
}

main().catch((e) => { log("tick threw", { error: String(e) }); releaseLock(); process.exit(0); });
