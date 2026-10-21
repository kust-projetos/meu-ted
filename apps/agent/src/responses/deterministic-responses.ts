import { formatCents } from '../evidence/financial-formatters.js';
import type { ReadAbsenceReason } from '../evidence/evidence-envelope.js';

export const renderBalance = (value: { accountName: string; balanceCents: number }): string => `${value.accountName}: ${formatCents(value.balanceCents)}.`;
export const renderEmpty = (subject: string): string => `Não há dados disponíveis para ${subject}.`;
export const renderUnavailable = (subject: string): string => `Não foi possível consultar ${subject} agora. Tente novamente mais tarde.`;

/**
 * A04/R04 — deterministic reply for a read that SUCCEEDED and proved an
 * absence in the requested scope. It states the reason, never turns an empty
 * query into a failure ("não foi possível") and never presents absence as a
 * zero figure. The requested period/category/filter is never widened silently:
 * adjusting the scope is only OFFERED.
 *
 * `workspace_empty` is the workspace-level claim, produced by the turn
 * collector only from a consistent multi-read snapshot that came back entirely
 * empty (A09/A04 block b); a narrower read keeps the wording scoped to what
 * was actually consulted.
 */
export const renderReadAbsence = (reason: ReadAbsenceReason, subject: string): string => {
  switch (reason) {
    case 'setup_incomplete': return `Ainda não encontrei ${subject} aqui. Quer que eu te guie no cadastro?`;
    case 'period_empty': return `Não há ${subject} no período que você consultou. Posso verificar outro período, se quiser.`;
    case 'category_empty': return `Não há ${subject} nessa categoria. Posso consultar sem esse filtro.`;
    case 'filter_empty': return `Nenhum item de ${subject} atende a esse filtro. Posso revisar o filtro com você.`;
    case 'entity_not_found': return 'Não encontrei esse item entre os seus dados.';
    case 'workspace_empty': return `Não encontrei ${subject} aqui ainda. Posso te mostrar como começar.`;
  }
};

/**
 * TEDV3-003 remediation: deterministic clarification used when the tool-call
 * sanitizer removed EVERY useful token of the model reply (the message was
 * pure tool-invocation markup). Never an empty message, never raw markup:
 * one short natural-language question inviting the user to rephrase. It
 * ends in "?" so the SPEC §26.3 clarification contract still holds when
 * small models persist in emitting tool-call markup on ambiguous reads.
 */
export const renderClarificationFallback = (subject = 'esta consulta'): string =>
  `Não consegui processar ${subject} agora. Você pode reformular o que deseja consultar?`;

/**
 * Fallback pt-BR por domínio (bug prod 2026-10-19: o id interno `accounts`
 * vazava em inglês na UX — "Não consegui processar accounts agora").
 * Sujeito em pt-BR válido nos dois templates acima (`processar ${s}`) e em
 * `renderUnavailable` (`consultar ${s}`). Domínios conferidos contra o
 * roteador (`orchestration/intent-router.ts`): payables = contas a pagar /
 * faturas / boletos; cards = cartões; budgets = orçamentos; goals = metas;
 * memory = memórias do agente; web/general = sem escopo próprio.
 */
export const DOMAIN_SUBJECT_PT_BR: Readonly<Record<string, string>> = {
  accounts: 'suas contas',
  transactions: 'seus lançamentos',
  cards: 'seus cartões',
  payables: 'suas contas a pagar',
  budgets: 'seus orçamentos',
  goals: 'suas metas',
  categories: 'suas categorias',
  memory: 'suas memórias',
  web: 'esta consulta',
  general: 'esta consulta',
};

/** Resolve um id interno de domínio para o sujeito pt-BR do fallback; desconhecido = 'esta consulta'. */
export const resolveDomainSubject = (domain: string): string =>
  Object.hasOwn(DOMAIN_SUBJECT_PT_BR, domain) ? DOMAIN_SUBJECT_PT_BR[domain as keyof typeof DOMAIN_SUBJECT_PT_BR] : 'esta consulta';

/**
 * T3.1 fail-closed financeiro (SPEC §14 H-06): evidence null, timeout ou
 * todos os EvidenceItems com error → esta resposta determinística, sem
 * chamar o LLM. Wording fixo da SPEC, nunca número inventado.
 */
