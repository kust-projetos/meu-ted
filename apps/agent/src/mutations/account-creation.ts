/**
 * Account-creation interpretation (accounts-draft-agent).
 *
 * Delimited, deterministic parsing for the CONVERSATIONAL account-creation
 * flow (`accounts.create` drafts). It is NOT a second financial parser: it
 * never reads expense/income utterances and never touches
 * `parseFinancialMutation` — it only detects an explicit account-creation
 * intent ("criar conta ...") and extracts the draft slots the fixed contract
 * names: `name`, `kind` (`bank`|`cash`) and `initialBalanceCents` (signed:
 * zero and negative are legitimate opening balances, cf. ADR-018).
 *
 * Hard rules (contract):
 * - the account `kind` is NEVER inferred from the name ("Nubank" does not
 *   imply `bank`): only an explicit kind marker (`conta corrente`, `no
 *   banco`, `dinheiro`, `especie`, ...) fills it, otherwise the turn asks;
 * - no value is ever invented: a missing slot stays missing and becomes a
 *   deterministic question, never a default (no `bank` default, no `0`
 *   default — "sem saldo" written by the user IS an explicit zero, which is
 *   different from inventing one).
 */

export const ACCOUNT_CREATE_TOOL = 'accounts.create' as const;

export type AccountDraftKind = 'bank' | 'cash';

export type AccountCreationParse = Readonly<{
  /** True only for an explicit creation intent (creation verb + "conta"). */
  isCreation: boolean;
  name?: string;
  initialBalanceCents?: number;
  /** True when the balance came from an explicit user token (incl. "zero"). */
  balanceExplicit: boolean;
  accountKind?: AccountDraftKind;
}>;

const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');

const fold = (value: string): string => value.normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();

const CREATION_VERBS = [
  'criar', 'cria', 'crie', 'criam', 'criamos', 'criei', 'criou',
  'cadastrar', 'cadastra', 'cadastre', 'cadastrei',
  'adicionar', 'adicione', 'abrir', 'abra', 'abri', 'abriu',
  'nova', 'novo', 'abertura',
];

