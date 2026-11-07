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
// Explicitly NOT present: propose_expense, confirm/execute, PG/synthetic
// bridges, seeds, traces, runners (see README + inventory notes).

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
];

export const TOOL_NAMES = TOOL_DEFS.map((d) => d.name);

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
export function createToolExecutors(transport) {
  const run = async (name, args, host, opts = {}) => {
    if (!host || typeof host.token !== 'string' || host.token.length === 0) {
      throw new ToolError('host_context_required', `${name}: host-bound context is required — hostless execution is blocked by design`);
    }
    const intentionId = opts ? opts.intentionId : undefined;
    if (typeof intentionId !== 'string' || intentionId.length === 0) {
      throw new ToolError('tool.invalid_args', `${name}: stable intentionId is required in opts (derive via deriveIntentionId — a CallID is correlation only, never identity)`);
    }
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
  return {
    list_accounts: (args, host, opts) => run('list_accounts', args, host, opts),
    get_month_summary: (args, host, opts) => run('get_month_summary', args, host, opts),
    list_categories: (args, host, opts) => run('list_categories', args, host, opts),
  };
}
