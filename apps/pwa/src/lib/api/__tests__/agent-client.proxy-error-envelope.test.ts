import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sendAgentMessage, fetchAgentHistory } from "../agent-client";
import * as agentAuth from "../agent-auth";

/**
 * P1 proxy error envelope (TASK_ID=CODER-TOOLS-PWA-P2):
 * o proxy same-origin responde erros próprios como
 * `{ ok:false, error:{ code, message } }` (route.ts upstreamErrorResponse),
 * enquanto o Agent emite `{ code, message }` top-level e o proxy repassa o
 * corpo do upstream intacto. O cliente lia SÓ o shape top-level — um 502 do
 * proxy virava erro genérico sem code. Estes testes FALHAM antes do fix.
 */
describe("agent-client proxy error envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL", "");
    vi.spyOn(agentAuth, "fetchAgentConnectionToken").mockResolvedValue("conn-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const proxyEnvelope = (code: string, message: string) =>
    new Response(JSON.stringify({ ok: false, error: { code, message } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });

  it("sendAgentMessage extrai code+message do envelope do proxy no 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      proxyEnvelope("upstream_unavailable", "O assistente está indisponível no momento. Tente novamente mais tarde."),
    );
    const err = await sendAgentMessage("ws-1", "oi").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe("upstream_unavailable");
    expect((err as Error).message).toContain("indisponível");
    expect((err as Error & { status?: number }).status).toBe(502);
  });

  it("sendAgentMessage preserva o shape top-level do Agent no 502", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "agent.inference_error", message: "Falha ao processar a solicitação." }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    const err = await sendAgentMessage("ws-1", "oi").catch((e) => e);
    expect((err as Error & { code?: string }).code).toBe("agent.inference_error");
    expect((err as Error).message).toContain("Falha ao processar");
  });

  it("fetchAgentHistory extrai o code do envelope do proxy (parseJson)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(proxyEnvelope("upstream_timeout", "O assistente não respondeu."));
    const err = await fetchAgentHistory("ws-1").catch((e) => e);
    expect((err as Error & { code?: string }).code).toBe("upstream_timeout");
    expect((err as Error).message).toContain("não respondeu");
  });
});
