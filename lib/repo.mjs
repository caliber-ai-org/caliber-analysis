/**
 * Canonical project identity from the git remote.
 *
 * `cwd` can't roll activity up to the real project — a worktree
 * (…/repo/.claude/worktrees/foo) and a teammate's clone (/home/bob/repo) are
 * different paths but the same project. The `origin` remote is the one key
 * stable across worktrees AND every clone (a worktree shares the main repo's
 * remotes), so we resolve it once per cwd and normalize to host/owner/repo.
 */

import { execFileSync } from "node:child_process";

/** Normalize any git remote URL to `host/owner/repo` (lowercased), or null. */
export function normalizeRemote(url) {
  if (typeof url !== "string") return null;
  let s = url.trim();
  if (!s) return null;

  // scp-like syntax has no scheme: user@host:owner/repo
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip scheme://
    s = s.replace(/^[^@/]+@/, ""); // strip user@
  }
  s = s.replace(/\.git\/*$/i, "").replace(/\/+$/, ""); // drop .git (+ any trailing slash)
  if (!s.includes("/")) return null; // need at least host/path
  return s.toLowerCase();
}

/**
 * A memoized cwd → repo resolver. Runs `git remote get-url origin` (a local
 * config read, bounded by a short timeout) once per distinct cwd. Returns null
 * for anything that isn't a git repo with an origin — never throws.
 */
export function makeRepoResolver() {
  const cache = new Map();
  return (cwd) => {
    if (!cwd) return null;
    if (cache.has(cwd)) return cache.get(cwd);
    let repo = null;
    try {
      const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      repo = normalizeRemote(url);
    } catch {
      repo = null; // not a git repo, no origin, or git unavailable
    }
    cache.set(cwd, repo);
    return repo;
  };
}
