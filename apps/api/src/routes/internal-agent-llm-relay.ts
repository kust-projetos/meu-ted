import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeCompareTokens as safeCompare } from '../auth/safe-compare.js';
import { isKindExecutable } from '../agent/llm-config.js';

const relayBody = z.object({
  provider: z
    .literal('opencode-zen')
    .or(z.literal('opencode-go'))
    .or(z.literal('openai-api'))
    .or(z.literal('openrouter')),
  model: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(16000),
  system: z.string().trim().max(8000).optional(),
  /**
   * FIX-API-OPENCODE-GO-SESSION-HEADER: stable per-conversation id the Go
   * upstream requires for routing/prompt-cache affinity (`x-opencode-session`).
   * Charset-bounded, never a free-form echo; opencode-zen/openai/openrouter
   * upstreams do not receive it.
   */
  sessionId: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, 'sessionId contains disallowed characters')
    .optional(),
});

const DEFAULT_ALLOWED_MODELS = new Set([
  // OpenCode Zen free models (no payment method required)
  'muse-spark-1.2-contributor-free',
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'hy3-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'laguna-s-2.1-free',
  // OpenRouter standard models fallback
  'openai/gpt-4o-mini',
  'deepseek/deepseek-chat',
  'google/gemini-2.0-flash-001',
]);

const RELAY_MODEL_CACHE_TTL_MS = 60_000;

const parseEnvAllowlist = (raw: string | undefined): string[] | null => {
  if (!raw) return null;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
};

export interface RelayModelSource {
  listModels(): Promise<Array<{ providerId: string; modelId: string; enabled: boolean; protocol?: string }>>;
  listProviders(): Promise<Array<{ id: string; enabled: boolean; kind: string }>>;
}

/**
 * Fase 2 item 8 + Fase 3 D3: resolves the relay model allowlist by priority —
 * RELAY_ALLOWED_MODELS env (csv, explicit admin override) wins, then the
 * enabled agent_llm_models (60s cache), then the built-in default set.
 * Env entries are authoritative as written; DB entries pass only when the
 * model is enabled AND its provider exists, is enabled and has an
 * executable kind — a disabled model or provider is never relayable.
 * A failing store does NOT fall back silently (see route handler: 503).
 *
 * Fase 3-FIX R7-rev: DB entries are keyed as `providerId:modelId` pairs so
 * the request provider is honored — the same model name under another
 * provider does not inherit allowlisting. Env/default entries are bare
 * names (no provider to pair with) and keep matching by name.
 */
export const createRelayModelResolver = (deps: {
  store?: RelayModelSource;
  cacheTtlMs?: number;
  now?: () => number;
} = {}): (() => Promise<{ allowed: Set<string>; protocols: Map<string, string> }>) => {
  const ttl = deps.cacheTtlMs ?? RELAY_MODEL_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  let cache: { at: number; allowed: Set<string>; protocols: Map<string, string> } | null = null;
  return async (): Promise<{ allowed: Set<string>; protocols: Map<string, string> }> => {
    const envList = parseEnvAllowlist(process.env.RELAY_ALLOWED_MODELS);
    if (envList) return { allowed: new Set(envList), protocols: new Map() };
    if (deps.store) {
      if (!cache || now() - cache.at >= ttl) {
        const [models, providers] = await Promise.all([
          deps.store.listModels(),
          deps.store.listProviders(),
        ]);
        const usableProviders = new Set(
          providers.filter((p) => p.enabled && isKindExecutable(p.kind)).map((p) => p.id),
        );
        const allowed = new Set<string>();
        const protocols = new Map<string, string>();
        for (const m of models) {
          if (!m.enabled || !usableProviders.has(m.providerId)) continue;
          const key = `${m.providerId}:${m.modelId}`;
          allowed.add(key);
          if (typeof m.protocol === 'string' && m.protocol.length > 0) {
            protocols.set(key, m.protocol);
          }
        }
        cache = { at: now(), allowed, protocols };
      }
      return { allowed: cache.allowed, protocols: cache.protocols };
    }
    return { allowed: DEFAULT_ALLOWED_MODELS, protocols: new Map() };
  };
};

/**
 * FIX-API-RELAY-MONOTONIC-AND-CANCEL (item6): monotonic clock for the relay
 * transport deadline. Production default is `performance.now()` (monotonic,
 * immune to wall-clock jumps); tests may inject a fake via `monotonicNow`.
 * `now` stays wall-clock for the model-allowlist cache TTL (absolute cache
 * timestamps, not a deadline). Deadline rechecks MUST use this clock only —
 * a `Date.now` jump backward must never revive a late body.
 */
