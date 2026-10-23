import type { EvidenceEnvelope } from '../evidence/evidence-envelope.js';
import { formatCents } from '../evidence/financial-formatters.js';

/**
 * W1-TED-ACCOUNT-GROUNDING: deterministic grounding of account balances.
 *
 * Rules (plan item 3, Onda 1 + FIX-TED-ACCOUNT-GROUNDING-EDGE-CASES +
 * FIX-TED-NAME-SPECIFICITY-AND-LIST-LIMIT +
 * FIX-TED-UNMATCHED-QUALIFIER-AND-AMBIGUOUS-CAP +
 * FIX-TED-GROUNDING-SEMANTIC-SCOPE + FIX-TED-GROUNDING-SEGMENT-SCOPING +
 * FIX-TED-ALL-ACCOUNTS-UNKNOWN-TOTAL + FIX-TED-ALL-ACCOUNTS-EXCLUDE-CARD +
 * FIX-TED-GROUNDING-PRESENTATION-CLAUSE):
 * - Never attribute one account's balance to another: a unique name match
 *   selects exactly that account; a missing/duplicated name clarifies with
 *   NO figures.
 * - Contained names resolve by specificity: "Nubank PJ" selects only the
 *   "Nubank PJ" account (never the shorter "Nubank" prefix), using the full
 *   token set — including short tokens like "PJ" that the lenient matcher
 *   ignores. A shorter name still wins when the longer one is not fully
 *   mentioned ("Nubank" selects "Nubank", not "Nubank PJ"). When specificity
 *   cannot narrow to a single account, the turn clarifies with NO figures.
 *   The same rule applies to card names. Explicitly mixed conta+cartão
 *   queries list kind-aware ONLY when they split lexically into a funds
 *   segment and a card segment with exactly one fully-named account of the
 *   correct kind per segment and no unmatched qualifier; no global token
 *   union crosses segments.
 * - Card questions resolve ONLY against `kind === 'credit_card'` evidence:
 *   a bank homonym never answers a card question, and a generic card
 *   question lists only cards. A card question naming a SPECIFIC card that
 *   is absent clarifies with NO figures (never the other cards' balances);
 *   only a genuinely generic plural question lists cards. A card question
 *   naming a SHORTER base ("Nubank?") when the card carries a qualifier
 *   ("Nubank PJ") clarifies with NO figures — never a prefix answer — and a
 *   bank homonym NEVER answers a card question: only an explicitly mixed
 *   query that splits into funds/card segments with one fully-named account
 *   of the correct kind per segment keeps the kind-aware listing;
 *   anything less clarifies with NO figures and no substitution.
 * - Names composed solely of generic balance vocabulary ("Saldo",
 *   "Cartão", "Conta") never match nominally: a generic question keeps its
 *   generic listing instead of single-selecting the generic-named account.
 * - Clarifications cap every name list at 20 with an explicit
 *   "mostrando X de N" note plus a partiality warning when the read was
 *   incomplete — never a silent omission.
 * - Never sum heterogeneous semantics: bank/cash balances are funds,
 *   credit_card balances are DEBT. A total request over mixed (or unknown)
 *   kinds lists each account kind-aware, never merges, and asks for scope.
 * - A homogeneous bank/cash total over a truncated list (>20) OMITS the
 *   subtotal instead of contradicting the partial scope.
 * - Invalid rows / partial reads are never presented as a complete total:
 *   partiality is stated explicitly; long lists are capped with an explicit
 *   "showing X of N" note instead of silent omission. Notes describe the
 *   partial list only and never claim anything about a total that is not
 *   presented.
 * - Account type comes ONLY from the `kind` origin field (API/projection).
 *   Never inferred from the name. Absent kind renders neutrally and is
 *   excluded from any subtotal.
 * - Card-balance questions resolve ONLY against `kind === 'credit_card'`
 *   evidence. There is no card-accounts tool with comparable semantics, so
 *   without such evidence the turn clarifies the limitation instead of
 *   borrowing another account's balance.
 * - TED-LOCAL-ACCOUNT-PARTIAL-BALANCE: a single significant normalized
 *   partial name match ("saldo QA Aurora" for "QA Aurora banco") may read,
 *   and a bare anaphora ("e o saldo daquela conta") resolves only with an
 *   unequivocal single-account scope — never on ambiguity, never with
 *   figures from another account, never for invented/absent names. Both new
 *   resolutions are forbidden on incomplete evidence (partial flag or
 *   omitted rows); the existing exact-name proof is preserved as-is.
 *   Single-character non-fillers ("Q", "1", "2") are unmatched qualifiers
 *   (veto), never positive evidence and never silently dropped.
 */

export type AccountKind = 'bank' | 'cash' | 'credit_card' | 'unknown';

export type GroundedAccount = Readonly<{
  name: string;
  kind: AccountKind;
  balanceCents: number;
}>;

export type AccountsEvidence = Readonly<{
  accounts: readonly GroundedAccount[];
  /** Rows seen but unusable (missing name/balance): the list is partial. */
  omittedCount: number;
  /** True when the read itself signaled incompleteness. */
  partial: boolean;
}>;

const KNOWN_KINDS: ReadonlySet<string> = new Set(['bank', 'cash', 'credit_card']);

export const normalizeKind = (value: unknown): AccountKind =>
  typeof value === 'string' && KNOWN_KINDS.has(value) ? (value as AccountKind) : 'unknown';

const ACCOUNTS_SOURCE = 'api.accounts';
const INCOMPLETE_REF = 'accounts:incomplete';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  !!value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Extracts kind-carrying account balances from an evidence envelope.
 * Returns null when the envelope carries NO accounts evidence at all
 * (neither usable rows nor an incompleteness marker).
 */
export const extractAccountsEvidence = (envelope: EvidenceEnvelope): AccountsEvidence | null => {
  const accounts: GroundedAccount[] = [];
  let omittedCount = 0;
  let seen = false;
  for (const item of envelope.items) {
    if (item.source !== ACCOUNTS_SOURCE) continue;
    if (item.ref === INCOMPLETE_REF && item.status === 'ok') {
      const record = asRecord(item.data);
      const omitted = record && typeof record.omittedCount === 'number' ? Math.trunc(record.omittedCount) : 0;
      if (Number.isFinite(omitted) && omitted > 0) omittedCount += omitted;
      seen = true;
      continue;
    }
    if (item.status !== 'ok') continue;
    seen = true;
    const record = asRecord(item.data);
    if (!record || typeof record.accountName !== 'string' || typeof record.balanceCents !== 'number') {
      omittedCount += 1;
      continue;
    }
    accounts.push({
      name: record.accountName,
      kind: normalizeKind(record.kind),
      balanceCents: Math.trunc(record.balanceCents),
    });
  }
  if (!seen) return null;
  return { accounts, omittedCount, partial: omittedCount > 0 };
};

const fold = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const tokens = (value: string): string[] =>
  fold(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);

const CARD_WORDS = new Set(['cartao', 'cartoes', 'fatura', 'faturas']);

export const mentionsCard = (text: string): boolean => tokens(text).some((token) => CARD_WORDS.has(token));

export const mentionsBalance = (text: string): boolean =>
  /\b(saldo|saldos|quanto tenho|quanto eu tenho)\b/.test(fold(text).replace(/\s+/g, ' '));

export const seeksAccountBalance = (text: string): boolean => mentionsBalance(text);

const LISTING_VERB_RE = /\b(liste|listar|lista|listagem|mostre|mostrar|mostra|exiba|exibir|quais|ver|veja|diga|diz)\b/;
const ACCOUNT_NOUN_RE = /\b(conta|contas)\b/;
// Scopes a listing must never steal: bills, statements and mutations.
// "liste minhas contas a pagar" is a payables turn, "liste minhas faturas" a
// statements turn, "crie uma conta" a mutation — none of them is an account
// listing even though each carries "conta(s)". A `sem cartão` negation is an
// exclusion, not a card request, so it stays listable (checked below via
// isNegatedCardExclusion rather than a blanket card-word ban).
const LISTING_EXCLUSION_RE = /\b(pagar|venc|boleto|fatura|extrato|transac|lancamento)\b/;
const LISTING_MUTATION_RE = /\b(crie|criar|criacao|cadastr|adicion|nova|novo|abra|abrir)\b/;

/**
 * True for a plain account-listing turn ("liste minhas contas") that carries
 * NO balance word. Such turns used to fall through to the generative provider
 * — where a small model emits tool-call markup, the sanitizer strips it, and
 * the turn collapses into the clarification fallback despite healthy evidence.
 */
export const seeksAccountListing = (text: string): boolean => {
  const folded = fold(text).replace(/\s+/g, ' ').trim();
  if (!LISTING_VERB_RE.test(folded)) return false;
  if (!ACCOUNT_NOUN_RE.test(folded)) return false;
  if (LISTING_EXCLUSION_RE.test(folded)) return false;
  if (!isNegatedCardExclusion(folded) && mentionsCard(folded)) return false;
  if (LISTING_MUTATION_RE.test(folded)) return false;
  return true;
};

const TOTAL_PATTERN = /\b(total|totais|soma|somando|somado|tudo junto|geral|consolidado|somatorio)\b/;

export const asksForTotal = (text: string): boolean => TOTAL_PATTERN.test(fold(text).replace(/\s+/g, ' '));

