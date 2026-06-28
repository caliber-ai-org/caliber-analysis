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
import { mapLine, stableId, sliceCompleteLines } from "../lib/transcript.mjs";
import { shipFromBuffer } from "../lib/ship.mjs";

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
