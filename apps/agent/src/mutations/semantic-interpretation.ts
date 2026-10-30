/**
 * A06 / SPEC R06 — interpretação semântica DELIMITADA.
 *
 * This module is a *normalization* layer in front of the existing parser, not
 * a second parser. It never replaces {@link parseFinancialMutation}: every
 * well-formed utterance is handed to it byte-identical, so the characterized
 * behavior stays green. What this layer adds is:
 *
 * 1. a schema-validated candidate with per-field provenance (R06);
 * 2. typed ambiguity flags that become the existing deterministic
 *    clarifications instead of a fabricated value (AC13).
 *
 * Boundaries it deliberately does NOT cross:
 * - no entity selection: an account hint only reaches the resolver as TEXT and
 *   is matched there against the authoritative account list (R08/A08 owns the
 *   alias store — the map below is a spelling-repair seed, not authority);
 * - no category inference from the description (R03/A03 preserved: `carne`
 *   stays the description);
 * - no new authorization or auto-execution threshold (V5 untouched);
 * - no second FSM, no persistent state, no network.
 */

import { DEFAULT_FINANCIAL_TIME_ZONE, parseFinancialMutation, parseMoneyToCents, isClearlyMutating } from './financial-parser.js';

export type ParsedCandidate = Readonly<{ kind: 'expense' | 'income'; amountCents: number; description: string; date: string; categoryQuery?: string }>;

export type FieldSource = 'token' | 'normalized_token' | 'implicit';

export type FieldProvenance<T = string> = Readonly<{
  /** Where the field came from: the literal token, its canonical form, or the default. */
  source: FieldSource;
  /** Exact span from the ORIGINAL message ('' when implicit). */
  raw: string;
  /** Canonical token handed downstream, when the literal one was rewritten. */
  normalized?: string;
  /** Resolved value of the field. */
  value: T;
  /** Timezone used to resolve the field. */
  timeZone?: string;
  /** 'default' means the caller supplied NO authorized timezone (never silent). */
  timeZoneSource?: 'authorized' | 'default';
}>;

/** AC13 — every value that must become a deterministic question, never a guess. */
export type SemanticAmbiguity =
  | 'negation'
  | 'approximate_amount'
  | 'unsupported_currency'
  | 'ambiguous_separator'
  | 'contradictory_dates'
  | 'ambiguous_year_date'
  | 'unresolved_explicit_date';

export type SemanticInterpretation =
  | Readonly<{
      status: 'candidate';
      /** The original message, preserved verbatim (R06). */
      raw: string;
      /** Canonical utterance actually parsed; '' means the original was used as-is. */
      normalizedText: string;
      /** Haystack for deterministic entity resolution (original + canonical hints). */
      resolutionText: string;
      parsed: ParsedCandidate;
      provenance: Readonly<{
        kind: FieldProvenance;
        amountCents: FieldProvenance<number>;
        description: FieldProvenance;
        date: FieldProvenance;
        categoryQuery?: FieldProvenance;
        accountHint?: FieldProvenance;
      }>;
      /** ADVISORY ONLY (R06): a signal, never an execution threshold. */
      confidence: number;
    }>
  | Readonly<{
      status: 'clarify';
      raw: string;
      ambiguities: readonly SemanticAmbiguity[];
      missingFields: readonly string[];
      clarification: string;
    }>
  | Readonly<{
      status: 'unparsed';
      raw: string;
      /** Reason handed over from the existing parser, unchanged. */
      reason: 'missing_amount' | 'unsupported';
    }>
  | Readonly<{ status: 'not-mutation'; raw: string }>;

// --- Bounded, deterministic tables -------------------------------------------------

/**
 * Clipped mutation verbs. Deliberately tiny: only forms that are not words in
 * Portuguese on their own, so no well-formed message is ever rewritten.
 */
const VERB_ABBREVIATIONS: ReadonlyArray<Readonly<{ from: string; to: string }>> = [
  { from: 'gstei', to: 'gastei' },
  { from: 'gst', to: 'gastei' },
  { from: 'pgei', to: 'paguei' },
  { from: 'rcbi', to: 'recebi' },
  { from: 'gnhei', to: 'ganhei' },
  { from: 'lncar', to: 'lancar' },
];

/**
 * Clipped prepositions (only the unambiguous standalone form).
 *
 * The pattern is case-SENSITIVE on purpose: an isolated uppercase `D` inside a
 * phrase is a real word (`vitamina D`, `Vitamina C`), never a clipped `de`.
 */
const PREPOSITION_ABBREVIATIONS: ReadonlyArray<Readonly<{ from: string; to: string }>> = [{ from: 'd', to: 'de' }];

