/**
 * F2-A1 supplied input context — hands the candidate the SAME observable
 * context the F1 corpus supplied to system A, per case and per turn.
 *
 * This is NOT a session system and performs no I/O. It is a frozen, hand
 * authored description of what the interpreter is allowed to see:
 *
 *  - `currentText`: the human message of this turn (exact frozen text);
 *  - `history`: only the prior turns/exchanges the case authorizes;
 *  - `accounts` / `categories`: synthetic catalogs (no production IDs);
 *  - `displayedOptions`: the exact ordered options shown to the user, with
 *    stable positions, so "a primeira" can bind deterministically;
 *  - `priorTransactions`: synthetic ledger references, empty when the POC
 *    has no ledger;
 *  - `suppliedValues`: values already known from earlier turns;
 *  - `resolvableFields`: fields that MUST NOT be re-asked because the
 *    supplied context already answers them;
 *  - `referenceDate`: frozen at `2026-10-24`, matching F1 derived dates.
 *
 * The runner reports this object on every result row and compares candidate
 * entity/args IDs against these allowed synthetic entities.
 */

export type F2A1ContextAccount = Readonly<{ id: string; name: string; kind: string }>;
export type F2A1ContextCategory = Readonly<{ id: string; name: string; kind: string }>;
export type F2A1DisplayedOption = Readonly<{
  position: number;
  label: string;
  name: string;
  accountId?: string;
}>;
export type F2A1PriorTransaction = Readonly<{ id: string; description: string }>;

export type F2A1InputContext = Readonly<{
  caseId: string;
  turnIndex?: number;
  currentText: string;
  referenceDate: '2026-10-24';
  history: readonly Readonly<{ role: 'user' | 'assistant'; text: string }>[];
  accounts: readonly F2A1ContextAccount[];
  categories: readonly F2A1ContextCategory[];
  displayedOptions: readonly F2A1DisplayedOption[];
  priorTransactions: readonly F2A1PriorTransaction[];
  suppliedValues: Readonly<Record<string, string | number>>;
  resolvableFields: readonly string[];
}>;

const MAIN_ACCOUNT: F2A1ContextAccount = Object.freeze({
  id: '10000000-0000-4000-8000-000000000003',
  name: 'Conta principal',
  kind: 'bank',
});
const AURORA_FIRST: F2A1ContextAccount = Object.freeze({
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Aurora',
  kind: 'bank',
});
const AURORA_SECOND: F2A1ContextAccount = Object.freeze({
  id: '10000000-0000-4000-8000-000000000002',
  name: 'Aurora',
  kind: 'bank',
});
const MERCADO_CATEGORY: F2A1ContextCategory = Object.freeze({
  id: '20000000-0000-4000-8000-000000000003',
  name: 'Mercado',
  kind: 'expense',
});

const EMPTY = Object.freeze([]) as readonly never[];

const context = (
  caseId: string,
  currentText: string,
  overrides: Partial<Omit<F2A1InputContext, 'caseId' | 'currentText' | 'referenceDate'>> = {},
): F2A1InputContext =>
  Object.freeze({
    caseId,
    currentText,
    referenceDate: '2026-10-24',
    history: EMPTY,
    accounts: EMPTY,
    categories: EMPTY,
    displayedOptions: EMPTY,
    priorTransactions: EMPTY,
    suppliedValues: Object.freeze({}),
    resolvableFields: EMPTY,
    ...overrides,
  });

const turnKey = (journeyId: string, turnIndex: number): string => `${journeyId}:T${turnIndex + 1}`;

