/**
 * The brain's channels on the developer's machine. With on-laptop distillation the LOCAL
 * directory is authoritative: the distiller writes pages to `~/.caliber/brain`
 * (autoMemoryDirectory) and `pushBrain` sends them UP to Caliber for the person-page/admin
 * view. `pullBrain` is now a non-destructive re-hydrate (fresh machine / second device): it
 * writes server pages it doesn't have but NEVER deletes a local page, so it can't clobber a
 * page the local distiller just wrote and hasn't pushed yet.
 *
 * Everything here is best-effort and non-fatal: a failed pull/push leaves local state intact
 * and stays silent. A governance plugin must never disrupt or slow the session it observes.
 */
import { writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CALIBER_DIR } from "./config.mjs";

export const BRAIN_DIR = join(CALIBER_DIR, "brain");
const MANIFEST = join(CALIBER_DIR, "brain-manifest.json");

/** A page filename is safe to write iff it's a plain `*.md` basename — no traversal. */
function safePageName(name) {
  return typeof name === "string" && /^[A-Za-z0-9._-]+\.md$/.test(name) && !name.includes("..");
}

export function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    return { slugs: [], activatedAt: null, pulledAt: null, newSlugs: [] };
  }
}
function writeManifest(m) {
  try {
    mkdirSync(CALIBER_DIR, { recursive: true });
    writeFileSync(MANIFEST, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

/** When the person turned their brain on (server-stamped, cached from the last pull). The
 *  distill daemon uses it as the forward-only horizon. */
export function brainActivatedAt() {
  return readManifest().activatedAt ?? null;
}

/**
 * Non-destructive re-hydrate from Caliber: write any server page we don't already have,
 * update the activation marker, and record "new since last pull" for the statusline. Never
 * deletes a local page. Returns a summary or null on failure.
 */
export async function pullBrain(config, { timeoutMs = 8000 } = {}) {
  if (!config?.endpoint || !config?.token) return null;
  const prev = readManifest();
  let payload;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${config.endpoint}/api/brain/pull`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.token}` },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }
  if (!payload || payload.enabled === false) {
    return { enabled: false, pageCount: 0, newSlugs: [], activatedAt: null };
  }

  const files = payload.files && typeof payload.files === "object" ? payload.files : {};
  const names = Object.keys(files).filter(safePageName);
  mkdirSync(BRAIN_DIR, { recursive: true });
  const isPage = (f) => f.endsWith(".md") && f !== "MEMORY.md" && f !== "_manual.md" && !f.startsWith("map-");

  for (const name of names) {
    const dest = join(BRAIN_DIR, name);
    // Routers (MEMORY.md/map-*) always refresh; content pages only fill gaps — the LOCAL
    // distiller owns page contents on the authoring device, so we never overwrite one.
    if (isPage(name) && existsSync(dest)) continue;
    try {
      writeFileSync(dest, String(files[name]));
    } catch {
      /* ignore */
    }
  }

  const nowSlugs = readdirSync(BRAIN_DIR).filter(isPage);
  const prevSet = new Set(prev.slugs ?? []);
  const newSlugs = nowSlugs.filter((s) => !prevSet.has(s));
  writeManifest({ slugs: nowSlugs, activatedAt: payload.activatedAt ?? prev.activatedAt ?? null, pulledAt: new Date().toISOString(), newSlugs });
  return { enabled: true, pageCount: nowSlugs.length, newSlugs, activatedAt: payload.activatedAt ?? null };
}

/** Refresh just the "new pages" + slug manifest after the LOCAL distiller writes pages, so
 *  the statusline's "📥 N new" reflects locally-authored learning too. */
export function noteLocalPages(newSlugs) {
  const m = readManifest();
  const nowSlugs = existsSync(BRAIN_DIR)
    ? readdirSync(BRAIN_DIR).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && f !== "_manual.md" && !f.startsWith("map-"))
    : [];
  writeManifest({ ...m, slugs: nowSlugs, newSlugs: newSlugs ?? [], pulledAt: new Date().toISOString() });
}

/** How many pages the last pull/local-distill added — drives the statusline's "📥 N new". */
export function newPagesFromLastPull() {
  return (readManifest().newSlugs ?? []).length;
}

/**
 * Push distilled pages + this session's quality UP to Caliber for the person-page/admin
 * view. Best-effort and non-fatal. Returns the server result or null.
 * @param payload { sessionId, pages:[BrainPageWrite], retires:[{slug,supersededBy,reason}], quality }
 */
export async function pushBrain(config, payload, { timeoutMs = 10000 } = {}) {
  if (!config?.endpoint || !config?.token) return null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${config.endpoint}/api/brain/pages`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json().catch(() => ({ ok: true }));
  } catch {
    return null;
  }
}
