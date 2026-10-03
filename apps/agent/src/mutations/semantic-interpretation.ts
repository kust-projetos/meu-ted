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
  | 'contradictory_dates';

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