import { describe, expect, it } from "vitest";
import {
  classifyAuthSignal,
  classifySessionProbeSignal,
  decideRoute,
  isMembershipRevocation,
  type AuthState,
} from "./auth-state-machine";

/**
 * V4.1 Phase 5 (Tasks 5.1–5.3, SPEC §12.1): explicit auth state machine.
 *
 * States: authenticated / unauthenticated / unreachable (+ offline snapshot
 * mode via decideRoute). A missing response must NEVER be classified as a
 * missing session.
 */
describe("auth state machine (SPEC §12.1)", () => {
  it("maps 401 to unauthenticated (→ login)", () => {
    const state: AuthState = classifyAuthSignal({ kind: "http", status: 401 });
    expect(state).toBe("unauthenticated");
    expect(decideRoute(state, true)).toBe("login");
    expect(decideRoute(state, false)).toBe("login");
  });

  it("maps 403 auth.workspace_forbidden to unauthenticated (→ login, never offline mode)", () => {
    // FIX-168: só a revogação de membership tira a sessão do ar — é o
    // removeMember/leave com o code explícito do contrato servidor.
    const state: AuthState = classifyAuthSignal({
      kind: "http",
      status: 403,
      code: "auth.workspace_forbidden",
    });
    expect(state).toBe("unauthenticated");
    // A clearly invalid session must not unlock offline data.
    expect(decideRoute(state, true)).toBe("login");
  });

  it("maps non-revocation 403 (permission denial, missing header) to unreachable", () => {
    // FIX-168: workspace.forbidden (owner-only), auth.workspace_required
    // (sem header) e 403 sem code NÃO matam a sessão — a sessão pode seguir
    // válida; logout aqui era o multiplicador dos 403 em massa.
    for (const code of [
      "workspace.forbidden",
      "auth.workspace_required",
      "auth.admin_forbidden",
      undefined,
    ]) {
      const state: AuthState = classifyAuthSignal({
        kind: "http",
        status: 403,
        code,
      });
      expect(state).toBe("unreachable");
    }
  });

  it("maps timeout to unreachable (→ offline snapshot when available)", () => {
    const state: AuthState = classifyAuthSignal({ kind: "network-error" });
    expect(state).toBe("unreachable");
    expect(decideRoute(state, true)).toBe("offline-snapshot");
    expect(decideRoute(state, false)).toBe("login");
  });

  it("maps DNS failure to unreachable", () => {
    expect(classifyAuthSignal({ kind: "network-error" })).toBe("unreachable");
  });

  it("maps 5xx to unreachable (server fault, not session fault)", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyAuthSignal({ kind: "http", status })).toBe("unreachable");
    }
  });

  it("maps offline browser to unreachable", () => {
    expect(classifyAuthSignal({ kind: "offline" })).toBe("unreachable");
  });

  it("maps success to authenticated (→ online app)", () => {
    const state: AuthState = classifyAuthSignal({ kind: "success" });
    expect(state).toBe("authenticated");
    expect(decideRoute(state, true)).toBe("app");
    expect(decideRoute(state, false)).toBe("app");
  });

  it("never treats no-response as no-session", () => {
    // Every no-response signal lands on unreachable, never unauthenticated.
    const noResponse = [
      classifyAuthSignal({ kind: "network-error" }),
      classifyAuthSignal({ kind: "offline" }),
      classifyAuthSignal({ kind: "http", status: 500 }),
      classifyAuthSignal({ kind: "http", status: 503 }),
    ];
    for (const state of noResponse) {
      expect(state).not.toBe("unauthenticated");
    }
  });
});

