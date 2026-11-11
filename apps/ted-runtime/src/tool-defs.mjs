// TED runtime tool definitions — P1 read-only slice + P3 opt-in category read.
//
// Adapted after review from the runtime spike (experiments/ted-runtime):
// keeps the proven host-bound contract (identity never in tool args, stable
// intentionId in opts, fail-closed typed errors) but ships ONLY the two P2
// reads by default: list_accounts + get_month_summary. list_categories is the
// bounded P3 prerequisite (category resolution for a FUTURE expense proposal):
// it lives in TOOL_DEFS so args/routing/shape/executors are pinned, yet the
// product catalog (plugin.mjs productToolDefs) exposes it ONLY under the local
// opt-in TED_OPENCODE_P3_READS_ENABLED=1 with NODE_ENV !== 'production'.
// Explicitly NOT present: confirm/execute/approve tools, PG/synthetic
// bridges, seeds, traces, runners (see README + inventory notes). The P3
// write slice adds `propose_expense`, which records a PROPOSAL INTENT only —
// it never calls the API and the LLM can never confirm or execute. P3.2 adds
// `propose_income` on the SAME intent-only contract (the API already accepts
// `transactions.income.create`); the shared executor below keeps one code path.
// P3.3 adds `propose_transfer` (internal transfer, from/to accounts, no
// category) on that same intent-only contract.

import { createHash } from 'node:crypto';

export class ToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
    if (details && typeof details.statusCode === 'number') this.statusCode = details.statusCode;
  }
}

