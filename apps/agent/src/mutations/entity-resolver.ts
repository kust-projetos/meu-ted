/**
 * Authoritative entity resolution (SPEC §7.2, §7.3, §7.6 — H-01; A08/R08).
 *
 * A mutation proposal may only exist once its canonical args are complete.
 * This module resolves `accountId` / `categoryId` EXCLUSIVELY from
 * authoritative workspace reads (the injected {@link EntityReader}) — the
 * LLM never chooses silently and similarity matches are only candidates
 * verified against the real lists.
 *
 * Account auto-resolution is allowed only when:
 * - the user names an account with an unambiguous match; or
 * - exactly one valid account exists.
 * Server default-account policy: investigated — no account-default policy
 * exists on the API (only categories carry `isDefault`, which marks template
 * origin, not a transaction default). No default is invented here.
 *
 * A08 / R08 resolution order (top wins), for BOTH account and category:
 *   1. the CURRENT turn's explicit choice (declared id or unambiguous name);
 *   2. an alias/preference already CONFIRMED inside this scope;
 *   3. a deterministic match against the CURRENT catalog;
 *   4. a bounded semantic ranking among CURRENT candidates — a CANDIDATE the
 *      user confirms, never an irrevocable selection;
 *   5. clarification.
 * A reference (declared id or confirmed alias) that no longer verifies is
 * INVALIDATED for the rest of the turn and never used; resolution continues
 * down the order. No global state is added: invalidation lives in the turn's
 * result trace, not in a store this module does not own.
 *
 * Boundaries it does NOT cross:
 * - it never creates a category (R08): ranking only names rows that already
 *   exist in the current list;
 * - the description is still NOT a category query (R03/A03): only a literal
 *   fold-exact name match is legitimate there, so no semantic inference can be
 *   smuggled in through the description;
 * - permission to use an account/category stays server-side (capabilities at
 *   propose); agent-side this module verifies existence, activity and scope.
 */

import { MUTATION_LEXICON_TERMINATORS } from './semantic-interpretation.js';

export type EntitySummary = Readonly<{
  id: string;
  name: string;
  /** 'active' rows are usable; anything else (inactive/archived) is not (R08). */
  status?: string;
  isActive?: boolean;
  /** Scope the authoritative read reported for this row (defensive R08 check). */
  scopeId?: string;
}>;

export type EntityReader = Readonly<{
  /**
   * Workspace this reader is bound to (the delegated token's scope). A row
   * reporting a different scope is out of scope and is never resolved, never
   * listed and never named to the user.
   */
  scope?: Readonly<{ workspaceId?: string }>;
  listAccounts(): Promise<readonly EntitySummary[]>;
  listCategories(): Promise<readonly EntitySummary[]>;
}>;

export type ResolvableMutation = Readonly<{
  kind: 'expense' | 'income';
  amountCents: number;
  description: string;
  date: string;
  categoryQuery?: string;
}>;

/** Which tier of the R08 order decided a field (never a raw id). */
export type ResolutionSource =
  | 'explicit'
  | 'confirmed_alias'
  | 'deterministic'
  | 'semantic_candidate'
  | 'clarification';

/**
 * Reference KINDS dropped because they no longer verify. Kinds only: a real id
 * is never carried in the trace (the trace can reach telemetry/logs).
 */
export type InvalidatedReference =
  | 'explicit_category_id'
  | 'confirmed_account_id'
  | 'confirmed_category_id'
  | 'resolved_account'
  | 'resolved_category';

export type ResolutionOutcome = Readonly<{
  source: ResolutionSource;
  /** Reference kinds invalidated in this turn (R08). */
  invalidated: readonly InvalidatedReference[];
  /** A confirmed preference this turn's explicit choice overrode, when any. */
  overrode?: InvalidatedReference;
  /** Labels the user must be able to see: homonyms / conflicting names. */
  homonyms: readonly string[];
}>;

export type EntityResolutionTrace = Readonly<{
  account: ResolutionOutcome;
  category: ResolutionOutcome;
}>;

