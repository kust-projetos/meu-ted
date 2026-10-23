/**
 * Category-rename interpretation (categories.update — name-only).
 *
 * Delimited, deterministic parsing for the CONVERSATIONAL category-rename
 * flow (`categories.update` drafts). It mirrors the account-rename module
 * in shape but resolves an EXISTING category from the AUTHORITATIVE
 * catalog AND a NEW name:
 * - `hasCategoryRenameSignal` detects an explicit rename intent for a
 *   category (rename verb family — or a name-swap verb next to "nome" —
 *   AND a "categoria(s)"/"subcategoria(s)" anchor);
 * - `parseCategoryRename` splits the turn into the target span and the NEW
 *   name (the text after the LAST "para"/"pra");
 * - `resolveCategoryRenameTarget` binds the target to ONE authoritative
 *   category id plus the new name, never guessing on 0 or 2+ candidates.
 *
 * Hard rules (contract):
 * - the target only ever comes from the catalog read — never invented, never
 *   parsed out of thin air;
 * - the CURRENT name (`expectedName`) is the SERVER's canonical name: it
 *   travels with the proposal as the CAS precondition;
 * - an explicit kind marker (`de despesa`/`de receita`) only NARROWS the
 *   candidates — the kind is never inferred from the name;
 * - a homonym (two categories with the same name under different parents)
 *   is ambiguous — the user is asked which one, never a guess;
 * - a category the catalog reports WITHOUT an explicit kind is unusable
 *   (never a wildcard);
 * - the same name is an honest no-op, never a proposal;
 * - DELETE is NOT here: category deletion stays unsupported (the copy is a
 *   separate, honest limitation — never a "forget").
 */

import { foldEntityName, type EntitySummary } from './entity-resolver.js';

export const CATEGORY_RENAME_TOOL = 'categories.update' as const;

export type CategoryRenameKind = 'expense' | 'income';

const DIACRITICS_RE = /[\u0300-\u036f]/g;

const fold = (value: string): string => value.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();

/**
 * Dedicated rename verbs: the `renomear` family only. "atualizar/editar/
 * alterar" carry no rename verb and never match here — the name-only
 * command is narrower than a generic category edit.
 */
const RENAME_VERBS = [
  'renomear', 'renomeie', 'renomeia', 'renomeiem',
  'renomeei', 'renomeou', 'renomeado', 'renomeada', 'renomeando',
];

/**
 * Name-swap verbs ("mudar"/"trocar"): only a rename when the turn ALSO
 * says "nome" — "mude a cor da categoria" is not a rename.
 */
const NAME_SWAP_VERBS = ['mudar', 'mude', 'muda', 'trocar', 'troque', 'troca'];

const CATEGORY_NOUN_RE = /\b(categoria|categorias|subcategoria|subcategorias)\b/;
const NAME_WORD_RE = /\bnomes?\b/;
const KIND_EXPENSE_RE = /\b(de\s+despesa|de\s+gasto|despesa|gasto|gastos)\b/;
const KIND_INCOME_RE = /\b(de\s+receita|receita|receitas)\b/;

