/**
 * Plugin health — tells Caliber when this laptop's capture is failing.
 *
 * A failed upload is otherwise invisible to the org: the watermark simply does
 * not advance and the error lands in ~/.caliber/capture.log, which nobody reads.
 * So each failure is tallied in ~/.caliber/health.json, and a small report is
 * POSTed to /api/ingest/claude-code/health — at most once per REPORT_INTERVAL_MS,
 * so a laptop with no network does not retry-storm. The admin's Practitioners
 * page then shows "installed, not healthy" with the reason.
 *
 * A successful upload clears the tally locally without sending anything: the
 * server clears its side from the upload itself. A healthy laptop never reports.
 *
 * Everything here is best-effort and swallows its own errors — health reporting
 * must never be the thing that breaks capture.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CALIBER_DIR } from "./config.mjs";

export const HEALTH_PATH = join(CALIBER_DIR, "health.json");
export const REPORT_INTERVAL_MS = 10 * 60 * 1000;
const REPORT_TIMEOUT_MS = 10_000;
const DETAIL_MAX = 200;

let cachedVersion;
export function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, "..", ".claude-plugin", "plugin.json"), "utf8"));
    cachedVersion = typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/**
 * Maps a postOnce() result ({ ok, status, error }) to the server's error kinds.
 * 429/503 never reach here as failures worth reporting on their own — postBatch
 * retries them — but if retries run out they count as server errors.
 */
export function classifyFailure(result) {
  const status = Number(result?.status) || 0;
  if (status === 0) {
    const name = String(result?.error || "");
    return /abort|timeout/i.test(name) ? "timeout" : "network";
  }
  if (status === 401) return "auth_revoked";
  if (status === 403) return "forbidden";
  if (status >= 400 && status < 500) return "bad_request";
  if (status >= 500) return "server_error";
  return "unknown";
}

export function readHealth(path = HEALTH_PATH) {
  try {
    const h = JSON.parse(readFileSync(path, "utf8"));
    return {
      errors: h && typeof h.errors === "object" && h.errors ? h.errors : {},
      lastReportAt: typeof h?.lastReportAt === "string" ? h.lastReportAt : null,
    };
  } catch {
    return { errors: {}, lastReportAt: null };
  }
}

function writeHealth(state, path = HEALTH_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path); // atomic: concurrent detached shippers never see half a file
  } catch {
    // best-effort
  }
}

/** Tally one failure. Returns the new state (for tests). */
export function noteFailure(kind, detail, { path = HEALTH_PATH, now = new Date() } = {}) {
  const state = readHealth(path);
  const prev = state.errors[kind] ?? { count: 0 };
  state.errors[kind] = {
    count: (Number(prev.count) || 0) + 1,
    last_at: now.toISOString(),
    detail: detail ? String(detail).slice(0, DETAIL_MAX) : prev.detail ?? null,
  };
  writeHealth(state, path);
  return state;
}

/** A successful upload: drop the tally. No network call. */
export function noteSuccess({ path = HEALTH_PATH } = {}) {
  const state = readHealth(path);
  if (Object.keys(state.errors).length === 0) return;
  writeHealth({ errors: {}, lastReportAt: state.lastReportAt }, path);
}

export function shouldReport(state, now = Date.now()) {
  if (Object.keys(state.errors).length === 0) return false;
  if (!state.lastReportAt) return true;
  const last = Date.parse(state.lastReportAt);
  return !Number.isFinite(last) || now - last >= REPORT_INTERVAL_MS;
}

export function buildReport(config, state) {
  return {
    email: config.email,
    version: pluginVersion(),
    os: process.platform,
    errors: Object.entries(state.errors).map(([kind, e]) => ({
      kind,
      count: Number(e?.count) || 0,
      last_at: e?.last_at ?? null,
      detail: e?.detail ?? null,
    })),
  };
}

/**
 * Send the tally if one is due. On a 2xx the tally is cleared (the server now
 * holds it); on any failure it is kept and retried after the interval. The
 * throttle stamp is written BEFORE the request, so concurrent shippers that
 * fail together send one report, not one each.
 */
export async function maybeReport(config, { path = HEALTH_PATH, fetchImpl = fetch } = {}) {
  try {
    const state = readHealth(path);
    if (!shouldReport(state)) return false;
    writeHealth({ ...state, lastReportAt: new Date().toISOString() }, path);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${config.endpoint}/api/ingest/claude-code/health`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify(buildReport(config, state)),
        signal: controller.signal,
      });
      if (!res.ok) return false;
    } finally {
      clearTimeout(timer);
    }
    // Keep failures that happened while the report was in flight.
    const after = readHealth(path);
    const remaining = {};
    for (const [kind, e] of Object.entries(after.errors)) {
      const sent = state.errors[kind];
      if (!sent) remaining[kind] = e;
      else if ((e?.last_at ?? "") > (sent.last_at ?? "")) {
        remaining[kind] = { ...e, count: Math.max(1, (Number(e.count) || 0) - (Number(sent.count) || 0)) };
      }
    }
    writeHealth({ errors: remaining, lastReportAt: after.lastReportAt }, path);
    return true;
  } catch {
    return false;
  }
}