/**
 * Nominal selection WITHOUT fuzzy matching: an account matches when every
 * significant token of its name appears in the utterance. Names composed
 * ONLY of short (2-letter) tokens such as "XP" fall back to their full
 * token set so the exact short name stays selectable; composite names keep
 * the lenient behavior (short tokens like "PJ" in "Nubank PJ" are ignored
 * for matching and used only for specificity ranking). Card words
 * ("cartão") inside an account name do not force a match on their own —
 * they behave like any other token. Names composed SOLELY of generic
 * balance vocabulary ("Saldo", "Cartão", "Conta") NEVER match nominally,
 * so a generic question ("qual meu saldo?", "saldo do cartão?") keeps its
 * generic listing instead of single-selecting the generic-named account.
 */
export const matchAccountsByName = (text: string, accounts: readonly GroundedAccount[]): GroundedAccount[] => {
  const utterance = new Set(tokens(text));
  return accounts.filter((account) => {
    if (isGenericOnlyName(account.name)) return false;
    const longTokens = tokens(account.name).filter((token) => token.length > 2);
    const nameTokens = longTokens.length > 0 ? longTokens : tokens(account.name);
    if (nameTokens.length === 0) return false;
    return nameTokens.every((token) => utterance.has(token));
  });
};

/**
 * TED-LOCAL-ACCOUNT-PARTIAL-BALANCE: significant partial match (no fuzzy
 * matching, no prefixes, no invented names). An account is a partial
 * candidate when it shares at least one NON-generic name token with the
 * utterance AND the shared set is significant: it holds a token of length
 * 4+ ("aurora") or at least two tokens ("qa"+"aurora"). A lone short token
 * ("Q", "QA" alone) never identifies anything. Generic vocabulary
 * ("banco", "conta", "saldo") never counts toward significance, so a bare
 * "banco" or a single letter can never single-select. Generic-only names
 * never match. Callers must require a UNIQUE candidate plus the unchanged
 * unmatched-qualifier veto before rendering any figure.
 */
export const matchSignificantPartial = (
  text: string,
  accounts: readonly GroundedAccount[],
): GroundedAccount[] => {
  const utterance = new Set(tokens(text));
  return accounts.filter((account) => {
    if (isGenericOnlyName(account.name)) return false;
    const shared = fullNameTokens(account.name).filter(
      (token) => utterance.has(token) && !isGenericBalanceWord(token),
    );
    if (shared.length === 0) return false;
    return shared.length >= 2 || shared.some((token) => token.length >= 4);
  });
};

/**
 * TED-LOCAL-ACCOUNT-PARTIAL-BALANCE: anaphoric demonstratives that point at
 * the previously established account ("aquela conta", "essa conta"). Kept
 * OUT of the shared generic sets on purpose: they are scope-neutral filler
 * only inside the partial/anaphora resolution below — everywhere else they
 * stay visible so existing vetoes keep failing closed.
 */
const ANAPHORA_DEMONSTRATIVES: ReadonlySet<string> = new Set([
  'aquela',
  'aquelas',
  'essa',
  'essas',
  'esta',
  'estas',
  'naquela',
  'naquelas',
  'nessa',
  'nessas',
  'nesta',
  'nestas',
  'daquela',
  'daquelas',
  'dessa',
  'dessas',
  'desta',
  'destas',
]);

const ANAPHORA_RE = /\b(aquel[ae]s?|ess[ae]s?|est[ae]s?|naquel[ae]s?|ness[ae]s?|nest[ae]s?|daquel[ae]s?|dess[ae]s?|dest[ae]s?)\s+(conta|contas)\b/;

/** The utterance with the anaphoric phrase blanked, so demonstratives never veto a named match. */
const withoutAnaphora = (text: string): string =>
  fold(text).replace(new RegExp(ANAPHORA_RE.source, 'gi'), ' ');

/**
 * Single-character fillers: articles/conjunctions that carry no nominal
 * content ("o", "a", "e" — "é" folds to "e"). Every OTHER single character
 * ("Q", "1", "2", "X") is a potential unmatched qualifier: `tokens()` drops
 * it, so without this the turn silently forgets something the user named.
 * Short tokens NEVER confer positive eligibility (matching still uses
 * `tokens()`); they only veto, conservatively.
 */
const SHORT_FILLER_TOKENS: ReadonlySet<string> = new Set(['e', 'o', 'a']);

const shortQualifierTokens = (text: string): string[] =>
  fold(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length === 1 && !SHORT_FILLER_TOKENS.has(token));

/**
 * A bare anaphora ("e o saldo daquela conta"): the anaphoric phrase is
 * present and every other token is generic, anaphoric, or a single-char
 * filler — the turn points at nothing specific. A dropped qualifier ("Q",
 * "2") breaks bareness: it vetoes. Resolvable ONLY against an unequivocal
 * authoritative context (exactly one account in scope); with 2+ accounts it
 * must ask.
 */
const isBareAnaphora = (text: string): boolean =>
  ANAPHORA_RE.test(fold(text)) &&
  tokens(text).every((token) => isGenericBalanceWord(token) || ANAPHORA_DEMONSTRATIVES.has(token)) &&
  shortQualifierTokens(text).length === 0;

const MAX_LISTED_ACCOUNTS = 20;

const kindLabel = (kind: AccountKind): string =>
  kind === 'credit_card' ? 'cartão — dívida' : kind === 'bank' ? 'conta' : kind === 'cash' ? 'dinheiro' : 'conta';

const renderAccountLine = (account: GroundedAccount): string => {
  const value = formatCents(account.balanceCents);
  if (account.kind === 'credit_card') return `- ${account.name} (${kindLabel(account.kind)}): ${value}.`;
  if (account.kind === 'unknown') return `- ${account.name} (tipo não confirmado): ${value}.`;
  return `- ${account.name}: ${value}.`;
};

/**
 * Kind label for the deterministic account LISTING ("liste minhas contas"):
 * every listed row names its type explicitly — bank/cash rows never render
 * bare — while card and unconfirmed rows keep the exact labels the balance
 * path already uses. Zero/negative bank/cash figures pass through untouched
 * (ADR-018, no clamp).
 */
const accountTypeLabel = (kind: AccountKind): string =>
  kind === 'bank' ? 'Banco' : kind === 'cash' ? 'Espécie' : kind === 'credit_card' ? 'cartão — dívida' : 'tipo não confirmado';

const renderAccountListLine = (account: GroundedAccount): string =>
  `- ${account.name} (${accountTypeLabel(account.kind)}): ${formatCents(account.balanceCents)}.`;

/**
 * Full token set of an account name, INCLUDING short (2-letter) tokens such
 * as "PJ"/"XP" that the lenient matcher ignores. Used only for specificity
 * ranking — never to widen matching.
 */
const fullNameTokens = (name: string): string[] => tokens(name);

/**
 * Narrows nominal matches by specificity WITHOUT widening or inventing
 * matches. First keeps only the matches the utterance fully names (every
 * full token present); when nothing is fully named, keeps everybody so the
 * pre-existing lenient behavior applies. Then drops matches strictly less
 * specific than another survivor (full token set strictly contained).
 * `narrowed` is true only when a survivor was dropped — i.e. a containment
 * ambiguity existed and was (perhaps only partially) resolved.
 */
const selectMostSpecific = (
  text: string,
  matches: readonly GroundedAccount[],
): { candidates: GroundedAccount[]; narrowed: boolean } => {
  if (matches.length <= 1) return { candidates: [...matches], narrowed: false };
  const utterance = new Set(tokens(text));
  const fullyNamed = matches.filter((account) => fullNameTokens(account.name).every((token) => utterance.has(token)));
  if (fullyNamed.length === 0) return { candidates: [...matches], narrowed: false };
  const tokenSets = fullyNamed.map((account) => new Set(fullNameTokens(account.name)));
  const candidates = fullyNamed.filter((_, index) => {
    const current = tokenSets[index] ?? new Set<string>();
    return !tokenSets.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      if (current.size >= other.size) return false;
      return [...current].every((token) => other.has(token));
    });
  });
  return { candidates, narrowed: candidates.length < matches.length };
};

/**
 * Generic (non-name) words of a card-balance question: balance, card,
 * account, total, question and filler vocabulary. Any leftover token means
 * the utterance names something SPECIFIC (e.g. "XP"), so an empty card
 * match must clarify instead of listing every card.
 */
const GENERIC_CARD_QUERY_WORDS: ReadonlySet<string> = new Set([
  'saldo',
  'saldos',
  'quanto',
  'tenho',
  'tem',
  'tenha',
  'eu',
  'meu',
  'minha',
  'meus',
  'minhas',
  'cartao',
  'cartoes',
  'fatura',
  'faturas',
  'conta',
  'contas',
  'total',
  'totais',
  'soma',
  'somando',
  'somado',
  'somatorio',
  'geral',
  'consolidado',
  'junto',
  'tudo',
  'qual',
  'quais',
  'como',
  'esta',
  'estao',
  'mostre',
  'mostra',
  'mostrar',
  'exiba',
  'exibir',
  'liste',
  'listar',
  'lista',
  'ver',
  'veja',
  'diga',
  'diz',
  'todos',
  'todas',
  'todo',
  'toda',
  'esse',
  'essa',
  'este',
  'desse',
  'dessa',
  'deste',
  'desta',
  'isso',
  'isto',
  'me',
  'um',
  'uma',
  'uns',
  'umas',
  'de',
  'da',
  'do',
  'das',
  'dos',
  'as',
  'os',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'se',
  'que',
  'com',
  'sem',
  'para',
  'por',
  'sobre',
  'entre',
  'seu',
  'sua',
  'seus',
  'suas',
  'nosso',
  'nossa',
  'ele',
  'ela',
  'eles',
  'elas',
  'voce',
  'voces',
  'dele',
  'dela',
  'aqui',
  'agora',
  'hoje',
  'ainda',
  'mais',
  'favor',
  'gentileza',
  'obrigado',
  'obrigada',
  'quando',
  'onde',
  'foi',
  'era',
  'sao',
  'porque',
]);

