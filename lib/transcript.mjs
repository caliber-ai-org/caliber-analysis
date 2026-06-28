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
export function mapLine(line, fallbackSessionId, repoFor = () => null) {
  const message = line && typeof line === "object" ? line.message : null;
  const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);
  const cwd = typeof line.cwd === "string" ? line.cwd : null;
  return {
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
  };
}

/**
 * From a chunk of transcript text (read past the last watermark), return the
 * COMPLETE lines and the exact byte count they occupy. A trailing partial line
 * (no newline yet — the turn is still being written) is held back so the
 * watermark only advances over fully-flushed lines.
 */
export function sliceCompleteLines(text, maxLines = Infinity) {
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) return { lines: [], consumedBytes: 0 };
  const complete = text.slice(0, lastNl + 1);
  const nonEmpty = complete.split("\n").filter((l) => l.length > 0);
  if (nonEmpty.length <= maxLines) {
    return { lines: nonEmpty, consumedBytes: Buffer.byteLength(complete, "utf8") };
  }
  // Cap the batch: take the first maxLines and count exactly their bytes (each
  // JSONL line is followed by a single '\n'). The remainder ships next run.
  const lines = nonEmpty.slice(0, maxLines);
  let consumedBytes = 0;
  for (const line of lines) consumedBytes += Buffer.byteLength(line, "utf8") + 1;
  return { lines, consumedBytes };
}

/** Parse JSONL lines, skipping any that don't parse (never throw on one bad line). */
export function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // A malformed/partial line must not sink the whole batch.
    }
  }
  return out;
}

/** Map a batch of raw transcript lines to ingest rows. */
export function mapLines(rawLines, fallbackSessionId, repoFor = () => null) {
  return rawLines.map((line) => mapLine(line, fallbackSessionId, repoFor));
}