describe("classifySessionProbeSignal (sonda canônica /auth/session — estrita, SPEC V4.1 INV-05)", () => {
  it("maps ANY 403 to unauthenticated — including codeless or non-revocation codes (fail-closed, nunca offline)", () => {
    // A sonda responde sobre a SESSÃO: /auth/session retorna 401 para
    // sessão ausente, então qualquer 403 explícito — mesmo sem code legível
    // ou corpo ilegível — é "sem sessão". O estreitamento FIX-168
    // (classifyAuthSignal) vale SÓ para o escopo financeiro.
    for (const code of [
      "auth.workspace_forbidden",
      "workspace.forbidden",
      "auth.workspace_required",
      "auth.admin_forbidden",
      undefined,
    ]) {
      expect(classifySessionProbeSignal({ kind: "http", status: 403, code })).toBe("unauthenticated");
    }
    expect(classifySessionProbeSignal({ kind: "http", status: 401 })).toBe("unauthenticated");
  });

  it("keeps transport/server faults unreachable (never a false logout)", () => {
    expect(classifySessionProbeSignal({ kind: "network-error" })).toBe("unreachable");
    expect(classifySessionProbeSignal({ kind: "offline" })).toBe("unreachable");
    expect(classifySessionProbeSignal({ kind: "http", status: 500 })).toBe("unreachable");
    expect(classifySessionProbeSignal({ kind: "http", status: 503 })).toBe("unreachable");
    expect(classifySessionProbeSignal({ kind: "success" })).toBe("authenticated");
  });
});

describe("isMembershipRevocation (D10 revocation purge trigger)", () => {
  it("treats only the source-backed membership denial as revocation", () => {
    // Canonical membership denial: API emits auth.workspace_forbidden when
    // workspaceAccess.resolve finds no active membership (device-access,
    // routes/auth session.forbidden, routes/index preHandler, agent-auth
    // revalidation). This is the removeMember/leave revocation signal.
    expect(isMembershipRevocation(403, "auth.workspace_forbidden")).toBe(true);
  });

  it("treats owner-only workspace.forbidden as permission denial, not revocation", () => {
    // workspace.forbidden is emitted by owner-only management routes
    // (requireOwnerAccess, remove-member owner check): the caller is still
    // a member, just not an owner. Must not purge the offline snapshot.
    expect(isMembershipRevocation(403, "workspace.forbidden")).toBe(false);
  });

  it("does NOT treat admin/invite permission denials as revocation", () => {
    expect(isMembershipRevocation(403, "auth.admin_forbidden")).toBe(false);
    expect(isMembershipRevocation(403, "auth.invite_forbidden")).toBe(false);
    expect(isMembershipRevocation(403, "auth.forbidden")).toBe(false);
  });

  it("does NOT treat unrelated agent errors as revocation", () => {
    expect(isMembershipRevocation(403, "agent.workspace_forbidden")).toBe(false);
    expect(isMembershipRevocation(403, "agent.invalid_parameters")).toBe(false);
  });

  it("does NOT treat non-source-backed literals as revocation", () => {
    // No API emitter found for these: the underscore/dotted membership
    // variants are not part of the server contract.
    expect(isMembershipRevocation(403, "workspace_forbidden")).toBe(false);
    expect(isMembershipRevocation(403, "membership.revoked")).toBe(false);
    expect(isMembershipRevocation(403, "auth.membership_revoked")).toBe(false);
  });

  it("does NOT treat a bare 403 without route context as revocation", () => {
    // No-route-context classifier: a codeless 403 can come from any
    // permission denial, so it must not trigger the global purge. The
    // /auth/session probe classifies direct 401/403 through its own
    // contract (fetchSession), unaffected by this function.
    expect(isMembershipRevocation(403, undefined)).toBe(false);
    expect(isMembershipRevocation(403, "")).toBe(false);
  });

  it("ignores non-403 statuses", () => {
    expect(isMembershipRevocation(401, "auth.workspace_forbidden")).toBe(false);
    expect(isMembershipRevocation(500, "auth.workspace_forbidden")).toBe(false);
    expect(isMembershipRevocation(200, "auth.workspace_forbidden")).toBe(false);
  });

  it("does NOT treat auth.invalid_origin (e.g. POST /auth/sign-out origin check) as revocation", () => {
    expect(isMembershipRevocation(403, "auth.invalid_origin")).toBe(false);
  });

  it("does NOT treat unrelated auth.* codes as revocation", () => {
    expect(isMembershipRevocation(403, "auth.session_expired")).toBe(false);
    expect(isMembershipRevocation(403, "auth.unauthorized")).toBe(false);
    expect(isMembershipRevocation(403, "auth.error")).toBe(false);
    expect(isMembershipRevocation(403, "auth.workspace_required")).toBe(false);
  });
});
