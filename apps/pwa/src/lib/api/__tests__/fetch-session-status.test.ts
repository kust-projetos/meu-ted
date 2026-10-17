import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchSession } from "../auth";

/**
 * V4.1 Closure (SPEC AUTH-04, INV-05, Plano Phase 1 — RED).
 *
 * A sonda de sessão precisa distinguir 2xx / 401+403 / unreachable
 * (`auth.ts:74-87` hoje colapsa tudo em `{ user: null }`). Estes testes
 * exigem o sinal `status` ao lado de `user` (compat: `user` continua
 * presente para os chamadores atuais).
 */

function mockFetchOnce(response: Response | Error): void {
  if (response instanceof Error) {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(response);
  } else {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
  }
}

const sessionUser = { id: "u1", email: "walis@example.com", name: "W" };

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3333");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fetchSession probe (AUTH-04: 2xx vs 401/403 vs unreachable)", () => {
  it("2xx com user → authenticated", async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ user: sessionUser }), { status: 200 }),
    );
    const res = await fetchSession();
    expect(res.user).toEqual(sessionUser);
    expect(res.status).toBe("authenticated");
  });

  it("2xx sem user → unauthenticated (servidor respondeu: sem sessão)", async () => {
    mockFetchOnce(new Response(JSON.stringify({ user: null }), { status: 200 }));
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unauthenticated");
  });

  it("401 → unauthenticated (nunca unreachable)", async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ code: "auth.invalid_token" }), { status: 401 }),
    );
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unauthenticated");
  });

  it("403 auth.workspace_forbidden → unauthenticated (revogação: purge+login, nunca offline)", async () => {
    // Sonda estrita (SPEC V4.1 INV-05 fail-closed): QUALQUER 403 no probe
    // é "sem sessão" — o classificador estreito do FIX-168
    // (classifyAuthSignal) vale SÓ para o escopo financeiro, nunca aqui.
    mockFetchOnce(
      new Response(JSON.stringify({ code: "auth.workspace_forbidden" }), { status: 403 }),
    );
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unauthenticated");
  });

  it("403 sem code de revogação → unauthenticated (sonda estrita: qualquer 403 no probe é 'sem sessão', nunca offline)", async () => {
    for (const code of ["workspace.forbidden", "auth.workspace_required", "auth.admin_forbidden"]) {
      mockFetchOnce(
        new Response(JSON.stringify({ code }), { status: 403 }),
      );
      const res = await fetchSession();
      expect(res.user).toBeNull();
      expect(res.status).toBe("unauthenticated");
    }
  });

  it("falha de rede → unreachable (nunca vira logout)", async () => {
    mockFetchOnce(new Error("network down"));
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unreachable");
  });

  it("5xx → unreachable (falha do servidor, não da sessão)", async () => {
    mockFetchOnce(new Response(JSON.stringify({}), { status: 503 }));
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unreachable");
  });

  it("200 com corpo JSON null → unauthenticated (envelope ausente respondido, nunca unreachable)", async () => {
    mockFetchOnce(new Response("null", { status: 200 }));
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unauthenticated");
  });

  it("204 sem conteúdo → unauthenticated (apiFetch resolve undefined, nunca unreachable)", async () => {
    mockFetchOnce(new Response(null, { status: 204 }));
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unauthenticated");
  });

  it("FIX-SESSION-RESPONSE-CLASSIFICATION (A): 401 com corpo JSON null → unauthenticated (nunca unreachable)", async () => {
    mockFetchOnce(new Response("null", { status: 401 }));
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unauthenticated");
  });

  it("FIX-SESSION-RESPONSE-CLASSIFICATION (A): 403 com corpo JSON null → unauthenticated (sonda estrita: qualquer 403 no probe é 'sem sessão', SPEC V4.1 INV-05)", async () => {
    mockFetchOnce(new Response("null", { status: 403 }));
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unauthenticated");
  });

  it("FIX-SESSION-RESPONSE-CLASSIFICATION (B): 2xx com JSON inválido → unauthenticated (servidor respondeu sem sessão utilizável, nunca offline)", async () => {
    mockFetchOnce(
      new Response("not-json{{{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await fetchSession();
    expect(res.user).toBeNull();
    expect(res.status).toBe("unauthenticated");
  });
});
