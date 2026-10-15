/**
 * Duplicate-detector agent tool
 *
 * Calls the authoritative API endpoint POST /transactions/detect-duplicate.
 * The endpoint is workspace-isolated and uses household_id from delegated token.
 * This tool mirrors the server's findDuplicate + formatDuplicateWarning logic.
 *
 * Agent delegates via apiFetch: uses X-Workspace-Id + Authorization Bearer delegatedToken
 * to hit ${API_ORIGIN}/transactions/detect-duplicate.
 * No local DB access; all duplicate semantics (jaccard >=0.6, window ±1 day, idempotency key exact) live server-side.
 * See apps/api/src/transactions/duplicate-detector.ts for canonical algorithm.
 */

export type DuplicateCheckInput = {
  kind: "expense" | "income" | "transfer";
  description: string;
  amountCents: number;
  date: string; // YYYY-MM-DD
  accountId?: string;
  fromAccountId?: string;
  toAccountId?: string;
  idempotencyKey?: string;
};

export type DuplicateMatch = {
  id: string;
  description: string;
  amount_cents: string;
  date: string;
  match_type: "idempotency_key" | "semantic";
  similarity: number;
};

export type DuplicateCheckResult = {
  duplicate_detected: boolean;
  match?: DuplicateMatch;
  warning?: string;
};

/**
 * Format warning identically to server's formatDuplicateWarning.
 * Kept client-side so agent can surface a human-readable message without extra round-trip.
 */
export function formatDuplicateWarning(match: DuplicateMatch, newDesc: string): string {
  const dateStr = new Date(match.date).toISOString().slice(0, 10);
  const amount = (parseInt(match.amount_cents, 10) / 100).toFixed(2);
  const simPct = Math.round(match.similarity * 100);
  if (match.match_type === "idempotency_key") {
    return `Já existe um lançamento com essa chave de idempotência: ${match.description} — R$ ${amount} em ${dateStr} ID: ${match.id} Quer registrar mesmo assim?`;
  }
  return `Achei um lançamento parecido: "${match.description}" — R$ ${amount} em ${dateStr} (${simPct}% similar) Seu novo: "${newDesc}" É o mesmo gasto?`;
}

export type DuplicateCheckOpts = {
  apiOrigin: string;
  workspaceId: string;
  delegatedToken: string;
  strict?: boolean;
  /**
   * FIX-186: budget explícito por verificação (default 10 s — detector é
   * leitura auxiliar do hot path financeiro, nunca pendência ilimitada).
   * Só encurta; valores at/acima do default saturam nele.
   */
  timeoutMs?: number;
  /** FIX-186: cancelamento do chamador (composto com o timeout interno). */
  signal?: AbortSignal;
};

/** Budget default do detector — leitura auxiliar, nunca ilimitada. */
export const DEFAULT_DUPLICATE_CHECK_TIMEOUT_MS = 10_000;

const resolveDuplicateTimeoutMs = (timeoutMs: unknown): number => {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.min(Math.trunc(timeoutMs), DEFAULT_DUPLICATE_CHECK_TIMEOUT_MS);
  }
  return DEFAULT_DUPLICATE_CHECK_TIMEOUT_MS;
};

