import { emitSanitizedEvent } from '../observability/events.js';
import { resolveBareModelName } from './attempts.js';

/**
 * Item 5 (Onda 2) — failover restrito do relay `/rpc/chat`.
 *
 * O relay (`POST /internal/agent/llm-relay` na API) é o único transporte do
 * canal `pwa-rest`. Este módulo resolve o par concreto (provider + bare model)
 * pelo mecanismo runtime existente, classifica elegibilidade com regra
 * explícita de relay e executa no máximo UMA primária + UM fallback distinto.
 *
 * Deliberadamente NÃO reutiliza `isRetryableLlmError`: aquele classificador
 * legado trata 401/403/5xx genéricos como retryable, o que ampliaria o
 * fallback para negações de política/autoridade. Aqui só há fallback em:
 * - HTTP 429 com `agent.rate_limited` (rate limit operacional);
 * - timeout de provider (`AbortError`/`TimeoutError` ou
 *   `agent.provider_timeout`, em geral HTTP 504);
 * - erro operacional demonstrado do provider (`agent.provider_error` com
 *   status 5xx — a API responde 502 nesse caso).
 *
 * Todo o resto falha fechado em 1-shot com o `{code,status}` estruturado do
 * relay preservado: `validation.error`/400, `auth.invalid_token`/401,
 * `agent.provider_auth`, `agent.model_not_allowlisted`/403, 409 de
 * autoridade/epoch, `agent.provider_not_configured`/503,
 * `agent.relay_allowlist_unavailable`/503, `agent.inference_error`,
 * saída inválida local e qualquer código não classificado.
 *
 * Allowlist/chave por perna: a API é a autoridade (allowlist + key por
 * provider no relay); o agente nunca envia segredo de provider. Por perna o
 * agente verifica apenas o que lhe cabe sem segredo — provider relayável +
 * bare model resolvido + distinto — e a API nega o resto com 403/503, que
 * este classificador nunca transforma em fallback.
 *
 * Limite de gasto/latência: no máximo 2 attempts por turno; cada perna tem o
 * budget explícito de 60 s (espelha `requestTimeoutMs` default da rota
 * `internal-agent-llm-relay.ts` da API), sem default ilimitado — o `fetch`
 * sempre carrega `AbortSignal.timeout`.
 */

export const RELAYABLE_PROVIDERS: ReadonlySet<string> = new Set([
  'opencode-zen',
  'opencode-go',
  'openai-api',
  'openrouter',
]);

/** Budget por perna de relay — espelha o default da API (60 s). */
export const RELAY_ATTEMPT_TIMEOUT_MS = 60_000;

/** Teto de attempts por turno: 1 primária + 1 fallback. */
export const RELAY_MAX_ATTEMPTS = 2;

export type RelayTarget = {
  providerId: string;
  modelName: string;
};

export type RelaySnapshot = {
  provider_id: string;
  model_id: string;
  model_name?: string | null;
  fallback_provider_id?: string | null;
  fallback_model_id?: string | null;
  fallback_model_name?: string | null;
};

export type RelayFallbackOmittedReason =
  | 'no_fallback_configured'
  | 'fallback_indistinct_from_primary'
  | 'fallback_provider_not_relayable'
  | 'fallback_unresolvable_model';

export const isRelayableProvider = (providerId: string): boolean =>
  RELAYABLE_PROVIDERS.has(providerId);

/**
 * Resolve o par executável do relay pelo mecanismo existente
 * (`resolveBareModelName`: nome persistido vence, senão só o prefixo
 * convencional `provider_id:`; row id opaco => null, fail-closed).
 * O fallback precisa ainda ser relayável e distinto da primária.
 */
