/**
 * Finds every transcript on this machine worth shipping.
 *
 * Two sources, because Claude Code writes them to two different places:
 *
 *   MAIN THREAD  ~/.claude/projects/<project-slug>/<session-id>.jsonl
 *   SUBAGENTS    ~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agentId>.jsonl
 *
 * The subagent files are the reason this module exists. They are NOT in the main
 * transcript — a session that delegated to ten agents shows none of their work,
 * and none of their tokens, if you only read the session's own .jsonl. Each one
 * carries the PARENT session's id, so delegated work rolls up to the session that
 * spawned it.
 *
 * A note on a wrong turn, so nobody re-takes it: Claude Code also exposes these
 * under <tmp>/claude-<uid>/<project>/<session>/tasks/<agentId>.output. That path
 * is a trap. The entries there are SYMLINKS (so a readdir filtering on isFile()
 * silently skips every one), the directory is ephemeral, and it also contains
 * background-bash task output that is not a transcript at all — shipping it
 * writes junk rows. The `subagents/` directory above is the real, durable
 * location; read that and none of those problems exist.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename } from "node:path";

/** Where Claude Code keeps transcripts. */
export function projectsDir() {
  return join(homedir(), ".claude", "projects");
}

/** Directory names, or [] if the path is missing/unreadable. Never throws. */
function safeDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * File names matching `suffix`.
 *
 * Follows symlinks on purpose (statSync, not the dirent's isFile()): Claude Code
 * exposes transcripts through symlinks in some locations, and a dirent for a
 * symlink reports isFile() === false — which silently skips real transcripts.
 */
function safeFiles(path, suffix) {
  try {
    return readdirSync(path)
      .filter((name) => name.endsWith(suffix))
      .filter((name) => {
        try {
          return statSync(join(path, name)).isFile(); // resolves symlinks
        } catch {
          return false; // dangling symlink
        }
      });
  } catch {
    return [];
  }
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * The watermark key for a byte stream: it must identify the FILE, not the session.
 *
 * A session id does NOT identify a file. Resume a session inside a git worktree and
 * Claude Code writes a transcript with the SAME session id into that worktree's
 * project directory — so one session id can own several files, on several paths.
 *
 * Keying the watermark on the session id alone made those files share one watermark
 * and clobber each other: the real 68MB transcript would ship and record
 * `offset: 71500273`, then a 113-byte worktree stub of the same session id would
 * ship and overwrite it with `offset: 113`. Next run, the big file looked unshipped
 * and re-sent all 68MB — every sweep, forever. Worktrees are a normal Claude Code
 * workflow, so this is not an exotic case.
 *
 * The project directory disambiguates them. It is hashed rather than embedded: the
 * key becomes a filename (see statePathFor), and a real project path URI-encodes to
 * well past the 255-byte filename limit.
 */
export function streamKey(projectDir, sessionId, agentId = null) {
  const scope = createHash("sha1").update(projectDir).digest("hex").slice(0, 8);
  return agentId ? `sub:${scope}:${sessionId}:${agentId}` : `${scope}:${sessionId}`;
}

/**
 * The watermark key this stream used BEFORE streamKey existed (the bare session id,
 * or `sub:<session>:<agent>`).
 *
 * Adopted once, when no watermark exists under the new key, so that fixing the key
 * does not make every laptop re-ship its entire history a second time. A stream whose
 * legacy watermark overshoots its file (the clobbered case above) simply re-ships
 * from 0 — shipFromBuffer already treats `offset > size` as a rotated file.
 */
export function legacyStreamKey(sessionId, agentId = null) {
  return agentId ? `sub:${sessionId}:${agentId}` : sessionId;
}

/**
 * Every main-thread transcript on disk.
 * Returns [{ key, legacyKey, path, sessionId, mtimeMs, size }].
 *
 * `key` is the watermark filename — stable across runs and distinct per byte
 * stream, or the shipper would re-send or skip data.
 */
export function listMainTranscripts(root = projectsDir()) {
  const out = [];
  if (!existsSync(root)) return out;

  for (const project of safeDirs(root)) {
    const projectPath = join(root, project);
    for (const file of safeFiles(projectPath, ".jsonl")) {
      const path = join(projectPath, file);
      const stat = safeStat(path);
      if (!stat) continue;
      const sessionId = basename(file, ".jsonl");
      out.push({
        key: streamKey(project, sessionId),
        legacyKey: legacyStreamKey(sessionId),
        path,
        sessionId,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }
  return out;
}

/**
 * Every subagent transcript on disk.
 * Returns [{ key, path, sessionId, agentId, mtimeMs, size }].
 *
 * `sessionId` is the directory's — the PARENT session — so a subagent's tokens
 * and tool calls roll up to the session that spawned it. (The lines carry the
 * same id internally; the directory is the belt to that braces, and it works
 * even on a line that omits the field.)
 *
 * Each agent file is its own append-only byte stream, so it gets its own
 * watermark key rather than sharing the session's.
 *
 * Only `agent-*.jsonl` is read. The same directory holds `agent-*.meta.json`
 * sidecars, which are not transcripts.
 */
export function listAgentTranscripts(root = projectsDir()) {
  const out = [];
  if (!existsSync(root)) return out;

  for (const project of safeDirs(root)) {
    const projectPath = join(root, project);
    // Session DIRECTORIES sit alongside the session .jsonl files.
    for (const sessionId of safeDirs(projectPath)) {
      const subagentsPath = join(projectPath, sessionId, "subagents");
      for (const file of safeFiles(subagentsPath, ".jsonl")) {
        if (!file.startsWith("agent-")) continue;
        const path = join(subagentsPath, file);
        const stat = safeStat(path);
        if (!stat) continue;
        const agentId = basename(file, ".jsonl").slice("agent-".length);
        out.push({
          key: streamKey(project, sessionId, agentId),
          legacyKey: legacyStreamKey(sessionId, agentId),
          path,
          sessionId,
          agentId,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    }
  }
  return out;
}

/**
 * Everything worth shipping.
 *
 * Subagent discovery is wrapped: if Claude Code ever moves or renames that
 * directory, subagent capture goes quiet and main-thread capture carries on. An
 * upstream change must never be able to take capture down entirely.
 */
export function discoverAll() {
  const main = listMainTranscripts();
  let agents = [];
  try {
    agents = listAgentTranscripts();
  } catch {
    agents = [];
  }
  return [...main, ...agents];
}
