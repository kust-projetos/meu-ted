// Shared TED finance tool definitions + executors (spike 02, Steps 2-3).
//
// Single source of truth imported by BOTH:
//   - bootstrap/plugins/ted-finance/index.mjs (native ctx.tool.add registration)
//   - bootstrap/ted-gateway.mjs (deterministic restricted facade)
//
// So the tool-integration tests exercise the SAME execute functions the native
// plugin registers. Identity is host-bound: executors take a frozen host
// context (token, actor, device) as a parameter — never from tool args.
// Tool args accept ONLY finance-domain fields; actorId/workspaceId/token keys
// are rejected BEFORE any transport call (G2-02/G2-03).

export class ToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
    if (details && typeof details.statusCode === 'number') this.statusCode = details.statusCode;
    if (details && details.body !== undefined) this.body = details.body;
  }
}

// Stable financial intention derivation (spike 03A-T3).
//
// deriveIntentionId({sessionID, messageID|clientMessageId}) returns a
// deterministic `int-<sha256-32hex>` over sessionID + NUL + messageID. The
// SAME session+message derives the SAME intention across retries even though
// every retry mints a new native CallID (ctx.id) — the CallID is a turn, the
// intention is the financial identity. Extra fields (callID, turns) are
// accepted-but-ignored: they NEVER perturb the derivation.
//
// Reads carry the derived intention as idempotency/correlation identity and
// the CallID separately as technical correlation (opts.callId). WRITES (none
// exist in this spike) must present a stable intentionId derived here PLUS a
// valid host binding — enforced by the executor's intention guard below and
// the session-bindings resolveHost gate, not by any new framework.
import { createHash } from 'node:crypto';

export function deriveIntentionId(input = {}) {
  const { sessionID, messageID, clientMessageId, callID, ...rest } = input || {};
  void callID;
  void rest; // correlation/turn fields: accepted, never identity
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
    // Native 2.2.4 prompt-loop REQUIRES an output schema whenever execute()
    // returns {output} (proven live 03B-T1: "Tool result declared output
    // without an output schema"). Permissive object: success shapes vary
    // ({items,total} incl. empty; never fabricated zeros on error — errors
    // throw, they do not return).
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
    // Same native requirement as above; exact totals come from the REAL
    // handler (incomeCents/expenseCents/balanceCents/transactionCount).
    output: { type: 'object', description: 'Real GET /dashboard/month-summary body.' },
  },
  {
    name: 'list_categories',
    description: 'TED read-only: list workspace categories via GET /categories (identity-scoped server-side; optional kind=expense|income filter).',
    input: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['expense', 'income'] },
      },
      required: [],
      additionalProperties: false,
    },
    // Same native requirement as above: execute() returns {output}, so a
    // schema is mandatory. Real GET /categories body ({items, total}).
    output: { type: 'object', description: 'Real GET /categories body ({items, total}).' },
  },
  {
    name: 'propose_expense',
    description: 'TED write: propose an expense via POST /pending-operations/v2/propose (Pending V2 authority; proposal only, never executes — confirmation is a separate authenticated action).',
    input: {
      type: 'object',
      properties: {
        amountCents: { type: 'integer', minimum: 1, description: 'Positive integer cents' },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'Effective date YYYY-MM-DD' },
        accountId: { type: 'string', minLength: 1 },
        categoryId: { type: 'string', minLength: 1 },
      },
      required: ['amountCents', 'description', 'date', 'accountId'],
      additionalProperties: false,
    },
    // Same native requirement as above: execute() returns {output}, so a
    // schema is mandatory. The REAL propose body varies by outcome (201
    // proposal vs 200 replay with existing:true); errors throw, never return.
    output: { type: 'object', description: 'Real POST /pending-operations/v2/propose body (proposal record: {id, status, tool, ...}; replay adds existing:true).' },
  },
];

// Stable idempotency key for propose_expense (S05 contract): deterministic
// per (workspace, intentionId, operation) — stable across retries (every retry
// re-derives the SAME intentionId via deriveIntentionId), independent of the
// volatile native CallID / messageId. A divergent payload under the SAME key
// is rejected by the REAL Pending V2 store (409 idempotency.conflict) — the
// key carries no payload hash by design; the authority compares proposalHash.
const PROPOSE_EXPENSE_TOOL = 'transactions.expense.create';

export function deriveExpenseIdempotencyKey({ workspace, intentionId, tool = PROPOSE_EXPENSE_TOOL } = {}) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new ToolError('tool.invalid_args', 'deriveExpenseIdempotencyKey: workspace (string, non-empty) is required');
  }
  if (typeof intentionId !== 'string' || intentionId.length === 0) {
    throw new ToolError('tool.invalid_args', 'deriveExpenseIdempotencyKey: intentionId (string, non-empty) is required');
  }
  const digest = createHash('sha256')
    .update(workspace, 'utf8')
    .update('\0', 'utf8')
    .update(intentionId, 'utf8')
    .update('\0', 'utf8')
    .update(tool, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `ted-${digest}`;
}