// Stable financial intention: deterministic `int-<sha256-32hex>` over
// sessionID + NUL + messageID. Retries re-derive the same intention; the
// volatile native CallID is correlation only and never perturbs derivation.
export function deriveIntentionId(input = {}) {
  const { sessionID, messageID, clientMessageId, callID, ...rest } = input || {};
  void callID;
  void rest;
  const message = messageID !== undefined ? messageID : clientMessageId;
  if (typeof sessionID !== 'string' || sessionID.length === 0) {
    throw new ToolError('tool.invalid_args', 'deriveIntentionId: sessionID (string, non-empty) is required');
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new ToolError('tool.invalid_args', 'deriveIntentionId: messageID (or clientMessageId) (string, non-empty) is required');
  }
  const digest = createHash('sha256')
    .update(sessionID, 'utf8')
    .update('\0', 'utf8')
    .update(message, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `int-${digest}`;
}

export const TOOL_DEFS = [
  {
    name: 'list_accounts',
    description: 'TED read-only: list workspace accounts via GET /accounts (identity-scoped server-side).',
    input: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['bank', 'cash', 'credit_card'] },
        includeInactive: { type: 'string', enum: ['true', 'false'] },
      },
      required: [],
      additionalProperties: false,
    },
    // Native 2.2.4 prompt-loop requires an output schema whenever execute()
    // returns {output} (proven in spike 03B-T1).
    output: { type: 'object', description: 'Real GET /accounts body ({items, total}).' },
  },
  {
    // P4 CORE parity (opt-in only — see plugin.mjs isP3ReadsEnabled): recent
    // transactions via the exact existing API route GET /transactions
    // (transactionFiltersSchema). Read-only; filters pass through to the real
    // API, which owns domain validation.
    name: 'list_recent_transactions',
    description: 'TED read-only: list transactions via GET /transactions (identity-scoped server-side).',
    input: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts' },
        categoryId: { type: 'string', description: 'Category uuid resolved from list_categories' },
        kind: { type: 'string', enum: ['expense', 'income', 'transfer'] },
        startDate: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
        endDate: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
        minAmountCents: { type: 'integer', minimum: 0 },
        maxAmountCents: { type: 'integer', minimum: 0 },
        query: { type: 'string', description: 'Free-text query (max 120 chars)' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0, maximum: 100000 },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /transactions body ({items, total, limit, offset}).' },
  },
  {
    // P4 CORE parity (opt-in only — see plugin.mjs isP3ReadsEnabled): spending
    // insights via the exact existing API route GET /insights/spending
    // (spendingInsightQuerySchema). Read-only.
    name: 'spending_insights',
    description: 'TED read-only: spending insights via GET /insights/spending (identity-scoped server-side).',
    input: {
      type: 'object',
      properties: {
        yearMonth: { type: 'string', description: 'Period YYYY-MM (defaults to the current month)' },
        insightType: { type: 'string', enum: ['all', 'comparison', 'anomalies', 'income-share'] },
        lookbackMonths: { type: 'integer', minimum: 1, maximum: 12 },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /insights/spending body.' },
  },
  {
    // P3.8 (opt-in only — see plugin.mjs isP3ReadsEnabled): credit-card
    // accounts via the exact existing route GET /cards/accounts (CardStore),
    // which returns ONLY credit cards. /accounts deliberately excludes cards;
    // this tool is the correct discovery path for card ids.
    name: 'list_credit_cards',
    description: 'TED read-only (P3 opt-in): list credit-card accounts via GET /cards/accounts (identity-scoped server-side).',
    input: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /cards/accounts body ({items, total}).' },
  },
  {
    name: 'get_month_summary',
    description: 'TED read-only: month totals via GET /dashboard/month-summary?yearMonth=YYYY-MM.',
    input: {
      type: 'object',
      properties: {
        yearMonth: { type: 'string', description: 'Effective period YYYY-MM' },
      },
      required: ['yearMonth'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /dashboard/month-summary body.' },
  },
  {
    // P3 prerequisite (opt-in only — see plugin.mjs isP3ReadsEnabled): category
    // lookup for a future expense proposal via the exact existing API route
    // GET /categories?kind=expense|income (categories.ts:59-68). Read-only.
    name: 'list_categories',
    description: 'TED read-only (P3 opt-in): category lookup via GET /categories (identity-scoped server-side).',
    input: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['expense', 'income'] },
      },
      required: [],
      additionalProperties: false,
    },
    // Native 2.2.4 prompt-loop requires an output schema whenever execute()
    // returns {output} (proven in spike 03B-T1).
    output: { type: 'object', description: 'Real GET /categories body ({items, total}).' },
  },
  {
    // P3.6 statement-payment prerequisite (opt-in only — see plugin.mjs
    // isP3ReadsEnabled): the real GET /cards/statements route with an optional
    // card filter. Read-only; the model resolves the card via list_credit_cards
    // and the invoice id here — never invented.
    name: 'list_card_statements',
    description: 'TED read-only (P3 opt-in): credit-card statements via GET /cards/statements, optionally filtered by card.',
    input: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Credit-card account uuid resolved from list_credit_cards (optional)' },
        status: { type: 'string', enum: ['open', 'closed', 'paid', 'partial', 'overdue', 'cancelled'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /cards/statements body ({items, total}).' },
  },
  {
    // V1 completion (opt-in read set — see plugin.mjs isP3ReadsEnabled):
    // analytics KPIs via the exact existing GET /analytics/kpis route. Every
    // filter is passed through; the API owns period/date validation and the
    // proof envelope.
    name: 'analytics_kpis',
    description: 'TED read-only: financial KPIs (balances, income/expense, savings rate, invoices) via GET /analytics/kpis.',
    input: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['last30days', 'lastMonth', 'thisYear', 'custom'] },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (required for period=custom)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (required for period=custom)' },
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts (optional scope)' },
        basis: { type: 'string', enum: ['liquidez', 'competencia'] },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /analytics/kpis body with proof envelope.' },
  },
  {
    // V1 completion: category breakdown via GET /analytics/category-breakdown.
    name: 'analytics_category_breakdown',
    description: 'TED read-only: expense/income totals by category via GET /analytics/category-breakdown.',
    input: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['last30days', 'lastMonth', 'thisYear', 'custom'] },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (required for period=custom)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (required for period=custom)' },
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts (optional scope)' },
        basis: { type: 'string', enum: ['liquidez', 'competencia'] },
        kind: { type: 'string', enum: ['expense', 'income'] },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /analytics/category-breakdown body with proof envelope.' },
  },
  {
    // V1 completion: cash-flow series via GET /analytics/cashflow-series.
    name: 'analytics_cashflow_series',
    description: 'TED read-only: daily cash-flow series (current and previous period) via GET /analytics/cashflow-series.',
    input: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['last30days', 'lastMonth', 'thisYear', 'custom'] },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (required for period=custom)' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (required for period=custom)' },
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts (optional scope)' },
        basis: { type: 'string', enum: ['liquidez', 'competencia'] },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /analytics/cashflow-series body with proof envelope.' },
  },
  {
    // V1 completion: budget consumption via GET /analytics/budget-consumption.
    // Household-only and basis-free by contract; the route is intentionally
    // argument-free so no unsupported filter can be invented here.
    name: 'analytics_budget_consumption',
    description: 'TED read-only: current budget consumption (household scope) via GET /analytics/budget-consumption.',
    input: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { type: 'object', description: 'Real GET /analytics/budget-consumption body with proof envelope.' },
  },
  {
    // V1 completion: net-worth history via GET /analytics/net-worth-history.
    name: 'analytics_net_worth_history',
    description: 'TED read-only: 12-month net-worth history via GET /analytics/net-worth-history.',
    input: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts (optional scope)' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /analytics/net-worth-history body with proof envelope.' },
  },
  {
    // V1 completion: budgets via GET /budgets.
    name: 'list_budgets',
    description: 'TED read-only: list workspace budgets with usage/limits via GET /budgets.',
    input: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { type: 'object', description: 'Real GET /budgets body ({items, total}).' },
  },
  {
    // V1 completion: budgets at/over the alert threshold via GET /budgets/check.
    name: 'check_budgets',
    description: 'TED read-only: budgets whose spending reached the alert threshold via GET /budgets/check.',
    input: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { type: 'object', description: 'Real GET /budgets/check body ({items, total}).' },
  },
  {
    // V1 completion: budget trends via GET /budgets/:id/trends.
    name: 'budget_trends',
    description: 'TED read-only: monthly trend for one budget via GET /budgets/:id/trends.',
    input: {
      type: 'object',
      properties: {
        budgetId: { type: 'string', description: 'Budget uuid resolved from list_budgets' },
        monthsBack: { type: 'integer', minimum: 1, maximum: 12 },
      },
      required: ['budgetId'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /budgets/:id/trends body ({items, total}).' },
  },
  {
    // V1 completion: goals and progress via GET /goals.
    name: 'list_goals',
    description: 'TED read-only: list financial goals with progress via GET /goals.',
    input: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { type: 'object', description: 'Real GET /goals body ({items, total}).' },
  },
  {
    // V1 completion: payables/upcoming bills via GET /payables.
    name: 'list_payables',
    description: 'TED read-only: list accounts payable (pending, paid, overdue, cancelled) via GET /payables.',
    input: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'paid', 'overdue', 'cancelled'] },
        type: { type: 'string', enum: ['one_time', 'recurring'] },
        dueWithinDays: { type: 'integer', minimum: 0, maximum: 365 },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /payables body ({items, total}).' },
  },
  {
    // V1 completion: payable reminders via GET /payables/reminders.
    name: 'payable_reminders',
    description: 'TED read-only: upcoming/overdue payable reminders via GET /payables/reminders.',
    input: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: { type: 'object', description: 'Real GET /payables/reminders body ({items, total}).' },
  },
  {
    // V1 completion: audit history via GET /audit-logs.
    name: 'list_audit_logs',
    description: 'TED read-only: workspace audit history (operations and receipts) via GET /audit-logs.',
    input: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        operation: { type: 'string' },
        eventType: { type: 'string' },
        actorType: { type: 'string', enum: ['device', 'user'] },
        entityType: { type: 'string' },
        entityId: { type: 'string', description: 'Entity uuid' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /audit-logs body ({items, total}).' },
  },
  {
    // P3 write slice (local opt-in only — see plugin.mjs isP3WritesEnabled).
    // This tool does NOT write and does NOT call the API: it records ONE
    // proposal intent (tool + normalizedArgs + stable intention) that the
    // gateway hands to the authenticated PWA. The PWA sends it to the Agent
    // broker, the ONLY component allowed to mint `financial.approval.propose`
    // (A4). The API remains the authority for validation, approval and
    // execution; the LLM can never confirm or execute.
    name: 'propose_expense',
    description:
      'TED (P3 opt-in): propose an expense for the authenticated user to approve. Records a pending proposal only — never creates the transaction. If the user gives a partial/ambiguous date (e.g. "15/03") and the year cannot be determined from context, ask for clarification instead of guessing; resolve account/category by authoritative reads and ask when more than one fits.',
    input: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', minimum: 1, description: 'Positive amount in cents (BRL)' },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        date: { type: 'string', description: 'Expense date YYYY-MM-DD (defaults to today UTC)' },
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts' },
        categoryId: { type: 'string', description: 'Expense category uuid resolved from list_categories' },
      },
      required: ['amountCents', 'description', 'accountId', 'categoryId'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // P3.2 income slice — same contract as propose_expense, different tool.
    // The API already accepts `transactions.income.create` through the existing
    // Pending V2 tool registry; this tool only records the intent.
    name: 'propose_income',
    description:
      'TED (P3 opt-in): propose an income for the authenticated user to approve. Records a pending proposal only — never creates the transaction. Use the same date/ambiguity rule: an undeterminable year or more than one matching account/category requires clarification before proposing.',
    input: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', minimum: 1, description: 'Positive amount in cents (BRL)' },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        date: { type: 'string', description: 'Income date YYYY-MM-DD (defaults to today UTC)' },
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts' },
        categoryId: { type: 'string', description: 'Income category uuid resolved from list_categories' },
      },
      required: ['amountCents', 'description', 'accountId', 'categoryId'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // P3.4 card purchase slice — same intent-only contract, card purchase tool.
    // Card identified via list_credit_cards; categoryId optional.
    name: 'propose_card_purchase',
    description:
      'TED (P3 opt-in): propose a credit-card purchase for the authenticated user to approve, either single (1x) or in installments. Records a pending proposal only — never creates the purchase. Resolve the card via list_credit_cards; if the date year or the card is ambiguous, ask before proposing.',
    input: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', minimum: 1, description: 'TOTAL purchase amount in cents (BRL), never a per-parcel amount' },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        date: { type: 'string', description: 'Purchase date YYYY-MM-DD (defaults to today UTC)' },
        accountId: { type: 'string', description: 'Credit-card account uuid resolved from list_credit_cards' },
        categoryId: { type: 'string', description: 'Expense category uuid resolved from list_categories (optional)' },
        installmentsTotal: { type: 'integer', minimum: 1, maximum: 48, description: 'Number of installments (1–48). Omit or 1 for a single purchase; amountCents stays the TOTAL.' },
      },
      required: ['amountCents', 'description', 'accountId'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // P3.3 internal transfer — same intent-only contract. NO category: a
    // transfer between the user's own accounts is neither income nor expense.
    // Both ids are resolved from list_accounts; the API revalidates workspace
    // scope, same-account and the credit-card restriction at propose/execute.
    name: 'propose_transfer',
    description:
      'TED (P3 opt-in): propose an internal transfer between two of the user\'s accounts. Records a pending proposal only — never moves money. Both accounts are resolved from list_accounts; ask when ambiguous or when the date year is undeterminable.',
    input: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', minimum: 1, description: 'Positive amount in cents (BRL)' },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        date: { type: 'string', description: 'Transfer date YYYY-MM-DD (defaults to today UTC)' },
        fromAccountId: { type: 'string', description: 'Source account uuid resolved from list_accounts' },
        toAccountId: { type: 'string', description: 'Destination account uuid resolved from list_accounts' },
      },
      required: ['amountCents', 'description', 'fromAccountId', 'toAccountId'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // P3.6 statement payment — same intent-only contract. The invoice id and
    // the payer account id come from the real reads; amountCents is the exact
    // amount paid NOW (total = the authoritative remaining balance, resolved
    // by the reader — never a "total" sentinel).
    name: 'propose_statement_payment',
    description:
      'TED (P3 opt-in): propose a total or partial credit-card statement payment for the authenticated user to approve. Records a pending proposal only — never pays the invoice.',
    input: {
      type: 'object',
      properties: {
        statementId: { type: 'string', description: 'Statement uuid resolved from list_card_statements' },
        fromAccountId: { type: 'string', description: 'Payer account uuid resolved from list_accounts (bank/cash, never credit_card)' },
        amountCents: { type: 'integer', minimum: 1, description: 'Exact amount paid now in cents (BRL). For a total payment use the statement remaining balance.' },
      },
      required: ['statementId', 'fromAccountId', 'amountCents'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // P4.2 account creation — same intent-only contract. The API validates
    // kind (bank|cash) and the signed initial balance; there is no CAS
    // precondition. The model never confirms or executes.
    name: 'propose_account_create',
    description:
      'TED (P4 opt-in): propose creating a bank/cash account for the authenticated user to approve. Records a pending proposal only — never creates the account.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        kind: { type: 'string', enum: ['bank', 'cash'] },
        initialBalanceCents: { type: 'integer', description: 'Signed initial balance in cents (BRL); 0 for an empty account' },
      },
      required: ['name', 'kind', 'initialBalanceCents'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // P4.2 category creation — same intent-only contract. No CAS precondition.
    // The optional parent is resolved from list_categories; the API revalidates
    // kind/parent against the workspace catalog.
    name: 'propose_category_create',
    description:
      'TED (P4 opt-in): propose creating an expense/income category for the authenticated user to approve. Records a pending proposal only — never creates the category.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        kind: { type: 'string', enum: ['expense', 'income'] },
        parentId: { type: 'string', description: 'Parent category uuid resolved from list_categories (optional)' },
      },
      required: ['name', 'kind'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // V1 completion (opt-in writes): create an accounts-payable commitment.
    // The API's Pending V2 `payables.create` contract revalidates account,
    // category and dates at execution.
    name: 'propose_payable_create',
    description:
      'TED (opt-in): propose creating an accounts-payable (bill) for the authenticated user to approve. Records a pending proposal only — never creates the payable. If the due date lacks a determinable year or the payer account is ambiguous, ask before proposing.',
    input: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Payer account uuid resolved from list_accounts' },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        amountCents: { type: 'integer', minimum: 1, description: 'Positive amount in cents (BRL)' },
        dueDate: { type: 'string', description: 'Due date YYYY-MM-DD' },
        categoryId: { type: 'string', description: 'Expense category uuid resolved from list_categories (optional)' },
      },
      required: ['accountId', 'description', 'amountCents', 'dueDate'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // V1 completion (opt-in writes): pay an existing accounts-payable. The
    // display tuple (description/amount/dueDate/accountId) must come from the
    // authoritative list_payables read; payableId is the only execution key.
    name: 'propose_payable_pay',
    description:
      'TED (opt-in): propose paying an accounts-payable for the authenticated user to approve. Records a pending proposal only — never pays the bill.',
    input: {
      type: 'object',
      properties: {
        payableId: { type: 'string', description: 'Payable uuid resolved from list_payables' },
        description: { type: 'string', minLength: 1, maxLength: 240, description: 'Payable description read from list_payables (display/CAS snapshot)' },
        amountCents: { type: 'integer', minimum: 1, description: 'Payable amount in cents read from list_payables' },
        dueDate: { type: 'string', description: 'Payable due date YYYY-MM-DD read from list_payables' },
        accountId: { type: 'string', description: 'Payer account uuid read from the payable' },
        paidDate: { type: 'string', description: 'Payment date YYYY-MM-DD (defaults to today UTC)' },
      },
      required: ['payableId', 'description', 'amountCents', 'dueDate', 'accountId'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // V1 CRUD completion (opt-in writes): description-only transaction edit.
    // The API's transactions.update contract accepts ONLY the description and
    // an exact expectedDescription CAS; amount/date/account/category are never
    // part of this tool.
    name: 'propose_transaction_update',
    description:
      'TED (opt-in): propose changing only the description of an existing transaction for the authenticated user to approve. Records a pending proposal only — never edits the transaction.',
    input: {
      type: 'object',
      properties: {
        transactionId: { type: 'string', description: 'Transaction uuid resolved from list_recent_transactions' },
        description: { type: 'string', minLength: 1, maxLength: 240, description: 'New description' },
        expectedDescription: { type: 'string', minLength: 1, maxLength: 240, description: 'Current description read from the authoritative transaction list (CAS)' },
      },
      required: ['transactionId', 'description', 'expectedDescription'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // V1 CRUD completion (opt-in writes): account rename, name-only + CAS.
    name: 'propose_account_update',
    description:
      'TED (opt-in): propose renaming an existing account for the authenticated user to approve. Records a pending proposal only — never renames the account.',
    input: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts' },
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'New account name' },
        expectedName: { type: 'string', minLength: 1, maxLength: 120, description: 'Current account name read from list_accounts (CAS)' },
      },
      required: ['accountId', 'name', 'expectedName'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // V1 CRUD completion (opt-in writes): account deactivation. The API binds
    // the target by accountId; accountName is display-only (never a CAS key).
    name: 'propose_account_deactivate',
    description:
      'TED (opt-in): propose deactivating an existing account for the authenticated user to approve. Records a pending proposal only — never deactivates the account.',
    input: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Account uuid resolved from list_accounts' },
        accountName: { type: 'string', minLength: 1, maxLength: 120, description: 'Current account name (display-only snapshot)' },
      },
      required: ['accountId'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // V1 CRUD completion (opt-in writes): category rename, name-only + CAS.
    name: 'propose_category_update',
    description:
      'TED (opt-in): propose renaming an existing category for the authenticated user to approve. Records a pending proposal only — never renames the category.',
    input: {
      type: 'object',
      properties: {
        categoryId: { type: 'string', description: 'Category uuid resolved from list_categories' },
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'New category name' },
        expectedName: { type: 'string', minLength: 1, maxLength: 120, description: 'Current category name read from list_categories (CAS)' },
      },
      required: ['categoryId', 'name', 'expectedName'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
  {
    // V1 CRUD completion (opt-in writes): category deactivation + CAS.
    name: 'propose_category_deactivate',
    description:
      'TED (opt-in): propose deactivating an existing category for the authenticated user to approve. Records a pending proposal only — never deactivates the category.',
    input: {
      type: 'object',
      properties: {
        categoryId: { type: 'string', description: 'Category uuid resolved from list_categories' },
        expectedName: { type: 'string', minLength: 1, maxLength: 120, description: 'Current category name read from list_categories (CAS)' },
      },
      required: ['categoryId', 'expectedName'],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Proposal status ({status:"proposed", summary}) — never execution.' },
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((d) => d.name);

// Single source for the intent-only proposal tools: the runtime tool name maps
// to the exact tool the API's Pending V2 registry accepts.
export const PROPOSAL_TOOL_SPECS = Object.freeze({
  propose_expense: Object.freeze({ tool: 'transactions.expense.create', noun: 'Despesa' }),
  propose_income: Object.freeze({ tool: 'transactions.income.create', noun: 'Receita' }),
  propose_card_purchase: Object.freeze({ tool: 'cards.purchase.create', noun: 'Compra no cartão' }),
  propose_transfer: Object.freeze({ tool: 'transactions.transfer.create', noun: 'Transferência' }),
  propose_statement_payment: Object.freeze({ tool: 'cards.statement.pay', noun: 'Pagamento de fatura' }),
  propose_account_create: Object.freeze({ tool: 'accounts.create', noun: 'Conta' }),
  propose_category_create: Object.freeze({ tool: 'categories.create', noun: 'Categoria' }),
  propose_transaction_update: Object.freeze({ tool: 'transactions.update', noun: 'Descrição do lançamento' }),
  propose_account_update: Object.freeze({ tool: 'accounts.update', noun: 'Conta' }),
  propose_account_deactivate: Object.freeze({ tool: 'accounts.deactivate', noun: 'Conta' }),
  propose_category_update: Object.freeze({ tool: 'categories.update', noun: 'Categoria' }),
  propose_category_deactivate: Object.freeze({ tool: 'categories.deactivate', noun: 'Categoria' }),
  propose_payable_create: Object.freeze({ tool: 'payables.create', noun: 'Conta a pagar' }),
  propose_payable_pay: Object.freeze({ tool: 'payables.pay', noun: 'Pagamento de conta' }),
});

// Canonical uuid shape (any version) — the API revalidates against its real
// schema; this only stops the model from recording an obviously unusable id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Identity/host keys must NEVER appear in tool args (host-bound identity).
const FORBIDDEN_KEYS = new Set([
  'actorId', 'actor_id', 'actor',
  'workspaceId', 'workspace_id', 'workspace',
  'householdId', 'household_id', 'household',
  'token', 'deviceToken', 'device_token', 'deviceId', 'device_id',
  'sessionId', 'session_id', 'intentionId', 'authorization',
  'idempotencyKey', 'idempotency_key', 'idempotency',
  'proposalHash', 'proposal_hash',
  'callId', 'call_id', 'toolCallId', 'tool_call_id',
]);

function knownKeys(name) {
  if (name === 'list_accounts') return ['kind', 'includeInactive'];
  if (name === 'list_recent_transactions') return ['accountId', 'categoryId', 'kind', 'startDate', 'endDate', 'minAmountCents', 'maxAmountCents', 'query', 'limit', 'offset'];
  if (name === 'spending_insights') return ['yearMonth', 'insightType', 'lookbackMonths'];
  if (name === 'analytics_kpis' || name === 'analytics_cashflow_series') return ['period', 'from', 'to', 'accountId', 'basis'];
  if (name === 'analytics_category_breakdown') return ['period', 'from', 'to', 'accountId', 'basis', 'kind'];
  if (name === 'analytics_net_worth_history') return ['accountId'];
  if (name === 'analytics_budget_consumption') return [];
  if (name === 'budget_trends') return ['budgetId', 'monthsBack'];
  if (name === 'list_payables') return ['status', 'type', 'dueWithinDays'];
  if (name === 'list_audit_logs') return ['limit', 'operation', 'eventType', 'actorType', 'entityType', 'entityId'];
  if (name === 'list_budgets' || name === 'check_budgets' || name === 'list_goals' || name === 'payable_reminders') return [];
  if (name === 'list_credit_cards') return [];
  if (name === 'list_categories') return ['kind'];
  if (name === 'list_card_statements') return ['accountId', 'status', 'limit'];
  if (name === 'propose_statement_payment') return ['statementId', 'fromAccountId', 'amountCents'];
  if (name === 'propose_transaction_update') return ['transactionId', 'description', 'expectedDescription'];
  if (name === 'propose_account_update') return ['accountId', 'name', 'expectedName'];
  if (name === 'propose_account_deactivate') return ['accountId', 'accountName'];
  if (name === 'propose_category_update') return ['categoryId', 'name', 'expectedName'];
  if (name === 'propose_category_deactivate') return ['categoryId', 'expectedName'];
  if (name === 'propose_payable_create') return ['accountId', 'description', 'amountCents', 'dueDate', 'categoryId'];
  if (name === 'propose_payable_pay') return ['payableId', 'description', 'amountCents', 'dueDate', 'accountId', 'paidDate'];
  if (name === 'propose_account_create') return ['name', 'kind', 'initialBalanceCents'];
  if (name === 'propose_category_create') return ['name', 'kind', 'parentId'];
  if (name === 'propose_transfer') return ['amountCents', 'description', 'date', 'fromAccountId', 'toAccountId'];
  if (name === 'propose_card_purchase') return ['amountCents', 'description', 'date', 'accountId', 'categoryId', 'installmentsTotal'];
  if (name === 'propose_expense' || name === 'propose_income') return ['amountCents', 'description', 'date', 'accountId', 'categoryId'];
  return ['yearMonth'];
}

// Validates structure only. Domain validation (kind enum, yearMonth format)
// belongs to the real API handlers — values pass through so a 400 comes from
// the real route, never from a tool guess.
export function validateToolArgs(name, args) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new ToolError('tool.unknown', `unknown tool ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('tool.invalid_args', `${name}: args must be an object`);
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ToolError('tool.invalid_args', `${name}: forbidden key '${key}' — identity is host-bound, never a tool arg`);
    }
    if (!knownKeys(name).includes(key)) {
      throw new ToolError('tool.invalid_args', `${name}: unknown arg '${key}'`);
    }
  }
  if (name === 'get_month_summary') {
    if (typeof args.yearMonth !== 'string' || args.yearMonth.length === 0) {
      throw new ToolError('tool.invalid_args', 'get_month_summary: yearMonth (string) is required');
    }
  } else if (name === 'list_categories') {
    // Structural only (like list_accounts): the kind enum is owned by the real
    // API handler — values pass through so a 400 comes from the real route.
    if (args.kind !== undefined && typeof args.kind !== 'string') {
      throw new ToolError('tool.invalid_args', 'list_categories: kind must be a string');
    }
  } else if (name === 'list_recent_transactions') {
    // Structural only: the filter contract (transactionFiltersSchema) is owned
    // by the real API handler — values pass through so a 400 comes from the
    // real route, never from a tool guess.
    if (args.accountId !== undefined && (typeof args.accountId !== 'string' || !UUID_RE.test(args.accountId))) {
      throw new ToolError('tool.invalid_args', 'list_recent_transactions: accountId must be a uuid');
    }
    if (args.categoryId !== undefined && (typeof args.categoryId !== 'string' || !UUID_RE.test(args.categoryId))) {
      throw new ToolError('tool.invalid_args', 'list_recent_transactions: categoryId must be a uuid');
    }
    if (args.kind !== undefined && (typeof args.kind !== 'string' || !['expense', 'income', 'transfer'].includes(args.kind))) {
      throw new ToolError('tool.invalid_args', 'list_recent_transactions: kind must be expense|income|transfer');
    }
    for (const key of ['startDate', 'endDate']) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args[key])) {
          throw new ToolError('tool.invalid_args', `list_recent_transactions: ${key} must be YYYY-MM-DD`);
        }
        const parsed = new Date(`${args[key]}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== args[key]) {
          throw new ToolError('tool.invalid_args', `list_recent_transactions: ${key} must be YYYY-MM-DD`);
        }
      }
    }
    for (const key of ['minAmountCents', 'maxAmountCents']) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 0)) {
        throw new ToolError('tool.invalid_args', `list_recent_transactions: ${key} must be a non-negative safe integer`);
      }
    }
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.trim().length === 0 || args.query.trim().length > 120)) {
      throw new ToolError('tool.invalid_args', 'list_recent_transactions: query must be a non-empty string (max 120)');
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) {
      throw new ToolError('tool.invalid_args', 'list_recent_transactions: limit must be an integer between 1 and 200');
    }
    if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > 100000)) {
      throw new ToolError('tool.invalid_args', 'list_recent_transactions: offset must be an integer between 0 and 100000');
    }
  } else if (name === 'spending_insights') {
    if (args.yearMonth !== undefined && (typeof args.yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(args.yearMonth))) {
      throw new ToolError('tool.invalid_args', 'spending_insights: yearMonth must be YYYY-MM');
    }
    if (args.insightType !== undefined && (typeof args.insightType !== 'string' || !['all', 'comparison', 'anomalies', 'income-share'].includes(args.insightType))) {
      throw new ToolError('tool.invalid_args', 'spending_insights: insightType must be all|comparison|anomalies|income-share');
    }
    if (args.lookbackMonths !== undefined && (!Number.isInteger(args.lookbackMonths) || args.lookbackMonths < 1 || args.lookbackMonths > 12)) {
      throw new ToolError('tool.invalid_args', 'spending_insights: lookbackMonths must be an integer between 1 and 12');
    }
  } else if (name === 'analytics_kpis' || name === 'analytics_cashflow_series' || name === 'analytics_category_breakdown' || name === 'analytics_net_worth_history' || name === 'analytics_budget_consumption') {
    // Structural only: the analytics query contract (period presets, custom
    // from/to, account scope, basis support per route) is owned by the real
    // API handler. These checks stop the model recording an unusable intent.
    if (args.period !== undefined && (typeof args.period !== 'string' || !['last30days', 'lastMonth', 'thisYear', 'custom'].includes(args.period))) {
      throw new ToolError('tool.invalid_args', `${name}: period must be last30days|lastMonth|thisYear|custom`);
    }
    for (const key of ['from', 'to']) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args[key])) {
          throw new ToolError('tool.invalid_args', `${name}: ${key} must be YYYY-MM-DD`);
        }
        const parsed = new Date(`${args[key]}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== args[key]) {
          throw new ToolError('tool.invalid_args', `${name}: ${key} must be YYYY-MM-DD`);
        }
      }
    }
    if (args.accountId !== undefined && (typeof args.accountId !== 'string' || !UUID_RE.test(args.accountId))) {
      throw new ToolError('tool.invalid_args', `${name}: accountId must be a uuid`);
    }
    if (args.basis !== undefined && (typeof args.basis !== 'string' || !['liquidez', 'competencia'].includes(args.basis))) {
      throw new ToolError('tool.invalid_args', `${name}: basis must be liquidez|competencia`);
    }
    if (args.kind !== undefined && (typeof args.kind !== 'string' || !['expense', 'income'].includes(args.kind))) {
      throw new ToolError('tool.invalid_args', `${name}: kind must be expense|income`);
    }
  } else if (name === 'budget_trends') {
    if (typeof args.budgetId !== 'string' || !UUID_RE.test(args.budgetId)) {
      throw new ToolError('tool.invalid_args', 'budget_trends: budgetId must be a uuid');
    }
    if (args.monthsBack !== undefined && (!Number.isInteger(args.monthsBack) || args.monthsBack < 1 || args.monthsBack > 12)) {
      throw new ToolError('tool.invalid_args', 'budget_trends: monthsBack must be an integer between 1 and 12');
    }
  } else if (name === 'list_payables') {
    if (args.status !== undefined && (typeof args.status !== 'string' || !['pending', 'paid', 'overdue', 'cancelled'].includes(args.status))) {
      throw new ToolError('tool.invalid_args', 'list_payables: status must be pending|paid|overdue|cancelled');
    }
    if (args.type !== undefined && (typeof args.type !== 'string' || !['one_time', 'recurring'].includes(args.type))) {
      throw new ToolError('tool.invalid_args', 'list_payables: type must be one_time|recurring');
    }
    if (args.dueWithinDays !== undefined && (!Number.isInteger(args.dueWithinDays) || args.dueWithinDays < 0 || args.dueWithinDays > 365)) {
      throw new ToolError('tool.invalid_args', 'list_payables: dueWithinDays must be an integer between 0 and 365');
    }
  } else if (name === 'list_audit_logs') {
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
      throw new ToolError('tool.invalid_args', 'list_audit_logs: limit must be an integer between 1 and 100');
    }
    if (args.actorType !== undefined && (typeof args.actorType !== 'string' || !['device', 'user'].includes(args.actorType))) {
      throw new ToolError('tool.invalid_args', 'list_audit_logs: actorType must be device|user');
    }
    for (const key of ['operation', 'eventType', 'entityType']) {
      if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].trim().length === 0)) {
        throw new ToolError('tool.invalid_args', `list_audit_logs: ${key} must be a non-empty string`);
      }
    }
    if (args.entityId !== undefined && (typeof args.entityId !== 'string' || !UUID_RE.test(args.entityId))) {
      throw new ToolError('tool.invalid_args', 'list_audit_logs: entityId must be a uuid');
    }
  } else if (name === 'list_card_statements') {
    if (args.accountId !== undefined && (typeof args.accountId !== 'string' || !UUID_RE.test(args.accountId))) {
      throw new ToolError('tool.invalid_args', 'list_card_statements: accountId must be a uuid');
    }
    if (args.status !== undefined && typeof args.status !== 'string') {
      throw new ToolError('tool.invalid_args', 'list_card_statements: status must be a string');
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) {
      throw new ToolError('tool.invalid_args', 'list_card_statements: limit must be an integer between 1 and 50');
    }
  } else if (name === 'propose_statement_payment') {
    if (typeof args.statementId !== 'string' || !UUID_RE.test(args.statementId)) {
      throw new ToolError('tool.invalid_args', 'propose_statement_payment: statementId must be a uuid');
    }
    if (typeof args.fromAccountId !== 'string' || !UUID_RE.test(args.fromAccountId)) {
      throw new ToolError('tool.invalid_args', 'propose_statement_payment: fromAccountId must be a uuid');
    }
    if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) {
      throw new ToolError('tool.invalid_args', 'propose_statement_payment: amountCents must be a positive safe integer');
    }
  } else if (name === 'propose_account_create') {
    // Structural only: the API owns the account contract (createAccountInputSchema:
    // kind bank|cash, signed initial balance bounded by MAX_MONEY_CENTS). The
    // runtime only stops the model from recording an unusable intent.
    if (typeof args.name !== 'string' || args.name.trim().length === 0 || args.name.trim().length > 120) {
      throw new ToolError('tool.invalid_args', 'propose_account_create: name must be a non-empty string (max 120)');
    }
    if (typeof args.kind !== 'string' || !['bank', 'cash'].includes(args.kind)) {
      throw new ToolError('tool.invalid_args', 'propose_account_create: kind must be bank|cash');
    }
    if (!Number.isSafeInteger(args.initialBalanceCents) || Math.abs(args.initialBalanceCents) > 1_000_000_000_000) {
      throw new ToolError('tool.invalid_args', 'propose_account_create: initialBalanceCents must be a safe integer within +/-1e12');
    }
  } else if (name === 'propose_category_create') {
    if (typeof args.name !== 'string' || args.name.trim().length === 0 || args.name.trim().length > 120) {
      throw new ToolError('tool.invalid_args', 'propose_category_create: name must be a non-empty string (max 120)');
    }
    if (typeof args.kind !== 'string' || !['expense', 'income'].includes(args.kind)) {
      throw new ToolError('tool.invalid_args', 'propose_category_create: kind must be expense|income');
    }
    if (args.parentId !== undefined && (typeof args.parentId !== 'string' || !UUID_RE.test(args.parentId))) {
      throw new ToolError('tool.invalid_args', 'propose_category_create: parentId must be a uuid');
    }
  } else if (name === 'propose_payable_create') {
    if (typeof args.accountId !== 'string' || !UUID_RE.test(args.accountId)) {
      throw new ToolError('tool.invalid_args', 'propose_payable_create: accountId must be a uuid');
    }
    if (typeof args.description !== 'string' || args.description.trim().length === 0 || args.description.trim().length > 240) {
      throw new ToolError('tool.invalid_args', 'propose_payable_create: description must be a non-empty string (max 240)');
    }
    if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) {
      throw new ToolError('tool.invalid_args', 'propose_payable_create: amountCents must be a positive safe integer');
    }
    if (typeof args.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.dueDate)) {
      throw new ToolError('tool.invalid_args', 'propose_payable_create: dueDate must be YYYY-MM-DD');
    }
    const due = new Date(`${args.dueDate}T00:00:00Z`);
    if (Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== args.dueDate) {
      throw new ToolError('tool.invalid_args', 'propose_payable_create: dueDate must be YYYY-MM-DD');
    }
    if (args.categoryId !== undefined && (typeof args.categoryId !== 'string' || !UUID_RE.test(args.categoryId))) {
      throw new ToolError('tool.invalid_args', 'propose_payable_create: categoryId must be a uuid');
    }
  } else if (name === 'propose_payable_pay') {
    for (const key of ['payableId', 'accountId']) {
      if (typeof args[key] !== 'string' || !UUID_RE.test(args[key])) {
        throw new ToolError('tool.invalid_args', `propose_payable_pay: ${key} must be a uuid`);
      }
    }
    if (typeof args.description !== 'string' || args.description.trim().length === 0 || args.description.trim().length > 240) {
      throw new ToolError('tool.invalid_args', 'propose_payable_pay: description must be a non-empty string (max 240)');
    }
    if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) {
      throw new ToolError('tool.invalid_args', 'propose_payable_pay: amountCents must be a positive safe integer');
    }
    for (const key of ['dueDate', 'paidDate']) {
      if (args[key] === undefined) continue;
      if (typeof args[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args[key])) {
        throw new ToolError('tool.invalid_args', `propose_payable_pay: ${key} must be YYYY-MM-DD`);
      }
      const parsed = new Date(`${args[key]}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== args[key]) {
        throw new ToolError('tool.invalid_args', `propose_payable_pay: ${key} must be YYYY-MM-DD`);
      }
    }
    if (args.dueDate === undefined) {
      throw new ToolError('tool.invalid_args', 'propose_payable_pay: dueDate is required');
    }
  } else if (name === 'propose_transaction_update') {
    // Description-only contract: the API schema accepts exactly
    // transactionId + new description + the literal current description used
    // as CAS. No amount/date/account/category can travel through this tool.
    if (typeof args.transactionId !== 'string' || !UUID_RE.test(args.transactionId)) {
      throw new ToolError('tool.invalid_args', 'propose_transaction_update: transactionId must be a uuid');
    }
    if (typeof args.description !== 'string' || args.description.trim().length === 0 || args.description.trim().length > 240) {
      throw new ToolError('tool.invalid_args', 'propose_transaction_update: description must be a non-empty string (max 240)');
    }
    if (typeof args.expectedDescription !== 'string' || args.expectedDescription.length === 0 || args.expectedDescription.length > 240 || args.expectedDescription.trim().length === 0) {
      throw new ToolError('tool.invalid_args', 'propose_transaction_update: expectedDescription must be the non-empty current description (max 240)');
    }
  } else if (name === 'propose_account_update' || name === 'propose_category_update') {
    const idKey = name === 'propose_account_update' ? 'accountId' : 'categoryId';
    const id = args[idKey];
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new ToolError('tool.invalid_args', `${name}: ${idKey} must be a uuid`);
    }
    if (typeof args.name !== 'string' || args.name.trim().length === 0 || args.name.trim().length > 120) {
      throw new ToolError('tool.invalid_args', `${name}: name must be a non-empty string (max 120)`);
    }
    if (typeof args.expectedName !== 'string' || args.expectedName.trim().length === 0 || args.expectedName.trim().length > 120) {
      throw new ToolError('tool.invalid_args', `${name}: expectedName must be the non-empty current name (max 120)`);
    }
  } else if (name === 'propose_account_deactivate') {
    if (typeof args.accountId !== 'string' || !UUID_RE.test(args.accountId)) {
      throw new ToolError('tool.invalid_args', 'propose_account_deactivate: accountId must be a uuid');
    }
    if (args.accountName !== undefined && (typeof args.accountName !== 'string' || args.accountName.trim().length === 0 || args.accountName.trim().length > 120)) {
      throw new ToolError('tool.invalid_args', 'propose_account_deactivate: accountName must be a non-empty string (max 120)');
    }
  } else if (name === 'propose_category_deactivate') {
    if (typeof args.categoryId !== 'string' || !UUID_RE.test(args.categoryId)) {
      throw new ToolError('tool.invalid_args', 'propose_category_deactivate: categoryId must be a uuid');
    }
    if (typeof args.expectedName !== 'string' || args.expectedName.trim().length === 0 || args.expectedName.trim().length > 120) {
      throw new ToolError('tool.invalid_args', 'propose_category_deactivate: expectedName must be the non-empty current name (max 120)');
    }
  } else if (
    name === 'propose_expense' ||
    name === 'propose_income' ||
    name === 'propose_card_purchase' ||
    name === 'propose_transfer'
  ) {
    // Structural validation only (types/format). The API remains the authority
    // for the transaction contract (expense/income share the same shape;
    // transfer uses from/to accounts and has NO category); these checks stop
    // the model from recording an unusable intent (the API would reject it
    // anyway).
    if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) {
      throw new ToolError('tool.invalid_args', `${name}: amountCents must be a positive safe integer`);
    }
    if (typeof args.description !== 'string' || args.description.trim().length === 0 || args.description.trim().length > 240) {
      throw new ToolError('tool.invalid_args', `${name}: description must be a non-empty string (max 240)`);
    }
    if (args.date !== undefined) {
      if (typeof args.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
        throw new ToolError('tool.invalid_args', `${name}: date must be YYYY-MM-DD`);
      }
      const parsed = new Date(`${args.date}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== args.date) {
        throw new ToolError('tool.invalid_args', `${name}: date must be YYYY-MM-DD`);
      }
    }
    if (name === 'propose_transfer') {
      if (typeof args.fromAccountId !== 'string' || !UUID_RE.test(args.fromAccountId)) {
        throw new ToolError('tool.invalid_args', `${name}: fromAccountId must be a uuid`);
      }
      if (typeof args.toAccountId !== 'string' || !UUID_RE.test(args.toAccountId)) {
        throw new ToolError('tool.invalid_args', `${name}: toAccountId must be a uuid`);
      }
      if (args.fromAccountId === args.toAccountId) {
        throw new ToolError('tool.invalid_args', `${name}: fromAccountId and toAccountId must differ`);
      }
    } else if (name === 'propose_card_purchase') {
      if (typeof args.accountId !== 'string' || !UUID_RE.test(args.accountId)) {
        throw new ToolError('tool.invalid_args', `${name}: accountId must be a uuid`);
      }
      if (args.categoryId !== undefined && (typeof args.categoryId !== 'string' || !UUID_RE.test(args.categoryId))) {
        throw new ToolError('tool.invalid_args', `${name}: categoryId must be a uuid`);
      }
      // P3.5: a declared split is 1–48. An invalid value fails closed here;
      // it is never coerced into a single purchase.
      if (
        args.installmentsTotal !== undefined &&
        (!Number.isInteger(args.installmentsTotal) || args.installmentsTotal < 1 || args.installmentsTotal > 48)
      ) {
        throw new ToolError('tool.invalid_args', `${name}: installmentsTotal must be an integer between 1 and 48`);
      }
      if (
        typeof args.installmentsTotal === 'number' &&
        args.installmentsTotal > 1 &&
        args.amountCents < args.installmentsTotal
      ) {
        throw new ToolError(
          'tool.invalid_args',
          `${name}: amountCents must cover at least 1 cent per installment`,
        );
      }
    } else {
      if (typeof args.accountId !== 'string' || !UUID_RE.test(args.accountId)) {
        throw new ToolError('tool.invalid_args', `${name}: accountId must be a uuid`);
      }
      if (typeof args.categoryId !== 'string' || !UUID_RE.test(args.categoryId)) {
        throw new ToolError('tool.invalid_args', `${name}: categoryId must be a uuid`);
      }
    }
  } else if (name === 'list_credit_cards') {
    // No arguments. Structural enforcement is via knownKeys/additionalProperties.
  } else if (name === 'list_accounts') {
    if (args.kind !== undefined && typeof args.kind !== 'string') {
      throw new ToolError('tool.invalid_args', 'list_accounts: kind must be a string');
    }
    if (args.includeInactive !== undefined && typeof args.includeInactive !== 'string') {
      throw new ToolError('tool.invalid_args', 'list_accounts: includeInactive must be a string');
    }
  }
  return args;
}

function routeFor(name, args) {
  if (name === 'list_accounts') {
    const q = new URLSearchParams();
    if (args.kind) q.set('kind', args.kind);
    if (args.includeInactive) q.set('includeInactive', args.includeInactive);
    const qs = q.toString();
    return qs ? `/accounts?${qs}` : '/accounts';
  }
  if (name === 'list_credit_cards') {
    // Exact existing route (cards.ts GET /cards/accounts): CardStore returns
    // credit-card accounts only. No query parameters.
    return '/cards/accounts';
  }
  if (name === 'list_categories') {
    // Exact existing API route (categories.ts:59-68): GET /categories with an
    // optional kind filter. Query strings pass through to the real API.
    const q = new URLSearchParams();
    if (args.kind) q.set('kind', args.kind);
    const qs = q.toString();
    return qs ? `/categories?${qs}` : '/categories';
  }
  if (name === 'list_recent_transactions') {
    // Exact existing API route (transactions.ts:17): GET /transactions with the
    // real filter query. Query strings pass through to the real API.
    const q = new URLSearchParams();
    for (const key of ['accountId', 'categoryId', 'kind', 'startDate', 'endDate', 'minAmountCents', 'maxAmountCents', 'query', 'limit', 'offset']) {
      if (args[key] !== undefined) q.set(key, String(args[key]));
    }
    const qs = q.toString();
    return qs ? `/transactions?${qs}` : '/transactions';
  }
  if (name === 'spending_insights') {
    // Exact existing API route (insights.ts:45): GET /insights/spending with
    // the real query. Query strings pass through to the real API.
    const q = new URLSearchParams();
    for (const key of ['yearMonth', 'insightType', 'lookbackMonths']) {
      if (args[key] !== undefined) q.set(key, String(args[key]));
    }
    const qs = q.toString();
    return qs ? `/insights/spending?${qs}` : '/insights/spending';
  }
  if (name === 'list_card_statements') {
    // Exact existing API route (cards.ts GET /cards/statements) with the
    // optional card/status/limit filters. No invented query.
    const q = new URLSearchParams();
    if (args.accountId) q.set('accountId', args.accountId);
    if (args.status) q.set('status', args.status);
    if (args.limit !== undefined) q.set('limit', String(args.limit));
    const qs = q.toString();
    return qs ? `/cards/statements?${qs}` : '/cards/statements';
  }
  if (name === 'analytics_kpis' || name === 'analytics_category_breakdown' || name === 'analytics_cashflow_series' || name === 'analytics_budget_consumption' || name === 'analytics_net_worth_history') {
    // Exact existing analytics routes; the query string passes through to the
    // real handler, which owns period/basis support per route.
    const path = name === 'analytics_kpis'
      ? '/analytics/kpis'
      : name === 'analytics_category_breakdown'
        ? '/analytics/category-breakdown'
        : name === 'analytics_cashflow_series'
          ? '/analytics/cashflow-series'
          : name === 'analytics_budget_consumption'
            ? '/analytics/budget-consumption'
            : '/analytics/net-worth-history';
    const q = new URLSearchParams();
    for (const key of ['period', 'from', 'to', 'accountId', 'basis', 'kind']) {
      if (args[key] !== undefined) q.set(key, String(args[key]));
    }
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
  }
  if (name === 'list_budgets') return '/budgets';
  if (name === 'check_budgets') return '/budgets/check';
  if (name === 'budget_trends') {
    // Dynamic resource path: only the uuid already shape-validated above can
    // reach the URL, and the transport allowlist matches the same pattern.
    const q = new URLSearchParams();
    if (args.monthsBack !== undefined) q.set('monthsBack', String(args.monthsBack));
    const qs = q.toString();
    const path = `/budgets/${encodeURIComponent(args.budgetId)}/trends`;
    return qs ? `${path}?${qs}` : path;
  }
  if (name === 'list_goals') return '/goals';
  if (name === 'list_payables') {
    const q = new URLSearchParams();
    if (args.status) q.set('status', args.status);
    if (args.type) q.set('type', args.type);
    if (args.dueWithinDays !== undefined) q.set('dueWithinDays', String(args.dueWithinDays));
    const qs = q.toString();
    return qs ? `/payables?${qs}` : '/payables';
  }
  if (name === 'payable_reminders') return '/payables/reminders';
  if (name === 'list_audit_logs') {
    const q = new URLSearchParams();
    for (const key of ['limit', 'operation', 'eventType', 'actorType', 'entityType', 'entityId']) {
      if (args[key] !== undefined) q.set(key, String(args[key]));
    }
    const qs = q.toString();
    return qs ? `/audit-logs?${qs}` : '/audit-logs';
  }
  return `/dashboard/month-summary?yearMonth=${encodeURIComponent(args.yearMonth)}`;
}

// SPEC §5: 2xx com JSON arbitrário NÃO é dado financeiro válido. Validação
// de FORMA contra o contrato real (accounts.ts:79, dashboard.ts:46-52,
// categories.ts:59-68):
// accounts/categories exigem {items: array, total: inteiro seguro não negativo};
// summary exige yearMonth EXATAMENTE igual ao requisitado (resposta de outro
// mês nunca vira grounding) + cents inteiros seguros + count inteiro seguro
// não negativo. NUNCA recalcula valores (saldo negativo passa intocado).
// Erro tipado fail-closed; nada é fabricado no lugar.
function isSafeInt(n) {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

function assertShape(name, args, body) {
  const fail = (why) => {
    throw new ToolError('tool.invalid_shape', `${name}: upstream 2xx with invalid shape (${why}) — refused, never fabricated`);
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(`expected object, got ${Array.isArray(body) ? 'array' : body === null ? 'null' : typeof body}`);
  }
  if (name === 'list_budgets' || name === 'check_budgets' || name === 'budget_trends' || name === 'list_goals' || name === 'list_payables' || name === 'payable_reminders' || name === 'list_audit_logs' || name === 'analytics_budget_consumption') {
    if (!Array.isArray(body.items)) fail('items must be an array');
    if (!isSafeInt(body.total) || body.total < 0) fail('total must be a non-negative safe integer');
    return body;
  }
  if (name === 'analytics_kpis') {
    for (const k of [
      'incomeCents', 'expenseCents', 'previousIncomeCents', 'previousExpenseCents',
      'accountsTotalCents', 'netWorthCents', 'netLiquidBalanceCents', 'dueSoonCents',
    ]) {
      if (!isSafeInt(body[k])) fail(`${k} must be a safe integer`);
    }
    if (!body.period || typeof body.period !== 'object' || Array.isArray(body.period)) fail('period must be an object');
    if (typeof body.period.from !== 'string' || typeof body.period.to !== 'string') fail('period.from/to must be strings');
    if (!isSafeInt(body.transactionCount) || body.transactionCount < 0) fail('transactionCount must be a non-negative safe integer');
    return body;
  }
  if (name === 'analytics_category_breakdown') {
    if (!isSafeInt(body.totalCents)) fail('totalCents must be a safe integer');
    if (!Array.isArray(body.slices)) fail('slices must be an array');
    if (body.kind !== 'expense' && body.kind !== 'income') fail('kind must be expense|income');
    if (!body.period || typeof body.period !== 'object' || Array.isArray(body.period)) fail('period must be an object');
    for (const slice of body.slices) {
      if (!slice || typeof slice !== 'object' || Array.isArray(slice)) fail('slice must be an object');
      if (typeof slice.categoryId !== 'string' || slice.categoryId.length === 0) fail('slice categoryId must be a non-empty string');
      if (typeof slice.name !== 'string') fail('slice name must be a string');
      if (!isSafeInt(slice.totalCents)) fail('slice totalCents must be a safe integer');
    }
    if (!isSafeInt(body.transactionCount) || body.transactionCount < 0) fail('transactionCount must be a non-negative safe integer');
    return body;
  }
  if (name === 'analytics_cashflow_series') {
    if (!body.period || typeof body.period !== 'object' || Array.isArray(body.period)) fail('period must be an object');
    for (const key of ['current', 'previous']) {
      if (!Array.isArray(body[key])) fail(`${key} must be an array`);
      for (const point of body[key]) {
        if (!point || typeof point !== 'object' || Array.isArray(point)) fail(`${key} point must be an object`);
        if (typeof point.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)) fail(`${key} point date must be YYYY-MM-DD`);
        if (!isSafeInt(point.valueCents)) fail(`${key} point valueCents must be a safe integer`);
      }
    }
    if (!isSafeInt(body.transactionCount) || body.transactionCount < 0) fail('transactionCount must be a non-negative safe integer');
    return body;
  }
  if (name === 'analytics_net_worth_history') {
    if (!Array.isArray(body.months)) fail('months must be an array');
    for (const point of body.months) {
      if (!point || typeof point !== 'object' || Array.isArray(point)) fail('month point must be an object');
      if (typeof point.month !== 'string' || !/^\d{4}-\d{2}$/.test(point.month)) fail('month must be YYYY-MM');
      if (!isSafeInt(point.netWorthCents)) fail('netWorthCents must be a safe integer');
    }
    if (!isSafeInt(body.transactionCount) || body.transactionCount < 0) fail('transactionCount must be a non-negative safe integer');
    return body;
  }
  if (name === 'list_accounts' || name === 'list_credit_cards' || name === 'list_categories') {
    if (!Array.isArray(body.items)) fail('items must be an array');
    if (!isSafeInt(body.total) || body.total < 0) fail('total must be a non-negative safe integer');
    return body;
  }
  if (name === 'list_recent_transactions') {
    if (!Array.isArray(body.items)) fail('items must be an array');
    if (!isSafeInt(body.total) || body.total < 0) fail('total must be a non-negative safe integer');
    if (!isSafeInt(body.limit) || body.limit < 1) fail('limit must be a positive safe integer');
    if (!isSafeInt(body.offset) || body.offset < 0) fail('offset must be a non-negative safe integer');
    // The model must never receive a transaction without the authoritative
    // fields it needs to ground an answer or a follow-up proposal. Shape drift
    // fails closed instead of inventing values.
    for (const item of body.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('transaction item must be an object');
      if (typeof item.id !== 'string' || item.id.length === 0) fail('transaction id must be a non-empty string');
      if (typeof item.kind !== 'string' || !['expense', 'income', 'transfer'].includes(item.kind)) fail('transaction kind must be expense|income|transfer');
      if (typeof item.description !== 'string') fail('transaction description must be a string');
      if (!isSafeInt(item.amountCents) || item.amountCents < 0) fail('transaction amountCents must be a non-negative safe integer');
      if (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) fail('transaction date must be YYYY-MM-DD');
      if (typeof item.accountId !== 'string' || item.accountId.length === 0) fail('transaction accountId must be a non-empty string');
    }
    return body;
  }
  if (name === 'spending_insights') {
    if (typeof body.success !== 'boolean') fail('success must be a boolean');
    if (typeof body.yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(body.yearMonth)) fail('yearMonth must be YYYY-MM');
    if (!Array.isArray(body.insights)) fail('insights must be an array');
    if (!isSafeInt(body.transactionCount) || body.transactionCount < 0) fail('transactionCount must be a non-negative safe integer');
    return body;
  }
  if (name === 'list_card_statements') {
    if (!Array.isArray(body.items)) fail('items must be an array');
    if (!isSafeInt(body.total) || body.total < 0) fail('total must be a non-negative safe integer');
    // The model must never receive a statement without the authoritative
    // tuple it needs to propose (id/card/competence/total/paid/remaining/
    // due/status). Shape drift fails closed instead of inventing values.
    for (const item of body.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('statement item must be an object');
      if (typeof item.id !== 'string' || item.id.length === 0) fail('statement id must be a non-empty string');
      if (typeof item.accountId !== 'string' || item.accountId.length === 0) fail('statement accountId must be a non-empty string');
      if (typeof item.cycleYearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(item.cycleYearMonth)) fail('statement cycleYearMonth must be YYYY-MM');
      if (!isSafeInt(item.totalCents) || item.totalCents < 0) fail('statement totalCents must be a non-negative safe integer');
      if (!isSafeInt(item.paidCents) || item.paidCents < 0) fail('statement paidCents must be a non-negative safe integer');
      if (item.paidCents > item.totalCents) fail('statement paidCents cannot exceed totalCents');
      if (typeof item.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)) fail('statement dueDate must be YYYY-MM-DD');
      if (typeof item.status !== 'string' || item.status.length === 0) fail('statement status must be a non-empty string');
    }
    return body;
  }
  if (typeof body.yearMonth !== 'string' || body.yearMonth !== args.yearMonth) {
    fail('yearMonth must exactly equal the requested period');
  }
  for (const k of ['incomeCents', 'expenseCents', 'balanceCents']) {
    if (!isSafeInt(body[k])) fail(`${k} must be a safe integer`);
  }
  if (!isSafeInt(body.transactionCount) || body.transactionCount < 0) {
    fail('transactionCount must be a non-negative safe integer');
  }
  return body;
}

// transport: async ({ route, method, host, ... }) -> { statusCode, body }.
// Host travels per call; the transport holds no token state.
function requireHostContext(name, host) {
  if (!host || typeof host.token !== 'string' || host.token.length === 0) {
    throw new ToolError('host_context_required', `${name}: host-bound context is required — hostless execution is blocked by design`);
  }
}

function requireIntention(name, opts) {
  const intentionId = opts ? opts.intentionId : undefined;
  if (typeof intentionId !== 'string' || intentionId.length === 0) {
    throw new ToolError('tool.invalid_args', `${name}: stable intentionId is required in opts (derive via deriveIntentionId — a CallID is correlation only, never identity)`);
  }
  return intentionId;
}

function formatBRL(amountCents) {
  const value = amountCents / 100;
  return `R$ ${value.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

export function createToolExecutors(transport, { proposalIntents } = {}) {
  const run = async (name, args, host, opts = {}) => {
    requireHostContext(name, host);
    const intentionId = requireIntention(name, opts);
    const safeArgs = validateToolArgs(name, args);
    const route = routeFor(name, safeArgs);
    let result;
    try {
      // opts can NEVER override routing/identity: only allowlisted
      // passthrough fields travel; host/route/method are assigned last.
      const o = opts || {};
      result = await transport({
        intentionId,
        callId: o.callId,
        workspaceId: o.workspaceId,
        delayMs: o.delayMs,
        timeoutMs: o.timeoutMs,
        signal: o.signal,
        route,
        method: 'GET',
        host,
      });
    } catch (e) {
      // Typed fail-closed codes (transport timeout/cancelled/allowlist) pass
      // through untouched; generic dependency failures get a fixed message —
      // raw exception text never reaches the tool/model context.
      if (e instanceof ToolError) throw e;
      if (e && (e.code === 'tool.timeout' || e.code === 'tool.cancelled')) throw e;
      throw new ToolError('tool.transport', `${name}: transport failed`);
    }
    const { statusCode, body: responseBody } = result;
    if (statusCode >= 200 && statusCode < 300) return assertShape(name, safeArgs, responseBody);
    const code = statusCode === 400 ? 'tool.invalid'
      : statusCode === 401 ? 'tool.unauthorized'
        : statusCode === 403 ? 'tool.forbidden'
          : statusCode === 404 ? 'tool.not_found'
            : statusCode === 409 ? 'tool.conflict'
              : statusCode === 422 ? 'tool.invalid'
                : statusCode === 500 ? 'tool.upstream_500'
                  : 'tool.upstream_error';
    // Fail-closed: upstream errors throw with the real status/code only.
    // Totals are NEVER fabricated (no zero-fill on error); the upstream
    // response body is never attached (no raw dependency text in details).
    throw new ToolError(code, `${name}: upstream ${statusCode}`, { statusCode });
  };
  // Proposal INTENT only (expense and income share this ONE code path). No
  // transport, no API, no write: the authenticated PWA hands the intent to the
  // Agent broker, the sole A4 issuer. Fails closed without the registry so a
  // wiring mistake cannot silently record (or worse, drop) a proposal.
  const propose = async (name, args, host, opts = {}) => {
    const spec = PROPOSAL_TOOL_SPECS[name];
    if (!spec) throw new ToolError('tool.unknown', `unknown proposal tool ${name}`);
    requireHostContext(name, host);
    const intentionId = requireIntention(name, opts);
    if (!proposalIntents || typeof proposalIntents.record !== 'function') {
      throw new ToolError('tool.unavailable', `${name}: proposal intent registry unavailable — failing closed`);
    }
    if (typeof opts.sessionID !== 'string' || opts.sessionID.length === 0) {
      throw new ToolError('host_context_required', `${name}: host-bound session context is required — hostless execution is blocked by design`);
    }
    const safe = validateToolArgs(name, args);
    if (name === 'propose_statement_payment') {
      // Exact payment tuple: invoice + payer + amount paid NOW. No date or
      // description is invented; the API revalidates the statement, the
      // remaining balance and the payer account.
      const normalizedArgs = {
        statementId: safe.statementId,
        fromAccountId: safe.fromAccountId,
        amountCents: safe.amountCents,
      };
      const summary = `${spec.noun} de ${formatBRL(normalizedArgs.amountCents)}`;
      proposalIntents.record(opts.sessionID, {
        tool: spec.tool,
        intentionId,
        summary,
        normalizedArgs,
      });
      return { status: 'proposed', summary };
    }
    if (name === 'propose_account_create') {
      // Account tuple: name + kind (bank|cash) + signed initial balance. No
      // date/description is invented; the API revalidates kind and the bound.
      const normalizedArgs = {
        name: safe.name.trim(),
        kind: safe.kind,
        initialBalanceCents: safe.initialBalanceCents,
      };
      const summary = `Conta "${normalizedArgs.name}" (${normalizedArgs.kind})`;
      proposalIntents.record(opts.sessionID, { tool: spec.tool, intentionId, summary, normalizedArgs });
      return { status: 'proposed', summary };
    }
    if (name === 'propose_category_create') {
      // Category tuple: name + kind (expense|income) + optional parent resolved
      // from list_categories. The API revalidates kind/parent against the
      // workspace catalog.
      const normalizedArgs = {
        name: safe.name.trim(),
        kind: safe.kind,
        ...(safe.parentId !== undefined ? { parentId: safe.parentId } : {}),
      };
      const summary = `Categoria "${normalizedArgs.name}" (${normalizedArgs.kind})`;
      proposalIntents.record(opts.sessionID, { tool: spec.tool, intentionId, summary, normalizedArgs });
      return { status: 'proposed', summary };
    }
    if (name === 'propose_payable_create') {
      const normalizedArgs = {
        accountId: safe.accountId,
        description: safe.description.trim(),
        amountCents: safe.amountCents,
        dueDate: safe.dueDate,
        ...(safe.categoryId !== undefined ? { categoryId: safe.categoryId } : {}),
      };
      const summary = `Conta a pagar de ${formatBRL(normalizedArgs.amountCents)} em "${normalizedArgs.description}"`;
      proposalIntents.record(opts.sessionID, { tool: spec.tool, intentionId, summary, normalizedArgs });
      return { status: 'proposed', summary };
    }
    if (name === 'propose_payable_pay') {
      const normalizedArgs = {
        payableId: safe.payableId,
        description: safe.description.trim(),
        amountCents: safe.amountCents,
        dueDate: safe.dueDate,
        accountId: safe.accountId,
        ...(safe.paidDate !== undefined ? { paidDate: safe.paidDate } : {}),
      };
      const summary = `Pagar conta "${normalizedArgs.description}" de ${formatBRL(normalizedArgs.amountCents)}`;
      proposalIntents.record(opts.sessionID, { tool: spec.tool, intentionId, summary, normalizedArgs });
      return { status: 'proposed', summary };
    }
    if (name === 'propose_transaction_update') {
      const normalizedArgs = {
        transactionId: safe.transactionId,
        description: safe.description.trim(),
        expectedDescription: safe.expectedDescription,
      };
      const summary = `Alterar descrição de "${normalizedArgs.expectedDescription}" para "${normalizedArgs.description}"`;
      proposalIntents.record(opts.sessionID, { tool: spec.tool, intentionId, summary, normalizedArgs });
      return { status: 'proposed', summary };
    }
    if (name === 'propose_account_update' || name === 'propose_category_update') {
      const normalizedArgs = name === 'propose_account_update'
        ? { accountId: safe.accountId, name: safe.name.trim(), expectedName: safe.expectedName }
        : { categoryId: safe.categoryId, name: safe.name.trim(), expectedName: safe.expectedName };
      const noun = name === 'propose_account_update' ? 'conta' : 'categoria';
      const summary = `Renomear ${noun} de "${normalizedArgs.expectedName}" para "${normalizedArgs.name}"`;
      proposalIntents.record(opts.sessionID, { tool: spec.tool, intentionId, summary, normalizedArgs });
      return { status: 'proposed', summary };
    }
    if (name === 'propose_account_deactivate') {
      // The API binds the target by accountId; accountName is an optional
      // display-only snapshot and never a CAS key.
      const normalizedArgs = {
        accountId: safe.accountId,
        ...(safe.accountName !== undefined ? { accountName: safe.accountName.trim() } : {}),
      };
      const summary = `Desativar conta${normalizedArgs.accountName ? ` "${normalizedArgs.accountName}"` : ''}`;
      proposalIntents.record(opts.sessionID, { tool: spec.tool, intentionId, summary, normalizedArgs });
      return { status: 'proposed', summary };
    }
    if (name === 'propose_category_deactivate') {
      const normalizedArgs = { categoryId: safe.categoryId, expectedName: safe.expectedName };
      const summary = `Desativar categoria "${normalizedArgs.expectedName}"`;
      proposalIntents.record(opts.sessionID, { tool: spec.tool, intentionId, summary, normalizedArgs });
      return { status: 'proposed', summary };
    }
    const date = safe.date ?? new Date().toISOString().slice(0, 10);
    const baseArgs = {
      amountCents: safe.amountCents,
      description: safe.description.trim(),
      date,
    };
    const normalizedArgs = name === 'propose_transfer'
      ? { ...baseArgs, fromAccountId: safe.fromAccountId, toAccountId: safe.toAccountId }
      : {
        ...baseArgs,
        accountId: safe.accountId,
        categoryId: safe.categoryId,
        // P3.5: only travel when the model declared a split, so the 1x
        // proposal payload stays byte-identical to P3.4.
        ...(safe.installmentsTotal !== undefined ? { installmentsTotal: safe.installmentsTotal } : {}),
      };
    const summary = `${spec.noun} de ${formatBRL(normalizedArgs.amountCents)} em "${normalizedArgs.description}"`;
    proposalIntents.record(opts.sessionID, {
      tool: spec.tool,
      intentionId,
      summary,
      normalizedArgs,
    });
    return { status: 'proposed', summary };
  };
  return {
    list_accounts: (args, host, opts) => run('list_accounts', args, host, opts),
    list_recent_transactions: (args, host, opts) => run('list_recent_transactions', args, host, opts),
    spending_insights: (args, host, opts) => run('spending_insights', args, host, opts),
    list_credit_cards: (args, host, opts) => run('list_credit_cards', args, host, opts),
    get_month_summary: (args, host, opts) => run('get_month_summary', args, host, opts),
    list_categories: (args, host, opts) => run('list_categories', args, host, opts),
    list_card_statements: (args, host, opts) => run('list_card_statements', args, host, opts),
    analytics_kpis: (args, host, opts) => run('analytics_kpis', args, host, opts),
    analytics_category_breakdown: (args, host, opts) => run('analytics_category_breakdown', args, host, opts),
    analytics_cashflow_series: (args, host, opts) => run('analytics_cashflow_series', args, host, opts),
    analytics_budget_consumption: (args, host, opts) => run('analytics_budget_consumption', args, host, opts),
    analytics_net_worth_history: (args, host, opts) => run('analytics_net_worth_history', args, host, opts),
    list_budgets: (args, host, opts) => run('list_budgets', args, host, opts),
    check_budgets: (args, host, opts) => run('check_budgets', args, host, opts),
    budget_trends: (args, host, opts) => run('budget_trends', args, host, opts),
    list_goals: (args, host, opts) => run('list_goals', args, host, opts),
    list_payables: (args, host, opts) => run('list_payables', args, host, opts),
    payable_reminders: (args, host, opts) => run('payable_reminders', args, host, opts),
    list_audit_logs: (args, host, opts) => run('list_audit_logs', args, host, opts),
    propose_expense: (args, host, opts) => propose('propose_expense', args, host, opts),
    propose_income: (args, host, opts) => propose('propose_income', args, host, opts),
    propose_card_purchase: (args, host, opts) => propose('propose_card_purchase', args, host, opts),
    propose_transfer: (args, host, opts) => propose('propose_transfer', args, host, opts),
    propose_statement_payment: (args, host, opts) => propose('propose_statement_payment', args, host, opts),
    propose_account_create: (args, host, opts) => propose('propose_account_create', args, host, opts),
    propose_category_create: (args, host, opts) => propose('propose_category_create', args, host, opts),
    propose_transaction_update: (args, host, opts) => propose('propose_transaction_update', args, host, opts),
    propose_account_update: (args, host, opts) => propose('propose_account_update', args, host, opts),
    propose_account_deactivate: (args, host, opts) => propose('propose_account_deactivate', args, host, opts),
    propose_category_update: (args, host, opts) => propose('propose_category_update', args, host, opts),
    propose_category_deactivate: (args, host, opts) => propose('propose_category_deactivate', args, host, opts),
    propose_payable_create: (args, host, opts) => propose('propose_payable_create', args, host, opts),
    propose_payable_pay: (args, host, opts) => propose('propose_payable_pay', args, host, opts),
  };
}