export const FINANCIAL_EVIDENCE_UNAVAILABLE_TEXT =
  'Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.';
export const renderSuccess = (subject: string): string => `${subject} concluído com sucesso.`;
export const renderFailure = (subject: string): string => `Não foi possível concluir ${subject}.`;

export type StatementEntry = Readonly<{
  description: string;
  date: string;
  amountCents: number;
}>;

const isStatementEntry = (value: unknown): value is StatementEntry => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.description === 'string' && typeof entry.date === 'string' && typeof entry.amountCents === 'number';
};

/** Deterministic statement list: every line comes from evidence, totals are computed in code. */
export const renderStatement = (entries: readonly unknown[], subject = 'extrato'): string => {
  const valid = entries.filter(isStatementEntry);
  if (valid.length === 0) return renderEmpty(subject);
  const lines = valid.slice(0, 20).map((entry) => `- ${entry.date} ${entry.description}: ${formatCents(entry.amountCents)}`);
  return `${subject}:\n${lines.join('\n')}`;
};

/**
 * #256 P1 — TOTAL do período a partir do `get_month_summary`. Precedência
 * determinística sobre a listagem: quando o plano pede o resumo e a leitura
 * `api.month-summary` voltou `ok`, a resposta é o total — nunca o extrato.
 * Retorna null quando o payload não carrega nenhum total (o orquestrador cai
 * no caminho generativo com a evidência, nunca no extrato determinístico).
 */
export const renderMonthSummary = (data: unknown): string | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
  const expense = num(record.expenseCents) ?? num(record.expense_cents) ?? num(record.expense);
  const income = num(record.incomeCents) ?? num(record.income_cents) ?? num(record.income);
  const balance = num(record.balanceCents) ?? num(record.balance_cents) ?? num(record.balance);
  const count = num(record.transactionCount) ?? num(record.entryCount) ?? num(record.count);
  const yearMonth = typeof record.yearMonth === 'string'
    ? record.yearMonth
    : typeof record.year_month === 'string'
      ? record.year_month
      : null;
  if (expense === null && income === null && balance === null) return null;
  const parts: string[] = [];
  if (expense !== null) parts.push(`gastos ${formatCents(expense)}`);
  if (income !== null) parts.push(`receitas ${formatCents(income)}`);
  if (balance !== null) parts.push(`saldo ${formatCents(balance)}`);
  const period = yearMonth ?? 'do mês';
  const suffix = count !== null ? ` (${count} lançamentos)` : '';
  return `Resumo ${period}: ${parts.join(', ')}${suffix}.`;
};

export type MutationOutcome = 'proposed' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

/**
 * Inconclusive handoff reply (SPEC §7.8/INV-10, R01): the write WAS SENT and
 * its outcome is unknown — the effect may well have committed. The reply
 * therefore claims neither success NOR the absence of any effect: "Nada foi
 * criado/cancelado" is an unproven assertion of fact. It names what is
 * unknown and points at the safe next step (check the transactions before
 * retrying, so a committed-but-unanswered write is not duplicated). Fixed
 * wording, never model text, and grammatically neutral: only the subject
 * varies, so no participle can disagree with it.
 */
export const renderInconclusive = (subject = 'operação'): string =>
  `${subject} em processamento: o resultado não pôde ser confirmado. Verifique seus lançamentos antes de tentar de novo.`;

/** Deterministic mutation/approval result: fixed wording per outcome, never model text. */
export const renderMutationResult = (
  outcome: MutationOutcome,
  subject = 'operação',
  receipt?: { mutationKind?: unknown },
): string => {
  switch (outcome) {
    case 'succeeded': {
      // Account tools report their own outcome: a deactivation confirmed via
      // the generic coordinator path must not read as a booking ("Lançamento
      // registrado"). Unknown/absent kinds keep the legacy transaction copy.
      if (receipt?.mutationKind === 'accounts.deactivate') return `Conta desativada com sucesso.`;
      if (receipt?.mutationKind === 'accounts.create') return `Conta criada com sucesso.`;
      return `Lançamento registrado com sucesso.`;
    }
    case 'proposed': return `Proposta: ${subject}. Confirma?`;
    case 'cancelled': return `Operação cancelada com segurança.`;
    case 'expired': return `A aprovação expirou. Inicie a operação novamente.`;
    case 'failed': return `Não foi possível concluir a operação.`;
  }
};