const hasSpecificCardName = (text: string): boolean =>
  tokens(text).some((token) => !GENERIC_CARD_QUERY_WORDS.has(token)) ||
  shortQualifierTokens(text).length > 0;

/**
 * Extra generic vocabulary for balance questions outside the card scope
 * (bank/cash markers, conjunctions, polite fillers). Combined with
 * GENERIC_CARD_QUERY_WORDS to detect an UNMATCHED qualifier: any leftover
 * specific token means the utterance names something the selected account
 * does not carry (e.g. "PJ" when only "Nubank" exists).
 */
const EXTRA_GENERIC_BALANCE_WORDS: ReadonlySet<string> = new Set([
  'banco',
  'bancos',
  'agencia',
  'agencias',
  'cofre',
  'carteira',
  'poupanca',
  'corrente',
  'ou',
  'mas',
  'nem',
  'ja',
  'so',
  'ao',
  'aos',
  'pra',
  'pro',
  'num',
  'numa',
  'ate',
  'tambem',
]);

const isGenericBalanceWord = (token: string): boolean =>
  GENERIC_CARD_QUERY_WORDS.has(token) || EXTRA_GENERIC_BALANCE_WORDS.has(token);

/**
 * FIX-TED-GROUNDING-PRESENTATION-CLAUSE: an output-presentation instruction
 * ("? Responda citando o valor em reais.") is a LAYER of the utterance, not
 * scope. Tokenizing it into the utterance destroys information — the loose
 * tokenization (`tokens`) drops punctuation, so a presentation word can never
 * be told apart from a scope word carrying the same spelling ("conta Valor?",
 * "banco Valor"). It is therefore removed by a deterministic LOCAL stage,
 * BEFORE any nominal matching, as a closed grammar over a COMPLETE and
 * ANCHORED trailing clause; the tail is removed atomically or not at all.
 *
 * Three deliberate asymmetries keep the existing vetoes intact:
 * - Presentation vocabulary is DISJOINT from every scope lexicon below (no
 *   conta/banco/cartao/fatura/tudo/geral/todo/corrente/poupanca/dinheiro), so
 *   a clause can never rewrite funds/card/broad/total scope.
 * - A SCOPE or aggregation demand typed INSIDE the clause is not consumed by
 *   the presentation layer: the clause is still recognized, and the demand is
 *   PRESERVED in `scopeText` ("Informe o total." still asks for a total).
 * - A NOMINAL complement is scope, not presentation: a preposition linked to
 *   an article/noun ("sobre o Valor") and a capitalized proper noun ("citando
 *   o Valor") name something, so the clause is rejected and the whole
 *   utterance keeps the vetoes fail-closed.
 * - It is not folded into `isGenericBalanceWord`: an account literally named
 *   e.g. "Valor" keeps its nominal semantics, and a presentation-looking word
 *   INSIDE the scope ("conta Nubank Valor?") stays scope and keeps the
 *   unmatched-qualifier veto fail-closed.
 *
 * The recognized clause is returned for observability only: it never selects
 * an account, never alters scope, and never authorizes a figure.
 */
const PRESENTATION_VERBS: ReadonlySet<string> = new Set([
  'responda',
  'responde',
  'responder',
  'informe',
  'informar',
  'mostre',
  'mostrar',
  'exiba',
  'exibir',
  'liste',
  'listar',
  'diga',
  'dizer',
  'cite',
  'citar',
  'citando',
  'citado',
  'citada',
  'mencione',
  'mencionar',
  'apresente',
  'apresentar',
]);

const PRESENTATION_FILLERS: ReadonlySet<string> = new Set([
  'o',
  'os',
  'a',
  'as',
  'um',
  'uma',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'do',
  'da',
  'de',
  'com',
  'por',
  'para',
  'sobre',
  'usando',
  'mesmo',
  'formato',
  'apenas',
  'somente',
  'favor',
  'gentilmente',
  'obrigado',
  'obrigada',
]);

/**
 * Content words that make the clause a presentation demand, not filler.
 * Disjoint from SCOPE_DEMAND_TOKENS by construction: `total`/`totais` are
 * AGGREGATION demands (TOTAL_PATTERN), never presentation, and were removed
 * from this set so they can never be consumed by the presentation layer.
 */
const PRESENTATION_CONTENT: ReadonlySet<string> = new Set([
  'valor',
  'valores',
  'saldo',
  'saldos',
  'montante',
  'montantes',
  'resposta',
  'respostas',
  'reais',
  'real',
  'moeda',
  'moedas',
]);

/**
 * Every token here is CONSUMED by a scope predicate further down
 * (`mentionsCard`, `mentionsFundsMarker`, `isBroadAllAccountsQuery`,
 * `isUnsupportedSubtypeQuery`, `isExplicitFundsOnlyTotal`, `TOTAL_PATTERN`).
 * None of them is presentation vocabulary: when one appears inside a
 * recognized clause, the clause is still presentation but the DEMAND is
 * preserved in `scopeText`, so the scope lexicon always wins the collision.
 */
const SCOPE_DEMAND_TOKENS: ReadonlySet<string> = new Set([
  // funds / card markers
  'conta',
  'contas',
  'banco',
  'bancos',
  'cartao',
  'cartoes',
  'fatura',
  'faturas',
  // broad all-accounts language
  'tudo',
  'toda',
  'todas',
  'todo',
  'todos',
  'geral',
  // unsupported subtype / kind scope
  'corrente',
  'correntes',
  'poupanca',
  'poupancas',
  'dinheiro',
  'especie',
  'bancari',
  'bancaria',
  'bancarias',
  // aggregation demand (TOTAL_PATTERN)
  'total',
  'totais',
  'soma',
  'somando',
  'somado',
  'somatorio',
  'consolidado',
]);

/**
 * Prepositions that link a clause to a COMPLEMENT. Anything after one of them
 * is a nominal complement that NAMES something ("Responda sobre o Valor",
 * "sobre valores", "do total"), so the clause is not an unequivocal
 * presentation demand: stripping it would turn a named or scoped question into
 * a listing of every account's balances. Failing closed keeps the whole
 * utterance — and therefore every existing veto — in place.
 */
const NOMINAL_LINK_PREPOSITIONS: ReadonlySet<string> = new Set([
  'sobre',
  'de',
  'do',
  'da',
  'dos',
  'das',
]);

/**
 * A strict clause token: letters only. Punctuation (`"`, `(`, digits from
 * `1.500`) stays visible and rejects the clause instead of being normalized
 * away — that is what makes quoted or malformed presentation fail closed.
 */
const PRESENTATION_TOKEN_RE = /^[a-z]+$/;

type PresentationAnalysis = {
  /** The recognized clause, folded — returned for observability only. */
  clause: string;
  /** Scope demands carried by the clause; preserved in `scopeText`. */
  demands: readonly string[];
};

const isPresentationClause = (clause: string): PresentationAnalysis | null => {
  const rawWords = clause.split(' ').filter((word) => word.length > 0);
  if (rawWords.length === 0) return null;
  const words = rawWords.map(fold);
  if (!PRESENTATION_VERBS.has(words[0] as string)) return null;
  const demands: string[] = [];
  let carriesContent = false;
  for (let index = 0; index < words.length; index += 1) {
    const raw = rawWords[index] as string;
    const word = words[index] as string;
    if (!PRESENTATION_TOKEN_RE.test(word)) return null;
    // A capitalized token after the verb is a PROPER NOUN ("citando o
    // Valor"): an account name, never presentation vocabulary.
    if (index > 0 && /[A-ZÀ-Þ]/.test(raw)) return null;
    if (SCOPE_DEMAND_TOKENS.has(word)) {
      if (!demands.includes(word)) demands.push(word);
      continue;
    }
    if (PRESENTATION_CONTENT.has(word)) carriesContent = true;
    else if (!PRESENTATION_VERBS.has(word) && !PRESENTATION_FILLERS.has(word)) return null;
  }
  // A NOMINAL complement is scope, not a presentation demand: any word after a
  // complement-linking preposition names something the clause is about.
  for (let index = 0; index < words.length; index += 1) {
    if (!NOMINAL_LINK_PREPOSITIONS.has(words[index] as string)) continue;
    if (index + 1 < words.length) return null;
  }
  // A bare verb ("Responda") says nothing about presentation: without a
  // content word — or a scope demand, which is preserved and never consumed
  // — the clause is an incomplete demand and is left in place.
  if (!carriesContent && demands.length === 0) return null;
  return { clause: words.join(' '), demands };
};

export type PresentationSplit = Readonly<{
  /**
   * Logical scope: the utterance without the recognized presentation clause,
   * PLUS any scope/aggregation demand the clause carried (never consumed by
   * the presentation layer).
   */
  scopeText: string;
  /** The recognized clause verbatim (normalized), or null when none matched. */
  presentation: string | null;
}>;

