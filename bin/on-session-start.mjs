#!/usr/bin/env node
/**
 * SessionStart hook — disclosure + one-time historical backfill kickoff.
 *
 * A governance tool that records transcripts must not do so silently. When
 * capture is configured, we inject a one-line notice into the session context
 * (so the assistant is aware and can answer "is my activity recorded?"
 * truthfully) and echo it to stderr for the user.
 *
 * On each configured SessionStart we also spawn a detached backfill worker.
 * The worker claims a one-shot lock and no-ops once the last-week seed is done,
 * so the hook stays fire-and-forget (same pattern as the Stop shipper) and
 * never imports the shipper stack into the hot path.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../lib/config.mjs";

const backfillScript = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "backfill.mjs");

const bail = setTimeout(() => process.exit(0), 2000);

process.stdin.resume();
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

    try {
      spawn(process.execPath, [backfillScript], {
        detached: true,
        stdio: "ignore",
      }).unref();
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
