#!/usr/bin/env node
/**
 * statusLine script — the live "what is the brain doing for me" readout, set into the
 * user's settings by the consented brain setup (a plugin can't set statusLine itself).
 * Receives the session JSON on stdin ({ transcript_path, model, ... }) and prints ONE line.
 *
 *   🧠 used 2 · saved ~1 call (~$0.09 est) · 📥 3 new
 *
 * `used`  — brain pages this session deliberately read.
 * `saved` — MCP calls a cached fact page stood in for (never called the tool it caches).
 * `📥 N`  — pages the most recent pull added (only shown when > 0).
 *
 * Honest by construction: `saved` is a real count; the $ is an estimate and says so. On a
 * session where the brain did nothing, it prints a quiet baseline. Never throws — a broken
 * statusline must be invisible, never break the prompt.
 */
import { sessionValue, countBrainPages } from "../lib/value.mjs";
import { BRAIN_DIR, newPagesFromLastPull } from "../lib/brain.mjs";

// Input $/1M tokens, for the saved-call estimate. A small table; unknown models fall back.
const PRICE_IN = {
  "claude-opus-4-8": 5,
  "claude-opus-4-7": 5,
  "claude-opus-4-6": 5,
  "claude-sonnet-5": 3,
  "claude-sonnet-4-6": 3,
  "claude-haiku-4-5": 1,
};
function priceFor(model) {
  if (!model) return 3;
  for (const k of Object.keys(PRICE_IN)) if (model.includes(k)) return PRICE_IN[k];
  return 3;
}

const bail = setTimeout(() => {
  process.stdout.write(""); // never hang the prompt
  process.exit(0);
}, 1500);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  clearTimeout(bail);
  try {
    const input = JSON.parse(raw || "{}");
    const transcript = input.transcript_path || input.transcriptPath || "";
    const model = input.model?.id || input.model || null;
    const newN = newPagesFromLastPull();

    if (!transcript) {
      const pages = countBrainPages(BRAIN_DIR);
      process.stdout.write(pages ? `🧠 ${pages} pages${newN ? ` · 📥 ${newN} new` : ""}` : "");
      process.exit(0);
    }

    const v = sessionValue(transcript, BRAIN_DIR);
    const used = v.used.length;
    const saved = v.calls_saved;
    const parts = [];
    parts.push(`used ${used}`);
    if (saved > 0) {
      const usd = (v.tokens_saved / 1e6) * priceFor(v.model || model);
      parts.push(`saved ~${saved} call${saved === 1 ? "" : "s"} (~$${usd.toFixed(2)} est)`);
    } else {
      parts.push("saved ~0 calls");
    }
    if (newN > 0) parts.push(`📥 ${newN} new`);
    process.stdout.write(`🧠 ${parts.join(" · ")}`);
  } catch {
    process.stdout.write("");
  }
  process.exit(0);
});
process.stdin.on("error", () => {
  clearTimeout(bail);
  process.stdout.write("");
  process.exit(0);
});