const withDuplicateBudget = async <T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(Object.assign(new Error(`duplicate check timed out after ${timeoutMs}ms`), { name: 'TimeoutError' }));
  }, timeoutMs);
  if (timer.unref) timer.unref();
  const onCallerAbort = (): void => {
    controller.abort((callerSignal as AbortSignal).reason ?? new Error('aborted'));
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    return await run(controller.signal);
  } catch (err) {
    if (timedOut && (err as { name?: unknown } | null)?.name !== 'TimeoutError') {
      throw Object.assign(new Error(`duplicate check timed out after ${timeoutMs}ms`), { name: 'TimeoutError' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
};

/**
 * FIX-186: caminho não-strict é FAIL-CLOSED como o strict — falha de
 * detecção (HTTP não-ok, transporte, timeout, corpo malformado) NUNCA é
 * prova de inexistência de duplicata em fluxo financeiro. Retorna
 * `duplicate_detected: true` (suspeito, sem match) nesses casos, com budget
 * explícito e cancelamento. Tentativa única, sem loops.
 */
export const detectDuplicateViaApi = async (
  input: DuplicateCheckInput,
  opts: DuplicateCheckOpts,
): Promise<DuplicateCheckResult> => {
  if (opts.strict) return detectDuplicateStrictResult(input, opts);
  try {
    const budgetMs = resolveDuplicateTimeoutMs(opts.timeoutMs);
    const url = `${opts.apiOrigin.replace(/\/$/, "")}/transactions/detect-duplicate`;
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${opts.delegatedToken}`,
        "X-Workspace-Id": opts.workspaceId,
      },
      body: JSON.stringify(input),
    };
    // Budget cobre headers E corpo: fetch + leitura do JSON rodam sob o
    // mesmo AbortSignal/timer (corpo paralisado pós-headers estoura e cai
    // em fail-closed, nunca pendência ilimitada).
    const outcome = await withDuplicateBudget(budgetMs, opts.signal, async (signal) => {
      const res = await fetch(url, { ...init, signal });
      if (!res.ok) return { resOk: false as const, body: null as unknown };
      const body = (await res.json().catch(() => null)) as { duplicate_detected?: unknown; match?: DuplicateMatch } | null;
      return { resOk: true as const, body };
    });
    if (!outcome.resOk) return { duplicate_detected: true };
    const body = outcome.body;
    if (!body || typeof body.duplicate_detected !== 'boolean') return { duplicate_detected: true };
    if (!body.duplicate_detected) return { duplicate_detected: false };
    if (!body.match) return { duplicate_detected: true };
    return { duplicate_detected: true, match: body.match, warning: formatDuplicateWarning(body.match, input.description) };
  } catch {
    return { duplicate_detected: true };
  }
};

const detectDuplicateStrictResult = async (
  input: DuplicateCheckInput,
  opts: DuplicateCheckOpts,
): Promise<DuplicateCheckResult> => {
  try {
  const budgetMs = resolveDuplicateTimeoutMs(opts.timeoutMs);
  const url = `${opts.apiOrigin.replace(/\/$/, "")}/transactions/detect-duplicate`;
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${opts.delegatedToken}`,
      "X-Workspace-Id": opts.workspaceId,
    },
    body: JSON.stringify(input),
  };
  // Budget cobre headers E corpo (mesmo contrato do caminho não-strict).
  const outcome = await withDuplicateBudget(budgetMs, opts.signal, async (signal) => {
    const res = await fetch(url, { ...init, signal });
    if (!res.ok) return { resOk: false as const, body: null as unknown };
    const body = (await res.json()) as { duplicate_detected?: unknown; match?: DuplicateMatch };
    return { resOk: true as const, body };
  });
  if (!outcome.resOk) {
    return { duplicate_detected: true };
  }
  const body = outcome.body;
  if (typeof body.duplicate_detected !== 'boolean') return { duplicate_detected: true };
  if (!body.duplicate_detected) return { duplicate_detected: false };
  if (!body.match) return { duplicate_detected: true };
  return {
    duplicate_detected: true,
    match: body.match,
    warning: formatDuplicateWarning(body.match, input.description),
  };
  } catch {
    return { duplicate_detected: true };
  }
}

export const detectDuplicateSuspectedStrict = async (
  input: DuplicateCheckInput,
  opts: Omit<Parameters<typeof detectDuplicateViaApi>[1], 'strict'>,
): Promise<boolean> => (await detectDuplicateViaApi(input, { ...opts, strict: true })).duplicate_detected;

/**
 * Agent tool spec for use with the generated HTTP tools pipeline.
 * When running inside .pi/extensions/financial-tools, the canonical tool is generated from
 * apps/api/openapi/agent-tools.openapi.json (operationId: detect_duplicate).
 * This module is the human-readable documentation and a fallback direct implementation.
 */
export const duplicateDetectorToolSpec = {
  name: "detect_duplicate",
  label: "Detect Duplicate",
  description:
    "Check if a transaction would be a duplicate (idempotency_key exact or semantic amount+description+date±1d, jaccard >=0.6). Uses POST /transactions/detect-duplicate.",
  inputSchema: {
    kind: "expense | income | transfer",
    description: "string (1-240)",
    amountCents: "integer >=1",
    date: "YYYY-MM-DD",
    accountId: "uuid optional",
    fromAccountId: "uuid optional",
    toAccountId: "uuid optional",
    idempotencyKey: "string optional",
  },
  endpoint: "POST /transactions/detect-duplicate",
  workspaceIsolated: true,
} as const;
