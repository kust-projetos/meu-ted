/**
 * Category-creation interpretation (categories.create drafts).
 *
 * Delimited, deterministic parsing for the CONVERSATIONAL category-creation
 * flow (`categories.create` drafts). Strict, minimal, no external data:
 * - creation intent = creation verb + "categoria"/"subcategoria";
 * - `name` = quoted/named span or bare token after the noun (never the kind
 *   word, never the parent clause);
 * - `kind` ONLY from an explicit marker (`de despesa`/`de gasto`/`despesa` →
 *   expense, `de receita` → income) — never inferred from the name;
 * - `parentQuery` ONLY from an explicit parent clause (`filha de X`,
 *   `sub de X`, `em X`, `dentro de X`) — never inferred from a partial or
 *   ambiguous token; resolution against the full catalog happens in the
 *   orchestrator (exact match required, no partial inference).
 * - update/delete verbs are NOT creation (separate refusal path).
 */

export const CATEGORY_CREATE_TOOL = 'categories.create' as const;

export type CategoryDraftKind = 'expense' | 'income';

export type CategoryCreationParse = Readonly<{
  /** True only for an explicit creation intent (creation verb + categoria). */
  isCreation: boolean;
  name?: string;
  kind?: CategoryDraftKind;
  parentQuery?: string;
  /**
   * R7-F3: true when the turn names a SUBcategoria without an explicit
   * parent clause. The intent requires a parent — the fresh flow must
   * clarify (never a silent macro); only an explicit "sem pai" decision in
   * a continuation drops it.
   */
  requiresParent?: boolean;
}>;

export type CategorySlotContribution = Readonly<{
  name?: string;
  kind?: CategoryDraftKind;
  parentQuery?: string;
  dropParent?: boolean;
}>;

const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');

const fold = (value: string): string =>
  value.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();

const CREATION_VERBS = [
  'criar', 'cria', 'crie', 'criam', 'criamos', 'criei', 'criou',
  'cadastrar', 'cadastra', 'cadastre', 'cadastrei',
  'adicionar', 'adicione', 'abrir', 'abra', 'abri', 'abriu',
  'nova', 'novo', 'abertura',
];

const UPDATE_DELETE_VERBS = [
  'renomear', 'renomeia', 'renomeie', 'renomeei',
  'atualizar', 'atualiza', 'atualize',
  'editar', 'edita', 'edite',
  'alterar', 'altera', 'altere',
  'excluir', 'exclua', 'exclui', 'excluiu',
  'deletar', 'delete', 'desativar', 'desativa', 'desative',
  'apagar', 'apague', 'remover', 'remove',
];

const CATEGORY_NOUN_RE = /\b(categoria|categorias|subcategoria|subcategorias)\b/;
const KIND_EXPENSE_RE = /\b(de\s+despesa|de\s+gasto|despesa|gasto|gastos)\b/;
const KIND_INCOME_RE = /\b(de\s+receita|receita|receitas)\b/;
// Explicit parent clause only: "filha de X", "sub de X", "em X", "dentro de X".
// (matched inline in parseCategoryCreation / parseCategorySlotContribution; no shared binding needed)

const hasVerb = (folded: string, verbs: readonly string[]): boolean =>
  verbs.some((verb) => new RegExp(`\\b${verb}\\b`).test(folded));

export const hasCategoryCreateSignal = (text: string): boolean => {
  const folded = fold(text);
  return hasVerb(folded, CREATION_VERBS) && CATEGORY_NOUN_RE.test(folded);
};

export const hasCategoryUpdateDeleteSignal = (text: string): boolean => {
  const folded = fold(text);
  return hasVerb(folded, UPDATE_DELETE_VERBS) && CATEGORY_NOUN_RE.test(folded);
};

const cleanToken = (value: string): string => value.trim().replace(/\s+/g, ' ');

const stripParentClause = (value: string): string =>
  value.replace(/\b(?:filha\s+de|filho\s+de|sub\s+de|dentro\s+de|\bem\b|pai|da\s+categoria|de\s+categoria)\s+[^,.;?]+$/gi, ' ');

const stripQuotedSpans = (value: string): string =>
  value.replace(/["“”'‘’][^"“”'‘’]{1,120}["“”'‘’]/g, ' ');

/**
 * R7-F2: kind is read from the turn WITHOUT quoted spans (a quoted name
 * such as `"Receita"` never sets kind) and WITHOUT the parent clause (a
 * parent named "Receita Federal" never sets kind). When BOTH markers are
 * present ("despesa ou receita") the result is ambiguous → undefined —
 * the draft clarifies instead of choosing.
 */
const detectKind = (text: string): CategoryDraftKind | undefined => {
  const scope = fold(stripQuotedSpans(stripParentClause(text)));
  const hasExpense = KIND_EXPENSE_RE.test(scope);
  const hasIncome = KIND_INCOME_RE.test(scope);
  if (hasExpense && hasIncome) return undefined;
  if (hasIncome) return 'income';
  if (hasExpense) return 'expense';
  return undefined;
};

const stripQuotedSurround = (value: string): string =>
  value.replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();

