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
  },
];

// Identity/host keys must NEVER appear in tool args (host-bound identity, §6).
const FORBIDDEN_KEYS = new Set([
  'actorId', 'actor_id', 'actor',
  'workspaceId', 'workspace_id', 'workspace',
  'householdId', 'household_id', 'household',
  'token', 'deviceToken', 'device_token', 'deviceId', 'device_id',
  'sessionId', 'session_id', 'intentionId', 'authorization',
]);

function knownKeys(name) {
  return name === 'list_accounts' ? ['kind', 'includeInactive'] : ['yearMonth'];
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
    const safeArgs = validateToolArgs(name, args);
    const route = routeFor(name, safeArgs);
    let result;
    try {
      result = await transport({ route, method: 'GET', host, ...opts });
    } catch (e) {
      if (e && e.code === 'tool.timeout') throw e;
      throw new ToolError('tool.transport', `${name}: transport failed: ${(e && e.message) || e}`);
    }
    const { statusCode, body } = result;
    if (statusCode >= 200 && statusCode < 300) return body;
    const code = statusCode === 400 ? 'tool.invalid'
      : statusCode === 401 ? 'tool.unauthorized'
        : statusCode === 403 ? 'tool.forbidden'
          : statusCode === 404 ? 'tool.not_found'
            : statusCode === 500 ? 'tool.upstream_500'
              : 'tool.upstream_error';
    // Fail-closed: upstream errors are rethrown with the real status/body.
    // Totals are NEVER fabricated (no zero-fill on error, §5).
    throw new ToolError(code, `${name}: upstream ${statusCode}`, { statusCode, body });
  };
  return {
    list_accounts: (args, host, opts) => run('list_accounts', args, host, opts),
    get_month_summary: (args, host, opts) => run('get_month_summary', args, host, opts),
  };
}
