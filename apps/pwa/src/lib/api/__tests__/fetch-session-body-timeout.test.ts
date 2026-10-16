import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, DEFAULT_API_TIMEOUT_MS } from "../client";
import { fetchSession } from "../auth";

/**
 * FIX-SESSION-STATUS-BODY-TIMEOUT (RED):
 * Headers 401/403 recebidos mas o corpo (`res.json()`) nunca termina.
 * O timeout global rejeita com ApiError(408) e o fetchSession classifica
 * como `unreachable` — podendo liberar o offline V3 apesar da rejeição
 * explícita do servidor. O status 401/403 deve ser preservado assim que
 * os headers chegam.
 */

function stalledResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn(() => new Promise<never>(() => {})),
  } as unknown as Response;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", "http://localhost:3333");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("FIX-SESSION-STATUS-BODY-TIMEOUT", () => {
  it("apiFetch: 401 com corpo travado preserva 401 (nunca 408)", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stalledResponse(401));
    const pending = apiFetch("/auth/session", { timeoutMs: 50 });
    const guard = Symbol("guard");
    const observed = Promise.race([
      pending.then(
        () => "resolved",
        (error) => error,
      ),
      new Promise<typeof guard>((resolve) => {
        setTimeout(() => resolve(guard), 200);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(200);
    const result = await observed;
    expect(result).not.toBe(guard);
    expect(result).toMatchObject({ status: 401 });
  });

  it("apiFetch: 403 com corpo travado preserva 403 (nunca 408)", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stalledResponse(403));
    const pending = apiFetch("/auth/session", { timeoutMs: 50 });
    const guard = Symbol("guard");
    const observed = Promise.race([
      pending.then(
        () => "resolved",
        (error) => error,
      ),
      new Promise<typeof guard>((resolve) => {
        setTimeout(() => resolve(guard), 200);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(200);
    const result = await observed;
    expect(result).not.toBe(guard);
    expect(result).toMatchObject({ status: 403 });
  });

  it("fetchSession: 401 com corpo travado → unauthenticated (nunca unreachable)", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stalledResponse(401));
    const pending = fetchSession();
    const guard = Symbol("guard");
    const observed = Promise.race([
      pending,
      new Promise<typeof guard>((resolve) => {
        setTimeout(() => resolve(guard), DEFAULT_API_TIMEOUT_MS + 1000);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 1000);
    const result = await observed;
    expect(result).not.toBe(guard);
    expect(result).toMatchObject({ user: null, status: "unauthenticated" });
  });

  it("fetchSession: 403 com corpo travado → unauthenticated (sonda estrita: status 403 preservado é rejeição explícita, nunca unreachable)", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stalledResponse(403));
    const pending = fetchSession();
    const guard = Symbol("guard");
    const observed = Promise.race([
      pending,
      new Promise<typeof guard>((resolve) => {
        setTimeout(() => resolve(guard), DEFAULT_API_TIMEOUT_MS + 1000);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 1000);
    const result = await observed;
    expect(result).not.toBe(guard);
    // Sonda estrita (SPEC V4.1 INV-05): o timeout preserva o status 403
    // (nunca 408), e qualquer 403 no probe é "sem sessão" — purge + login,
    // nunca avaliação de snapshot offline pelo AuthGate.
    expect(result).toMatchObject({ user: null, status: "unauthenticated" });
  });

  it("guarda: 200 com corpo travado permanece 408/unreachable (sem over-fix)", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stalledResponse(200));
    const pending = apiFetch("/hanging-body", { timeoutMs: 50 });
    const guard = Symbol("guard");
    const observed = Promise.race([
      pending.then(
        () => "resolved",
        (error) => error,
      ),
      new Promise<typeof guard>((resolve) => {
        setTimeout(() => resolve(guard), 200);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(200);
    const result = await observed;
    expect(result).not.toBe(guard);
    expect(result).toMatchObject({ status: 408, code: "network.timeout" });
  });
});
