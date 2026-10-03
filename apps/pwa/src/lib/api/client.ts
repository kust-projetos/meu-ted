/**
 * API Client — canonical browser transport is the same-origin proxy
 * `/api/backend` (ADR-011: browser → /api/backend, HttpOnly cookie session
 * via Set-Cookie passthrough, allowlisted headers, Origin check, upstream
 * timeout, `no-store` responses).
 *
 * `NEXT_PUBLIC_PI_FINANCE_API_BASE_URL`, when explicitly set, overrides the
 * proxy — explicit dev/test escape hatch only (ADR-011 "Decisão": compatibilidade
 * transitória; T2.1/ADR-015 session-first Option C). It is never a published
 * production default: without it the browser always uses the proxy, and no
 * production hostname is an architectural dependency (V4.1 Phase 5, SPEC §12.6).
 *
 * Auth transport (ADR-011 compat window + ADR-015 Opção C, session-first):
 * the proxy forwards `cookie` (plus `authorization` when present) with
 * `credentials: "include"`, so same-origin requests authenticate via the
 * HttpOnly cookie and MUST NOT require localStorage tokens. The session
 * Bearer from localStorage remains as fallback for origins where the Secure
 * cookie is not persisted (localhost).
 *
 * T2.5 (ADR-015 Opção C): `x-device-token` is NEVER attached implicitly.
 * Normal calls (financial data, RPC, chat) authenticate via session
 * (cookie + compat bearer) and `X-Workspace-Id`; the device header travels
 * ONLY on explicitly scoped device flows (POST /auth/devices/register,
 * GET /auth/devices/me, rotation) via the explicit `token` option.
 *
 * TODO(ADR-011, review 2026-12-01): remove the localStorage session/device
 * fallback once the compat window closes — see ADR-011 "Decisão".
 *
 * All env reads happen at call-time, allowing tests to use vi.stubEnv.
 */

import { z, type ZodType } from "zod";
import { closeAllSockets } from "@/lib/auth/socket-registry";
import { CLIENT_EVENTS_STORAGE_KEY } from "@/lib/telemetry/client-events";
import {
  getSessionToken as getStoredSessionToken,
  getToken as getStoredDeviceToken,
} from "@/lib/auth/token-store";
import { clearOfflineSubjectId, setOfflineSubjectId } from "@/lib/auth/offline-subject";
import { setOfflineWorkspaceId } from "@/lib/auth/offline-identity";
import { isMembershipRevocation } from "@/lib/auth/auth-state-machine";
import { noteLegacyAuthUsage } from "@/lib/auth/legacy-usage";

