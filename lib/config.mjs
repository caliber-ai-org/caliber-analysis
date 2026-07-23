/**
 * Plugin configuration + state paths, all under ~/.caliber.
 *
 * Config is read from capture.json, falling back to the dogfood shipper's
 * dogfood.json — so a laptop already onboarded into Caliber Labs captures with
 * zero extra setup, while a customer install can drop its own capture.json.
 * Both hold { endpoint, email, token }; capture.json may set "enabled": false
 * to opt out without uninstalling.
 *
 * MDM installs may omit email at first (Claude not logged in yet). loadConfig
 * then resolves email from Claude login → CALIBER_EMAIL → git, and persists it
 * into capture.json once found so later ships skip rediscovery.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveLaptopEmail } from "./resolve-email.mjs";

export const CALIBER_DIR = join(homedir(), ".caliber");
export const STATE_DIR = join(CALIBER_DIR, "capture-state");
export const CAPTURE_LOG = join(CALIBER_DIR, "capture.log");
export const CAPTURE_CONFIG_PATH = join(CALIBER_DIR, "capture.json");

/**
 * The generation of the capture format. BUMP THIS to make every laptop re-ship
 * every transcript it still holds, exactly once.
 *
 * A watermark says "I have shipped this file up to byte N", so a fix to WHAT we
 * capture reaches new lines only — the history already past the watermark is never
 * looked at again. That is not good enough when the bug was in what we stored:
 *
 *   1 → the original capture.
 *   2 → line identity. Ingest keyed a row on (session, message_uuid), but Claude
 *       Code replays a session's history into the file when it forks into another
 *       worktree, so a uuid is not a line. 19–57% of the lines in every real
 *       transcript were silently dropped at ingest. Re-shipping is the only way the
 *       lines already on disk are ever recovered — without this bump, the fix would
 *       apply to new sessions only and every existing session would stay short.
 *
 * The re-ship is safe by construction: an append-only file gives a line the same
 * byte offset forever, so the server dedupes on (session, uuid, offset) and a
 * re-ship of a line it already holds writes nothing. The sweeper's 20MB/run budget
 * keeps the recapture spread over several runs rather than one thundering herd.
 */
export const CAPTURE_EPOCH = 2;

const CONFIG_PATHS = [CAPTURE_CONFIG_PATH, join(CALIBER_DIR, "dogfood.json")];

function persistEmail(path, cfg, email) {
  if (path !== CAPTURE_CONFIG_PATH) return; // never rewrite dogfood.json
  if (typeof cfg?.email === "string" && cfg.email.trim().toLowerCase() === email) return;
  try {
    mkdirSync(CALIBER_DIR, { recursive: true, mode: 0o700 });
    const next = { ...cfg, email };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // best-effort; shipping still works with the resolved email in memory
  }
}

/**
 * Returns { endpoint, email, token } or null. Null means "stay silent" — the
 * hook must never disrupt a session because capture isn't configured.
 */
export function loadConfig() {
  for (const path of CONFIG_PATHS) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue; // missing/unreadable/malformed — try the next source
    }
    if (cfg && cfg.enabled === false) return null; // explicit opt-out
    const endpoint = typeof cfg?.endpoint === "string" ? cfg.endpoint.replace(/\/+$/, "") : "";
    const token = typeof cfg?.token === "string" ? cfg.token : "";
    if (!endpoint || !token) continue;

    let email = typeof cfg?.email === "string" ? cfg.email.trim().toLowerCase() : "";
    if (!email.includes("@")) {
      email = resolveLaptopEmail() ?? "";
      if (email) persistEmail(path, cfg, email);
    }
    if (!email) continue; // configured but identity not known yet — stay silent

    return { endpoint, email, token };
  }
  return null;
}
