#!/usr/bin/env node
/**
 * SessionStart hook — surfaces a disclosure that capture is active.
 *
 * A governance tool that records transcripts must not do so silently. When
 * capture is configured, we inject a one-line notice into the session context
 * (so the assistant is aware and can answer "is my activity recorded?"
 * truthfully) and echo it to stderr for the user. Non-blocking by design:
 * exits 0 no matter what, and stays silent when capture isn't configured.
 */

import { loadConfig } from "../lib/config.mjs";
import { pullBrain } from "../lib/brain.mjs";
import { persistClaudePath } from "../lib/llm.mjs";

const bail = setTimeout(() => process.exit(0), 8000);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", async () => {
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

    // Capture the `claude` binary path while we can see the user's PATH — the distill daemon
    // runs from launchd/systemd, which does NOT inherit the interactive shell PATH, so it
    // needs this stashed path to invoke `claude -p`.
    try {
      persistClaudePath();
    } catch {
      /* ignore */
    }

    // Re-hydrate the local brain from Caliber (non-destructive: fresh machine / second
    // device). On the authoring machine the local distiller owns page contents; this only
    // fills gaps and refreshes the router + activation marker. Best-effort, non-fatal.
    try {
      await pullBrain(config);
    } catch {
      /* offline / not a pilot user — stay silent */
    }
  }
  process.exit(0);
});
process.stdin.on("error", () => {
  clearTimeout(bail);
  process.exit(0);
});
