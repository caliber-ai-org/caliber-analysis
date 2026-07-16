---
description: Turn on your Caliber personal brain (one-time, consented, reversible)
---

You are running the **Caliber brain setup**. This is the single consented step that turns
on this developer's personal brain. It changes their Claude Code configuration, so you must
disclose plainly and get explicit confirmation BEFORE making any change.

## Step 1 — Disclose, then ask

Tell the user, in your own words, exactly what enabling the brain does:

- It sets `autoMemoryDirectory` in their `~/.claude/settings.json` to
  `~/.caliber/brain`, so a small set of distilled lessons (built from their own Claude Code
  sessions) **loads into every session, in every repo**.
- **It distills on THIS machine using their own Claude Code login** — about 1–2 small
  `claude -p` calls a day, on their own quota. No API key, nothing sent to a third party for
  the model call; a ~15-min background daemon does it off the session path.
- It records that they turned it on (the before/after marker for the "are your sessions
  improving?" trend on their Caliber page). It does **NOT** touch their `statusLine` or any
  other setting — the brain's per-session readout is available via the end-of-turn line,
  `/caliber-analysis:wiki-value`, and the Caliber page.
- Their existing settings and hooks are preserved; the prior `autoMemoryDirectory` /
  `statusLine` values are backed up and fully restored by uninstall.
- It is **reversible**: uninstall restores their settings and stops the daemon (no more
  `claude -p` calls); their pages remain in Caliber.

Then ask: **"Enable your Caliber brain now?"** Do not proceed without a clear yes.

## Step 2 — Run it

Only after the user confirms, run:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/brain-setup.mjs
```

It prints a JSON result. If `ok` is false, relay the `error` verbatim and stop — nothing
was enabled. If `ok` is true, tell the user:

- how many pages were pulled (`pulled.pageCount`), or that the brain is empty so far,
- that the brain **loads from their next session on** (not this one — `autoMemoryDirectory`
  is read at session start),
- that they can see the full brain and their trend on their Caliber practitioner page,
- how to turn it off (the uninstall line above).

If the user asked to turn it OFF, run the same script with `--uninstall` and confirm their
settings were restored.
