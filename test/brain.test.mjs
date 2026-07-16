/**
 * The brain's local half: value computation (used · saved) and the pull that reconciles
 * the on-disk brain to what Caliber returns.
 *
 * Two things that must hold or the feature lies to the user:
 *   1. A saved call is REAL — a fact page whose cached MCP tool was NOT invoked this
 *      session. If the tool WAS invoked, the cache saved nothing and must not be claimed.
 *   2. The pull never writes a page name it wasn't given cleanly — no path traversal, no
 *      spaces — even though the server only ever emits safe names.
 *
 * Runs with HOME pointed at a scratch dir so it touches no real ~/.caliber.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Point HOME at a scratch dir BEFORE importing the modules (config.mjs resolves
// CALIBER_DIR from homedir() at import time).
const ORIG_HOME = process.env.HOME;
const SCRATCH = mkdtempSync(join(tmpdir(), "caliber-brain-"));
process.env.HOME = SCRATCH;

const { sessionValue, countBrainPages } = await import("../lib/value.mjs");
const { pullBrain, BRAIN_DIR, newPagesFromLastPull } = await import("../lib/brain.mjs");

after(() => {
  process.env.HOME = ORIG_HOME;
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("value — used · saved", () => {
  before(() => {
    mkdirSync(BRAIN_DIR, { recursive: true });
    writeFileSync(
      join(BRAIN_DIR, "fact-schema.md"),
      `---\nname: fact-schema\nmetadata:\n  class: fact\n  refresh_cmd: "mcp__pg__describe users"\n---\nColumns.`,
    );
    writeFileSync(join(BRAIN_DIR, "lesson-x.md"), `---\nname: lesson-x\nmetadata:\n  class: lesson\n---\nRule.`);
  });

  test("counts a saved call only when the cached tool was NOT invoked", () => {
    const t1 = join(SCRATCH, "t1.jsonl");
    writeFileSync(
      t1,
      [
        `{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"tool_use","name":"Read","input":{"file_path":"${BRAIN_DIR}/fact-schema.md"}}]}}`,
        `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}`,
      ].join("\n"),
    );
    const v = sessionValue(t1, BRAIN_DIR);
    assert.deepEqual(v.used, ["fact-schema.md"]);
    assert.equal(v.calls_saved, 1);

    // Same read, but this time the tool WAS called → no saved call claimed.
    const t2 = join(SCRATCH, "t2.jsonl");
    writeFileSync(
      t2,
      [
        `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"${BRAIN_DIR}/fact-schema.md"}}]}}`,
        `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__pg__describe","input":{}}]}}`,
      ].join("\n"),
    );
    assert.equal(sessionValue(t2, BRAIN_DIR).calls_saved, 0);
  });

  test("countBrainPages excludes routers", () => {
    writeFileSync(join(BRAIN_DIR, "MEMORY.md"), "# router");
    writeFileSync(join(BRAIN_DIR, "map-repo.md"), "# map");
    assert.equal(countBrainPages(BRAIN_DIR), 2); // fact-schema + lesson-x only
  });
});

describe("pull — reconcile the on-disk brain", () => {
  test("non-destructive re-hydrate: fills gaps, keeps local pages, rejects unsafe names", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        enabled: true,
        activatedAt: "2026-07-10T00:00:00Z",
        files: { "MEMORY.md": "r", "lesson-a.md": "a", "fact-b.md": "b", "../evil.md": "x", "bad name.md": "y" },
      }),
    });
    try {
      const r = await pullBrain({ endpoint: "https://x", email: "a@b.c", token: "clbi_x" });
      assert.equal(r.enabled, true);
      const written = readdirSync(BRAIN_DIR).sort();
      // server pages we didn't have are written
      assert.ok(written.includes("lesson-a.md") && written.includes("fact-b.md"));
      // unsafe names never land
      assert.ok(!written.some((f) => f.includes("evil") || f.includes("bad ")));
      // the local page authored earlier is PRESERVED — pull is non-destructive on the
      // authoring device (the local distiller owns page contents, not the pull).
      assert.ok(written.includes("lesson-x.md"));
      assert.equal(newPagesFromLastPull() >= 2, true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("a disabled (non-pilot) response leaves the last-good brain untouched", async () => {
    const origFetch = globalThis.fetch;
    const before = readdirSync(BRAIN_DIR).sort();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ enabled: false }) });
    try {
      const r = await pullBrain({ endpoint: "https://x", email: "a@b.c", token: "clbi_x" });
      assert.equal(r.enabled, false);
      assert.deepEqual(readdirSync(BRAIN_DIR).sort(), before); // nothing wiped
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