/**
 * Amount literal the description region follows. Mirrors the parser's own
 * `bareAmountToken`, so the preposition is expanded only where the parser
 * would actually read a description (`<amount> d <word>`).
 */
const AMOUNT_LITERAL = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,12}(?:[.,]\d{1,2})?)`;

/** Preposition that introduces an account hint; consumed together with it. */
const ACCOUNT_HINT_LEAD = String.raw`(?:\b(?:nos|nas|no|na|em|pro|para|da|do)\s+)?`;

/** Clipped relative dates. */
const CANONICAL_DATE: Readonly<Record<string, string>> = {
  hoje: 'hoje',
  hj: 'hoje',
  ontem: 'ontem',
  ontm: 'ontem',
  anteontem: 'anteontem',
  antontm: 'anteontem',
};

/**
 * The mutation lexicon as ONE read-only set, derived from the tables above (no
 * new vocabulary, no second source of truth): every mutation verb spelling A06
 * rewrites (clipped AND canonical), the preposition it expands and every
 * relative-date spelling.
 *
 * Exported for the A08 entity resolver, which needs the SAME words as
 * STRUCTURAL TERMINATORS when it decides how far a cited account name runs in
 * the user's sentence. That consumer must not keep a private copy of this
 * lexicon: a verb A06 learns to rewrite has to stop a name run on the same
 * turn, or the canonical utterance it produces would read as a longer account
 * name to the resolver.
 */
export const MUTATION_LEXICON_TERMINATORS: ReadonlySet<string> = new Set<string>([
  ...VERB_ABBREVIATIONS.flatMap(({ from, to }) => [from, to]),
  ...PREPOSITION_ABBREVIATIONS.map(({ to }) => to),
  ...Object.keys(CANONICAL_DATE),
]);

/**
 * Account-hint spelling repairs. A hint is TEXT ONLY: the deterministic match
 * against the authoritative account list stays in `entity-resolver` (R08), so
 * nothing here can select or invent an account id. A08 owns real aliases.
 */
const ACCOUNT_HINT_ALIASES: ReadonlyArray<Readonly<{ from: string; to: string }>> = [
  { from: 'nubnk', to: 'nubank' },
  { from: 'nub', to: 'nubank' },
];

const APPROXIMATION = /(?:\b(?:uns|umas|cerca de|aproximadamente|aproximado|aproximada|mais ou menos|por volta de|em torno de|ao redor de)\b|~)\s*(?:r\$\s*)?\d/iu;
const UNSUPPORTED_CURRENCY = /(?<![rR])\$|[£€¥]|\b(?:usd|eur|euros?|d[oó]lares?|dolares?|yen|ienes?)\b/iu;
const NEGATION = /\b(n[aã]o|nunca|jamais)\b/iu;
const EXPLICIT_DATE = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/u;
const RELATIVE_DATE_TOKEN = /\b(hoje|hj|ontem|ontm|anteontem|antontm)\b/giu;
const RELATIVE_DATE_WORDS = /\b(hoje|hj|ontem|ontm|anteontem|antontm)\b/giu;
const NUMERIC_TOKEN = /\d+(?:[.,]\d+)+/g;

const CLARIFICATION: Readonly<Record<SemanticAmbiguity, { missingFields: readonly string[]; text: string }>> = {
  negation: {
    missingFields: ['intent'],
    text: 'Entendi que este lançamento não deve ser registrado. Nada foi criado.',
  },
  approximate_amount: {
    missingFields: ['amount'],
    text: 'O valor parece aproximado. Informe o valor exato em reais para eu registrar.',
  },
  unsupported_currency: {
    missingFields: ['amount'],
    text: 'Registro apenas valores em reais. Informe o valor em reais.',
  },
  ambiguous_separator: {
    missingFields: ['amount'],
    text: 'Não identifiquei o valor com segurança por causa do separador. Informe em reais, por exemplo R$ 1.234,56.',
  },
  contradictory_dates: {
    missingFields: ['date'],
    text: 'A mensagem tem datas conflitantes. Informe a data do lançamento.',
  },
  ambiguous_year_date: {
    missingFields: ['date'],
    text: 'Não reconheci a data — você informou apenas o ano. Só entendo hoje, ontem ou anteontem: reenvie a operação inteira com uma dessas datas.',
  },
  unresolved_explicit_date: {
    missingFields: ['date'],
    text: 'Não reconheci a data informada. Só entendo hoje, ontem ou anteontem: reenvie a operação inteira com uma dessas datas.',
  },
};

// --- Token helpers -----------------------------------------------------------------

/** Word-bounded token regex. A digit may touch the token ("gstei50"), a letter may not. */
const tokenRegex = (token: string, global = false): RegExp =>
  new RegExp(`(?<!\\p{L})${token}(?!\\p{L})`, global ? 'giu' : 'iu');

const isGlobal = (regex: RegExp): boolean => regex.global || regex.sticky;
const scan = (text: string, regex: RegExp): string[] => {
  if (!isGlobal(regex)) return regex.test(text) ? [text] : [];
  return [...text.matchAll(regex)].map((match) => match[0]);
};

const replaceToken = (
  text: string,
  regex: RegExp,
  replacement: (matched: string, rebuilt: string) => string,
  canonicalOf?: (matched: string) => string | undefined,
): { text: string; matches: string[]; canonical: string | undefined } => {
  const matches: string[] = [];
  let firstCanonical: string | undefined;
  const next = text.replace(regex, (matched, offset: number, whole: string) => {
    const canonical = canonicalOf?.(matched);
    matches.push(matched);
    if (canonical !== undefined && firstCanonical === undefined) firstCanonical = canonical;
    const before = offset > 0 ? whole[offset - 1]! : '';
    const after = whole[offset + matched.length] ?? '';
    // Keep digits glued to a rewritten verb/preposition readable for the parser,
    // which anchors both on a word boundary.
    const rebuilt = `${/\d/.test(before) ? ' ' : ''}${canonical ?? matched}${/\d/.test(after) ? ' ' : ''}`;
    return replacement(matched, rebuilt);
  });
  return { text: next, matches, canonical: firstCanonical };
};

// --- Ambiguity detectors ------------------------------------------------------------

/** pt-BR number shapes that are NOT ambiguous, checked token by token. */
const isUnambiguousNumber = (token: string): boolean => {
  const separators = [...token.matchAll(/[.,]/g)].map((match) => match[0]!);
  const parts = token.split(/[.,]/);
  if (parts.length === 2) {
    const fraction = parts[1]!;
    if (separators[0] === ',') return fraction.length <= 2;
    // "1.500" is thousands; "1.50" is cents. "1.2345" is neither.
    return fraction.length <= 2 || (fraction.length % 3 === 0 && parts[0]!.length <= 3);
  }
  // Canonical pt-BR: 1.234,56
  if (parts.length === 3 && separators[0] === '.' && separators[1] === ',' && parts[2]!.length <= 2) return true;
  // Repeated pt-BR thousands: 1.234.567
  return separators.every((separator) => separator === '.') && parts.slice(1).every((part) => part.length === 3) && parts[0]!.length <= 3;
};

const hasAmbiguousSeparator = (text: string): boolean =>
  (text.match(NUMERIC_TOKEN) ?? []).some((token) => !isUnambiguousNumber(token));

const hasContradictoryDates = (text: string): boolean => {
  const relatives = new Set(scan(text, RELATIVE_DATE_WORDS).map((word) => CANONICAL_DATE[word.toLowerCase()]!));
  if (relatives.size > 1) return true;
  return relatives.size === 1 && EXPLICIT_DATE.test(text);
};

// --- Normalization -----------------------------------------------------------------

type Normalization = Readonly<{
  text: string;
  applied: boolean;
  verb?: Readonly<{ raw: string; normalized: string }>;
  preposition?: Readonly<{ raw: string; normalized: string }>;
  accountHint?: Readonly<{ raw: string; normalized: string }>;
  dateToken?: Readonly<{ raw: string; normalized: string }>;
}>;

/**
 * Rewrites an informal utterance into the canonical shape the existing parser
 * already understands: `<verb> <amount> de <description> <relative date>`, with
 * an account hint kept out of the description region (it travels as text for
 * the resolver, never as part of what was bought).
 *
 * Every rewrite is POSITIONAL and case-bounded, so a well-formed utterance is
 * never touched:
 * - the clipped preposition is expanded only where the parser reads a
 *   description (`<amount> d <word>`) and only in lowercase, so an isolated
 *   uppercase `D` inside a phrase (`vitamina D`) stays a word;
 * - a date is hoisted to the trailing position only when it was itself
 *   clipped (`hj`, `ontm`), never when it is already canonical — hoisting a
 *   canonical date would change the description away from the legacy result
 *   with no informal input to justify it.
 */
const normalizeUtterance = (raw: string): Normalization => {
  let text = raw;
  let verb: { raw: string; normalized: string } | undefined;
  let preposition: { raw: string; normalized: string } | undefined;
  let accountHint: { raw: string; normalized: string } | undefined;
  let dateToken: { raw: string; normalized: string } | undefined;

  for (const { from, to } of VERB_ABBREVIATIONS) {
    const expanded = replaceToken(text, tokenRegex(from, true), (_matched, replacement) => replacement, () => to);
    if (expanded.matches.length > 0 && !verb) verb = { raw: expanded.matches[0]!, normalized: to };
    text = expanded.text;
  }
  // Case-SENSITIVE (`gu`, never `giu`) and anchored on the amount: only the
  // clipped preposition token that opens the description is expanded.
  for (const { from, to } of PREPOSITION_ABBREVIATIONS) {
    const region = new RegExp(`(${AMOUNT_LITERAL})(\\s*)${from}(?=\\s)`, 'gu');
    text = text.replace(region, (_matched, amount: string, gap: string) => {
      if (!preposition) preposition = { raw: from, normalized: to };
      return `${amount}${gap}${to}`;
    });
  }
  for (const { from, to } of ACCOUNT_HINT_ALIASES) {
    const hint = new RegExp(String.raw`(?<!\p{L})${ACCOUNT_HINT_LEAD}${from}(?!\p{L})`, 'giu');
    const stripped = replaceToken(text, hint, () => ' ');
    if (stripped.matches.length > 0 && !accountHint) {
      // Provenance keeps the token the user actually typed, not the consumed preposition.
      accountHint = { raw: stripped.matches[0]!.split(/\s+/).pop()!, normalized: to };
    }
    text = stripped.text;
  }
  const dated = replaceToken(text, RELATIVE_DATE_TOKEN, () => ' ', (matched) => CANONICAL_DATE[matched.toLowerCase()]!);
  if (dated.matches.length > 0) dateToken = { raw: dated.matches[0]!, normalized: dated.canonical! };
  text = dated.text;

  // A canonical date token alone is not a reason to rewrite anything: the
  // parser already understands `hoje`/`ontem` where the user wrote it, and
  // hoisting it would move words in/out of the description for no reason.
  const dateRewritten = !!dateToken && dateToken.raw.toLowerCase() !== dateToken.normalized.toLowerCase();
  if (!verb && !preposition && !accountHint && !dateRewritten) return { text: raw, applied: false };

  const words = text.split(/\s+/).filter(Boolean);
  const ordered = accountHint ? [accountHint.normalized, ...words] : words;
  const canonical = dateToken ? `${ordered.join(' ')} ${dateToken.normalized}` : ordered.join(' ');
  return {
    text: canonical,
    applied: canonical !== raw,
    ...(verb ? { verb } : {}),
    ...(preposition ? { preposition } : {}),
    ...(accountHint ? { accountHint } : {}),
    ...(dateToken ? { dateToken } : {}),
  };
};

/**
 * The mutation boundary used by ROUTING: the historical `isClearlyMutating`
 * signal plus a clipped verb. A bare number ("uns 80") is deliberately NOT a
 * mutation signal — treating it as one would invent the intent itself.
 *
 * Plan builders keep this gate (R06 never widens what gets planned); the
 * orchestrator, whose plan is already decided, does not need it.
 */
export const hasMutationIntentSignal = (text: string): boolean => {
  if (isClearlyMutating(text)) return true;
  return VERB_ABBREVIATIONS.some(({ from }) => tokenRegex(from).test(text));
};

const amountProvenanceToken = (text: string, amountCents: number): string | null => {
  for (const token of text.match(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,12}(?:[.,]\d{1,2})?/g) ?? []) {
    try {
      if (parseMoneyToCents(token) === amountCents) return token;
    } catch {
      // Not a parseable literal for this parser; keep looking.
    }
  }
  return null;
};

/**
 * Rewrites only the clipped mutation verbs of a message. Exported so skill
 * selection (the generative path) recognizes the same informal language
 * instead of a second, private copy of the table.
 */
export const expandMutationVerbs = (text: string): string => {
  let expanded = text;
  for (const { from, to } of VERB_ABBREVIATIONS) {
    expanded = replaceToken(expanded, tokenRegex(from, true), (_matched, replacement) => replacement, () => to).text;
  }
  return expanded;
};

/**
 * A06/AC13 (review fix round A07) — the existing detector and copy, exported
 * so the A07 continuation grammars REUSE them instead of keeping a private
 * copy of the same table. Same semantics, one source of truth:
 * - {@link hasNegation} gates the bare date fragment ("não foi ontem");
 * - {@link hasUnsupportedCurrency} gates the value-correction grammar
 *   ("não, 500 dólares" is never read as 500 reais);
 * - {@link ambiguityClarificationText} hands the exact copy A06 already shows
 *   the user, so no third wording exists for the same ambiguity.
 */
export const hasNegation = (text: string): boolean => NEGATION.test(text);

export const hasUnsupportedCurrency = (text: string): boolean => UNSUPPORTED_CURRENCY.test(text);

/**
 * Issue #255 review fix (HIGH) — the follow-up VALUE of a partial draft goes
 * through the SAME approximation guard as a fresh utterance. Exported so the
 * continuation grammar reuses it instead of a private copy of the table.
 */
export const hasApproximateAmount = (text: string): boolean => APPROXIMATION.test(text);

export const ambiguityClarificationText = (ambiguity: SemanticAmbiguity): string =>
  CLARIFICATION[ambiguity].text;

/**
 * B058 + HIGH (review): date material the financial parser cannot resolve
 * must never silently become today — `dateFor` only understands
 * hoje/ontem/anteontem. Evaluated on the post-amount remainder
 * (`parsed.description`), never on the whole sentence: a year embedded in a
 * nominal description ("edição de 2020") keeps flowing as candidate, while
 * date material in adjunct position clarifies — bare year ("2020",
 * "2020 no mercado", any preposition already consumed by the parser),
 * year with an explicit "ano" noun ("no ano 2020", "no ano de 2020"), any 1000–2999 run in
 * year position ("em 1899", never a 0xxx code), month name
 * ("janeiro de 2020", abbreviated "jan de 2020" with year so "mar" alone
 * never matches), numeric date ("dia 12/03"), bare day ("dia 12") or
 * unresolvable relative ("semana passada"), before or after
 * the amount (prefix delimited by the amount token: "Em 2020 ...",
 * "Dia 12/03 ..."). This also covers
 * value==year with explicit currency ("R$ 2020 ... de 2020"): the amount is
 * genuine but the date is still unresolved, so it clarifies instead of
 * stamping today. Relative dates and dateless utterances keep the documented
 * today default (parser-resolved or implicit, never fabricated over explicit
 * material).
 */
const LEADING_YEAR_REF = /^\s*(?:[12]\d{3})\b/;
const MONTH_NAME_REF = /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i;
const EM_YEAR_REF = /\bem\s+([12]\d{3})\b/i;
/** Year with an explicit "ano" noun ("no ano 2020", "no ano de 2020"): temporal, never nominal. */
const ANO_YEAR_REF = /\bano\s+(?:de\s+)?([12]\d{3})\b/i;
/** Abbreviated month with year ("jan de 2020"): same family as full month names. The year is required so "mar" (sea) never matches alone. */
const ABBR_MONTH_YEAR_REF = /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s+de\s+(?:19|20)\d{2}\b/i;
/**
 * Freestanding abbreviated month after "em" ("em jan"): temporal context the
 * parser cannot resolve. Deliberately narrower than the abbreviations above:
 * `mar` (sea) and `dez` (ten) collide with common non-temporal readings, so
 * only unambiguous abbreviations count — "no mar" stays nominal, "em dez
 * parcelas" keeps the today default, and "em março"/"em dezembro" were
 * already covered by MONTH_NAME_REF. Tested on whole/raw text (never on the
 * post-amount remainder alone, whose leading-preposition strip would erase
 * the anchoring "em").
 */
const EM_ABBR_MONTH_REF = /\bem\s+(jan|fev|abr|mai|jun|jul|ago|set|out|nov)\b/i;
/**
 * Ambiguous abbreviated month at turn end ("em mar?", "em dez"): temporal
 * shorthand the parser cannot resolve — clarify WITHOUT deciding which
 * month it was (never map to março/dezembro). End-anchored on purpose:
 * mid-sentence "em dez" is usually a quantity ("em dez parcelas") and
 * "em mar ..." is usually the sea ("em mar aberto") — those keep the today
 * default, as does "no mar" (no "em", never matched). `mar`/`dez` carrying a
 * year stay with ABBR_MONTH_YEAR_REF.
 */
const EM_ABBR_MONTH_AMBIGUOUS_REF = /\bem\s+(mar|dez)\s*[?.!…]*$/i;
/** Relative phrases the parser cannot resolve ("semana passada"). Fold before testing. */
const UNRESOLVED_RELATIVE_REF = /\b(semana|mes|ano)\s+passad[oa]s?\b/i;
/** Bare day without month ("dia 12"): the parser cannot resolve it. */
const BARE_DAY_REF = /\bdia\s+\d{1,2}\b/i;
/** Full ISO date (YYYY-MM-DD): explicit date material, never a bare year. */
const ISO_FULL_DATE_REF = /\b(?:19|20)\d{2}[/-]\d{1,2}[/-]\d{1,2}\b/;
/** ISO year-month (YYYY-MM): year material without a day, before or after the amount. */
const ISO_YEAR_MONTH_REF = /\b(?:19|20)\d{2}[/-]\d{1,2}\b/;
/**
 * Interrogative pronouns: S8-query territory (the router diverts those turns
 * to read/unsupported-year and needs a candidate to divert). A bare "?"
 * alone does NOT qualify — "Gastei 2020 em 2021?" is a declarative mutation
 * carrying date material, not a query.
 */
const INTERROGATIVE_PRONOUN = /\b(?:quanto|quantos|quantas|qual|quais|quando|onde|como|quem|por\s*que|porque)\b/i;

const hasUnresolvedMonthOrNumericDate = (description: string): boolean => {
  if (EXPLICIT_DATE.test(description)) return true;
  if (ABBR_MONTH_YEAR_REF.test(description)) return true;
  if (BARE_DAY_REF.test(description)) return true;
  const folded = description.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return MONTH_NAME_REF.test(folded) || UNRESOLVED_RELATIVE_REF.test(folded);
};

/**
 * S8-exemption remainder check (debugger 2026-10-28, freestanding month):
 * blanks the amount-year everywhere it is covered — in period position
 * (`em/de/ano + year`, `mês de + year`, ISO carrying it) and as the bare
 * value token itself — then reports any temporal material LEFT over (a
 * freestanding month, another year, numeric dates, "semana passada"...).
 * "Quanto gastei em janeiro de 2020?" blanks clean (exemption holds, router
 * diverts to read); "Quanto gastei 2020 em janeiro?" leaves "janeiro"
 * behind (no exemption, the turn clarifies). Operates on folded text so
 * accented months ("março") behave like the detectors above.
 */
const MONTH_ALT = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez';

const blankCoveredAmountYear = (folded: string, amountYear: string): string => {
  const esc = amountYear.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return folded
    .replace(new RegExp(`\\b(?:${MONTH_ALT})\\s+de\\s+${esc}\\b`, 'g'), ' ')
    .replace(new RegExp(`\\bem\\s+${esc}\\b|\\bde\\s+${esc}\\b|\\bano\\s+(?:de\\s+)?${esc}\\b`, 'g'), ' ')
    .replace(new RegExp(`\\b${esc}[/-]\\d{1,2}(?:[/-]\\d{1,2})?\\b|\\b\\d{1,2}[/-]\\d{1,2}[/-]${esc}\\b`, 'g'), ' ')
    .replace(new RegExp(`(?<![\\d.,])${esc}(?![\\d.,])`, 'g'), ' ');
};

const hasLeftoverTemporalMaterial = (folded: string): boolean => {
  if (EXPLICIT_DATE.test(folded) || BARE_DAY_REF.test(folded)) return true;
  if (/\b((?:19|20)\d{2})\b/.test(folded)) return true;
  if (EM_ABBR_MONTH_REF.test(folded) || EM_ABBR_MONTH_AMBIGUOUS_REF.test(folded)) return true;
  return MONTH_NAME_REF.test(folded) || UNRESOLVED_RELATIVE_REF.test(folded);
};

/**
 * Draft follow-up guard (A): absolute-date material the parser cannot
 * resolve, evaluated on the WHOLE follow-up text (amount-less turns never
 * reach the fresh-path remainder/prefix detectors). A completing turn that
 * carries such material ("categoria mercado dia 15") must clarify
 * fail-closed instead of proposing with the stale stored date — the date
 * the user wrote was not understood, so proposing would silently drop it.
 * Relative dates (`hoje`/`ontem`/`anteontem`) are parser-resolved and never
 * count; a bare year alone is ambiguous with a value and stays out (only
 * clearly temporal year shapes — `em NNNN`, `ano [de] NNNN`, ISO year-month
 * — count).
 */
export const hasUnresolvedAbsoluteDate = (text: string): boolean => {
  if (ISO_FULL_DATE_REF.test(text) || EXPLICIT_DATE.test(text)) return true;
  if (BARE_DAY_REF.test(text) || ABBR_MONTH_YEAR_REF.test(text)) return true;
  if (EM_YEAR_REF.test(text) || ANO_YEAR_REF.test(text) || ISO_YEAR_MONTH_REF.test(text)) return true;
  if (EM_ABBR_MONTH_REF.test(text) || EM_ABBR_MONTH_AMBIGUOUS_REF.test(text)) return true;
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return MONTH_NAME_REF.test(folded) || UNRESOLVED_RELATIVE_REF.test(folded);
};

/**
 * Locates the amount token in the text to delimit the prefix (material
 * before the amount). Prefers the token glued to `R$`; otherwise, a bare
 * token with digit boundaries — "20" never matches inside "2020".
 */
const locateAmountToken = (haystack: string, token: string): number => {
  if (!token) return -1;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const glued = new RegExp(`r\\$\\s*${esc}(?![\\d.,])`, 'i').exec(haystack);
  if (glued) return glued.index + glued[0].indexOf(token);
  const bare = new RegExp(`(?<![\\d.,])${esc}(?![\\d.,])`).exec(haystack);
  return bare ? bare.index : haystack.indexOf(token);
};

/**
 * Explicit date before the amount ("Em 2020 ...", "Dia 12/03 ...",
 * "Em janeiro ...", ISO "2020-01-02" / "2020-01"). Only "em + year" counts
 * as a year (temporal); "de + year" after a noun is nominal
 * ("Edição de 2020, ...") and stays out. A full ISO date is explicit;
 * a bare ISO year-month is year material (no day). The same post-amount
 * detectors apply here ("No ano 2020 ...", "Dia 12 ...",
 * "Semana passada ...", "Em jan de 2020 ..."). Relative dates
 * (hoje/ontem) never count — the parser resolves them.
 */
const prefixDateKind = (prefix: string): 'year' | 'explicit' | null => {
  if (EM_YEAR_REF.test(prefix)) return 'year';
  if (ISO_FULL_DATE_REF.test(prefix) || EXPLICIT_DATE.test(prefix)) return 'explicit';
  if (ISO_YEAR_MONTH_REF.test(prefix) || ANO_YEAR_REF.test(prefix)) return 'year';
  if (ABBR_MONTH_YEAR_REF.test(prefix) || BARE_DAY_REF.test(prefix)) return 'explicit';
  const folded = prefix.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return MONTH_NAME_REF.test(folded) || UNRESOLVED_RELATIVE_REF.test(folded) ? 'explicit' : null;
};

/**
 * The single entry point every mutation call site uses instead of calling the
 * parser directly. Returns a schema-validated interpretation; the caller keeps
 * owning proposal, clarification and authorization.
 */
export const interpretMutationUtterance = (
  text: string,
  options: Readonly<{ now?: Date; timeZone?: string }> = {},
): SemanticInterpretation => {
  const raw = text;
  if (!raw.trim()) return Object.freeze({ status: 'not-mutation', raw });

  const ambiguities: SemanticAmbiguity[] = [];
  if (NEGATION.test(raw)) ambiguities.push('negation');
  if (APPROXIMATION.test(raw)) ambiguities.push('approximate_amount');
  if (UNSUPPORTED_CURRENCY.test(raw)) ambiguities.push('unsupported_currency');
  if (hasAmbiguousSeparator(raw)) ambiguities.push('ambiguous_separator');
  if (hasContradictoryDates(raw)) ambiguities.push('contradictory_dates');
  if (ambiguities.length > 0) {
    const missingFields = ambiguities.flatMap((ambiguity) => CLARIFICATION[ambiguity].missingFields);
    const clarification = ambiguities.map((ambiguity) => CLARIFICATION[ambiguity].text).join('\n\n');
    return Object.freeze({ status: 'clarify', raw, ambiguities: Object.freeze(ambiguities), missingFields: Object.freeze([...new Set(missingFields)]), clarification });
  }

  const normalization = normalizeUtterance(raw);
  const parsed = parseFinancialMutation(normalization.applied ? normalization.text : raw, options);
  if (parsed.kind === 'none') {
    // 'negation' is resolved above as an ambiguity; only the legacy reasons reach here.
    const reason = parsed.reason === 'negation' ? 'missing_amount' : parsed.reason;
    // Outside the mutation boundary this is simply not our utterance to read.
    return Object.freeze(hasMutationIntentSignal(raw)
      ? { status: 'unparsed', raw, reason }
      : { status: 'not-mutation', raw });
  }

  // B058 + HIGH: date material the parser cannot resolve clarifies instead
  // of stamping today. Bare year keeps its own copy (names the "ano");
  // month/numeric material uses the generic explicit-date copy. Both ask
  // for the whole operation resent with hoje/ontem/anteontem and promise
  // neither absolute dates nor a persisting draft. The remainder
  // covers post-value material ("... em 2021", bare "2021", "no ano de
  // 2021"); the prefix covers pre-value material ("Em 2020 ...",
  // "Dia 12/03 ..."). The exemption below excuses ONLY the amount-year
  // itself in covered position: every year token in the turn must BE the
  // parsed value, AND nothing else temporal may remain once the covered
  // spans (period + bare value) are blanked. A second, distinct year
  // ("... em 2021 ... 2020 ...") or freestanding month material
  // ("Quanto gastei 2020 em janeiro?") still clarifies — even with an
  // interrogative pronoun, which previously exempted the whole phrase and
  // proposed with today's date. The exemption survives exactly for S8-query
  // shapes ("Quanto gastei em janeiro de 2020?", "... em 2020"), where the
  // router owns the read/unsupported-year diversion and needs a candidate
  // to divert. Declarative turns always run the detectors, so
  // "Gastei 2020 em 2021 ..." clarifies while "Gastei 2020 no mercado"
  // (no other temporal material) stays a candidate.
  if (hasMutationIntentSignal(raw)) {
    const yearTokens = [...raw.matchAll(/\b((?:19|20)\d{2})\b/gu)].map((match) => match[1]!);
    const foldedRaw = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const trapOwns = yearTokens.length > 0
      && yearTokens.every((token) => Number(token) * 100 === parsed.amountCents)
      && !/r\$/i.test(raw)
      && INTERROGATIVE_PRONOUN.test(raw)
      && !hasLeftoverTemporalMaterial(blankCoveredAmountYear(foldedRaw, yearTokens[0]!));
    if (!trapOwns) {
      const amountToken = amountProvenanceToken(raw, parsed.amountCents) ?? '';
      const at = locateAmountToken(raw, amountToken);
      const prefixKind = at >= 0 ? prefixDateKind(raw.slice(0, at)) : null;
      const ambiguity: SemanticAmbiguity | null = LEADING_YEAR_REF.test(parsed.description) || EM_YEAR_REF.test(parsed.description) || ANO_YEAR_REF.test(parsed.description) || prefixKind === 'year'
        ? 'ambiguous_year_date'
        : hasUnresolvedMonthOrNumericDate(parsed.description) || prefixKind === 'explicit' || EM_ABBR_MONTH_REF.test(raw) || EM_ABBR_MONTH_AMBIGUOUS_REF.test(raw)
          ? 'unresolved_explicit_date'
          : null;
      if (ambiguity) {
        return Object.freeze({
          status: 'clarify',
          raw,
          ambiguities: Object.freeze([ambiguity]),
          missingFields: Object.freeze([...CLARIFICATION[ambiguity].missingFields]),
          clarification: CLARIFICATION[ambiguity].text,
        });
      }
    }
  }

  const timeZone = options.timeZone ?? DEFAULT_FINANCIAL_TIME_ZONE;
  const timeZoneSource: 'authorized' | 'default' = options.timeZone ? 'authorized' : 'default';
  const resolutionText = normalization.applied ? normalization.text : raw;
  const amountRaw = amountProvenanceToken(resolutionText, parsed.amountCents) ?? '';
  const steps = [normalization.verb, normalization.preposition, normalization.dateToken, normalization.accountHint].filter(Boolean).length;
  return Object.freeze({
    status: 'candidate',
    raw,
    normalizedText: normalization.applied ? normalization.text : '',
    resolutionText,
    parsed: Object.freeze(parsed),
    provenance: Object.freeze({
      kind: Object.freeze({
        source: normalization.verb ? ('normalized_token' as const) : ('token' as const),
        raw: normalization.verb?.raw ?? '',
        ...(normalization.verb ? { normalized: normalization.verb.normalized } : {}),
        value: parsed.kind,
      }),
      amountCents: Object.freeze({
        source: amountRaw ? ('token' as const) : ('implicit' as const),
        raw: amountRaw,
        value: parsed.amountCents,
      }),
      description: Object.freeze({ source: 'token' as const, raw: parsed.description, value: parsed.description }),
      date: Object.freeze({
        source: normalization.dateToken ? ('normalized_token' as const) : rawDateSource(resolutionText),
        raw: normalization.dateToken?.raw ?? '',
        ...(normalization.dateToken ? { normalized: normalization.dateToken.normalized } : {}),
        value: parsed.date,
        timeZone,
        timeZoneSource,
      }),
      ...(parsed.categoryQuery ? { categoryQuery: Object.freeze({ source: 'token' as const, raw: parsed.categoryQuery, value: parsed.categoryQuery }) } : {}),
      ...(normalization.accountHint
        ? { accountHint: Object.freeze({ source: 'normalized_token' as const, raw: normalization.accountHint.raw, normalized: normalization.accountHint.normalized, value: normalization.accountHint.normalized }) }
        : {}),
    }),
    // Advisory only: R06 forbids turning confidence into an execution threshold.
    confidence: Math.max(0.5, Math.min(0.95, 1 - 0.05 * steps)),
  });
};

const rawDateSource = (text: string): FieldSource => (scan(text, RELATIVE_DATE_WORDS).length > 0 ? 'token' : 'implicit');