/**
 * Account-rename interpretation (ted-local-account-rename-client).
 *
 * Delimited, deterministic parsing for the CONVERSATIONAL account-rename
 * flow (`accounts.update` drafts). It mirrors the account-deactivation
 * module in shape but resolves an EXISTING account AND a NEW name:
 * - `hasAccountRenameSignal` detects an explicit rename intent;
 * - `resolveRenameTarget` binds it to ONE authoritative account id
 *   (name match or single-candidate anaphora) plus the new name parsed
 *   after "para"/"pra", never guessing on 0 or 2+ candidates.
 *
 * Hard rules (contract):
 * - the signal is the `renomear` verb family next to an account anchor
 *   ("conta"/"contas"/"nome"/"nomes") — balance/card updates and other
 *   domains never match;
 * - anaphora and names resolve ONLY against the authoritative
 *   `list_accounts` evidence passed in by the caller — never invented;
 * - ambiguity (0 or 2+ candidates) is a clarification, never a guess;
 * - a missing new name is a multi-turn question, never an invented
 *   default; the same name answers "já está assim" without a proposal;
 * - no user-facing copy here promises "desfazer" (undo of a rename
 *   has no verified support).
 */

import { foldEntityName, type EntitySummary } from './entity-resolver.js';

export const ACCOUNT_RENAME_TOOL = 'accounts.update' as const;

const DIACRITICS_RE = /[\u0300-\u036f]/g;

const fold = (value: string): string => value.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();

