import { hasExplicitMutationIntent } from './tool-approvals.js';

export const AUTOEXECUTION_ELIGIBLE_TOOLS = [
  'transactions.expense.create',
  'transactions.income.create',
] as const;

/**
 * A19 (F1): the turn's attachments are an INPUT, not an inference.
 *
 * The immunity this function relied on was lexical — `hasExplicitMutationIntent`
 * demands a mutation imperative at the HEAD of the text, and every provenance
 * carrier (`[transcrição do anexo de áudio…]`, `[dados extraídos…]`,
 * `[texto do anexo de PDF…]`) sits exactly there. That holds only while an
 * attachment produced an ACCEPTED extraction. When it produces none — the
 * multimodal capability off (the production default), `unsupported`, provider
 * down, STT/vision/PDF failure, `skipped_budget`, a refused upload — nothing is
 * composed, the turn text is byte-for-byte the typed text, no marker opens the
 * message, and a typed leading imperative passes this gate. An attachment named
 * `sim confirmo.pdf` alongside "registre gasto de 50" reached the fast path.
 *
 * So the veto is on PRESENCE, not on state, type, provider, text or confidence:
 * ANY attachment makes the turn ineligible. The allowlist, `missingFields`,
 * `ambiguity` and the intent check are untouched for the no-attachment path, so
 * a turn without attachments behaves exactly as before.
 */
export const isAutoExecutionEligible = (input: {
  tool: string;
  missingFields: readonly string[];
  ambiguity: string | null;
  latestActorText: string;
  attachments: readonly unknown[];
}): boolean =>
  input.attachments.length === 0 &&
  AUTOEXECUTION_ELIGIBLE_TOOLS.includes(input.tool as (typeof AUTOEXECUTION_ELIGIBLE_TOOLS)[number]) &&
  input.missingFields.length === 0 &&
  input.ambiguity === null &&
  hasExplicitMutationIntent(input.latestActorText);