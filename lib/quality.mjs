/**
 * Per-session quality — the friction signal that answers "are their sessions improving?".
 * Ported from src/lib/brain/quality.ts. Deterministic, no model. Computed for EVERY session
 * (gated or not) and pushed up, so the person-page trend has every session's friction.
 *
 * On the laptop we can also fill brainPagesUsed + callsSaved (value.mjs knows the brain
 * dir), which the cloud job could not — that's what makes the admin scorecard's "calls
 * saved" a concrete number. The distill orchestrator sets them; sessionQuality alone
 * leaves them 0.
 */
import { extractEvidence } from "./extract.mjs";

export function sessionQuality(lines) {
  const e = extractEvidence(lines);
  const toolCalls = Object.values(e.toolsUsed).reduce((a, b) => a + b, 0);
  return {
    humanTurns: e.humanTurns.length,
    corrections: e.corrections.length,
    interrupts: e.interrupts,
    snapBacks: e.snapBacks.length,
    friction: e.corrections.length + e.interrupts + e.snapBacks.length,
    toolCalls,
    brainPagesUsed: 0,
    callsSaved: 0,
  };
}
