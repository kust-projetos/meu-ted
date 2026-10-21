/**
 * Account-deactivation interpretation (accounts-deactivate-agent).
 *
 * Delimited, deterministic parsing for the CONVERSATIONAL account-deactivation
 * flow (`accounts.deactivate` drafts). It mirrors the account-creation module
 * in shape but resolves an EXISTING account instead of naming a new one:
 * - `hasAccountDeactivationSignal` detects an explicit deactivation intent;
 * - `resolveDeactivationTarget` binds it to ONE authoritative account id
 *   (name match or single-candidate anaphora), never guessing on 0 or 2+
 *   candidates.
 *
 * Hard rules (contract):
 * - anaphora ("ela") and names resolve ONLY against the authoritative
 *   `list_accounts` evidence passed in by the caller — never invented;
 * - ambiguity (0 or 2+ candidates) is a clarification, never a guess;
 * - no user-facing copy here promises "desfazer" (undo of a deactivation
 *   has no verified support — escalation point (a) of the task).
 */

import { foldEntityName, type EntitySummary } from './entity-resolver.js';

export const ACCOUNT_DEACTIVATE_TOOL = 'accounts.deactivate' as const;

const DIACRITICS_RE = /[\u0300-\u036f]/g;

const fold = (value: string): string => value.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();

