import { apiFetch, announceUnauthorized } from "./client";
import { registerDeviceToken } from "./auth";
import { getToken, setToken } from "../auth/token-store";

export type AgentConnectionTokenResponse = {
  token: string;
  expiresIn: number;
};

let cachedToken: {
  workspaceId: string;
  token: string;
  expiresAt: number;
} | null = null;

/**
 * H-13: registry of in-flight agent connections. Every agent request flight
 * (token mint, authenticated turn/history/session call, SSE stream) registers
 * its AbortController here and releases it on settle, so a session clear can
 * cancel everything still active with a single central call. Entries whose
 * signal already aborted are pruned on register (no unbounded growth).
 */
const trackedConnections = new Set<AbortController>();

const pruneTrackedConnections = (): void => {
  for (const controller of trackedConnections) {
    if (controller.signal.aborted) trackedConnections.delete(controller);
  }
};

export const trackAgentConnection = (
  externalSignal?: AbortSignal | null,
): { signal: AbortSignal; release: () => void } => {
  pruneTrackedConnections();
  const controller = new AbortController();
  trackedConnections.add(controller);
  let onExternalAbort: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    release: () => {
      trackedConnections.delete(controller);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    },
  };
};

/** H-13: cancels every tracked in-flight agent connection. Idempotent. */
export const abortAgentConnections = (): void => {
  for (const controller of trackedConnections) {
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }
  trackedConnections.clear();
};

/**
 * FIX-AGENT-MINT-SELF-HEAL: a cookie-only session leaves the device store
 * empty, which makes the mint deviceless (no H-12 `deviceId` claim) and every
 * approval/undo RPC answers 401. Register the device through the session and
 * persist the issued token. Single-flight: concurrent mints share ONE
 * registration instead of racing several device issuances.
 *
 * Auth channel: `registerDeviceToken` authenticates via the SESSION — the
 * HttpOnly cookie (`credentials: "include"`), plus, while the ADR-015
 * compatibility window is open (`NEXT_PUBLIC_LEGACY_BEARER_COMPAT`, flipped
 * off at the Release B gate), the session bearer stored locally that `apiFetch`
 * attaches implicitly as `Authorization`. The cookie is what identifies the
 * session; the attached bearer is the one stored locally, and it is expected
 * to be that same session because that is the premise of the compat window
 * (cookie primary, stored bearer only as a fallback) — an assumption this call
 * does not verify. After the flag is off the stored-bearer read is removed
 * and the call is cookie-only, with no change here.
 *
 * Never throws: a rejected/empty registration resolves to `null` so callers
 * keep the deviceless path exactly as before.
 */
let pendingDeviceSelfHeal: Promise<string | null> | null = null;

/**
 * Session generation: bumped by `clearAgentSession` (the central cleanup —
 * logout / 401 / workspace switch). A registration started under an older
 * generation must NOT act on its result when it settles: the session it was
 * issued for may no longer be the active one, so it must neither write to the
 * device store nor broadcast a session expiry over the new session.
 */
let sessionGeneration = 0;

const ensureDeviceToken = async (): Promise<string | null> => {
  if (pendingDeviceSelfHeal) return pendingDeviceSelfHeal;
  const generation = sessionGeneration;
  const run = async (): Promise<string | null> => {
    try {
      // FINDING 1 (review): suppression-aware. A 401 here is handled LOCALLY:
      // it may belong to a session this generation no longer owns, and the
      // global signal would expire whatever session is active now. The mint
      // announces a definitive expiry once its own retry is exhausted, which
      // is the only place that decision can be made correctly.
      const res = await registerDeviceToken(undefined, { skipUnauthorizedEvent: true });
      // Stale generation: the session was cleaned while this registration was
      // in flight. Write nothing and let the caller mint deviceless — the
      // next mint of the NEW generation registers its own device.
      if (generation !== sessionGeneration) return null;
      if (res?.token) {
        // Overwrite, never clear: the stale token stays harmless because the
        // scoped device flow (T2.5) never presents it.
        setToken(res.token);
        return res.token;
      }
      return null;
    } catch {
      return null;
    }
  };
  const selfHeal: Promise<string | null> = run().finally(() => {
    // FINDING 2 (review): release the slot ONLY if it is still ours. A
    // cleanup may already have handed it to a newer generation's
    // registration; clearing it here would let a third registration start in
    // that generation.
    if (pendingDeviceSelfHeal === selfHeal) pendingDeviceSelfHeal = null;
  });
  pendingDeviceSelfHeal = selfHeal;
  return selfHeal;
};

/**
 * Status-based 401 check: `apiFetch` throws `ApiError`, but a caller-visible
 * wrapper must not depend on the class identity surviving bundling/mocks —
 * only the observed HTTP status is load-bearing here.
 */
const isUnauthorized = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { status?: unknown }).status === 401;

