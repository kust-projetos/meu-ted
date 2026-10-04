export type ParsedMutation =
  | { kind: 'expense' | 'income'; amountCents: number; description: string; date: string; categoryQuery?: string }
  | { kind: 'none'; reason: 'negation' | 'missing_amount' | 'unsupported' };

const bareAmountToken = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,12}(?:[.,]\d{1,2})?)`;
const explicitAmountToken = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,12}(?:,\d{1,2})?)`;
const explicitMoney = new RegExp(`r\\$\\s*(${explicitAmountToken})(?![\\d.,])`, 'i');
const verbAnchoredMoney = new RegExp(
  `\\b(?:gastei|gasto|paguei|compra|despesa|recebi|ganhei|entrou|renda|sal[aá]rio|receita|lancei|lancar|lan[cç]amento|lancamento)\\b[^\\d]*?(${bareAmountToken})(?![\\d.,])`,
  'i',
);
const secondAmountConnector = new RegExp(
  String.raw`(?:\be\b|\bmais\b|\+)\s*(?:r\$\s*)?(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d.,])`,
  'i',
);
const monetaryLabel = String.raw`(?:gorjeta|taxa|juros|tarifa|multa|adicional|extra|desconto|parcela|comiss[aã]o)s?`;
const labelQualifier = String.raw`(?:de|da|do|das|dos|a|o|as|os|uma|um|umas|uns)`;
const monetaryAmount = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const commaImmediateSecondAmount = new RegExp(
  String.raw`,\s*(?:r\$\s*)?${monetaryAmount}(?![\d.,\/])`,
  'i',
);
const commaLabelledSecondAmount = new RegExp(
  String.raw`,\s*(?:r\$\s*)?(?:${labelQualifier}\s+)?${monetaryLabel}\s+(?:${labelQualifier}\s+)?(?:r\$\s*)?${monetaryAmount}(?![\d.,\/])`,
  'i',
);
const secondAmountConnectorLabelled = new RegExp(
  String.raw`(?:\be\b|\bmais\b|\+)\s*(?:r\$\s*)?(?:${labelQualifier}\s+)?${monetaryLabel}\s+(?:${labelQualifier}\s+)?(?:r\$\s*)?${monetaryAmount}(?![\d.,\/])`,
  'i',
);
const preAmountConnector = /(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:\be\b|\bmais\b|\+)\s*$/i;
const firstFiniteVerb = /\b(?:gastei|gasto|paguei|recebi|ganhei|entrou|lancei|lancar)\b/i;
const scopedPriorAmountConnector = new RegExp(
  String.raw`(?<![\d\w.,])(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s+[A-Za-zÀ-ÿ]+){0,8}\s*(?:\be\b|\bmais\b|\+)\s*$`,
  'i',
);
const finiteMutationVerb = /\b(?:gastei|gasto|paguei|recebi|ganhei|entrou|lancei|lancar)\b/gi;
const finiteExpenseVerb = /\b(?:gastei|gasto|paguei)\b/i;
const finiteIncomeVerb = /\b(?:recebi|ganhei|entrou)\b/i;
const neutralFiniteVerb = /\b(?:lancei|lancar)\b/i;
const incomeNoun = /\b(?:renda|sal[aá]rio|receita)\b/i;
const expenseNoun = /\b(?:compra|despesa)\b/i;
const negation = /\b(n[aã]o|nunca|jamais)\b/i;
/**
 * Timezone assumed when the caller supplies no authorized one (SPEC R06: a
 * default is a visible fallback, never an authorization — callers report it as
 * `timeZoneSource: 'default'` instead of pretending it came from the user).
 */
export const DEFAULT_FINANCIAL_TIME_ZONE = 'America/Sao_Paulo';
const dateFor = (text: string, now = new Date(), timeZone = DEFAULT_FINANCIAL_TIME_ZONE): string => {
  const base = new Date(new Intl.DateTimeFormat('en-CA', { timeZone }).format(now) + 'T12:00:00Z');
  if (/anteontem/i.test(text)) base.setUTCDate(base.getUTCDate() - 2);
  else if (/ontem/i.test(text)) base.setUTCDate(base.getUTCDate() - 1);
  return base.toISOString().slice(0, 10);
};

const cents = (raw: string): number => {
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : /^\d{1,3}(?:\.\d{3})+$/.test(raw)
      ? raw.replace(/\./g, '')
      : raw;
  const [whole, fraction = ''] = normalized.split('.');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) throw new Error('invalid_amount');
  const total = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid_amount');
  return Number(total);
};