/**
 * A08/R08 observability: the trace's SIGNALS, as reference-KIND names only
 * (`confirmed_account_id`, `explicit_category_id`, ...). The trace can reach
 * telemetry and logs, so this deliberately carries no ids, no UUIDs and no
 * account/category labels — only which references were dropped and which
 * confirmed preference this turn overrode. Kinds are already a closed union,
 * so this can never leak a value by construction.
 */
export const entityResolutionSignals = (trace: EntityResolutionTrace): readonly string[] => {
  const signals: string[] = [];
  for (const outcome of [trace.account, trace.category]) {
    for (const reference of outcome.invalidated) signals.push(reference);
    if (outcome.overrode) signals.push(outcome.overrode);
  }
  return [...new Set(signals)];
};

export type EntityResolution =
  | Readonly<{ complete: true; accountId: string; accountName: string; categoryId: string; categoryName: string; missingFields: readonly []; trace: EntityResolutionTrace }>
  | Readonly<{ complete: false; missingFields: readonly string[]; clarification: string; trace: EntityResolutionTrace }>;

/**
 * A08/R08 tier 2 input: ids this conversation/draft already CONFIRMED inside
 * the scope (e.g. the stored account/category of an active draft). An id that
 * no longer verifies is invalidated and re-resolved, never reused.
 */
export type EntityResolutionOptions = Readonly<{
  confirmed?: Readonly<{ accountId?: string; categoryId?: string }>;
}>;

type RequestFn = (
  method: string,
  path: string,
  options?: { query?: Record<string, string>; headers?: Record<string, string> },
) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CLARIFICATION_OPTIONS = 10;
const MAX_SEMANTIC_CANDIDATES = 3;
const READ_FAILURE_CLARIFICATION = 'Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.';

