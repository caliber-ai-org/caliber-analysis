/**
 * Derive the on-disk brain layout from the active pages — a Node port of the platform's
 * src/lib/brain/render.ts (from yaniv-wiki/pipeline/apply.py:_rebuild_routers). MEMORY.md
 * (with the manual inlined), one map per repo, and every page are a pure function of the
 * active set, so the router can never drift; a fact's SNAPSHOT/STALE banner is date math
 * recomputed here, never stored. `parsePageFile` reads a rendered page back into a page
 * object so the laptop can merge this session's writes into the accumulated brain.
 */
import { TTL_DAYS } from "./lint.mjs";

const CLASS_TO_TYPE = { lesson: "feedback", fact: "reference", entity: "reference", project: "project", user: "user" };

const MANUAL = `# Operating manual — your Caliber brain

A curated wiki, not a scratchpad. **Global**: it loads in every repo, every session. These
rules **extend** the memory protocol in your system prompt; where they conflict, these win.

## Page classes

Every page keeps its native \`metadata.type\` **and** a \`metadata.class\`:

| class | native \`type\` | what it is |
|---|---|---|
| \`lesson\` | \`feedback\` | a behavioural rule: **TRIGGER → ACTION**. The core asset. |
| \`fact\` | \`reference\` | a **cache** of an expensive tool/MCP call. Never truth. |
| \`entity\` | \`reference\` | a system, service, workflow, or person. |
| \`project\` | \`project\` | durable knowledge about one repo. |
| \`user\` | \`user\` | standing preferences of the developer this brain belongs to. |

## NEVER record the state of anything outside this brain — on ANY page

A task's status, a ticket, a PR, whether something is deployed, a count, a balance: the
fastest-rotting thing you can write, and how a brain lies to its next reader.

**Reference the item. Never its state.** Durable = *what a thing is and how it works*.
Volatile = *what state it is in right now*. Write the first; for the second, write down how
to go and look. Binds **every class**, not just \`fact\`.

## Correcting a page: REPLACE the claim, never narrate it

If a page is wrong, **fix the sentence**. Delete the wrong claim; write the true one. Do
**not** write *"an earlier version of this page said X"* — the next reader cannot tell your
quoted mistake from your current claim. The history is in version control, where it costs
the reader nothing. **A page's only job is to be true right now.**

## Facts: a cache with a TTL, never live truth

- **Before you ACT on any id, number or status from a fact**, re-derive it with \`refresh_cmd\`.
- A **STALE** banner means re-derive *and heal the page in the same turn*.
- Say "as of \`<observed_at>\`", never "there are N".

## Scope — and the one thing you must actually DO

Pages are \`scope: global\`, or \`scope: repo\` + \`repo: <name>\`. **Before answering any
question about the repo you are in — and before acting in it — read \`map-<repo>.md\` if the
router lists one.** The pages behind that map exist precisely because the obvious answer was
wrong once. Ignore maps for repos you are not in.

## When this brain contradicts a CLAUDE.md, THIS BRAIN WINS

A CLAUDE.md is aspirational and rots; these pages are empirical — each distilled from a real
correction. When they disagree, follow the brain and flag the doc as stale.`;

function slugifyRepo(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 70);
}
function titleOf(slug) {
  const parts = slug.split("-");
  return parts.slice(1).join(" ") || slug;
}
function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

function factBanner(page, today) {
  const vol = page.volatility || "slow";
  const observed = page.observedAt || today;
  const exp = addDays(observed, TTL_DAYS[vol] ?? 30);
  if (exp < today) {
    const daysAgo = Math.round((Date.parse(today) - Date.parse(exp)) / 86_400_000);
    return (
      `> [!danger] STALE — this cache expired on ${exp} (${daysAgo} days ago).\n` +
      `> Do NOT use any value below. Re-run \`${page.refreshCmd || ""}\`, then update this ` +
      `page (bump observed_at) in the same turn.\n\n`
    );
  }
  return (
    `> [!info] SNAPSHOT — cached from a tool call on ${observed} (${vol}, expires ${exp}).\n` +
    `> Not live truth. Re-derive with \`refresh_cmd\` before acting on any value below.\n\n`
  );
}

