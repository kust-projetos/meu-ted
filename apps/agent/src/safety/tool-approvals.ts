export type ToolApprovalRequirement = {
  toolName: string;
  action: string;
  category: 'payment' | 'cancellation' | 'deactivation' | 'write';
  requiresFreshApproval: boolean;
};

export const APPROVAL_REQUIRED_TOOLS = new Map<string, ToolApprovalRequirement>([
  ['pay_statement', { toolName: 'pay_statement', action: 'pay_statement', category: 'payment', requiresFreshApproval: true }],
  ['pay_payable', { toolName: 'pay_payable', action: 'pay_payable', category: 'payment', requiresFreshApproval: true }],
  ['mark_account_paid', { toolName: 'mark_account_paid', action: 'mark_account_paid', category: 'payment', requiresFreshApproval: true }],
  ['unpay_payable', { toolName: 'unpay_payable', action: 'unpay_payable', category: 'cancellation', requiresFreshApproval: true }],
  ['cancel_payable', { toolName: 'cancel_payable', action: 'cancel_payable', category: 'cancellation', requiresFreshApproval: true }],
  ['cancel_account_payable', { toolName: 'cancel_account_payable', action: 'cancel_account_payable', category: 'cancellation', requiresFreshApproval: true }],
  ['cancel_goal', { toolName: 'cancel_goal', action: 'cancel_goal', category: 'cancellation', requiresFreshApproval: true }],
  ['deactivate_account', { toolName: 'deactivate_account', action: 'deactivate_account', category: 'deactivation', requiresFreshApproval: true }],
  ['deactivate_category', { toolName: 'deactivate_category', action: 'deactivate_category', category: 'deactivation', requiresFreshApproval: true }],
  ['cancel_card_purchase', { toolName: 'cancel_card_purchase', action: 'cancel_card_purchase', category: 'cancellation', requiresFreshApproval: true }],
  ['delete_transaction', { toolName: 'delete_transaction', action: 'delete_transaction', category: 'write', requiresFreshApproval: true }],
]);

export const requiresApproval = (toolName: string): boolean => {
  return APPROVAL_REQUIRED_TOOLS.has(toolName);
};

export const getApprovalRequirement = (toolName: string): ToolApprovalRequirement | undefined => {
  return APPROVAL_REQUIRED_TOOLS.get(toolName);
};

const EXPLICIT_MUTATION_IMPERATIVE = /^(?:por favor,?\s+)?(?:registre|registrar|adicionar|adicione|lance|lançar|lancar|anote|anotar|inclua|incluir)\b/;
const READ_OR_NONCOMMITTING_INTENT = /^(?:resuma|resumo|listar|mostre|consultar|ver|quais\b|me mostre|saldo|extrato|gastei\b|paguei\b|acho\b|talvez\b|e se\b|quanto\b|como\b|poderia\b|pode\b|não\b|nao\b|nunca\b|assistant\b|no resultado\b)/;

/** True only when the latest actor message itself starts with a clear mutation imperative. */
export const hasExplicitMutationIntent = (text: string): boolean => {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!normalized || /[?¿]/.test(normalized) || READ_OR_NONCOMMITTING_INTENT.test(normalized)) return false;
  if (/\b(?:se|talvez|acho|caso)\b/.test(normalized)) return false;
  return EXPLICIT_MUTATION_IMPERATIVE.test(normalized);
};

export const validateActorIntentForMutation = (
  lastActorMessage: string,
  toolName: string,
  isMutating: boolean,
): { allowed: boolean; reason?: string } => {
  if (!isMutating) return { allowed: true };

  // Anti-prompt-injection: If last user message is asking for read/summary or doesn't request mutation,
  // do not allow mutating tool calls planted by prior history or untrusted tool outputs.
  const lower = lastActorMessage.toLowerCase().trim();

  const isSummaryOrReadQuery = /^(resuma|resumo|listar|mostre|consultar|ver|quais s[aã]o|me mostre|saldo|extrato)\b/i.test(lower);
  if (isSummaryOrReadQuery && isMutating) {
    return {
      allowed: false,
      reason: `Blocked mutating tool call "${toolName}" because actor query is read-only summary`,
    };
  }

  return { allowed: true };
};