/**
 * FINDING 3 (review): the mint suppresses the expiry signal so its own retry
 * can run. Once the retry is exhausted the 401 is definitive, and the caller
 * owes the app the central announcement — but only while the session that
 * produced it is still the active one. A generation bump means another session
 * owns the app now, and a dead session's failure must not tear it down.
 */
function throwWithExpirySignal(err: unknown, generation: number): never {
  if (generation === sessionGeneration) announceUnauthorized();
  throw err;
}

export const fetchAgentToken = async (
  workspaceId: string,
  forceFresh = false,
): Promise<{ token: string; expiresIn: number }> => {
  const tokenString = await fetchAgentConnectionToken(workspaceId, forceFresh);
  return { token: tokenString, expiresIn: 90 };
};

export const fetchAgentConnectionToken = async (
  workspaceId: string,
  forceFresh = false,
): Promise<string> => {
  const now = Date.now();
  if (!forceFresh && cachedToken && cachedToken.workspaceId === workspaceId && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  // H-13: the mint flight is tracked so logout/401/switch aborts it.
  const { signal, release } = trackAgentConnection();
  try {
    // FIX-PWA-DEVICE-BOUND-MINT: the mint carries the device token via the
    // T2.5 EXPLICIT channel (apiFetch `token` → `x-device-token`), so the API
    // emits a device-bound JWT (H-12). Without it the Worker deletes
    // `x-agent-device` and every approval/undo RPC answers 401
    // `agent.approval_context_required`. Explicit + scoped: this is not the
    // banned universal attach — regular calls stay cookie-only.
    //
    // FIX-AGENT-MINT-SELF-HEAL: a cookie-only session (the AuthGate boot path
    // never registers a device) leaves the store empty, so the mint silently
    // degraded to deviceless. Self-heal once through the session before the
    // mint; a failed registration keeps the deviceless path (never a new
    // error). A presented-but-rejected device (401: stale/revoked) is
    // re-registered ONCE and the mint repeated with the new token.
    const generationAtMint = sessionGeneration;
    const deviceToken = getToken() ?? (await ensureDeviceToken());
    const mint = (token: string | null) =>
      apiFetch<AgentConnectionTokenResponse>("/auth/agent-token", {
        method: "POST",
        headers: {
          "X-Workspace-Id": workspaceId,
        },
        ...(token ? { token } : {}),
        // FINDING 2 (review): a 401 here means "device inválido OU sessão
        // expirada", and the caller can still re-register and retry the mint.
        // Firing the global UNAUTHORIZED_EVENT would expire the session out
        // from under that retry, so it is suppressed FOR THE MINT ONLY.
        // A definitive 401 — after the retry is exhausted — is announced by
        // `throwWithExpirySignal`, which re-checks the session generation so a
        // dead session can never expire the live one.
        skipUnauthorizedEvent: true,
        signal,
      });

    let response: AgentConnectionTokenResponse;
    try {
      response = await mint(deviceToken);
    } catch (err) {
      // Only a 401 has expiry semantics; anything else propagates untouched.
      if (!isUnauthorized(err)) throw err;
      // Max 1 retry, and only when a device token was actually presented: a
      // 401 without one is a session problem, not a stale device.
      const refreshed = deviceToken ? await ensureDeviceToken() : null;
      // A failed re-registration cannot mint a device-bound token, so the
      // original 401 propagates (fail closed, never a deviceless downgrade).
      if (!refreshed) throwWithExpirySignal(err, generationAtMint);
      try {
        response = await mint(refreshed);
      } catch (retryErr) {
        // Only a 401 means the session is gone. Any other retry failure (500,
        // 408, transport error, abort) says nothing about the session — the
        // re-register that just succeeded proved it is alive — so announcing
        // an expiry here would purge credentials and log the user out over a
        // transient outage. Those propagate intact, unannounced.
        if (isUnauthorized(retryErr)) throwWithExpirySignal(retryErr, generationAtMint);
        throw retryErr;
      }
    }

    const ttlMs = Math.min((response.expiresIn ?? 120) * 1000, 90_000); // 90s cache TTL limit
    cachedToken = {
      workspaceId,
      token: response.token,
      expiresAt: now + ttlMs,
    };

    return response.token;
  } finally {
    release();
  }
};

export const clearAgentConnectionTokenCache = (): void => {
  cachedToken = null;
};

/**
 * H-13: THE central agent-session cleanup — cache + every in-flight
 * connection, in one call. `clearSensitiveSession` invokes this
 * unconditionally (any session cleanup may imply a context change, and the
 * bearer is cheap to re-mint: it is single-use per call anyway).
 */
export const clearAgentSession = (): void => {
  // Generation bump FIRST: any registration still in flight is already stale
  // and must not write to the store this call is about to invalidate. The
  // single-flight slot is dropped so the next mint of the new generation
  // registers its own device instead of joining the previous session's.
  sessionGeneration += 1;
  pendingDeviceSelfHeal = null;
  try {
    clearAgentConnectionTokenCache();
  } catch {
    /* noop */
  }
  try {
    abortAgentConnections();
  } catch {
    /* noop */
  }
};
