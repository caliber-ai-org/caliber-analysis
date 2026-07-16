/**
 * Signal extraction for one Claude Code session — the deterministic front of the on-laptop
 * distiller. No model call. Ported from the platform's src/lib/brain/extract.ts, whose
 * behaviour is pinned by tests/fixtures/dov_golden.json. A "line" is one transcript entry
 * (the parsed JSONL object), so this runs on exactly the objects the distiller reads off disk.
 *
 * R7: every captured human/assistant quote is passed through redactString before it is
 * stored, so a credential shape can never ride an evidence quote into the distiller prompt
 * or a rendered page body. Redaction masks credential SHAPES only, so correction/confirmation
 * keyword detection is unaffected.
 */
import { redactString } from "./redact.mjs";

const META_PREFIXES = [
  "<command-name>", "<command-message>", "<command-args>", "<local-command",
  "<system-reminder>", "<task-notification>", "<bash-input>", "<bash-stdout>",
  "<bash-stderr>", "<user-prompt-submit-hook>",
  "Caveat:", "[Request interrupted",
  "This session is being continued from",
  "[[CALIBER-BRAIN-INTERNAL", // the distiller's own prompts — the decisive loop guard
];

const CORRECTION = /\b(no|nope|wrong|incorrect|actually|instead|revert|undo|stop|don'?t|that'?s not|not that|i said|why did you|why didn'?t you|you broke)\b/i;
const CONFIRMATION = /\b(perfect|exactly|correct|yes that'?s right|ship it|lgtm|nice|great)\b/i;
const INTERRUPT = "[Request interrupted";

function userText(o) {
  if (o.type !== "user" || o.isMeta || o.isSidechain) return null;
  if ("toolUseResult" in o && o.toolUseResult != null) return null;
  const c = o.message?.content;
  let text = null;
  if (typeof c === "string") {
    text = c;
  } else if (Array.isArray(c)) {
    if (c.some((b) => b && typeof b === "object" && b.type === "tool_result")) return null;
    const parts = c.filter((b) => b && typeof b === "object" && b.type === "text").map((b) => b.text ?? "");
    text = parts.length ? parts.join("") : null;
  }
  if (!text || !text.trim()) return null;
  return text.trim();
}

function startsWithMeta(s) {
  return META_PREFIXES.some((p) => s.startsWith(p));
}

function assistantMaxText(o) {
  const c = o.message?.content;
  if (!Array.isArray(c)) return 0;
  let max = 0;
  for (const b of c) {
    if (b && typeof b === "object" && b.type === "text") max = Math.max(max, (b.text ?? "").length);
  }
  return max;
}

export function extractEvidence(lines) {
  const e = {
    humanTurns: [], corrections: [], interrupts: 0, snapBacks: [], confirmations: [],
    prLinks: 0, toolsUsed: {}, filesTouched: [], aiTitle: null, repo: null,
    factCandidates: 0, errorFixPairs: 0, signal: 0,
  };
  let prevAssistantLen = 0;
  let recentAssistant = "";
  const seenMsgIds = new Set();

  for (const o of lines) {
    const t = o.type;
    if (o.cwd && !e.repo) e.repo = String(o.cwd).split("/").pop() ?? null;
    if (t === "ai-title" && !e.aiTitle) { e.aiTitle = o.aiTitle ?? null; continue; }
    if (t === "pr-link") { e.prLinks += 1; continue; }

    if (t === "user") {
      const raw = userText(o);
      if (raw === null) continue;
      if (raw.startsWith(INTERRUPT)) { e.interrupts += 1; prevAssistantLen = 0; continue; }
      if (startsWithMeta(raw)) continue;
      const s = redactString(raw); // scrub before storing (R7)
      e.humanTurns.push(s);
      if (CORRECTION.test(s)) e.corrections.push({ said: s, afterClaudeSaid: recentAssistant.slice(-320) });
      if (CONFIRMATION.test(s)) e.confirmations.push({ said: s });
      if (s.length < 60 && prevAssistantLen > 2000) e.snapBacks.push({ said: s });
      prevAssistantLen = 0;
      continue;
    }

    if (t === "assistant") {
      const msg = o.message ?? {};
      const mid = msg.id;
      if (mid && !seenMsgIds.has(mid)) seenMsgIds.add(mid);
      const c = msg.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text") {
            const len = (b.text ?? "").length;
            if (len > prevAssistantLen) prevAssistantLen = len;
            recentAssistant = redactString(b.text ?? "");
          } else if (b.type === "tool_use") {
            const name = b.name ?? "?";
            e.toolsUsed[name] = (e.toolsUsed[name] ?? 0) + 1;
            const fp = b.input?.file_path;
            if (fp && ["Edit", "Write", "NotebookEdit"].includes(name)) e.filesTouched.push(fp);
          }
        }
      }
      const maxA = assistantMaxText(o);
      if (maxA > prevAssistantLen) prevAssistantLen = maxA;
    }
  }

  e.signal =
    3 * e.corrections.length +
    3 * e.interrupts +
    2 * e.snapBacks.length +
    2 * e.confirmations.length +
    2 * e.factCandidates +
    1 * e.errorFixPairs +
    1 * e.prLinks +
    (e.humanTurns.length >= 4 ? 1 : 0);

  return e;
}