export const foldEntityName = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  !!value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Normalize the shapes authoritative reads actually return. */
export const normalizeEntities = (response: unknown): EntitySummary[] => {
  const record = asRecord(response);
  const top: readonly unknown[] = Array.isArray(response)
    ? response
    : record && Array.isArray(record.items)
      ? (record.items as readonly unknown[])
      : record && Array.isArray(record.data)
        ? (record.data as readonly unknown[])
        : record && Array.isArray(record.accounts)
          ? (record.accounts as readonly unknown[])
          : record && Array.isArray(record.categories)
            ? (record.categories as readonly unknown[])
            : [];
  const flattened: unknown[] = [];
  for (const entry of top) {
    flattened.push(entry);
    // Category tree nodes (macros) nest their subcategories one level deep.
    const node = asRecord(entry);
    const nested = node?.subcategories ?? node?.children;
    if (Array.isArray(nested)) flattened.push(...nested);
  }
  const entities: EntitySummary[] = [];
  for (const entry of flattened) {
    const row = asRecord(entry);
    const id = row && typeof row.id === 'string' ? row.id.trim() : '';
    const rawName = row && typeof row.name === 'string' ? row.name : row && typeof row.accountName === 'string' ? row.accountName : '';
    const name = rawName.trim();
    if (id && name) {
      const status = row && typeof row.status === 'string' ? row.status : undefined;
      const isActive = row && typeof row.isActive === 'boolean' ? row.isActive : undefined;
      // IDEMPOTENT NORMALIZATION (R08 scope axis). The raw reads carry
      // `householdId`/`workspaceId`; an `EntitySummary` that already went
      // through this function carries `scopeId`. Both forms reach here — the
      // resolver normalizes whatever the reader returned, a second time — so
      // dropping `scopeId` would silently disarm the `isOutOfScope` check and
      // let a foreign row be resolved, listed and named to the user.
      const scopeId = row && typeof row.householdId === 'string'
        ? row.householdId
        : row && typeof row.workspaceId === 'string'
          ? row.workspaceId
          : row && typeof row.scopeId === 'string'
            ? row.scopeId
            : undefined;
      entities.push({
        id,
        name,
        ...(status !== undefined ? { status } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(scopeId !== undefined ? { scopeId } : {}),
      });
    }
  }
  return entities;
};

/**
 * Builds an {@link EntityReader} over the same request seam the existing
 * entity-resolution helper uses (`GET /accounts`, `GET /categories`) —
 * authoritative workspace reads, never guesses. `workspaceId` is the scope the
 * delegated token is bound to; it is never taken from the caller's body/query.
 */
export const createRequestEntityReader = (request: RequestFn, scope?: Readonly<{ workspaceId?: string }>): EntityReader => ({
  ...(scope?.workspaceId ? { scope: { workspaceId: scope.workspaceId } } : {}),
  listAccounts: async () => normalizeEntities(await request('GET', '/accounts')),
  listCategories: async () => normalizeEntities(await request('GET', '/categories')),
});

// --- R08 validity axes ---------------------------------------------------------------

/** Out of scope: the row belongs to another workspace, so it is never even named. */
const isOutOfScope = (entity: EntitySummary, scope?: string): boolean =>
  !!scope && entity.scopeId !== undefined && entity.scopeId !== scope;

/** Removed/deactivated rows stay visible as unavailable, never silently replaced. */
const isActiveRow = (entity: EntitySummary): boolean =>
  entity.isActive !== false && (entity.status === undefined || entity.status.trim().toLowerCase() === 'active');

/** The only rows R08 may resolve: existing, active and inside the scope. */
const isUsable = (entity: EntitySummary, scope?: string): boolean =>
  !!entity.id && !!entity.name && !isOutOfScope(entity, scope) && isActiveRow(entity);

const usableEntities = (entities: readonly EntitySummary[], scope?: string): EntitySummary[] =>
  entities.filter((entity) => isUsable(entity, scope));

const byId = (id: string): string => id.trim().toLowerCase();

const bulletList = (names: readonly string[]): string =>
  names.slice(0, MAX_CLARIFICATION_OPTIONS).map((name) => `\n• ${name}`).join('');

const exactOrContained = (query: string, name: string): boolean =>
  name === query || name.includes(query) || query.includes(name);

/**
 * A name CONTINUES past one token only when the next token can be part of a
 * proper name. Four ways, in this order:
 * (a) it is inside a QUOTED span — what the user delimited as a whole is one
 *     name ("no \"Nubank PJ\"");
 * (b) it starts uppercase ("PJ", "Visa") — the historical rule;
 * (c) it carries a digit ("2", "Nubank2");
 * (d) it is a lowercase word of at least two characters that is NOT a
 *     structural TERMINATOR of the utterance ("nubank pj").
 *
 * (d) is what the uppercase-only rule missed: a lowercase qualifier is a
 * qualifier, and R08 never lets a shorter row answer for a longer cited name.
 * It is bounded by TERMINATORS so the sentence's own words stop the run
 * instead of being absorbed into the name: a mutation verb ("nubank gastei"),
 * a preposition/connective ("no nubank e no mercado"), the category marker
 * ("no nubank categoria carne") and a relative date all END it. The verb,
 * preposition and date spellings come from the SAME lexicon A06 normalizes
 * ({@link MUTATION_LEXICON_TERMINATORS}) — never a second private copy, so a
 * spelling A06 learns to rewrite stops the run on the very same turn.
 *
 * Money ("R$", "US$") never continues a name either way.
 */
const QUOTE_PAIRS: Readonly<Record<string, string>> = { '"': '"', "'": "'", '“': '”', '‘': '’' };
const UPPERCASE_START = /^\p{Lu}/u;
const CONTAINS_DIGIT = /\p{N}/u;
const MONEY = /\p{Sc}/u;
const MAX_NAME_RUN = 4;
/** Trailing punctuation belongs to the sentence, never to the name ("Nubank?"). */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;

/**
 * Structural terminators of a cited name run, over and above the mutation
 * lexicon A06 owns: the category marker of the utterance ("no nubank CATEGORIA
 * carne"). The pt-BR connectives arrive with the shared lexicon below.
 */
const RUN_TERMINATORS: ReadonlySet<string> = new Set<string>([
  ...MUTATION_LEXICON_TERMINATORS,
  'categoria',
  'cat',
]);

type RunToken = Readonly<{ text: string; quoted: boolean }>;

/**
 * Splits the message into run tokens, flagging the ones the user wrapped in
 * quotes. Quoted tokens keep their flag across whitespace ("Nubank" + "PJ" is
 * ONE cited name), which is what lets a lowercase quoted qualifier extend the
 * run like an uppercase one.
 */
const runTokens = (text: string): readonly RunToken[] => {
  const tokens: RunToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const closer = QUOTE_PAIRS[char];
    if (closer !== undefined) {
      const end = text.indexOf(closer, index + 1);
      if (end !== -1) {
        for (const inner of text.slice(index + 1, end).split(/\s+/u)) {
          if (inner.length > 0) tokens.push({ text: inner, quoted: true });
        }
        index = end + 1;
        continue;
      }
    }
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && !/\s/u.test(text[end]!)) end += 1;
    tokens.push({ text: text.slice(index, end), quoted: false });
    index = end;
  }
  return tokens;
};