/** 13 single-turn scenarios (6 critical + 7 semantic extensions). */
const SCENARIO_INPUTS: Readonly<Record<string, F2A1InputContext>> = Object.freeze({
  'F1-B005': context('F1-B005', 'Quais contas tenho que pagar'),
  'F1-B010': context('F1-B010', 'Mostre minhas faturas'),
  'F1-B012': context('F1-B012', 'Crie um orçamento de alimentação de 500 reais', {
    suppliedValues: Object.freeze({ amountCents: 50000, capability: 'budgets.create' }),
  }),
  'F1-B017': context('F1-B017', 'Quanto gastei em 2020?', {
    suppliedValues: Object.freeze({ year: 2020 }),
  }),
  'F1-B036': context('F1-B036', 'Me diga o total das despesas do mês atual', {
    suppliedValues: Object.freeze({ currentYearMonth: '2026-10' }),
    resolvableFields: Object.freeze(['period']),
  }),
  'F1-B058': context('F1-B058', 'Gastei R$ 20 em 2020', {
    suppliedValues: Object.freeze({ amountCents: 2000, year: 2020 }),
    resolvableFields: Object.freeze(['amount']),
  }),
  'F2A1-B013-catalog': context('F2A1-B013-catalog', 'Registre uma despesa de R$ 25,00 no mercado', {
    accounts: Object.freeze([MAIN_ACCOUNT]),
    categories: Object.freeze([MERCADO_CATEGORY]),
    suppliedValues: Object.freeze({ date: '2026-10-24' }),
    resolvableFields: Object.freeze(['account', 'category', 'date']),
  }),
  'F2A1-B015-colloquial': context('F2A1-B015-colloquial', 'Anotei cinquenta reais de carne', {
    suppliedValues: Object.freeze({ amountCents: 5000 }),
    resolvableFields: Object.freeze(['amount']),
  }),
  'F2A1-B027-approx': context('F2A1-B027-approx', 'Gastei uns 50 com carne'),
  'F2A1-B006-reference': context('F2A1-B006-reference', 'Corrija valor daquele gasto', {
    history: Object.freeze([
      Object.freeze({ role: 'user' as const, text: 'Gastei R$ 50,00 com carne' }),
      Object.freeze({ role: 'assistant' as const, text: 'Qual lançamento devo corrigir?' }),
    ]),
  }),
  'F2A1-B016-homonyms': context('F2A1-B016-homonyms', 'Renomeie Aurora para Reserva', {
    accounts: Object.freeze([AURORA_FIRST, AURORA_SECOND]),
  }),
  'F2A1-B021-correction': context('F2A1-B021-correction', 'Foi 75, não 50', {
    history: Object.freeze([
      Object.freeze({ role: 'user' as const, text: 'Gastei R$ 50,00 com carne' }),
    ]),
    suppliedValues: Object.freeze({ priorAmountCents: 5000, correctedAmountCents: 7500 }),
  }),
  'F2A1-B008-concept': context('F2A1-B008-concept', 'O que é cartão de crédito?'),
});

