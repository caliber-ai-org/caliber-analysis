/**
 * The on-laptop distiller pipeline. Three things must hold or the feature misbehaves on the
 * user's machine and their quota:
 *   1. PARITY — the .mjs ports must produce the SAME gate/signal as the platform TS oracle,
 *      pinned by the same Dov golden fixture. If a port drifts, a session that should teach
 *      a lesson is silently dropped (or vice-versa).
 *   2. SAFETY — a page that asserts external state, leaks a secret, or writes a volatile
 *      number down is DROPPED; and the deterministic render is well-formed.
 *   3. LOOP CONTAINMENT — the distiller's own `claude -p` child (sentinel-prefixed) scores 0
 *      human turns and is gated out, so it can never distill itself and drain the quota.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEvidence } from "../lib/extract.mjs";
import { verdict } from "../lib/gate.mjs";
import { applyPlan } from "../lib/apply.mjs";
import { renderBrainFiles, renderPage, parsePageFile } from "../lib/render.mjs";
import { readLocalPages, mergePages, writeLocalBrain } from "../lib/store.mjs";

const TODAY = "2026-07-16";

// ---- 1. Parity vs the platform golden fixture -------------------------------
const GOLDEN = join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "dov_golden.json");
const DOV_DIR = "/Users/yanivbh/Downloads/dov sessions";

function loadSession(prefix8) {
  if (!existsSync(DOV_DIR)) return null;
  for (const dir of readdirSync(DOV_DIR)) {
    const p = join(DOV_DIR, dir);
    let files = [];
    try { files = readdirSync(p); } catch { continue; }
    const f = files.find((x) => x.startsWith(prefix8) && x.endsWith(".jsonl"));
    if (f) {
      return readFileSync(join(p, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  }
  return null;
}

describe("parity — .mjs ports match the TS golden fixture", () => {
  const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : [];
  for (const g of golden) {
    test(`${g.session}: gate=${g.gate_pass} signal=${g.signal}`, (t) => {
      const lines = loadSession(g.session);
      if (!lines) { t.skip("Dov session files not present on this machine"); return; }
      const e = extractEvidence(lines);
      assert.equal(e.humanTurns.length, g.human_turns, "human turns");
      assert.equal(e.corrections.length, g.corrections, "corrections");
      assert.equal(e.interrupts, g.interrupts, "interrupts");
      assert.equal(e.snapBacks.length, g.snap_backs, "snap-backs");
      assert.equal(e.confirmations.length, g.confirmations, "confirmations");
      assert.equal(e.signal, g.signal, "signal");
      assert.equal(verdict(e).pass, g.gate_pass, "gate");
    });
  }
  test("fixture is present (contract recorded even when Dov files absent)", (t) => {
    // The golden fixture lives in caliber-platform/tests/fixtures — present when this test
    // runs inside caliber-platform, absent in the standalone published plugin repo. Skip
    // rather than fail there; the parity contract is asserted where the fixture exists.
    if (!existsSync(GOLDEN)) { t.skip("golden fixture only present inside caliber-platform"); return; }
    assert.ok(golden.length >= 1);
  });
});

// ---- 2. Safety: apply guards + render --------------------------------------
describe("apply — drops unsafe pages, keeps clean ones", () => {
  const plan = (ops) => ({ trivial: false, ops });

  test("keeps a clean lesson with When/Then + evidence; drops external-state/secret/volatile", () => {
    const out = applyPlan(
      plan([
        { op: "create", name: "run linter", class: "lesson", scope: "repo", repo: "caliber-platform", description: "Run the linter first.", trigger: "editing", action: "lint", body: "Keeps churn down.", evidence: ["you didn't lint again"], reason: "correction" },
        { op: "create", name: "po bug", class: "project", description: "PO bug", body: "Tasks #2635 and #2636 — resolved.", reason: "x" },
        { op: "create", name: "leak", class: "entity", description: "d", body: "ANTHROPIC_API_KEY=sk-ant-abcdefghij0123456789KLMNOP", reason: "x" },
        { op: "create", name: "count", class: "fact", description: "open tasks", body: "There are 137 open tasks.", volatility: "volatile", refresh_cmd: "mcp__x__y", reason: "x" },
      ]),
      { today: TODAY },
    );
    assert.deepEqual(out.writes.map((w) => w.slug), ["lesson-run-linter"]);
    assert.ok(out.writes[0].body.startsWith("**When** editing\n**Then** lint"));
    assert.ok(out.writes[0].body.includes("**Evidence"));
    const reasons = out.skipped.map((s) => s.why).join(" | ");
    assert.match(reasons, /external state/);
    assert.match(reasons, /secret/);
    assert.match(reasons, /bare number/);
  });
});

describe("render — derived layout + fact banners", () => {
  const page = (p) => ({ slug: p.slug, pageClass: p.pageClass ?? "lesson", scope: p.scope ?? "global", repo: p.repo ?? null, description: p.description ?? "d", body: p.body ?? "b", volatility: p.volatility ?? null, refreshCmd: p.refreshCmd ?? null, observedAt: p.observedAt ?? TODAY });

  test("MEMORY.md inlines the manual + routes repo pages to a map", () => {
    const files = renderBrainFiles([
      page({ slug: "lesson-global-x", scope: "global", description: "A global rule." }),
      page({ slug: "lesson-repo-y", scope: "repo", repo: "caliber-platform", description: "A repo rule." }),
    ], TODAY);
    assert.match(files["MEMORY.md"], /Operating manual/);
    assert.match(files["MEMORY.md"], /NEVER record the state/);
    assert.match(files["MEMORY.md"], /- \[global x\]\(lesson-global-x\.md\) — A global rule\./);
    assert.match(files["MEMORY.md"], /map-caliber-platform\.md/);
    assert.ok(files["map-caliber-platform.md"].includes("lesson-repo-y.md"));
  });

  test("fact banner is fresh SNAPSHOT vs STALE by observed_at", () => {
    assert.match(renderPage(page({ slug: "fact-a", pageClass: "fact", volatility: "slow", refreshCmd: "mcp__x__y", observedAt: "2026-07-10" }), TODAY), /\[!info\] SNAPSHOT/);
    assert.match(renderPage(page({ slug: "fact-b", pageClass: "fact", volatility: "volatile", refreshCmd: "mcp__x__y", observedAt: "2026-07-01" }), TODAY), /\[!danger\] STALE/);
  });
});

// ---- store round-trip -------------------------------------------------------
describe("store — read/merge/write the local brain", () => {
  test("writeLocalBrain → readLocalPages round-trips; merge upserts and retires", () => {
    const dir = mkdtempSync(join(tmpdir(), "caliber-store-"));
    try {
      const writes = [
        { slug: "lesson-a", pageClass: "lesson", scope: "global", repo: null, description: "A.", body: "body a", confidence: "high", volatility: null, refreshCmd: null, observedAt: TODAY },
        { slug: "fact-b", pageClass: "fact", scope: "repo", repo: "r", description: "B.", body: "body b", confidence: "medium", volatility: "durable", refreshCmd: "mcp__x__y", observedAt: TODAY },
      ];
      writeLocalBrain(dir, writes, TODAY);
      const back = readLocalPages(dir).sort((a, b) => a.slug.localeCompare(b.slug));
      assert.deepEqual(back.map((p) => p.slug), ["fact-b", "lesson-a"]);
      assert.equal(back.find((p) => p.slug === "fact-b").refreshCmd, "mcp__x__y");

      // merge: upsert lesson-a, retire fact-b
      const merged = mergePages(back, [{ ...writes[0], description: "A2." }], [{ slug: "fact-b" }]);
      writeLocalBrain(dir, merged, TODAY);
      const files = readdirSync(dir);
      assert.ok(files.includes("lesson-a.md") && !files.includes("fact-b.md"));
      assert.equal(readLocalPages(dir)[0].description, "A2.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parsePageFile strips the fact banner from the body", () => {
    const rendered = renderPage({ slug: "fact-c", pageClass: "fact", scope: "global", repo: null, description: "C.", body: "the real body", volatility: "slow", refreshCmd: "mcp__x__y", observedAt: "2026-07-10" }, TODAY);
    const parsed = parsePageFile(rendered);
    assert.equal(parsed.body, "the real body");
    assert.equal(parsed.refreshCmd, "mcp__x__y");
  });
});

// ---- 3. Loop containment ----------------------------------------------------
describe("loop containment — the distiller never distills itself", () => {
  test("a sentinel-prefixed child transcript scores 0 human turns and is gated out", () => {
    const child = [
      { type: "user", message: { role: "user", content: "[[CALIBER-BRAIN-INTERNAL — this is the brain talking to itself; never ingest]]\n\nYou are the distiller... no don't wrong revert" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "X", input: {} }] } },
    ];
    const e = extractEvidence(child);
    assert.equal(e.humanTurns.length, 0);
    assert.equal(verdict(e).pass, false);
  });

  test("evidence quotes are redacted before storage (no secret into a page body)", () => {
    const lines = [
      { type: "user", message: { content: "no that's wrong, my key is sk-ant-abcdefghij0123456789KLMNOPqrstuv revert" } },
    ];
    const e = extractEvidence(lines);
    assert.ok(!JSON.stringify(e).includes("sk-ant-abcdefghij"), "raw anthropic key must not survive in evidence");
  });
});