export const resolveRelayTargets = (
  snapshot: RelaySnapshot,
): {
  primary: RelayTarget | null;
  fallback: RelayTarget | null;
  fallbackOmittedReason: RelayFallbackOmittedReason | null;
} => {
  const primaryName = resolveBareModelName(snapshot.provider_id, snapshot.model_id, snapshot.model_name);
  const primary: RelayTarget | null =
    primaryName && isRelayableProvider(snapshot.provider_id)
      ? { providerId: snapshot.provider_id, modelName: primaryName }
      : null;

  if (!snapshot.fallback_provider_id || !snapshot.fallback_model_id) {
    return { primary, fallback: null, fallbackOmittedReason: 'no_fallback_configured' };
  }
  if (!isRelayableProvider(snapshot.fallback_provider_id)) {
    return { primary, fallback: null, fallbackOmittedReason: 'fallback_provider_not_relayable' };
  }
  const fallbackName = resolveBareModelName(
    snapshot.fallback_provider_id,
    snapshot.fallback_model_id,
    snapshot.fallback_model_name,
  );
  if (!fallbackName) {
    return { primary, fallback: null, fallbackOmittedReason: 'fallback_unresolvable_model' };
  }
  if (
    primary &&
    snapshot.fallback_provider_id === primary.providerId &&
    fallbackName === primary.modelName
  ) {
    return { primary, fallback: null, fallbackOmittedReason: 'fallback_indistinct_from_primary' };
  }
  return {
    primary,
    fallback: { providerId: snapshot.fallback_provider_id, modelName: fallbackName },
    fallbackOmittedReason: null,
  };
};

type RelayErrorShape = {
  name?: string;
  status?: number;
  statusCode?: number;
  code?: string;
};

/**
 * Classificador explícito de fallback do relay. Retorna true SOMENTE para
 * rate limit (429 + `agent.rate_limited`), timeout de provider e erro
 * operacional (`agent.provider_error` + 5xx). Qualquer outro status/code —
 * incluindo 401/403/409/503 que o `isRetryableLlmError` legado trataria como
 * retryable — retorna false.
 *
 * FIX-AGENT-RELAY-FAILOVER-HARDENING (D): `agent.provider_timeout` só é
 * elegível com o status coerente de timeout do contrato da API (504) ou com
 * o nome local reconhecido (`AbortError`/`TimeoutError`, tratado acima). Um
 * `provider_timeout` contraditório com 400/401/403/409 (ou sem status) é
 * inelegível — o código sozinho não autoriza fallback.
 */
export const isRelayFallbackEligible = (err: unknown): boolean => {
  const e = err as RelayErrorShape | null;
  if (!e) return false;
  const status =
    typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null;
  const code = typeof e.code === 'string' ? e.code : '';
  const name = (e as { name?: unknown }).name;
  const isAbortName = name === 'AbortError' || name === 'TimeoutError';
  if (isAbortName) {
    const hasStatus = status !== null;
    const hasCode = code.length > 0;
    // W2: pure local timeout (no status/code) stays eligible. Any explicit
    // status/code contradicts the bare name and wins — fall through to the
    // status/code rules below so AbortError+403+model_not_allowlisted and
    // TimeoutError+409+security_epoch_changed stay ineligible.
    if (!hasStatus && !hasCode) return true;
  }
  if (code === 'agent.provider_timeout') return status === 504;
  if (status === 429 && code === 'agent.rate_limited') return true;
  if (code === 'agent.provider_error' && status !== null && status >= 500 && status <= 599) return true;
  return false;
};

/**
 * FIX-AGENT-RELAY-FAILOVER-HARDENING (B/C): reason codes sanitizados. Só
 * códigos da allowlist sobrevivem; qualquer `code` arbitrário vindo do
 * upstream (que poderia carregar injeção com newline/segredo) degrada para
 * `unknown_error`. Sem isso o código bruto vazaria na mensagem composta e
 * na telemetria.
 */
const SAFE_RELAY_REASON = /^(agent\.[a-z_]+|http_\d{3}|timeout|unknown_error|unresolvable_model)$/;

const sanitizeRelayReason = (reason: string): string => {
  const clean = String(reason ?? '')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, '')
    .slice(0, 64);
  return SAFE_RELAY_REASON.test(clean) ? clean : 'unknown_error';
};