// Identity/host keys must NEVER appear in tool args (host-bound identity, §6).
const FORBIDDEN_KEYS = new Set([
  'actorId', 'actor_id', 'actor',
  'workspaceId', 'workspace_id', 'workspace',
  'householdId', 'household_id', 'household',
  'token', 'deviceToken', 'device_token', 'deviceId', 'device_id',
  'sessionId', 'session_id', 'intentionId', 'authorization',
  // S05: idempotency/proposal identity is host-derived (stable per
  // workspace+intention+operation), never a model-supplied arg; the native
  // CallID is transport correlation only.
  'idempotencyKey', 'idempotency_key', 'idempotency',
  'proposalHash', 'proposal_hash',
  'callId', 'call_id', 'toolCallId', 'tool_call_id',
]);

function knownKeys(name) {
  if (name === 'list_accounts') return ['kind', 'includeInactive'];
  if (name === 'list_categories') return ['kind'];
  if (name === 'get_month_summary') return ['yearMonth'];
  return ['amountCents', 'description', 'date', 'accountId', 'categoryId'];
}

// Validates tool args structurally. Domain validation (period format, kind
// enum values on the wire) is owned by the REAL handlers (§5 contract):
// the tool passes values through so a 400 comes from the real route.
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
  } else if (name === 'propose_expense') {
    // Structural finance-only checks (S05 contract). Domain semantics (uuid
    // shape, real calendar date, category kind) belong to the REAL registry
    // handler — the tool passes values through so a 422 comes from the route.
    if (typeof args.amountCents !== 'number' || !Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new ToolError('tool.invalid_args', 'propose_expense: amountCents (positive integer cents) is required');
    }
    if (typeof args.description !== 'string' || args.description.trim().length === 0 || args.description.trim().length > 240) {
      throw new ToolError('tool.invalid_args', 'propose_expense: description (string, 1-240 chars) is required');
    }
    if (typeof args.date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(args.date)) {
      throw new ToolError('tool.invalid_args', 'propose_expense: date (YYYY-MM-DD) is required');
    }
    if (typeof args.accountId !== 'string' || args.accountId.length === 0) {
      throw new ToolError('tool.invalid_args', 'propose_expense: accountId (string) is required');
    }
    if (args.categoryId !== undefined && (typeof args.categoryId !== 'string' || args.categoryId.length === 0)) {
      throw new ToolError('tool.invalid_args', 'propose_expense: categoryId must be a non-empty string when provided');
    }
  } else if (name === 'list_categories') {
    // Value enum (kind=expense|income) is validated by the REAL handler
    // (§5 contract: the tool mirrors the wire shape, the route owns domain
    // validation, so a bad value returns the real 400 — never a tool guess).
    if (args.kind !== undefined && typeof args.kind !== 'string') {
      throw new ToolError('tool.invalid_args', 'list_categories: kind must be a string');
    }
  } else {
    // Value enums (kind/includeInactive) are validated by the REAL handler
    // (§5 contract: the tool mirrors the wire shape, the route owns domain
    // validation, so a bad value returns the real 400 — never a tool guess).
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
    const q = new URLSearchParams();
    if (args.kind) q.set('kind', args.kind);
    const qs = q.toString();
    return qs ? `/categories?${qs}` : '/categories';
  }
  if (name === 'propose_expense') return '/pending-operations/v2/propose';
  return `/dashboard/month-summary?yearMonth=${encodeURIComponent(args.yearMonth)}`;
}

