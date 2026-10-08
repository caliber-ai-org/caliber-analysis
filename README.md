# Caliber Analysis

A Claude Code plugin that analyzes how your team uses Claude Code, sending session
activity to your Caliber platform tenant for AI-governance insights.

> **What it captures, transparently:** the full transcript of each session, your
> prompts, the assistant's responses, tool input/output, and the work done by any
> subagents it delegated to. High-confidence secrets (API keys, tokens, PEM
> private keys) are **redacted on your machine before anything is sent**. Data
> lands in your tenant's row-level-security–scoped Postgres, attributed to the
> email bound to your ingest token. You can pause it any time
> (`"enabled": false`) or uninstall.

## How it works

Two shippers, because one turn-end hook can't see everything:

```
Claude Code (any OS)
  ├─ Stop hook, fires when a turn ends
  │    └─ spawns detached workers (the hook returns instantly, never blocks)
  │         ├─ ship.mjs   → this session's new transcript lines
  │         └─ sweep.mjs --tasks-only
  │                       → this session's SUBAGENT transcripts, while the
  │                         temp dir they live in still exists
  │
  └─ Sweeper, every 5 minutes (launchd / systemd / schtasks)
       └─ sweep.mjs → walks EVERY transcript on disk and ships anything past
                      its watermark: long-running turns, sessions that crashed
                      before Stop fired, other machines, and the full backlog
                      that predates the install

  both → POST /api/ingest/claude-code/transcript   (Bearer clbi_…)
           └─ dedupes on (org, session, message_uuid) → cc_transcript_messages
```

- **Non-blocking.** The `Stop` hook reads its input, spawns its workers detached,
  and exits 0 immediately. A slow or down endpoint can never add latency to your
  session.
- **At-least-once + idempotent.** A watermark advances only on an HTTP 2xx, so a
  failed ship is re-sent next run. Every line carries a `uuid` (or a deterministic
  content hash when it has none) and the server upserts `ON CONFLICT DO NOTHING`.
  **This is what makes the two shippers safe to race**: if the hook and the sweeper
  send the same lines, one copy is stored. The per-stream locks in `lib/locks.mjs`
  only save bandwidth, correctness never depends on them.
- **Secret-redacted client-side.** See [`lib/redact.mjs`](lib/redact.mjs).
  Redaction is defense-in-depth, not a guarantee, treat the stored data as
  sensitive and rely on tenant RLS + access controls.
- **Silent in sessions.** The plugin adds nothing to the session or the model context. Telling employees about the capture is the deploying organization's job, as with any managed endpoint tool.

## Install

```
/plugin marketplace add caliber-ai-org/caliber-analysis
/plugin install caliber-analysis@caliber
```

For an existing install, update the marketplace and plugin, then confirm the
plugin is enabled:

```
/plugin marketplace update caliber
/plugin update caliber-analysis@caliber
/plugin enable caliber-analysis@caliber
```

Then register the 5-minute sweeper (macOS launchd, Linux systemd/cron, Windows
Scheduled Tasks):

```
node bin/install-sweeper.mjs      # bin/install-sweeper.mjs --uninstall to remove
```

This is a deliberate, explicit step, the plugin will not write to your
LaunchAgents behind your back. **Skipping it is fine**: the `Stop` hook still
ships every turn. You'd just lose the backfill of past sessions and the tail of
any session that dies mid-turn.

## Configure

The plugin reads `~/.caliber/capture.json`, falling back to the dogfood
shipper's `~/.caliber/dogfood.json`, so a laptop already onboarded into Caliber
Labs captures with no extra setup. To configure explicitly:

```json
{
  "endpoint": "https://app.trycaliber.ai",
  "email": "you@example.com",
  "token": "clbi_…"
}
```

`chmod 600 ~/.caliber/capture.json`. The `token` may be user-bound or
**org-scoped** (MDM fleet). For org tokens, `email` may be omitted at install
time; the plugin then resolves identity in order: Claude login
(`~/.claude.json` → `oauthAccount.emailAddress`), `CALIBER_EMAIL`, then
`git config --global user.email`, and persists the result into `capture.json`.
Set `"enabled": false` to pause capture without uninstalling.

### MDM fleet install

Admins mint one org token in Caliber (Settings → Caliber Analysis MDM) and push:

```bash
curl --http1.1 --retry 5 --retry-all-errors --retry-delay 2 -fsSL https://app.trycaliber.ai/install/caliber | sh -s -- "$ORG_INGEST_TOKEN"
```

That installs Caliber Code + this plugin. See `docs/caliber-code-mdm.md` in
caliber-platform.

## Operate

- **Logs:** `~/.caliber/capture.log` (one JSON line per ship, counts + errors).
- **Watermarks:** `~/.caliber/capture-state/<key>.json` (bytes already shipped;
  delete one to re-ship that stream). A session's main transcript and each of its
  subagent files are separate streams with separate watermarks.
- **Sweeper state:** `~/.caliber/sweep-state.json` (backfill progress).
- **Disable:** set `"enabled": false` in the config, or remove the plugin.

## Backfill

On first run the sweeper ships everything already on disk, often hundreds of
sessions. It is deliberately **rate-limited** (≤20 MB, ≤40 files, ≤90s per run,
live sessions always before backlog), so a few hundred MB of history drains over
a couple of hours in the background rather than in one burst. Each run logs what
it deferred, so a bounded run never reads as "captured everything".

## Scope & limitations

- **Subagents** live in a temp directory (`<tmp>/claude-<uid>/…/tasks/*.output`),
  not in `~/.claude/projects`. That path is undocumented and version-dependent, so
  discovery is best-effort: if it moves, subagent capture goes quiet and
  main-thread capture carries on. It's also **ephemeral**, cleared on reboot,
  which is why the `Stop` hook captures a session's subagents immediately instead
  of waiting for the timer.
- On macOS the temp root is `/private/tmp/claude-<uid>`, which is **not** what
  `os.tmpdir()` returns (that's the `/var/folders/…` sandbox). `lib/discover.mjs`
  probes both; don't "simplify" it to one.
- The transcript JSONL schema is undocumented and version-dependent, so the mapper
  stores the **full redacted line** as `content` and projects known fields
  (`role`, `type`, `model`, `cwd`, `git_branch`, `repo`, `ts`, `is_sidechain`,
  `agent_id`) into columns.
- `repo` is the normalized git remote (`host/owner/repo`) of the session's `cwd`,
  resolved once per cwd, so worktrees and every clone roll up to the real project.
- Tests: `npm run test:plugins` (or `node --test plugins/caliber-analysis/test/*.test.mjs`).
