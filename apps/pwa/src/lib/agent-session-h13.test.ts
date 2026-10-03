import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { clearSensitiveSession } from "@/lib/session";
import { resetLocalSession } from "@/lib/reset-session";
import * as client from "@/lib/api/client";
import * as agentAuth from "@/lib/api/agent-auth";
import { sendAgentMessage } from "@/lib/api/agent-client";
import { setToken, clearToken } from "@/lib/auth/token-store";

/**
 * FIX-AGENT-MINT-SELF-HEAL: a mint with no stored device token first registers
 * the device (its own apiFetch call), so a total-call count would blur the
 * mint/cache contract asserted here. Count the mint path only.
 */
const mintCalls = (spy: { mock: { calls: unknown[][] } }): number =>
  spy.mock.calls.filter(([path]) => path === "/auth/agent-token").length;

/**
 * Every test seeds a device token so the mint takes the device-bound path
 * without a preceding registration round-trip.
 */
describe("H-13: limpeza central do agent no logout/401/troca (+ abort)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "https://agent.example.test");
    agentAuth.clearAgentConnectionTokenCache();
    setToken("device-token-h13");
  });

  afterEach(() => {
    clearToken();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("logout -> login de outro usuário nunca reutiliza o bearer antigo", async () => {
    // Logout clears the device token, so the next mint self-heals by
    // registering the device first (FIX-AGENT-MINT-SELF-HEAL): the mock is
    // path-aware so only the mint hands out a connection bearer.
    let mints = 0;
    const apiSpy = vi
      .spyOn(client, "apiFetch")
      .mockImplementation((path: string) =>
        Promise.resolve(
          path === "/auth/agent-token"
            ? { token: `agent-token-user-${(mints += 1)}`, expiresIn: 120 }
            : { token: "device-token-h13", deviceId: "dev-1", householdId: "hh-1" },
        ) as never,
      );
    const ws = "ws-h13-logout";

    await agentAuth.fetchAgentConnectionToken(ws);
    await resetLocalSession();
    const second = await agentAuth.fetchAgentConnectionToken(ws);

    expect(mintCalls(apiSpy)).toBe(2);
    expect(second).toBe("agent-token-user-2");
  });

  it("troca rápida de workspace invalida o cache mesmo sem clearToken", async () => {
    const apiSpy = vi
      .spyOn(client, "apiFetch")
      .mockResolvedValueOnce({ token: "agent-token-ws-a", expiresIn: 120 })
      .mockResolvedValueOnce({ token: "agent-token-ws-b", expiresIn: 120 });

    await agentAuth.fetchAgentConnectionToken("ws-a");
    // selectWorkspace path: snapshot/profile clear, sem clearToken.
    await clearSensitiveSession({ clearV1Snapshot: true, clearProfile: true });
    const second = await agentAuth.fetchAgentConnectionToken("ws-a");

    expect(mintCalls(apiSpy)).toBe(2);
    expect(second).toBe("agent-token-ws-b");
  });

  it("401 no turno: voo em curso é abortado e o cache morre", async () => {
    const apiSpy = vi.spyOn(client, "apiFetch").mockResolvedValue({ token: "agent-token-flight", expiresIn: 120 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // Mock fiel: respeita o AbortSignal como o fetch real.
          const signal = (init as RequestInit | undefined)?.signal;
          if (signal instanceof AbortSignal) {
            if (signal.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          }
        }),
    );

    const flight = sendAgentMessage("ws-h13-401", "qual meu saldo?");
    // Deixa o turno alcançar o voo (token mintado + fetch pendente).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).toHaveBeenCalled();

    await resetLocalSession();
    await expect(flight).rejects.toSatisfy(
      (err) => err instanceof Error || (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError"),
    );

    // Cache morto pelo próprio reset (sem clear manual): próximo mint busca de novo.
    await agentAuth.fetchAgentConnectionToken("ws-h13-401");
    expect(mintCalls(apiSpy)).toBe(2);
  });

  it("tracked canonical agent flight in progress is aborted on session clear", async () => {
    // T4.2: the legacy SSE reconnect helper (streamAgentTurn) was REMOVED —
    // the H-13 abort contract is now proven on the canonical /rpc/chat flight,
    // which shares the same trackAgentConnection tracking.
    vi.spyOn(client, "apiFetch").mockResolvedValue({ token: "agent-token-h13", expiresIn: 120 });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (signal instanceof AbortSignal) {
            if (signal.aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
              once: true,
            });
          }
        }),
    );
    const flight = sendAgentMessage("ws-h13-stream", "qual meu saldo?");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await clearSensitiveSession({ clearToken: true });
    await expect(flight).rejects.toSatisfy(
      (err) => err instanceof Error || (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError"),
    );
  });

  it("chamada vazia também limpa o agent (contrato central único)", async () => {
    const apiSpy = vi.spyOn(client, "apiFetch").mockResolvedValue({ token: "agent-token-x", expiresIn: 120 });
    await agentAuth.fetchAgentConnectionToken("ws-h13-empty");
    expect(mintCalls(apiSpy)).toBe(1);
    await clearSensitiveSession({});
    await agentAuth.fetchAgentConnectionToken("ws-h13-empty");
    expect(mintCalls(apiSpy)).toBe(2);
  });
});