export const parseCategoryCreation = (text: string): CategoryCreationParse => {
  if (!hasCategoryCreateSignal(text)) return { isCreation: false };
  // Parent clause is stripped FIRST so it never leaks into the name.
  // Matched on the ORIGINAL text (case-insensitive) to preserve spelling;
  // the folded form only decides kind (diacritics-insensitive).
  const parentMatch = /\b(?:filha\s+de|filho\s+de|sub\s+de|dentro\s+de|em|pai|da\s+categoria|de\s+categoria)\s+([^,.;?]+?)\s*$/i.exec(text);
  const parentQueryRaw = parentMatch?.[1]?.trim();
  // R7-F2: kind from the whole turn MINUS quoted spans and the parent
  // clause; dual markers ("despesa ou receita") stay ambiguous (undefined).
  const kind = detectKind(text);
  // Name: parent clause stripped FIRST (a quoted parent is never the
  // name); quoted span in the remainder wins, else bare token after
  // categoria + optional kind strip.
  const original = text;
  const withoutParentForName = stripParentClause(original);
  const quoted = /["“”'‘’]([^"“”'‘’]{1,120})["“”'‘’]/.exec(withoutParentForName)?.[1]?.trim();
  let candidate = quoted ?? '';
  if (!candidate) {
    const afterNoun = withoutParentForName.split(/categoria[s]?|subcategoria[s]?/i)[1] ?? '';
    candidate = afterNoun;
    // Strip kind markers textually (folded positions differ; operate on
    // the raw remainder with case-insensitive removes).
    candidate = candidate
      .replace(/\b(de\s+despesa|de\s+gasto|despesa|gastos?|de\s+receita|receitas?)\b/gi, ' ')
      .replace(/\b(criar|cria|crie|cadastrar|cadastra|cadastre|adicionar|adicione|nova|novo)\b/gi, ' ');
  }
  const name = cleanToken(candidate).replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim() || undefined;
  const parentQuery = parentQueryRaw ? stripQuotedSurround(cleanToken(parentQueryRaw)) || undefined : undefined;
  // R7-F3: a SUBcategoria without an explicit parent clause requires a
  // parent — the caller clarifies instead of creating a silent macro.
  const isSubcategory = /\bsubcategoria[s]?\b/i.test(text);
  const requiresParent = isSubcategory && !parentQuery ? true : undefined;
  return {
    isCreation: true,
    ...(name ? { name } : {}),
    ...(kind ? { kind } : {}),
    ...(parentQuery ? { parentQuery } : {}),
    ...(requiresParent ? { requiresParent } : {}),
  };
};

/**
 * R7-F1: contextual slot contribution for an ACTIVE category draft.
 * Unlike {@link parseCategoryCreation} (fresh-turn detector: creation verb
 * + categoria required), a follow-up answers with bare slots — `de
 * despesa`, a name, `em X`, `sem pai` — and carries no verb. Never
 * invents: kind uses the same quoted/parent-excluded, dual-ambiguous
 * {@link detectKind}; name never comes from kind/verb/noun words.
 */
export const parseCategorySlotContribution = (text: string): CategorySlotContribution => {
  const raw = text ?? '';
  if (!raw.trim()) return {};
  // Confirmation tokens never contribute slots: they decide, they do not
  // rename/retype/reparent the draft.
  if (/^\s*(sim|confirmo|confirmar|pode\s+criar|manda|faz|quero)(\s+(sim|confirmo|criar|confirmar))?\s*$/i.test(raw.trim())) {
    return {};
  }
  const dropParent = /\bsem\s+pai\b/i.test(raw) ? true : undefined;
  const parentMatch = /\b(?:filha\s+de|filho\s+de|sub\s+de|dentro\s+de|em|pai|da\s+categoria|de\s+categoria)\s+([^,.;?]+?)\s*$/i.exec(raw);
  const parentQueryRaw = parentMatch?.[1]?.trim();
  const parentQuery = parentQueryRaw ? stripQuotedSurround(cleanToken(parentQueryRaw)) || undefined : undefined;
  const kind = detectKind(raw);
  // Quoted name search runs on the remainder WITHOUT the parent clause (a
  // quoted parent is never the name).
  const remainderForName = stripParentClause(raw);
  const quoted = /["“”'‘’]([^"“”'‘’]{1,120})["“”'‘’]/.exec(remainderForName)?.[1]?.trim();
  let candidate: string;
  if (quoted) {
    candidate = quoted;
  } else {
    candidate = stripParentClause(raw)
      .replace(/\b(de\s+despesa|de\s+gasto|despesa|gastos?|de\s+receita|receitas?)\b/gi, ' ')
      .replace(/\b(criar|cria|crie|criei|criou|cadastrar|cadastra|cadastre|cadastrei|adicionar|adicione|abrir|abra|abri|abriu|nova|novo|abertura)\b/gi, ' ')
      .replace(/\b(categoria[s]?|subcategoria[s]?)\b/gi, ' ')
      .replace(/\bsem\s+pai\b/gi, ' ')
      .replace(/\b(filha\s+de|filho\s+de|sub\s+de|dentro\s+de|pai|da\s+categoria|de\s+categoria)\b/gi, ' ');
  }
  const cleaned = stripQuotedSurround(cleanToken(candidate));
  // Foreign/generic commands and bare conjunctions never become a name.
  const FOREIGN_OR_GENERIC = new Set(['obrigado', 'obrigada', 'por favor', 'sim', 'nao', 'não', 'ok', 'cancelar', 'e', 'ou', 'de', 'em', 'para']);
  const name = cleaned && cleaned.length >= 2 && cleaned.length <= 120 && !FOREIGN_OR_GENERIC.has(cleaned.toLowerCase()) ? cleaned : undefined;
  const out: { name?: string; kind?: CategoryDraftKind; parentQuery?: string; dropParent?: boolean } = {};
  if (name) out.name = name;
  if (kind) out.kind = kind;
  if (parentQuery) out.parentQuery = parentQuery;
  if (dropParent) out.dropParent = true;
  return out;
};
