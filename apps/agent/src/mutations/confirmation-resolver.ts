export type ConfirmationDecision = { kind: 'confirm' | 'cancel' | 'clarify'; operationId?: string; reason?: string };

const affirmative = /^(sim|s[ií]m|confirmo|confirmado|pode|pode sim|autorizo|vai em frente|ok|okay|fechado)[!. ]*$/i;
/**
 * "desfaz" cancela (decisão do operador): desfaz/desfazer/desfaç comportam-se
 * como "cancela" aqui. "não ..." já cancelava antes (o "não" está na
 * alternância), então "não desfaz" segue cancelando por essa via — sem
 * mudança de classe. Proteção contra conteúdo de anexo vive no roteamento
 * (decisionText), não neste matcher.
 */
const negative = /\b(n[aã]o|não|cancela|cancelar|deixa|desist|pare|desfaz|desfazer|desfaç)\b/i;

/** Resolves confirmation text without reconstructing or modifying proposal arguments. */
export const resolveConfirmation = (text: string, pendingOperationIds: readonly string[]): ConfirmationDecision => {
  if (negative.test(text)) return { kind: 'cancel', reason: 'explicit_negation' };
  if (!affirmative.test(text.trim())) return { kind: 'clarify', reason: 'not_explicit_confirmation' };
  if (pendingOperationIds.length !== 1) return { kind: 'clarify', reason: pendingOperationIds.length === 0 ? 'no_pending_operation' : 'multiple_pending_operations' };
  return { kind: 'confirm', operationId: pendingOperationIds[0] };
};