/** Razão sanitizada (só códigos, nunca prompt/transcript/segredo). */
export const relayFailoverReasonOf = (err: unknown): string => {
  const e = err as RelayErrorShape | null;
  if (!e) return 'unknown_error';
  const name = (e as { name?: unknown }).name;
  const isAbortName = name === 'AbortError' || name === 'TimeoutError';
  const codeRaw = typeof e.code === 'string' ? e.code : '';
  const status =
    typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null;
  if (isAbortName) {
    // W2: status/code explícito contradiz o nome puro e prevalece — só o
    // timeout puro (sem status/code) mapeia para 'timeout'. Coerente
    // provider_timeout+504 preserva o code; contraditório preserva code/http.
    const hasStatus = status !== null;
    const hasCode = codeRaw.length > 0;
    if (!hasStatus && !hasCode) return 'timeout';
    if (hasCode) return sanitizeRelayReason(codeRaw);
    if (hasStatus) return `http_${status}`;
    return 'timeout';
  }
  if (typeof e.code === 'string' && e.code.length > 0) return sanitizeRelayReason(e.code);
  if (status !== null) return `http_${status}`;
  return 'unknown_error';
};

/**
 * FIX-AGENT-RELAY-FAILOVER-HARDENING (B): mensagens públicas fixas por
 * code/status para falhas do relay. O `{code,status}` estruturado é
 * preservado; o `body.message` bruto do upstream NUNCA é ecoado para o
 * `/rpc/chat` — ele pode conter system prompt, segredos ou injeção.
 */
export const relayPublicMessage = (code: string, status: number): string => {
  if (status === 400) return 'Não foi possível processar a solicitação.';
  if (status === 401) return 'Não foi possível autenticar a solicitação.';
  if (status === 403) return 'Modelo não permitido no relay.';
  if (status === 409) return 'Configuração de IA atualizada durante o turno. Tente de novo.';
  if (status === 429) return 'Limite de uso do provedor atingido. Tente novamente.';
  if (
    status === 503 &&
    (code === 'agent.provider_not_configured' || code === 'agent.relay_allowlist_unavailable')
  ) {
    return 'Provedor não configurado.';
  }
  if (status >= 500 && status <= 599) return 'Falha temporária do provedor. Tente novamente.';
  return 'Falha ao processar a solicitação.';
};

/**
 * FIX-AGENT-RELAY-FAILOVER-HARDENING (B): `code` vindo do JSON do upstream é
 * dado não confiável — só o charset da allowlist sobrevive; o resto degrada
 * para `http_<status>`. O status HTTP (número, do `fetch`) é confiável.
 */
export const sanitizeRelayCode = (raw: unknown, status: number): string => {
  if (typeof raw === 'string' && /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(raw)) return raw;
  return `http_${status}`;
};

export type SafeRelayError = Error & { code: string; status: number };

/**
 * FIX-AGENT-RELAY-FAILOVER-HARDENING (B): converte qualquer falha de perna
 * do relay em erro seguro — mesmo `{code,status}`, mensagem pública fixa.
 * Falhas locais de abort sem status mapeiam para o timeout coerente
 * (504 + `agent.provider_timeout`).
 */
