/**
 * Plugin configuration + state paths, all under ~/.caliber.
 *
 * Config is read from capture.json, falling back to the dogfood shipper's
 * dogfood.json — so a laptop already onboarded into Caliber Labs captures with
 * zero extra setup, while a customer install can drop its own capture.json.
 * Both hold { endpoint, email, token }; capture.json may set "enabled": false
 * to opt out without uninstalling.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CALIBER_DIR = join(homedir(), ".caliber");
export const STATE_DIR = join(CALIBER_DIR, "capture-state");
export const CAPTURE_LOG = join(CALIBER_DIR, "capture.log");

const CONFIG_PATHS = [join(CALIBER_DIR, "capture.json"), join(CALIBER_DIR, "dogfood.json")];

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
    const email = typeof cfg?.email === "string" ? cfg.email : "";
    const token = typeof cfg?.token === "string" ? cfg.token : "";
    if (endpoint && email && token) return { endpoint, email, token };
  }
  return null;
}
