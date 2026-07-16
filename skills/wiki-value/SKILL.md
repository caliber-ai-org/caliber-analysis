---
name: wiki-value
description: Report what the Caliber brain did for the current session AND whether it is making your sessions better over time — pages used, MCP calls saved, and your friction/efficiency vs your before-brain baseline. Use when the user asks "what did my brain do", "is the brain helping", "wiki value", or "brain value".
---

# Caliber brain value — this session, and the trend

Answer two questions honestly, with numbers you compute (do not guess): what the brain did
**this session**, and whether it is making the user's sessions **better over time**.

## Part 1 — this session (local, exact)

Run the value reporter against the current transcript:

```
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/value.mjs').then(async m => { const b = await import('${CLAUDE_PLUGIN_ROOT}/lib/brain.mjs'); const v = m.sessionValue(process.argv[1], b.BRAIN_DIR); console.log(JSON.stringify({ used: v.used, calls_saved: v.calls_saved, facts: v.facts_substituted, pages: m.countBrainPages(b.BRAIN_DIR), new: b.newPagesFromLastPull() }, null, 2)); })" "<TRANSCRIPT_PATH>"
```

Use the current session's `transcript_path` (hooks receive it; else the newest file under
`~/.claude/projects/`). Report: **used** (brain pages this session read), **saved** (MCP
calls a cached fact stood in for — a real count; the tool it caches was never called this
session), **new** (pages the last distill/pull added), and total pages.

## Part 2 — the rolling verdict (are your sessions improving?)

Fetch the before/after scorecard from Caliber (same identity the plugin ships with):

```
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/config.mjs').then(async ({loadConfig}) => { const c = loadConfig(); if(!c){console.log('{}');return;} const r = await fetch(c.endpoint + '/api/brain/impact', { headers: { authorization: 'Bearer ' + c.token } }).catch(()=>null); console.log(r && r.ok ? await r.text() : '{}'); })"
```

It returns before/after deltas (friction, tool-calls/session, turns/session, calls-saved,
pages-in-use) since `brain_activated_at`. Present it as a one-line verdict, e.g.
*"Last 14 days vs your before-brain baseline: friction −38%, tool-calls/session −22%,
turns/session −15%, 47 MCP calls saved."*

## Be honest

- A quiet session where the brain did nothing is a real, common outcome — say so; do not inflate.
- The trend is directional and needs a few weeks of after-data to be meaningful (week one is
  mostly "before"). If the deltas are flat or negative, **say that plainly** — the brain is
  supposed to earn its keep, and reporting when it doesn't is the point.
- The full picture (every page, the weekly chart) lives on the user's Caliber practitioner page.
