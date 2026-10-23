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
 * - the account `kind` is NEVER inferred from the name, with ONE deliberate
 *   exception (itau-kind-bank, operator-authorized): known bank-institution
 *   names listed in `KNOWN_BANK_NAMES` (folded, case-insensitive — currently
 *   only `itau`, matching "Itaú"/"Itau"/"itau") fill `bank`. The original
 *   name spelling is always preserved ("Itaú", never rewritten). Any other
 *   name ("Nubank", "Banco do Brasil", ...) fills NOTHING — the turn asks;
 * - an EXPLICIT kind marker written inline also fills `bank` on a fresh
 *   turn, without inferring from the name: "do tipo bank"/"tipo bank" and a
 *   bare "banco"/"bank" token that carries name content BEFORE it (e.g. "QA
 *   Aurora banco saldo 1000"). A name-leading "Banco ..." ("Banco do
 *   Brasil", "Banco Inter") is NEVER a marker — it stays part of the name;
 * - an EXPLICITLY delimited/named span always wins over structural
 *   inference (round3 shared segmentation): a "banco"/"bank", "tipo",
 *   "carteira", currency, zero or sign cue inside quotes ("Aurora Banco",
 *   "tipo bank", "Reserva USD", "Saldo zero") or in a
 *   `chamada`/`chamado`/`nome`/`de nome` region is part of the NAME — kind
 *   and balance read ONLY the text outside those spans, and the name is
 *   extracted FROM the spans with spelling preserved. Ambiguous use never
 *   infers silently;
 * - the same structural markers are stripped from the extracted name ONLY
 *   in those explicit positions; "Banco" inside a real bank name is never
 *   touched, attached forms are never split mid-word ("Conta360" survives),
 *   and only the syntactic "conta" noun (first mention) is structural —
 *   later mentions name ("Conta 360"). No indiscriminate `banco` strip;
 * - the balance slot requires an EXACT amount in a SUPPORTED currency in
 *   the pertinent region (mirrors `semantic-interpretation.ts`: foreign
 *   currency like USD/€/EUR/dólares, approximation like "aproximadamente"/
 *   "cerca de"/"uns" + number, competing alternatives and negations are
 *   checked BEFORE zero and sign — never converted, never defaulted);
 *   numbers that are not the consumed balance belong to the name
 *   ("Reserva 3");
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

import {
  blankNamedSpans,
  governedNounIsForeign,
  isNegatedVerb,
} from './account-domain-signal.js';

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
 * Explicit creation signal: a creation verb governing an ACCOUNT object. The
 * object is read first (ted-local-account-domain-guards): a foreign entity
 * ("crie parcelamento ...", the "conta a pagar" idiom) or a negated verb
 * ("não crie") is never a creation — quoted/named spans are blanked before
 * the check so `"Conta a Pagar"` and `chamada Categoria ...` keep working.
 * Deliberately narrow otherwise ("paguei a conta de luz" has no verb, and
 * "nubank o saldo atual e 145" has no verb and no "conta"): those turns only
 * ever continue an already-active account draft.
 */
export const hasAccountCreationSignal = (text: string): boolean => {
  const folded = fold(text);
  const blanked = blankNamedSpans(folded);
  if (isNegatedVerb(blanked, CREATION_VERBS)) return false;
  if (governedNounIsForeign(blanked, CREATION_VERBS)) return false;
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

const SHORT_NEGATIONS = [
  'não', 'nao', 'nunca', 'jamais', 'nem',
  'cancela', 'cancelar', 'desisto',
  'não quero', 'nao quero',
];

/** Short refusal/cancel ("não", "cancela") — never a value. */
export const isShortNegative = (text: string): boolean => {
  const folded = fold(text.trim()).replace(new RegExp('[\\s!.]+$', ''), '');
  return text.trim().length <= 32 && SHORT_NEGATIONS.some((a) => folded === a);
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

/**
 * Known bank-institution names (FOLDED forms: lowercase, no diacritics —
 * compare against `fold(text)`). Deliberate, operator-authorized exception
 * to the never-infer-from-the-name rule (itau-kind-bank): these fill
 * `bank` while the extracted name keeps the user's original spelling.
 *
 * Minimal scope: only `itau` in this diff. Extend by appending the folded
 * form here — no re-architecture needed. NEVER add ambiguous names.
 */
const KNOWN_BANK_NAMES = ['itau'];

const KNOWN_BANK_NAME_RE = wordRe(KNOWN_BANK_NAMES);

/**
 * Content words ignored when deciding whether a bare "banco"/"bank" token
 * has real name content BEFORE it: creation verbs, the "conta" noun and
 * filler words. A "banco" with nothing but these before it leads the name
 * ("Banco do Brasil", "Banco Inter") and is never a kind marker.
 */
const PRE_BANCO_IGNORABLE = new Set<string>([
  ...CREATION_VERBS,
  'conta', 'contas',
  'com', 'pra', 'para', 'meu', 'minha', 'por', 'favor', 'quero', 'pode', 'ser',
  // Same short function words as EDGE_FILLERS below (inlined: that const is
  // declared later in module order and must not be referenced here).
  'e', 'eh', 'é', 'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas',
  'de', 'da', 'do', 'das', 'dos', 'no', 'na', 'nos', 'nas',
].map((w) => fold(w)));

/**
 * Words after "banco" that keep it inside a bank name ("Aurora Banco do
 * ...", "Banco do Brasil"): the marker reading applies only when the next
 * word is NOT one of these.
 */
const BANCO_NAME_CONTINUATION = new Set([
  'do', 'da', 'de', 'dos', 'das', 'dum', 'duma', 'no', 'na', 'nos', 'nas',
]);

const normWord = (word: string): string => fold(word).replace(new RegExp('[^a-z0-9]+', 'g'), '');

/**
 * Shared light segmentation (round3 — Debugger ses_ea0607f2affe22HBz4rDjHuzK8):
 * every extractor interprets the SAME name spans instead of the whole text
 * independently. Explicitly named spans — quoted excerpts (`"Aurora Banco"`)
 * and introducer name regions (`chamada`/`chamado`/`nome`/`de nome` up to
 * `saldo`|`tipo`|`R$`|end) — preserve spelling and offsets. Kind markers
 * (`tipo`, `banco`, `carteira`, ...), the balance token (numbers, zero,
 * sign, currency, approximation, negation, alternatives) are read ONLY
 * outside these spans; the name is extracted FROM the spans without global
 * stripping over explicit names. Delimited/named input always wins over
 * structural inference; ambiguous use never infers silently.
 */
const QUOTED_SPAN_SRC = '"([^"]+)"|\'([^\']+)\'|"([^"]+)"|\'([^\']+)\'';

const INTRODUCER_RE_SRC = '\\b(chamada|chamado|de\\s+nome|nome)\\b';

const quotedRanges = (text: string): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  const re = new RegExp(QUOTED_SPAN_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
};

const namedRegion = (text: string): [number, number] | undefined => {
  const intro = new RegExp(INTRODUCER_RE_SRC, 'i').exec(text);
  if (!intro || intro.index === undefined) return undefined;
  const start = intro.index + intro[0].length;
  // Same cue source as everywhere else: the structural `saldo` (unicode
  // boundary — never inside `MeuSaldo`), else the `tipo`/`R$` markers, else
  // end of text.
  const tailRe = new RegExp(`${SALDO_CUE_SRC}|\\btipo\\b|R\\$`, 'giu');
  tailRe.lastIndex = start;
  const m = tailRe.exec(text);
  return [start, m ? m.index : text.length];
};

/** All explicitly named spans (quotes + introducer region), in text order. */
const explicitNameSpans = (text: string): Array<[number, number]> => {
  const spans = quotedRanges(text);
  const region = namedRegion(text);
  if (region && region[1] > region[0]) spans.push(region);
  spans.sort((a, b) => a[0] - b[0]);
  return spans;
};

const isProtectedNameIndex = (text: string, idx: number): boolean =>
  explicitNameSpans(text).some(([s, e]) => idx >= s && idx < e);

/**
 * The text OUTSIDE explicitly named spans (blanked to spaces, length and
 * offsets preserved): every global signal — kind markers, balance numbers,
 * zero words, sign/currency/approximation/negation cues — is read from this.
 */
const outsideNameSpans = (text: string): string => {
  const spans = explicitNameSpans(text);
  if (spans.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const [s, e] of spans) {
    if (s < pos) continue;
    out += text.slice(pos, s) + ' '.repeat(Math.max(0, e - s));
    pos = Math.max(pos, e);
  }
  return out + text.slice(pos);
};

/**
 * The explicit name itself: quoted contents (unquoted, in order), else the
 * introducer region trimmed of edge fillers and a trailing "com". Returns
 * `undefined` when nothing is explicitly named — the normal pipeline owns
 * the turn then.
 */
const explicitNameText = (text: string): string | undefined => {
  const qs = quotedRanges(text);
  if (qs.length > 0) {
    const name = qs
      .map(([s, e]) => text.slice(s, e).replace(new RegExp('^["\'“”‘’\\s]+|["\'“”‘’\\s]+$', 'g'), '').trim())
      .filter(Boolean)
      .join(' ');
    return name ? name : undefined;
  }
  const region = namedRegion(text);
  if (region && region[1] > region[0]) {
    const name = trimEdgeFillers(
      text.slice(region[0], region[1]).replace(new RegExp('\\bcom\\s*$', 'i'), '').trim(),
    );
    return name ? name : undefined;
  }
  return undefined;
};

/** A zero reading explicitly revoked by the user ("não é zero", "não zero"). */
const NEGATED_ZERO_RE = new RegExp('\\bn[aã]o\\s+e?\\s*zer(o|ada|ado)\\b', 'i');

/**
 * THE structural saldo cue (round-final-2, single source of truth): the
 * first `saldo`/`saldos` with a valid UNICODE initial boundary, outside
 * explicitly named spans. Trailing digits attach (`saldo1000`); leading
 * letters/digits never match (`MeuSaldo`, `ressaldo`, quoted `"Saldo"` is
 * skipped via spans). Selection, sign, guards and cut ALL reuse exactly this
 * occurrence — no loose indexOf('saldo') anywhere in this module.
 */
const SALDO_CUE_SRC = '(?<![\\p{L}\\p{N}])saldos?(?![\\p{L}])';

const findSaldoCue = (text: string): number | undefined => {
  const spans = explicitNameSpans(text);
  for (const m of text.matchAll(new RegExp(SALDO_CUE_SRC, 'giu'))) {
    const idx = m.index ?? 0;
    if (!spans.some(([a, b]) => idx >= a && idx < b)) return idx;
  }
  return undefined;
};

/**
 * Balance certainty gates (single source — mirrors `semantic-interpretation.ts`
 * APPROXIMATION / UNSUPPORTED_CURRENCY, same user-visible contract: only an
 * exact amount in reais fills the slot; anything else is asked, never
 * converted or defaulted). All checks run on the ORIGINAL text (blanked):
 * fold is content-comparison only in this module, never a position source,
 * so NFD spellings ("Café\u0301") never shift an offset.
 */
const APPROXIMATION_RE = new RegExp(
  '(?:\\b(?:uns|umas|cerca de|aproximadamente|aproximado|aproximada|mais ou menos|por volta de|em torno de|ao redor de)\\b|~)\\s*(?:r\\$\\s*)?\\d',
  'iu',
);
const UNSUPPORTED_CURRENCY_RE = new RegExp(
  '(?<![rR])\\$|[\u00A3\u20AC\u00A5]|\\b(?:usd|eur|euros?|d[o\u00F3]lares?|dolares?|yen|ienes?)\\b',
  'iu',
);

/**
 * Approximation scoping the value fragment (round-final): the hedge words
 * apply to the amount even without digits ("saldo aproximadamente zero"),
 * before any early zero return.
 */
const FRAGMENT_APPROX_RE = new RegExp(
  '\\b(?:uns|umas|cerca\\s+de|aproximadamente|aproximado|aproximada|mais\\s+ou\\s+menos|por\\s+volta\\s+de|em\\s+torno\\s+de|ao\\s+redor\\s+de)\\b|~',
  'iu',
);

/**
 * Negation scoping the monetary fragment (round-final): `não`/`nunca`/
 * `jamais` at/after the structural cue ("saldo não está zerado", "saldo não
 * negativo de 50") makes the slot conservatively missing — no
 * autocorrection is attempted. A negation BEFORE the cue scopes over
 * something else ("não quero, criar conta ... com saldo 100" still fills).
 * Linguistic negation is not a sign: `negativo`/`-50` WITHOUT `não` still
 * sign (ADR-018).
 */
const MONETARY_NEGATION_RE = new RegExp('\\b(n[aã]o|nunca|jamais)\\b', 'iu');

/** Shared gate: every balance path consults exactly this — never ad-hoc. */
const balanceBlocked = (blanked: string, cueIdx: number | undefined): boolean => {
  if (UNSUPPORTED_CURRENCY_RE.test(blanked) || APPROXIMATION_RE.test(blanked)) return true;
  if (cueIdx === undefined) return false;
  const frag = blanked.slice(cueIdx);
  return FRAGMENT_APPROX_RE.test(frag) || MONETARY_NEGATION_RE.test(frag);
};

/**
 * A digit run counts as an amount only when it stands alone: attached to
 * letters it is name content ("Reserva3", "Conta360"), never a value — in
 * selection AND in the blanket strip. General origin rule, no per-case
 * lexicon: amounts are standalone words.
 */
const isStandaloneNumber = (text: string, idx: number, len: number): boolean => {
  const wordChar = (c: string): boolean => c !== '' && new RegExp('[\\p{L}]', 'u').test(c);
  const before = idx <= 0 ? '' : text[idx - 1] ?? '';
  const after = idx + len >= text.length ? '' : text[idx + len] ?? '';
  return !wordChar(before) && !wordChar(after);
};

/**
 * Explicit structural bank markers (ted-local-account-name): "do tipo
 * bank"/"tipo bank" phrases, or a bare "banco"/"bank" token that (a) has
 * real name content before it and (b) is not followed by a name-continuation
 * ("do"/"da"/"de"/...). Name-leading "Banco ..." never matches, so this is
 * safe on fresh turns — it never infers kind from a bank name. Word
 * boundaries only, so "Nubank" (substring "bank") never matches.
 */
export const hasStructuralBankMarker = (text: string): boolean => {
  const folded = fold(text);
  // "tipo bank" counts only OUTSIDE explicitly named spans: a quoted
  // `"tipo bank"` is a literal name, never a marker.
  if (new RegExp('\\btipo\\s+(banco|bank)\\b').test(outsideNameSpans(folded))) return true;
  const words = [...folded.matchAll(new RegExp('[a-z0-9]+', 'g'))];
  for (let i = 0; i < words.length; i++) {
    const token = words[i]![0];
    if (token !== 'banco' && token !== 'bank') continue;
    // Explicitly named spans win: quoted or `chamada <nome>` regions are
    // never structural markers and never infer kind silently.
    if (isProtectedNameIndex(folded, words[i]!.index ?? 0)) continue;
    if (!words.slice(0, i).some((w) => !PRE_BANCO_IGNORABLE.has(w[0]))) continue;
    const next = words.slice(i + 1).find((w) => w[0].length > 0);
    if (next && BANCO_NAME_CONTINUATION.has(next[0])) continue;
    return true;
  }
  return false;
};

export const parseAccountKind = (text: string, opts?: { allowBare?: boolean }): AccountDraftKind | undefined => {
  const folded = fold(text);
  // Every marker below reads the text OUTSIDE explicitly named spans: quoted
  // (`"Reserva carteira"`) or introducer-named (`chamada ...`) content never
  // fills kind — it is asked instead. Only the spelling outside names counts.
  const visible = ` ${outsideNameSpans(folded)} `;
  if (CASH_KIND_MARKERS.some((m) => visible.includes(m))) return 'cash';
  if (BANK_KIND_MARKERS.some((m) => visible.includes(m))) return 'bank';
  // Explicit structural markers (ted-local-account-name): "tipo bank" or a
  // bare "banco"/"bank" with name content before it (never a name-leading
  // "Banco ...", never the "bank" inside "Nubank"). Safe on fresh turns.
  if (hasStructuralBankMarker(text)) return 'bank';
  // Deliberate exception (itau-kind-bank): a known bank-institution name
  // fills `bank` on ANY turn (fresh or continuation, regardless of
  // `allowBare`) — it is a specific name, not a bare generic answer. Word
  // boundaries only, so "itau" never matches inside another word. Explicit
  // cash markers above keep precedence; a bare name alone NEVER yields cash.
  if (KNOWN_BANK_NAME_RE.test(visible)) return 'bank';
  // Bare answers ("banco") match on WORD BOUNDARIES only: "Nubank" contains
  // "bank" as a substring but is a name, never a kind answer.
  if (opts?.allowBare && wordRe(BARE_BANK_MARKERS).test(visible)) return 'bank';
  // NOTE: the bare word "conta" deliberately fills NOTHING — the kind must
  // be asked, never inferred from the name or from the generic noun.
  return undefined;
};

const ZERO_BALANCE_RE = new RegExp('\\b(zero|zerada|zerado)\\b|\\bsem\\s+saldo\\b', 'i');
const NEGATIVE_CUES_RE = new RegExp('\\b(negativo|negativa|menos|devendo|descoberto)\\b', 'i');

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
 * A validated balance selection: the token AND its offset in the pipeline
 * text (folded/blanked coordinates preserve length, so the offset maps onto
 * the original). Removal uses this validated occurrence — never the first
 * substring ("Reserva1000" keeps its digits when the balance is the later
 * standalone "100").
 */
type BalanceSelection = { token: string; index: number };

/**
 * Picks the balance token the user WROTE in the pertinent region: numbers
 * inside explicitly named spans (`"Reserva 3"`) belong to the NAME and are
 * never balance candidates. Positions come from the ORIGINAL text
 * (span-blanked, length-preserving): fold is content-comparison only in this
 * module, never a position source, so NFD spellings ("Café\u0301") never
 * shift an offset. Origin rule: with a "saldo" clause the token comes ONLY
 * after the single structural cue — never before it, never inside the name
 * (`Reserva3 ... saldo ainda não sei` stays missing); a number attached to
 * the cue itself (`saldo1000`) counts, but one attached to other letters
 * (`Reserva1000`) never does. Without the clause only a standalone number
 * counts. With several candidates after the cue the whole fragment counts,
 * with no arbitrary distance window. The shared certainty gate blocks
 * selection entirely (never converted, never defaulted).
 */
const selectBalanceToken = (text: string): BalanceSelection | undefined => {
  const blanked = outsideNameSpans(text);
  const cueIdx = findSaldoCue(text);
  if (balanceBlocked(blanked, cueIdx)) return undefined;
  const matches = [...blanked.matchAll(NUMBER_TOKEN_RE)]
    .filter((m) => m.index !== undefined)
    .map((m) => ({ token: m[0], index: m.index as number }))
    .filter((m) => new RegExp('[1-9-]').test(m.token) || m.token === '0')
    .filter(
      (m) =>
        isStandaloneNumber(blanked, m.index, m.token.length) ||
        // Attached to the cue itself (`saldo1000`): the cue is the boundary.
        (cueIdx !== undefined && m.index > cueIdx && new RegExp('^saldos?$', 'i').test(blanked.slice(cueIdx, m.index))),
    );
  if (cueIdx !== undefined) {
    const after = matches.filter((m) => m.index > cueIdx);
    return after.length === 1 ? { token: after[0]!.token, index: after[0]!.index } : undefined;
  }
  return matches.length === 1 ? { token: matches[0]!.token, index: matches[0]!.index } : undefined;
};
/**
 * Extracts the opening balance the user WROTE (signed), read ONLY outside
 * explicitly named spans and positioned on the ORIGINAL text (see
 * `selectBalanceToken`). The shared certainty gate runs FIRST (foreign
 * currency, approximation incl. the value fragment, monetary negation —
 * never converted, never autocorrected). Then:
 * 1. an explicit zero ("saldo zero", "zerada", "sem saldo") — unless a
 *    competing number after the cue makes it ambiguous ("saldo zero ou
 *    100"): ask, never invent;
 * 2. the selected number fragment (origin rule: with a "saldo" clause only
 *    after it; other/attached numbers belong to the name and are preserved;
 *    a lone number with no balance cue is NOT taken).
 *
 * A "negativo"/"menos"/leading-dash marker in the balance region (at/after
 * the single structural cue; the whole turn when there is no cue) signs the
 * value — never from the name spans, never from a pre-clause word. Anything
 * else (no number, competing numbers, unparseable) yields `undefined`: ask,
 * never invent, never default.
 */
export const parseAccountBalance = (text: string): { cents: number; explicit: boolean } | undefined => {
  const blanked = outsideNameSpans(text);
  const cueIdx = findSaldoCue(text);
  const hasSaldoCue = cueIdx !== undefined;
  const tokens = [...blanked.matchAll(NUMBER_TOKEN_RE)].map((m) => m[0]).filter((t) => new RegExp('[1-9-]').test(t) || t === '0');
  if (balanceBlocked(blanked, cueIdx)) return undefined;
  if (ZERO_BALANCE_RE.test(blanked) && (hasSaldoCue || tokens.length === 0)) {
    // A negated zero ("não é zero") is a clarification that leaves the slot
    // missing — never an implicit correction to a nearby number.
    if (NEGATED_ZERO_RE.test(blanked)) return undefined;
    // A number after the cue competes with the textual zero ("saldo zero ou
    // 100"): ambiguous — ask instead of defaulting to zero.
    const afterCue = cueIdx === undefined
      ? []
      : [...blanked.matchAll(NUMBER_TOKEN_RE)].filter(
        (m) => m.index !== undefined && m.index > cueIdx && new RegExp('[1-9-]').test(m[0]),
      );
    if (afterCue.length === 0) return { cents: 0, explicit: true };
    return undefined;
  }
  if (tokens.length <= 1 && !hasSaldoCue && !hasAccountCreationSignal(text)) return undefined;
  const selection = selectBalanceToken(text);
  if (selection === undefined) return undefined;
  const cents = centsFromToken(selection.token);
  if (cents === undefined) return undefined;
  // Sign applies ONLY in the balance region (Planner criterion): with a
  // "saldo" cue only at/after the single structural occurrence — a
  // pre-clause word ("Reserva negativo com saldo 50", "MeuSaldo negativo
  // ... com saldo 50") never signs, and name-span content never signs either
  // (it is already blanked). Without the cue the whole turn is the region
  // (unchanged legacy behavior).
  const signRegion = cueIdx !== undefined ? blanked.slice(cueIdx) : blanked;
  if (NEGATIVE_CUES_RE.test(signRegion) && cents > 0) return { cents: -cents, explicit: true };
  return { cents, explicit: true };
};

/**
 * Content words stripped ANYWHERE in the turn: creation verbs, kind
 * markers, balance vocabulary, naming introducers, numbers-adjacent fillers
 * ("com", "para", ...). The "conta" noun is NOT listed here: the syntactic
 * noun (first mention, next to the creation verb) is removed once up front,
 * and later mentions survive unless they are generic — so "Conta 360" keeps
 * its name while "conta no banco" still strips. Short function words
 * (`de`/`do`/`o`/`é`/`e`, ...) are deliberately NOT here: they are trimmed
 * ONLY at the name edges (see EDGE_FILLERS), so interior words survive
 * ("Banco do Brasil" keeps "do").
 */
const STRIP_WORDS = [
  ...CREATION_VERBS,
  'corrente', 'poupanca', 'bancaria', 'no banco', 'do banco', 'num banco',
  'dinheiro', 'especie', 'carteira', 'fisico', 'em maos', 'bolso',
  'moeda fisica',
  'saldo', 'saldos', 'inicial', 'atual', 'atualizado', 'atualizada',
  'com',
  'pra', 'para', 'meu', 'minha', 'por favor', 'quero', 'pode', 'ser',
  'reais', 'real', 'rs',
  'chamada', 'chamado', 'de nome', 'nome',
  'usd', 'eur', 'euro', 'euros', 'dólar', 'dólares', 'dolar', 'dolares',
  'dollar', 'dollars', 'yen', 'iene', 'ienes',
  'aproximadamente', 'aproximado', 'aproximada', 'aprox',
  'cerca de', 'mais ou menos', 'por volta de', 'em torno de', 'ao redor de',
  'zero', 'zerada', 'zerado', 'sem saldo',
  'espécie', 'físico', 'mãos',
];

/**
 * Raw (unescaped) strip fragments: the "conta" noun UNLESS it names
 * ("Conta 360" — conta followed by a number is name content, cf. the
 * Conta360 probe). The syntactic noun itself is removed once up front (see
 * CONTA_NOUN_FIRST_RE), so this guard only protects later mentions.
 */
const STRIP_RAW = ['contas?(?!\\s*\\d)'];

const escapeRe = (word: string): string =>
  word.replace(new RegExp('[.+*?^${}()|[\\]\\\\]', 'g'), '\\$&');

const STRIP_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...STRIP_WORDS].sort((a, b) => b.length - a.length).map(escapeRe).concat(STRIP_RAW).join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

/**
 * The syntactic "conta" noun: the FIRST mention (next to the creation verb
 * in fresh turns, or the lone noun in answers like "conta no banco").
 * Removed once up front — later mentions are name candidates ("Conta 360").
 * Letter+digit boundaries so attached forms ("Conta360") are never split.
 */
const CONTA_NOUN_FIRST_RE = new RegExp('(?<![\\p{L}\\p{N}])contas?(?![\\p{L}\\p{N}])', 'i');
const NUM_RE = new RegExp('-?\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|-?\\d{1,12}(?:[.,]\\d{1,2})?', 'g');
const PUNCT_RE = new RegExp('[\\s,.;:!?|/\\\\\\-_()\"$]+', 'g');

/**
 * "tipo" phrases: structural kind vocabulary ("do tipo bank", "tipo
 * corrente"), never an account name. Stripped as whole phrases BEFORE the
 * generic strip so "reserva do tipo corrente" leaves "reserva". A bare
 * "banco"/"bank" is NOT listed here — it is removed only when structural
 * (see `stripStructuralBareBank`), so "Banco do Brasil" survives intact.
 */
const TIPO_PHRASE_RES = [
  new RegExp('\\bdo\\s+tipo\\s+(banco|bank)\\b', 'gi'),
  new RegExp('\\btipo\\s+(banco|bank)\\b', 'gi'),
  new RegExp('\\bdo\\s+tipo\\b', 'gi'),
  new RegExp('\\btipo\\b', 'gi'),
];

/**
 * Removes ONLY structural bare "banco"/"bank" tokens: same positions where
 * `hasStructuralBankMarker` fills kind (name content before, no
 * name-continuation after). Name-leading "Banco ..." ("Banco do Brasil",
 * "Banco Inter") and the "bank" inside "Nubank" are preserved. Operates on
 * the original text so the surviving name keeps the user's casing.
 */
const stripStructuralBareBank = (text: string): string => {
  const tokens = text.split(new RegExp('(\\s+)'));
  const wordIdx: number[] = [];
  const words: string[] = [];
  const offsets: number[] = [];
  let pos = 0;
  tokens.forEach((t, i) => {
    if (i % 2 === 0) {
      wordIdx.push(i);
      words.push(normWord(t));
      offsets.push(pos);
    }
    pos += t.length;
  });
  const drop = new Set<number>();
  words.forEach((w, i) => {
    if (w !== 'banco' && w !== 'bank') return;
    // Explicitly named spans win: quoted or `chamada <nome>` regions are
    // never structural markers and are never stripped.
    if (isProtectedNameIndex(text, offsets[i] ?? 0)) return;
    if (!words.slice(0, i).some((b) => b.length > 0 && !PRE_BANCO_IGNORABLE.has(b))) return;
    const next = words.slice(i + 1).find((b) => b.length > 0);
    if (next && BANCO_NAME_CONTINUATION.has(next)) return;
    drop.add(i);
  });
  if (drop.size === 0) return text;
  const dropTokens = new Set([...drop].map((i) => wordIdx[i]));
  return tokens.map((t, i) => (dropTokens.has(i) ? ' ' : t)).join('');
};

/**
 * Foreign-currency / approximation amounts (round2): "USD 100", "100
 * dólares", "€50", "aproximadamente 100", "uns 100". Removed as a UNIT from
 * the name pipeline — the currency/hedge word must not leak into the name,
 * and the number is never the balance (selection is blocked, never
 * converted). Vocabulary mirrors `semantic-interpretation.ts`.
 */
const NUM_PAT = '-?\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|-?\\d{1,12}(?:[.,]\\d{1,2})?';

const FOREIGN_APPROX_AMOUNT_RES = [
  new RegExp(`\\b(?:usd|eur|euros?|d[o\u00F3]lares?|dolares?|yen|ienes?|dollars?)\\s*(${NUM_PAT})`, 'gi'),
  new RegExp(`(${NUM_PAT})\\s*(?:usd|eur|euros?|d[o\u00F3]lares?|dolares?|yen|ienes?|dollars?)\\b`, 'gi'),
  new RegExp(`(?<![rR])\\$\\s*(${NUM_PAT})`, 'gi'),
  new RegExp(`(${NUM_PAT})\\s*[$\u20AC\u00A3\u00A5]`, 'gi'),
  new RegExp(`[\u20AC\u00A3\u00A5]\\s*(${NUM_PAT})`, 'gi'),
  new RegExp(
    `\\b(?:uns|umas|cerca\\s+de|aproximadamente|aproximado|aproximada|mais\\s+ou\\s+menos|por\\s+volta\\s+de|em\\s+torno\\s+de|ao\\s+redor\\s+de)\\s*(?:r\\$\\s*)?(${NUM_PAT})`,
    'gi',
  ),
  new RegExp(`~\\s*(?:r\\$\\s*)?(${NUM_PAT})`, 'gi'),
];

/**
 * Numbers that are NOT the consumed balance belong to the name and must be
 * preserved (never blanket-stripped): a textual zero ("saldo zero" consumes
 * no digits, so "Reserva 3" keeps its "3"), or a blocked foreign/approx
 * amount (its span is removed above; the rest stays).
 */
const shouldPreserveNumbers = (text: string): boolean => {
  const blanked = outsideNameSpans(text);
  if (findSaldoCue(text) !== undefined && ZERO_BALANCE_RE.test(blanked)) return true;
  return balanceBlocked(blanked, findSaldoCue(text));
};
/**
 * Removes the consumed balance number at its VALIDATED pipeline occurrence
 * (offset from the selector on the still-unmodified padded text) — never the
 * first substring: "Reserva1000 ... 100" keeps "Reserva1000" because only
 * the validated "100" is removed. If the occurrence is not proven, preserves
 * instead of consuming a wrong digit. Standalone blanket stripping lives in
 * `stripStandaloneNumbers` and runs only after the cue cut, so pre-cue
 * offsets are never shifted.
 */
const removeValidatedToken = (rest: string, selection: BalanceSelection): string => {
  const at = selection.index + 1;
  if (rest.slice(at, at + selection.token.length) === selection.token) {
    return rest.slice(0, at) + ' ' + rest.slice(at + selection.token.length);
  }
  return rest;
};

/**
 * Standalone-only blanket strip for ambiguous turns (no balance token
 * selected, numbers not preserved): a digit inside a word ("Reserva3",
 * "Conta360") is name content and is never consumed — the name stays clean
 * while the balance is asked.
 */
const stripStandaloneNumbers = (rest: string): string => {
  let out = '';
  let pos = 0;
  for (const m of rest.matchAll(new RegExp(NUM_RE.source, 'g'))) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (isStandaloneNumber(rest, s, m[0].length)) {
      out += rest.slice(pos, s) + ' ';
      pos = e;
    }
  }
  return out + rest.slice(pos);
};

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
 * Span-aware replacement: applies `re` only OUTSIDE explicitly named spans,
 * so a quoted `"tipo bank"` or a `chamada ...` name never loses words to
 * structural stripping. With no spans present this is a plain replace.
 * `firstOnly` replaces just the first outside-span match (the syntactic
 * "conta" noun).
 */
const replaceOutsideSpans = (text: string, re: RegExp, replacement: string, firstOnly = false): string => {
  const spans = explicitNameSpans(text);
  const fresh = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let out = '';
  let pos = 0;
  let done = false;
  let m: RegExpExecArray | null;
  while ((m = fresh.exec(text)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (e === s) {
      fresh.lastIndex += 1;
      continue;
    }
    if (!done && !spans.some(([a, b]) => s < b && e > a)) {
      out += text.slice(pos, s) + replacement;
      pos = e;
      if (firstOnly) done = true;
    }
    if (done) break;
  }
  return out + text.slice(pos);
};

/**
 * The human name fragment. Explicitly named spans win outright (quoted or
 * `chamada/chamado/nome/de nome` — spelling preserved, no global stripping
 * over the explicit name). Otherwise: whatever survives after stripping the
 * syntactic "conta" noun once, kind markers, balance vocabulary, the
 * consumed balance number and fillers. "Conta 360" keeps its name (only the
 * noun-adjacent first "conta" is structural); attached forms ("Conta360")
 * are never split mid-word. Confirmations, short affirmatives and short
 * negations ("sim", "pode criar", "não", "cancela") are never names. Empty
 * (or filler-only) remainder = no name: ask, never invent.
 */
export const extractAccountName = (text: string): string | undefined => {
  if (isShortAffirmative(text) || isConfirmCreateText(text) || isShortNegative(text)) return undefined;
  const explicit = explicitNameText(text);
  if (explicit !== undefined) return explicit;
  // Strip on the ORIGINAL text (case-insensitive patterns) so the surviving
  // name keeps the user's casing ("Nubank", not "nubank"). Order is
  // offset-safe: the validated token is removed first (unmodified text, at
  // or after the cue), then the cue cut, and only afterwards anything that
  // shifts offsets — never the reverse.
  let rest = ` ${text} `;
  const selection = selectBalanceToken(text);
  if (selection !== undefined) rest = removeValidatedToken(rest, selection);
  const cueIdx = findSaldoCue(text);
  const balanceMissing = parseAccountBalance(text) === undefined;
  // The name aligns with the balance RESULT: when the balance is missing but
  // the single structural cue exists, the clause is cut even if inconclusive
  // — the hedge after it is not name content — without zeroing a valid
  // pre-cue name. The cue is the shared occurrence (never a "saldo" inside
  // "MeuSaldo"). Resolvable turns keep the full-text path.
  if (balanceMissing && cueIdx !== undefined) {
    rest = rest.slice(0, cueIdx + 1);
  } else if (selection === undefined && !shouldPreserveNumbers(text)) {
    rest = stripStandaloneNumbers(rest);
  }
  // Sign words ("negativo", "menos") strip ONLY in the balance region:
  // with a cue, at/after the shared occurrence — before it they are name
  // content ("Reserva negativo com saldo 50" keeps its name; the sign itself
  // applies only in the region per the Planner criterion). Without a cue
  // the legacy whole-text strip applies. A cut turn has no region left.
  if (!balanceMissing && cueIdx !== undefined) {
    const c = cueIdx + 1;
    rest = rest.slice(0, c) + rest.slice(c).replace(new RegExp('\\b(negativo|negativa|menos)\\b', 'gi'), ' ');
  } else if (cueIdx === undefined) {
    rest = rest.replace(new RegExp('\\b(negativo|negativa|menos)\\b', 'gi'), ' ');
  }
  rest = replaceOutsideSpans(rest, CONTA_NOUN_FIRST_RE, ' ', true);
  for (const re of TIPO_PHRASE_RES) rest = replaceOutsideSpans(rest, re, ' ');
  for (const re of FOREIGN_APPROX_AMOUNT_RES) rest = replaceOutsideSpans(rest, re, ' ');
  rest = stripStructuralBareBank(rest);
  rest = rest.replace(STRIP_RE, ' ');
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
