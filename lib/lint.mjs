/**
 * The deterministic safety layer for the on-laptop distiller — a Node port of the
 * platform's src/lib/brain/lint.ts (itself from yaniv-wiki/pipeline/lint.py). The model
 * returns data; this file is one of the two things (with apply.mjs) that decide what lands
 * as a brain page. Its whole job is to make the failure that hurt the reference brain
 * UNREPRESENTABLE, not merely detectable:
 *   - Reference an item; never its mutable state (a task's status, a PR, a deploy).
 *   - A correction REPLACES the claim; it never narrates it.
 * A page that breaks either rule, leaks a secret, or writes a volatile number down is
 * DROPPED before it is ever written or pushed.
 *
 * This is the identical logic re-expressed in .mjs so it runs in the plugin; the platform
 * keeps its .ts copy for server-side re-validation of pushed pages, and both are pinned to
 * the same fixtures so they can't drift.
 */

export const TTL_DAYS = { durable: 180, slow: 30, volatile: 1 };

export const CLASS_TO_TYPE = {
  lesson: "feedback",
  fact: "reference",
  entity: "reference",
  project: "project",
  user: "user",
};

const SECRETS = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9_\-]{20,}/],
  ["openai-key", /\bsk-[A-Za-z0-9]{32,}/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._\-]{20,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["db-url-with-password", /\b(?:postgres|postgresql|mysql|mongodb)(?:\+\w+)?:\/\/[^\s:/@]+:[^\s@]+@/],
  [
    "assigned-secret",
    /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*\s*[:=]\s*['"]?[A-Za-z0-9/+_\-]{16,}/,
  ],
];

const ITEM_REF = String.raw`(?:#\d{3,5}\b|\btasks?\s+#?\d{3,5}\b|\btickets?\s+#?\d{2,6}\b|\b(?:MARV|CAL)-\d+\b)`;
const STATE_WORD = String.raw`(?:resolved|closed|completed|pending|reopened|unresolved|still\s+open)`;
const EXTERNAL_STATE = new RegExp(
  `(?:${ITEM_REF}[^.\\n]{0,50}?\\b${STATE_WORD}\\b|\\b${STATE_WORD}\\b[^.\\n]{0,50}?${ITEM_REF})`,
  "i",
);

const PROCESS_RESIDUE = new RegExp(
  [
    "an earlier version",
    "previously (?:claimed|said|stated)",
    "this page (?:was|has been) wrong",
    "used to say",
    "the old note",
    "^\\s*\\*\\*Run \\d{4}-",
    "^\\s*##\\s*\\[?\\d{4}-\\d{2}-\\d{2}",
    "\\bRun log\\b",
    "earlier version of this page",
  ].join("|"),
  "im",
);

const EVIDENCE_BLOCK = /\*\*Evidence[^\n]*\n(?:.*\n)*?(?=\n\S|$)/m;
const QUOTED = /[“"'][^”"'\n]{10,300}[”"']/g;
const STALE_BANNER = /^>\s*\[!(info|danger)\][^\n]*\n(?:>[^\n]*\n)*/m;
const BARE_NUMBER = /(?<![\w.$/#-])\d{2,}(?![\w%.\-])/;

export function stripQuoted(body) {
  return body.replace(EVIDENCE_BLOCK, "").replace(QUOTED, "");
}

export function scanSecrets(text) {
  const hits = [];
  for (const [kind, rx] of SECRETS) if (rx.test(text)) hits.push(kind);
  return hits;
}

/** Run every hard guard against a candidate page. Non-empty `violations` ⇒ drop the op. */
export function guardPage({ body, description, cls, refreshCmd, volatility }) {
  const violations = [];

  for (const k of scanSecrets(`${description}\n${body}`)) violations.push(`secret-shaped string (${k})`);

  const factExempt = cls === "fact" && !!(refreshCmd || "").trim();
  const claims = stripQuoted(body);
  if (!factExempt) {
    const m = EXTERNAL_STATE.exec(claims);
    if (m) violations.push(`asserts external state: ${m[0].trim().slice(0, 60)}`);
  }

  const res = PROCESS_RESIDUE.exec(body);
  if (res) violations.push(`process residue: ${res[0].trim().slice(0, 50)}`);

  if (cls === "fact" && (volatility || "slow") === "volatile") {
    const stripped = body.replace(STALE_BANNER, "");
    if (BARE_NUMBER.test(stripped)) {
      violations.push("volatile fact contains a bare number (store refresh_cmd, not the value)");
    }
  }

  return { ok: violations.length === 0, violations };
}

export function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 70);
}
