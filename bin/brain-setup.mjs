#!/usr/bin/env node
/**
 * The one consented, reversible step that turns the brain ON for this developer.
 *
 * It is the ONLY part of the plugin that writes settings or changes agent behaviour, so it
 * runs explicitly (via the /caliber-brain:setup command after the user confirms), never
 * from a hook. It:
 *   1. merges `autoMemoryDirectory` + `statusLine` into ~/.claude/settings.json (every
 *      other key, hook, and setting is preserved; the prior values are backed up so
 *      --uninstall restores them exactly),
 *   2. pulls the brain once so the very next session already has it,
 *   3. stamps brain_activated_at server-side — the before/after marker for the trend.
 *
 *   node bin/brain-setup.mjs              enable (idempotent)
 *   node bin/brain-setup.mjs --uninstall  restore settings to their pre-setup values
 *
 * Everything is printed as JSON on stdout so the calling command can report it faithfully.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, CALIBER_DIR } from "../lib/config.mjs";
import { BRAIN_DIR, pullBrain } from "../lib/brain.mjs";
import { persistClaudePath } from "../lib/llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(homedir(), ".claude", "settings.json");
const BACKUP = join(CALIBER_DIR, "brain-setup-backup.json");
const STATUSLINE = join(HERE, "statusline.mjs");
const INSTALL_DISTILL = join(HERE, "install-distill.mjs");
const BACKFILL = join(HERE, "backfill-quality.mjs");
const UNINSTALL = process.argv.includes("--uninstall");
const RESTORE_STATUSLINE = process.argv.includes("--restore-statusline");

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function enable() {
  const config = loadConfig();
  if (!config) {
    out({ ok: false, error: "Caliber is not configured on this machine (~/.caliber/capture.json). Nothing changed." });
    process.exit(1);
  }

  const settings = readJson(SETTINGS, {});
  mkdirSync(dirname(SETTINGS), { recursive: true });

  // Back up the exact prior values ONCE, so uninstall is a faithful restore and re-running
  // setup never overwrites the genuine original with our own values.
  if (!existsSync(BACKUP)) {
    mkdirSync(CALIBER_DIR, { recursive: true });
    writeFileSync(
      BACKUP,
      JSON.stringify({
        autoMemoryDirectory: settings.autoMemoryDirectory ?? null,
        statusLine: settings.statusLine ?? null,
        had_autoMemoryDirectory: "autoMemoryDirectory" in settings,
        had_statusLine: "statusLine" in settings,
      }),
    );
  }
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.pre-caliber-brain`);

  // autoMemoryDirectory is the brain's load mechanism — it must point at the brain dir. If
  // the user already had a DIFFERENT one, surface it (it's backed up; uninstall restores it)
  // instead of clobbering silently.
  const priorAutoMem = settings.autoMemoryDirectory ?? null;
  const autoMemoryReplaced = priorAutoMem && priorAutoMem !== BRAIN_DIR ? priorAutoMem : null;
  settings.autoMemoryDirectory = BRAIN_DIR;

  // NEVER touch the user's statusLine. Overwriting their prompt config without consent is
  // exactly the wrong thing to do; the brain's readout is available without it (the
  // end-of-turn line, /caliber-analysis:wiki-value, and the Caliber page). Leave it alone.
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");

  // Capture the `claude` path now (the daemon can't see the interactive PATH), then install
  // the ~15-min distill daemon. Both non-fatal — the brain still works if the daemon can't
  // install; it just won't self-update.
  const claudePath = (() => { try { return persistClaudePath(); } catch { return null; } })();
  let daemon = "not installed";
  try { daemon = execFileSync(process.execPath, [INSTALL_DISTILL], { encoding: "utf8" }).trim(); } catch (e) { daemon = `install failed: ${String(e?.message || e).slice(0, 120)}`; }

  const pull = await pullBrain(config).catch(() => null);

  let activatedAt = null;
  try {
    const res = await fetch(`${config.endpoint}/api/brain/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "x-caliber-email": config.email },
    });
    if (res.ok) activatedAt = (await res.json())?.activatedAt ?? null;
  } catch {
    /* activation is best-effort; the trend marker can be stamped on a later run */
  }

  // Kick off the free (no-model) quality backfill in the background so the "before" side of
  // the trend fills from history without making the user wait or spending any quota.
  try { spawn(process.execPath, [BACKFILL], { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }

  out({
    ok: true,
    action: "enabled",
    brainDir: BRAIN_DIR,
    statusLine: "not modified (your existing statusLine is left untouched)",
    autoMemoryReplaced,
    claudePath,
    distillDaemon: daemon,
    pulled: pull ? { enabled: pull.enabled, pageCount: pull.pageCount, newPages: pull.newSlugs.length } : null,
    activatedAt,
    note:
      "Enabled. Only autoMemoryDirectory was set in ~/.claude/settings.json (backup at " +
      ".pre-caliber-brain); your statusLine was NOT touched. Distillation runs on THIS machine using " +
      "your Claude Code quota (~1-2 small calls/day); the brain loads from your NEXT session on. Your " +
      "friction 'before' trend is backfilling in the background." +
      (autoMemoryReplaced ? ` NOTE: replaced your existing autoMemoryDirectory (${autoMemoryReplaced}); uninstall restores it.` : ""),
  });
}

function uninstall() {
  const settings = readJson(SETTINGS, {});
  const backup = readJson(BACKUP, null);
  if (backup) {
    if (backup.had_autoMemoryDirectory) settings.autoMemoryDirectory = backup.autoMemoryDirectory;
    else delete settings.autoMemoryDirectory;
    if (backup.had_statusLine) settings.statusLine = backup.statusLine;
    else delete settings.statusLine;
  } else {
    // No backup (shouldn't happen) — remove only the keys we would have set.
    delete settings.autoMemoryDirectory;
    delete settings.statusLine;
  }
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");

  // Stop the distill daemon too, so no more `claude -p` calls run on this machine.
  let daemon = "not removed";
  try { daemon = execFileSync(process.execPath, [INSTALL_DISTILL, "--uninstall"], { encoding: "utf8" }).trim(); } catch (e) { daemon = `remove failed: ${String(e?.message || e).slice(0, 120)}`; }

  out({
    ok: true,
    action: "uninstalled",
    distillDaemon: daemon,
    note: "Restored autoMemoryDirectory + statusLine to their pre-setup values and stopped the distill daemon. Your pages remain in Caliber.",
  });
}

/**
 * Restore the user's original statusLine from the backup, keeping the brain intact — for
 * anyone whose statusLine was overwritten by an older build of setup that used to set it.
 */
function restoreStatusline() {
  const settings = readJson(SETTINGS, {});
  const backup = readJson(BACKUP, null);
  if (!backup) {
    out({ ok: false, error: "No brain-setup backup found (~/.caliber/brain-setup-backup.json) — nothing to restore." });
    return;
  }
  if (backup.had_statusLine) settings.statusLine = backup.statusLine;
  else delete settings.statusLine;
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  out({
    ok: true,
    action: "restore-statusline",
    statusLine: settings.statusLine ?? null,
    note: "Restored your original statusLine from the backup. The brain (autoMemoryDirectory) is unchanged.",
  });
}

const run = RESTORE_STATUSLINE ? Promise.resolve(restoreStatusline()) : UNINSTALL ? Promise.resolve(uninstall()) : enable();
run.catch((e) => {
  out({ ok: false, error: String(e) });
  process.exit(1);
});
