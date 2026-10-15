export type ApiRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  delegatedToken?: string;
  apiOrigin?: string;
  /**
   * FIX-186: budget explícito por operação (default 30 s, nunca ilimitado).
   * Só pode encurtar o budget — valores at/acima do default saturam nele,
   * de modo que o teto da plataforma nunca é ampliado por aqui.
   */
  timeoutMs?: number;
  /** FIX-186: cancelamento do chamador (composto com o timeout interno). */
  signal?: AbortSignal;
};

/** Budget default por request à API autoritativa — tentativa única, sem retry. */
export const DEFAULT_API_TIMEOUT_MS = 30_000;

let globalDelegatedToken: string | undefined;
let globalApiOrigin = 'https://api.synkroo.com.br';

export const setGlobalApiContext = (context: { delegatedToken?: string; apiOrigin?: string }): void => {
  if (context.delegatedToken !== undefined) globalDelegatedToken = context.delegatedToken;
  if (context.apiOrigin !== undefined) globalApiOrigin = context.apiOrigin;
};

/**
 * Test/turn-boundary helper: drops any token/origin left in the legacy
 * module-global slot. Production evidence reads never rely on the global
 * (they thread `delegatedToken` + `apiOrigin` explicitly per request), so a
 * previous turn's credential can never become the next turn's.
 */
export const clearGlobalApiContext = (): void => {
  globalDelegatedToken = undefined;
  globalApiOrigin = 'https://api.synkroo.com.br';
};

export const getGlobalApiContext = () => ({
  delegatedToken: globalDelegatedToken,
  apiOrigin: globalApiOrigin,
});

export type ApiErrorShape = Error & { statusCode?: number; code?: string };

/**
 * FIX-186: classificação de erros do client API.
 * - timeout (TimeoutError / abort pelo timer interno): INCERTO — a mutação
 *   pode ter executado; reconciliar (replay com a MESMA idempotencyKey)
 *   antes de retentar, nunca reemitir como nova operação.
 * - 401/403: DEFINITIVO de autoridade — erro apropriado, sem retry/fallback.
 * - 400/404/409/422: DEFINITIVO de domínio/validação — sem retry.
 * - 408/429/5xx/rede: INCERTO/TRANSITÓRIO — retry só com a mesma
 *   idempotencyKey e orçamento explícito por operação (o client faz UMA
 *   tentativa; quem retenta é o chamador, com reconciliação).
 */
export const isApiTimeoutError = (err: unknown): boolean =>
  (err as { name?: unknown } | null)?.name === 'TimeoutError';

export const isApiAuthError = (err: unknown): boolean => {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return status === 401 || status === 403;
};

export const isApiUncertainError = (err: unknown): boolean => {
  if (isApiTimeoutError(err)) return true;
  const e = err as { name?: unknown; statusCode?: unknown; code?: unknown } | null;
  if (e?.name === 'AbortError') return true;
  const status = typeof e?.statusCode === 'number' ? e.statusCode : null;
  if (status !== null) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }
  const code = typeof e?.code === 'string' ? e.code : '';
  return /^(api\.request_timeout|api\.request_aborted|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch_failed|network_error|timeout)$/i.test(code);
};

export const requestPiApiJson = async <T = Record<string, unknown>>(
  method: string,
  path: string,
  opts: ApiRequestOptions = {},
): Promise<T> => {
  const origin = opts.apiOrigin ?? globalApiOrigin;
  const url = new URL(path, origin);  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  // Token isolation: callers that thread the per-turn credential pass an
  // explicit `delegatedToken` key (even when its value is `undefined` for an
  // unauthenticated read). An explicit key is authoritative — the legacy
  // module-global is consulted ONLY when the caller omits the key entirely,
  // so a previous turn's token can never leak into a later turn's request
  // through the global fallback (fail-closed, never stale).
  const token = Object.prototype.hasOwnProperty.call(opts, 'delegatedToken')
    ? opts.delegatedToken
    : globalDelegatedToken;
  const headers: Record<string, string> = {
    accept: 'application/json',
  };

  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }

  if (opts.idempotencyKey) {
    headers['idempotency-key'] = opts.idempotencyKey;
  }

  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      if (v !== undefined) {
        headers[k.toLowerCase()] = String(v);
      }
    }
  }

  let body: string | undefined;
  if (opts.body !== undefined && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  // FIX-186: timeout explícito + cancelamento. Uma tentativa por chamada —
  // sem loops/retries aqui; retry (se houver) é decisão do chamador com a
  // MESMA idempotencyKey após reconciliação. O timer interno aborta o fetch;
  // o signal do chamador compõe com ele. Timeout do timer vira TimeoutError
  // (incerto: pode ter executado); abort externo vira AbortError.
  const rawTimeout = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : NaN;
  const timeoutMs =
    Number.isFinite(rawTimeout) && (rawTimeout as number) > 0
      ? Math.min(Math.trunc(rawTimeout as number), DEFAULT_API_TIMEOUT_MS)
      : DEFAULT_API_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(Object.assign(new Error(`api request timed out after ${timeoutMs}ms`), { name: 'TimeoutError' }));
  }, timeoutMs);
  if (timer.unref) timer.unref();
  const onCallerAbort = (): void => {
    controller.abort((opts.signal as AbortSignal).reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw Object.assign(new Error('aborted'), { name: 'AbortError', ...(opts.signal.reason instanceof Error ? { cause: opts.signal.reason } : {}) });
    }
    opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    const res = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const message = typeof errorBody.message === 'string' ? errorBody.message : `HTTP ${res.status}`;
      const err = new Error(message);
      (err as { statusCode?: number; code?: string }).statusCode = res.status;
      (err as { statusCode?: number; code?: string }).code = typeof errorBody.code === 'string' ? errorBody.code : 'api.request_failed';
      throw err;
    }

    return (await res.json()) as T;
  } catch (err) {
    // Normaliza abort do timer para TimeoutError (incerto) mesmo quando o
    // fetch expõe como AbortError genérico; abort externo segue AbortError.
    if (timedOut && (err as { name?: unknown } | null)?.name !== 'TimeoutError') {
      throw Object.assign(new Error(`api request timed out after ${timeoutMs}ms`), { name: 'TimeoutError' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
};
