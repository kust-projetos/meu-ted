import type { EvidenceEnvelope } from './evidence-envelope.js';

type GroundingResult = Readonly<{ valid: boolean; unsupportedClaims: readonly string[] }>;

const fold = (value: string): string =>
  (value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * A19-GROUND-FORMATS: a detected money figure in BOTH units the envelope
 * may hold it in — `cents` (tool payloads such as `balanceCents`) and
 * `reais` (plain numeric payloads such as invoice totals).
 */
type MoneyClaim = Readonly<{ cents: number; reais: number }>;

/**
 * Parses a digit run with BR/US thousand/decimal separators into cents.
 * The LAST separator carrying 1-2 trailing digits is the decimals; every
 * other separator is thousands. Trailing stray separators (sentence
 * punctuation) are trimmed first. Returns null when no digit is present.
 */
const flexibleToCents = (raw: string): number | null => {
  const s = raw.replace(/[.,\s]+$/, '').replace(/^\s+/, '');
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
  return Number(intDigits) * 100 + Number((`${dec}00`).slice(0, 2));
};

const toClaim = (raw: string): MoneyClaim | null => {
  const cents = flexibleToCents(raw);
  return cents === null ? null : { cents, reais: cents / 100 };
};

const pushClaim = (found: MoneyClaim[], raw: string | undefined): void => {
  if (raw === undefined) return;
  const claim = toClaim(raw);
  if (claim) found.push(claim);
};

/**
 * Explicitly marked money: needs NO surrounding context, so it is ALWAYS
 * a financial claim. Covers the canonical `R$ 1.234,56`, the integer
 * `R$ 999`/`R$999`, `999 reais`/`999,00 reais`/`1.234,56 reais` (and the
 * `1 real` singular), `US$`/`$` with digits (BR or US separators), and
 * the `BRL`/`USD` ISO codes. The bare-`$` lookbehind keeps the `$` of
 * `R$`/`US$` from double-counting.
 */
const markedMoney = (text: string): MoneyClaim[] => {
  const found: MoneyClaim[] = [];
  for (const match of text.matchAll(/R\$\s*([\d.,]*\d)/g)) pushClaim(found, match[1]);
  for (const match of text.matchAll(/US\$\s*([\d.,]*\d)/gi)) pushClaim(found, match[1]);
  for (const match of text.matchAll(/(?<![A-Za-z$])\$\s*([\d.,]*\d)/g)) pushClaim(found, match[1]);
  for (const match of text.matchAll(/([\d.,]*\d)\s*(?:real|reais)\b/gi)) pushClaim(found, match[1]);
  for (const match of text.matchAll(/\b(?:BRL|USD)\s*([\d.,]*\d)/gi)) pushClaim(found, match[1]);
  for (const match of text.matchAll(/([\d.,]*\d)\s*(?:BRL|USD)\b/gi)) pushClaim(found, match[1]);
  return found;
};

/**
 * Bare BR-decimal figures (`999,00`-style) count as claims ONLY in clear
 * financial context: a finance keyword within ±30 chars of the figure.
 * Keyword matching runs on folded text so `preço`/`cobrança`/`débito`
 * match their unaccented forms. Deliberately narrow (no bare `conta` /
 * `cartao`): genuine account-mention sentences rarely carry bare
 * decimals, and every other keyword here already covers them.
 */
const BARE_MONEY_CONTEXT = /\b(total|saldo|fatura|valor|preco|pagamento|cobranca|despesa|receita|gasto|custo|tarifa|juros|multa|parcela|mensalidade|debito|credito|extrato|boleto|pix|lancamento|transferencia)\b/;

const bareMoney = (text: string): MoneyClaim[] => {
  const folded = fold(text);
  const found: MoneyClaim[] = [];
  for (const match of text.matchAll(/\b([\d.,]*\d,\d{2})\b/g)) {
    const start = match.index ?? 0;
    const window = folded.slice(Math.max(0, start - 30), start + match[0]!.length + 30);
    if (!BARE_MONEY_CONTEXT.test(window)) continue;
    pushClaim(found, match[1]);
  }
  return found;
};

const moneyClaims = (text: string): MoneyClaim[] => [...markedMoney(text), ...bareMoney(text)];

// RESIDUAL (accepted, fail-closed): spelled-out amounts ("quarenta e dois
// reais", "um milhão") carry no delimitable figure for any regex. They are
// NOT claims here; mitigation is the DATA-precedence instruction (attachment
// blocks outrank model prose) plus the single correction retry — and, with
// the read-bypass active, the retry/unavailable path still stands between
// an unverified turn and publication. Never "fix" this by loosening
// detection of delimited shapes.

const percentages = (text: string): number[] =>
  [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((match) => Number(match[1]!.replace(',', '.')));

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

const moneyCentsIn = (value: unknown): number[] => {
  if (typeof value === 'number' && Number.isFinite(value)) return [Math.trunc(value)];
  if (typeof value === 'string') {
    const out: number[] = [];
    for (const claim of markedMoney(value)) out.push(claim.cents);
    // Support-side superset: any BR-decimal figure inside TRUSTED tool data
    // counts as known. Context-gating applies to CLAIMS (model text), never
    // to support — a figure present in evidence is grounded by definition.
    for (const match of value.matchAll(/\b([\d.,]*\d,\d{2})\b/g)) {
      const cents = flexibleToCents(match[1]!);
      if (cents !== null) out.push(cents);
    }
    return out;
  }
  return [];
};

/**
 * A19-GROUND-FIX2 (P1): raw tool numbers carry their field's unit. A key
 * containing `cents` (e.g. `balanceCents`) holds CENTAVOS and must never
 * satisfy the reais arm of a money claim — otherwise `balanceCents: 99900`
 * (= R$ 999,00) wrongly grounds "R$ 99.900,00" (reais 99900). Keyless
 * numbers keep the legacy behavior (eligible for both arms) so no
 * previously-grounded shape is over-blocked.
 */
const CENTS_KEY = /cents/i;

const collectUnitNumbers = (value: unknown, key: string | null, out: { cents: number[]; reais: number[] }): void => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    (key !== null && CENTS_KEY.test(key) ? out.cents : out.reais).push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUnitNumbers(item, key, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) collectUnitNumbers(child, childKey, out);
  }
};