const wordRe = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${words.join('|')})\\b`);

const CREATION_VERB_RE = wordRe(CREATION_VERBS);

/**
 * Explicit creation signal: a creation verb AND the word "conta" in the same
 * turn. Deliberately narrow — "paguei a conta de luz" (no verb) and "nubank
 * o saldo atual e 145" (no verb, no "conta") are NOT creation turns; they
 * only ever continue an already-active account draft.
 */
export const hasAccountCreationSignal = (text: string): boolean => {
  const folded = fold(text);
  return CREATION_VERB_RE.test(folded) && new RegExp('\\bconta\\b').test(folded);
};

const SHORT_AFFIRMATIVES = [
  'quero', 'sim', 'pode', 'bora', 'vamos', 'fechado', 'isso', 'ok',
  'beleza', 'combinado', 'claro', 'confirmo', 'confirmar', 'pode ser',
  'pode criar', 'cria', 'crie', 'faz', 'manda', 'quero sim', 'sim, quero',
  'por favor',
];

/** Short offer-acceptance ("quero", "sim", "pode criar") — never a value. */
export const isShortAffirmative = (text: string): boolean => {
  const folded = fold(text.trim()).replace(/[!.\s]+$/, '');
  return text.trim().length <= 24 && SHORT_AFFIRMATIVES.some((a) => folded === a);
};

const CONFIRM_CREATE_PHRASES = [
  'pode criar', 'sim, pode criar', 'sim, cria', 'sim, criar', 'cria',
  'criar', 'cria a conta', 'criar a conta', 'confirmo', 'confirmar',
  'quero sim', 'fechado',
];

/** Explicit creation confirmation for an already-complete draft. */
export const isConfirmCreateText = (text: string): boolean => {
  const folded = fold(text.trim()).replace(new RegExp('[\\s!.]+$', ''), '');
  return text.trim().length <= 32 && CONFIRM_CREATE_PHRASES.some((a) => folded === a);
};

const BANK_KIND_MARKERS = [
  'corrente', 'poupanca', 'bancaria', 'no banco', 'do banco',
  'num banco', 'conta corrente', 'conta poupanca',
];
const CASH_KIND_MARKERS = [
  'dinheiro', 'especie', 'carteira', 'fisico', 'em maos', 'bolso',
  'moeda fisica',
];
// Bare answers ("banco") only count when the name is already known (opt-in
// via `allowBare`): on a fresh turn they would infer kind from names like
// "Banco do Brasil" — never infer from the name.
const BARE_BANK_MARKERS = ['banco', 'bank'];

export const parseAccountKind = (text: string, opts?: { allowBare?: boolean }): AccountDraftKind | undefined => {
  const folded = ` ${fold(text)} `;
  if (CASH_KIND_MARKERS.some((m) => folded.includes(m))) return 'cash';
  if (BANK_KIND_MARKERS.some((m) => folded.includes(m))) return 'bank';
  if (opts?.allowBare && BARE_BANK_MARKERS.some((m) => folded.includes(m))) return 'bank';
  // NOTE: the bare word "conta" deliberately fills NOTHING — the kind must
  // be asked, never inferred from the name or from the generic noun.
  return undefined;
};

const ZERO_BALANCE_MARKERS = ['zero', 'zerada', 'zerado', 'sem saldo'];
const NEGATIVE_CUES = ['negativo', 'negativa', 'menos', 'devendo', 'descoberto'];

const centsFromToken = (token: string): number | undefined => {
  const normalized = token.includes(',')
    ? token.replace(new RegExp('\\.', 'g'), '').replace(',', '.')
    : new RegExp('^\\d{1,3}(?:\\.\\d{3})+$').test(token)
      ? token.replace(new RegExp('\\.', 'g'), '')
      : token;
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ''] = unsigned.split('.');
  if (!whole || !new RegExp('^\\d+$').test(whole) || !new RegExp('^\\d{0,2}$').test(fraction)) return undefined;
  const total = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const value = Number(total);
  return negative ? -value : value;
};

const NUMBER_TOKEN_RE = new RegExp('-?\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|-?\\d{1,12}(?:[.,]\\d{1,2})?', 'g');

/**
 * Extracts the opening balance the user WROTE (signed). Sources, in order:
 * 1. an explicit "saldo ... <number>" / "<number> ... saldo" fragment;
 * 2. an explicit zero ("saldo zero", "zerada", "sem saldo");
 * 3. a single parseable number in a creation turn (the "145" in "criar conta
 *    nubank com saldo 145" is caught by (1); a lone number with no balance
 *    cue is NOT taken — it stays missing and is asked).
 *
 * A "negativo"/"menos"/leading-dash marker signs the value. Anything else
 * (two numbers, unparseable) yields `undefined`: ask, never invent.
 */
export const parseAccountBalance = (text: string): { cents: number; explicit: boolean } | undefined => {
  const folded = fold(text);
  const tokens = [...text.matchAll(NUMBER_TOKEN_RE)].map((m) => m[0]).filter((t) => new RegExp('[1-9-]').test(t) || t === '0');
  const hasSaldoCue = folded.includes('saldo');
  if (ZERO_BALANCE_MARKERS.some((m) => folded.includes(m)) && (hasSaldoCue || tokens.length === 0)) {
    return { cents: 0, explicit: true };
  }
  if (tokens.length !== 1) return undefined;
  if (!hasSaldoCue && !hasAccountCreationSignal(text)) return undefined;
  const cents = centsFromToken(tokens[0]!);
  if (cents === undefined) return undefined;
  if (NEGATIVE_CUES.some((m) => folded.includes(m)) && cents > 0) return { cents: -cents, explicit: true };
  return { cents, explicit: true };
};

/**
 * Content words stripped ANYWHERE in the turn: creation verbs, the "conta"
 * noun, kind markers, balance vocabulary, numbers-adjacent fillers ("com",
 * "para", ...). Short function words (`de`/`do`/`o`/`é`/`e`, ...) are
 * deliberately NOT here: they are trimmed ONLY at the name edges (see
 * EDGE_FILLERS), so interior words survive ("Banco do Brasil" keeps "do").
 */
const STRIP_WORDS = [
  ...CREATION_VERBS,
  'conta', 'contas',
  'corrente', 'poupanca', 'bancaria', 'no banco', 'do banco', 'num banco',
  'dinheiro', 'especie', 'carteira', 'fisico', 'em maos', 'bolso',
  'moeda fisica',
  'saldo', 'saldos', 'inicial', 'atual', 'atualizado', 'atualizada',
  'com',
  'pra', 'para', 'meu', 'minha', 'por favor', 'quero', 'pode', 'ser',
  'reais', 'real', 'rs',
  'zero', 'zerada', 'zerado', 'sem saldo', 'negativo', 'negativa', 'menos',
  'espécie', 'físico', 'mãos',
];

const escapeRe = (word: string): string =>
  word.replace(new RegExp('[.+*?^${}()|[\\]\\\\]', 'g'), '\\$&');

const STRIP_RE = new RegExp(
  `(?<!\\p{L})(?:${[...STRIP_WORDS].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?!\\p{L})`,
  'giu',
);
const NUM_RE = new RegExp('-?\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|-?\\d{1,12}(?:[.,]\\d{1,2})?', 'g');
const PUNCT_RE = new RegExp('[\\s,.;:!?|/\\\\\\-_()"]+', 'g');

/**
 * Short function words trimmed ONLY at the name edges (never stripped
 * inside): "Banco do Brasil" keeps its interior "do", while "nubank o ...
 * é" loses the dangling "o"/"é". Compared folded so "é" matches even though
 * `\b` is ASCII-only and never matched it (the live "nubank é" bug).
 */
const EDGE_FILLERS = [
  'e', 'eh', 'é',
  'o', 'a', 'os', 'as',
  'um', 'uma', 'uns', 'umas',
  'de', 'da', 'do', 'das', 'dos',
  'no', 'na', 'nos', 'nas',
];
const EDGE_FILLER_SET = new Set(EDGE_FILLERS.map((w) => fold(w)));

const trimEdgeFillers = (name: string): string => {
  const tokens = name.split(' ').filter(Boolean);
  while (tokens.length > 1 && EDGE_FILLER_SET.has(fold(tokens[0]!))) tokens.shift();
  while (tokens.length > 1 && EDGE_FILLER_SET.has(fold(tokens[tokens.length - 1]!))) tokens.pop();
  return tokens.join(' ');
};

/**
 * The human name fragment: whatever survives after stripping creation verbs,
 * the "conta" noun, kind markers, balance vocabulary, numbers and fillers.
 * Empty (or filler-only) remainder = no name: ask, never invent.
 */
export const extractAccountName = (text: string): string | undefined => {
  // Strip on the ORIGINAL text (case-insensitive patterns) so the surviving
  // name keeps the user's casing ("Nubank", not "nubank").
  let rest = ` ${text} `.replace(STRIP_RE, ' ').replace(NUM_RE, ' ');
  rest = rest.replace(PUNCT_RE, ' ').trim().slice(0, 80).trim();
  // "r$" leaves a stray "r" after the `$` strip: drop lone filler letters.
  rest = rest.replace(new RegExp('(^|\\s)[rs](?=\\s|$)', 'gi'), ' ').replace(PUNCT_RE, ' ').trim();
  rest = trimEdgeFillers(rest);
  return rest ? rest : undefined;
};

export const parseAccountCreation = (text: string): AccountCreationParse => {
  const isCreation = hasAccountCreationSignal(text);
  const name = extractAccountName(text);
  const balance = parseAccountBalance(text);
  const accountKind = parseAccountKind(text);
  return Object.freeze({
    isCreation,
    balanceExplicit: balance?.explicit ?? false,
    ...(name ? { name } : {}),
    ...(balance ? { initialBalanceCents: balance.cents } : {}),
    ...(accountKind ? { accountKind } : {}),
  });
};

export type AccountMissingField = 'name' | 'kind' | 'initialBalanceCents';

export const accountMissingFields = (input: {
  name?: string;
  accountKind?: AccountDraftKind;
  initialBalanceCents?: number;
}): AccountMissingField[] => {
  const missing: AccountMissingField[] = [];
  if (!input.name || !input.name.trim()) missing.push('name');
  if (input.initialBalanceCents === undefined || !Number.isInteger(input.initialBalanceCents)) {
    missing.push('initialBalanceCents');
  }
  if (input.accountKind !== 'bank' && input.accountKind !== 'cash') missing.push('kind');
  return missing;
};

export const accountKindLabel = (kind: AccountDraftKind): string =>
  kind === 'bank' ? 'conta no banco' : 'dinheiro em espécie';

/** Next deterministic question: names ONLY the missing slots, never values. */
export const accountQuestion = (missing: readonly AccountMissingField[], name?: string): string => {
  const named = name && name.trim() ? `"${name.trim()}"` : null;
  const wantsName = missing.includes('name');
  const wantsBalance = missing.includes('initialBalanceCents');
  const wantsKind = missing.includes('kind');
  if (!wantsName && !wantsBalance && wantsKind) {
    return named
      ? `A conta ${named} é conta no banco ou dinheiro em espécie?`
      : 'É conta no banco ou dinheiro em espécie?';
  }
  if (wantsName && !wantsBalance && !wantsKind) return 'Qual o nome da conta?';
  if (!wantsName && wantsBalance && !wantsKind) {
    return named
      ? `Qual o saldo inicial da conta ${named}? Pode ser zero ou negativo.`
      : 'Qual o saldo inicial? Pode ser zero ou negativo.';
  }
  if (wantsName && wantsBalance) {
    return 'Vamos criar a conta. Me diga o nome da conta e o saldo inicial (por exemplo: "Nubank, saldo 145").';
  }
  const parts: string[] = [];
  if (wantsName) parts.push('o nome');
  if (wantsBalance) parts.push('o saldo inicial');
  if (wantsKind) parts.push('o tipo (conta no banco ou dinheiro em espécie)');
  return `Para criar a conta, me diga ${parts.join(' e ')}.`;
};