export const responseSchema = z
  .object({
    ok: z.boolean().optional(),
    data: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .refine(
    (obj) => obj.ok !== undefined || obj.data !== undefined || obj.error !== undefined,
    { message: "Invalid API response envelope" },
  );

/** Canonical same-origin proxy base (ADR-011) — never a cross-origin default. */
const SAME_ORIGIN_BACKEND_PROXY = "/api/backend";

let activeWorkspaceId: string | undefined;

export function setActiveWorkspaceId(workspaceId: string | undefined): void {
  activeWorkspaceId = workspaceId;
  // T2.2 B4/D-V4-11: o id do workspace ativo (UUID opaco, não-credencial) é
  // persistido como offlineSubjectId no momento em que é definido após auth
  // válida — todo set passa por este choke point (workspace-context). Chave
  // dedicada, nunca IndexedDB de credencial. Best-effort, nunca quebra o fluxo.
  // Phase 3 (AUTH-02): o mesmo choke point alimenta o offlineWorkspaceId da
  // identidade V3 (somente UUID; recusado de forma silenciosa caso contrário).
  if (workspaceId !== undefined) {
    try {
      setOfflineSubjectId(workspaceId);
    } catch {
      /* noop */
    }
    try {
      setOfflineWorkspaceId(workspaceId);
    } catch {
      /* noop */
    }
  }
}

/** In-memory active workspace id (the persisted V3 binding lives in offline-identity). */
export function getActiveWorkspaceId(): string | undefined {
  return activeWorkspaceId;
}

export function clearActiveWorkspaceId(): void {
  activeWorkspaceId = undefined;
}
/**
 * Base-URL resolution order (V4.1 Phase 5, SPEC §12.6):
 * explicit override > static NEXT_PUBLIC env > same-origin default.
 *
 * The browser default is the same-origin proxy `/api/backend` — no
 * production hostname is an architectural dependency anymore. The env is a
 * static literal read (SPEC §12.3) and an explicit dev/test escape hatch.
 * SSR without env stays unconfigured (fail-closed).
 */
export function resolveApiBaseUrl(explicitOverride?: string): string | undefined {
  const explicit = explicitOverride?.replace(/\/$/, "");
  if (explicit) return explicit;
  const configured = process.env.NEXT_PUBLIC_PI_FINANCE_API_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  if (typeof window !== "undefined") return SAME_ORIGIN_BACKEND_PROXY;
  return undefined;
}

function baseUrl(): string | undefined {
  return resolveApiBaseUrl();
}

export function isApiConfigured(): boolean {
  return baseUrl() !== undefined;
}

/**
 * Returns the session token from the token-store (única abstração, T2.2 B2).
 * ADR-011 compat fallback: the same-origin proxy authenticates via the
 * HttpOnly cookie first — this Bearer is only a fallback for origins where
 * the Secure cookie is not persisted. See the TODO(ADR-011) in the header.
 * T2.3 B3.5: com NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off a token-store retorna
 * null (leitura removida) e nenhum Authorization de sessão é anexado.
 */
export function getSessionToken(): string | undefined {
  try {
    return getStoredSessionToken() ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the auth token from the token-store (única abstração, T2.2 B2).
 * ADR-011 compat fallback — see getSessionToken / header TODO(ADR-011).
 */
export function getAuthToken(): string | undefined {
  try {
    return getStoredDeviceToken() ?? undefined;
  } catch {
    return undefined;
  }
}

export const DEFAULT_API_TIMEOUT_MS = 15_000;

export interface ApiClientOptions extends RequestInit {
  /**
   * X-Device-Token header override — explicit opt-in ONLY for scoped device
   * flows (registration, verification, rotation, /auth/devices/*).
   * T2.5 (ADR-015 Opção C): apiFetch NEVER falls back to the device token
   * store implicitly; normal calls omit the header entirely.
   */
  token?: string;
  /** X-Idempotency-Key header */
  idempotencyKey?: string;
  /** Optional runtime response validation for protected API boundaries. */
  responseSchema?: ZodType<unknown>;
  /** Request timeout in milliseconds. Set to 0 to disable. Defaults to 15000ms. */
  timeoutMs?: number;
  /**
   * Suppresses the global `UNAUTHORIZED_EVENT` dispatch for THIS call only.
   *
   * Scoped use: a 401 that the caller can still recover from without ending
   * the session. Used by the agent connection-token mint, whose 401 means
   * "device inválido OU sessão expirada" and is retried after a fresh device
   * registration — expiring the session there would abort its own recovery.
   * The socket close is kept (the connection really was refused); only the
   * session-expiry signal is suppressed. Default false: every other call
   * keeps the central 401 contract unchanged.
   */
  skipUnauthorizedEvent?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Central 401 handling ─────────────────────────────────────────────────────
// Any 401 from the authoritative API (socket close + window event) lets every
// consumer react to session expiry without each caller handling 401 itself.

/**
 * Fired on `window` whenever apiFetch receives a 401, so any part of the app
 * (e.g. session expiry in AppStateProvider) can react without importing the
 * client or handling 401 per call-site.
 */
export const UNAUTHORIZED_EVENT = "pi-finance:unauthorized";

/**
 * Broadcasts the central session-expiry signal. `apiFetch` calls this on every
 * 401 unless the call opted out via `skipUnauthorizedEvent` — a caller that
 * opted out stays responsible for announcing an expiry it ultimately
 * confirms. Exported so those callers reuse the exact same event name and
 * dispatch instead of re-implementing the semantics.
 */
export const announceUnauthorized = (): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
};

/**
 * Fired on `window` whenever apiFetch receives a membership-revocation 403
 * (workspace_forbidden — the API revoked authorization on removeMember/leave,
 * Phase 1). Listeners take the unauthenticated transition (expireSession);
 * the client itself purges the offline snapshot best-effort (D10).
 */
export const FORBIDDEN_EVENT = "pi-finance:forbidden";

/**
 * D10 revocation purge: drop the offline subject partition and delete the
 * v2 snapshot so a revoked membership keeps no readable offline data.
 * Best-effort and non-blocking — purge failures never break the request
 * path (expireSession re-purges synchronously on the login transition).
 */
function purgeOfflineSnapshotOnRevocation(): void {
  try {
    clearOfflineSubjectId();
  } catch {
    /* noop */
  }
  void import("@/lib/state/snapshot-db")
    .then((db) => db.deleteV2Snapshot().catch(() => {}))
    .catch(() => {});
}

// ── Telemetry flush on the authenticated cycle ─────────────────────────────
// Queued mic.error events (V4 T0.4.7, SPEC §24.7) flush on the next
// successful same-origin request — that success IS the authenticated cycle.
// Best-effort and non-blocking: the peek is a single localStorage read, the
// flush itself never rejects into the request path, and the /client-events
// request itself never re-triggers (no recursion). Dynamic import keeps the
// transport one-directional (client-events → client) with no static cycle.

function maybeFlushClientEvents(path: string): void {
  if (path.startsWith("/client-events")) return;
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(CLIENT_EVENTS_STORAGE_KEY);
    if (!raw || raw === "[]") return;
  } catch {
    return;
  }
  void import("@/lib/telemetry/client-events")
    .then((events) => events.flushQueuedClientEvents())
    .catch(() => {
      /* queue stays durable for the next cycle */
    });
}

export async function apiFetch<T>(
  path: string,
  options: ApiClientOptions = {},
): Promise<T> {
  const {
    headers: optsHeaders,
    token,
    idempotencyKey,
    responseSchema,
    timeoutMs = DEFAULT_API_TIMEOUT_MS,
    signal: callerSignal,
    skipUnauthorizedEvent = false,
    ...rest
  } = options;
  // T2.5 (ADR-015 Opção C, session-first): the device token is attached
  // ONLY when passed explicitly (scoped device flows). Normal calls
  // authenticate via the cookie (+ compat session bearer) and MUST NOT
  // carry x-device-token, even when one sits in localStorage.
  const resolvedToken = token;
  const sessionToken = getSessionToken();

  // ADR-011: cookie session (credentials: "include" below) is primary on the
  // same-origin proxy path; localStorage headers are compat fallback only and
  // are omitted entirely when absent — the proxy MUST NOT require them.
  // T2.2: cada anexo de fallback conta na telemetria local (só contadores).
  // T2.5: o canal "device" agora conta só anexos explícitos de fluxos
  // escopados — o attach universal foi removido (ADR-015 Opção C).
  if (sessionToken) noteLegacyAuthUsage("session");
  if (resolvedToken) noteLegacyAuthUsage("device");
  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    ...(rest.body ? { "Content-Type": "application/json" } : {}),
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    ...(resolvedToken ? { "x-device-token": resolvedToken } : {}),
    ...(activeWorkspaceId ? { "X-Workspace-Id": activeWorkspaceId } : {}),
    ...((optsHeaders as Record<string, string>) ?? {}),
  };

  if (idempotencyKey) {
    requestHeaders["idempotency-key"] = idempotencyKey;
  }

  const controller = new AbortController();
  let callerAbortHandler: (() => void) | undefined;
  // FIX-SESSION-STATUS-BODY-TIMEOUT: status observado nos headers antes do
  // corpo — alimenta o timeout global para nunca mascarar 401/403 como 408.
  let observedAuthStatus: 401 | 403 | undefined;
  if (callerSignal) {
    callerAbortHandler = () => controller.abort();
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", callerAbortHandler, { once: true });
  }

  const request = async (): Promise<T> => {
    const res = await fetch(`${baseUrl() ?? ""}${path}`, {
      ...rest,
      signal: controller.signal,
      credentials: "include",
      headers: requestHeaders,
    });
    // FIX-SESSION-STATUS-BODY-TIMEOUT: preserve o status assim que os
    // headers chegam — se `res.json()` travar, o timeout global abaixo
    // rejeita com este status em vez de 408 (que viraria `unreachable`).
    if (res.status === 401) observedAuthStatus = 401;
    else if (res.status === 403) observedAuthStatus = 403;

    if (res.status === 401) {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch { /* noop */ }
      closeAllSockets("session expired");
      // A caller that opted out owns the recovery (see `skipUnauthorizedEvent`):
      // the refused connection is still torn down, but the session-expiry
      // signal is not broadcast behind its back.
      if (!skipUnauthorizedEvent) announceUnauthorized();
      throw new ApiError(
        401,
        (body.code as string) ?? "auth.error",
        (body.message as string) ?? "Token inválido",
      );
    }

    if (res.status === 403) {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch { /* noop */ }
      const code = (body.code as string) ?? "error";
      const message = (body.message as string) ?? "Acesso restrito";
      // State machine (SPEC §12.1): 403 is an explicit server rejection →
      // unauthenticated, never offline mode. Revocation-coded 403s additionally
      // purge the offline snapshot (D10) and notify listeners.
      if (isMembershipRevocation(403, body.code as string | undefined)) {
        closeAllSockets("workspace access revoked");
        purgeOfflineSnapshotOnRevocation();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(FORBIDDEN_EVENT));
        }
      }
      throw new ApiError(403, code, message);
    }

    if (res.status === 204) {
      maybeFlushClientEvents(path);
      return undefined as T;
    }

    if (!res.ok) {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch { /* noop */ }
      throw new ApiError(
        res.status,
        (body.code as string) ?? "error",
        (body.message as string) ?? `HTTP ${res.status}`,
      );
    }

    const payload: unknown = await res.json();
    maybeFlushClientEvents(path);
    return (responseSchema ? responseSchema.parse(payload) : payload) as T;
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs <= 0) return await request();
    return await new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        // FIX-SESSION-STATUS-BODY-TIMEOUT: headers 401/403 já recebidos mas
        // corpo travado — rejeição tipada no status original (defaults
        // seguros do caminho normal), nunca 408/unreachable. 401 espelha os
        // efeitos colaterais do caminho normal (sockets + evento); 403 sem
        // corpo não carrega código de revogação (isMembershipRevocation
        // exige código explícito), então só classifica — sem purge/evento.
        // Demais casos (fetch pendente, 200/5xx travados) seguem 408.
        if (observedAuthStatus === 401) {
          closeAllSockets("session expired");
          // Same opt-out as the body-parsed path above (see the option docs).
          if (!skipUnauthorizedEvent) announceUnauthorized();
          reject(new ApiError(401, "auth.error", "Token inválido"));
          return;
        }
        if (observedAuthStatus === 403) {
          reject(new ApiError(403, "error", "Acesso restrito"));
          return;
        }
        reject(new ApiError(408, "network.timeout", "Tempo limite de conexão excedido."));
      }, timeoutMs);
      void request().then(resolve, reject);
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (callerSignal && callerAbortHandler) {
      callerSignal.removeEventListener("abort", callerAbortHandler);
    }
  }
}

/** Convenience: GET with explicit token */
export function apiGet<T>(path: string, token: string): Promise<T> {
  return apiFetch<T>(path, { token });
}

/**
 * Telemetry transport for POST /client-events (V4 T0.4, SPEC §24): the only
 * approved endpoint-layer entry point for lib/telemetry — keeps raw apiFetch
 * confined to the lib/api boundary (write-policy/architecture invariants).
 */
export function postClientEvents(body: string): Promise<unknown> {
  return apiFetch<unknown>("/client-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

/** Convenience: POST with optional token */
export function apiPost<T>(
  path: string,
  token: string | null,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    token: token ?? undefined,
    idempotencyKey,
  });
}
