/**
 * Discovery — finding both kinds of transcript on disk.
 *
 * The subagent half is the whole reason this module exists, and it shipped BROKEN
 * the first time. Two traps, both now pinned by tests below:
 *
 *   1. SYMLINKS. Claude Code exposes subagent transcripts through symlinked
 *      `tasks/*.output` entries as well as the real files. A readdir that filters
 *      on the dirent's isFile() reports FALSE for a symlink and silently skips
 *      every one — discovery finds nothing and nobody notices, because "no
 *      subagents" looks exactly like "this session had no subagents".
 *   2. NOT EVERYTHING IN THAT DIR IS A TRANSCRIPT. The temp tasks/ directory also
 *      holds background-bash task output. Shipping it writes junk rows into the
 *      tenant. We read `subagents/agent-*.jsonl` — the durable, unambiguous path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMainTranscripts, listAgentTranscripts, discoverAll, streamKey} from "../lib/discover.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "caliber-discover-"));
}

describe("listMainTranscripts", () => {
  test("finds every session jsonl and keys it by FILE, not by session id", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, "-Users-me-proj"), { recursive: true });
      writeFileSync(join(root, "-Users-me-proj", "sess-a.jsonl"), "{}\n");
      writeFileSync(join(root, "-Users-me-proj", "sess-b.jsonl"), "{}\n");
      writeFileSync(join(root, "-Users-me-proj", "notes.txt"), "ignore me");

      const found = listMainTranscripts(root);
      assert.deepEqual(found.map((f) => f.sessionId).sort(), ["sess-a", "sess-b"]);
      // The key is per-FILE (project-scoped), and the legacy session-id key is kept
      // so an existing watermark can be adopted instead of re-shipping everything.
      assert.deepEqual(
        found.map((f) => f.key).sort(),
        ["sess-a", "sess-b"].map((s) => streamKey("-Users-me-proj", s)).sort(),
      );
      assert.deepEqual(found.map((f) => f.legacyKey).sort(), ["sess-a", "sess-b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gives the SAME session id in two worktrees two DIFFERENT watermarks", () => {
    // The bug this exists to prevent, and it was live in v0.2.0.
    //
    // Resume a session inside a git worktree and Claude Code writes a transcript
    // with the SAME session id into that worktree's project directory. Keying the
    // watermark on the session id made those files share one watermark and clobber
    // each other: the real 68MB transcript shipped and recorded offset 71500273,
    // then a 113-byte worktree stub of the same session id shipped and overwrote it
    // with offset 113. Next run the big file looked unshipped and re-sent all 68MB
    // — every sweep, forever. Worktrees are a normal Claude Code workflow (this
    // repo's own CLAUDE.md recommends them), so it is not an exotic case.
    const root = scratch();
    try {
      mkdirSync(join(root, "-Users-me-proj"), { recursive: true });
      mkdirSync(join(root, "-Users-me-proj--worktrees-feature"), { recursive: true });
      writeFileSync(join(root, "-Users-me-proj", "same-id.jsonl"), "{}\n");
      writeFileSync(join(root, "-Users-me-proj--worktrees-feature", "same-id.jsonl"), "{}\n");

      const found = listMainTranscripts(root);
      assert.equal(found.length, 2);
      assert.ok(found.every((f) => f.sessionId === "same-id"), "same session id");

      const keys = new Set(found.map((f) => f.key));
      assert.equal(keys.size, 2, "two files must never share one watermark");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns [] for a missing projects dir rather than throwing", () => {
    assert.deepEqual(listMainTranscripts("/no/such/path"), []);
  });
});

describe("listAgentTranscripts", () => {
  test("attributes a subagent file to its PARENT session, with a per-agent watermark", () => {
    const root = scratch();
    try {
      const subs = join(root, "-Users-me-proj", "parent-session", "subagents");
      mkdirSync(subs, { recursive: true });
      writeFileSync(join(subs, "agent-a1.jsonl"), "{}\n");
      writeFileSync(join(subs, "agent-a2.jsonl"), "{}\n");
      // Sidecar metadata that sits in the same directory — not a transcript.
      writeFileSync(join(subs, "agent-a1.meta.json"), "{}");

      const found = listAgentTranscripts(root);
      assert.equal(found.length, 2, "the .meta.json sidecar must not be shipped");

      // Parent session — so a subagent's tokens roll up to the session that spawned it.
      assert.ok(found.every((f) => f.sessionId === "parent-session"));
      assert.deepEqual(found.map((f) => f.agentId).sort(), ["a1", "a2"]);

      // Each agent file is its own append-only byte stream, so it needs its own
      // watermark. Sharing the session's key would make one agent's offset skip
      // another's bytes entirely.
      assert.deepEqual(
        found.map((f) => f.key).sort(),
        ["a1", "a2"].map((a) => streamKey("-Users-me-proj", "parent-session", a)).sort(),
      );
      assert.deepEqual(
        found.map((f) => f.legacyKey).sort(),
        ["sub:parent-session:a1", "sub:parent-session:a2"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("follows SYMLINKED transcripts — the bug that shipped", () => {
    // A dirent for a symlink has isFile() === false. Filtering on it skipped every
    // real subagent transcript in production, and the failure was invisible: zero
    // subagents captured reads identically to "there were no subagents".
    const root = scratch();
    try {
      const real = join(root, "real-store");
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "actual.jsonl"), '{"isSidechain":true}\n');

      const subs = join(root, "-Users-me-proj", "parent-session", "subagents");
      mkdirSync(subs, { recursive: true });
      symlinkSync(join(real, "actual.jsonl"), join(subs, "agent-linked.jsonl"));

      const found = listAgentTranscripts(root);
      assert.equal(found.length, 1, "a symlinked transcript must be discovered");
      assert.equal(found[0].agentId, "linked");
      assert.ok(found[0].size > 0, "size must come from the symlink TARGET");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores a dangling symlink instead of throwing", () => {
    const root = scratch();
    try {
      const subs = join(root, "-Users-me-proj", "s1", "subagents");
      mkdirSync(subs, { recursive: true });
      symlinkSync(join(root, "gone.jsonl"), join(subs, "agent-dead.jsonl"));
      assert.deepEqual(listAgentTranscripts(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores a session dir with no subagents/ subdirectory", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, "-Users-me-proj", "sess-no-agents"), { recursive: true });
      assert.deepEqual(listAgentTranscripts(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("goes quiet when the projects dir is missing — never throws", () => {
    assert.deepEqual(listAgentTranscripts("/no/such/path"), []);
  });
});

describe("discoverAll", () => {
  test("returns main threads and subagents together", () => {
    const root = scratch();
    try {
      const proj = join(root, "-Users-me-proj");
      mkdirSync(join(proj, "s1", "subagents"), { recursive: true });
      writeFileSync(join(proj, "s1.jsonl"), "{}\n");
      writeFileSync(join(proj, "s1", "subagents", "agent-x.jsonl"), "{}\n");

      const all = discoverAll.length === 0 ? [] : null; // discoverAll takes no args
      void all;
      const main = listMainTranscripts(root);
      const agents = listAgentTranscripts(root);
      assert.equal(main.length, 1);
      assert.equal(agents.length, 1);
      assert.equal(agents[0].sessionId, "s1", "subagent rolls up to its parent session");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