/** A token continues the run unless money or an empty quote rules it out. */
const extendsRun = (token: RunToken): boolean => {
  if (MONEY.test(token.text)) return false;
  const bare = token.text.replace(TRAILING_PUNCTUATION, '');
  if (bare.length === 0) return false;
  if (token.quoted || UPPERCASE_START.test(bare) || CONTAINS_DIGIT.test(bare)) return true;
  return bare.length >= 2
    && !RUN_TERMINATORS.has(foldEntityName(bare))
    && !CATEGORY_STOPWORDS.has(foldEntityName(bare));
};

/**
 * pt-BR function words that carry no category meaning. Declared here because
 * {@link RUN_TERMINATORS} (below) also terminates a cited account name on them:
 * one table, two consumers.
 */
const CATEGORY_STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'para', 'com', 'e', 'a', 'o']);

/**
 * The MORE SPECIFIC name the user actually typed that the matched account only
 * covers by substring: "Nubank" (active) against a typed "Nubank PJ" — and,
 * since a lowercase or quoted qualifier counts too, against a typed "nubank pj"
 * or 'no "Nubank PJ"'.
 *
 * This is the in-app half of R08's "never silently replace a reference to an
 * unavailable entity". The row-based half (`unavailableBlocks` below) can only
 * fire when the authoritative read actually delivers an inactive row, and the
 * production read does not (`WHERE status = 'active' AND deleted_at IS NULL`).
 * Without this, the user's own wording decides: a typed "Nubank PJ" would
 * resolve to "Nubank" purely because the shorter name is a substring.
 *
 * Bounded and deterministic: one left-to-right scan of the message, at most
 * {@link MAX_NAME_RUN} tokens per candidate run, no model and no network. It
 * returns the cited name (the user's own words, never an id) or `undefined`.
 */
const moreSpecificCitedName = (text: string, account: EntitySummary): string | undefined => {
  const nameFold = foldEntityName(account.name);
  if (nameFold.length === 0) return undefined;
  const tokens = runTokens(text);
  for (let start = 0; start < tokens.length; start += 1) {
    // The name-like run that starts at this token ("Nubank PJ", "Nubank Visa
    // Gold"), which is what the user may have cited as a whole.
    const run = [tokens[start]!.text.replace(TRAILING_PUNCTUATION, '')];
    for (let take = 1; take < MAX_NAME_RUN && start + take < tokens.length; take += 1) {
      const next = tokens[start + take]!;
      if (!extendsRun(next)) break;
      run.push(next.text.replace(TRAILING_PUNCTUATION, ''));
    }
    const runFold = foldEntityName(run.join(' '));
    if (runFold.length <= nameFold.length || !runFold.startsWith(nameFold)) continue;
    // A plural or an inflection ("Nubanks") is the SAME name, not a more
    // specific one: only a non-letter boundary extends it ("Nubank PJ").
    if (/\p{L}/u.test(runFold[nameFold.length] ?? '')) continue;
    return run.join(' ');
  }
  return undefined;
};

/**
 * Bounded, deterministic ranking over CURRENT candidates (R08 tier 4). Token
 * overlap plus a conservative prefix match (`aliment` → `alimentacao`), with a
 * floor of half of the query's meaningful tokens. No model, no network, no new
 * category: the result only reorders rows the authoritative list already has,
 * and the caller presents it as a CANDIDATE the user confirms.
 */
const meaningfulTokens = (folded: string): string[] =>
  folded.split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !CATEGORY_STOPWORDS.has(token));

