#!/usr/bin/env node
/**
 * Register the brain-distill daemon (~15 min) with the OS scheduler. Installed by the
 * consented brain-setup, never silently. Its OWN unit — separate label/timer from the
 * capture sweeper — so the model path never rides the sweeper's short lock (a distill
 * `claude -p` can outlast the sweeper's 120s stale timeout).
 *
 *   node bin/install-distill.mjs             install
 *   node bin/install-distill.mjs --uninstall remove
 */
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CALIBER_DIR } from "../lib/config.mjs";
import { installScheduledJob } from "../lib/scheduler-install.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "distill.mjs");
const LABEL = "dev.caliber.brain-distill";
const UNIT = "caliber-brain-distill";
const INTERVAL_SEC = 900;
const STATE = join(CALIBER_DIR, "distill-daemon.json");
const UNINSTALL = process.argv.includes("--uninstall");

try {
  const mechanism = installScheduledJob({
    label: LABEL,
    unitName: UNIT,
    script: SCRIPT,
    intervalSec: INTERVAL_SEC,
    logDir: CALIBER_DIR,
    uninstall: UNINSTALL,
  });
  mkdirSync(CALIBER_DIR, { recursive: true });
  if (UNINSTALL) {
    if (existsSync(STATE)) unlinkSync(STATE);
    console.log(`Caliber: brain-distill daemon removed (${mechanism}).`);
  } else {
    writeFileSync(STATE, JSON.stringify({ installed: true, mechanism, installedAt: new Date().toISOString() }));
    console.log(`Caliber: brain-distill daemon installed via ${mechanism} — runs every ${INTERVAL_SEC / 60} min.`);
  }
} catch (err) {
  console.error(
    `Caliber: could not ${UNINSTALL ? "remove" : "install"} the brain-distill daemon (${String(err?.message || err)}). ` +
      `The brain will not update automatically; you can run it by hand: ${process.execPath} ${SCRIPT}`,
  );
  process.exit(0);
}
