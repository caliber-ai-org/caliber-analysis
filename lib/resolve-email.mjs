/**
 * Resolve which email to attribute Caliber Analysis capture to on this laptop.
 *
 * Order (MDM fleet):
 *   1. Claude Code login — ~/.claude.json → oauthAccount.emailAddress
 *   2. Explicit override — CALIBER_EMAIL env (MDM / installer --email)
 *   3. git config --global user.email
 *
 * Returns a lowercased email string, or null when nothing is available yet
 * (common when MDM runs before the first Claude /login).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

/** Claude Code OAuth identity written after /login. */
export function emailFromClaudeLogin(home = homedir()) {
  try {
    const raw = readFileSync(join(home, ".claude.json"), "utf8");
    const cfg = JSON.parse(raw);
    return normalizeEmail(cfg?.oauthAccount?.emailAddress);
  } catch {
    return null;
  }
}

export function emailFromEnv(env = process.env) {
  return normalizeEmail(env.CALIBER_EMAIL);
}

export function emailFromGitConfig() {
  try {
    const out = execFileSync("git", ["config", "--global", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalizeEmail(out);
  } catch {
    return null;
  }
}

/**
 * @param {{ home?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string | null}
 */
export function resolveLaptopEmail(opts = {}) {
  return (
    emailFromClaudeLogin(opts.home ?? homedir()) ||
    emailFromEnv(opts.env ?? process.env) ||
    emailFromGitConfig() ||
    null
  );
}