/**
 * Splits a trailing presentation clause off the utterance. The clause must be
 * anchored at the END (it starts right after the last sentence terminator that
 * has a non-empty head) and must match the grammar ENTIRELY. Anything else —
 * no head, no terminator, a nominal complement, quoted text, a trailing
 * second question — keeps the utterance whole so the existing vetoes still
 * see it. Segmentation runs on the RAW text (only whitespace is collapsed)
 * so the grammar can still see capitalization; each word is folded locally.
 */
export const splitPresentationClause = (text: string): PresentationSplit => {
  const raw = text.replace(/\s+/g, ' ').trim();
  const whole = fold(raw);
  const body = raw.replace(/[?!.\s]+$/, '');
  const unchanged: PresentationSplit = { scopeText: whole, presentation: null };
  let cut = -1;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const char = body.charAt(index);
    if (char === '?' || char === '!' || char === '.') {
      cut = index;
      break;
    }
  }
  if (cut < 0) return unchanged;
  const head = fold(body.slice(0, cut).trim());
  const analysis = isPresentationClause(body.slice(cut + 1).trim());
  if (!head || !analysis) return unchanged;
  // A scope/aggregation demand typed inside the clause stays in scope: the
  // scope lexicon always wins the collision with the presentation layer.
  const headTokens = new Set(tokens(head));
  const preserved = analysis.demands.filter((demand) => !headTokens.has(demand));
  const scopeText = preserved.length > 0 ? `${head} ${preserved.join(' ')}` : head;
  return { scopeText, presentation: analysis.clause };
};

/**
 * True when every token of the account name is generic balance vocabulary.
 * Such names ("Saldo", "Cartão", "Conta") can never single-select a turn:
 * they carry no specific nominal content, so any match through them is
 * spurious. Declared here (after the generic sets) and consumed by
 * matchAccountsByName at call time.
 */
const isGenericOnlyName = (name: string): boolean => {
  const nameTokens = fullNameTokens(name);
  return nameTokens.length > 0 && nameTokens.every((token) => isGenericBalanceWord(token));
};

/** Explicit funds-side marker: "conta(s)"/"banco(s)". */
const mentionsFundsMarker = (text: string): boolean =>
  /\b(conta|contas|banco|bancos)\b/.test(fold(text).replace(/\s+/g, ' '));

/**
 * FIX-TED-ALL-ACCOUNTS-UNKNOWN-TOTAL + FIX-TED-ALL-ACCOUNTS-EXCLUDE-CARD:
 * broad all-accounts language ("todas/todos/geral/tudo") scopes to every
 * account — never to a filtered bank/cash subset — EXCEPT an explicit
 * `sem cartão` (or exceto/excluindo + cartão) exclusion, which prevails over
 * broad language and scopes to bank/cash. An explicit bank/cash-only total
 * is otherwise recognized ONLY by exclusion/kind scoping
 * ("só/somente/apenas/exceto/sem cartão",
 * "corrente/poupança/bancária/dinheiro") WITHOUT broad language; anything
 * ambiguous fails closed so an unknown kind is never silently excluded from
 * a total presented as complete.
 */
const isBroadAllAccountsQuery = (text: string): boolean =>
  /\b(toda|todas|todo|todos|geral|tudo)\b/.test(fold(text).replace(/\s+/g, ' '));

const isExplicitFundsOnlyTotal = (text: string): boolean => {
  const folded = fold(text).replace(/\s+/g, ' ').trim();
  // FIX-TED-ALL-ACCOUNTS-EXCLUDE-CARD: `sem cartão` exclusion prevails over
  // broad `todas/todos/geral/tudo` — it scopes to bank/cash, never the full
  // pool. Any other broad query keeps the full pool.
  if (isBroadAllAccountsQuery(text)) {
    return (
      isNegatedCardExclusion(text) ||
      (/\b(exceto|excluindo)\b/.test(folded) && mentionsCard(text))
    );
  }
  const hasExclusion = /\b(so|somente|apenas|exceto|excluindo|sem cartao|sem cartoes|sem fatura|sem faturas)\b/.test(folded);
  const hasKindScope =
    /\b(corrente|poupanca|bancari|dinheiro|especie)\b/.test(folded);
  return hasExclusion || hasKindScope;
};

/**
 * FIX-TED-GROUNDING-BROAD-SCOPE-EDGECASES: a `sem cartão/fatura`
 * negation is an exclusion — never a card request. It must be recognized
 * before `cardQuestion` so the turn never enters the card-clarification
 * branch merely because the word cartão occurs.
 */
const isNegatedCardExclusion = (text: string): boolean =>
  /\bsem\s+(cartao|cartoes|fatura|faturas)\b/.test(fold(text).replace(/\s+/g, ' '));

/**
 * FIX-TED-GROUNDING-BROAD-SCOPE-EDGECASES: unsupported checking/savings
 * subtype. The store carries only broad `bank`/`cash` — no
 * corrente/poupança distinction — so such a query fail-closes before any
 * numeric answer instead of summing bank+cash as "corrente".
 */
const isUnsupportedSubtypeQuery = (text: string): boolean =>
  /\b(corrente|correntes|poupanca|poupancas)\b/.test(fold(text).replace(/\s+/g, ' '));

/**
 * True when the utterance carries a specific (non-generic) token absent
 * from the account's full name. A single lenient match with such a leftover
 * is an UNMATCHED qualifier ("Nubank PJ?" with only "Nubank" present) and
 * must clarify with NO figures instead of answering the shorter prefix.
 * FIX-TED-GROUNDING-PRESENTATION-CLAUSE: presentation is NOT special-cased
 * here — the clause stage already removed a recognized trailing clause from
 * the text this receives, and a presentation-looking word that survives it
 * ("conta Nubank Valor?") is scope and keeps the veto fail-closed.
 */
