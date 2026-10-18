import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../client";
import {
  getSessionToken,
  getToken,
  setSessionToken,
  setToken,
} from "@/lib/auth/token-store";

/**
 * T2.2 — Cookie-first: transporte validado e preferência (SPEC §8 B1/B2/B3
 * passos 1–3, ADR-015 Opção C).
 *
 * 1. Login/operação SEM escrita em localStorage opera 100% via cookie.
 * 2. Com token legado presente + compat on: Authorization continua anexado.
 * 3. Compat off: nenhuma escrita em localStorage (AuthGate + convite passam
 *    pela token-store, única abstração — sem writes diretos remanescentes).
 * 4. offlineSubjectId coberto em offline-subject.test.ts.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_DIR, relativePath), "utf8");
}

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

describe("T2.2 cookie-first: operation without localStorage writes", () => {
  it("authenticates and operates via cookie when localStorage writes throw", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    // jsdom: espiona a instância real (Storage.prototype não intercepta aqui).
    const setItemSpy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    const fetchMock = mockOkFetch();

    // Writes never throw outward (store is fail-closed on storage errors).
    expect(() => setToken("dev-x")).not.toThrow();
    expect(() => setSessionToken("sess-x")).not.toThrow();
    expect(getToken()).toBeNull();
    expect(getSessionToken()).toBeNull();

    await apiFetch("/workspaces");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(init.credentials).toBe("include");
    expect(init.headers["Authorization"]).toBeUndefined();
    expect(init.headers["x-device-token"]).toBeUndefined();
    expect(setItemSpy).toHaveBeenCalled();
  });
});

describe("T2.2 coexistence (B3.1): legacy bearer still attached when present", () => {
  it("attaches Authorization with compat on (default) but NOT x-device-token on normal calls (T2.5 session-first)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "https://api.example.com");
    localStorage.setItem("pi-finance:session-token", "sess-abc");
    localStorage.setItem("pi-finance:token", "dev-abc");
    const fetchMock = mockOkFetch();

    await apiFetch("/workspaces");

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sess-abc");
    // T2.5 (ADR-015 Opção C): normal calls never carry the device header,
    // even with a device token stored — scoped device flows pass it explicitly.
    expect(headers["x-device-token"]).toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
  });
});

describe("T2.2 compat flag: writes gated behind NEXT_PUBLIC_LEGACY_BEARER_COMPAT", () => {
  it("writes legacy keys by default (compat window open)", () => {
    setToken("dev-1");
    setSessionToken("sess-1");
    expect(localStorage.getItem("pi-finance:token")).toBe("dev-1");
    expect(localStorage.getItem("pi-finance:session-token")).toBe("sess-1");
  });

  it("performs NO session-bearer writes with compat off (device token persists — T04)", () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_BEARER_COMPAT", "false");
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

    setSessionToken("sess-1");

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("pi-finance:session-token")).toBeNull();
    expect(getSessionToken()).toBeNull();

    // T04: a chave de device NÃO é bearer legado — persiste com a flag off
    // para o mint do Agent não repetir POST /auth/devices/register.
    setToken("dev-1");
    expect(localStorage.getItem("pi-finance:token")).toBe("dev-1");
    expect(getToken()).toBe("dev-1");
  });

  it("treats explicit falsy spellings as off (session bearer only — T04)", () => {
    for (const value of ["0", "no", "FALSE"]) {
      vi.stubEnv("NEXT_PUBLIC_LEGACY_BEARER_COMPAT", value);
      const setItemSpy = vi.spyOn(window.localStorage, "setItem");
      setSessionToken("sess-1");
      expect(setItemSpy).not.toHaveBeenCalled();
      setItemSpy.mockRestore();
    }
  });

  it("routes every AuthGate/convite credential write through the token-store (no direct writes)", () => {
    for (const file of [
      "features/auth/AuthGate.tsx",
      "app/convite/page.tsx",
    ]) {
      const source = readSource(file);
      expect(
        source,
        `${file} must not write credential keys directly (use token-store)`,
      ).not.toMatch(/localStorage\.setItem\("pi-finance:(session-token|token)"/);
    }
  });
});
