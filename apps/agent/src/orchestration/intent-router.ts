import type { PlannedOperation } from './conversation-orchestrator.js';
import { hasMutationIntentSignal, interpretMutationUtterance } from '../mutations/semantic-interpretation.js';
import { findSkillsFor, toolsForSkills } from './skill-inventory.js';
import { validateTurnPlan, type TurnPlanV2 } from './turn-plan.js';

const fold = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const typoNormalize = (value: string): string => value.replace(/\bsald\b/g, 'saldo').replace(/\bextrat\b/g, 'extrato').replace(/\bcontas?\b/g, 'contas');
const operation = (name: string): PlannedOperation => ({ name, kind: 'read' });

export type FastPathKind = 'balance' | 'recent_transactions' | 'confirm' | 'cancel' | 'none';
export type FastPathOptions = Readonly<{ stageCalls?: number; turnCalls?: number; cacheHit?: boolean }>;
export type FastPathResult = Readonly<{
  kind: FastPathKind;
  plannerRequired: boolean;
  allowed: boolean;
  reason?: 'call_budget_exceeded';
  apiCallBudget: number;
  cacheAuthoritative: false;
  requiresFreshApi: boolean;
}>;

/** Classifies high-volume requests without invoking a generative planner. */
export const classifyFastPath = (text: string, options: FastPathOptions = {}): FastPathResult => {
  const normalized = typoNormalize(fold(text));
  const kind: FastPathKind = /\b(confirmar|confirma|confirmo|confirmado|autorizo|sim)\b/.test(normalized) ? 'confirm'
    : /\b(cancelar|cancela|desistir|deixa pra la)\b/.test(normalized) ? 'cancel'
    : /\b(saldo|quanto tenho|quanto eu tenho)\b/.test(normalized) ? 'balance'
    : /\b(ultimos? lancamentos?|extrato recente|ultimas? transac)\b/.test(normalized) ? 'recent_transactions' : 'none';
  const apiCallBudget = kind === 'balance' ? 2 : kind === 'recent_transactions' ? 1 : kind === 'confirm' || kind === 'cancel' ? 1 : 0;
  const stageCalls = options.stageCalls ?? 0;
  const turnCalls = options.turnCalls ?? 0;
  const allowed = stageCalls < apiCallBudget && turnCalls < 2;
  return {
    kind,
    plannerRequired: kind === 'none',
    allowed,
    ...(allowed ? {} : { reason: 'call_budget_exceeded' as const }),
    apiCallBudget,
    cacheAuthoritative: false,
    requiresFreshApi: kind === 'balance' || kind === 'recent_transactions' || options.cacheHit === true,
  };
};

