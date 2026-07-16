/**
 * Cross-platform "run this Node script every N seconds" installer — the OS-scheduler logic
 * generalized out of bin/install-sweeper.mjs so the brain-distill daemon can reuse it
 * without duplicating the launchd/systemd/cron/schtasks matrix. The existing sweeper
 * installer is left untouched (proven, load-bearing for capture); this serves the new unit.
 *
 * Every failure is non-fatal and reported — a plugin that can't install a background unit
 * (locked-down laptop, no systemd) must degrade, never break.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const NODE = process.execPath;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", ...opts }).toString();
}

/**
 * @param opts.label       launchd label / macOS + logical id (e.g. "dev.caliber.brain-distill")
 * @param opts.unitName    systemd/cron/schtasks base name (e.g. "caliber-brain-distill")
 * @param opts.script      absolute path to the .mjs to run
 * @param opts.intervalSec run cadence in seconds
 * @param opts.logDir      directory for stdout/stderr logs
 * @param opts.uninstall   remove instead of install
 * @returns the mechanism string (e.g. "launchd"), or throws
 */
export function installScheduledJob({ label, unitName, script, intervalSec, logDir, uninstall = false }) {
  // Escape hatch for CI / tests / locked-down machines: never touch the OS scheduler.
  if (process.env.CALIBER_BRAIN_NO_SCHEDULER) return "skipped (CALIBER_BRAIN_NO_SCHEDULER)";
  if (process.platform === "darwin") return macOS({ label, script, intervalSec, logDir, uninstall });
  if (process.platform === "linux") return linux({ unitName, script, intervalSec, uninstall });
  if (process.platform === "win32") return windows({ unitName, script, uninstall });
  throw new Error(`no scheduler for platform "${process.platform}"`);
}

function macOS({ label, script, intervalSec, logDir, uninstall }) {
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  mkdirSync(dirname(plist), { recursive: true });
  try { run("launchctl", ["bootout", `${domain}/${label}`]); } catch { /* not loaded */ }
  if (uninstall) {
    if (existsSync(plist)) unlinkSync(plist);
    return "launchd (removed)";
  }
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${script}</string></array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(logDir, `${label}.out.log`)}</string>
  <key>StandardErrorPath</key><string>${join(logDir, `${label}.err.log`)}</string>
</dict>
</plist>
`,
  );
  run("launchctl", ["bootstrap", domain, plist]);
  return "launchd";
}

function linux({ unitName, script, intervalSec, uninstall }) {
  const dir = join(homedir(), ".config", "systemd", "user");
  const service = join(dir, `${unitName}.service`);
  const timer = join(dir, `${unitName}.timer`);
  let hasSystemd = false;
  try { run("systemctl", ["--user", "--version"]); hasSystemd = true; } catch { /* none */ }

  if (hasSystemd) {
    if (uninstall) {
      try { run("systemctl", ["--user", "disable", "--now", `${unitName}.timer`]); } catch { /* not enabled */ }
      for (const f of [service, timer]) if (existsSync(f)) unlinkSync(f);
      return "systemd (removed)";
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(service, `[Unit]\nDescription=Caliber ${unitName}\n\n[Service]\nType=oneshot\nExecStart=${NODE} ${script}\n`);
    writeFileSync(timer, `[Unit]\nDescription=Run ${unitName} every ${intervalSec}s\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${intervalSec}s\nUnit=${unitName}.service\n\n[Install]\nWantedBy=timers.target\n`);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${unitName}.timer`]);
    return "systemd";
  }

  const marker = `# ${unitName}`;
  let current = "";
  try { current = run("crontab", ["-l"]); } catch { current = ""; }
  const without = current.split("\n").filter((l) => !l.includes(marker)).join("\n").replace(/\n+$/, "");
  const writeCrontab = (body) => execFileSync("crontab", ["-"], { input: body, stdio: ["pipe", "pipe", "pipe"] });
  if (uninstall) { writeCrontab(without ? `${without}\n` : ""); return "cron (removed)"; }
  const everyMin = Math.max(1, Math.round(intervalSec / 60));
  const line = `*/${everyMin} * * * * ${NODE} ${script} >/dev/null 2>&1 ${marker}`;
  writeCrontab(`${without ? `${without}\n` : ""}${line}\n`);
  return "cron";
}

function windows({ unitName, script, uninstall }) {
  const task = unitName.replace(/[^A-Za-z0-9]/g, "");
  if (uninstall) { run("schtasks", ["/Delete", "/F", "/TN", task]); return "schtasks (removed)"; }
  run("schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", "15", "/TN", task, "/TR", `"${NODE}" "${script}"`]);
  return "schtasks";
}