/** 10 turns across the five evaluated journeys. */
const JOURNEY_INPUTS: Readonly<Record<string, F2A1InputContext>> = Object.freeze({
  [turnKey('J01', 0)]: context('J01', 'Gastei com carne na Conta principal categoria mercado', {
    turnIndex: 0,
    accounts: Object.freeze([MAIN_ACCOUNT]),
    categories: Object.freeze([MERCADO_CATEGORY]),
    resolvableFields: Object.freeze(['description', 'account', 'category', 'date']),
  }),
  [turnKey('J01', 1)]: context('J01', '2500', {
    turnIndex: 1,
    history: Object.freeze([
      Object.freeze({ role: 'user' as const, text: 'Gastei com carne na Conta principal categoria mercado' }),
      Object.freeze({ role: 'assistant' as const, text: 'Não identifiquei o valor a registrar. Informe o valor e a descrição.' }),
    ]),
    accounts: Object.freeze([MAIN_ACCOUNT]),
    categories: Object.freeze([MERCADO_CATEGORY]),
    suppliedValues: Object.freeze({
      amountCents: 250000,
      description: 'carne',
      accountId: MAIN_ACCOUNT.id,
      categoryId: MERCADO_CATEGORY.id,
      date: '2026-10-24',
    }),
    resolvableFields: Object.freeze(['amount', 'description', 'account', 'category', 'date']),
  }),
  [turnKey('J02', 0)]: context('J02', 'Gastei 50 na Conta principal com carne', {
    turnIndex: 0,
    accounts: Object.freeze([MAIN_ACCOUNT]),
    categories: Object.freeze([MERCADO_CATEGORY]),
    suppliedValues: Object.freeze({ amountCents: 5000, description: 'carne' }),
    resolvableFields: Object.freeze(['amount', 'description', 'account', 'category', 'date']),
  }),
  [turnKey('J02', 1)]: context('J02', 'mercado', {
    turnIndex: 1,
    history: Object.freeze([
      Object.freeze({ role: 'user' as const, text: 'Gastei 50 na Conta principal com carne' }),
      Object.freeze({ role: 'assistant' as const, text: 'Qual categoria devo usar?\n• Mercado' }),
    ]),
    accounts: Object.freeze([MAIN_ACCOUNT]),
    categories: Object.freeze([MERCADO_CATEGORY]),
    suppliedValues: Object.freeze({
      amountCents: 5000,
      description: 'carne',
      accountId: MAIN_ACCOUNT.id,
      categoryId: MERCADO_CATEGORY.id,
      date: '2026-10-24',
    }),
    resolvableFields: Object.freeze(['amount', 'description', 'account', 'category', 'date']),
  }),
  [turnKey('J03', 0)]: context('J03', 'Crie conta chamada Reserva', {
    turnIndex: 0,
    resolvableFields: Object.freeze(['accountName']),
  }),
  [turnKey('J03', 1)]: context('J03', 'banco com saldo 100', {
    turnIndex: 1,
    history: Object.freeze([
      Object.freeze({ role: 'user' as const, text: 'Crie conta chamada Reserva' }),
      Object.freeze({
        role: 'assistant' as const,
        text: 'Para criar a conta, me diga o saldo inicial e o tipo (conta no banco ou dinheiro em espécie).',
      }),
    ]),
    suppliedValues: Object.freeze({
      accountName: 'Reserva',
      accountKind: 'bank',
      initialBalanceCents: 10000,
    }),
    resolvableFields: Object.freeze(['accountName', 'accountKind', 'initialBalance']),
  }),
  [turnKey('J05', 0)]: context('J05', 'Renomeie conta Aurora para Reserva', {
    turnIndex: 0,
    accounts: Object.freeze([AURORA_FIRST, AURORA_SECOND]),
  }),
  [turnKey('J05', 1)]: context('J05', 'a primeira conta Aurora', {
    turnIndex: 1,
    history: Object.freeze([
      Object.freeze({ role: 'user' as const, text: 'Renomeie conta Aurora para Reserva' }),
      Object.freeze({
        role: 'assistant' as const,
        text: 'Encontrei mais de uma conta para sua mensagem. Qual conta devo renomear?\n• Aurora\n• Aurora',
      }),
    ]),
    accounts: Object.freeze([AURORA_FIRST, AURORA_SECOND]),
    // Exact ordered options shown by the frozen F1 clarification text.
    displayedOptions: Object.freeze([
      Object.freeze({ position: 1, label: '• Aurora', name: 'Aurora', accountId: AURORA_FIRST.id }),
      Object.freeze({ position: 2, label: '• Aurora', name: 'Aurora', accountId: AURORA_SECOND.id }),
    ]),
    suppliedValues: Object.freeze({
      selectedPosition: 1,
      selectedAccountId: AURORA_FIRST.id,
      newName: 'Reserva',
    }),
    resolvableFields: Object.freeze(['account']),
  }),
  [turnKey('J09', 0)]: context('J09', 'Quanto gastei neste mês?', {
    turnIndex: 0,
    suppliedValues: Object.freeze({ currentYearMonth: '2026-10' }),
    resolvableFields: Object.freeze(['period']),
  }),
  [turnKey('J09', 1)]: context('J09', 'E no mês passado?', {
    turnIndex: 1,
    history: Object.freeze([
      Object.freeze({ role: 'user' as const, text: 'Quanto gastei neste mês?' }),
    ]),
    suppliedValues: Object.freeze({ currentYearMonth: '2026-10', previousYearMonth: '2026-09' }),
    resolvableFields: Object.freeze(['period']),
  }),
});

export const F2A1_INPUTS: Readonly<Record<string, F2A1InputContext>> = Object.freeze({
  ...SCENARIO_INPUTS,
  ...JOURNEY_INPUTS,
});

export const F2A1_INPUT_KEYS: readonly string[] = Object.freeze(Object.keys(F2A1_INPUTS));
