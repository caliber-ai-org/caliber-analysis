/**
 * Client-side secret redaction. Runs on the laptop BEFORE any transcript line
 * leaves the machine — a captured prompt or tool output must never carry a live
 * credential to the server.
 *
 * Deliberately HIGH-CONFIDENCE only: each pattern matches a credential shape
 * distinctive enough that a false positive on ordinary code/prose is unlikely.
 * Over-redacting would gut the very content the capture exists to analyze, so we
 * match known token formats and PEM blocks, not generic "secret"-looking words.
 * This is defense-in-depth, not a guarantee — the server still stores in an
 * RLS-scoped table with restricted access.
 */

export const REDACTIONS = [
  // PEM private key blocks (RSA/EC/OPENSSH/PGP) — match the whole armored body.
  { label: "private-key", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  // Anthropic. Must precede the generic sk- rule.
  { label: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  // OpenAI (classic + project + service-account).
  { label: "openai-key", re: /sk-(?:proj|svcacct)?-?[A-Za-z0-9_-]{20,}/g },
  // Caliber ingest / install tokens — our own, the most important to never leak.
  { label: "caliber-token", re: /clbi?_[A-Za-z0-9_-]{16,}/g },
  // AWS access key id.
  { label: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub tokens: classic (ghp/gho/ghu/ghs/ghr) + fine-grained (github_pat).
  { label: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  // GitLab personal/CI tokens.
  { label: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  // Slack.
  { label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API key.
  { label: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Stripe live secret/restricted keys (publishable pk_ is intentionally NOT redacted).
  { label: "stripe-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  // npm automation token.
  { label: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // JSON Web Tokens (three base64url segments).
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Authorization: Bearer <token> — redact the token, keep the scheme.
  { label: "bearer", re: /(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, replace: (_m, p1) => `${p1}[REDACTED:bearer]` },
];

/** Redact secret shapes from a single string. */
export function redactString(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const { label, re, replace } of REDACTIONS) {
    out = out.replace(re, replace ?? `[REDACTED:${label}]`);
  }
  return out;
}

/**
 * Recursively redact every string value in a parsed JSON value, returning a new
 * structure. Operating on values (not the serialized blob) means redaction can
 * never corrupt the JSON shape.
 */
export function redactDeep(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}