// transport: async ({ route, method, host, seed, fault, workspaceId, tokenStore, delayMs, timeoutMs }) ->
//   { statusCode, body, meta }. Host is passed per call; the transport module
// holds NO token state (no global mutable swapping, §6).
export function createToolExecutors(transport) {
  const run = async (name, args, host, opts = {}) => {
    // Explicit fail-closed: hostless execution is BLOCKED BY DESIGN (the
    // native prompt-loop path carries no host-bound identity in this spike:
    // no synthetic host, no LLM invocation). Refuse here with a TYPED code
    // instead of falling through to an incidental transport rejection, so the
    // registered plugin tools can never execute without a host-bound context
    // (spike02-fix-r2). Checked BEFORE arg validation: no host => refuse,
    // regardless of args.
    if (!host || typeof host.token !== 'string' || host.token.length === 0) {
      throw new ToolError('host_context_required', `${name}: host-bound context is required — hostless execution is blocked by design`);
    }
    // Intention contract (spike 03A-T3): every finance call carries a STABLE
    // opts.intentionId (never in args — FORBIDDEN_KEYS rejects it there).
    // Reads use it as idempotency/correlation identity; future WRITES (none
    // exist) must present a stable intentionId derived via deriveIntentionId
    // PLUS a valid host binding. The native CallID rides along ONLY as
    // technical correlation (opts.callId) and is NEVER identity.
    // Checked BEFORE transport: no stable intention => refuse, no spawn.
    const intentionId = opts ? opts.intentionId : undefined;
    if (typeof intentionId !== 'string' || intentionId.length === 0) {
      throw new ToolError('tool.invalid_args', `${name}: stable intentionId is required in opts (derive via deriveIntentionId — a CallID is correlation only, never identity)`);
    }
    const safeArgs = validateToolArgs(name, args);
    const route = routeFor(name, safeArgs);
    // S05 write path: propose_expense is a proposal ONLY (Pending V2 is the
    // authority; no second state machine). The Idempotency-Key is derived
    // deterministically per (workspace, intentionId, operation) — stable
    // across retries, independent of the volatile CallID. Identity
    // (workspace/actor/device/token) is injected host-side by the bridge from
    // the frozen host binding — never from tool args (FORBIDDEN_KEYS above).
    // Confirmation NEVER happens via text ("sim" or otherwise): this executor
    // only calls propose; confirm/execute routes are not allowlisted and no
    // confirm tool exists, so nothing here can execute before an explicit
    // authenticated confirmation action.
    const isPropose = name === 'propose_expense';
    const idempotencyKey = isPropose
      ? deriveExpenseIdempotencyKey({ workspace: host.household, intentionId })
      : undefined;
    const delegated = isPropose ? { capabilities: ['financial.approval.propose'], requestId: intentionId } : undefined;
    const body = isPropose
      ? {
          tool: PROPOSE_EXPENSE_TOOL,
          normalizedArgs: {
            amountCents: safeArgs.amountCents,
            description: safeArgs.description,
            date: safeArgs.date,
            accountId: safeArgs.accountId,
            ...(safeArgs.categoryId !== undefined ? { categoryId: safeArgs.categoryId } : {}),
          },
        }
      : undefined;
    let result;
    try {
      // P1: opts can NEVER override routing/identity. Only the allowlisted
      // test-only passthrough fields are forwarded (intentionId/callId plus
      // the transport's own options: seed/fault/workspaceId/tokenStore/
      // access/delayMs/timeoutMs/signal); host/route/method are assigned
      // LAST so a hostile opts.host/route/method is dead on arrival. The
      // write body/key/delegation above are executor-constructed (never from
      // opts or args) and travel the same LAST-assignment path.
      const o = opts || {};
      result = await transport({
        intentionId,
        callId: o.callId,
        seed: o.seed,
        fault: o.fault,
        workspaceId: o.workspaceId,
        tokenStore: o.tokenStore,
        access: o.access,
        delayMs: o.delayMs,
        timeoutMs: o.timeoutMs,
        signal: o.signal,
        route,
        method: isPropose ? 'POST' : 'GET',
        host,
        ...(body !== undefined ? { body } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(delegated !== undefined ? { delegated } : {}),
      });
    } catch (e) {
      // tool.timeout and tool.cancelled are terminal caller-observable codes:
      // rethrow unwrapped so cancellation survives as tool.cancelled (fix-r2).
      if (e && (e.code === 'tool.timeout' || e.code === 'tool.cancelled')) throw e;
      throw new ToolError('tool.transport', `${name}: transport failed: ${(e && e.message) || e}`);
    }
    const { statusCode, body: responseBody } = result;
    if (statusCode >= 200 && statusCode < 300) return responseBody;
    const code = statusCode === 400 ? 'tool.invalid'
      : statusCode === 401 ? 'tool.unauthorized'
        : statusCode === 403 ? 'tool.forbidden'
          : statusCode === 404 ? 'tool.not_found'
            : statusCode === 409 ? 'tool.conflict'
              : statusCode === 422 ? 'tool.invalid'
                : statusCode === 500 ? 'tool.upstream_500'
                  : 'tool.upstream_error';
    // Fail-closed: upstream errors are rethrown with the real status/body.
    // Totals/proposals are NEVER fabricated (no zero-fill on error, §5).
    throw new ToolError(code, `${name}: upstream ${statusCode}`, { statusCode, body: responseBody });
  };
  return {
    list_accounts: (args, host, opts) => run('list_accounts', args, host, opts),
    list_categories: (args, host, opts) => run('list_categories', args, host, opts),
    get_month_summary: (args, host, opts) => run('get_month_summary', args, host, opts),
    propose_expense: (args, host, opts) => run('propose_expense', args, host, opts),
  };
}