const wordRe = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${words.join('|')})\\b`);

/**
 * Verbs that are account-domain by themselves: "desative nubank" names no
 * "conta" noun and no pronoun, yet it can only mean an account. Generic
 * removal verbs ("excluir", "apagar", ...) need an account anchor below.
 */
const ACCOUNT_SPECIFIC_VERBS = [
  'desativar', 'desative', 'desativa', 'desativem', 'desativei', 'desativou',
  'desativado', 'desativada', 'desativando',
  'inativar', 'inative', 'inativa', 'inativem', 'inativado', 'inativada',
  'deletei', 'deletou',
];

/** Generic removal verbs: only a deactivation turn next to an account anchor. */
const GENERIC_REMOVAL_VERBS = [
  'apagar', 'apague', 'apaga', 'apaguem',
  'excluir', 'exclua', 'exclui', 'excluam', 'excluido', 'excluida',
  'deletar', 'delete', 'deleta', 'deletem',
  'remover', 'remove', 'remova', 'removam',
  'fechar', 'feche', 'fecha', 'fechem',
  'encerrar', 'encerre', 'encerra', 'encerrem',
];

/** What makes a generic removal verb account-bound: the noun or an anaphora. */
const ACCOUNT_ANCHORS = [
  'conta', 'contas',
  'ela', 'elas', 'dela', 'delas', 'essa', 'essas', 'dessa', 'dessas',
];

/**
 * Nouns that pin a generic removal verb to ANOTHER domain: "exclua a
 * transação" carries an anchor ("ela"? no — but "esta"? also no) ... the
 * guard below only matters when an anchor IS present ("delete ela da
 * categoria x" is still an account turn by the anaphora rule; a turn that
 * names a foreign domain without "conta" is not).
 */
const FOREIGN_DOMAIN_NOUNS = [
  'transacao', 'transacoes', 'lancamento', 'lancamentos',
  'receita', 'receitas', 'despesa', 'despesas',
  'categoria', 'categorias', 'fatura', 'faturas',
  'orcamento', 'orcamentos', 'meta', 'metas', 'lembrete', 'lembretes',
];

/**
 * Nouns that pin a generic removal verb to a NON-account object: "exclua a
 * despesa de ontem da conta Nubank" is about the transaction, never an
 * account deactivation — even though an account anchor is present. Checked
 * AFTER account-specific verbs (explicit "desative" wins) and BEFORE the
 * anchor rule. Anaphora-only turns ("delete ela") carry none of these nouns
 * and keep flowing to deactivation.
 */
const TRANSACTION_OBJECT_NOUNS = [
  'despesa', 'despesas', 'receita', 'receitas',
  'lancamento', 'lancamentos', 'transacao', 'transacoes',
  'transferencia', 'transferencias', 'fatura', 'faturas',
];

/**
 * Explicit deactivation signal: an account-specific verb anywhere, or a
 * generic removal verb next to an account anchor (noun or anaphora) without
 * a foreign-domain noun stealing the turn.
 */
export const hasAccountDeactivationSignal = (text: string): boolean => {
  const folded = fold(text);
  if (wordRe(ACCOUNT_SPECIFIC_VERBS).test(folded)) return true;
  if (wordRe(TRANSACTION_OBJECT_NOUNS).test(folded)) return false;
  if (!wordRe(GENERIC_REMOVAL_VERBS).test(folded)) return false;
  if (!wordRe(ACCOUNT_ANCHORS).test(folded)) return false;
  if (wordRe(FOREIGN_DOMAIN_NOUNS).test(folded) && !/\bcontas?\b/.test(folded)) return false;
  return true;
};

const CONFIRM_DEACTIVATE_PHRASES = [
  'pode desativar', 'sim, pode desativar', 'sim, desative', 'pode inativar',
  'sim, pode inativar', 'desative', 'desativar', 'desativa',
  'inativar', 'inative', 'confirmo', 'confirmar', 'fechado',
];

/**
 * Explicit deactivation confirmation for an already-complete draft.
 * Deliberately WITHOUT a bare "sim"/"ok": an isolated "sim" resolves
 * through the coordinator's authoritative listing (a missing target keeps
 * rejecting as today — hard rule (4)), never through a draft.
 */
export const isConfirmDeactivateText = (text: string): boolean => {
  const folded = fold(text.trim()).replace(/[\s!.]+$/, '');
  return text.trim().length <= 32 && CONFIRM_DEACTIVATE_PHRASES.some((a) => folded === a);
};

/** Anaphoric references that continue onto the single contextual account. */
const ANAPHORA_RE = /\b(ela|elas|dela|delas|essa|essas|dessa|dessas)\b/;

/** R08-parity usability: existing, active and inside the scope. */
const isUsableAccount = (entity: EntitySummary, scope?: string): boolean => {
  if (!entity.id || !entity.name) return false;
  if (scope && entity.scopeId !== undefined && entity.scopeId !== scope) return false;
  if (entity.isActive === false) return false;
  const status = entity.status?.trim().toLowerCase();
  if (status !== undefined && status !== 'active') return false;
  return true;
};

const MAX_CLARIFICATION_OPTIONS = 10;

const bulletList = (names: readonly string[]): string =>
  names.slice(0, MAX_CLARIFICATION_OPTIONS).map((name) => `\n• ${name}`).join('');

export type DeactivationResolution =
  | Readonly<{ kind: 'resolved'; account: EntitySummary }>
  | Readonly<{ kind: 'ambiguous'; options: readonly string[]; clarification: string }>
  | Readonly<{ kind: 'none'; reason: 'empty' | 'no-match'; clarification: string }>;

/**
 * Binds a deactivation turn to ONE authoritative account. Name match wins
 * (folded exact-or-contained, the same predicate the entity resolver uses);
 * otherwise an anaphora resolves only onto a single usable candidate.
 * Zero or 2+ candidates are clarifications — never a guess (hard rule 1).
 */
export const resolveDeactivationTarget = (
  text: string,
  accounts: readonly EntitySummary[],
  scope?: string,
): DeactivationResolution => {
  const usable = accounts.filter((account) => isUsableAccount(account, scope));
  if (usable.length === 0) {
    return {
      kind: 'none',
      reason: 'empty',
      clarification: 'Não encontrei nenhuma conta disponível para desativar.',
    };
  }
  const haystack = foldEntityName(text);
  const named = usable.filter((account) => {
    const name = foldEntityName(account.name);
    return name.length > 0 && haystack.length > 0 && (name === haystack || name.includes(haystack) || haystack.includes(name));
  });
  if (named.length === 1) return { kind: 'resolved', account: named[0]! };
  if (named.length > 1) {
    const options = named.map((account) => account.name);
    return {
      kind: 'ambiguous',
      options,
      clarification: `Encontrei mais de uma conta para sua mensagem. Qual conta devo desativar?${bulletList(options)}`,
    };
  }
  if (ANAPHORA_RE.test(haystack)) {
    if (usable.length === 1) return { kind: 'resolved', account: usable[0]! };
    const options = usable.map((account) => account.name);
    return {
      kind: 'ambiguous',
      options,
      clarification: `Encontrei ${usable.length} contas. Qual delas devo desativar?${bulletList(options)}`,
    };
  }
  const options = usable.map((account) => account.name);
  return {
    kind: 'none',
    reason: 'no-match',
    clarification: `Não identifiquei qual conta desativar. Qual conta devo desativar?${bulletList(options)}`,
  };
};

/** Proposal summary: always carries the resolved NAME (hard rule 2). */
export const deactivateProposeSummary = (name: string): string =>
  `desativar a conta "${name.trim()}"`;

/** Read failure: fail-closed, never "no accounts" (contract-parity). */
export const DEACTIVATE_READ_FAILURE_TEXT =
  'Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.';

/**
 * Complete draft but no transport: honest limitation, NEVER a confirmation
 * ask (hard rule 3 — no "pode desativar"/"responda sim" without a proposal).
 */
export const deactivateNoTransportText = (name: string): string =>
  `Não foi possível propor a desativação da conta "${name.trim()}" agora. Tente novamente em instantes.`;

/** Complete draft awaiting an explicit confirmation turn: states, never asks. */
export const deactivateReadyNoProposalText = (name: string): string =>
  `A conta "${name.trim()}" está selecionada para desativação, mas ainda não há proposta ativa. Tente novamente.`;