const hasUnmatchedQualifier = (text: string, account: GroundedAccount): boolean => {
  const owned = new Set(fullNameTokens(account.name));
  // Single-character non-fillers ("Q", "1", "2") veto UNLESS they belong to
  // the account's canonical name as standalone words ("Reserva 2" answers
  // "saldo Reserva 2"; a lone qualifier never matches just because some
  // other account's longer token contains it — matching never sees shorts).
  const named = new Set(
    fold(account.name)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  return (
    tokens(text).some((token) => !isGenericBalanceWord(token) && !owned.has(token)) ||
    shortQualifierTokens(text).some((token) => !named.has(token))
  );
};

const isFullyNamed = (text: string, account: GroundedAccount): boolean => {
  const utterance = new Set(tokens(text));
  return fullNameTokens(account.name).every((token) => utterance.has(token));
};

/**
 * FIX-TED-GROUNDING-SEGMENT-SCOPING: explicit segment scoping for mixed
 * conta+cartão queries. A mixed listing is allowed ONLY when the utterance
 * splits lexically into two segments (`... conta/banco <nome> ... e ...
 * cartão <nome> ...` or the inverse). Each account is matched against ONLY
 * its own segment AND its correct kind; no global token union crosses
 * segments. Ambiguous splits fail closed (clarify with NO figures).
 */
type MixedSegments = { fundsText: string; cardText: string };

const FUNDS_MARKER_RE = /\b(conta|contas|banco|bancos)\b/;
const CARD_MARKER_RE = /\b(cartao|cartoes|fatura|faturas)\b/;
const SEGMENT_SEPARATOR_RE = /(\s+e\s+|\s+com\s+|,|;|\+|\s+mais\s+)/;

const splitMixedSegments = (text: string): MixedSegments | null => {
  const folded = fold(text).replace(/\s+/g, ' ').trim();
  const fundsMatch = FUNDS_MARKER_RE.exec(folded);
  const cardMatch = CARD_MARKER_RE.exec(folded);
  if (!fundsMatch || !cardMatch) return null;
  const fundsIdx = fundsMatch.index;
  const cardIdx = cardMatch.index;
  const findLastSeparator = (haystack: string): { index: number; length: number } | null => {
    const re = new RegExp(SEGMENT_SEPARATOR_RE.source, 'g');
    let last: { index: number; length: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) last = { index: m.index, length: m[0].length };
    return last;
  };
  if (fundsIdx < cardIdx) {
    const between = folded.slice(fundsIdx, cardIdx);
    const sep = findLastSeparator(between);
    if (!sep) return null;
    const cut = fundsIdx + sep.index;
    const fundsText = folded.slice(0, cut).trim();
    const cardText = folded.slice(cut + sep.length).trim();
    if (!fundsText || !cardText) return null;
    if (!FUNDS_MARKER_RE.test(fundsText) || CARD_MARKER_RE.test(fundsText)) return null;
    if (!CARD_MARKER_RE.test(cardText) || FUNDS_MARKER_RE.test(cardText)) return null;
    return { fundsText, cardText };
  }
  const between = folded.slice(cardIdx, fundsIdx);
  const sep = findLastSeparator(between);
  if (!sep) return null;
  const cut = cardIdx + sep.index;
  const cardText = folded.slice(0, cut).trim();
  const fundsText = folded.slice(cut + sep.length).trim();
  if (!fundsText || !cardText) return null;
  if (!CARD_MARKER_RE.test(cardText) || FUNDS_MARKER_RE.test(cardText)) return null;
  if (!FUNDS_MARKER_RE.test(fundsText) || CARD_MARKER_RE.test(fundsText)) return null;
  return { fundsText, cardText };
};

/**
 * Resolves exactly one account inside its own segment: nominal match, then
 * specificity narrowing, then full-name + no-unmatched-qualifier checks.
 * Anything else (zero, ambiguity, partial qualifier) returns null so the
 * caller clarifies with NO figures.
 */
const resolveSingleInSegment = (
  segment: string,
  pool: readonly GroundedAccount[],
): GroundedAccount | null => {
  const matches = matchAccountsByName(segment, pool);
  if (matches.length === 0) return null;
  const { candidates } = selectMostSpecific(segment, matches);
  if (candidates.length !== 1 || !candidates[0]) return null;
  const single = candidates[0];
  if (!isFullyNamed(segment, single)) return null;
  if (hasUnmatchedQualifier(segment, single)) return null;
  return single;
};

/**
 * Note for an explicitly requested multi-name listing capped at 20:
 * declares the omitted rows — never a silent truncation — plus a
 * partiality warning when the read itself was incomplete.
 */
const renderMultiListNote = (
  evidence: AccountsEvidence,
  listedCount: number,
  candidateCount: number,
): string | null => {
  const notes: string[] = [];
  if (candidateCount > listedCount) notes.push(`mostrando ${listedCount} de ${candidateCount} (lista parcial)`);
  if (evidence.partial) notes.push('alguns dados estavam incompletos e não entraram na lista');
  if (notes.length === 0) return null;
  return `Observação: ${notes.join('; ')}.`;
};

const availableNames = (accounts: readonly GroundedAccount[]): string => {
  const listed = accounts
    .slice(0, MAX_LISTED_ACCOUNTS)
    .map((account) => (account.kind === 'credit_card' ? `${account.name} (cartão)` : account.name));
  const joined = listed.join(', ');
  if (accounts.length > listed.length) return `${joined} (mostrando ${listed.length} de ${accounts.length})`;
  return joined;
};

const partialSuffix = (evidence: AccountsEvidence): string =>
  evidence.partial ? ' Alguns dados estavam incompletos e não entraram na lista.' : '';

const renderDuplicateClarification = (
  matches: readonly GroundedAccount[],
  noun: 'conta' | 'cartão',
  evidence: AccountsEvidence,
): string => {
  const listed = matches.slice(0, MAX_LISTED_ACCOUNTS);
  const options = listed.map((account) => `- ${account.name} (${kindLabel(account.kind)})`).join('\n');
  const head =
    noun === 'cartão'
      ? 'Encontrei mais de um cartão com esse nome. Qual deles você quer ver?'
      : 'Encontrei mais de uma conta com esse nome. Qual delas você quer ver?';
  const body =
    matches.length > listed.length
      ? `${head}\n${options}\nMostrando ${listed.length} de ${matches.length} (lista parcial) — refine o nome para ver os demais.`
      : `${head}\n${options}`;
  return `${body}${partialSuffix(evidence)}`;
};

const renderPartialNote = (evidence: AccountsEvidence, listed: number, total: number): string | null => {
  const notes: string[] = [];
  if (total > listed) notes.push(`mostrando ${listed} de ${total} contas (lista parcial)`);
  if (evidence.partial) notes.push('alguns dados estavam incompletos e não entraram na lista');
  if (notes.length === 0) return null;
  return `Observação: ${notes.join('; ')}.`;
};

/**
 * Deterministic non-empty account LISTING ("liste minhas contas").
 *
 * Every line comes from evidence — figures are never invented — and the turn
 * never reaches the relay, so a small model can no longer collapse it into
 * tool-call markup that the sanitizer strips. The balance path above is
 * untouched: this branch fires ONLY when no balance word is present.
 *
 * Invariants mirror the balance renderer: a named listing resolves exactly
 * like a named balance (one fully-named account renders alone; an unmatched
 * qualifier or an unresolvable ambiguity clarifies with NO figures, never
 * another account's balance); a funds marker scopes to non-card rows; long
 * lists cap at 20 with an explicit note. Returns null when the listing owns
 * nothing — an empty pool stays with the read-absence renderer (cadastro
 * offer) and a card-only pool stays with the existing paths.
 */
const renderAccountsListing = (scopeText: string, evidence: AccountsEvidence): string | null => {
  const { accounts } = evidence;
  if (accounts.length === 0) return null;
  const fundsScoped = mentionsFundsMarker(scopeText) || isNegatedCardExclusion(scopeText);
  const pool = fundsScoped ? accounts.filter((account) => account.kind !== 'credit_card') : [...accounts];
  if (pool.length === 0) return null;
  const notFound = (noun: 'conta' | 'contas'): string =>
    noun === 'conta'
      ? `Não encontrei essa conta. ` +
        `Contas disponíveis: ${availableNames(accounts)}. ` +
        `Qual delas você quer ver?${partialSuffix(evidence)}`
      : `Não consegui identificar qual conta você quer ver. ` +
        `Contas disponíveis: ${availableNames(accounts)}. ` +
        `Qual delas você quer ver?${partialSuffix(evidence)}`;
  const renderSingleListLine = (account: GroundedAccount): string => {
    const single = renderAccountListLine(account);
    const note = renderPartialNote(evidence, 1, pool.length);
    return note ? `${single}\n${note}` : single;
  };
  const named = matchAccountsByName(scopeText, pool);
  if (named.length === 1 && named[0]) {
    if (hasUnmatchedQualifier(scopeText, named[0]) || !isFullyNamed(scopeText, named[0])) return notFound('conta');
    return renderSingleListLine(named[0]);
  }
  if (named.length > 1) {
    const { candidates, narrowed } = selectMostSpecific(scopeText, named);
    if (candidates.length === 1 && candidates[0]) {
      if (hasUnmatchedQualifier(scopeText, candidates[0]) || !isFullyNamed(scopeText, candidates[0])) {
        return notFound('conta');
      }
      return renderSingleListLine(candidates[0]);
    }
    if (candidates.length > 1 && !narrowed && candidates.every((candidate) => isFullyNamed(scopeText, candidate))) {
      const listed = candidates.slice(0, MAX_LISTED_ACCOUNTS);
      const lines = listed.map(renderAccountListLine).join('\n');
      const note = renderMultiListNote(evidence, listed.length, candidates.length);
      const body = `Suas contas:\n${lines}`;
      return note ? `${body}\n${note}` : body;
    }
    return notFound('contas');
  }
  // No name matched: a leftover specific token names something absent —
  // clarify with NO figures. A genuinely generic listing shows the pool.
  // Single-character non-fillers count as leftovers for the same reason as
  // in the balance path: a dropped "Q"/"2" must not widen into a listing.
  if (
    tokens(scopeText).some((token) => !isGenericBalanceWord(token)) ||
    shortQualifierTokens(scopeText).length > 0
  ) {
    return notFound('conta');
  }
  const listed = pool.slice(0, MAX_LISTED_ACCOUNTS);
  const lines = listed.map(renderAccountListLine).join('\n');
  const note = renderPartialNote(evidence, listed.length, pool.length);
  const body = `Suas contas:\n${lines}`;
  return note ? `${body}\n${note}` : body;
};

/**
 * Deterministic account-balance answer. Returns null when this module
 * should NOT own the turn (no accounts evidence, or a non-balance query
 * such as a pure statement/fatura request that the legacy renderers own).
 *
 * FIX-TED-GROUNDING-PRESENTATION-CLAUSE: the presentation layer is separated
 * ONCE, here at the renderer boundary, BEFORE any matching. Every predicate
 * below — nominal match, unmatched qualifier, full-name, card/funds scoping,
 * broad/total scope, mixed segments — consumes the same `scopeText`, so
 * presentation can never select an account, alter scope or authorize a
 * figure. The original `text` argument is read-only and never mutated.
 */
export const renderAccountsAnswer = (text: string, evidence: AccountsEvidence | null): string | null => {
  if (!evidence) return null;
  const { scopeText } = splitPresentationClause(text);
  const { accounts } = evidence;
  const negatedCardExclusion = isNegatedCardExclusion(scopeText);
  const cardQuestion = mentionsCard(scopeText) && !negatedCardExclusion;
  const balanceQuestion = seeksAccountBalance(scopeText);
  const listingQuestion = seeksAccountListing(scopeText);
  // Pure fatura/extrato questions without balance words stay with the
  // legacy statement renderers — never a balance, never a card debt. A pure
  // account listing ("liste minhas contas") is owned by the deterministic
  // listing below — never the generative provider.
  if (!balanceQuestion && !listingQuestion) return null;
  // Unsupported corrente/poupança subtype fail-closes before ANY numeric
  // answer: the store has only broad bank/cash with no such dimension.
  if (isUnsupportedSubtypeQuery(scopeText)) {
    return (
      `Não consigo separar o saldo de conta corrente ou poupança nesta consulta — ` +
      `só tenho o tipo amplo (banco/dinheiro), sem distinção entre corrente e poupança, ` +
      `por isso não apresentei nenhum total. ` +
      `Contas disponíveis: ${availableNames(accounts)}. ` +
      `Quer refinar o escopo?${partialSuffix(evidence)}`
    );
  }
  // Deterministic account listing: a non-empty pool renders name + kind +
  // balance without ever calling the relay. An empty pool returns null so the
  // read-absence renderer keeps the cadastro offer; the balance path below is
  // reached only when a balance word is present and is byte-for-byte intact.
  if (listingQuestion && !balanceQuestion) {
    return renderAccountsListing(scopeText, evidence);
  }
  const matched = matchAccountsByName(scopeText, accounts);
  const creditCards = accounts.filter((account) => account.kind === 'credit_card');

  // Card-scoped resolution (FIX-TED-ACCOUNT-GROUNDING-EDGE-CASES +
  // FIX-TED-GROUNDING-SEMANTIC-SCOPE + FIX-TED-GROUNDING-SEGMENT-SCOPING):
  // a card question must never answer with a bank homonym's balance.
  // Nominal selection is restricted to `credit_card` evidence. The ONLY
  // exception is an explicitly mixed conta+cartão query that splits
  // lexically into a funds segment and a card segment, where EACH side
  // resolves to exactly one fully-named account of the correct kind with
  // no unmatched qualifier — anything less clarifies with NO figures.
  if (cardQuestion) {
    if (mentionsFundsMarker(scopeText)) {
      const segments = splitMixedSegments(scopeText);
      if (segments) {
        const fundsPool = accounts.filter(
          (account) => account.kind === 'bank' || account.kind === 'cash',
        );
        const fundsSingle = resolveSingleInSegment(segments.fundsText, fundsPool);
        const cardSingle = resolveSingleInSegment(segments.cardText, creditCards);
        if (fundsSingle && cardSingle) {
          const mixedMatched = [fundsSingle, cardSingle];
          const listed = mixedMatched.slice(0, MAX_LISTED_ACCOUNTS);
          const lines = listed.map(renderAccountLine).join('\n');
          const note = renderMultiListNote(evidence, listed.length, mixedMatched.length);
          const scopeNote = 'Valores por conta, sem somar tipos diferentes.';
          return note ? `${lines}\n${scopeNote}\n${note}` : `${lines}\n${scopeNote}`;
        }
      }
      return (
        `Não consegui identificar qual conta ou cartão você quer ver. ` +
        `Contas disponíveis: ${availableNames(accounts)}. ` +
        `Qual deles você quer ver ou consulte a fatura do cartão?${partialSuffix(evidence)}`
      );
    }
    {
      if (creditCards.length === 0) {
        if (accounts.length === 0) {
          return 'Ainda não consigo mostrar o saldo do cartão nesta consulta. Me diga qual conta você quer ver ou consulte a fatura do cartão.';
        }
        return (
          `Ainda não consigo mostrar o saldo do cartão nesta consulta — só tenho os saldos das contas. ` +
          `Contas disponíveis: ${availableNames(accounts)}. ` +
          `Me diga qual delas você quer ver ou consulte a fatura do cartão.${partialSuffix(evidence)}`
        );
      }
      const cardMatches = matchAccountsByName(scopeText, creditCards);
      if (cardMatches.length > 0) {
        const { candidates, narrowed } = selectMostSpecific(scopeText, cardMatches);
        if (candidates.length === 1 && candidates[0]) {
          // Unmatched qualifier ("Nubank PJ?" with only "Nubank"): the
          // shorter prefix must NOT answer — clarify with NO figures.
          // Likewise a card carrying a qualifier the question does not
          // name ("Nubank?" with only "Nubank PJ" present) never answers
          // by prefix — clarify with NO figures.
          if (hasUnmatchedQualifier(scopeText, candidates[0]) || !isFullyNamed(scopeText, candidates[0])) {
            return (
              `Não encontrei esse cartão. ` +
              `Cartões disponíveis: ${availableNames(creditCards)}. ` +
              `Me diga qual deles você quer ver ou consulte a fatura do cartão.${partialSuffix(evidence)}`
            );
          }
          const single = renderAccountLine(candidates[0]);
          const note = renderPartialNote(evidence, 1, creditCards.length);
          return note ? `${single}\n${note}` : single;
        }
        const distinctCards = new Set(candidates.map((account) => fold(account.name)));
        if (candidates.length > 1 && distinctCards.size === 1) {
          return renderDuplicateClarification(candidates, 'cartão', evidence);
        }
        if (candidates.length > 1 && !narrowed) {
          // Only an explicitly fully-named set publishes figures (capped
          // at 20 with an explicit note). A shared-prefix ambiguity
          // ("Nubank?" over "Nubank 01..25") clarifies with names only.
          if (candidates.every((candidate) => isFullyNamed(scopeText, candidate))) {
            const listed = candidates.slice(0, MAX_LISTED_ACCOUNTS);
            const lines = listed.map(renderAccountLine).join('\n');
            const note = renderMultiListNote(evidence, listed.length, candidates.length);
            const scopeNote = 'Valores por cartão, sem somar.';
            return note ? `${lines}\n${scopeNote}\n${note}` : `${lines}\n${scopeNote}`;
          }
          return (
            `Não consegui identificar qual cartão você quer ver. ` +
            `Cartões disponíveis: ${availableNames(candidates)}. ` +
            `Me diga qual deles você quer ver ou consulte a fatura do cartão.${partialSuffix(evidence)}`
          );
        }
        // Containment ambiguity that specificity could not narrow to a
        // single card: clarify with NO figures.
        return (
          `Não consegui identificar qual cartão você quer ver. ` +
          `Cartões disponíveis: ${availableNames(creditCards)}. ` +
          `Me diga qual deles você quer ver ou consulte a fatura do cartão.${partialSuffix(evidence)}`
        );
      }
      // No card matched: a question naming a SPECIFIC card clarifies with NO
      // figures; only a genuinely generic plural question lists cards.
      if (hasSpecificCardName(scopeText)) {
        return (
          `Não encontrei esse cartão. ` +
          `Cartões disponíveis: ${availableNames(creditCards)}. ` +
          `Me diga qual deles você quer ver ou consulte a fatura do cartão.${partialSuffix(evidence)}`
        );
      }
      const listedCards = creditCards.slice(0, MAX_LISTED_ACCOUNTS);
      const lines = listedCards.map(renderAccountLine).join('\n');
      const note = renderPartialNote(evidence, listedCards.length, creditCards.length);
      if (asksForTotal(scopeText)) {
        const body = `Saldos por cartão:\n${lines}\nValores por cartão, sem somar.`;
        return note ? `${body}\n${note}` : body;
      }
      const body = listedCards.length === 1 ? lines : `Saldos por cartão:\n${lines}`;
      return note ? `${body}\n${note}` : body;
    }
  }

  // Named selection (non-card turns) with explicit type scoping (a): an
  // explicit `conta/banco` query resolves ONLY against bank/cash evidence.
  // A homonym card never answers a funds question; a missing funds name
  // clarifies with NO figures. A `sem cartão` negation counts as funds
  // scoping (exclusion, not a card request).
  const fundsScoped = mentionsFundsMarker(scopeText) || negatedCardExclusion;
  const fundsPool = accounts.filter((account) => account.kind === 'bank' || account.kind === 'cash');
  const scopedMatched = fundsScoped ? matchAccountsByName(scopeText, fundsPool) : matched;
  const scopedPoolSize = fundsScoped ? fundsPool.length : accounts.length;
  // TED-LOCAL-ACCOUNT-PARTIAL-BALANCE: the exact matcher above demands every
  // long name token and the single-selection guard below demands the complete
  // name — a partial ("saldo QA Aurora" for "QA Aurora banco") or an anaphoric
  // ("e o saldo daquela conta") turn otherwise falls to notfound. Both are
  // resolved here, cohesively and WITHOUT relaxing the financial guard:
  // - bare anaphora reads ONLY with an unequivocal authoritative context
  //   (exactly one account in the funds scope and nothing else specific in
  //   the turn); with 2+ accounts it falls through and asks;
  // - a significant partial reads ONLY when it singles out exactly one
  //   account, and the unchanged unmatched-qualifier veto still drops any
  //   turn naming something the account does not carry. No figures on
  //   ambiguity, no borrowed balances, no invented names — ever.
  if (scopedMatched.length === 0) {
    const pool = fundsScoped ? fundsPool : accounts;
    // Incomplete evidence vetoes the NEW resolutions below (round2): with a
    // partial read (partial flag or omitted rows) a "unique" visible match
    // may hide another candidate, so anaphora/partial single-selects are
    // forbidden — the turn falls through and clarifies with NO figures.
    // Existing exact-name proof is preserved as-is (it carries its own
    // full-name + unmatched-qualifier guards plus the global partiality
    // notes); no global warning or renderer is relaxed.
    // NOTE (read-contract boundary): `total`-vs-rows is not signaled to this
    // layer — the projection drops the route `total` and incompleteness
    // arrives only via omitted rows. Workspace/inactive scoping lives
    // upstream (workspace-scoped token, active-only default read, separate
    // card store); grounding operates on scope-valid rows only, through the
    // same pools as exact matching, and never invents its own filter.
    const evidenceComplete = !evidence.partial && evidence.omittedCount === 0;
    if (evidenceComplete) {
      if (fundsScoped && isBareAnaphora(scopeText) && pool.length === 1 && pool[0]) {
        const single = renderAccountLine(pool[0]);
        const note = renderPartialNote(evidence, 1, scopedPoolSize);
        return note ? `${single}\n${note}` : single;
      }
      const denuded = withoutAnaphora(scopeText);
      const partial = matchSignificantPartial(denuded, pool);
      if (partial.length === 1 && partial[0]) {
        if (hasUnmatchedQualifier(denuded, partial[0])) {
          return (
            `Não encontrei essa conta. ` +
            `Contas disponíveis: ${availableNames(accounts)}. ` +
            `Qual delas você quer ver?${partialSuffix(evidence)}`
          );
        }
        const single = renderAccountLine(partial[0]);
        const note = renderPartialNote(evidence, 1, scopedPoolSize);
        return note ? `${single}\n${note}` : single;
      }
    }
  }
  if (scopedMatched.length === 1 && scopedMatched[0]) {
    // Singular funds selection requires the full name (like cards): a
    // shorter base ("Nubank?" with only "Nubank PJ" present) clarifies with
    // NO figures — never a prefix answer.
    if (hasUnmatchedQualifier(scopeText, scopedMatched[0]) || !isFullyNamed(scopeText, scopedMatched[0])) {
      return (
        `Não encontrei essa conta. ` +
        `Contas disponíveis: ${availableNames(accounts)}. ` +
        `Qual delas você quer ver?${partialSuffix(evidence)}`
      );
    }
    const single = renderAccountLine(scopedMatched[0]);
    const note = renderPartialNote(evidence, 1, scopedPoolSize);
    return note ? `${single}\n${note}` : single;
  }
  if (scopedMatched.length > 1) {
    // `candidates` is reassigned below, never restored: once short labels
    // filter the pool, the discarded accounts stay discarded for every
    // downstream branch (no figures for "Reserva 1" when only "Reserva 2"
    // homonyms survive).
    let { candidates, narrowed } = selectMostSpecific(scopeText, scopedMatched);
    if (candidates.length === 1 && candidates[0]) {
      if (hasUnmatchedQualifier(scopeText, candidates[0]) || !isFullyNamed(scopeText, candidates[0])) {
        return (
          `Não encontrei essa conta. ` +
          `Contas disponíveis: ${availableNames(accounts)}. ` +
          `Qual delas você quer ver?${partialSuffix(evidence)}`
        );
      }
      const single = renderAccountLine(candidates[0]);
      const note = renderPartialNote(evidence, 1, scopedPoolSize);
      return note ? `${single}\n${note}` : single;
    }
    const distinctNames = new Set(candidates.map((account) => fold(account.name)));
    if (candidates.length > 1 && distinctNames.size === 1) {
      return renderDuplicateClarification(candidates, 'conta', evidence);
    }
    // Short-label disambiguation (round3 + round4): the lenient matcher
    // ignores one-character tokens, so "Reserva 1"/"Reserva 2" collide on
    // "reserva". When the utterance carries short non-filler labels ("saldo
    // Reserva 2"), the candidates whose canonical names own them all form
    // the pool from here on — the original set is never restored. A single
    // survivor is the exact full-name answer and resolves (leftovers still
    // veto); zero survivors clarify with NO figures; several survivors
    // re-run the duplicate guard on the FILTERED pool (homonyms clarify
    // with NO figures) before any render/list.
    if (candidates.length > 1) {
      const shorts = shortQualifierTokens(scopeText);
      if (shorts.length > 0) {
        const disambiguated = candidates.filter((candidate) => {
          const words = new Set(
            fold(candidate.name)
              .split(/[^a-z0-9]+/)
              .filter(Boolean),
          );
          return shorts.every((token) => words.has(token));
        });
        if (disambiguated.length === 1 && disambiguated[0]) {
          if (hasUnmatchedQualifier(scopeText, disambiguated[0])) {
            return (
              `Não encontrei essa conta. ` +
              `Contas disponíveis: ${availableNames(accounts)}. ` +
              `Qual delas você quer ver?${partialSuffix(evidence)}`
            );
          }
          const single = renderAccountLine(disambiguated[0]);
          const note = renderPartialNote(evidence, 1, scopedPoolSize);
          return note ? `${single}\n${note}` : single;
        }
        if (disambiguated.length === 0) {
          return (
            `Não encontrei essa conta. ` +
            `Contas disponíveis: ${availableNames(accounts)}. ` +
            `Qual delas você quer ver?${partialSuffix(evidence)}`
          );
        }
        const filteredNames = new Set(disambiguated.map((account) => fold(account.name)));
        if (filteredNames.size === 1) {
          return renderDuplicateClarification(disambiguated, 'conta', evidence);
        }
        candidates = disambiguated;
      }
    }
    if (candidates.length > 1 && !narrowed) {
      // Explicitly mentioned distinct accounts (e.g. "saldo da conta
      // Itaú e do cartão Nubank"): list them kind-aware capped at 20,
      // never a merged total — even when together they cover every known
      // account. A shared-prefix ambiguity clarifies with names only.
      if (candidates.every((candidate) => isFullyNamed(scopeText, candidate))) {
        const listed = candidates.slice(0, MAX_LISTED_ACCOUNTS);
        const lines = listed.map(renderAccountLine).join('\n');
        const note = renderMultiListNote(evidence, listed.length, candidates.length);
        const scopeNote = 'Valores por conta, sem somar tipos diferentes.';
        return note ? `${lines}\n${scopeNote}\n${note}` : `${lines}\n${scopeNote}`;
      }
      return (
        `Não consegui identificar qual conta você quer ver. ` +
        `Contas disponíveis: ${availableNames(candidates)}. ` +
        `Qual delas você quer ver?${partialSuffix(evidence)}`
      );
    }
    // Containment ambiguity that specificity could not narrow to a single
    // account: clarify with NO figures.
    return (
      `Não consegui identificar qual conta você quer ver. ` +
      `Contas disponíveis: ${availableNames(accounts)}. ` +
      `Qual delas você quer ver?${partialSuffix(evidence)}`
    );
  }

  // A singular "conta" marker with no matching name is a MISSING name
  // (not a generic listing): clarify with NO figures.
  const foldedText = fold(scopeText);
  const seeksSpecificAccount = /\bconta\b/.test(foldedText) && !/\bcontas\b/.test(foldedText);
  if (scopedMatched.length === 0 && seeksSpecificAccount && !cardQuestion) {
    return (
      `Não encontrei essa conta. ` +
      `Contas disponíveis: ${availableNames(accounts)}. ` +
      `Qual delas você quer ver?${partialSuffix(evidence)}`
    );
  }

  // An unmatched specific qualifier WITHOUT the word "conta" (e.g. "saldo
  // do banco XP?" with only Itaú/Nubank present) is still a MISSING name —
  // never a generic listing of other accounts' figures. Any leftover
  // non-generic token means the utterance names something no account
  // carries, so clarify with NO figures. Genuinely generic questions carry
  // only generic vocabulary and keep the listing below.
  // FIX-TED-GROUNDING-PRESENTATION-CLAUSE: this path no longer knows about
  // presentation. A recognized clause was already removed from `scopeText` at
  // the stage above, and an unrecognized one leaves every word here — so an
  // unknown name survives as an unknown name ("banco Valor" with no such
  // account) instead of widening into a listing of other accounts.
  if (scopedMatched.length === 0 && !cardQuestion) {
    // Single-character non-fillers ("Q", "2") count as specific qualifiers
    // even though `tokens()` drops them: the user named something, so a
    // generic listing of other accounts' figures would invent an answer.
    const hasSpecificQualifier =
      tokens(scopeText).some((token) => !isGenericBalanceWord(token)) ||
      shortQualifierTokens(scopeText).length > 0;
    if (hasSpecificQualifier) {
      return (
        `Não encontrei essa conta. ` +
        `Contas disponíveis: ${availableNames(accounts)}. ` +
        `Qual delas você quer ver?${partialSuffix(evidence)}`
      );
    }
  }

  if (accounts.length === 0) {
    if (scopedMatched.length === 0 && (cardQuestion || balanceQuestion)) {
      return 'Não encontrei contas para essa consulta. Me diga qual conta você quer ver.';
    }
    return null;
  }

  // A funds-scoped generic question with no funds evidence clarifies instead
  // of borrowing card balances — EXCEPT a total over unconfirmed kinds
  // (FIX-TED-ALL-ACCOUNTS-UNKNOWN-TOTAL): a broad or ambiguous all-accounts
  // total must withhold with an explicit unconfirmed-type explanation and a
  // full grounded listing, never a names-only clarification.
  const hasUnknownForScope = accounts.some((account) => account.kind === 'unknown');
  if (fundsScoped && fundsPool.length === 0 && !(asksForTotal(scopeText) && hasUnknownForScope)) {
    return (
      `Não encontrei essa conta. ` +
      `Contas disponíveis: ${availableNames(accounts)}. ` +
      `Qual delas você quer ver?${partialSuffix(evidence)}`
    );
  }

  // Generic or scoped listing. A funds-scoped listing shows ONLY the
  // bank/cash pool with pool-appropriate counts; a truly generic listing
  // keeps the full accounts pool. Broad `todas/todos/geral/tudo` wins over
  // the funds filter and always uses the full pool — EXCEPT an explicit
  // `sem cartão` card exclusion (FIX-TED-ALL-ACCOUNTS-EXCLUDE-CARD), which
  // prevails over broad language and keeps the scoped bank/cash pool. An
  // ambiguous funds-scoped listing that would silently drop unknown rows
  // uses the full pool; an explicitly scoped listing keeps the scoped pool
  // but must state the omission explicitly.
  const broadAll = isBroadAllAccountsQuery(scopeText);
  const explicitFunds = isExplicitFundsOnlyTotal(scopeText);
  const hasUnknownOverallEarly = accounts.some((account) => account.kind === 'unknown');
  const useFullPoolForListing =
    (broadAll && !explicitFunds) || (fundsScoped && hasUnknownOverallEarly && !explicitFunds);
  const scopedAccounts = useFullPoolForListing
    ? [...accounts]
    : fundsScoped
      ? fundsPool
      : accounts;
  const total = asksForTotal(scopeText);
  const listed = scopedAccounts.slice(0, MAX_LISTED_ACCOUNTS);
  const lines = listed.map(renderAccountLine).join('\n');
  const baseNote = renderPartialNote(evidence, listed.length, scopedAccounts.length);
  const omissionNote =
    !useFullPoolForListing && fundsScoped && hasUnknownOverallEarly && explicitFunds
      ? 'O tipo de outra conta não foi confirmado e não entrou neste escopo.'
      : null;
  const note = [baseNote, omissionNote].filter((part): part is string => part !== null).join('\n') || null;
  const kinds = new Set(scopedAccounts.map((account) => account.kind));
  const homogeneousFunds =
    kinds.size > 0 && [...kinds].every((kind) => kind === 'bank' || kind === 'cash') && !evidence.partial;

  if (total) {
    // FIX-TED-ALL-ACCOUNTS-UNKNOWN-TOTAL: a funds-scoped ("conta/contas")
    // total silently drops unknown rows from `scopedAccounts`, so a broad or
    // ambiguous total would present a partial bank/cash sum as the complete
    // all-accounts total. Fail closed: withhold every subtotal, list the full
    // grounded accounts, and state the unconfirmed type. Only an explicitly
    // bank/cash-scoped request keeps a NAMED scoped subtotal that declares
    // the exclusion instead of claiming completeness.
    const hasUnknownOverall = hasUnknownOverallEarly;
    const hasCardOverall = accounts.some((account) => account.kind === 'credit_card');
    // Negated `sem cartão` with any unknown kind: the unknown could itself
    // be a card, so never sum a partial scoped subset as complete.
    if (negatedCardExclusion && hasUnknownOverall) {
      const body =
        `Saldos por conta:\n${lines}\n` +
        `Não somei os valores porque o tipo de outra conta não foi confirmado e ela pode ser cartão — ` +
        `a exclusão de cartão não pode ser garantida. ` +
        `Quer refinar o escopo ou informar o tipo pendente?`;
      return note ? `${body}\n${note}` : body;
    }
    if (hasUnknownOverall && (broadAll || (fundsScoped && !explicitFunds))) {
      const fullListed = accounts.slice(0, MAX_LISTED_ACCOUNTS);
      const fullLines = fullListed.map(renderAccountLine).join('\n');
      const fullNote = renderPartialNote(evidence, fullListed.length, accounts.length);
      if (hasCardOverall) {
        const body =
          `Saldos por conta:\n${fullLines}\n` +
          `Não somei os valores porque o tipo de alguma conta não foi confirmado. ` +
          `Quer refinar o escopo ou informar o tipo pendente?`;
        return fullNote ? `${body}\n${fullNote}` : body;
      }
      const body =
        `Saldos por conta:\n${fullLines}\n` +
        `Não somei os valores porque o tipo de alguma conta não foi confirmado e o total não foi apresentado. ` +
        `Quer o total só das contas ou refinar o escopo?`;
      return fullNote ? `${body}\n${fullNote}` : body;
    }
    if (hasUnknownOverall && fundsScoped && explicitFunds && homogeneousFunds) {
      if (scopedAccounts.length > MAX_LISTED_ACCOUNTS) {
        const body =
          `Saldos por conta:\n${lines}\n` +
          `Total omitido porque a lista é parcial (mostrando ${listed.length} de ${scopedAccounts.length}). ` +
          `O tipo de outra conta não foi confirmado e não entrou neste escopo. ` +
          `Quer refinar o escopo?`;
        return note ? `${body}\n${note}` : body;
      }
      const subtotal = scopedAccounts.reduce((sum, account) => sum + account.balanceCents, 0);
      const body =
        `Saldos por conta:\n${lines}\n` +
        `Total só das contas (banco/dinheiro): ${formatCents(subtotal)}. ` +
        `O tipo de outra conta não foi confirmado e não entrou neste total.`;
      return note ? `${body}\n${note}` : body;
    }
    // Explicitly scoped homogeneous total (e.g. `sem cartão`, `só das
    // contas`): declare the scope instead of claiming generic completeness,
    // even when nothing unconfirmed was omitted.
    if (explicitFunds && fundsScoped && homogeneousFunds) {
      if (scopedAccounts.length > MAX_LISTED_ACCOUNTS) {
        const body =
          `Saldos por conta:\n${lines}\n` +
          `Total omitido porque a lista é parcial (mostrando ${listed.length} de ${scopedAccounts.length}). ` +
          `Quer o total só das contas ou refinar o escopo?`;
        return note ? `${body}\n${note}` : body;
      }
      const subtotal = scopedAccounts.reduce((sum, account) => sum + account.balanceCents, 0);
      const exclusionNote = hasCardOverall
        ? `Cartões ficaram fora deste escopo (sem cartão). `
        : `Excluindo cartões do escopo. `;
      const body =
        `Saldos por conta:\n${lines}\n` +
        `Total só das contas (banco/dinheiro): ${formatCents(subtotal)}. ` +
        `${exclusionNote}Quer refinar o escopo?`;
      return note ? `${body}\n${note}` : body;
    }
    if (homogeneousFunds) {
      // Truncated homogeneous list: omit the subtotal instead of pairing a
      // whole-scope sum with a partial list (contradictory scope).
      if (scopedAccounts.length > MAX_LISTED_ACCOUNTS) {
        const body =
          `Saldos por conta:\n${lines}\n` +
          `Total omitido porque a lista é parcial (mostrando ${listed.length} de ${scopedAccounts.length}). ` +
          `Quer o total de todas as ${scopedAccounts.length} contas ou refinar o escopo?`;
        return note ? `${body}\n${note}` : body;
      }
      const subtotal = scopedAccounts.reduce((sum, account) => sum + account.balanceCents, 0);
      const body =
        `Saldos por conta:\n${lines}\n` + `Total disponível em contas: ${formatCents(subtotal)}.`;
      return note ? `${body}\n${note}` : body;
    }
    // Mixed, unknown, or partial kinds: per-account figures only, explicit
    // non-summation, and a scope question — never a merged total. Card debt
    // is mentioned ONLY when `credit_card` evidence exists; unknown kinds
    // report the unconfirmed type; partial reads report the incomplete read
    // without alleging a missing card. FIX-TED-CARD-ONLY-TOTAL-MESSAGE: the
    // "conta e dívida" wording requires confirmed bank/cash AND a confirmed
    // card; card-only lists per-card with no sum and no conta claim, and
    // card+unknown reports the unconfirmed type without alleging funds.
    if (evidence.partial) {
      const body =
        `Saldos por conta:\n${lines}\n` +
        `Não somei os valores porque a leitura está parcial/incompleta. ` +
        `Quer refinar o escopo ou tentar de novo?`;
      return note ? `${body}\n${note}` : body;
    }
    const hasFunds = scopedAccounts.some((account) => account.kind === 'bank' || account.kind === 'cash');
    const hasCard = scopedAccounts.some((account) => account.kind === 'credit_card');
    if (!hasFunds && hasCard && !kinds.has('unknown')) {
      const cardLines = listed.map(renderAccountLine).join('\n');
      const body =
        `Saldos por cartão:\n${cardLines}\n` +
        `Valores por cartão, sem somar. A soma financeira total não é feita com dívida de cartão e está fora do escopo disponível. ` +
        `Quer ver outro cartão ou refinar o escopo?`;
      return note ? `${body}\n${note}` : body;
    }
    if (kinds.has('unknown')) {
      if (hasCard) {
        const body =
          `Saldos por conta:\n${lines}\n` +
          `Não somei os valores porque o tipo de alguma conta não foi confirmado. ` +
          `Quer refinar o escopo ou informar o tipo pendente?`;
        return note ? `${body}\n${note}` : body;
      }
      const body =
        `Saldos por conta:\n${lines}\n` +
        `Não somei os valores porque o tipo de alguma conta não foi confirmado. ` +
        `Quer o total só das contas ou refinar o escopo?`;
      return note ? `${body}\n${note}` : body;
    }
    if (hasFunds && hasCard) {
      const body =
        `Saldos por conta:\n${lines}\n` +
        `São tipos diferentes (conta e dívida no cartão), por isso não somei os valores. ` +
        `Quer o total só das contas ou a dívida do cartão?`;
      return note ? `${body}\n${note}` : body;
    }
    const fallbackBody =
      `Saldos por conta:\n${lines}\n` +
      `Não somei os valores para este escopo. ` +
      `Quer refinar o escopo?`;
    return note ? `${fallbackBody}\n${note}` : fallbackBody;
  }

  // Non-total listing that kept the full pool because of unconfirmed kinds:
  // state the unconfirmed type explicitly instead of a silent subset.
  if (!total && hasUnknownOverallEarly && useFullPoolForListing) {
    const fullBody = scopedAccounts.length === 1 ? lines : `Saldos por conta:\n${lines}`;
    const explain = `Observação: o tipo de alguma conta não foi confirmado.`;
    return note ? `${fullBody}\n${note}\n${explain}` : `${fullBody}\n${explain}`;
  }

  const body = scopedAccounts.length === 1 ? lines : `Saldos por conta:\n${lines}`;
  return note ? `${body}\n${note}` : body;
};
