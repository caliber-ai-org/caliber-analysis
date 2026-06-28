/**
 * End-to-end transport test for the shipper: runs ship.mjs against a local mock
 * server in an isolated $HOME, exercising the real fetch, redaction-in-transit,
 * auth header, request shape, watermark persistence, and client-side
 * idempotency. No production contact — the server-side insert is covered by
 * tests/integration/transcript-ingest.test.ts.
 *
 * Run: node --test plugins/caliber-analysis/test/ship-http.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const shipScript = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "ship.mjs");

function startMock() {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: parsed });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, stored: parsed.messages.length, deduped: 0 }));
    });
  });
  return { server, received };
}

function isolatedHome(endpoint) {
  const home = mkdtempSync(join(tmpdir(), "pc-home-"));
  mkdirSync(join(home, ".caliber"), { recursive: true });
  writeFileSync(
    join(home, ".caliber", "capture.json"),
    JSON.stringify({ endpoint, email: "test@example.com", token: "clbi_testtoken" }),
  );
  return home;
}

// Async spawn — must NOT block the parent event loop, or the in-process mock
// server can't answer the child's request (the child would just time out).
function runShip(home, transcriptPath, session) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [shipScript, "--transcript", transcriptPath, "--session", session],
      { env: { ...process.env, HOME: home } },
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("exit", (status) => resolve({ status, stderr }));
  });
}

test("ship.mjs POSTs redacted messages, then dedupes a re-run via the watermark", async () => {
  const { server, received } = startMock();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const home = isolatedHome(`http://127.0.0.1:${port}`);

  const sid = "e2e-http-1";
  const transcriptPath = join(home, "transcript.jsonl");
  const lines = [
    {
      type: "user", uuid: "u1", sessionId: sid, cwd: "/repo", gitBranch: "main",
      timestamp: "2026-06-28T11:00:00.000Z",
      message: { role: "user", content: "ship with sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234567890" },
    },
    {
      type: "assistant", uuid: "a1", sessionId: sid,
      message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "never paste live keys" }] },
    },
  ];
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  try {
    const r1 = await runShip(home, transcriptPath, sid);
    assert.equal(r1.status, 0, r1.stderr);

    assert.equal(received.length, 1, "one POST");
    const req = received[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/ingest/claude-code/transcript");
    assert.equal(req.auth, "Bearer clbi_testtoken");
    assert.equal(req.body.email, "test@example.com");
    assert.equal(req.body.messages.length, 2);
    // redacted in transit — the fake key never reaches the wire
    assert.match(JSON.stringify(req.body.messages[0].content), /\[REDACTED:anthropic-key\]/);
    assert.doesNotMatch(JSON.stringify(req.body), /sk-ant-api03-FAKE/);

    // watermark persisted
    assert.ok(existsSync(join(home, ".caliber", "capture-state", sid + ".json")));

    // re-run: nothing new past the watermark → no second POST
    const r2 = await runShip(home, transcriptPath, sid);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(received.length, 1, "no duplicate POST on re-run");
  } finally {
    server.close();
  }
});

test("ship.mjs holds the watermark when the endpoint rejects (retry next turn)", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(500);
      res.end("nope");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const home = isolatedHome(`http://127.0.0.1:${port}`);

  const sid = "e2e-http-fail";
  const transcriptPath = join(home, "t.jsonl");
  writeFileSync(transcriptPath, JSON.stringify({ uuid: "u1", sessionId: sid, message: { role: "user", content: "x" } }) + "\n");

  try {
    const r = await runShip(home, transcriptPath, sid);
    assert.equal(r.status, 0, r.stderr);
    // 500 ⇒ watermark NOT written, so the next turn re-ships
    assert.equal(existsSync(join(home, ".caliber", "capture-state", sid + ".json")), false);
  } finally {
    server.close();
  }
});
