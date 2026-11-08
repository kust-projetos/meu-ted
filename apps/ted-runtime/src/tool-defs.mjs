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
    // card filter. Read-only; the model resolves the card via list_accounts
    // and the invoice id here — never invented.
    name: 'list_card_statements',
    description: 'TED read-only (P3 opt-in): credit-card statements via GET /cards/statements, optionally filtered by card.',
    input: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Credit-card account uuid resolved from list_accounts (optional)' },
        status: { type: 'string', enum: ['open', 'closed', 'paid', 'partial', 'overdue', 'cancelled'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', description: 'Real GET /cards/statements body ({items, total}).' },
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
      'TED (P3 opt-in): propose an expense for the authenticated user to approve. Records a pending proposal only — never creates the transaction.',
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
      'TED (P3 opt-in): propose an income for the authenticated user to approve. Records a pending proposal only — never creates the transaction.',
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
    // Card identified via list_accounts (credit_card); categoryId optional.
    name: 'propose_card_purchase',
    description:
      'TED (P3 opt-in): propose a credit-card purchase for the authenticated user to approve, either single (1x) or in installments. Records a pending proposal only — never creates the purchase.',
    input: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', minimum: 1, description: 'TOTAL purchase amount in cents (BRL), never a per-parcel amount' },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        date: { type: 'string', description: 'Purchase date YYYY-MM-DD (defaults to today UTC)' },
        accountId: { type: 'string', description: 'Credit-card account uuid resolved from list_accounts (credit_card)' },
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
      'TED (P3 opt-in): propose an internal transfer between two of the user\'s accounts. Records a pending proposal only — never moves money.',
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
  if (name === 'list_categories') return ['kind'];
  if (name === 'list_card_statements') return ['accountId', 'status', 'limit'];
  if (name === 'propose_statement_payment') return ['statementId', 'fromAccountId', 'amountCents'];
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
  } else {
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
  if (name === 'list_categories') {
    // Exact existing API route (categories.ts:59-68): GET /categories with an
    // optional kind filter. Query strings pass through to the real API.
    const q = new URLSearchParams();
    if (args.kind) q.set('kind', args.kind);
    const qs = q.toString();
    return qs ? `/categories?${qs}` : '/categories';
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
  if (name === 'list_accounts' || name === 'list_categories') {
    if (!Array.isArray(body.items)) fail('items must be an array');
    if (!isSafeInt(body.total) || body.total < 0) fail('total must be a non-negative safe integer');
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
    get_month_summary: (args, host, opts) => run('get_month_summary', args, host, opts),
    list_categories: (args, host, opts) => run('list_categories', args, host, opts),
    list_card_statements: (args, host, opts) => run('list_card_statements', args, host, opts),
    propose_expense: (args, host, opts) => propose('propose_expense', args, host, opts),
    propose_income: (args, host, opts) => propose('propose_income', args, host, opts),
    propose_card_purchase: (args, host, opts) => propose('propose_card_purchase', args, host, opts),
    propose_transfer: (args, host, opts) => propose('propose_transfer', args, host, opts),
    propose_statement_payment: (args, host, opts) => propose('propose_statement_payment', args, host, opts),
  };
}