const semanticCandidates = (queryFold: string, categories: readonly EntitySummary[]): EntitySummary[] => {
  const queryTokens = meaningfulTokens(queryFold);
  if (queryTokens.length === 0) return [];
  const scored = categories.map((category) => {
    const nameTokens = meaningfulTokens(foldEntityName(category.name));
    const shared = queryTokens.filter((token) =>
      nameTokens.some((nameToken) => nameToken === token || (token.length >= 4 && nameToken.startsWith(token))),
    ).length;
    return { category, coverage: shared / queryTokens.length };
  });
  return scored
    .filter(({ coverage }) => coverage >= 0.5)
    .sort((left, right) => (right.coverage - left.coverage) || left.category.name.localeCompare(right.category.name, 'pt-BR'))
    .slice(0, MAX_SEMANTIC_CANDIDATES)
    .map(({ category }) => category);
};

const outcome = (input: {
  source: ResolutionSource;
  invalidated?: readonly InvalidatedReference[];
  overrode?: InvalidatedReference;
  homonyms?: readonly string[];
}): ResolutionOutcome => ({
  source: input.source,
  invalidated: input.invalidated ?? [],
  ...(input.overrode ? { overrode: input.overrode } : {}),
  homonyms: input.homonyms ?? [],
});

/** Fail-closed terminal: unreadable authoritative data can never become a proposal. */
const readFailure = (
  accounts: EntitySummary[] | null,
  categories: EntitySummary[] | null,
): EntityResolution => ({
  complete: false,
  missingFields: [
    ...(accounts === null ? ['accountId'] : []),
    ...(categories === null ? ['categoryId'] : []),
  ],
  clarification: READ_FAILURE_CLARIFICATION,
  trace: { account: outcome({ source: 'clarification' }), category: outcome({ source: 'clarification' }) },
});

