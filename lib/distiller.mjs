/**
 * The distiller contract — prompt + JSON schema + the two hard rules. DATA, ported verbatim
 * from the platform's src/lib/brain/distiller.ts (from yaniv-wiki/pipeline/distill.py). The
 * model gets NO agentic tools and this schema; apply.mjs (deterministic) is the only thing
 * that writes a page. That makes a bot free-text-appending into the index unrepresentable.
 */

/** JSON schema the model output is constrained to (passed to `claude -p --json-schema`). */
export const DISTILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["trivial", "ops"],
  properties: {
    trivial: { type: "boolean" },
    ops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "name", "reason", "description"],
        properties: {
          op: { enum: ["create", "update", "retire", "noop"] },
          name: { type: "string" },
          class: { enum: ["lesson", "fact", "entity", "project", "user"] },
          scope: { enum: ["global", "repo"] },
          repo: { type: "string" },
          description: { type: "string" },
          trigger: { type: "string" },
          action: { type: "string" },
          body: { type: "string" },
          confidence: { enum: ["high", "medium", "low"] },
          evidence: { type: "array", items: { type: "string" } },
          learning_type: { enum: ["new", "extends", "updates", "retires"] },
          prior_pages: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
          superseded_by: { type: "string" },
          volatility: { enum: ["durable", "slow", "volatile"] },
          source: { type: "string" },
          refresh_cmd: { type: "string" },
        },
      },
    },
  },
};

/** Build the distiller prompt for one gated session. `index`/`relevant` describe the
 *  CURRENT brain so the model updates/retires instead of duplicating. */
export function buildDistillPrompt({ repo, title, evidenceText, index, relevant }) {
  return `You are the distiller for one developer's personal knowledge brain.

One Claude Code session just ended. Below is the evidence extracted from it, plus the
CURRENT contents of the brain. Decide what — if anything — the brain should learn.

## The brain is not free
Its router loads into EVERY session in EVERY repo. A page earns its place or it makes the
brain net-negative. Most sessions teach nothing durable: returning {"trivial": true,
"ops": []} is a correct and common answer. Do not invent a lesson to look useful.

## TWO HARD RULES. They bind every op you emit, of every class.

**1. NEVER record the state of anything outside the brain.**
A task's status, a ticket, a PR, whether something is deployed, a count, a balance — the
fastest-rotting thing you can write, and the way this brain lies to its next reader.
This has caused real damage: a project page once said "resolved tasks #1234, #1235". They
were never resolved — the CODE shipped, the TASKS stayed open, blocked on a human. A later
session read it, believed it, and had to rescue itself. Shipping code is not closing a task.
  BAD:  "#1234 and #1235 — resolved."
  GOOD: "#1234/#1235 are the PO edit/cancel bug (one root fix). For status, query the
         tasks table — this page will not know."
Durable = what a thing IS and how it works. Volatile = what state it is in right now. Write
the first; for the second, write down how to go and look. Binds lesson/project/entity/user,
not just fact.

**2. You are writing what is TRUE, not a record of what you DID.**
No run logs. No dated entries. No "previously". No "an earlier version of this page said X"
— that leaves the wrong claim in the body where the next reader mistakes it for the current
one. If a page is wrong, the update body REPLACES the wrong sentence with the right one and
says nothing about the change. The history is already in version control.
A body that would fail either rule is worse than no page at all. Prefer noop.

## What to look for, in order
1. Corrections, interrupts, snap-backs — the developer told the agent it was wrong or cut
   it off. Each is a rule it should not have needed. Write it as a RULE: one TRIGGER, one
   ACTION, one **Why:**.
2. Confirmations — approaches they explicitly approved. A brain built only from corrections
   drifts toward uselessly cautious.
3. Repeated expensive tool calls -> a fact page (a cache). volatility: durable(180d) /
   slow(30d) / volatile(never store the value — store refresh_cmd + what it means).
   refresh_cmd is MANDATORY on every fact.

## Updating and retiring — this is what stops the brain rotting
You are shown the existing pages. Before you create, check whether one already covers this
and update it. If this session CONTRADICTS a page, retire that page and name what supersedes
it — a stale lesson actively misfires. scope: global only if the rule holds in a repo that
does not exist yet; otherwise scope: repo + repo: ${repo}.

body is the full markdown body (no frontmatter). For a lesson: the rule, then **Why:**,
then **How to apply:**.

## The session
repo: ${repo}   title: ${title}
${evidenceText}

## The brain today
### every page (name · class · scope · description)
${index}

### full text of the pages most likely to be affected
${relevant}
`;
}