export const parseFinancialMutation = (text: string, options: { now?: Date; timeZone?: string } = {}): ParsedMutation => {
  if (negation.test(text)) return { kind: 'none', reason: 'negation' };
  const finiteCount = (text.match(finiteMutationVerb) ?? []).length;
  if (finiteCount > 1) return { kind: 'none', reason: 'unsupported' };
  if (finiteCount === 0 && incomeNoun.test(text) && expenseNoun.test(text)) return { kind: 'none', reason: 'unsupported' };
  if (neutralFiniteVerb.test(text) && !finiteExpenseVerb.test(text) && !finiteIncomeVerb.test(text) && !incomeNoun.test(text) && !expenseNoun.test(text)) return { kind: 'none', reason: 'unsupported' };
  if (neutralFiniteVerb.test(text) && incomeNoun.test(text) && expenseNoun.test(text)) return { kind: 'none', reason: 'unsupported' };
  const markers = text.match(/r\$/gi) ?? [];
  if (markers.length > 1) return { kind: 'none', reason: 'missing_amount' };
  const match = markers.length === 1 ? text.match(explicitMoney) : text.match(verbAnchoredMoney);
  if (!match) return { kind: 'none', reason: 'missing_amount' };
  const matchIndex = match.index ?? 0;
  const prefix = text.slice(Math.max(0, matchIndex - 48), matchIndex);
  if (preAmountConnector.test(prefix)) return { kind: 'none', reason: 'unsupported' };
  const verbIndex = firstFiniteVerb.exec(text)?.index;
  const scopedPrefix = verbIndex !== undefined ? text.slice(verbIndex, matchIndex) : prefix;
  if (scopedPriorAmountConnector.test(scopedPrefix)) return { kind: 'none', reason: 'unsupported' };
  const tail = text.slice(matchIndex + match[0].length);
  if (secondAmountConnector.test(tail)) return { kind: 'none', reason: 'unsupported' };
  if (secondAmountConnectorLabelled.test(tail)) return { kind: 'none', reason: 'unsupported' };
  if (commaImmediateSecondAmount.test(tail)) return { kind: 'none', reason: 'unsupported' };
  if (commaLabelledSecondAmount.test(tail)) return { kind: 'none', reason: 'unsupported' };
  let amountCents: number;
  try { amountCents = cents(match[1]!); } catch { return { kind: 'none', reason: 'missing_amount' }; }
  const income = finiteExpenseVerb.test(text) ? false : finiteIncomeVerb.test(text) ? true : incomeNoun.test(text);
  const remainder = text.slice((match.index ?? 0) + match[0].length)
    .replace(/^\s*(em|de|do|da|no|na|por)\s+/i, '').replace(/\s+(ontem|hoje|anteontem)$/i, '').trim();
  const description = remainder || (income ? 'receita' : 'despesa');
  return { kind: income ? 'income' : 'expense', amountCents, description, date: dateFor(text, options.now, options.timeZone), ...( /\b(categoria|categoria de)\s+([^,.;]+)/i.exec(text)?.[2] ? { categoryQuery: /\b(categoria|categoria de)\s+([^,.;]+)/i.exec(text)![2]!.trim() } : {}) };
};

export const parseMoneyToCents = (value: string): number => {
  const stripped = value.replace(/^r\$\s*/i, '').trim();
  if (/^r\$\s*/i.test(value) && !/^(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,12}(?:,\d{1,2})?)$/.test(stripped)) throw new Error('invalid_amount');
  return cents(stripped);
};
export const parseMutationRequest = parseFinancialMutation;

/**
 * A07/AC14: resolves a bare relative-date fragment ("hoje", "ontem",
 * "anteontem") through the SAME `dateFor` the parser uses, so a
 * continuation turn that only says "ontem" corrects the draft's date with
 * one implementation and one timezone. Returns undefined when the text names
 * no relative date — never a guess.
 */
export const resolveRelativeDate = (text: string, options: { now?: Date; timeZone?: string } = {}): string | undefined => {
  const token = /\b(anteontem|ontem|hoje)\b/i.exec(text)?.[1];
  if (!token) return undefined;
  return dateFor(token, options.now, options.timeZone);
};

/**
 * A07/AC14 (review fix 4) — the date FRAGMENT is only ever applied when the
 * turn names EXACTLY ONE relative date. `resolveRelativeDate` used to take the
 * FIRST token, so "ontem ou hoje" silently chose `ontem`; that is a guess, not
 * a fragment, and it is now an honest `'ambiguous'` for the caller to clarify.
 *
 * The single date is still resolved through {@link resolveRelativeDate}, i.e.
 * the parser's own `dateFor` and timezone — one implementation, one calendar.
 */
export type RelativeDateFragment = Readonly<
  { status: 'date'; date: string } | { status: 'none' } | { status: 'ambiguous' }
>;

const RELATIVE_DATE_TOKENS = /\b(anteontem|ontem|hoje)\b/giu;

export const resolveRelativeDateFragment = (
  text: string,
  options: { now?: Date; timeZone?: string } = {},
): RelativeDateFragment => {
  const distinct = new Set([...text.matchAll(RELATIVE_DATE_TOKENS)].map((match) => match[0]!.toLowerCase()));
  if (distinct.size === 0) return Object.freeze({ status: 'none' as const });
  if (distinct.size > 1) return Object.freeze({ status: 'ambiguous' as const });
  const date = resolveRelativeDate(text, options);
  return date ? Object.freeze({ status: 'date' as const, date }) : Object.freeze({ status: 'none' as const });
};

/** Shared mutation-utterance signal (SPEC §7.6): one definition for router + plan builder. */
export const isClearlyMutating = (text: string): boolean =>
  /\b(gastei|gasto|paguei|compra|despesa|recebi|ganhei|renda|sal[aá]rio|receita|lancei|lancar|lançamento|lancamento)\b/i.test(text);