export const resolveMutationEntities = async (
  parsed: ResolvableMutation,
  text: string,
  reader: EntityReader,
  options: EntityResolutionOptions = {},
): Promise<EntityResolution> => {
  const [accountsSettled, categoriesSettled] = await Promise.allSettled([
    reader.listAccounts(),
    reader.listCategories(),
  ]);
  const accounts = accountsSettled.status === 'fulfilled' ? normalizeEntities(accountsSettled.value) : null;
  const categories = categoriesSettled.status === 'fulfilled' ? normalizeEntities(categoriesSettled.value) : null;

  if (accounts === null || categories === null) return readFailure(accounts, categories);

  const scope = reader.scope?.workspaceId;
  const usableAccounts = usableEntities(accounts, scope);
  const usableCategories = usableEntities(categories, scope);
  const confirmedAccountId = options.confirmed?.accountId?.trim() ?? '';
  const confirmedCategoryId = options.confirmed?.categoryId?.trim() ?? '';
  // R08: a confirmed alias is checked against the CURRENT list up front, so a
  // reference that no longer verifies is invalidated the moment the authority
  // says so — whichever branch the turn then takes.
  const confirmedAccount = confirmedAccountId
    ? usableAccounts.find((account) => byId(account.id) === byId(confirmedAccountId))
    : undefined;
  const confirmedCategory = confirmedCategoryId
    ? usableCategories.find((category) => byId(category.id) === byId(confirmedCategoryId))
    : undefined;

  const missingFields: string[] = [];
  const accountSections: string[] = [];
  const categorySections: string[] = [];
  let accountId: string | null = null;
  let accountName: string | null = null;
  let categoryId: string | null = null;
  let categoryName: string | null = null;

  // --- Account (R08 §7.2): explicit choice > confirmed alias > deterministic.
  const accountInvalidated: InvalidatedReference[] = confirmedAccountId && !confirmedAccount
    ? ['confirmed_account_id']
    : [];
  const haystack = foldEntityName(text);
  const namesAccount = (account: EntitySummary): boolean => {
    const name = foldEntityName(account.name);
    return name.length > 0 && haystack.length > 0 && exactOrContained(haystack, name);
  };
  const hintedAll = accounts.filter(namesAccount);
  const hinted = hintedAll.filter((account) => isUsable(account, scope));
  // Named but no longer usable: visible, never silently replaced by another.
  // A row from another workspace is not "unavailable" — it simply never exists
  // here, so it is never named to the user either.
  const unavailable = hintedAll.filter((account) => !isOutOfScope(account, scope) && !isActiveRow(account));
  // R08: naming a MORE SPECIFIC account that is no longer available must not
  // collapse into a LESS SPECIFIC active one. "Nubank PJ" (inactive) only beats
  // "Nubank" (active) by a longer folded match, so when the user cited the
  // longer name we never let the shorter one win the turn — the disabled one
  // is named back and the decision stays with the user.
  // AT LEAST as specific, not longer: two rows the user cited under the SAME
  // folded name (an active one and a deactivated twin) are a tie, and a tie is
  // a question, never a silent pick of the surviving row.
  const unavailableBlocks = (account: EntitySummary): boolean =>
    unavailable.some((row) => foldEntityName(row.name).length >= foldEntityName(account.name).length);
  // The other half of the same rule, for the reader that only ever delivers
  // usable rows (production): the name the user actually typed is longer than
  // the only active row it covers, so nothing may be resolved on that row's
  // behalf — not by substring, not by the confirmed alias, not by the single
  // active account.
  const citedMoreSpecific = hinted.length === 1 && !unavailableBlocks(hinted[0]!)
    ? moreSpecificCitedName(text, hinted[0]!)
    : undefined;
  let accountSource: ResolutionSource = 'clarification';
  let accountHomonyms: readonly string[] = [];
  let accountOverrode: InvalidatedReference | undefined;
  if (hinted.length === 1 && !unavailableBlocks(hinted[0]!) && citedMoreSpecific === undefined) {
    accountId = hinted[0]!.id;
    accountName = hinted[0]!.name;
    accountSource = 'explicit';
    if (confirmedAccountId && byId(confirmedAccountId) !== byId(hinted[0]!.id)) {
      // The turn's explicit choice wins over the confirmed preference; the
      // conflict stays recorded instead of being resolved silently.
      accountOverrode = 'confirmed_account_id';
    }
  } else if (hinted.length > 1) {
    accountHomonyms = hinted.map((account) => account.name);
    missingFields.push('accountId');
    accountSections.push(`Encontrei mais de uma conta para sua mensagem. Em qual conta devo registrar?${bulletList(accountHomonyms)}`);
  } else if (unavailable.length > 0) {
    missingFields.push('accountId');
    const named = unavailable.map((account) => account.name);
    accountSections.push(
      `A conta ${named.join(', ')} não está mais disponível.${usableAccounts.length > 0 ? ' Em qual conta devo registrar?' : ''}${usableAccounts.length > 0 ? bulletList(usableAccounts.map((account) => account.name)) : ''}`,
    );
  } else if (citedMoreSpecific !== undefined) {
    // The quoted name is the user's own wording — never an id, and never a claim
    // that a specific row is deactivated (we cannot see it: an authoritative
    // read that only delivers usable rows cannot tell us why it is missing).
    missingFields.push('accountId');
    accountSections.push(
      `Não encontrei a conta "${citedMoreSpecific}" que você citou.${usableAccounts.length > 0 ? ' Em qual conta devo registrar?' : ''}${usableAccounts.length > 0 ? bulletList(usableAccounts.map((account) => account.name)) : ''}`,
    );
  } else if (confirmedAccount) {
    // Tier 2: the preference already confirmed inside this scope.
    accountId = confirmedAccount.id;
    accountName = confirmedAccount.name;
    accountSource = 'confirmed_alias';
  } else if (usableAccounts.length === 1) {
    accountId = usableAccounts[0]!.id;
    accountName = usableAccounts[0]!.name;
    accountSource = 'deterministic';
  } else if (usableAccounts.length === 0) {
    missingFields.push('accountId');
    accountSections.push('Não encontrei nenhuma conta disponível. Crie uma conta antes de registrar.');
  } else {
    missingFields.push('accountId');
    accountHomonyms = usableAccounts.map((account) => account.name);
    accountSections.push(`Em qual conta devo registrar?${bulletList(accountHomonyms)}`);
  }

  // --- Category (R08 §7.3): declared reference > confirmed alias > deterministic
  // name match > semantic candidate > clarification. The description is never a
  // category query (R03/A03): no semantic inference may enter through it.
  const categoryInvalidated: InvalidatedReference[] = confirmedCategoryId && !confirmedCategory
    ? ['confirmed_category_id']
    : [];
  let categorySource: ResolutionSource = 'clarification';
  let categoryHomonyms: readonly string[] = [];
  let categoryOverrode: InvalidatedReference | undefined;
  let explicitReferenceInvalidated = false;
  // Symmetric with the account axis: the turn's explicit choice wins over the
  // confirmed preference and the conflict stays recorded, never silent.
  const noteCategoryOverride = (chosen: EntitySummary): void => {
    if (confirmedCategoryId && byId(confirmedCategoryId) !== byId(chosen.id)) {
      categoryOverrode = 'confirmed_category_id';
    }
  };
  const categoryQuery = parsed.categoryQuery?.trim() ?? '';
  if (categoryQuery.length > 0 && UUID.test(categoryQuery)) {
    const verified = usableCategories.find((category) => byId(category.id) === byId(categoryQuery));
    if (verified) {
      categoryId = verified.id;
      categoryName = verified.name;
      categorySource = 'explicit';
      noteCategoryOverride(verified);
    } else {
      // The declared id does not exist any more: invalidate it, never echo it,
      // and re-resolve. Substituting another category silently is forbidden.
      categoryInvalidated.push('explicit_category_id');
      explicitReferenceInvalidated = true;
    }
  }
  if (categoryId === null && categoryQuery.length > 0 && !explicitReferenceInvalidated) {
    const queryFold = foldEntityName(categoryQuery);
    const exact = usableCategories.filter((category) => foldEntityName(category.name) === queryFold);
    const contained = exact.length === 0
      ? usableCategories.filter((category) => {
        const name = foldEntityName(category.name);
        return name.length > 0 && queryFold.length > 0 && exactOrContained(queryFold, name);
      })
      : [];
    const deterministic = exact.length > 0 ? exact : contained;
    if (deterministic.length === 1) {
      categoryId = deterministic[0]!.id;
      categoryName = deterministic[0]!.name;
      categorySource = 'explicit';
      noteCategoryOverride(deterministic[0]!);
    } else if (deterministic.length > 1) {
      // Homonyms stay visible instead of becoming a silent pick.
      categoryHomonyms = deterministic.map((category) => category.name);
      missingFields.push('categoryId');
      categorySections.push(`Encontrei mais de uma categoria para "${categoryQuery}". Qual delas devo usar?${bulletList(categoryHomonyms)}`);
    } else if (confirmedCategory) {
      // A category CONFIRMED earlier in this scope outranks the semantic
      // ranking: reopening an already-settled decision with a fuzzy guess is
      // what the R08 order forbids. Only this turn's explicit choice may.
      categoryId = confirmedCategory.id;
      categoryName = confirmedCategory.name;
      categorySource = 'confirmed_alias';
    } else {
      // R08 tier 4: a bounded ranking among CURRENT candidates. It suggests,
      // it never selects, and it never creates a category.
      const ranked = semanticCandidates(queryFold, usableCategories);
      missingFields.push('categoryId');
      if (ranked.length > 0) {
        categorySource = 'semantic_candidate';
        categoryHomonyms = ranked.map((category) => category.name);
        categorySections.push(`Não encontrei a categoria "${categoryQuery}" com esse nome. Talvez você quis dizer?${bulletList(categoryHomonyms)}`);
      } else {
        categorySections.push(`Não encontrei a categoria "${categoryQuery}". Qual categoria devo usar?${bulletList(usableCategories.map((category) => category.name))}`);
      }
    }
  }
  if (categoryId === null && categoryQuery.length === 0) {
    // Tier 2 for the category: the preference already confirmed in scope.
    if (confirmedCategory) {
      categoryId = confirmedCategory.id;
      categoryName = confirmedCategory.name;
      categorySource = 'confirmed_alias';
    } else {
      // R03/A03 (sacred): only a literal, fold-exact name match is legitimate
      // when the user declared no category — a real "Carne" still resolves
      // while an automatic inference fallback stays prohibited.
      const descriptionFold = foldEntityName(parsed.description);
      const exact = descriptionFold.length > 0
        ? usableCategories.filter((category) => foldEntityName(category.name) === descriptionFold)
        : [];
      if (exact.length === 1) {
        categoryId = exact[0]!.id;
        categoryName = exact[0]!.name;
        categorySource = 'deterministic';
      } else {
        missingFields.push('categoryId');
        // Generic on purpose: no category was asked for, so reporting the
        // description as a category that could not be found would be false.
        categorySections.push(`Qual categoria devo usar?${bulletList(usableCategories.map((category) => category.name))}`);
      }
    }
  }
  if (categoryId === null && explicitReferenceInvalidated) {
    missingFields.push('categoryId');
    // The declared reference is gone: say so (never echo the dead id) and ask
    // again with the CURRENT catalog instead of substituting silently.
    categorySections.push('A categoria informada não está mais disponível.');
    categorySections.push(`Qual categoria devo usar?${bulletList(usableCategories.map((category) => category.name))}`);
  }

  const trace: EntityResolutionTrace = {
    account: outcome({
      source: accountSource,
      invalidated: accountInvalidated,
      ...(accountOverrode ? { overrode: accountOverrode } : {}),
      homonyms: accountHomonyms,
    }),
    category: outcome({
      source: categorySource,
      invalidated: categoryInvalidated,
      ...(categoryOverrode ? { overrode: categoryOverrode } : {}),
      homonyms: categoryHomonyms,
    }),
  };

  if (accountId !== null && accountName !== null && categoryId !== null && categoryName !== null) {
    return { complete: true, accountId, accountName, categoryId, categoryName, missingFields: [], trace };
  }
  return {
    complete: false,
    missingFields,
    clarification: [...accountSections, ...categorySections].join('\n\n'),
    trace,
  };
};

