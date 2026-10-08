/**
 * Self-contained unit tests for the Caliber Analysis plugin (node:test — no app
 * build needed). Run: `node --test plugins/caliber-analysis/test/`.
 *
 * Covers the parts that must be right: secret redaction, line→row mapping +
 * uuid fallback, and the watermark/batching logic that makes shipping
 * at-least-once and idempotent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { redactString, redactDeep } from "../lib/redact.mjs";
import { mapLine, stableId, sliceCompleteLines, parseLines } from "../lib/transcript.mjs";
import { shipFromBuffer, readOffset, writeOffset, ingestRetryDelayMs } from "../lib/ship.mjs";
import { CAPTURE_EPOCH } from "../lib/config.mjs";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("redactString masks high-confidence secret shapes", () => {
  const cases = [
    "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX",
    "clbi_AbCdEfGhIjKlMnOpQrStUvWx",
    "ghp_0123456789012345678901234567890123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  ];
  for (const c of cases) {
    assert.match(redactString(c), /\[REDACTED:/, `should redact: ${c}`);
  }
  // PEM block
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactString(pem), "[REDACTED:private-key]");
});

test("redactString is a no-op on ordinary code/prose (no false positives)", () => {
  const benign = "const total = items.reduce((a, b) => a + b, 0); // sum the cart";
  assert.equal(redactString(benign), benign);
  assert.equal(redactString("git checkout -b feat/foo origin/main"), "git checkout -b feat/foo origin/main");
});

test("redactDeep recurses through nested objects and arrays", () => {
  const input = {
    role: "user",
    content: [{ type: "text", text: "token clbi_AbCdEfGhIjKlMnOpQrStUvWx here" }],
    meta: { nested: { key: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV" } },
    n: 42,
  };
  const out = redactDeep(input);
  assert.match(out.content[0].text, /\[REDACTED:caliber-token\]/);
  assert.match(out.meta.nested.key, /\[REDACTED:anthropic-key\]/);
  assert.equal(out.n, 42);
  // original is untouched (new structure returned)
  assert.match(input.meta.nested.key, /^sk-ant-/);
});

test("mapLine projects envelope fields and stores the full redacted line", () => {
  const line = {
    type: "user",
    uuid: "u1",
    parentUuid: "p0",
    sessionId: "s9",
    cwd: "/repo",
    gitBranch: "main",
    timestamp: "2026-06-28T10:00:00.000Z",
    message: { role: "user", content: "my key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV" },
  };
  const row = mapLine(line, "fallback");
  assert.equal(row.uuid, "u1");
  assert.equal(row.sessionId, "s9");
  assert.equal(row.role, "user");
  assert.equal(row.type, "user");
  assert.equal(row.ts, "2026-06-28T10:00:00.000Z");
  // content is the full line, redacted
  assert.match(JSON.stringify(row.content), /\[REDACTED:anthropic-key\]/);
  assert.doesNotMatch(JSON.stringify(row.content), /sk-ant-api03-ABCDEF/);
});

test("mapLine resolves repo from the line's cwd via repoFor (null when no cwd)", () => {
  const repoFor = (cwd) => (cwd === "/work/proj" ? "github.com/acme/proj" : null);
  const withCwd = mapLine({ uuid: "u1", cwd: "/work/proj" }, "fb", repoFor);
  assert.equal(withCwd.repo, "github.com/acme/proj");

  // No cwd → repoFor isn't consulted → null. Default repoFor is a no-op.
  assert.equal(mapLine({ uuid: "u2" }, "fb", repoFor).repo, null);
  assert.equal(mapLine({ uuid: "u3", cwd: "/work/proj" }, "fb").repo, null);
});

test("mapLine falls back to a deterministic id when the line has no uuid", () => {
  const line = { type: "pr-link", prNumber: 521, sessionId: "s9", timestamp: "2026-06-28T10:00:00Z" };
  const row = mapLine(line, "fallback");
  assert.match(row.uuid, /^h:/);
  // same line → same id (idempotent re-ship); different line → different id
  assert.equal(row.uuid, stableId(line));
  assert.notEqual(stableId(line), stableId({ ...line, prNumber: 522 }));
});

test("mapLine uses the fallback sessionId only when the line omits one", () => {
  assert.equal(mapLine({ uuid: "x" }, "fb").sessionId, "fb");
  assert.equal(mapLine({ uuid: "x", sessionId: "real" }, "fb").sessionId, "real");
});

test("a subagent line ships under its PARENT session, carrying its provenance in content", () => {
  // A line from <tmp>/claude-<uid>/<project>/<session>/tasks/<agentId>.output.
  // Its sessionId is the session that SPAWNED the agent — that's what makes a
  // subagent's tokens and tool calls roll up to the right session.
  const line = {
    uuid: "sub-1",
    sessionId: "parent-session",
    agentId: "a913990626273cbce",
    isSidechain: true,
    message: { role: "assistant", model: "claude-opus-4-8" },
  };
  const row = mapLine(line, "fallback");

  assert.equal(row.sessionId, "parent-session");

  // isSidechain/agentId are NOT projected onto the wire — `content` is the whole
  // line, so the server derives them at insert. That's what lets an old plugin
  // version still get subagent support. Assert they survive in content, because
  // if redaction or mapping ever dropped them, the server would silently start
  // counting subagent lines as human turns.
  assert.equal(row.content.isSidechain, true);
  assert.equal(row.content.agentId, "a913990626273cbce");
  assert.equal(row.isSidechain, undefined);
  assert.equal(row.agentId, undefined);
});

test("parseLines drops non-object lines that merely happen to be valid JSON", () => {
  // We shipped `"alert.fired"` into a live tenant this way: a line of grep output
  // from a file that was never a transcript. It parses as valid JSON (a string),
  // and without this guard it becomes a row with null role/type that looks real.
  const parsed = parseLines([
    '{"uuid":"u1","type":"user"}',
    '"alert.fired"',
    "42",
    "null",
    "[1,2]",
    "not json",
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].line.uuid, "u1");
});

test("sliceCompleteLines reports each line's byte offset, utf-8 aware", () => {
  // Offsets must be in BYTES, not chars — a multi-byte prompt would otherwise
  // shift every subsequent line and silently corrupt the restored order.
  const text = '{"a":"\u00e9\u00e9"}\n{"b":2}\n';
  const { lines, offsets, consumedBytes } = sliceCompleteLines(text);
  assert.equal(lines.length, 2);
  assert.equal(offsets[0], 0);
  // "é" is 2 bytes each: {"a":"éé"} = 10 chars but 12 bytes, + '\n' = 13.
  assert.equal(offsets[1], Buffer.byteLength('{"a":"\u00e9\u00e9"}', "utf8") + 1);
  assert.equal(consumedBytes, Buffer.byteLength(text, "utf8"));
});

test("parseLines carries absolute file offsets, and keeps them aligned when it DROPS a line", () => {
  // The alignment is the whole point: parseLines drops bad lines, so an index
  // into its OUTPUT no longer matches its INPUT. Carrying the offset alongside
  // each line is what stops a dropped line from shifting the order of the rest.
  const lines = ['{"uuid":"a"}', '"junk"', '{"uuid":"b"}'];
  const offsets = [0, 13, 21];
  const parsed = parseLines(lines, offsets, 1000); // chunk starts at byte 1000
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].line.uuid, "a");
  assert.equal(parsed[0].fileOffset, 1000);
  assert.equal(parsed[1].line.uuid, "b");
  assert.equal(parsed[1].fileOffset, 1021, "the dropped junk line must not shift b's offset");
});

test("mapLine carries fileOffset onto the wire row (null when unknown)", () => {
  assert.equal(mapLine({ uuid: "x" }, "fb", () => null, 4096).fileOffset, 4096);
  assert.equal(mapLine({ uuid: "x" }, "fb").fileOffset, null);
});

test("sliceCompleteLines holds back a partial trailing line", () => {
  const whole = '{"a":1}\n{"b":2}\n';
  const r1 = sliceCompleteLines(whole);
  assert.equal(r1.lines.length, 2);
  assert.equal(r1.consumedBytes, Buffer.byteLength(whole));

  const partial = '{"a":1}\n{"b":2'; // second line not yet flushed
  const r2 = sliceCompleteLines(partial);
  assert.deepEqual(r2.lines, ['{"a":1}']);
  assert.equal(r2.consumedBytes, Buffer.byteLength('{"a":1}\n'));
});

test("sliceCompleteLines caps the batch and counts only the bytes it took", () => {
  const text = '{"a":1}\n{"b":2}\n{"c":3}\n';
  const r = sliceCompleteLines(text, 2);
  assert.equal(r.lines.length, 2);
  assert.equal(r.consumedBytes, Buffer.byteLength('{"a":1}\n{"b":2}\n'));
});

// --- watermark / idempotency via shipFromBuffer ---

function transcript(lines, { trailingNewline = true } = {}) {
  const body = lines.map((l) => JSON.stringify(l)).join("\n");
  return Buffer.from(trailingNewline ? body + "\n" : body, "utf8");
}

const okPost = (sink) => async (messages) => {
  sink.push(...messages);
  return { ok: true, status: 200 };
};

test("shipFromBuffer ships all complete lines and advances the offset to EOF", async () => {
  const buf = transcript([
    { type: "user", uuid: "u1", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "u2", message: { role: "assistant", content: [] } },
  ]);
  const sink = [];
  const res = await shipFromBuffer(buf, 0, "s", okPost(sink));
  assert.equal(res.shipped, 2);
  assert.equal(res.offset, buf.length);
  assert.deepEqual(sink.map((m) => m.uuid), ["u1", "u2"]);
});

test("shipFromBuffer ships nothing when the offset is already at EOF", async () => {
  const buf = transcript([{ uuid: "u1" }]);
  const sink = [];
  const res = await shipFromBuffer(buf, buf.length, "s", okPost(sink));
  assert.equal(res.shipped, 0);
  assert.equal(sink.length, 0);
});

test("ingestRetryDelayMs honors Retry-After seconds and defaults to 2s", () => {
  assert.equal(ingestRetryDelayMs("2"), 2000);
  assert.equal(ingestRetryDelayMs("1.5"), 1500);
  assert.equal(ingestRetryDelayMs("0"), 0);
  assert.equal(ingestRetryDelayMs(null), 2000);
  assert.equal(ingestRetryDelayMs("nope"), 2000);
  assert.equal(ingestRetryDelayMs("999"), 30000);
});

test("shipFromBuffer does NOT advance the offset when the POST fails (retry next turn)", async () => {
  const buf = transcript([{ uuid: "u1", message: { role: "user", content: "x" } }]);
  const failPost = async () => ({ ok: false, status: 500 });
  const res = await shipFromBuffer(buf, 0, "s", failPost);
  assert.equal(res.shipped, 0);
  assert.equal(res.offset, 0); // watermark held → at-least-once
  assert.ok(res.lastError);
});

test("shipFromBuffer re-ships from 0 when the file was rotated/truncated", async () => {
  const buf = transcript([{ uuid: "u1" }, { uuid: "u2" }]);
  const sink = [];
  // startOffset beyond EOF ⇒ the previous file is gone; re-ship everything.
  const res = await shipFromBuffer(buf, buf.length + 999, "s", okPost(sink));
  assert.equal(res.shipped, 2);
  assert.equal(res.offset, buf.length);
});

test("shipFromBuffer only advances over the flushed prefix on a partial tail", async () => {
  const buf = transcript(
    [
      { uuid: "u1", message: { role: "user", content: "a" } },
      { uuid: "u2", message: { role: "assistant", content: "b" } },
    ],
    { trailingNewline: false },
  );
  const sink = [];
  const res = await shipFromBuffer(buf, 0, "s", okPost(sink));
  assert.equal(res.shipped, 1); // u2's line isn't newline-terminated yet
  assert.deepEqual(sink.map((m) => m.uuid), ["u1"]);
  assert.ok(res.offset < buf.length);
});

// ---------------------------------------------------------------------------
// Capture epoch — the one-time re-ship that recovers history.
//
// A watermark says "shipped up to byte N", so a fix to WHAT we capture reaches new
// lines only. When the bug was in what we STORED (ingest dropped 19-57% of every
// file's lines), the history already past the watermark is unreachable forever
// unless the watermark is invalidated. That is what the epoch does — and it must
// fire exactly once, or a laptop re-ships its entire history on every single run.
// ---------------------------------------------------------------------------

test("readOffset re-captures a stream written by an older epoch", () => {
  const p = join(tmpdir(), `caliber-epoch-${randomUUID()}.json`);

  // A watermark from the epoch-1 plugin: no epoch field at all.
  writeFileSync(p, JSON.stringify({ offset: 68_000_000 }));
  assert.equal(readOffset(p), 0, "a stale watermark must re-ship from the start");

  // An explicitly older epoch is just as stale.
  writeFileSync(p, JSON.stringify({ offset: 500, epoch: CAPTURE_EPOCH - 1 }));
  assert.equal(readOffset(p), 0);

  rmSync(p, { force: true });
});

test("the re-capture fires ONCE — progress stamps the epoch and resumes", () => {
  const p = join(tmpdir(), `caliber-epoch-${randomUUID()}.json`);
  writeFileSync(p, JSON.stringify({ offset: 900 })); // legacy

  assert.equal(readOffset(p), 0); // first run: start over

  // The ship makes progress and stamps the current epoch.
  writeOffset(p, 400);

  // Second run resumes from where the re-capture got to — it does NOT start over.
  // Getting this wrong means every sweeper run re-ships the whole file, forever.
  assert.equal(readOffset(p), 400);

  rmSync(p, { force: true });
});

test("a re-capture that ships nothing is retried, not abandoned", () => {
  // The server is down: shipFile writes no watermark (offset never moved), so the
  // stale epoch survives and the stream is still due for re-capture next run.
  const p = join(tmpdir(), `caliber-epoch-${randomUUID()}.json`);
  writeFileSync(p, JSON.stringify({ offset: 900 }));

  assert.equal(readOffset(p), 0);
  assert.equal(readOffset(p), 0); // nothing written in between → still re-captures

  rmSync(p, { force: true });
});

test("a corrupt or missing state file ships from the start", () => {
  const p = join(tmpdir(), `caliber-epoch-${randomUUID()}.json`);
  assert.equal(readOffset(p), 0, "missing");
  writeFileSync(p, "{not json");
  assert.equal(readOffset(p), 0, "corrupt");
  writeFileSync(p, JSON.stringify({ offset: -5, epoch: CAPTURE_EPOCH }));
  assert.equal(readOffset(p), 0, "nonsense offset");
  rmSync(p, { force: true });
});

test("sliceCompleteLines caps a batch by BYTES, not just line count", () => {
  // 2,000 lines of chat is small; 2,000 lines of big assistant messages is 5.5MB,
  // which cannot be uploaded AND ingested inside the 4s POST budget. The timeout
  // does not land evenly — it lands on the LARGEST sessions, i.e. the ones with the
  // most history to recover, which then retry forever and never ship a byte.
  const big = JSON.stringify({ type: "assistant", text: "x".repeat(10_000) });
  const text = Array.from({ length: 50 }, () => big).join("\n") + "\n";

  const { lines, consumedBytes } = sliceCompleteLines(text, 2000, 50_000);

  assert.ok(lines.length < 50, "must stop well before the line cap");
  assert.ok(consumedBytes <= 60_000, `consumed ${consumedBytes}B, expected ~<=50KB`);
  // consumedBytes must still be a truthful file position, so the next batch resumes
  // exactly where this one stopped — an over-count here silently skips lines.
  assert.equal(consumedBytes, lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0));
});

test("a single line larger than the byte cap still ships (no stall)", () => {
  // Otherwise one oversized line wedges the stream behind a batch that can never
  // fit, and the session stops shipping forever.
  const huge = JSON.stringify({ type: "assistant", text: "x".repeat(200_000) });
  const { lines } = sliceCompleteLines(huge + "\n", 2000, 1000);
  assert.equal(lines.length, 1);
});

test("the plugin registers only the Stop capture hook, and its script exists", async () => {
  // Capture only: no SessionStart notice in the user's session or the model context,
  // and no brain hooks. A hook whose script is missing fails on every turn.
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { hooks } = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks), ["Stop"]);
  const commands = hooks.Stop.flatMap((h) => h.hooks.map((x) => x.command));
  assert.deepEqual(commands, ["node ${CLAUDE_PLUGIN_ROOT}/bin/on-stop.mjs"]);
  for (const c of commands) {
    assert.ok(existsSync(join(root, c.split("${CLAUDE_PLUGIN_ROOT}/")[1])), `${c} points at a missing file`);
  }
});
