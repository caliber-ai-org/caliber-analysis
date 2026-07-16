/**
 * plan → page writes. The model never reaches here — it returns validated JSON and this
 * pure function decides what becomes a brain page. Ported from src/lib/brain/apply.ts.
 * create/update collapse into one upsert on the (slug) key; the hard guards (external
 * state, process residue, secret, volatile number) drop any offending op before it is
 * written locally or pushed.
 */
import { guardPage, slugify, TTL_DAYS } from "./lint.mjs";

function pageName(op, cls) {
  const raw = op.name || "";
  return raw.startsWith(`${cls}-`) ? raw : `${cls}-${slugify(raw)}`;
}

function renderBody(op, cls) {
  let body = (op.body || "").trim();
  if (cls === "lesson" && op.trigger && op.action) {
    const head = `**When** ${op.trigger.trim()}\n**Then** ${op.action.trim()}\n\n`;
    if (!body.startsWith("**When**")) body = head + body;
  }
  const ev = op.evidence || [];
  if (ev.length) {
    body += "\n\n**Evidence (verbatim, from the session that taught this):**\n";
    body += ev.slice(0, 4).map((x) => `- “${x.trim().slice(0, 220)}”`).join("\n");
  }
  return body;
}

export function applyPlan(plan, opts) {
  const out = { writes: [], retires: [], noop: [], skipped: [] };

  for (const op of plan.ops || []) {
    const kind = op.op;
    if (kind === "noop") {
      out.noop.push(op.name || "?");
      continue;
    }
    if (kind === "retire") {
      out.retires.push({ slug: op.name, supersededBy: op.superseded_by || null, reason: (op.reason || "").slice(0, 160) });
      continue;
    }
    if (kind !== "create" && kind !== "update") continue;

    const description = (op.description || "").trim();
    if (!description) {
      out.skipped.push({ name: op.name, why: "no description" });
      continue;
    }
    const cls = op.class || "lesson";
    const refreshCmd = (op.refresh_cmd || "").trim();
    if (cls === "fact" && !refreshCmd) {
      out.skipped.push({ name: op.name, why: "fact with no refresh_cmd" });
      continue;
    }

    const volatility = cls === "fact" ? op.volatility || "slow" : null;
    const body = renderBody(op, cls);

    const guard = guardPage({ body, description, cls, refreshCmd, volatility: volatility || undefined });
    if (!guard.ok) {
      out.skipped.push({ name: op.name, why: guard.violations.join("; ") });
      continue;
    }

    const scope = op.scope || (op.repo ? "repo" : "global");
    out.writes.push({
      slug: pageName(op, cls),
      pageClass: cls,
      scope,
      repo: scope === "repo" ? op.repo || null : null,
      description,
      body,
      confidence: op.confidence || "medium",
      volatility: cls === "fact" && volatility && volatility in TTL_DAYS ? volatility : null,
      refreshCmd: cls === "fact" ? refreshCmd : null,
      observedAt: opts.today,
    });
  }

  return out;
}
