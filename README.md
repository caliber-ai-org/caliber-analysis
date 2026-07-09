# Caliber Analysis

A Claude Code plugin that analyzes how your team uses Claude Code, sending session
activity to your Caliber platform tenant for AI-governance insights.

> **What it captures, transparently:** the full transcript of each turn — your
> prompts, the assistant's responses, and tool input/output. High-confidence
> secrets (API keys, tokens, PEM private keys) are **redacted on your machine
> before anything is sent**. Data lands in your tenant's row-level-security–scoped
> Postgres, attributed to the email bound to your ingest token. You can pause it
> any time (`"enabled": false`) or uninstall.

## How it works

```
Claude Code (any OS)
  ├─ SessionStart (first configured session)
  │    ├─ disclosure notice
  │    └─ spawns a detached backfill worker (once)
  │         └─ ships ~/.claude/projects/*/*.jsonl from the last 7 days
  │              (same redact + watermark + POST path as live capture)
  └─ Stop hook fires when a turn ends
       └─ spawns a detached worker (the hook returns instantly — never blocks)
            ├─ reads new transcript lines past a per-session byte watermark
            ├─ redacts high-confidence secret shapes
            └─ POST /api/ingest/claude-code/transcript   (Bearer clbi_…)
                 └─ dedupes on (org, session, message_uuid) → cc_transcript_messages
```

- **Non-blocking.** The `Stop` hook reads its input, spawns the shipper detached,
  and exits 0 immediately. A slow or down endpoint can never add latency to your
  session. The one-time historical backfill is the same pattern.
- **Last-week seed.** On first install, a `SessionStart` backfill ships the last
  7 days of local Claude Code transcripts (`~/.claude/projects/`) so the tenant
  already has data to analyze. A marker at
  `~/.caliber/capture-state/_backfill.json` records completion; delete it to
  re-run. Per-session watermarks keep the pass idempotent with live capture.
- **At-least-once + idempotent.** The watermark advances only on an HTTP 2xx, so
  a failed ship is re-sent next turn. Every transcript line carries a `uuid` (or a
  deterministic content hash when it has none), and the server upserts
  `ON CONFLICT DO NOTHING` — re-shipping is free, nothing is lost or duplicated.
- **Secret-redacted client-side.** See [`lib/redact.mjs`](lib/redact.mjs).
  Redaction is defense-in-depth, not a guarantee — treat the stored data as
  sensitive and rely on tenant RLS + access controls.
- **Disclosed.** A `SessionStart` notice records that capture is active.

## Install

```
/plugin marketplace add caliber-ai-org/caliber-analysis
/plugin install caliber-analysis@caliber
```

## Configure

The plugin reads `~/.caliber/capture.json`, falling back to the dogfood
shipper's `~/.caliber/dogfood.json` — so a laptop already onboarded into Caliber
Labs captures with no extra setup. To configure explicitly:

```json
{
  "endpoint": "https://app.caliber-ai.dev",
  "email": "you@example.com",
  "token": "clbi_…"
}
```

`chmod 600 ~/.caliber/capture.json`. The `token` is a user-bound Caliber ingest
token (minted by the platform). Set `"enabled": false` to pause capture without
uninstalling.

## Operate

- **Logs:** `~/.caliber/capture.log` (one JSON line per ship — counts + errors).
- **Watermarks:** `~/.caliber/capture-state/<session>.json` (byte offset already
  shipped; delete to re-ship a session).
- **Backfill marker:** `~/.caliber/capture-state/_backfill.json` (one-time
  last-week seed; delete to re-scan historical transcripts).
- **Disable:** set `"enabled": false` in the config, or remove the plugin.

## Scope & limitations (v0)

- Captures the main-agent transcript; subagent (sidechain) lines are included
  because they're written to the same transcript before the main `Stop` fires.
- The transcript JSONL schema is undocumented and version-dependent, so the
  mapper stores the **full redacted line** as `content` and projects known
  fields (`role`, `type`, `model`, `cwd`, `git_branch`, `repo`, `ts`) into columns.
- `repo` is the normalized git remote (`host/owner/repo`) of the session's `cwd`,
  resolved once per cwd — so worktrees and every clone roll up to the real project.
- Tests: `npm test` (or `node --test test/*.test.mjs`).