export const toSafeRelayError = (err: unknown): SafeRelayError => {
  const e = err as { name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : '';
  const isAbortName = name === 'AbortError' || name === 'TimeoutError';
  const rawStatusCandidate =
    typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : null;
  const hasExplicitStatus =
    rawStatusCandidate !== null && rawStatusCandidate >= 400 && rawStatusCandidate < 600;
  const rawCodeStr = typeof e?.code === 'string' ? (e.code as string) : '';
  const hasExplicitCode = rawCodeStr.length > 0;
  // W2: só o timeout puro (Abort/Timeout sem status/code) mapeia para o
  // timeout coerente (504 + agent.provider_timeout). Status/code explícito
  // contradiz o nome e prevalece — AbortError+403+model_not_allowlisted
  // preserva 403+code; TimeoutError+409+security_epoch_changed preserva
  // 409+code; provider_timeout+504 coerente continua 504.
  if (isAbortName && !hasExplicitStatus && !hasExplicitCode) {
    return Object.assign(new Error(relayPublicMessage('agent.provider_timeout', 504)), {
      code: 'agent.provider_timeout',
      status: 504,
    });
  }
  const rawStatus =
    typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : null;
  const status = rawStatus !== null && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 502;
  const code = sanitizeRelayCode(typeof e?.code === 'string' ? e.code : '', status);
  return Object.assign(new Error(relayPublicMessage(code, status)), { code, status });
};

/**
 * FIX-AGENT-LOG-CORRELATION-AND-ABORT-STATUS (W2): correlação opaca por
 * evento. O `intentionId` é fornecido pelo usuário (pode conter newline,
 * marker ou injeção, e é previsível — FNV determinístico NÃO é suficiente) e
 * nunca entra verbatim no log. Cada chamada gera um `corr-<hex>` aleatório
 * independente; o input é ignorado para correlação (mantido na assinatura
 * por compatibilidade com os call sites).
 */
export const newRelayCorrelation = (): string => {
  try {
    const uuid = (globalThis.crypto as unknown as { randomUUID?: () => string })?.randomUUID?.();
    if (typeof uuid === 'string' && uuid.length > 0) {
      return `corr-${uuid.replace(/-/g, '').slice(0, 16)}`;
    }
  } catch {
    // Fall through to Math.random fallback below.
  }
  const rand = `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  return `corr-${rand.replace(/[^0-9a-f]/gi, '').slice(0, 16).padStart(16, '0')}`;
};

export const toOpaqueCorrelation = (_raw: string): string => newRelayCorrelation();

export type RelayDoubleFailureFields = {
  intentionId: string;
  primaryProviderId: string;
  primaryModelId: string;
  fallbackProviderId?: string | null;
  fallbackModelId?: string | null;
  primaryReason: string;
  fallbackReason: string;
};

/**
 * FIX-AGENT-RELAY-FAILOVER-HARDENING (C): telemetria da falha dupla — quando
 * a primária era elegível, o fallback foi realmente invocado e AMBAS as
 * pernas falharam, emite UM evento sanitizado com o par de reason codes.
 * Nunca prompt, corpo/message bruto do provider, nem intentionId verbatim
 * (só a correlação opaca). Nunca chamada em 1-shot, sem fallback ou
 * sucesso da primária.
 */
export const logRelayDoubleFailure = (
  fields: RelayDoubleFailureFields,
  log = console.info,
): void => {
  const correlation = toOpaqueCorrelation(fields.intentionId);
  const primaryReason = sanitizeRelayReason(fields.primaryReason);
  const fallbackReason = sanitizeRelayReason(fields.fallbackReason);
  const fallbackProvider = fields.fallbackProviderId ?? '-';
  const fallbackModel = fields.fallbackModelId ?? '-';
  // FIX-AGENT-FAILOVER-LOGGER-BEST-EFFORT: telemetry is best-effort — a
  // throwing logger must never mask the already constructed
  // RelayAttemptsError in the finance-chat-agent catch path.
  try {
    log(
      `llm.relay.double_failure corr=${correlation} primary=${fields.primaryProviderId}/${fields.primaryModelId} fallback=${fallbackProvider}/${fallbackModel} primary_reason=${primaryReason} fallback_reason=${fallbackReason}`,
    );
  } catch {
    // Observability must never break the turn.
  }
  try {
    emitSanitizedEvent(
      'provider.fallback',
      {
        provider: fields.primaryProviderId,
        model: fields.primaryModelId,
        fallback: true,
        status: 'both_failed',
        primaryReason,
        fallbackReason,
        correlation,
      },
      log,
    );
  } catch {
    // Observability must never break the turn.
  }
};

export type RelayAttemptsError = Error & {
  code: 'agent.provider_not_configured' | 'agent.inference_error' | 'agent.security_epoch_changed';
  status: number;
  primaryReason: string | null;
  fallbackReason: string | null;
};

export type RelayAttemptsOutcome = {
  result: string;
  usedFallback: boolean;
  failoverReason: string | null;
  primary: RelayTarget;
  fallback: RelayTarget | null;
  /** 1 (primária venceu ou 1-shot) ou 2 (fallback executado). */
  attempts: number;
};

/**
 * Usage-quota passthrough: reservation denials and unavailable-ledger errors
 * thrown by the relay leg MUST NOT trigger provider fallback/retry and MUST
 * NOT be collapsed into the generic safe-relay 502. They carry the exact
 * typed `{code,status}` from the ledger gate and propagate verbatim through
 * the executor (primary and fallback legs alike).
 *
 * The `__usageQuotaPassthrough` marker is authoritative; the code set is a
 * backstop so a cloned/rethrown quota error without the marker still skips
 * fallback. Production quota codes:
 * - `agent.quota_exceeded` (429): atomic reservation denied (input cap or
 *   daily budget).
 * - `agent.usage_rate_limited` (429): the same atomic gate denied by the
 *   sliding window (FINDING 4). Distinct code for accurate client guidance,
 *   SAME passthrough semantics: no dispatch happened, so no retry/failover.
 *   Deliberately NOT `agent.rate_limited` — that one is the PROVIDER 429 from
 *   the API relay and MUST stay fallback-eligible (`isRelayFallbackEligible`).
 * - `agent.usage_input_cap` (429): the same atomic gate denied by the
 *   per-request input cap. Also nothing was dispatched — the oversized request
 *   never left — so it must not fail over either; the client is told to
 *   shorten the message instead of waiting for a budget to reset.
 * - `agent.usage_unavailable` / `agent.persistence_unavailable` (503):
 *   no atomic ledger (missing `transactionSync`) — fail closed pre-dispatch.
 */
export const USAGE_QUOTA_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  'agent.quota_exceeded',
  'agent.usage_rate_limited',
  'agent.usage_input_cap',
  'agent.usage_unavailable',
  'agent.persistence_unavailable',
]);

export const isUsageQuotaPassthroughError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  if ((err as { __usageQuotaPassthrough?: unknown }).__usageQuotaPassthrough === true) return true;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && USAGE_QUOTA_PASSTHROUGH_CODES.has(code);
};

/**
 * Executa no máximo 1 primária + 1 fallback distinto. A primária preserva seu
 * erro estruturado quando inelegível/sem fallback; quando ambas falham, lança
 * erro composto sanitizado (só reason codes). `authorizeBetween` é a
 * reautorização de epoch entre as pernas — se negar, o fallback nunca executa.
 */
export const executeRelayAttempts = async (opts: {
  primary: RelayTarget | null;
  fallback: RelayTarget | null;
  runLeg: (target: RelayTarget, attempt: 'primary' | 'fallback') => Promise<string>;
  authorizeBetween?: () => Promise<unknown>;
}): Promise<RelayAttemptsOutcome> => {
  const { primary, fallback } = opts;
  if (!primary) {
    throw Object.assign(new Error('TED ready: provider not configured'), {
      code: 'agent.provider_not_configured',
      status: 503,
      primaryReason: 'unresolvable_model',
      fallbackReason: null,
    }) as RelayAttemptsError;
  }
  let primaryErr: unknown = null;
  try {
    const result = await opts.runLeg(primary, 'primary');
    return { result, usedFallback: false, failoverReason: null, primary, fallback, attempts: 1 };
  } catch (err) {
    primaryErr = err;
  }
  // Usage-quota gate: a denied/unavailable reservation never authorizes a
  // provider dispatch, so it can never be retried on the fallback leg — the
  // exact typed error propagates before any eligibility check.
  if (isUsageQuotaPassthroughError(primaryErr)) throw primaryErr;
  // FIX-AGENT-RELAY-FAILOVER-HARDENING (B): falha única inelegível ou sem
  // fallback falha fechada em 1-shot com o `{code,status}` preservado e a
  // mensagem pública fixa — nunca o erro bruto (que pode carregar o
  // `body.message` do upstream).
  if (!fallback || !isRelayFallbackEligible(primaryErr)) throw toSafeRelayError(primaryErr);
  if (opts.authorizeBetween) {
    // Epoch/rollout re-verificados entre as pernas: revogação aqui nega o
    // fallback antes de qualquer segunda chamada ao provider.
    await opts.authorizeBetween();
  }
  const primaryReason = relayFailoverReasonOf(primaryErr);
  try {
    const result = await opts.runLeg(fallback, 'fallback');
    return { result, usedFallback: true, failoverReason: primaryReason, primary, fallback, attempts: 2 };
  } catch (fallbackErr) {
    // Same gate on the fallback leg: a quota denial there is the turn's
    // exact error, never composed into the generic double-failure 502.
    if (isUsageQuotaPassthroughError(fallbackErr)) throw fallbackErr;
    const fallbackReason = relayFailoverReasonOf(fallbackErr);
    throw Object.assign(
      new Error(`Falha na inferência (primário: ${primaryReason}; fallback: ${fallbackReason}).`),
      {
        code: 'agent.inference_error',
        status: 502,
        primaryReason,
        fallbackReason,
      },
    ) as RelayAttemptsError;
  }
};
