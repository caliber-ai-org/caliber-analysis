#!/usr/bin/env node
/**
 * Stop hook entry — fires when a Claude Code turn finishes.
 *
 * This MUST be fire-and-forget: it reads the hook input, spawns the shipper as a
 * DETACHED, unref'd child, and exits 0 immediately with no stdout. The actual
 * read/redact/POST happens in that child, so a slow or down endpoint can never
 * add latency to — or block — the user's session. Any error here is swallowed:
 * a logging plugin must be invisible to the session it observes.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const shipScript = join(here, "..", "lib", "ship.mjs");
const sweepScript = join(here, "sweep.mjs");

// Hard ceiling so we never hang the hook chain if stdin never closes.
const bail = setTimeout(() => process.exit(0), 2000);

function detach(args) {
  spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  clearTimeout(bail);
  try {
    const input = JSON.parse(raw);
    if (input.transcript_path && input.session_id) {
      detach([shipScript, "--transcript", input.transcript_path, "--session", input.session_id]);

      // Subagent transcripts live in a TEMP directory that the OS clears on
      // reboot, so capture this session's while they're still guaranteed to be
      // there. The 5-minute sweeper would also find them, but only if the
      // machine survives that long — and a session with ten delegated agents
      // would otherwise lose all of their tokens and tool calls.
      detach([sweepScript, "--session", input.session_id, "--tasks-only"]);
    }
  } catch {
    // malformed input or spawn failure — stay silent, never disrupt the session
  }
  process.exit(0);
});
process.stdin.on("error", () => {
  clearTimeout(bail);
  process.exit(0);
});
