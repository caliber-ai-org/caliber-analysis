/**
 * Plugin health: failure tally in ~/.caliber/health.json and the throttled
 * report to /api/ingest/claude-code/health.
 *
 * Run: node --test plugins/caliber-analysis/test/health.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  classifyFailure,
  noteFailure,
  noteSuccess,
  readHealth,
  shouldReport,
  maybeReport,
  REPORT_INTERVAL_MS,
} from "../lib/health.mjs";

const shipScript = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "ship.mjs");
const tmpPath = () => join(mkdtempSync(join(tmpdir(), "pc-health-")), "health.json");
const config = { endpoint: "http://caliber.test", email: "dev@example.com", token: "clbi_x" };

test("classifyFailure maps transport and HTTP failures to server error kinds", () => {
  assert.equal(classifyFailure({ ok: false, status: 0, error: "AbortError" }), "timeout");
  assert.equal(classifyFailure({ ok: false, status: 0, error: "TypeError" }), "network");
  assert.equal(classifyFailure({ ok: false, status: 401 }), "auth_revoked");
  assert.equal(classifyFailure({ ok: false, status: 403 }), "forbidden");
  assert.equal(classifyFailure({ ok: false, status: 413 }), "bad_request");
  assert.equal(classifyFailure({ ok: false, status: 500 }), "server_error");
});

test("noteFailure tallies per kind; noteSuccess clears the tally", () => {
  const path = tmpPath();
  noteFailure("network", "TypeError", { path });
  noteFailure("network", "TypeError", { path });
  noteFailure("timeout", "AbortError", { path });
  const h = readHealth(path);
  assert.equal(h.errors.network.count, 2);
  assert.equal(h.errors.timeout.count, 1);
  noteSuccess({ path });
  assert.deepEqual(readHealth(path).errors, {});
});

test("shouldReport only with errors, and at most once per interval", () => {
  const now = Date.now();
  assert.equal(shouldReport({ errors: {}, lastReportAt: null }, now), false);
  const errors = { network: { count: 1, last_at: new Date(now).toISOString() } };
  assert.equal(shouldReport({ errors, lastReportAt: null }, now), true);
  assert.equal(shouldReport({ errors, lastReportAt: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(
    shouldReport({ errors, lastReportAt: new Date(now - REPORT_INTERVAL_MS).toISOString() }, now),
    true,
  );
});

test("maybeReport sends the tally once, clears it on 2xx, and throttles the next one", async () => {
  const path = tmpPath();
  noteFailure("network", "TypeError", { path });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return { ok: true };
  };
  assert.equal(await maybeReport(config, { path, fetchImpl }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://caliber.test/api/ingest/claude-code/health");
  assert.equal(calls[0].auth, "Bearer clbi_x");
  assert.equal(calls[0].body.email, "dev@example.com");
  assert.equal(calls[0].body.errors[0].kind, "network");
  assert.equal(calls[0].body.errors[0].count, 1);
  assert.match(String(calls[0].body.version), /^\d+\.\d+\.\d+/);
  assert.deepEqual(readHealth(path).errors, {});

  noteFailure("network", "TypeError", { path });
  assert.equal(await maybeReport(config, { path, fetchImpl }), false, "throttled");
  assert.equal(calls.length, 1);
});

test("maybeReport keeps the tally when the report itself fails", async () => {
  const path = tmpPath();
  noteFailure("timeout", "AbortError", { path });
  const ok = await maybeReport(config, {
    path,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(ok, false);
  assert.equal(readHealth(path).errors.timeout.count, 1);
});

test("ship.mjs on a 500: tallies the failure and reports it to the health endpoint", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, body: JSON.parse(body) });
      if (req.url === "/api/ingest/claude-code/transcript") {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const home = mkdtempSync(join(tmpdir(), "pc-home-"));
  mkdirSync(join(home, ".caliber"), { recursive: true });
  writeFileSync(
    join(home, ".caliber", "capture.json"),
    JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, email: "dev@example.com", token: "clbi_x" }),
  );
  const sid = "health-e2e";
  const transcriptPath = join(home, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: "user", uuid: "u1", sessionId: sid, message: { role: "user", content: "hi" } }) + "\n",
  );

  try {
    const status = await new Promise((resolve) => {
      const child = spawn(process.execPath, [shipScript, "--transcript", transcriptPath, "--session", sid], {
        env: { ...process.env, HOME: home },
      });
      child.on("exit", resolve);
    });
    assert.equal(status, 0);
    const report = hits.find((h) => h.url === "/api/ingest/claude-code/health");
    assert.ok(report, "health report sent");
    assert.equal(report.body.errors[0].kind, "server_error");
    // Sent → cleared locally; the throttle stamp stays.
    const local = readHealth(join(home, ".caliber", "health.json"));
    assert.deepEqual(local.errors, {});
    assert.ok(existsSync(join(home, ".caliber", "health.json")));
  } finally {
    server.close();
  }
});
