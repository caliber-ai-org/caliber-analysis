/**
 * The local brain store: the on-disk `~/.caliber/brain` directory is authoritative, so a
 * distill run reads the accumulated pages back, merges this session's writes/retirements,
 * and re-renders the whole set (MEMORY.md + maps + pages). This is the reconcile that makes
 * the local directory a pure function of every distill so far — the same property the
 * cloud/render path has, kept on the laptop.
 */
import { writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { renderBrainFiles, parsePageFile } from "./render.mjs";

function isContentPage(fn) {
  return fn.endsWith(".md") && fn !== "MEMORY.md" && fn !== "_manual.md" && !fn.startsWith("map-");
}

/** Read the accumulated active pages back into page objects. */
export function readLocalPages(brainDir) {
  if (!existsSync(brainDir)) return [];
  const pages = [];
  for (const fn of readdirSync(brainDir)) {
    if (!isContentPage(fn)) continue;
    try {
      const p = parsePageFile(readFileSync(join(brainDir, fn), "utf8"));
      if (p) pages.push(p);
    } catch {
      /* skip an unparseable page rather than lose the whole brain */
    }
  }
  return pages;
}

/** Upsert `writes` by slug and drop `retires` — returns the new page set. */
export function mergePages(existing, writes, retires) {
  const bySlug = new Map(existing.map((p) => [p.slug, p]));
  for (const w of writes) bySlug.set(w.slug, w);
  for (const r of retires) bySlug.delete(r.slug);
  return [...bySlug.values()];
}

/** Render the full page set to disk and remove any file no longer part of it. */
export function writeLocalBrain(brainDir, pages, today) {
  mkdirSync(brainDir, { recursive: true });
  const files = renderBrainFiles(pages, today);
  const want = new Set(Object.keys(files));
  for (const [name, content] of Object.entries(files)) {
    try {
      writeFileSync(join(brainDir, name), content);
    } catch {
      /* ignore a single bad write */
    }
  }
  for (const fn of readdirSync(brainDir)) {
    if (fn.endsWith(".md") && !want.has(fn)) {
      try {
        rmSync(join(brainDir, fn));
      } catch {
        /* ignore */
      }
    }
  }
  return Object.keys(files).filter(isContentPage);
}
