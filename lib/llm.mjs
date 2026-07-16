/**
 * The one place the on-laptop distiller talks to a model. A Node port of the reference
 * yaniv-wiki/pipeline/llm.py. The model is given NO agentic tools and a JSON schema; it can
 * only return validated JSON that deterministic code (apply.mjs) then applies. It runs on
 * the user's OWN Claude Code login via `claude -p` — no API key, their quota.
 *
 * LOOP + RUNAWAY GUARDS (this spends the user's quota, so these are load-bearing):
 *   1. --safe-mode + disableAllHooks + auto-memory off — the child fires no hooks (can't
 *      spawn a shipper/second distiller) and does not load the brain into itself.
 *   2. SENTINEL-prefixed prompt — the child's single user turn starts with
 *      [[CALIBER-BRAIN-INTERNAL, which extract.mjs drops, so the child scores 0 human turns
 *      and the gate rejects it: the distiller can never distill its own transcript. DECISIVE.
 *   3. rate limiter (MAX_PER_HOUR, attended/unattended split) — the backstop for an UNKNOWN
 *      runaway; the daemon path is "unattended". Plus a per-call --max-budget-usd wallet cap.
 * (llm.py notes --no-session-persistence does NOT suppress the child transcript; it is passed
 *  anyway, harmless, but nothing depends on it — which is why guard 2 is the one that matters.)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CALIBER_DIR } from "./config.mjs";

const DISTILL_STATE = join(CALIBER_DIR, "distill-state");
const RATE_LOG = join(DISTILL_STATE, "llm-calls.log");
const CLAUDE_PATH_FILE = join(CALIBER_DIR, "claude-path.json");
const MAX_PER_HOUR = Number(process.env.CALIBER_BRAIN_MAX_LLM_PER_HOUR || "6");

const SENTINEL = "[[CALIBER-BRAIN-INTERNAL — this is the brain talking to itself; never ingest]]";

export class RateLimited extends Error {}
export class LLMError extends Error {}

/** Resolve the absolute `claude` binary: prefer the path captured at SessionStart (where
 *  the user's PATH is visible), then a `which`/common-location probe. Daemons don't inherit
 *  the interactive shell PATH, so a bare "claude" would silently fail from launchd/systemd. */
export function resolveClaudePath() {
  try {
    const p = JSON.parse(readFileSync(CLAUDE_PATH_FILE, "utf8"))?.path;
    if (p && existsSync(p)) return p;
  } catch {
    /* fall through to probe */
  }
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  const found = (probe.stdout || "").split("\n").map((s) => s.trim()).find(Boolean);
  if (found && existsSync(found)) return found;
  for (const c of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(CALIBER_DIR, "..", ".local/bin/claude")]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Record the resolved path (called by the SessionStart hook, where PATH is the user's). */
export function persistClaudePath() {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  const found = (probe.stdout || "").split("\n").map((s) => s.trim()).find(Boolean);
  if (found) {
    mkdirSync(CALIBER_DIR, { recursive: true });
    try {
      writeFileSync(CLAUDE_PATH_FILE, JSON.stringify({ path: found, capturedAt: new Date().toISOString() }));
    } catch {
      /* ignore */
    }
  }
  return found || null;
}

function rateCheck(attended) {
  mkdirSync(DISTILL_STATE, { recursive: true });
  const now = Date.now() / 1000;
  let recentUnattended = 0;
  if (existsSync(RATE_LOG)) {
    for (const line of readFileSync(RATE_LOG, "utf8").split("\n")) {
      const [ts, tag] = line.trim().split(" ");
      const t = Number(ts);
      if (!Number.isFinite(t)) continue;
      if (now - t < 3600 && tag !== "attended") recentUnattended++;
    }
  }
  if (!attended && recentUnattended >= MAX_PER_HOUR) {
    throw new RateLimited(`${recentUnattended} unattended distill calls in the last hour (cap ${MAX_PER_HOUR}); skipping this run`);
  }
  appendFileSync(RATE_LOG, `${now} ${attended ? "attended" : "unattended"}\n`);
}

function stripFence(s) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  return (m ? m[1] : s).trim();
}

/**
 * Run one tool-less, schema-constrained distiller call. Returns the validated plan object.
 * @param prompt the distiller prompt (buildDistillPrompt output)
 * @param schema JSON schema (DISTILL_SCHEMA)
 * @param opts { model, budgetUsd, timeoutMs, attended, claudePath }
 */
export function ask(prompt, schema, opts = {}) {
  const {
    model = process.env.CALIBER_BRAIN_DISTILL_MODEL || "sonnet",
    budgetUsd = 0.6,
    timeoutMs = 600_000,
    attended = false,
    claudePath = resolveClaudePath(),
  } = opts;

  if (!claudePath) throw new LLMError("could not locate the `claude` binary (not on the daemon PATH)");
  rateCheck(attended);

  const args = [
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--model", model,
    "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
    "--json-schema", JSON.stringify(schema),
    "--output-format", "json",
  ];
  if (budgetUsd) args.push("--max-budget-usd", String(budgetUsd));

  const res = spawnSync(claudePath, args, {
    input: `${SENTINEL}\n\n${prompt}`,
    encoding: "utf8",
    timeout: timeoutMs,
    cwd: "/tmp",
    env: { ...process.env, CALIBER_BRAIN_DISTILL: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    if (res.error.code === "ETIMEDOUT") throw new LLMError(`timed out after ${timeoutMs}ms`);
    throw new LLMError(String(res.error));
  }
  if (res.status !== 0) throw new LLMError(`exit ${res.status}: ${(res.stderr || res.stdout || "").slice(0, 400)}`);

  const raw = (res.stdout || "").trim();
  let payload = raw;
  try {
    const env = JSON.parse(raw);
    payload = env && typeof env === "object" && "result" in env ? env.result : raw;
  } catch {
    /* not the envelope — treat stdout as the payload */
  }
  if (payload && typeof payload === "object") return payload;
  try {
    return JSON.parse(stripFence(String(payload)));
  } catch {
    throw new LLMError(`model did not return JSON: ${String(payload).slice(0, 400)}`);
  }
}