const wordRe = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${words.join('|')})\\b`);

/**
 * Explicit rename signal for a CATEGORY: a rename verb (or a name-swap
 * verb next to "nome") AND a category noun in the same turn. Deliberately
 * narrow — account renames ("renomeie a conta ...") never match, and a
 * generic category edit ("atualize a categoria ...") is not a rename.
 */
export const hasCategoryRenameSignal = (text: string): boolean => {
  const folded = fold(text ?? '');
  if (!CATEGORY_NOUN_RE.test(folded)) return false;
  if (wordRe(RENAME_VERBS).test(folded)) return true;
  return wordRe(NAME_SWAP_VERBS).test(folded) && NAME_WORD_RE.test(folded);
};

/**
 * Explicit rename confirmation for an already-complete draft. Deliberately
 * WITHOUT a bare "sim"/"ok": an isolated "sim" resolves through the
 * coordinator's authoritative listing, never through a draft.
 */
const CONFIRM_RENAME_PHRASES = [
  'pode renomear', 'sim, pode renomear', 'sim, renomeie', 'pode trocar o nome',
  'renomeie', 'renomear', 'trocar o nome', 'troca o nome',
  'confirmo', 'confirmar', 'fechado',
];

/**
 * Tokens that DECIDE, never name: a confirmation/decision word must never
 * become the new category name (nor a target name in a follow-up).
 */
const DECISION_TOKENS: ReadonlySet<string> = new Set([
  'sim', 's', 'yes', 'y', 'ok', 'okay', 'claro', 'beleza', 'nao', 'não',
  'confirmo', 'confirma', 'confirmar', 'confirmado', 'pode', 'pode?', 'manda',
  'faz', 'faça', 'faca', 'quero', 'bora', 'isso', 'nada', 'nenhum', 'obrigado',
  'obrigada', 'por favor', 'valeu', 'cancela', 'cancelar', 'renomeie',
  'renomear', 'renomeia', 'pode renomear', 'pode renomear.', 'sim, renomeie',
]);

/**
 * Comandos de LEITURA/OUTRO domínio: nunca nomeiam uma categoria (nem
 * viram o novo nome de um rascunho pendente).
 */
const FOREIGN_COMMAND_RE =
  /\b(liste|listar|lista|mostre|mostrar|mostra|quais|qual|exclua|excluir|exclui|apague|apagar|remova|remover|remove|desative|desativar|crie|criar|cria|adicione|adicionar|paguei|gastei|recebi|quanto|qual\s+é)\b/i;

/** True for a decision/confirmation token (never a name). */
export const isCategoryRenameDecisionToken = (text: string): boolean => {
  const normalized = (text ?? '').trim().replace(/[\s!.,;:]+$/, '').toLowerCase();
  if (!normalized) return true;
  if (DECISION_TOKENS.has(normalized)) return true;
  return CONFIRM_RENAME_PHRASES.some((phrase) => normalized === phrase);
};

/** True for a foreign/read command (never a name). */
export const isCategoryRenameForeignCommand = (text: string): boolean =>
  FOREIGN_COMMAND_RE.test(text ?? '');

export const isConfirmCategoryRenameText = (text: string): boolean => {
  const trimmed = (text ?? '').trim();
  const folded = fold(trimmed).replace(/[\s!.]+$/, '');
  return trimmed.length <= 32 && CONFIRM_RENAME_PHRASES.some((phrase) => folded === phrase);
};

/**
 * Splits a rename turn into target hint (left) and new-name fragment
 * (right of the LAST "para"/"pra"). Mirrors the account-rename split: the
 * separator needs explicit delimiters on BOTH sides (so "paro"/"praça"
 * never split mid-word) and the ORIGINAL text is kept so the new name
 * preserves the user's casing.
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

const cleanToken = (value: string): string =>
  value.replace(EDGE_PUNCT_RE, '').replace(/\s+/g, ' ').trim();

/** Maximum length of the NEW name (contract: trim 1..120). */
export const MAX_CATEGORY_NAME_LENGTH = 120;

/**
 * The NEW name fragment: whatever survives after stripping edge
 * punctuation/quotes and collapsing whitespace. Empty (or filler-only)
 * remainder = missing name: ask, never invent. A decision token ("pode
 * renomear") or a foreign command is NEVER a name.
 */
export const extractNewCategoryName = (text: string): string | undefined => {
  const { newNameText } = splitRenameParts(text);
  if (newNameText === undefined) return undefined;
  const cleaned = cleanToken(newNameText).slice(0, MAX_CATEGORY_NAME_LENGTH).trim();
  if (!cleaned) return undefined;
  if (isCategoryRenameDecisionToken(cleaned)) return undefined;
  if (isCategoryRenameForeignCommand(cleaned)) return undefined;
  return cleaned;
};

/**
 * The CURRENT category name mentioned by a CONTEXTUAL follow-up (no verb,
 * no noun): the raw text, cleaned. A decision token, a foreign command or a
 * too-short fragment is never a name — the caller keeps asking.
 */
export const extractContextualCategoryName = (text: string): string | undefined => {
  const raw = (text ?? '').trim();
  if (!raw) return undefined;
  if (isCategoryRenameDecisionToken(raw)) return undefined;
  if (isCategoryRenameForeignCommand(raw)) return undefined;
  // An explicit rename verb + the category noun are stripped: what remains
  // names the category ("renomeie a categoria QA Viagem Safira" → "QA Viagem
  // Safira").
  const stripped = raw
    .replace(/\b(renomear|renomeie|renomeia|renomeiem|renomeei|renomeou|renomeado|renomeada|renomeando)\b/gi, ' ')
    .replace(/\b(categoria|categorias|subcategoria|subcategorias)\b/gi, ' ');
  const cleaned = cleanToken(stripped).slice(0, MAX_CATEGORY_NAME_LENGTH).trim();
  if (cleaned.length < 2) return undefined;
  return cleaned;
};

/**
 * The CURRENT category name mentioned by the turn: the span after the
 * category noun (or the whole fragment when the noun is absent — a
 * follow-up that names the category directly). A quoted span wins.
 */
export const extractCategoryTargetName = (text: string): string | undefined => {
  const { targetText } = splitRenameParts(text);
  const quoted = /["“”'‘’]([^"“”'‘’]{1,120})["“”'‘’]/.exec(targetText)?.[1];
  if (quoted) {
    const cleaned = cleanToken(quoted);
    return cleaned ? cleaned : undefined;
  }
  const noun = CATEGORY_NOUN_RE.exec(targetText);
  const afterNoun = noun
    ? targetText.slice((noun.index ?? 0) + noun[0].length)
    : targetText.replace(wordRe(RENAME_VERBS), ' ');
  const cleaned = cleanToken(afterNoun);
  if (!cleaned) return undefined;
  // Strip an explicit kind qualifier ("de receita", "de despesa", ...) so it
  // never leaks into the target name (the kind travels separately).
  const kindStripped = cleaned.replace(/^(de\\s+)?(despesa|gasto|gastos|receita|receitas)\\s+/i, '').trim();
  const finalName = kindStripped || cleaned;
  if (finalName.length > MAX_CATEGORY_NAME_LENGTH) return undefined;
  return finalName;
};

/**
 * Explicit kind marker, read from the turn WITHOUT the quoted spans: a
 * quoted name such as `"Receita"` never sets the kind. Both markers
 * ("despesa ou receita") stay ambiguous (undefined) — the caller clarifies
 * instead of choosing.
 */
const detectKind = (text: string): CategoryRenameKind | undefined => {
  const scope = fold(text.replace(/["“”'‘’][^"“”'‘’]{1,120}["“”'‘’]/g, ' '));
  const hasExpense = KIND_EXPENSE_RE.test(scope);
  const hasIncome = KIND_INCOME_RE.test(scope);
  if (hasExpense && hasIncome) return undefined;
  if (hasIncome) return 'income';
  if (hasExpense) return 'expense';
  return undefined;
};

export type CategoryRenameParse = Readonly<{
  /** True only for an explicit rename intent (rename verb + category noun). */
  isRename: boolean;
  /** The mentioned CURRENT category name (never invented). */
  targetName?: string;
  /** The requested NEW name (never invented). */
  newName?: string;
  /** Explicit kind marker only — narrows homonyms, never inferred. */
  kind?: CategoryRenameKind;
}>;

export const parseCategoryRename = (text: string): CategoryRenameParse => {
  if (!hasCategoryRenameSignal(text)) return { isRename: false };
  const targetName = extractCategoryTargetName(text);
  const newName = extractNewCategoryName(text);
  const kind = detectKind(text);
  return {
    isRename: true,
    ...(targetName ? { targetName } : {}),
    ...(newName ? { newName } : {}),
    ...(kind ? { kind } : {}),
  };
};

/** Folded equality: "QA Viagem" IS "qa viagem" (same name, no proposal). */
export const isSameCategoryName = (a: string, b: string): boolean =>
  fold(a.trim()) === fold(b.trim()) && a.trim().length > 0;

/**
 * R08-parity usability for a CATEGORY: existing, active, inside the
 * authenticated scope, and EXPLICITLY typed (`expense`|`income`). A row
 * without an explicit kind is unusable — never a wildcard (otherwise an
 * untyped row could become rename-eligible).
 */
const isUsableCategory = (entity: EntitySummary, scope?: string): boolean => {
  if (!entity.id || !entity.name) return false;
  if (scope && entity.scopeId !== undefined && entity.scopeId !== scope) return false;
  if (entity.isActive === false) return false;
  const status = entity.status?.trim().toLowerCase();
  if (status !== undefined && status !== 'active') return false;
  const kind = entity.kind?.trim().toLowerCase();
  if (kind !== 'expense' && kind !== 'income') return false;
  return true;
};

const MAX_CLARIFICATION_OPTIONS = 10;

const bulletList = (names: readonly string[]): string =>
  names.slice(0, MAX_CLARIFICATION_OPTIONS).map((name) => `\n• ${name}`).join('');

/**
 * Disambiguation labels: the category name plus its PARENT when the
 * catalog carries one ("Viagem (em Viagem Internacional)"). Homonyms are
 * only distinguishable through the parent — the label must say so.
 */
const categoryOptionLabels = (
  candidates: readonly EntitySummary[],
  catalog: readonly EntitySummary[],
): string[] =>
  candidates.map((candidate) => {
    if (!candidate.parentId) return candidate.name;
    const parent = catalog.find((row) => row.id === candidate.parentId);
    return parent?.name ? `${candidate.name} (em ${parent.name})` : candidate.name;
  });

export type CategoryRenameResolution =
  | Readonly<{ kind: 'resolved'; category: EntitySummary; newName?: string }>
  | Readonly<{ kind: 'ambiguous'; options: readonly string[]; clarification: string }>
  | Readonly<{ kind: 'none'; reason: 'empty' | 'no-match'; clarification: string }>
  | Readonly<{ kind: 'same-name'; category: EntitySummary }>;

/**
 * Contextual resolution inputs (a follow-up turn contributes the TARGET
 * while the draft keeps the new name and the kind qualifier):
 * - `targetName`: the name the user just typed (overrides the parsed one);
 * - `kind`: the qualifier carried from the original turn (overrides the
 *   parsed one).
 */
export type CategoryRenameContext = Readonly<{
  targetName?: string;
  kind?: CategoryRenameKind;
}>;

/**
 * Binds a rename turn to ONE authoritative category plus the new name.
 *
 * Exact (folded) name match wins; an explicit kind marker narrows the
 * candidates FIRST and NEVER falls back — a "de receita" request must not
 * resolve an expense category (an empty narrowed set is a clarification,
 * not a wildcard). Without an exact match a contained match is accepted
 * only when it is UNIQUE — two partial matches are a clarification, never a
 * guess. Zero candidates are a clarification too. A new name identical to
 * the current one answers `same-name` — never a proposal.
 */
export const resolveCategoryRenameTarget = (
  text: string,
  categories: readonly EntitySummary[],
  scope?: string,
  context?: CategoryRenameContext,
): CategoryRenameResolution => {
  const usable = categories.filter((category) => isUsableCategory(category, scope));
  if (usable.length === 0) {
    return {
      kind: 'none',
      reason: 'empty',
      clarification: 'Não encontrei nenhuma categoria disponível para renomear.',
    };
  }
  const parsed = parseCategoryRename(text);
  const newName = parsed.newName;
  const targetName = context?.targetName ?? parsed.targetName;
  const kind = context?.kind ?? parsed.kind;
  if (!targetName) {
    return {
      kind: 'none',
      reason: 'no-match',
      clarification: `Não identifiquei qual categoria renomear. Qual categoria devo renomear?${bulletList(usable.map((category) => category.name))}`,
    };
  }
  const needle = foldEntityName(targetName);
  // An EXPLICIT kind is a hard constraint: the pool is the narrowed set
  // (possibly EMPTY). Falling back to the untyped pool would resolve a
  // "de receita" request against an expense category.
  const pool = kind
    ? usable.filter((category) => category.kind?.trim().toLowerCase() === kind)
    : usable;
  if (pool.length === 0) {
    const qualifier = kind === 'income' ? ' de receita' : kind === 'expense' ? ' de despesa' : '';
    return {
      kind: 'none',
      reason: 'no-match',
      clarification: `Não encontrei a categoria${qualifier} "${targetName}". Qual categoria devo renomear?${bulletList(pool.map((category) => category.name))}`,
    };
  }
  const exact = pool.filter((category) => foldEntityName(category.name) === needle);
  const candidates = exact.length > 0
    ? exact
    : pool.filter((category) => {
      const name = foldEntityName(category.name);
      return name.length > 0 && needle.length > 0 && (name.includes(needle) || needle.includes(name));
    });
  if (candidates.length === 1) {
    const category = candidates[0]!;
    if (newName !== undefined && isSameCategoryName(newName, category.name)) {
      return { kind: 'same-name', category };
    }
    return newName !== undefined
      ? { kind: 'resolved', category, newName }
      : { kind: 'resolved', category };
  }
  if (candidates.length > 1) {
    const options = categoryOptionLabels(candidates, usable);
    return {
      kind: 'ambiguous',
      options,
      clarification: `Encontrei mais de uma categoria com esse nome. Qual delas devo renomear?${bulletList(options)}`,
    };
  }
  const options = (kind ? usable.filter((category) => category.kind?.trim().toLowerCase() === kind) : usable).map((category) => category.name);
  return {
    kind: 'none',
    reason: 'no-match',
    clarification: `Não encontrei a categoria "${targetName}". Qual categoria devo renomear?${bulletList(options)}`,
  };
};

/**
 * A FULL fresh intent (rename verb + category noun + a NEW name): the turn
 * carries its own target AND its own new name — it must start a NEW intent
 * instead of filling the slot of a pending draft.
 */
export const isFullCategoryRenameIntent = (text: string): boolean => {
  const parsed = parseCategoryRename(text);
  return parsed.isRename && parsed.targetName !== undefined && parsed.newName !== undefined;
};

/** Proposal summary: always carries BOTH names (De → Para). */
export const categoryRenameProposeSummary = (expectedName: string, newName: string): string =>
  `renomear a categoria "${expectedName.trim()}" para "${newName.trim()}"`;

/** Read failure: fail-closed, never "no categories" (contract-parity). */
export const CATEGORY_RENAME_READ_FAILURE_TEXT =
  'Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.';

/**
 * Complete draft but no transport: honest limitation, NEVER a confirmation
 * ask (hard rule — no "pode renomear"/"responda sim" without a proposal).
 */
export const categoryRenameNoTransportText = (expectedName: string): string =>
  `Não foi possível propor a renomeação da categoria "${expectedName.trim()}" agora. Tente novamente em instantes.`;

/** Complete draft awaiting an explicit confirmation turn: states, never asks. */
export const categoryRenameReadyNoProposalText = (expectedName: string): string =>
  `A categoria "${expectedName.trim()}" está selecionada para renomeação, mas ainda não há proposta ativa. Tente novamente.`;

/** Same name: honest no-op, never a proposal. */
export const categoryRenameSameNameText = (expectedName: string): string =>
  `A categoria "${expectedName.trim()}" já está com esse nome.`;

/** Missing new name: multi-turn collection, never an invented default. */
export const categoryRenameAskNewNameText = (expectedName: string): string =>
  `Qual o novo nome da categoria "${expectedName.trim()}"?`;