/**
 * A08/R08 — existence, activity and scope re-checked IMMEDIATELY before the
 * propose write (the contract point that arms the operation). An entity that
 * disappeared, was deactivated or left the scope never reaches the write: the
 * caller converges on its ordinary clarification terminal.
 *
 * This is part of the SAME resolution attempt (no recovery slot, no second
 * loop). Permitted use stays server-side: the propose's capability check is
 * unchanged, and an unreadable list fails closed here as well.
 */
export const revalidateResolvedEntities = async (
  resolution: Extract<EntityResolution, { complete: true }>,
  reader: EntityReader,
): Promise<EntityResolution> => {
  const [accountsSettled, categoriesSettled] = await Promise.allSettled([
    reader.listAccounts(),
    reader.listCategories(),
  ]);
  const accounts = accountsSettled.status === 'fulfilled' ? normalizeEntities(accountsSettled.value) : null;
  const categories = categoriesSettled.status === 'fulfilled' ? normalizeEntities(categoriesSettled.value) : null;
  if (accounts === null || categories === null) return readFailure(accounts, categories);

  const scope = reader.scope?.workspaceId;
  const usableAccounts = usableEntities(accounts, scope);
  const usableCategories = usableEntities(categories, scope);
  const account = usableAccounts.find((row) => byId(row.id) === byId(resolution.accountId));
  const category = usableCategories.find((row) => byId(row.id) === byId(resolution.categoryId));
  if (account && category) {
    // Still there: the decision stands, with the labels the authority has now.
    return { ...resolution, accountName: account.name, categoryName: category.name };
  }

  const sections: string[] = [];
  if (!account) {
    sections.push(`A conta ${resolution.accountName} não está mais disponível.`);
  }
  if (!category) {
    sections.push(`A categoria ${resolution.categoryName} não está mais disponível.`);
  }
  if (!account && usableAccounts.length > 0) {
    sections.push(`Em qual conta devo registrar?${bulletList(usableAccounts.map((row) => row.name))}`);
  }
  if (!category && usableCategories.length > 0) {
    sections.push(`Qual categoria devo usar?${bulletList(usableCategories.map((row) => row.name))}`);
  }
  return {
    complete: false,
    missingFields: [!account ? 'accountId' : null, !category ? 'categoryId' : null].filter((field): field is string => field !== null),
    clarification: sections.join('\n\n'),
    trace: {
      account: account
        ? resolution.trace.account
        : outcome({ source: 'clarification', invalidated: ['resolved_account'], homonyms: usableAccounts.map((row) => row.name) }),
      category: category
        ? resolution.trace.category
        : outcome({ source: 'clarification', invalidated: ['resolved_category'], homonyms: usableCategories.map((row) => row.name) }),
    },
  };
};