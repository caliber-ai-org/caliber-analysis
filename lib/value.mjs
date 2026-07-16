/**
 * The honest per-session value of the brain, computed locally — a Node port of the
 * reference yaniv-wiki/pipeline/value.py:session_value. Answers the three questions Yaniv
 * asked the statusline to answer: what got USED (a brain page deliberately read), and what
 * it SAVED (an MCP call a cached fact stood in for).
 *
 * Distillation runs on THIS machine (the ~15-min daemon), so pages are written locally and
 * "learned" is a real local fact again: the statusline shows `used · saved` for the live
 * session plus `📥 N new` when the daemon/pull adds pages. The fuller "last 14 days vs your
 * before-brain baseline" rolling verdict lives in the /wiki-value skill and on the Caliber
 * page (the person-page Impact scorecard).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const CHARS_PER_TOKEN = 4;
// A fact page names the MCP tool it caches at the start of its refresh_cmd (~mcp__server__tool).
const TOOL_IN_REFRESH = /^\s*"?\s*(mcp__[a-z0-9_+.-]+)/i;

/** Minimal frontmatter reader: returns { class, refresh_cmd } for a brain page, or {}. */
function readFrontmatter(path) {
  let txt;
  try {
    txt = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  if (!txt.startsWith("---")) return {};
  const end = txt.indexOf("\n---", 3);
  if (end === -1) return {};
  const fm = txt.slice(3, end);
  const cls = /(^|\n)\s*class:\s*(\w+)/.exec(fm)?.[2] ?? null;
  const refresh = /(^|\n)\s*refresh_cmd:\s*"?([^"\n]*)"?/.exec(fm)?.[2]?.trim() ?? null;
  return { cls, refresh, body: txt.slice(end + 4) };
}

/** A page is a router (never counted as "used") if it's MEMORY.md/_manual.md or a map. */
function isRouter(fn) {
  return fn === "MEMORY.md" || fn === "_manual.md" || fn.startsWith("map-");
}

/**
 * Parse a transcript JSONL file and return what the brain did this session.
 * @param transcriptPath path to the .jsonl transcript
 * @param brainDir the autoMemoryDirectory the brain was pulled into
 */
export function sessionValue(transcriptPath, brainDir) {
  const result = { used: [], calls_saved: 0, facts_substituted: [], tokens_saved: 0, model: null };
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return result;
  }

  const toolsCalled = new Map(); // name -> count
  const readPaths = new Set();
  const brainBase = basename(brainDir);

  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === "assistant") {
      const msg = o.message ?? {};
      if (msg.model && !result.model) result.model = msg.model;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (b?.type !== "tool_use") continue;
        const name = b.name ?? "?";
        toolsCalled.set(name, (toolsCalled.get(name) ?? 0) + 1);
        const fp = b.input?.file_path;
        // A Read of a file under the brain dir is the brain being consulted.
        if (name === "Read" && typeof fp === "string" && fp.includes(`${brainBase}/`)) {
          readPaths.add(basename(fp));
        }
      }
    }
  }

  const used = [...readPaths].filter((fn) => !isRouter(fn));
  result.used = used;

  for (const fn of used) {
    const p = join(brainDir, fn);
    if (!existsSync(p)) continue;
    const { cls, refresh, body } = readFrontmatter(p);
    if (cls !== "fact" || !refresh) continue;
    const m = TOOL_IN_REFRESH.exec(refresh);
    if (!m) continue; // SQL/prose fact — can't verify a saved call, don't claim it
    const tool = m[1];
    if (!toolsCalled.has(tool)) {
      // read the cache AND never called the tool it caches → a saved call
      result.facts_substituted.push({ page: fn, tool });
      result.tokens_saved += Math.floor(Buffer.byteLength(body ?? "", "utf8") / CHARS_PER_TOKEN);
    }
  }
  result.calls_saved = result.facts_substituted.length;
  return result;
}

/** Count the active brain pages on disk (excludes routers). */
export function countBrainPages(brainDir) {
  if (!existsSync(brainDir)) return 0;
  return readdirSync(brainDir).filter((fn) => fn.endsWith(".md") && !isRouter(fn)).length;
}
