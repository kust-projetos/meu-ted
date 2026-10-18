import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../client";
import {
  getSessionToken,
  getToken,
  cleanupOrphanedLegacyTokens,
} from "@/lib/auth/token-store";

/**
 * T2.3 — Cookie-first: remoção gradual do localStorage (SPEC §8 B3 passos
 * 4–7, ADR-015). A flag NEXT_PUBLIC_LEGACY_BEARER_COMPAT controla
 * leitura+escrita do bearer legado de SESSÃO (DECISÃO T2.3: manter simples,
 * sem sub-flag).
 *
 * T04: a chave de DEVICE (`pi-finance:token`, vínculo H-12) NÃO é bearer
 * legado — persiste e é legível com a flag off, e o cleanup de bootstrap a
 * preserva. Só o session-token continua gateado.
 */

function mockOkFetch(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("T2.3 B3.5: compat off => leitura removida (token órfão ignorado)", () => {
  it("request sem Authorization mesmo com token órfão em localStorage", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    vi.stubEnv("NEXT_PUBLIC_LEGACY_BEARER_COMPAT", "false");
    // Token órfão gravado por versão anterior (bypass da store, como resíduo real).
    localStorage.setItem("pi-finance:session-token", "sess-orphan");
    localStorage.setItem("pi-finance:token", "dev-orphan");
    const fetchMock = mockOkFetch();

    await apiFetch("/workspaces");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["x-device-token"]).toBeUndefined();
  });

  it("flag off => session-bearer reads removidas; device reads preservadas (T04)", () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_BEARER_COMPAT", "false");
    localStorage.setItem("pi-finance:session-token", "sess-orphan");
    localStorage.setItem("pi-finance:token", "dev-orphan");

    // O bearer legado de sessão é ignorado…
    expect(getSessionToken()).toBeNull();
    // …mas a chave de device NÃO é bearer legado: continua legível para o
    // mint do Agent não repetir o register com a flag off.
    expect(getToken()).toBe("dev-orphan");
  });

  it("flag on (default) => coexistência preservada (lê órfão)", () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    localStorage.setItem("pi-finance:session-token", "sess-abc");
    const fetchMock = mockOkFetch();

    return apiFetch("/workspaces").then(() => {
      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sess-abc");
    });
  });
});

describe("T2.3 B3/B2: bootstrap cleanup de token órfão", () => {
  it("flag off => apaga só o bearer legado de sessão; device é preservado (T04)", () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_BEARER_COMPAT", "false");
    localStorage.setItem("pi-finance:session-token", "sess-orphan");
    localStorage.setItem("pi-finance:token", "dev-orphan");

    cleanupOrphanedLegacyTokens();

    expect(localStorage.getItem("pi-finance:session-token")).toBeNull();
    expect(localStorage.getItem("pi-finance:token")).toBe("dev-orphan");
  });

  it("flag on => preserva as chaves (coexistência)", () => {
    localStorage.setItem("pi-finance:session-token", "sess-abc");
    localStorage.setItem("pi-finance:token", "dev-abc");

    cleanupOrphanedLegacyTokens();

    expect(localStorage.getItem("pi-finance:session-token")).toBe("sess-abc");
    expect(localStorage.getItem("pi-finance:token")).toBe("dev-abc");
  });
});