const wordRe = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${words.join('|')})\\b`);

/**
 * Dedicated rename verbs: the `renomear` family only. Balance updates
 * ("atualize o saldo ..."), card updates and every other domain carry no
 * such verb and never match — even next to an account anchor.
 */
const RENAME_VERBS = [
  'renomear', 'renomeie', 'renomeia', 'renomeiem',
  'renomeei', 'renomeou', 'renomeado', 'renomeada', 'renomeando',
];

/** What makes a rename turn account-bound: the noun (or an anaphora). */
const RENAME_ANCHORS = [
  'conta', 'contas',
  'nome', 'nomes',
  'ela', 'elas', 'dela', 'delas', 'essa', 'essas', 'dessa', 'dessas',
];

/**
 * Explicit rename signal: a `renomear`-family verb AND an account anchor
 * ("conta"/"nome") in the same turn. Deliberately narrow — "atualize o
 * saldo da conta ..." (no verb) and "atualize o cartão ..." (no verb, no
 * anchor) are NOT rename turns; they only ever continue an already-active
 * rename draft.
 */
export const hasAccountRenameSignal = (text: string): boolean => {
  const folded = fold(text);
  return wordRe(RENAME_VERBS).test(folded) && wordRe(RENAME_ANCHORS).test(folded);
};

const CONFIRM_RENAME_PHRASES = [
  'pode renomear', 'sim, pode renomear', 'sim, renomeie', 'pode trocar o nome',
  'renomeie', 'renomear', 'trocar o nome', 'troca o nome',
  'confirmo', 'confirmar', 'fechado',
];

/**
 * Explicit rename confirmation for an already-complete draft.
 * Deliberately WITHOUT a bare "sim"/"ok": an isolated "sim" resolves
 * through the coordinator's authoritative listing (a missing target keeps
 * rejecting as today), never through a draft.
 */
export const isConfirmRenameText = (text: string): boolean => {
  const folded = fold(text.trim()).replace(/[\s!.]+$/, '');
  return text.trim().length <= 32 && CONFIRM_RENAME_PHRASES.some((a) => folded === a);
};

/** Anaphoric references that continue onto the single contextual account. */
const ANAPHORA_RE = /\b(ela|elas|dela|delas|essa|essas|dessa|dessas)\b/;

/**
 * R08-parity usability + rename scope: existing, active, inside the scope,
 * and EXPLICITLY bank/cash. The authoritative `list_accounts` read carries
 * `kind` on `EntitySummary`; a row without an explicit kind is unusable —
 * never a wildcard (HIGH1: otherwise a credit_card row would become
 * rename-eligible).
 */
const isUsableAccount = (entity: EntitySummary, scope?: string): boolean => {
  if (!entity.id || !entity.name) return false;
  if (scope && entity.scopeId !== undefined && entity.scopeId !== scope) return false;
  if (entity.isActive === false) return false;
  const status = entity.status?.trim().toLowerCase();
  if (status !== undefined && status !== 'active') return false;
  const kind = entity.kind?.trim().toLowerCase();
  if (kind !== 'bank' && kind !== 'cash') return false;
  return true;
};

const MAX_CLARIFICATION_OPTIONS = 10;

const bulletList = (names: readonly string[]): string =>
  names.slice(0, MAX_CLARIFICATION_OPTIONS).map((name) => `\n• ${name}`).join('');

/** Maximum length of the NEW name (contract: trim 1..120). */
export const MAX_RENAME_NAME_LENGTH = 120;

/**
 * Splits a rename turn into target hint (left) and new-name fragment
 * (right of the LAST "para"/"pra"). Operates on the ORIGINAL text
 * (case-insensitive, no folding) so offsets stay valid and the new name
 * keeps the user's casing. The separator needs explicit delimiters
 * (whitespace/punctuation/start/end) on BOTH sides — LOW5: `\b` is
 * ASCII-only, so it accepted "paro" and split "praça" mid-word. Returns
 * the full text as target hint when no separator is present.
 */
const SEPARATOR_RE = /(^|[\s"'(\-])(para|pra)(?=[\s"'.,;:!?)\-]|$)/gi;

const splitRenameParts = (text: string): { targetText: string; newNameText?: string } => {
  const matches = [...text.matchAll(SEPARATOR_RE)];
  if (matches.length === 0) return { targetText: text };
  const last = matches[matches.length - 1]!;
  const separatorStart = (last.index ?? 0) + (last[1]?.length ?? 0);
  const targetText = text.slice(0, separatorStart);
  const newNameText = text.slice(separatorStart + (last[2]?.length ?? 0));
  return { targetText, newNameText };
};

const EDGE_PUNCT_RE = /^[\s.,;:!?("|')\u00ab\u00bb]+|[\s.,;:!?("|')\u00ab\u00bb]+$/g;

/**
 * The NEW name fragment: whatever survives after stripping edge
 * punctuation/quotes and collapsing whitespace. Empty (or filler-only)
 * remainder = missing name: ask, never invent.
 */
export const extractNewAccountName = (text: string): string | undefined => {
  const { newNameText } = splitRenameParts(text);
  if (newNameText === undefined) return undefined;
  const cleaned = newNameText
    .replace(EDGE_PUNCT_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RENAME_NAME_LENGTH)
    .trim();
  return cleaned ? cleaned : undefined;
};

/** Folded equality: "Nubank" IS "nubank" (same name, no proposal). */
export const isSameAccountName = (a: string, b: string): boolean =>
  fold(a.trim()) === fold(b.trim()) && a.trim().length > 0;

export type RenameResolution =
  | Readonly<{ kind: 'resolved'; account: EntitySummary; newName?: string }>
  | Readonly<{ kind: 'ambiguous'; options: readonly string[]; clarification: string }>
  | Readonly<{ kind: 'none'; reason: 'empty' | 'no-match'; clarification: string }>
  | Readonly<{ kind: 'same-name'; account: EntitySummary }>;

/**
 * Binds a rename turn to ONE authoritative account plus the new name.
 * Name match wins (folded exact-or-contained, the same predicate the
 * entity resolver uses); otherwise an anaphora resolves only onto a
 * single usable candidate. Zero or 2+ candidates are clarifications —
 * never a guess. A new name identical to the current one answers
 * `same-name` — never a proposal.
 */
export const resolveRenameTarget = (
  text: string,
  accounts: readonly EntitySummary[],
  scope?: string,
): RenameResolution => {
  const usable = accounts.filter((account) => isUsableAccount(account, scope));
  if (usable.length === 0) {
    return {
      kind: 'none',
      reason: 'empty',
      clarification: 'Não encontrei nenhuma conta disponível para renomear.',
    };
  }
  const { targetText, newNameText } = splitRenameParts(text);
  const newName = newNameText !== undefined ? extractNewAccountName(text) : undefined;
  const haystack = foldEntityName(targetText);
  const named = usable.filter((account) => {
    const name = foldEntityName(account.name);
    return name.length > 0 && haystack.length > 0 && (name === haystack || name.includes(haystack) || haystack.includes(name));
  });
  if (named.length === 1) {
    const account = named[0]!;
    if (newName !== undefined && isSameAccountName(newName, account.name)) {
      return { kind: 'same-name', account };
    }
    return newName !== undefined ? { kind: 'resolved', account, newName } : { kind: 'resolved', account };
  }
  if (named.length > 1) {
    const options = named.map((account) => account.name);
    return {
      kind: 'ambiguous',
      options,
      clarification: `Encontrei mais de uma conta para sua mensagem. Qual conta devo renomear?${bulletList(options)}`,
    };
  }
  if (ANAPHORA_RE.test(haystack)) {
    if (usable.length === 1) {
      const account = usable[0]!;
      if (newName !== undefined && isSameAccountName(newName, account.name)) {
        return { kind: 'same-name', account };
      }
      return newName !== undefined ? { kind: 'resolved', account, newName } : { kind: 'resolved', account };
    }
    const options = usable.map((account) => account.name);
    return {
      kind: 'ambiguous',
      options,
      clarification: `Encontrei ${usable.length} contas. Qual delas devo renomear?${bulletList(options)}`,
    };
  }
  const options = usable.map((account) => account.name);
  return {
    kind: 'none',
    reason: 'no-match',
    clarification: `Não identifiquei qual conta renomear. Qual conta devo renomear?${bulletList(options)}`,
  };
};

/** Proposal summary: always carries BOTH names (De → Para). */
export const renameProposeSummary = (expectedName: string, newName: string): string =>
  `renomear a conta "${expectedName.trim()}" para "${newName.trim()}"`;

/** Read failure: fail-closed, never "no accounts" (contract-parity). */
export const RENAME_READ_FAILURE_TEXT =
  'Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.';

/**
 * Complete draft but no transport: honest limitation, NEVER a confirmation
 * ask (hard rule — no "pode renomear"/"responda sim" without a proposal).
 */
export const renameNoTransportText = (expectedName: string): string =>
  `Não foi possível propor a renomeação da conta "${expectedName.trim()}" agora. Tente novamente em instantes.`;

/** Complete draft awaiting an explicit confirmation turn: states, never asks. */
export const renameReadyNoProposalText = (expectedName: string): string =>
  `A conta "${expectedName.trim()}" está selecionada para renomeação, mas ainda não há proposta ativa. Tente novamente.`;

/** Same name: honest no-op, never a proposal. */
export const renameSameNameText = (expectedName: string): string =>
  `A conta "${expectedName.trim()}" já está com esse nome.`;

/** Missing new name: multi-turn collection, never an invented default. */
export const renameAskNewNameText = (expectedName: string): string =>
  `Qual o novo nome da conta "${expectedName.trim()}"?`;
