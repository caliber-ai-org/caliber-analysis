/**
 * Claude Code transcript (JSONL) → ingest row mapping.
 *
 * The transcript schema is intentionally undocumented and version-dependent, so
 * we map defensively: known envelope fields become columns, and the ENTIRE
 * redacted line is stored as `content` for full fidelity (nothing is lost even
 * when the shape shifts). Lines that carry no `uuid` (pr-link, attachment,
 * queue-operation, …) get a deterministic content hash as their dedup key, so a
 * re-ship of the same line still collapses on the server.
 */

import { createHash } from "node:crypto";
import { redactDeep } from "./redact.mjs";

/** Deterministic dedup id for a line that has no native uuid. */
export function stableId(line) {
  const digest = createHash("sha256").update(JSON.stringify(line)).digest("base64url");
  return `h:${digest.slice(0, 32)}`;
}

/**
 * Map one parsed transcript line to the ingest row shape (content redacted).
 * `repoFor` resolves a cwd to its canonical project (the git remote); it defaults
 * to a no-op so pure callers/tests never shell out to git.
 */
export function mapLine(line, fallbackSessionId, repoFor = () => null, fileOffset = null) {
  const message = line && typeof line === "object" ? line.message : null;
  const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);
  const cwd = typeof line.cwd === "string" ? line.cwd : null;
  return {
    // A subagent line carries the PARENT session's id (verified against real
    // task files — it matches the containing session directory), so subagent
    // work rolls up to the session that spawned it. fallbackSessionId is the
    // directory-derived id, used when a line omits the field entirely.
    sessionId: str(line.sessionId) ?? fallbackSessionId,
    uuid: str(line.uuid) ?? stableId(line),
    parentUuid: typeof line.parentUuid === "string" ? line.parentUuid : null,
    role: message && typeof message.role === "string" ? message.role : null,
    type: typeof line.type === "string" ? line.type : null,
    // Full redacted line — the columns above are just indexed projections of it.
    content: redactDeep(line),
    model: message && typeof message.model === "string" ? message.model : null,
    cwd,
    gitBranch: typeof line.gitBranch === "string" ? line.gitBranch : null,
    repo: cwd ? repoFor(cwd) : null,
    ts: typeof line.timestamp === "string" ? line.timestamp : null,
    // The line's byte offset in its own stream file. THE ONE THING THE SERVER
    // CANNOT DERIVE FROM `content` — and without it a session can't be put back
    // in order, so it can't be restored. See sliceCompleteLines.
    fileOffset,
    // NOTE: subagent provenance (isSidechain/agentId), token counts, tool names
    // and the client version are NOT projected here on purpose. `content` is the
    // whole line, so the server already has them and derives them at insert. That
    // keeps the wire contract stable — a laptop still on an old plugin version
    // gets subagent support without updating, and lines already shipped can be
    // corrected server-side. Adding them here would buy nothing and couple the
    // plugin's release to the server's.
  };
}

/**
 * From a chunk of transcript text (read past the last watermark), return the
 * COMPLETE lines, each line's byte offset WITHIN THE CHUNK, and the exact byte
 * count they occupy. A trailing partial line (no newline yet — the turn is still
 * being written) is held back so the watermark only advances over fully-flushed
 * lines.
 *
 * The offsets are what make a session restorable. A transcript's meaning depends
 * on line ORDER, and the stored rows can't recover it: ~12% of lines carry no
 * timestamp, and the server's captured_at is per-batch, not per-line — so 10% of
 * rows are genuinely un-orderable after the fact. The byte offset is the only
 * total order that survives the trip, and we already walk the file by it.
 */
export function sliceCompleteLines(text, maxLines = Infinity, maxBytes = Infinity) {
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) return { lines: [], offsets: [], consumedBytes: 0 };

  const lines = [];
  const offsets = [];
  let pos = 0; // char index into `text`
  let bytePos = 0; // byte offset into `text` — NOT the same as pos (utf-8)
  let consumedBytes = 0;

  while (pos <= lastNl && lines.length < maxLines) {
    const nl = text.indexOf("\n", pos);
    if (nl === -1) break;
    const raw = text.slice(pos, nl);
    const bytes = Buffer.byteLength(raw, "utf8") + 1; // + the '\n'

    // Stop before a batch grows too big to POST. A line count is a bad proxy for
    // request size: 2,000 lines of chat is a few hundred KB, but 2,000 lines of a
    // transcript full of large assistant messages is 5.5MB, which cannot be
    // uploaded AND ingested inside the shipper's timeout. That failure is not
    // spread evenly — it lands on the LARGEST sessions, which are exactly the ones
    // with the most to recover, so they would retry forever and never ship a byte.
    //
    // `lines.length > 0` keeps it a stop condition rather than a stall condition: a
    // single line bigger than the cap still goes out on its own (the server bounds
    // it separately) instead of wedging the stream behind a line that can never fit.
    if (lines.length > 0 && bytePos + bytes > maxBytes) break;

    // A blank line contributes bytes but is not a record. Skipping it from
    // `lines` while still advancing bytePos is what keeps offsets truthful.
    if (raw.length > 0) {
      lines.push(raw);
      offsets.push(bytePos);
    }
    bytePos += bytes;
    consumedBytes = bytePos;
    pos = nl + 1;
  }

  return { lines, offsets, consumedBytes };
}

/**
 * Parse JSONL lines, skipping any that don't parse (never throw on one bad line).
 *
 * Non-OBJECT values are dropped too, and that guard is load-bearing. A transcript
 * line is always a JSON object; a bare string or number is something else that
 * merely happens to be valid JSON. We shipped `"alert.fired"` into a tenant this
 * way — a line of grep output from a file that wasn't a transcript at all. Without
 * this, any such line becomes a content-hashed row with null role and null type,
 * which is indistinguishable from a real one at a glance.
 */
export function parseLines(lines, offsets = [], baseOffset = 0) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Offsets are carried alongside the parsed line rather than by index,
        // because this function DROPS lines — an index into the output would no
        // longer line up with the input, and the order we're trying to preserve
        // would be silently wrong.
        const rel = offsets[i];
        out.push({
          line: parsed,
          fileOffset: typeof rel === "number" ? baseOffset + rel : null,
        });
      }
    } catch {
      // A malformed/partial line must not sink the whole batch.
    }
  }
  return out;
}

/** Map a batch of parsed { line, fileOffset } entries to ingest rows. */
export function mapLines(entries, fallbackSessionId, repoFor = () => null) {
  return entries.map(({ line, fileOffset }) =>
    mapLine(line, fallbackSessionId, repoFor, fileOffset),
  );
}
