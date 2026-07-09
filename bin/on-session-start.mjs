#!/usr/bin/env node
/**
 * SessionStart hook — disclosure + one-time historical backfill kickoff.
 *
 * A governance tool that records transcripts must not do so silently. When
 * capture is configured, we inject a one-line notice into the session context
 * (so the assistant is aware and can answer "is my activity recorded?"
 * truthfully) and echo it to stderr for the user.
 *
 * On the first configured SessionStart we also spawn a detached backfill
 * worker that ships the last week of local Claude Code transcripts — so a
 * freshly installed tenant already has data to analyze. The hook itself stays
 * fire-and-forget: exits 0 no matter what, and stays silent when capture
 * isn't configured.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { claimBackfill } from "../lib/backfill.mjs";

const backfillScript = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "backfill.mjs");

const bail = setTimeout(() => process.exit(0), 2000);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  clearTimeout(bail);
  const config = loadConfig();
  if (config) {
    const notice =
      `Caliber Analysis is active: this machine's Claude Code activity for ${config.email} ` +
      `(prompts, responses, tool use) is analyzed for AI-governance — secrets are redacted ` +
      `locally before anything is sent to ${config.endpoint}.`;
    process.stderr.write(`[caliber] ${notice}\n`);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notice },
      }),
    );

    // One-time last-week backfill — claim the lock here, then spawn detached
    // so concurrent SessionStarts don't kick off duplicate scans.
    try {
      if (claimBackfill()) {
        spawn(process.execPath, [backfillScript], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }
    } catch {
      // spawn failure must never disrupt the session
    }
  }
  process.exit(0);
});
process.stdin.on("error", () => {
  clearTimeout(bail);
  process.exit(0);
});