const defaultRelayMonotonicNow = (): number => {
  try {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    if (perf && typeof perf.now === 'function') return perf.now();
  } catch {
    // Fall through to the wall clock below.
  }
  return Date.now();
};

/**
 * Best-effort upstream body release. Never awaited by the error path (the
 * timeout rejection must not wait for provider-stream teardown) and never
 * throws: a locked/consumed/mocked stream is fine to ignore. A returned
 * promise gets a swallowed catch so a rejecting `cancel()` cannot surface
 * as an unhandled rejection.
 */
const cancelUpstreamBody = (res: unknown): void => {
  try {
    const body = (res as Response | null | undefined)?.body as
      | { cancel?: unknown }
      | null
      | undefined;
    if (body && typeof body.cancel === 'function') {
      const out = (body.cancel as () => unknown).call(body) as
        | { catch?: unknown }
        | undefined;
      if (out && typeof (out as { catch?: unknown }).catch === 'function') {
        (out as Promise<unknown>).catch(() => {});
      }
    }
  } catch {
    // Best effort only.
  }
};
export const registerAgentLlmRelayRoutes = (
  app: FastifyInstance,
  deps: {
    adminToken: string;
    zenApiKey?: string;
    /** FIX-API-OPENCODE-GO-RELAY-KEY: distinct credential for the opencode-go provider (alias OPENCODE_GO_API_KEY). */
    opencodeGoApiKey?: string;
    /** H-02: real OpenAI parity — relay executes openai-api upstream instead of only allowlisting it. */
    openaiApiKey?: string;
    /** OpenRouter parity — relay executes openrouter upstream. */
    openrouterApiKey?: string;
    llmConfigStore?: RelayModelSource;
    cacheTtlMs?: number;
    now?: () => number;
    /** Monotonic clock for the transport deadline (default performance.now). */
    monotonicNow?: () => number;
    /** Full upstream budget (headers + body) in ms. Default 60s. */
    requestTimeoutMs?: number;
  },
): void => {
  const resolveAllowedModels = createRelayModelResolver({
    ...(deps.llmConfigStore ? { store: deps.llmConfigStore } : {}),
    ...(deps.cacheTtlMs !== undefined ? { cacheTtlMs: deps.cacheTtlMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  app.post('/internal/agent/llm-relay', async (req, reply) => {
    const rawToken = req.headers['x-agent-runtime-admin-token'];
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!token || !deps.adminToken || !safeCompare(token, deps.adminToken)) {
      return reply.code(401).send({ code: 'auth.invalid_token', message: 'Token administrativo inválido.' });
    }

    const parsed = relayBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: 'validation.error', issues: parsed.error.issues });
    }
    const { provider, model, prompt, system, sessionId } = parsed.data;

    // H-02: each relayable provider needs its own key — a missing key fails
    // closed before any upstream call.
    const isOpenAi = provider === 'openai-api';
    const isOpenRouter = provider === 'openrouter';
    const isGo = provider === 'opencode-go';
    const isOpenAiCompatible = isOpenAi || isOpenRouter;
    const providerApiKey = isOpenAi
      ? deps.openaiApiKey
      : isOpenRouter
        ? (deps.openrouterApiKey ?? process.env.OPENROUTER_API_KEY)
        : isGo
          ? (deps.opencodeGoApiKey ?? process.env.OPENCODE_GO_API_KEY)
          : deps.zenApiKey;
    if (!providerApiKey) {
      const missingEnv = isOpenAi
        ? 'OPENAI_API_KEY'
        : isOpenRouter
          ? 'OPENROUTER_API_KEY'
          : isGo
            ? 'OPENCODE_GO_API_KEY'
            : 'OPENCODE_ZEN_API_KEY';
      return reply.code(503).send({
        code: 'agent.provider_not_configured',
        message: `${missingEnv} não configurada na API.`,
      });
    }

    // Fase 3 D3: a configured store that fails resolves fail-closed with an
    // explicit operational code — never a silent fallback to the built-in set.
    let allowedModels: Set<string>;
    let modelProtocols: Map<string, string>;
    try {
      const resolved = await resolveAllowedModels();
      allowedModels = resolved.allowed;
      modelProtocols = resolved.protocols;
    } catch {
      return reply.code(503).send({
        code: 'agent.relay_allowlist_unavailable',
        message: 'Allowlist do relay indisponível (store de configuração inacessível).',
      });
    }
    // Fase 3-FIX R7-rev: the request provider scopes the allowlist — a DB
    // pair matches only as `providerId:modelId`, while env/default bare
    // names keep matching by name. A provider absent from the allowlist
    // (or disabled upstream of it) is 403, never borrowed from a sibling.
    if (!allowedModels.has(`${provider}:${model}`) && !allowedModels.has(model)) {
      return reply.code(403).send({ code: 'agent.model_not_allowlisted', message: 'Modelo não permitido no relay.' });
    }

    // FIX-API-RELAY-PROTOCOL-AWARE: the wire protocol is resolved from the
    // DB model row (server authority, same cached list as the allowlist).
    // openai/openrouter are chat-completions natively; opencode kinds follow
    // the registered model protocol so the whole go/zen catalogue (responses
    // AND chat-completions models) is servable — unknown pairs keep the
    // historical /responses default.
    const useChatCompletions =
      isOpenAiCompatible || modelProtocols.get(`${provider}:${model}`) === 'chat-completions';
    const baseUrl = provider === 'opencode-zen'
      ? 'https://opencode.ai/zen/v1'
      : provider === 'opencode-go'
        ? 'https://opencode.ai/zen/go/v1'
        : provider === 'openrouter'
          ? 'https://openrouter.ai/api/v1'
          : 'https://api.openai.com/v1';
    // H-02: allowlisted upstream origins only (H-06) — never a caller-supplied URL.
    const upstreamUrl = useChatCompletions ? `${baseUrl}/chat/completions` : `${baseUrl}/responses`;
    const upstreamHeaders: Record<string, string> = {
      authorization: `Bearer ${providerApiKey}`,
      'content-type': 'application/json',
      ...(isOpenRouter ? { 'HTTP-Referer': 'https://synkroo.com.br', 'X-Title': 'Pi Financeiro' } : {}),
      // FIX-API-OPENCODE-GO-SESSION-HEADER: the Go upstream rejects requests
      // without a stable session id (400 MissingSessionID). A caller-provided
      // id keeps prompt-cache affinity across turns; the generated fallback
      // only satisfies the contract (routing optimization is best-effort).
      ...(isGo
        ? { 'x-opencode-session': sessionId ?? `ted-${globalThis.crypto.randomUUID()}` }
        : {}),
    };
    const upstreamBody = useChatCompletions
      ? {
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }
      : {
        model,
        input: prompt,
        ...(system ? { instructions: system } : {}),
      };
    const requestTimeoutMs = deps.requestTimeoutMs ?? 60_000;
    const timeoutError = () => Object.assign(new Error('Timeout aguardando provider.'), { name: 'AbortError' });

    // W2-ITEM6 + FIX-API-RELAY-MONOTONIC-AND-CANCEL: ONE absolute deadline
    // spans fetch-to-headers + body parse, measured on a MONOTONIC clock
    // (`performance.now()` by default, injectable via `monotonicNow`).
    // Wall-clock `Date.now` jumps (NTP, DST, manual set) never move this
    // deadline. `controller.abort()` fires at the deadline, but the outer
    // Promise.race below is what guarantees a FINITE response: an upstream
    // fetch (or a response.json()) that ignores AbortSignal and never
    // settles cannot hang the relay — the deadline branch rejects as
    // AbortError instead. A single timer owns the whole operation (no
    // per-phase budget reset, default budget unchanged) and is cleared in
    // `finally` on every path. Late success after the deadline is rejected
    // by the monotonic recheck, never accepted or synthesized as success.
    // Whenever a response exists at timeout/late-discard time, its body is
    // released best-effort (`body.cancel()`, never awaited) so the provider
    // stream does not linger; the error path never waits for teardown.
    const monotonicNow = deps.monotonicNow ?? defaultRelayMonotonicNow;
    const startMark = monotonicNow();
    const isExpired = (): boolean => monotonicNow() - startMark >= requestTimeoutMs;
    try {
      const controller = new AbortController();
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      // Latest upstream response seen by the fetch branch. Shared with the
      // timer callback so a response that arrived just before the deadline
      // is still released, and with the background continuation so a
      // response resolving AFTER the race settled is canceled on discard.
      let seenResponse: Response | undefined;
      const deadlinePromise = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          controller.abort();
          cancelUpstreamBody(seenResponse);
          reject(timeoutError());
        }, requestTimeoutMs);
      });
      try {
        const { res, body } = await Promise.race([
          (async () => {
            const res = await fetch(upstreamUrl, {
              method: 'POST',
              headers: upstreamHeaders,
              body: JSON.stringify(upstreamBody),
              signal: controller.signal,
              // FIX-RELAY-NO-REDIRECT-FOLLOW: never follow an upstream 3xx —
              // the default fetch behavior would issue a second request to
              // the redirect target, potentially forwarding Authorization
              // outside the pinned endpoint. `manual` returns the 3xx
              // response as-is so the classifier below fails closed (502).
              redirect: 'manual',
            });
            seenResponse = res;

            // An abort-ignoring upstream (or mock) may resolve headers after
            // the budget — never accept a late byte as a valid response.
            // Monotonic recheck: immune to wall-clock shifts and to a
            // delayed timer callback (headers resolving before the callback
            // runs still fail closed here).
            if (isExpired()) {
              cancelUpstreamBody(res);
              throw timeoutError();
            }

            const body = (await res.json().catch(() => null)) as {
              error?: { type?: string; message?: string };
              output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
              choices?: Array<{ message?: { content?: string } }>;
              cost?: string | number;
            } | null;

            // Same recheck after the body: an immediate body may have settled
            // just as the deadline fired — it must not win over expiry.
            if (isExpired()) {
              cancelUpstreamBody(res);
              throw timeoutError();
            }

            return { res, body };
          })(),
          deadlinePromise,
        ]);

      if (!res.ok) {
        // FIX-RELAY-NO-REDIRECT-FOLLOW: with `redirect: 'manual'` above,
        // an upstream 3xx arrives here unfollowed (single pinned request,
        // no Authorization forwarded to any Location target). Fail closed
        // with the existing sanitized provider-error contract — same
        // status/code/message as the generic 5xx branch, never the
        // Location body.
        if (res.status >= 300 && res.status < 400) {
          return reply.code(502).send({
            code: 'agent.provider_error',
            message: 'Falha no provider. Tente novamente em instantes.',
          });
        }
        // FIX-API-RELAY-ALL-ERROR-MESSAGES-SAFE (W2 review): EVERY
        // non-2xx path returns a FIXED safe message keyed by class/status
        // only. The raw provider body (`body.error.message`) may echo the
        // prompt/system, leak key material, or carry CRLF/log injection, so
        // it is never relayed to the caller nor logged. The {code,status}
        // classifier contract is preserved: 429 stays 429 rate_limited
        // (fallback-eligible), 401/5xx stay 502 with their codes, other 4xx
        // stay 502 provider_rejected (item5, inelegível).
        if (res.status === 429) {
          return reply.code(429).send({
            code: 'agent.rate_limited',
            message: 'Provider com muitas requisições. Tente novamente em instantes.',
          });
        }
        if (res.status === 401) {
          return reply.code(502).send({
            code: 'agent.provider_auth',
            message: 'Falha de autenticação no provider.',
          });
        }
        if (res.status >= 500) {
          return reply.code(502).send({
            code: 'agent.provider_error',
            message: 'Falha no provider. Tente novamente em instantes.',
          });
        }
        if (res.status >= 400) {
          return reply.code(502).send({
            code: 'agent.provider_rejected',
            message: 'Provider rejeitou a requisição (conteúdo ou parâmetros inválidos).',
          });
        }
        return reply.code(502).send({
          code: 'agent.provider_error',
          message: 'Falha no provider. Tente novamente em instantes.',
        });
      }

      const text = useChatCompletions
        ? (body?.choices?.[0]?.message?.content ?? '')
        : (body?.output
          ?.filter((o) => o.type === 'message')
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text ?? '')
          .join('') ?? '');

      if (!text) {
        return reply.code(502).send({ code: 'agent.inference_error', message: 'No output generated by provider.' });
      }

        return reply.send({ text, model, cost: body?.cost ?? 0, provider });
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    } catch (err) {
      // FIX-API-RELAY-ALL-ERROR-MESSAGES-SAFE: transport/catch errors keep
      // the 504 agent.provider_timeout classification but the message is
      // fixed by class only — `err.message` (fetch internals, URLs,
      // AbortError text) is never echoed. W2-ITEM6 owns the absolute
      // transport deadline above and preserves these fixed messages.
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      return reply.code(504).send({
        code: 'agent.provider_timeout',
        message: isAbort ? 'Timeout aguardando provider.' : 'Falha de comunicação com o provider.',
      });
    }
  });
};