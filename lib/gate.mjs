/**
 * The gate — decides whether a session is worth a distiller model call. Cheap,
 * deterministic, and what makes the on-laptop feature affordable: the vast majority of
 * sessions teach nothing durable and are dropped here for free, before spending the user's
 * Claude quota. Ported from src/lib/brain/gate.ts; pinned by the Dov golden fixture.
 *
 * It is also loop-guard #4: a distiller's own `claude -p` session has a single
 * SENTINEL-prefixed user turn that extract.mjs drops, so it scores 0 human turns and this
 * gate rejects it as a machine session — the distiller can never distill itself.
 */
export const MIN_SIGNAL = 3;
export const MIN_TURNS_IF_NO_SIGNAL = 6;

export function verdict(e) {
  const n = e.humanTurns.length;
  if (n === 0) return { pass: false, why: "machine session (no human turns)" };
  if (e.signal < MIN_SIGNAL && n < MIN_TURNS_IF_NO_SIGNAL) {
    return { pass: false, why: `trivial (signal ${e.signal} < ${MIN_SIGNAL}, ${n} turns)` };
  }
  const why = [];
  if (e.corrections.length) why.push(`${e.corrections.length} correction(s)`);
  if (e.interrupts) why.push(`${e.interrupts} interrupt(s)`);
  if (e.snapBacks.length) why.push(`${e.snapBacks.length} snap-back(s)`);
  if (e.confirmations.length) why.push(`${e.confirmations.length} confirmation(s)`);
  if (e.factCandidates) why.push(`${e.factCandidates} repeated expensive call(s)`);
  if (e.errorFixPairs) why.push(`${e.errorFixPairs} error->fix`);
  if (!why.length) why.push(`${n} turns`);
  return { pass: true, why: why.join(", ") };
}
