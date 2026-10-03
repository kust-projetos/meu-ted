import { apiFetch, apiGet, ApiError } from "./client";
import { getSessionToken } from "@/lib/auth/token-store";
import { classifyAuthSignal } from "@/lib/auth/auth-state-machine";

export type VerifyAccountInviteResult = {
  email: string;
  expiresAt: string;
};

export type PendingInviteSummary = {
  id: string;
  householdId: string;
  email: string;
  role: "owner" | "member";
  expiresAt: string;
  createdAt?: string;
};

export type PendingMeResult = {
  items: PendingInviteSummary[];
  total: number;
};

export type SignInEmailCredentials = {
  email: string;
  password: string;
};

export type SignInEmailResponse = {
  token?: string;
  user?: unknown;
  redirect?: boolean;
};

export type RegisterDeviceResponse = {
  token: string;
  deviceId: string;
  householdId: string;
};

export async function signInWithEmail(credentials: SignInEmailCredentials): Promise<SignInEmailResponse> {
  return apiFetch<SignInEmailResponse>("/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify(credentials),
    headers: { "Content-Type": "application/json" },
  });
}

/** Revoke the current server-side cookie session before clearing local state. */
export async function signOut(): Promise<void> {
  await apiFetch<{ success?: boolean }>("/auth/sign-out", { method: "POST" });
}

export async function signUpWithEmail(input: { email: string; password: string; name: string }): Promise<SignInEmailResponse> {
  return apiFetch<SignInEmailResponse>("/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
  });
}

export async function verifyAccountInvite(token: string): Promise<VerifyAccountInviteResult> {
  return apiFetch<VerifyAccountInviteResult>("/auth/account-invites/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function fetchPendingMe(): Promise<PendingMeResult> {
  const headers: Record<string, string> = {};
  const token = getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return apiFetch<PendingMeResult>("/auth/invites/pending-me", {
    method: "GET",
    headers,
  });
}

export type SessionUser = { id: string; email: string; name: string };

/** Session probe signal (V4.1 Closure AUTH-04, INV-05). */
export type SessionProbeStatus = "authenticated" | "unauthenticated" | "unreachable";

export interface SessionProbeResult {
  user: SessionUser | null;
  /**
   * authenticated: 2xx with a user. unauthenticated: the server answered
   * "no session" (2xx without user, 401/403 → purge + login). unreachable:
   * the server never answered about the session (network/timeout/5xx →
   * NEVER logout, NEVER offline-unlock of an invalid session by itself).
   */
  status: SessionProbeStatus;
}

/**
 * FIX-SESSION-USER-ID: canonical-principal guard for the /auth/session probe.
 * Better-auth always returns a non-empty string `id` for a valid session
 * (missing session → 401, see apps/api/src/auth/better-auth-http.ts), so a
 * 2xx `user` without one is malformed and must fail closed. Trims because a
 * whitespace-only id carries no principal identity.
 */
function isCanonicalSessionUser(user: unknown): user is SessionUser {
  if (typeof user !== "object" || user === null) return false;
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0;
}

/**
 * Session probe (cookie-first: `credentials: "include"` in apiFetch, compat
 * bearer only as fallback). Distinguishes 2xx / 401+403 / unreachable via
 * the auth state machine — network errors are NOT collapsed into logout.
 */
export async function fetchSession(): Promise<SessionProbeResult> {
  try {
    const headers: Record<string, string> = {};
    const token = getSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await apiFetch<{ user: SessionUser; session: unknown }>("/auth/session", {
      method: "GET",
      headers,
    });
    // FIX-SESSION-USER-ID: a 2xx only proves a session when it carries the
    // canonical principal — a non-empty string user id. Any truthy-but-shapeless
    // `user` ({}, missing/non-string/blank id) is an explicit "no session"
    // rejection (unauthenticated → purge + login), never an unlock.
    // FIX-SESSION-NULL-ENVELOPE: a 2xx answered-but-empty envelope is an
    // explicit "no session" — apiFetch resolves undefined for 204 and a JSON
    // null body parses to null, so `res` itself may be missing/malformed.
    // Dereferencing `res.user` here would throw into the catch below and be
    // mapped to unreachable (offline consideration). Fail closed instead:
    // unauthenticated → purge + login.
    if (res === null || res === undefined || typeof res !== "object")
      return { user: null, status: "unauthenticated" };
    if (!isCanonicalSessionUser(res.user)) return { user: null, status: "unauthenticated" };
    return { user: res.user, status: "authenticated" };
  } catch (e) {
    if (e instanceof ApiError) {
      const state = classifyAuthSignal({ kind: "http", status: e.status, code: e.code });
      return { user: null, status: state === "unauthenticated" ? "unauthenticated" : "unreachable" };
    }
    // FIX-SESSION-RESPONSE-CLASSIFICATION (B): a 2xx answered-but-unparseable
    // body means the server responded with no usable session — explicit
    // "no session" (unauthenticated → purge + login), never offline-unlock.
    // Only SyntaxError (Response.json parse failure) takes this path;
    // transport failures (TypeError/Error) and 5xx ApiError stay unreachable.
    if (e instanceof SyntaxError) return { user: null, status: "unauthenticated" };
    return { user: null, status: "unreachable" };
  }
}

/**
 * T2.5 (ADR-015 Opção C, session-first): scoped device flow — device
 * registration authenticates via the SESSION (cookie + compat bearer) and
 * intentionally carries NO x-device-token. A stale stored device token must
 * never leak into this call; apiFetch only attaches the device header on the
 * explicit `token` option, which this flow deliberately omits.
 *
 * `opts.skipUnauthorizedEvent` is for callers that own the recovery of a 401
 * (the agent mint self-heal): suppressing the global session-expiry signal
 * lets them treat a denied registration as LOCAL instead of tearing down the
 * session. The AuthGate login path omits it and keeps the default contract.
 */
export async function registerDeviceToken(
  sessionToken?: string,
  opts?: { skipUnauthorizedEvent?: boolean },
): Promise<RegisterDeviceResponse> {
  return apiFetch<RegisterDeviceResponse>("/auth/devices/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify({ deviceName: "PWA Web Device" }),
    ...(opts?.skipUnauthorizedEvent ? { skipUnauthorizedEvent: true } : {}),
  });
}

/**
 * T2.5 (ADR-015 Opção C, session-first): scoped device flow — the ONLY
 * normal-path caller that carries x-device-token, passed explicitly via the
 * `token` opt-in (boot gate verification). Rotation
 * (POST /auth/devices/rotate) follows the same pattern when wired: explicit
 * token, never the implicit store fallback (removed in T2.5).
 */
export async function verifyDeviceToken(token: string): Promise<unknown> {
  return apiGet<unknown>("/auth/devices/me", token);
}
