#!/usr/bin/env node
/**
 * Registers the 5-minute sweeper with the OS scheduler.
 *
 * Run explicitly — `node bin/install-sweeper.mjs` — never silently from a hook.
 * This writes to the user's LaunchAgents / systemd units / Scheduled Tasks, and
 * a plugin that does that behind your back is a plugin you uninstall.
 *
 * The sweeper is a safety net, not the primary path: the Stop hook still ships
 * every turn. If installation fails (locked-down corporate laptop, no systemd),
 * capture keeps working — it just loses the backfill and the crashed-session
 * tail. So every failure here is reported and non-fatal.
 *
 *   node bin/install-sweeper.mjs            install
 *   node bin/install-sweeper.mjs --uninstall remove
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CALIBER_DIR } from "../lib/config.mjs";

const SWEEP = join(dirname(fileURLToPath(import.meta.url)), "sweep.mjs");
const NODE = process.execPath;
const LABEL = "dev.caliber.capture-sweeper";
const INTERVAL_SEC = 300;
const STATE = join(CALIBER_DIR, "sweeper.json");

const UNINSTALL = process.argv.includes("--uninstall");

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: "pipe" }).toString();
}

/* --------------------------------- macOS --------------------------------- */

function macPlistPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function macPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${SWEEP}</string>
  </array>
  <key>StartInterval</key><integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(CALIBER_DIR, "sweeper.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(CALIBER_DIR, "sweeper.err.log")}</string>
</dict>
</plist>
`;
}

function macInstall() {
  const plist = macPlistPath();
  const domain = `gui/${process.getuid()}`;
  mkdirSync(dirname(plist), { recursive: true });

  // bootout first so a re-install replaces cleanly; it fails when not loaded,
  // which is fine and expected on a first run.
  try {
    run("launchctl", ["bootout", `${domain}/${LABEL}`]);
  } catch {
    /* not loaded */
  }

  if (UNINSTALL) {
    if (existsSync(plist)) unlinkSync(plist);
    return "launchd (removed)";
  }

  writeFileSync(plist, macPlist());
  run("launchctl", ["bootstrap", domain, plist]);
  return "launchd";
}

/* --------------------------------- Linux --------------------------------- */

function systemdDir() {
  return join(homedir(), ".config", "systemd", "user");
}

function hasSystemd() {
  try {
    run("systemctl", ["--user", "--version"]);
    return true;
  } catch {
    return false;
  }
}

function linuxInstall() {
  const dir = systemdDir();
  const service = join(dir, "caliber-sweeper.service");
  const timer = join(dir, "caliber-sweeper.timer");

  if (hasSystemd()) {
    if (UNINSTALL) {
      try {
        run("systemctl", ["--user", "disable", "--now", "caliber-sweeper.timer"]);
      } catch {
        /* not enabled */
      }
      for (const f of [service, timer]) if (existsSync(f)) unlinkSync(f);
      return "systemd (removed)";
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      service,
      `[Unit]
Description=Caliber Analysis capture sweeper

[Service]
Type=oneshot
ExecStart=${NODE} ${SWEEP}
`,
    );
    writeFileSync(
      timer,
      `[Unit]
Description=Run the Caliber Analysis capture sweeper every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL_SEC}s
Unit=caliber-sweeper.service

[Install]
WantedBy=timers.target
`,
    );
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "caliber-sweeper.timer"]);
    return "systemd";
  }

  // No systemd (containers, minimal distros, WSL without systemd) → cron.
  const marker = "# caliber-analysis sweeper";
  let current = "";
  try {
    current = run("crontab", ["-l"]);
  } catch {
    current = ""; // no crontab yet
  }
  const without = current
    .split("\n")
    .filter((l) => !l.includes(marker))
    .join("\n")
    .replace(/\n+$/, "");

  const writeCrontab = (body) =>
    execFileSync("crontab", ["-"], { input: body, stdio: ["pipe", "pipe", "pipe"] });

  if (UNINSTALL) {
    writeCrontab(without ? `${without}\n` : "");
    return "cron (removed)";
  }

  const line = `*/5 * * * * ${NODE} ${SWEEP} >/dev/null 2>&1 ${marker}`;
  writeCrontab(`${without ? `${without}\n` : ""}${line}\n`);
  return "cron";
}

/* -------------------------------- Windows -------------------------------- */

function windowsInstall() {
  const task = "CaliberCaptureSweeper";
  if (UNINSTALL) {
    run("schtasks", ["/Delete", "/F", "/TN", task]);
    return "schtasks (removed)";
  }
  run("schtasks", [
    "/Create",
    "/F",
    "/SC",
    "MINUTE",
    "/MO",
    String(INTERVAL_SEC / 60),
    "/TN",
    task,
    "/TR",
    `"${NODE}" "${SWEEP}"`,
  ]);
  return "schtasks";
}

/* --------------------------------- main ---------------------------------- */

function main() {
  let mechanism;
  try {
    if (process.platform === "darwin") mechanism = macInstall();
    else if (process.platform === "linux") mechanism = linuxInstall();
    else if (process.platform === "win32") mechanism = windowsInstall();
    else {
      console.error(
        `Caliber: no sweeper scheduler for platform "${process.platform}". ` +
          `Capture still works via the Stop hook; only the 5-minute backfill is unavailable.`,
      );
      process.exit(0);
    }
  } catch (err) {
    // Non-fatal by design — see the header.
    console.error(
      `Caliber: could not ${UNINSTALL ? "remove" : "install"} the sweeper (${String(
        err?.message || err,
      )}).\n` +
        `Capture still works via the Stop hook; the 5-minute backfill is unavailable. ` +
        `You can run it by hand: ${NODE} ${SWEEP}`,
    );
    process.exit(0);
  }

  mkdirSync(CALIBER_DIR, { recursive: true });
  if (UNINSTALL) {
    if (existsSync(STATE)) unlinkSync(STATE);
    console.log(`Caliber: sweeper removed (${mechanism}).`);
  } else {
    writeFileSync(
      STATE,
      JSON.stringify({ installed: true, mechanism, installedAt: new Date().toISOString() }),
    );
    console.log(`Caliber: sweeper installed via ${mechanism} — runs every 5 minutes.`);
  }
}

main();
