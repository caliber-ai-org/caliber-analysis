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

const shipScript = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "ship.mjs");

// Hard ceiling so we never hang the hook chain if stdin never closes.
const bail = setTimeout(() => process.exit(0), 2000);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  clearTimeout(bail);
  try {
    const input = JSON.parse(raw);
    if (input.transcript_path && input.session_id) {
      spawn(
        process.execPath,
        [shipScript, "--transcript", input.transcript_path, "--session", input.session_id],
        { detached: true, stdio: "ignore" },
      ).unref();
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