export const routeIntent = (text: string): TurnPlanV2 => {
  const normalized = typoNormalize(fold(text));
  if (!normalized) return fallbackPlan();
  if (/\bnao\b/.test(normalized) && /\b(registre|registrar|lance|lancar|crie|criar|apague|apagar|exclua|excluir|transfira|transferir)\b/.test(normalized)) {
    return makePlan('cancel', 'general', [], [], ['conversation']);
  }
  const fastPath = classifyFastPath(normalized);
  if (fastPath.kind === 'confirm') return makePlan('confirmation', 'general', [], [], ['conversation']);
  if (fastPath.kind === 'cancel') return makePlan('cancel', 'general', [], [], ['conversation']);
  // SPEC §7.6: a parseable mutation attempt carries its real missing fields
  // from the start — accountId/categoryId always pending authoritative
  // resolution (§7.2/§7.3). Never []. Amount-less or negated utterances keep
  // the legacy read/unsupported routing below (no proposal either way).
  // R06/A06: the interpretation layer decides "this is a mutation candidate",
  // so clipped verbs ("gstei") route exactly like their canonical form and an
  // ambiguous amount (AC13) plans no mutation operation at all. The intent
  // gate itself is unchanged — only clipped verbs were added to it.
  if (hasMutationIntentSignal(text)) {
    const interpretation = interpretMutationUtterance(text);
    if (interpretation.status === 'candidate') {
      const tool = interpretation.parsed.kind === 'income' ? 'transactions.income.create' : 'transactions.expense.create';
      const skills = findSkillsFor('transactions').slice(0, 2).map((skill) => skill.name);
      return makePlan(
        'mutation-proposal',
        'transactions',
        [{ name: tool, kind: 'mutation' }],
        skills,
        undefined,
        ['accountId', 'categoryId'],
      );
    }
    // AC13: an ambiguous mutation intent must NOT fall through to the read
    // heuristics below — "gastei uns 80 no mercado" is not a transactions
    // query, it is a mutation the assistant refuses to guess. This plan
    // carries NO operation (no mutation, no authoritative read, no tool) and
    // is answered by the orchestrator's existing deterministic
    // `ambiguousClarification` terminal.
    if (interpretation.status === 'clarify') {
      return ambiguityPlan(interpretation.missingFields, interpretation.ambiguities);
    }
  }
  const operations: PlannedOperation[] = [];
  let domain: TurnPlanV2['domain'] = 'general';
  if (/\b(saldo|quanto tenho|quanto eu tenho)\b/.test(normalized)) { domain = 'accounts'; operations.push(operation('get_balance')); }
  if (/\b(conta|contas)\b/.test(normalized)) { domain = 'accounts'; operations.push(operation('list_accounts')); }
  if (/\b(extrato|transac|lancamento|gast\w*|despesas?)\b/.test(normalized)) { domain = 'transactions'; operations.push(operation('list_transactions')); }
  if (/\b(fatura|faturas|cartao|cartoes)\b/.test(normalized)) { domain = /fatura/.test(normalized) ? 'payables' : 'cards'; operations.push(operation(/fatura/.test(normalized) ? 'list_payables' : 'list_cards')); }
  // T3.1 (SPEC §14): finance-seeking asks must map to evidence reads, never
  // fall through to unsupported/general (which yields evidence=null).
  if (/\b(orcament\w*|budget\w*)\b/.test(normalized)) { domain = 'budgets'; operations.push(operation('list_budgets')); }
  // "contas vencidas" overrides the generic accounts match above: overdue
  // bills are payables evidence, not account balances.
  if (/\b(vencid\w*|vencer|a pagar|boleto\w*)\b/.test(normalized)) { domain = 'payables'; operations.push(operation('list_payables')); }
  if (!operations.length) return fallbackPlan();
  const skills = findSkillsFor(domain).slice(0, 2).map((skill) => skill.name);
  return makePlan('read', domain, operations.slice(0, 4), skills);
};

const makePlan = (mode: TurnPlanV2['mode'], domain: TurnPlanV2['domain'], requestedOperations: readonly PlannedOperation[], skillNames: readonly string[], requestedTools?: readonly string[], missingFields: readonly string[] = []): TurnPlanV2 => {
  const plan: TurnPlanV2 = { version: '2', mode, domain, skillNames, requestedOperations, requestedTools: requestedTools ?? toolsForSkills(skillNames).slice(0, 8), missingFields: [...missingFields], ambiguity: null, confidence: requestedOperations.length ? 0.95 : 1, correctionCount: 0 };
  const result = validateTurnPlan(plan);
  return result.success ? result.plan : fallbackPlan();
};

const fallbackPlan = (): TurnPlanV2 => ({ version: '2', mode: 'unsupported', domain: 'general', skillNames: ['conversation'], requestedOperations: [], requestedTools: [], missingFields: ['intent'], ambiguity: 'unsupported', confidence: 0, correctionCount: 0 });

/**
 * R06/A06 (AC13): the deterministic plan for an AMBIGUOUS mutation intent.
 *
 * It declares no operation at all — no mutation, no read, no tool — and names
 * the real missing fields plus the ambiguities, so the turn can only be
 * answered by asking the user. `confidence: 0` mirrors `fallbackPlan`: nothing
 * about this utterance is actionable yet.
 */
const ambiguityPlan = (
  missingFields: readonly string[],
  ambiguities: readonly string[],
): TurnPlanV2 => {
  const result = validateTurnPlan({
    version: '2',
    mode: 'unsupported',
    domain: 'transactions',
    skillNames: ['conversation'],
    requestedOperations: [],
    requestedTools: [],
    missingFields: [...missingFields],
    ambiguity: `ambiguous:${ambiguities.join(',')}`,
    confidence: 0,
    correctionCount: 0,
  } satisfies TurnPlanV2);
  return result.success ? result.plan : fallbackPlan();
};