export const validateGroundedClaims = (
  text: string,
  envelope: EvidenceEnvelope,
  attachmentTexts: readonly string[] = [],
): GroundingResult => {
  const okData = envelope.items.filter((item) => item.status === 'ok').map((item) => item.data);
  const values = flatten(okData);
  const supportedMoney = new Set(values.flatMap(moneyCentsIn));
  const supportedNumbers = new Set(
    values.filter((value): value is number => typeof value === 'number').map((n) => Math.round(n * 100) / 100),
  );
  const unitNumbers = { cents: [] as number[], reais: [] as number[] };
  for (const data of okData) collectUnitNumbers(data, null, unitNumbers);
  const supportedReaisNumbers = new Set(unitNumbers.reais.map((n) => Math.round(n * 100) / 100));
  const supportedStrings = values.filter((value): value is string => typeof value === 'string');
  const foldedStrings = supportedStrings.map(fold);
  // A19-GROUND-EVIDENCE: admitted attachment support for READ narration.
  // Server-side attachment-extracted texts ONLY (never typed text, never
  // client input — the caller plumbs them from the turn's accepted
  // extractions). A SEPARATE support set: a money/name/date claim is
  // accepted when it matches EITHER tool evidence OR admitted block text,
  // with the SAME matchers on both sides (exact cents, reais unit rule,
  // alternate formats, support-side BR-decimal superset). A figure present
  // in NEITHER still fails. Read-narration only: no mutation/approval path
  // consumes this validator (only grounded-response does).
  const admitted = attachmentTexts.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  const admittedMoney = new Set(admitted.flatMap(moneyCentsIn));
  const admittedFolded = admitted.map(fold);
  const admittedText = fold(admitted.join(' | '));
  const unsupportedClaims: string[] = [];
  for (const claim of moneyClaims(text)) {
    // A figure is supported when its cents match tool money (or a raw tool
    // number holding cents), OR its reais value matches a raw tool number
    // holding reais (e.g. an invoice total `999` against "999 reais").
    // A19-GROUND-FIX2: the reais arm consults ONLY reais-denominated
    // fields — a `*cents` field never grounds a reais reading.
    // A19-GROUND-EVIDENCE: OR its cents match money parsed from admitted
    // block text with the same string-support matchers — the cents
    // comparison keeps the FIX2 unit discipline on the attachment side.
    if (!supportedMoney.has(claim.cents) && !supportedNumbers.has(claim.cents) && !supportedReaisNumbers.has(claim.reais) && !admittedMoney.has(claim.cents)) {
      unsupportedClaims.push(`R$ ${claim.cents}`);
    }
  }
  for (const percent of percentages(text)) {
    if (!supportedNumbers.has(percent) && !supportedMoney.has(percent)) unsupportedClaims.push(`${percent}%`);
  }
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
    if (!toolMatched && !admittedMatched) unsupportedClaims.push(date);
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
  }
  return { valid: unsupportedClaims.length === 0, unsupportedClaims };
};