export function renderPage(page, today) {
  const cls = page.pageClass;
  const typ = CLASS_TO_TYPE[cls] || "reference";
  const fm = [
    "---",
    `name: ${page.slug}`,
    `description: "${page.description.replace(/"/g, "'")}"`,
    "metadata:",
    "  node_type: memory",
    `  type: ${typ}`,
    `  class: ${cls}`,
    `  scope: ${page.scope}`,
  ];
  if (page.scope === "repo" && page.repo) fm.push(`  repo: ${page.repo}`);
  fm.push("  status: active");
  if (page.observedAt) fm.push(`  observed_at: ${page.observedAt}`);

  let banner = "";
  if (cls === "fact") {
    const vol = page.volatility || "slow";
    const exp = addDays(page.observedAt || today, TTL_DAYS[vol] ?? 30);
    fm.push(`  volatility: ${vol}`, `  expires_at: ${exp}`, `  refresh_cmd: "${(page.refreshCmd || "").replace(/"/g, "'")}"`);
    banner = factBanner(page, today);
  }
  fm.push("---");
  return `${fm.join("\n")}\n\n${banner}${page.body.trim()}\n`;
}

/** Read a rendered page file back into a page object (banner stripped), for merging. */
export function parsePageFile(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = text.slice(3, end);
  let body = text.slice(end + 4).replace(/^\n+/, "");
  body = body.replace(/^>\s*\[!(?:info|danger)\][^\n]*\n(?:>[^\n]*\n)*\n?/, ""); // strip banner
  const get = (k) => {
    const m = new RegExp(`(^|\\n)\\s*${k}:\\s*"?([^"\\n]*)"?`).exec(fm);
    return m ? m[2].trim() : null;
  };
  const slug = get("name");
  if (!slug) return null;
  return {
    slug,
    pageClass: get("class") || "lesson",
    scope: get("scope") || "global",
    repo: get("repo"),
    description: get("description") || "",
    body: body.trim(),
    volatility: get("volatility"),
    refreshCmd: get("refresh_cmd"),
    observedAt: get("observed_at"),
  };
}

export function renderBrainFiles(pages, today) {
  const files = {};
  const globals = [];
  const byRepo = {};
  const facts = [];

  for (const p of pages) {
    const fn = `${p.slug}.md`;
    files[fn] = renderPage(p, today);
    const rec = {
      fn, title: titleOf(p.slug), desc: p.description.trim(), cls: p.pageClass,
      repo: p.repo, observed: p.observedAt || "", vol: p.volatility || "",
    };
    if (rec.cls === "fact") facts.push(rec);
    else if (p.scope === "global") globals.push(rec);
    else (byRepo[p.repo || "unknown"] ||= []).push(rec);
  }

  for (const [repo, recs] of Object.entries(byRepo)) {
    const lines = [`# ${repo} — page map`, "", `${recs.length} pages. Read these only when working in \`${repo}\`.`, ""];
    for (const cls of ["lesson", "project", "entity", "fact", "user"]) {
      const sel = recs.filter((r) => r.cls === cls).sort((a, b) => a.fn.localeCompare(b.fn));
      if (!sel.length) continue;
      lines.push(`## ${cls}s`);
      for (const r of sel) lines.push(`- [${r.title}](${r.fn}) — ${r.desc}`);
      lines.push("");
    }
    files[`map-${slugifyRepo(repo)}.md`] = lines.join("\n") + "\n";
  }

  const r = [
    MANUAL, "", "---", "", "# Your brain — router", "",
    "Global lessons apply everywhere. For repo-specific knowledge, read that repo's map.",
    "Fact caches are snapshots — check `observed_at` and re-derive before acting on a value.",
    "", "## Always-on lessons (apply in every repo)", "",
  ];
  for (const x of globals.sort((a, b) => a.fn.localeCompare(b.fn))) r.push(`- [${x.title}](${x.fn}) — ${x.desc}`);
  r.push("", "## Repo maps (read only the one you are in)", "");
  for (const [repo, recs] of Object.entries(byRepo).sort((a, b) => b[1].length - a[1].length)) {
    r.push(`- **${repo}** — ${recs.length} pages → [map-${slugifyRepo(repo)}.md](map-${slugifyRepo(repo)}.md)`);
  }
  r.push("", "## Fact caches (SNAPSHOTS — check observed_at, re-derive before acting)", "");
  if (facts.length) {
    for (const x of facts.sort((a, b) => a.fn.localeCompare(b.fn))) {
      r.push(`- [${x.title}](${x.fn}) — ${x.desc} [${x.vol} · observed ${x.observed}]`);
    }
  } else {
    r.push("<!-- populated by the distiller as repeated expensive tool calls are detected -->");
  }
  r.push("");
  files["MEMORY.md"] = r.join("\n");
  return files;
}
