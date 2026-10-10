import type { EvidenceEnvelope } from './evidence-envelope.js';

type GroundingResult = Readonly<{
  valid: boolean;
  unsupportedClaims: readonly string[];
  /**
   * V1-GROUND-OBSERVABILITY: per-axis counts of the rejected claims. NUMBERS
   * only — never the claim text, never a figure, never a name — so the
   * existing sanitized `agent.grounding.rejected` event can say which axis
   * failed without carrying any financial payload.
   */
  counts: Readonly<{ money: number; percent: number; date: number; name: number }>;
}>;

const fold = (value: string): string =>
  (value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * V1-GROUND-CURRENCY — a detected money figure carries the currency it was
 * marked with, and the currencies never substitute for each other: a BRL
 * figure is never grounded by USD evidence (nor the reverse). `null` is an
 * UNMARKED figure, and it resolves to the workspace currency (BRL) on both
 * sides, so a bare `999,00` in financial context still matches the API's
 * cents fields while `US$ 999,00` does not.
 */
type CurrencyTag = 'BRL' | 'USD' | 'UNKNOWN';
const currencyOf = (value: CurrencyTag | null): CurrencyTag => value ?? 'BRL';

/**
 * A detected money figure: the amount in CENTS (the unit the API read contract
 * uses for every money field) plus the currency it was marked with. SIGNED:
 * a negative figure stays negative, so a positive value can never ground it
 * (and the reverse). The `reais` value is derived on demand — a raw tool
 * number is never eligible for it, because only a contract-declared money
 * field can hold money (see V1-GROUND-SCHEMA below).
 *
 * EXACT integer arithmetic (bigint): the G-B analytics contract ships
 * aggregates past 2^53 — bigger than the exactly-representable integer range
 * of a double — as decimal strings. Parsing those (or a BR-formatted claim
 * of the same magnitude) into `number` would round the low-order cents and
 * make both sides wrong in DIFFERENT ways; bigint keeps every digit and the
 * sign, so the comparison is exact.
 */
type MoneyClaim = Readonly<{ cents: bigint; currency: CurrencyTag | null }>;

/**
 * Parses a digit run with BR/US thousand/decimal separators into cents.
 * The LAST separator carrying 1-2 trailing digits is the decimals; every
 * other separator is thousands. Trailing stray separators (sentence
 * punctuation) are trimmed first. Returns null when no digit is present.
 * The returned value is the MAGNITUDE — the sign lives in the captured text
 * (see `isNegativeFigure`).
 *
 * EXACT (bigint): an aggregate past 2^53 must survive verbatim. `Number`
 * would round the low-order cents, so both a huge claim and its exact-string
 * evidence would be wrong — and wrong in different directions.
 */
const flexibleToCents = (raw: string): bigint | null => {
  // Trailing stray characters are punctuation/accounting, not digits: the
  // sentence's `.`, a stray separator and the accounting trailing `-` all go.
  const s = raw.replace(/[.,\s−-]+$/, '').replace(/^\s+/, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart = s;
  let dec = '';
  if (lastComma > lastDot && /,\d{1,2}$/.test(s)) {
    intPart = s.slice(0, lastComma);
    dec = s.slice(lastComma + 1);
  } else if (lastDot > lastComma && /\.\d{1,2}$/.test(s)) {
    intPart = s.slice(0, lastDot);
    dec = s.slice(lastDot + 1);
  }
  const intDigits = intPart.replace(/\D/g, '');
  if (intDigits.length === 0) return null;
  return BigInt(intDigits) * 100n + BigInt(`${dec}00`.slice(0, 2));
};

/**
 * V1-GROUND-SIGN — a leading OR trailing minus makes the figure negative
 * (`-R$ 42,50`, `R$ -42,50`, and the accounting spelling `42,50-` all reach
 * the capture group, which therefore carries the sign). The sign is preserved
 * end to end on both sides: a backend `balanceCents: -4250` grounds
 * "-R$ 42,50" and nothing else, so a positive figure can never be used to
 * launder a negative claim (nor a negative value to fake a positive one).
 *
 * `signSource` is the FULL match, not only the digit group, so a minus that
 * sits before the marker (`-R$ 42,50`) still counts.
 */
const isNegativeFigure = (raw: string): boolean => /^\s*[−-]/.test(raw) || /[−-]\s*$/.test(raw);

const signedCents = (raw: string, signSource: string = raw): bigint | null => {
  const cents = flexibleToCents(raw);
  if (cents === null) return null;
  // The sign may sit before the marker (`-R$ 42,50`), inside the figure group
  // (`R$ -42,50`), or trail the figure in accounting notation (`42,50-`).
  return isNegativeFigure(raw) || isNegativeFigure(signSource) ? -cents : cents;
};

const toClaim = (raw: string, currency: CurrencyTag | null, signSource: string = raw): MoneyClaim | null => {
  const cents = signedCents(raw, signSource);
  return cents === null ? null : { cents, currency };
};

/**
 * V1-GROUND-UNITS — a figure carrying a UNIT is a quantity, never money:
 * `12,50 kg`, `12,50 km`, `12,50 unidades`, `12,50 toneladas` and `12,50%`
 * are not currency amounts. The guard is SHARED by claims and support, so a
 * unit-qualified figure can neither be flagged as a money claim nor ground
 * one — otherwise "carga de 12,50 kg" inside trusted data would ground a
 * "R$ 12,50" claim.
 */
const UNIT_TAIL =
  /^\s*(?:%|kg\b|km\b|quilograma\w*|quilos?\b|tonelada\w*|tonnes?\b|\btons?\b|\bg\b|mg\b|ml\b|litro\w*|\bl\b|metro\w*|\bm\b|cm\b|mm\b|un\b|unid\b|unidade\w*|pct\b|percentual|pontos?\b|pts\b|dias?\b|meses\b|\bmes\b|anos?\b|horas?\b|minutos?\b|vezes\b|\bx\b|kwh\b|\bkw\b)/i;

const hasUnitTail = (after: string): boolean => UNIT_TAIL.test(after);

/**
 * V1-GROUND-UNKNOWN-UNIT: the CLOSED `UNIT_TAIL` only knew the common measure
 * words, so an UNRECOGNISED unit (`12,50 hectares`, an arbitrary
 * `12,50 widgets`) still read as a bare money claim and could be grounded by
 * an API `*cents` value of the same magnitude — publishing a quantity as
 * reais. The fix does NOT try to enumerate every unit in every language: on
 * the bare-decimal path a figure counts as money only when the word that
 * IMMEDIATELY follows it (whitespace aside) is a NEUTRAL CONTINUATION. That
 * set is the closed pt-BR FUNCTION-word class (prepositions/articles/
 * conjunctions/connectors/pronouns) plus the copular and financial verbs that
 * open a normal predicate phrase — the words that make "… 999,00 na Conta
 * principal" or "… 42,50 foi confirmado" read as money. Any OTHER immediate
 * alphabetic word (a measure noun, known or invented) disqualifies the figure,
 * so `hectares`/`widgets` behave like `kg` without being hardcoded.
 *
 * The residual is deliberate and bounded by the bare path itself (a financial
 * keyword within ±30 chars AND a BR-decimal shape): a rare verb not listed
 * here after a bare money figure is conservatively read as a unit. Known
 * units and `%` keep their own guard (`UNIT_TAIL`); the explicit markers
 * (`R$`, `reais`, ISO codes) never reach this path — they are matched by
 * `markedMoney` regardless.
 */
const NEUTRAL_CONTINUATION: ReadonlySet<string> = new Set([
  // prepositions, contractions and locatives
  'a','ante','apos','ate','com','contra','de','desde','em','entre','para','per','perante','por','sem','sob','sobre',
  'ao','aos','aum','num','numa','na','no','nas','nos','do','da','dos','das','dum','duma','pro','pra','pelo','pela','pelos','pelas',
  'nesta','neste','nestas','nestes','nessa','nesse','nessas','nesses','desta','deste','destas','destes','dessa','desse','dessas','desses',
  'naquele','naquela','naqueles','naquelas','disto','nisso','disso','nisto',
  // articles, determiners and pronouns
  'o','as','os','um','uma','uns','umas','meu','minha','seu','sua','nosso','nossa','este','esta','esse','essa','aquele','aquela','isto','isso','tudo','nada','voce','ele','ela','eles','elas','voces',
  // conjunctions and connectors
  'e','ou','mas','porem','contudo','todavia','entretanto','logo','portanto','pois','porque','que','como','quando','enquanto','se','caso','ja','ainda','tambem','apenas','somente','mesmo','conforme','segundo','onde','cujo','cuja','aonde','entao','assim',
  // copular / financial verbs that open a normal predicate on the figure
  'era','eram','foi','foram','seja','sendo','sido','sao','sera','serao','estava','estavam','esta','estao','estara','ficou','ficaram','fica','ficam',
  'custou','custa','custam','vale','valeu','valem','valia','totaliza','totalizam','totalizou','representa','representam',
  'veio','vieram','vem','rendeu','renderam','rende','rendem','subiu','subiram','caiu','cairam','entrou','entraram','saiu','sairam',
  'passou','passaram','chegou','chegaram','apareceu','consta','constam','tem','tinha','tinham','houve','havia','gastou','pagou','recebeu','movimentou','gerou','gira','girou',
  'confirmado','confirmada','processado','processada','quitado','liquidado','pago','paga',
  // the spelled money word (normally consumed by markedMoney, kept neutral so
  // the bare path never misreads it as a unit either)
  'real','reais',
]);

/** IMEDIATE (whitespace aside) alphabetic token after a figure, folded; null when none. */
const immediateWord = (after: string): string | null => {
  const token = /^\s*([A-Za-zÀ-ÿ]+)/.exec(after);
  return token === null ? null : fold(token[1]!);
};

/**
 * V1-GROUND-PAYMENT-TAIL: `PIX`/`TED`/`DOC` are PAYMENT METHODS, never units
 * of measure. A figure that follows one (`42,50 PIX`) is a money amount — the
 * acronym says how it was paid, not what the figure counts — so it must stay
 * a claim (groundable by matching cents, never free) instead of being read as
 * a quantity by the unknown-unit guard. The same closed set keeps these
 * acronyms out of the currency-code rules (see `KNOWN_CURRENCY_CODES`).
 */
const PAYMENT_TAIL: ReadonlySet<string> = new Set(['pix', 'ted', 'doc']);

/** True when an UNRECOGNISED immediate word — not a neutral continuation, and not a payment method — follows (a unit of measure). */
const hasUnknownUnitTail = (after: string): boolean => {
  const word = immediateWord(after);
  return word !== null && !PAYMENT_TAIL.has(word) && !NEUTRAL_CONTINUATION.has(word);
};

/**
 * Explicitly marked money: needs NO surrounding context, so it is ALWAYS
 * a financial claim. Covers the canonical `R$ 1.234,56`, the integer
 * `R$ 999`/`R$999`, `999 reais`/`999,00 reais`/`1.234,56 reais` (and the
 * `1 real` singular), `US$`/`$` with digits (BR or US separators), the
 * `BRL`/`USD` ISO codes on either side of the figure, and the renderer
 * shape `42.50 R$`/`42.50 BRL` (digits before the symbol — the vision/PDF
 * renderers print `<amount> <currency>`). The bare-`$` lookbehind keeps the
 * `$` of `R$`/`US$` from double-counting.
 *
 * V1-GROUND-CURRENCY: every capture is signed (V1-GROUND-SIGN) and carries
 * the marker that produced it. A currency the workspace does NOT serve
 * (a closed list of other ISO codes, the `€`/`£`/`¥` family) and an
 * explicitly UNREADABLE one (`unknown`/`ambiguous`, the honest vision
 * answer) are tagged `UNKNOWN`: they can never ground a BRL figure, and
 * they are never support at all — no implicit conversion or substitution.
 *
 * The label is what a REJECTED claim reports back to the correction prompt,
 * so it names the marker the reply actually used instead of pretending the
 * figure was reais.
 */
type MoneyMatch = Readonly<{ claim: MoneyClaim; index: number; length: number; label: string }>;

/**
 * Records one detected figure. The sign is read from the WHOLE match (a minus
 * written before the marker, `-R$ 42,50`, sits outside the digit group) and
 * `label` is either a literal marker name or the index of the group holding
 * the marker that produced the match.
 */
const pushMatch = (
  found: MoneyMatch[],
  raw: string | undefined,
  currency: CurrencyTag | null,
  label: string | number,
  index: number,
  match: RegExpMatchArray,
): void => {
  if (raw === undefined) return;
  const claim = toClaim(raw, currency, match[0]!);
  if (!claim) return;
  found.push({ claim, index, length: match[0]!.length, label: typeof label === 'number' ? (match[label] ?? label.toString()) : label });
};

/**
 * Optional sign (leading, or accounting-trailing) + BR/US digit run.
 *
 * V1-GROUND-SIGN-DETACHED: the sign may sit against the digits (`-42,50`,
 * `42,50-`) or be DETACHED from them by whitespace (`R$ - 42,50`,
 * `BDT - 42,50`). The detached spelling reaches every marked rule and keeps
 * the sign; before this, a spaced minus fell outside the capture, the marked
 * rule missed, and the bare rule read the digits as a POSITIVE figure — which
 * both laundered the sign of a negative claim and let an unknown-currency
 * figure (`BDT - 42,50`) leak through as implicit BRL.
 */
const FIGURE = '[-−]?\\s*[\\d.,]*\\d[-−]?';

/**
 * The BARE (unmarked) figure the CLAIMS side uses: a BR-decimal amount
 * (`42,50`, `1.234,56`), signed. The lookbehind replaces the old leading
 * `\b` so a leading minus is allowed (between a space and `-` there is no
 * word boundary); the trailing anchor still refuses a figure embedded in a
 * LONGER number (`1.234,567`), while a sentence-ending period after `42,50.`
 * stays allowed, exactly as the old `\b` did. An integer without decimals
 * stays OUT: `3 parcelas` is a count, and the marked rules (`999 reais`,
 * `R$ 999`) are the shapes that carry money.
 *
 * V1-GROUND-SIGN-DETACHED: the leading sign may sit against the digits
 * (`-42,50`) or be DETACHED from them by whitespace (`- 42,50`, `− 42,50`),
 * exactly as the marked `FIGURE` allows. The whitespace is part of the
 * capture, so the sign reaches `isNegativeFigure` and the claim stays
 * negative: before this, a spaced minus fell outside the capture, the digits
 * alone were read as a POSITIVE figure, and a positive `*cents` value
 * grounded a negative claim (sign laundering through the bare path).
 *
 * CLAIMS ONLY, and only inside clear financial context (`bareMoney`). The
 * admitted document axis no longer shares it — evidence must be explicitly
 * marked (V1-GROUND-ATTRIBUTION-MARKER, see `moneyInString`), because an
 * unmarked decimal in a block is a quantity or an unidentified currency,
 * never implicit BRL.
 */
const BARE_FIGURE = `(?<![\\dA-Za-z.,])(${'[-−]?\\s*[\\d.,]*\\d,\\d{2}[-−]?'})(?!\\d)`;

/**
 * V1-GROUND-MARKER-CONFLICT: two markers that DISAGREE about the currency of
 * the SAME figure invalidate the figure. `BDT 42,50 reais` is matched twice —
 * once by the unknown-code prefix rule (`BDT`, UNKNOWN) and once by the
 * `reais` suffix rule (BRL) — and keeping the BRL half would let a figure the
 * text itself calls an unidentified currency ground a reais claim. The figure's
 * currency is therefore UNREADABLE: it collapses into ONE `UNKNOWN` match
 * spanning both markers, which never grounds BRL evidence (claim axis) and is
 * dropped as support (document axis, `moneyInString`). Markers that AGREE
 * (`R$ 42,50 reais`) are not a conflict and keep their ordinary de-duplication
 * downstream.
 */
const resolveMarkerConflicts = (found: MoneyMatch[]): MoneyMatch[] => {
  const kept: MoneyMatch[] = [];
  for (const match of found) {
    const clashIndex = kept.findIndex(
      (other) =>
        match.index < other.index + other.length &&
        other.index < match.index + match.length &&
        currencyOf(other.claim.currency) !== currencyOf(match.claim.currency),
    );
    if (clashIndex === -1) {
      kept.push(match);
      continue;
    }
    const clash = kept[clashIndex]!;
    const start = Math.min(clash.index, match.index);
    const end = Math.max(clash.index + clash.length, match.index + match.length);
    // The label names the marker the reply must distrust: an UNKNOWN currency
    // code whenever the cluster carries one, so the correction prompt never
    // reports a contradicted figure as plain reais (which would invite the
    // model to drop the contradicting code and keep the figure grounded).
    // With no unknown marker (e.g. US$ … reais) the earliest one wins.
    const label =
      [clash, match].find((entry) => currencyOf(entry.claim.currency) === 'UNKNOWN')?.label ??
      (clash.index <= match.index ? clash.label : match.label);
    kept.splice(clashIndex, 1, {
      claim: { cents: clash.claim.cents, currency: 'UNKNOWN' },
      index: start,
      length: end - start,
      label,
    });
  }
  return kept;
};

const markedMoney = (text: string): MoneyMatch[] => {
  const found: MoneyMatch[] = [];
  const collectAll = (re: RegExp, currency: CurrencyTag | null, label: string | number, group: number): void => {
    for (const match of text.matchAll(re)) pushMatch(found, match[group], currency, label, match.index ?? 0, match);
  };
  const MARKED: ReadonlyArray<readonly [RegExp, CurrencyTag, string | number, number]> = [
    [new RegExp(`([-−]?\\s*R\\$\\s*(${FIGURE}))`, 'g'), 'BRL', 'R$', 2],
    [new RegExp(`((${FIGURE})\\s*R\\$)`, 'g'), 'BRL', 'R$', 2],
    [new RegExp(`([-−]?\\s*US\\$\\s*(${FIGURE}))`, 'gi'), 'USD', 'US$', 2],
    [new RegExp(`((${FIGURE})\\s*US\\$)`, 'gi'), 'USD', 'US$', 2],
    [new RegExp(`([-−]?\\s*(?<![A-Za-z$])\\$\\s*(${FIGURE}))`, 'g'), 'USD', 'US$', 2],
    [new RegExp(`((${FIGURE})\\s*(?:real|reais)\\b)`, 'gi'), 'BRL', 'R$', 2],
    [new RegExp(`([-−]?\\s*\\bBRL\\s*(${FIGURE}))`, 'gi'), 'BRL', 'BRL', 2],
    [new RegExp(`([-−]?\\s*\\bUSD\\s*(${FIGURE}))`, 'gi'), 'USD', 'USD', 2],
    [new RegExp(`((${FIGURE})\\s*BRL\\b)`, 'gi'), 'BRL', 'BRL', 2],
    [new RegExp(`((${FIGURE})\\s*USD\\b)`, 'gi'), 'USD', 'USD', 2],
  ];
  for (const [re, currency, label, group] of MARKED) collectAll(re, currency, label, group);
  // V1-GROUND-CURRENCY: currencies the workspace does not serve, and a
  // currency the reader could not identify. The list of foreign codes is
  // CLOSED on purpose — an open `[A-Z]{3}` rule would also eat payment
  // methods such as `PIX`/`TED` and silently unmark a genuine reais figure.
  const FOREIGN = 'EUR|GBP|JPY|CHF|CAD|AUD|NZD|CNY|ARS|CLP|COP|MXN|UYU|PYG|PEN|BOL|VES|RUB|INR|KRW|TRY|ZAR|SEK|NOK|DKK|PLN|ILS|SGD|HKD|AED|TWD|MOP|CZK|HUF|RON|IDR|MYR|THB|VND|PHP';
  const UNREADABLE = 'unknown|ambiguous|desconhecid\\w*|n[ãa]o identificad\\w*|indefinid\\w*|ileg\\w*';
  // V1-GROUND-CURRENCY-UNKNOWN: closing the foreign list left a leak on the
  // other side. An all-caps 3-letter code FLANKING a figure that is neither a
  // known currency (BRL/USD/foreign) nor a known PAYMENT method (PIX/TED/DOC)
  // is an UNRECOGNISED currency (`BDT 42,50`): it is tagged UNKNOWN so it can
  // never ground a BRL figure, instead of leaking through the bare-decimal
  // rule as implicit reais. The tag is matched CASE-SENSITIVE (uppercase —
  // an ISO code and the payment acronyms are written uppercase); a lowercase
  // 3-letter token is an ordinary word, not a currency. The lookahead also
  // keeps `PIX`/`TED`/`DOC` from being read as currencies, so a reais figure
  // that merely follows one stays a grounded bare BRL claim.
  const PAYMENT_MARKERS = 'PIX|TED|DOC';
  const KNOWN_CURRENCY_CODES = `(?:${FOREIGN}|BRL|USD|${PAYMENT_MARKERS})`;
  const OTHER_MARKED: ReadonlyArray<readonly [RegExp, string | number, number]> = [
    [new RegExp(`([-−]?\\s*\\b(${FOREIGN})\\s*(${FIGURE}))`, 'gi'), 2, 3],
    [new RegExp(`(((${FIGURE})\\s*\\b(${FOREIGN})\\b))`, 'gi'), 3, 2],
    [new RegExp(`([-−]?\\s*([€£¥₤₽₩₹])\\s*(${FIGURE}))`, 'g'), 2, 3],
    [new RegExp(`(((${FIGURE})\\s*([€£¥₤₽₩₹])))`, 'g'), 3, 2],
    [new RegExp(`(((${FIGURE})\\s*(?:moeda\\s*)?\\b(${UNREADABLE})\\b))`, 'gi'), 3, 2],
    // unknown 3-letter code PREFIXING the figure: `BDT 42,50`
    [new RegExp(`([-−]?\\s*\\b(?!${KNOWN_CURRENCY_CODES}\\b)([A-Z]{3})\\b\\s*(${FIGURE}))`, 'g'), 2, 3],
    // unknown 3-letter code SUFFIXING the figure: `42,50 BDT`
    [new RegExp(`((${FIGURE})\\s*\\b(?!${KNOWN_CURRENCY_CODES}\\b)([A-Z]{3})\\b)`, 'g'), 3, 2],
  ];
  for (const [re, label, group] of OTHER_MARKED) collectAll(re, 'UNKNOWN', label, group);
  return resolveMarkerConflicts(found);
};

/**
 * Bare BR-decimal figures (`999,00`-style) count as claims ONLY in clear
 * financial context: a finance keyword within ±30 chars of the figure.
 * Keyword matching runs on folded text so `preço`/`cobrança`/`débito`
 * match their unaccented forms. Deliberately narrow (no bare `conta` /
 * `cartao`): genuine account-mention sentences rarely carry bare
 * decimals, and every other keyword here already covers them.
 *
 * The figure itself is `BARE_FIGURE` — signed, and anchored by lookarounds
 * instead of `\b…\b` so a leading minus is allowed (between a space and `-`
 * there is no word boundary) while a number embedded in a LONGER figure
 * (`1.234,567`) or in a word (`x42,50`) is still not a claim.
 *
 * V1-GROUND-PAYMENT-CONTEXT: the payment-method acronyms are financial
 * context too. `hasUnknownUnitTail` already keeps `PIX`/`TED`/`DOC` from
 * reading as units (V1-GROUND-PAYMENT-TAIL), but only `pix` was named here,
 * so a bare `42,50 TED` / `42,50 DOC` in a sentence with no other finance
 * keyword was never a claim at all — an unchallenged figure, free against an
 * empty envelope. All three now count as context, so the figure is a claim
 * that must be grounded (rejected absent evidence, accepted only by matching
 * API cents). Residual, fail-closed and accepted: a bare figure sitting near
 * an unrelated mention of the acronym is read as a claim and, if nothing
 * grounds it, the turn takes the correction-retry path instead of publishing.
 */
const BARE_MONEY_CONTEXT = /\b(total|saldo|fatura|valor|preco|pagamento|cobranca|despesa|receita|gasto|custo|tarifa|juros|multa|parcela|mensalidade|debito|credito|extrato|boleto|pix|ted|doc|lancamento|transferencia)\b/;

const bareMoney = (text: string): MoneyMatch[] => {
  const folded = fold(text);
  const found: MoneyMatch[] = [];
  for (const match of text.matchAll(new RegExp(BARE_FIGURE, 'g'))) {
    const span = match[0]!;
    const after = text.slice((match.index ?? 0) + span.length);
    // V1-GROUND-UNKNOWN-UNIT: a known unit / `%` tail, OR an UNRECOGNISED
    // immediate word that is not a neutral continuation, disqualifies the
    // figure — it is a quantity, not money (see `NEUTRAL_CONTINUATION`).
    if (hasUnitTail(after) || hasUnknownUnitTail(after)) continue;
    const start = match.index ?? 0;
    const window = folded.slice(Math.max(0, start - 30), start + span.length + 30);
    if (!BARE_MONEY_CONTEXT.test(window)) continue;
    pushMatch(found, match[1], null, 'R$', start, match);
  }
  return found;
};

/**
 * Every detected money figure in the reply, deduplicated BY SPAN: a
 * `R$ 999,99` matches the marked rule AND the bare BR-decimal rule over the
 * same digits, and listing one figure twice would inflate both the correction
 * prompt and the per-axis count the observability event reports. Matches are
 * visited in text order, and at the same start the LONGER span (the marked
 * one, which carries the currency and the sign) wins, so a bare match that
 * overlaps it is dropped while a genuinely different figure survives.
 */
const moneyMatches = (text: string): MoneyMatch[] => {
  const accepted: MoneyMatch[] = [];
  const ordered = [...markedMoney(text), ...bareMoney(text)].sort(
    (left, right) => left.index - right.index || right.length - left.length,
  );
  for (const match of ordered) {
    const start = match.index;
    const end = start + match.length;
    if (accepted.some((kept) => start < kept.index + kept.length && kept.index < end)) continue;
    accepted.push(match);
  }
  return accepted;
};

// RESIDUAL (accepted, fail-closed): spelled-out amounts ("quarenta e dois
// reais", "um milhão") carry no delimitable figure for any regex. They are
// NOT claims here; mitigation is the DATA-precedence instruction (attachment
// blocks outrank model prose) plus the single correction retry — and, with
// the read-bypass active, the retry/unavailable path still stands between
// an unverified turn and publication. Never "fix" this by loosening
// detection of delimited shapes.

/**
 * V1-GROUND-SIGN: a percent keeps its sign too, so `-12,5%` can never be
 * grounded by `12.5` (nor the reverse).
 *
 * The match INDEX travels with the value: V1-GROUND-PROVENANCE decides
 * REGISTERED state from the sentence the figure sits in, and that sentence
 * is located by where the figure was found.
 */
const percentages = (text: string): ReadonlyArray<{ value: number; index: number }> =>
  [...text.matchAll(/([-−]?\s*\d+(?:[.,]\d+)?\s*[-−]?)\s*%/g)].map((match) => {
    const raw = match[1]!;
    const value = Number(raw.replace(/[-−]/g, '').trim().replace(',', '.'));
    return { value: isNegativeFigure(raw) ? -value : value, index: match.index ?? 0 };
  });

const MONTHS_PT = '(janeiro|fevereiro|marco|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)';
const MONTH_INDEX: Record<string, string> = {
  janeiro: '01', fevereiro: '02', marco: '03', 'março': '03', abril: '04', maio: '05', junho: '06',
  julho: '07', agosto: '08', setembro: '09', outubro: '10', novembro: '11', dezembro: '12',
};

const dates = (text: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const day = match[1]!.padStart(2, '0');
    const month = match[2]!.padStart(2, '0');
    found.push(match[3] ? `${match[3].length === 2 ? `20${match[3]}` : match[3]}-${month}-${day}` : `--${month}-${day}`);
  }
  for (const match of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    found.push(`${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`);
  }
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+de\\s+${MONTHS_PT}\\b`, 'gi'))) {
    const month = MONTH_INDEX[fold(match[2]!)] ?? MONTH_INDEX[match[2]!.toLowerCase()] ?? '00';
    found.push(`--${month}-${match[1]!.padStart(2, '0')}`);
  }
  return [...new Set(found)];
};

const names = (text: string): string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(/"([^"]{2,60})"/g)) found.add(match[1]!.trim());
  for (const match of text.matchAll(/(?:conta|cart[aã]o|categoria)\s+([A-Za-zÁÀÃÂÉÊÍÓÔÕÚÇáàãâéêíóôõúç][\wÁÀÃÂÉÊÍÓÔÕÚÇáàãâéêíóôõúç]*(?:\s+[A-Za-zÁÀÃÂÉÊÍÓÔÕÚÇáàãâéêíóôõúç][\wÁÀÃÂÉÊÍÓÔÕÚÇáàãâéêíóôõúç]*){0,1})/gi)) {
    found.add(match[1]!.replace(/[.!?,]+$/, '').trim());
  }
  for (const match of text.matchAll(/(?:na|no|em|da|do|para|conta|cartao|cartão|categoria)\s+([A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][\wÁÀÃÂÉÊÍÓÔÕÚÇ]*(?:\s+[\wÁÀÃÂÉÊÍÓÔÕÚÇ]*)*)/g)) {
    found.add(match[1]!.replace(/[.!?,]+$/, '').trim());
  }
  for (const match of text.matchAll(/\b([A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][a-záàãâéêíóôõúç]+(?:\s+[A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][a-záàãâéêíóôõúç]+)+)/g)) {
    found.add(match[1]!.trim());
  }
  return [...found].filter((name) => name.length >= 2);
};

const flatten = (value: unknown): unknown[] => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? Object.values(value).flatMap(flatten) : [value];

/**
 * Money READ OUT OF a TEXT payload: EXPLICITLY MARKED figures only, with the
 * same currency discipline the claims use.
 *
 * Serves the ADMITTED DOCUMENT axis only (server-side attachment-extracted
 * texts): a block text is evidence OF THE DOCUMENT, never proof of API state
 * (V1-GROUND-PROVENANCE applies on top). API financial claims are supported
 * ONLY by contract-typed quantitative fields — arbitrary backend text fields
 * never reach here (V1-GROUND-SCHEMA-TEXT).
 *
 * V1-GROUND-ATTRIBUTION-MARKER: on this axis a figure must carry an EXPLICIT
 * monetary marker (`R$`, `BRL`, `reais`, `US$`, `USD`, `$`, or a currency the
 * matcher recognises). The old support-side superset also admitted any bare
 * BR-decimal inside the block, which made an UNMARKED decimal implicit BRL
 * evidence: `12,50 hectares` (a unit outside the closed unit list) and
 * `BDT 42,50` (a code outside the closed foreign list) both grounded a reais
 * claim. An unmarked decimal is a quantity or an unidentified currency, never
 * money — the CLAIMS side still needs no marker in clear financial context
 * (`bareMoney`), but evidence must name what the figure is.
 *
 * A figure marked with a currency the workspace does not serve (or with none
 * readable) is NOT support — see `markedMoney`. It is dropped here, so an
 * `EUR 42,50` line, a `42,50 unknown` line or a `12,50 toneladas` quantity
 * never become reais evidence for a BRL claim.
 */
const moneyInString = (value: string): MoneyClaim[] =>
  markedMoney(value)
    .map((match) => match.claim)
    .filter((claim) => claim.currency !== 'UNKNOWN');

/**
 * V1-GROUND-SCHEMA (P1): a raw tool number's MEANING comes from the API read
 * contract's field name, never from a numeric heuristic. A key ending in
 * `cents` (`balanceCents`, and the raw `balance_cents`/`amount_cents` the
 * entity-list reads carry verbatim) is money in minor units of the workspace
 * currency — and so is the G-B EXACT spelling (`incomeCentsExact`,
 * `expenseCentsExact`, `previousIncomeCentsExact`, `previousExpenseCentsExact`,
 * `totalCentsExact`), which the contract types as a decimal string present
 * only when the sibling number passed 2^53; a key that DECLARES a percentage
 * (`pct`, `pctUsed`, `savingsRatePct`, `incomeChangePercent`, `sharePercent`,
 * …) is a ratio; and EVERY other numeric field — `transactionCount`,
 * `omittedCount`, a list `total`, `limit`, an unclassified `allocation` — is
 * a count or an unknown quantity and can NEVER ground a money claim NOR a
 * percent claim. Data without money metadata fails closed instead of being
 * flattened into a currency-shaped sink.
 *
 * V1-GROUND-SCHEMA-TEXT: support comes ONLY from such contract-typed
 * QUANTITATIVE fields. Arbitrary backend TEXT — a transaction description, a
 * free note, an account name — can carry `R$ …`/`%` prose, and that prose is
 * never API financial evidence: it would let any labeled copy launder a
 * figure the read contract never proved. (Document-attributed support is a
 * separate, admitted axis — see the attachment wall in
 * `validateGroundedClaims`.)
 */
const MONEY_FIELD = /cents(?:[_\-]?exact)?$/i;

/**
 * The contract's own shape for the exact aggregates (`pattern: ^-?\d+$`):
 * optionally signed DECIMAL DIGITS, nothing else. A locally formatted string
 * under the same key is out of contract and stays inert.
 */
const EXACT_CENTS_STRING = /^-?\d+$/;

/** V1-GROUND-PERCENT: only an explicitly percentage-declared field is a ratio. */
const PERCENT_FIELD = /pct|percent|percentage|percentual/i;

const collectNumbers = (value: unknown, key: string | null, out: { money: MoneyClaim[]; percents: number[] }): void => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // V1-GROUND-SCHEMA-EXACT: a numeric money field is evidence ONLY when it
    // is a SAFE INTEGER. Past 2^53 the double has already lost the low-order
    // cents, so the figure it carries is a ROUNDED aggregate — grounding with
    // it would publish a rounded false claim (the true aggregate travels as
    // the sibling decimal string, `*CentsExact`, which is parsed as bigint
    // below). An unsafe (or fractional) number under a money key therefore
    // carries no exact quantity and fails closed instead of being flattened
    // into a currency-shaped sink.
    if (key !== null && MONEY_FIELD.test(key)) {
      if (Number.isSafeInteger(value)) out.money.push({ cents: BigInt(value), currency: 'BRL' });
    }
    else if (key !== null && PERCENT_FIELD.test(key)) out.percents.push(round2(value));
    return;
  }
  if (typeof value === 'string' && key !== null && MONEY_FIELD.test(key)) {
    // V1-GROUND-SCHEMA-EXACT: the exact aggregates travel as decimal strings
    // (G-B) when the sibling number already lost cents above 2^53. Parsed as
    // bigint, every low-order digit and the sign survive — no double
    // rounding on either side of the comparison. A string outside the
    // contract pattern is not a quantity at all: it never becomes money
    // evidence (and is never scanned as prose here).
    if (EXACT_CENTS_STRING.test(value)) out.money.push({ cents: BigInt(value), currency: 'BRL' });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, key, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) collectNumbers(child, childKey, out);
  }
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * V1-GROUND-PROVENANCE — a figure whose sentence asserts REGISTERED state
 * (a balance/expense/entry the workspace holds) can only be grounded by
 * authoritative API evidence. Document-reported money stays usable, but only
 * as document-attributed data ("o PDF informa R$ 42,50"), never as proof of a
 * registered balance or transaction.
 *
 * The markers are deliberately narrow and every one of them asserts the
 * WORKSPACE holds the figure. A bare `consta` is NOT one of them — "no anexo
 * consta R$ 42,50" is a document attribution, exactly the phrasing the rule
 * exists to protect; `consta no sistema` is the registered shape.
 *
 * The sentence that carries the figure is its OWN context, and a LINE BREAK
 * is not a sentence boundary: a labelled block renders as
 * `Seu saldo atual:\nR$ 42,50`, and treating the newline as a delimiter
 * would leave the figure in a one-line sentence with no registered marker at
 * all — the document figure would then ground a balance claim. Splitting on
 * `.`/`!`/`?`/`;` only (and never inside a decimal such as `1.234,56`) keeps
 * the marker and its figure in the same context.
 *
 * This deny-list is ADDITIONAL defense, not the whole rule: positive
 * attribution is decided by `DOCUMENT_ATTRIBUTION_SOURCE` /
 * `attributesDocumentInClause` below.
 */
const REGISTERED_STATE =
  /\b(registrad\w*|lan[çc]ad\w*|lan[çc]ament\w*|consta no sistema|no sistema|seu saldo|saldo atual|saldo da conta|saldo registrado|saldo bancari\w*|saldo dispon[ií]vel)\b/i;

/**
 * V1-GROUND-ATTRIBUTION — attachment-only monetary support (money and
 * percent) is admitted ONLY when the figure's own sentence attributes it to
 * the document: the reply must say the DOCUMENT reports the figure ("O
 * documento informa R$ 42,50", "No anexo consta R$ 42,50", "Segundo o
 * extrato, …", "O valor no PDF é …"). A deny-list of registered words is not
 * provenance — "A fatura é R$ 42,50 na Conta principal" names no registered
 * marker, yet it presents the figure as workspace state, and a document can
 * never prove that. The registered-state guard stays and WINS: a sentence
 * that BOTH attributes and asserts registered state ("O documento informa
 * que seu saldo registrado é R$ 42,50") still fails closed.
 *
 * V1-GROUND-ATTRIBUTION-CLAUSE: the attribution must GOVERN the figure. The
 * nouns are the document kinds the attachment pipeline actually produces
 * plus the generic `documento`/`anexo`/`arquivo`; the relations are the pt-BR
 * report verbs and the attributive prepositions. The relation must follow the
 * noun DIRECTLY, so a negation in between ("O documento NÃO informa R$ 42,50")
 * is not an attribution. The phrase must also live in the SAME local clause as
 * the figure and must not be negated — see `clauseAround` /
 * `attributesDocumentInClause` below: "O documento informa a data, mas o total
 * da sua fatura é R$42,50" leaves the amount outside the attributed clause, and
 * "O valor NÃO está no documento: o total é R$42,50" is a negated reference,
 * not provenance. Matching stays on the FOLDED text, so the marker and its
 * figure keep the same context even across a line break ("O documento
 * informa:\nR$ 42,50").
 */
const DOCUMENT_NOUN =
  '(?:documento|anexo|arquivo|pdf|imagem|foto|recibo|comprovante|nota\\s+fiscal|cupom|fatura|boleto|extrato|print|captura\\s+de\\s+tela|scan)';
const DOCUMENT_REPORT =
  '(?:informa\\w*|consta\\w*|mostra\\w*|indica\\w*|aponta\\w*|descreve\\w*|menciona\\w*|diz\\w*|traz\\w*|apresenta\\w*|cont[ée]m|lista\\w*)';
const DOCUMENT_ATTRIBUTION_SOURCE = [
  // "O documento informa …" / "No anexo consta …" / "A fatura mostra …"
  `\\b${DOCUMENT_NOUN}\\s+${DOCUMENT_REPORT}`,
  // "Segundo o anexo, …" / "Conforme o documento …" / "De acordo com o PDF …"
  `\\b(?:segundo|conforme|de\\s+acordo\\s+com)\\s+(?:o|a|os|as)?\\s*${DOCUMENT_NOUN}\\b`,
  // "Conforme consta no documento, …" / "Como mostra o PDF, …"
  `\\b(?:conforme|como)\\s+(?:consta|${DOCUMENT_REPORT})\\s+(?:(?:no|na|do|da|pel[oa]|ness[ae]|nest[ae]|o|a|os|as)\\s+)?${DOCUMENT_NOUN}\\b`,
  // "O valor no documento …" / "A taxa do anexo …"
  `\\b(?:no|na|do|da|nesse|nessa|neste|nesta|desse|dessa|deste|desta)\\s+${DOCUMENT_NOUN}\\b`,
  // "Extraído do anexo: …"
  `\\bextra[ií]d[oa]s?\\s+(?:do|da|de)\\s+${DOCUMENT_NOUN}\\b`,
].join('|');

/**
 * V1-GROUND-ATTRIBUTION-CLAUSE — an adversative/concessive OR coordinating
 * conjunction starts a NEW clause, and a figure that lands there is not
 * covered by an attribution sitting before it: "O documento informa a data,
 * mas o total da sua fatura é R$42,50" says one thing about the document and
 * another, unattributed, about the amount — and so does the COORDINATING
 * "O documento informa a data e o total da sua fatura é R$42,50", where the
 * second conjunct carries its OWN predicate the document never vouched for
 * (an `e` that merely coordinates objects inside one predicate still keeps
 * the figure in the attributed clause, as does a negation that FOLLOWS it).
 * The list is CLOSED (with the accented spellings, because this runs on the
 * ORIGINAL text — see `clauseAround`) so an ordinary word inside a labelled
 * block never splits the clause. A comma, a colon and a LINE BREAK are
 * deliberately NOT breaks — "O documento informa:\nR$ 42,50" is how a
 * labelled block renders, and splitting there would strip the attribution
 * from the very figure it governs. Over-blocking a coordination that really
 * is one predicate is the fail-closed direction: the reply takes the
 * correction-retry path instead of publishing.
 *
 * Matching on the ORIGINAL text is load-bearing for the coordinating `e`:
 * folding turns the copula "é" into "e" as well, and a clause break there
 * would strip the attribution from the canonical direct citation "O valor no
 * documento é R$ 42,50". A decomposed (NFD) "e" + combining acute is excluded
 * by the lookahead, so both spellings of the verb stay inside the clause.
 */
const CLAUSE_BREAK =
  /\b(?:e(?![\u0300-\u036f])|mas|porem|por[eé][\u0300-\u036f]*m|contudo|entretanto|todavia|no\s+entanto|apesar\s+disso|s[oó][\u0300-\u036f]*\s+que|embora|ainda\s+que|mesmo\s+que|apesar\s+de)\b/i;

/** A sentence delimiter only splits when whitespace follows, so `1.234,56` never ends a sentence. */
const isSentenceEnd = (char: string | undefined, next: string | undefined): boolean =>
  char !== undefined && (char === '.' || char === '!' || char === '?' || char === ';') &&
  (next === undefined || /\s/.test(next));

/** Bounds of the sentence around `index`; a LINE BREAK is not a sentence boundary. */
const sentenceBoundsAround = (text: string, index: number): { start: number; end: number } => {
  let start = 0;
  for (let i = 0; i < index; i += 1) if (isSentenceEnd(text[i], text[i + 1])) start = i + 1;
  let end = text.length;
  for (let i = index; i < text.length; i += 1) {
    if (isSentenceEnd(text[i], text[i + 1])) {
      end = i + 1;
      break;
    }
  }
  return { start, end };
};

/**
 * Bounds of the LOCAL CLAUSE governing the figure at `index`: the sentence,
 * narrowed by the nearest `CLAUSE_BREAK` on either side of the figure. The
 * figure always sits inside the result, and an attribution governs it only when
 * the phrase sits inside it too.
 *
 * `text` is the ORIGINAL reply (not the folded copy) so the coordinating `e`
 * is never confused with the folded verb `é`; folding is length-preserving,
 * so the sentence bounds computed on the folded copy still index it exactly.
 */
const clauseAround = (text: string, index: number, sentence: { start: number; end: number }): { start: number; end: number } => {
  let start = sentence.start;
  let end = sentence.end;
  for (const match of text.slice(sentence.start, sentence.end).matchAll(new RegExp(CLAUSE_BREAK.source, 'gi'))) {
    const from = sentence.start + (match.index ?? 0);
    const to = from + match[0]!.length;
    if (to <= index) start = Math.max(start, to);
    else if (from >= index) {
      end = Math.min(end, from);
      break;
    }
  }
  return { start, end };
};

/**
 * V1-GROUND-ATTRIBUTION-NEGATION — a document reference preceded by a negator
 * denies the document instead of citing it ("O valor NÃO está no documento",
 * "NÃO encontrei o valor no anexo"), so it is never provenance. The search is
 * bounded by the clause and looks only BEFORE the reference: a negation that
 * follows it, or one stranded in another clause, must not suppress a positive
 * attribution ("O documento não informa a data, mas o anexo informa R$ 42,50"
 * stays attributed). `sem` is deliberately not a negator here — "sem registros
 * no sistema, o valor no documento é R$ 42,50" still cites the document.
 *
 * V1-GROUND-ATTRIBUTION-COORDINATION — the SAME denial reached from the other
 * side: a negator sitting BETWEEN the attribution and the figure denies the
 * relation for that very figure ("O documento informa a data e NÃO informa o
 * total de R$ 42,50"), so a positive attribution is never borrowed across the
 * coordinated clause. A negation AFTER the figure denies another object and
 * leaves the citation intact ("O documento informa o total de R$ 42,50 e não
 * informa a data" stays attributed).
 */
const NEGATION_TOKENS: ReadonlySet<string> = new Set(['nao', 'nunca', 'jamais', 'nem']);

/** True when a negator precedes the document reference at `matchStart` inside the clause. */
const isNegatedReference = (folded: string, clauseStart: number, matchStart: number): boolean => {
  const tokens = folded.slice(clauseStart, matchStart).match(/[a-z0-9]+/g) ?? [];
  return tokens.some((token) => NEGATION_TOKENS.has(token));
};

/** True when a negator sits between `from` and `to` — nothing to deny when the range is empty or reversed. */
const isNegatedSpan = (folded: string, from: number, to: number): boolean => {
  if (to <= from) return false;
  const tokens = folded.slice(from, to).match(/[a-z0-9]+/g) ?? [];
  return tokens.some((token) => NEGATION_TOKENS.has(token));
};

/**
 * True when the figure's own clause attributes it to the document: at least
 * one `DOCUMENT_ATTRIBUTION_SOURCE` phrase inside that clause, none of them
 * negated — neither before the phrase nor between it and the figure.
 */
const attributesDocumentInClause = (folded: string, clause: { start: number; end: number }, figureIndex: number): boolean => {
  for (const match of folded.slice(clause.start, clause.end).matchAll(new RegExp(DOCUMENT_ATTRIBUTION_SOURCE, 'gi'))) {
    const matchStart = clause.start + (match.index ?? 0);
    if (isNegatedReference(folded, clause.start, matchStart)) continue;
    if (isNegatedSpan(folded, matchStart + match[0]!.length, figureIndex)) continue;
    return true;
  }
  return false;
};

export const validateGroundedClaims = (
  text: string,
  envelope: EvidenceEnvelope,
  attachmentTexts: readonly string[] = [],
): GroundingResult => {
  const okData = envelope.items.filter((item) => item.status === 'ok').map((item) => item.data);
  const values = flatten(okData);
  const numbers = { money: [] as MoneyClaim[], percents: [] as number[] };
  for (const data of okData) collectNumbers(data, null, numbers);
  // V1-GROUND-SCHEMA-TEXT: API financial evidence is ONLY what the read
  // contract types as quantitative — `*cents` money fields (numbers, and the
  // G-B exact decimal strings) and percentage-declared fields. A backend
  // TEXT field (description/note/accountName) carrying `R$ …`/`%` prose is
  // inert on this axis: labeled copy must never launder a figure the read
  // contract never proved. Document-attributed support stays on its own
  // admitted axis below.
  const toolMoney: MoneyClaim[] = numbers.money;
  const supportedPercents = new Set(numbers.percents);
  // A19-GROUND-EVIDENCE: admitted attachment support for READ narration.
  // Server-side attachment-extracted texts ONLY (never typed text, never
  // client input — the caller plumbs them from the turn's accepted
  // extractions). A SEPARATE support set: a money/name/date claim is
  // accepted when it matches EITHER tool evidence OR admitted block text,
  // with the SAME matchers on both sides (exact cents, currency tag,
  // alternate formats, and — on the document axis only — an explicit
  // monetary marker: see `moneyInString`). A figure present in NEITHER still
  // fails. V1-GROUND-ATTRIBUTION: on this axis MONEY and PERCENT additionally
  // require positive document attribution in the LOCAL CLAUSE that governs the
  // figure, and V1-GROUND-PROVENANCE still refuses a figure presented as
  // REGISTERED state (dates and names are figure-free and keep their existing
  // support). Read-narration only: no mutation/approval path consumes this
  // validator (only grounded-response does).
  const admitted = attachmentTexts.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  const admittedMoney = admitted.flatMap(moneyInString);
  const admittedFolded = admitted.map(fold);
  const admittedText = fold(admitted.join(' | '));
  // V1-GROUND-PERCENT-ATTACHMENT: the admitted set also carries the `%`-marked
  // figures of the block, parsed with the SAME matcher the claims use — money
  // evidence never enters here (the axes stay distinct), and a figure absent
  // from BOTH the tool contract and the block still fails.
  const admittedPercents = new Set(admitted.flatMap((item) => percentages(item).map((percent) => percent.value)));
  const counts = { money: 0, percent: 0, date: 0, name: 0 };
  const unsupportedClaims: string[] = [];
  // V1-GROUND-ATTRIBUTION: the claim text is folded ONCE (folding is
  // length-preserving, so match indices stay valid) and every attribution
  // decision below reads that same folded string: sentence bounds, clause
  // bounds, the registered-state deny-list and the attribution phrase.
  const foldedText = fold(text);
  for (const match of moneyMatches(text)) {
    const claim = match.claim;
    const tag = currencyOf(claim.currency);
    const inTools = toolMoney.some((support) => support.cents === claim.cents && currencyOf(support.currency) === tag);
    // V1-GROUND-ATTRIBUTION + V1-GROUND-PROVENANCE: document money grounds a
    // figure ONLY when the LOCAL CLAUSE that governs it attributes it to the
    // document AND the sentence does not assert registered workspace state. An
    // attribution that sits in another clause ("…o documento informa a data,
    // mas o total da fatura é R$42,50") or is negated ("o valor NÃO está no
    // documento") is not provenance. API money needs neither — it is
    // authoritative on its own.
    const sentence = sentenceBoundsAround(foldedText, match.index);
    const clause = clauseAround(text, match.index, sentence);
    const assertsRegistered = REGISTERED_STATE.test(foldedText.slice(sentence.start, sentence.end));
    const attributesDocument = attributesDocumentInClause(foldedText, clause, match.index);
    const inDocument = attributesDocument && !assertsRegistered &&
      admittedMoney.some((support) => support.cents === claim.cents && currencyOf(support.currency) === tag);
    if (!inTools && !inDocument) {
      // The label names the marker the reply used, so a foreign-currency or
      // unreadable figure is never reported to the correction prompt as reais.
      unsupportedClaims.push(`${match.label} ${claim.cents}`);
      counts.money += 1;
    }
  }
  for (const percent of percentages(text)) {
    // V1-GROUND-PERCENT: a percent is grounded ONLY by an explicitly
    // percentage-declared field of the read contract. Counts, totals, limits
    // and unclassified numbers can never support one, and a `*cents` field is
    // money in minor units — never a ratio.
    const inTools = supportedPercents.has(percent.value);
    // V1-GROUND-PERCENT-ATTACHMENT + V1-GROUND-ATTRIBUTION: the same `%`
    // figure in admitted block text also grounds the claim, under the SAME
    // boundary money obeys — positive document attribution in the figure's
    // own CLAUSE, and never a presentation of REGISTERED workspace state
    // (the deny-list wins when both appear).
    const sentence = sentenceBoundsAround(foldedText, percent.index);
    const clause = clauseAround(text, percent.index, sentence);
    const assertsRegistered = REGISTERED_STATE.test(foldedText.slice(sentence.start, sentence.end));
    const attributesDocument = attributesDocumentInClause(foldedText, clause, percent.index);
    const inDocument = attributesDocument && !assertsRegistered && admittedPercents.has(percent.value);
    if (!inTools && !inDocument) {
      unsupportedClaims.push(`${percent.value}%`);
      counts.percent += 1;
    }
  }
  const supportedStrings = values.filter((value): value is string => typeof value === 'string');
  const foldedStrings = supportedStrings.map(fold);
  const envelopeText = fold(supportedStrings.join(' | '));
  for (const date of dates(text)) {
    const compact = date.replace(/-/g, '');
    const slashDayMonth = date.startsWith('--') ? date.slice(2).split('-').reverse().join('/') : null;
    const toolMatched =
      envelopeText.includes(fold(date)) ||
      envelopeText.includes(compact) ||
      (date.startsWith('--') && envelopeText.includes(date.slice(2))) ||
      (slashDayMonth !== null && envelopeText.includes(slashDayMonth));
    // A19-GROUND-EVIDENCE: the same date shapes match admitted block text.
    const admittedMatched =
      admittedText.includes(fold(date)) ||
      admittedText.includes(compact) ||
      (date.startsWith('--') && admittedText.includes(date.slice(2))) ||
      (slashDayMonth !== null && admittedText.includes(slashDayMonth));
    if (!toolMatched && !admittedMatched) {
      unsupportedClaims.push(date);
      counts.date += 1;
    }
  }
  for (const name of names(text)) {
    const folded = fold(name);
    if (foldedStrings.some((candidate) => candidate.includes(folded) || folded.includes(candidate))) continue;
    // A19-GROUND-EVIDENCE: the same name matchers consult admitted block text.
    if (admittedFolded.some((candidate) => candidate.includes(folded) || folded.includes(candidate))) continue;
    // Fallback for keyword-led captures with trailing context ("conta
    // principal está…"): the claim is supported when its leading nominal
    // token appears in evidence. Unknown proper names still fail.
    const tokens = folded.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    const head = tokens[0];
    if (head && tokens.length > 1 && envelopeText.includes(head)) continue;
    if (head && tokens.length > 1 && admittedText.includes(head)) continue;
    unsupportedClaims.push(name);
    counts.name += 1;
  }
  return { valid: unsupportedClaims.length === 0, unsupportedClaims, counts };
};
