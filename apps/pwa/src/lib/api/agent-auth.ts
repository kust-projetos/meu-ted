import { apiFetch } from "./client";
import { getToken } from "../auth/token-store";

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
    const deviceToken = getToken();
    const response = await apiFetch<AgentConnectionTokenResponse>("/auth/agent-token", {
      method: "POST",
      headers: {
        "X-Workspace-Id": workspaceId,
      },
      ...(deviceToken ? { token: deviceToken } : {}),
      signal,
    });

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
