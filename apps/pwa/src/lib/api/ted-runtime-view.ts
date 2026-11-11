/**
 * P2 — per-workspace server-confirmed TED runtime view (client-side only).
 *
 * The proxy marks P2 responses (and only those — the frozen A0 path stays
 * header-identical) with the non-secret `x-ted-runtime: opencode|agent`
 * header. `agent-client` captures it into this view; `TedChat` gates the
 * turn-cancel UI on it. Never body/DTO/session id, never a secret, never
 * persisted — memory only, keyed by workspace. Unknown until the first
 * captured P2 response for the workspace.
 */
export type TedRuntimeView = "opencode" | "agent" | "unknown";

const views = new Map<string, TedRuntimeView>();

export function getTedRuntimeView(workspaceId: string): TedRuntimeView {
  return views.get(workspaceId) ?? "unknown";
}

/**
 * Records the runtime revealed by one proxied response header. Unknown /
 * foreign values never overwrite a confirmed view — absence of the header
 * (legacy A0 path) is not evidence. Returns the current view.
 */
export function noteTedRuntimeView(
  workspaceId: string,
  headerValue: string | null | undefined,
): TedRuntimeView {
  if (typeof headerValue === "string") {
    const value = headerValue.trim().toLowerCase();
    if (value === "opencode" || value === "agent") {
      views.set(workspaceId, value);
    }
  }
  return getTedRuntimeView(workspaceId);
}

/** Drops runtime beliefs (session teardown, renewal lifecycle, test isolation). */
export function clearTedRuntimeViews(workspaceId?: string): void {
  if (typeof workspaceId === "string") {
    views.delete(workspaceId);
  } else {
    views.clear();
  }
}
