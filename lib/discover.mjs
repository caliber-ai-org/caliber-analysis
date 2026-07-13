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
 * Every main-thread transcript on disk.
 * Returns [{ key, path, sessionId, mtimeMs, size }].
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
      out.push({ key: sessionId, path, sessionId, mtimeMs: stat.mtimeMs, size: stat.size });
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
          key: `sub:${sessionId}:${agentId}`,
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
