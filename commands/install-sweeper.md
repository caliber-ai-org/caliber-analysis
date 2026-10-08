---
description: Register the Caliber Analysis backfill sweeper (5-minute scheduler)
---

You are running the **Caliber Analysis sweeper install**. This registers a background
job on the user's machine (launchd / systemd / cron) that backfills existing Claude
Code transcripts. It is a deliberate, consented step — the plugin will not write to
LaunchAgents without the user asking.

Tell the user briefly: this backfills past sessions in the background over the next
few hours; new sessions capture immediately via the Stop hook even if this fails.

## Run it

```
node ${CLAUDE_PLUGIN_ROOT}/bin/install-sweeper.mjs
```

If the slash command is unavailable, discover the script:

```bash
SWEEPER="$(find ~/.claude/plugins -path '*/caliber-analysis/bin/install-sweeper.mjs' 2>/dev/null | head -1)"
test -n "$SWEEPER" && node "$SWEEPER"
```

**Non-fatal:** If install fails (corporate laptop, no scheduler permissions), report
the error and continue — the Stop hook still ships every new turn. Backfill is a bonus.

To remove later: `node ${CLAUDE_PLUGIN_ROOT}/bin/install-sweeper.mjs --uninstall`
