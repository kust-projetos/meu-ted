/**
 * Authoritative entity resolution (SPEC §7.2, §7.3, §7.6 — H-01).
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
 */

export type EntitySummary = Readonly<{ id: string; name: string }>;

export type EntityReader = Readonly<{
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

export type EntityResolution =
  | Readonly<{ complete: true; accountId: string; accountName: string; categoryId: string; categoryName: string; missingFields: readonly [] }>
  | Readonly<{ complete: false; missingFields: readonly string[]; clarification: string }>;

type RequestFn = (
  method: string,
  path: string,
  options?: { query?: Record<string, string>; headers?: Record<string, string> },
) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CLARIFICATION_OPTIONS = 10;

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
    if (id && name) entities.push({ id, name });
  }
  return entities;
};

/**
 * Builds an {@link EntityReader} over the same request seam the existing
 * entity-resolution helper uses (`GET /accounts`, `GET /categories`) —
 * authoritative workspace reads, never guesses.
 */
export const createRequestEntityReader = (request: RequestFn): EntityReader => ({
  listAccounts: async () => normalizeEntities(await request('GET', '/accounts')),
  listCategories: async () => normalizeEntities(await request('GET', '/categories')),
});

const bulletList = (names: readonly string[]): string =>
  names.slice(0, MAX_CLARIFICATION_OPTIONS).map((name) => `\n• ${name}`).join('');

const exactOrContained = (query: string, name: string): boolean =>
  name === query || name.includes(query) || query.includes(name);

export const resolveMutationEntities = async (
  parsed: ResolvableMutation,
  text: string,
  reader: EntityReader,
): Promise<EntityResolution> => {
  const [accountsSettled, categoriesSettled] = await Promise.allSettled([
    reader.listAccounts(),
    reader.listCategories(),
  ]);
  const accounts = accountsSettled.status === 'fulfilled' ? normalizeEntities(accountsSettled.value) : null;
  const categories = categoriesSettled.status === 'fulfilled' ? normalizeEntities(categoriesSettled.value) : null;

  // Fail closed: unreadable authoritative data can never become a proposal.
  if (accounts === null || categories === null) {
    const missing = [...(accounts === null ? ['accountId'] : []), ...(categories === null ? ['categoryId'] : [])];
    return {
      complete: false,
      missingFields: missing,
      clarification: 'Não consegui acessar seus dados financeiros agora. Tente novamente em instantes.',
    };
  }

  const missingFields: string[] = [];
  const sections: string[] = [];
  let accountId: string | null = null;
  let accountName: string | null = null;
  let categoryId: string | null = null;
  let categoryName: string | null = null;

  // --- Account (§7.2): explicit unambiguous indication, else single account.
  const haystack = foldEntityName(text);
  const hinted = accounts.filter((account) => {
    const name = foldEntityName(account.name);
    return name.length > 0 && haystack.length > 0 && exactOrContained(haystack, name);
  });
  if (hinted.length === 1) {
    accountId = hinted[0]!.id;
    accountName = hinted[0]!.name;
  } else if (hinted.length > 1) {
    missingFields.push('accountId');
    sections.push(`Encontrei mais de uma conta para sua mensagem. Em qual conta devo registrar?${bulletList(hinted.map((a) => a.name))}`);
  } else if (accounts.length === 1) {
    accountId = accounts[0]!.id;
    accountName = accounts[0]!.name;
  } else if (accounts.length === 0) {
    missingFields.push('accountId');
    sections.push('Não encontrei nenhuma conta disponível. Crie uma conta antes de registrar.');
  } else {
    missingFields.push('accountId');
    sections.push(`Em qual conta devo registrar?${bulletList(accounts.map((a) => a.name))}`);
  }

  // --- Category (§7.3): the user's explicit category statement is the only
  // semantic query. The transaction description is NOT a category query
  // (SPEC R03): "gastei 50 de carne" keeps `carne` as the description, and
  // matching the description fuzzily would turn every expense description into
  // an inferred category. Without an explicit `categoryQuery`, only a literal
  // fold-exact name match is legitimate — a real "Carne" category still
  // resolves — while a contained/fuzzy hit stays a candidate that asks instead
  // of selecting.
  const categoryQuery = parsed.categoryQuery?.trim() ?? '';
  if (categoryQuery.length > 0 && UUID.test(categoryQuery)) {
    const verified = categories.find((category) => category.id.toLowerCase() === categoryQuery.toLowerCase());
    if (verified) {
      categoryId = verified.id;
      categoryName = verified.name;
    } else {
      missingFields.push('categoryId');
      sections.push(`Não encontrei a categoria informada. Qual categoria devo usar?${bulletList(categories.map((c) => c.name))}`);
    }
  } else if (categoryQuery.length > 0) {
    const queryFold = foldEntityName(categoryQuery);
    const exact = categories.filter((category) => foldEntityName(category.name) === queryFold);
    const candidates = exact.length > 0
      ? exact
      : categories.filter((category) => {
        const name = foldEntityName(category.name);
        return name.length > 0 && queryFold.length > 0 && exactOrContained(queryFold, name);
      });
    if (candidates.length === 1) {
      categoryId = candidates[0]!.id;
      categoryName = candidates[0]!.name;
    } else if (candidates.length > 1) {
      missingFields.push('categoryId');
      sections.push(`Encontrei mais de uma categoria para "${categoryQuery}". Qual delas devo usar?${bulletList(candidates.map((c) => c.name))}`);
    } else {
      missingFields.push('categoryId');
      sections.push(`Não encontrei a categoria "${categoryQuery}". Qual categoria devo usar?${bulletList(categories.map((c) => c.name))}`);
    }
  } else {
    const descriptionFold = foldEntityName(parsed.description);
    const exact = descriptionFold.length > 0
      ? categories.filter((category) => foldEntityName(category.name) === descriptionFold)
      : [];
    if (exact.length === 1) {
      categoryId = exact[0]!.id;
      categoryName = exact[0]!.name;
    } else {
      missingFields.push('categoryId');
      // Generic on purpose: no category was asked for, so reporting the
      // description as a category that could not be found would be false.
      sections.push(`Qual categoria devo usar?${bulletList(categories.map((c) => c.name))}`);
    }
  }

  if (accountId !== null && accountName !== null && categoryId !== null && categoryName !== null) {
    return { complete: true, accountId, accountName, categoryId, categoryName, missingFields: [] };
  }
  return { complete: false, missingFields, clarification: sections.join('\n\n') };
};
