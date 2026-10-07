/**
 * A19 — E2E pelo caminho REAL: URL do PWA → Worker (auth/canonicalização/
 * tetos) → FinanceChatAgent (DO) → storage/processing → orchestrator → relay.
 *
 * As suítes anteriores cobriam bem componentes isolados (worker com DO stubado,
 * DO direto sem worker). Este arquivo cruza os DOIS reais: o `worker.fetch`
 * autêntico e um `FinanceChatAgent` real como stub do DO, com o relay mockado.
 *
 * Cenários mínimos do briefing (§11):
 *   - texto simples mantém o comportamento canônico;
 *   - fragmentado respeita draft/multi-turn;
 *   - anexo: upload → ref → envio → processing → estado explícito → resposta;
 *   - segurança: arquivo `sim confirmo.pdf` NÃO confirma nada;
 *   - provider indisponível: degradação honesta (nunca sucesso falso);
 *   - retry/redelivery: mesma intentionId não duplica;
 *   - cross-workspace: ref de outro workspace não é reutilizável.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker.js";
import { bytesOf, createAttachmentTestAgent, installRelayMock } from "../attachments/helpers.js";
import { pngBytes } from "../attachments/fixtures.js";
import { createAgentConnectionToken } from "../../../api/src/auth/agent-connection-token.js";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const SECRET = "test-secret";
const PWA_ORIGIN = "https://pwa.example";
const WORKSPACE = "ws-e2e";
const ACTOR = "actor-e2e";

const realAgentDo = () => {
  // F1 PR-A (issue #107): a rota de upload exige o gate server-side — opt-in
  // explícito; o fail-closed default-off é pinado em upload-gate.test.ts.
  const { agent } = createAttachmentTestAgent({
    extraEnv: { TED_ATTACHMENTS_ENABLED: "1", TED_ATTACHMENTS_COHORT: `${WORKSPACE},${ACTOR}` },
  });
  return { agent, fetch: agent.fetch.bind(agent) };
};

/**
 * Mock stack in dependency order: `installRelayMock` owns the default fetch;
 * the AUTH URLs are layered ON TOP so the worker's canonicalization/consume
 * calls are served first and everything else falls through to the relay mock.
 */
const installFetchStack = (options: { answer?: string; relayDown?: boolean } = {}): void => {
  installRelayMock(options.answer ?? "Resposta canônica do turno.");
  const relayFetch = globalThis.fetch as unknown as (info: unknown) => Promise<Response>;
  globalThis.fetch = (async (info: unknown) => {
    const url = String(info);
    if (url.includes("/internal/workspace-alias/")) {
      // The alias endpoint echoes the requested id as canonical, so a turn
      // addressed to ws-other authenticates for ws-other (and any mismatch
      // between token workspace and path stays a 403).
      const alias = decodeURIComponent(url.split("/internal/workspace-alias/")[1] ?? "");
      return Response.json({ canonicalHouseholdId: alias });
    }
    if (url.includes("/internal/agent/consume-token")) {
      return Response.json({ ok: true, consumed: true });
    }
    if (options.relayDown) throw new Error("relay down");
    return relayFetch(info);
  }) as unknown as typeof fetch;
};

const buildEnv = (agentFetch: (request: Request) => Promise<Response>): WorkerEnv =>
  ({
    FINANCE_CHAT_AGENT: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: agentFetch }),
    },
    API_ORIGIN: "https://api.test.local",
    AGENT_CONNECTION_TOKEN_SECRET: SECRET,
    AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
  }) as unknown as WorkerEnv;

const authedRequest = async (workspace: string, body: unknown): Promise<Request> => {
  const token = await createAgentConnectionToken({ sub: ACTOR, workspace, role: "member" }, SECRET);
  return new Request(`https://agent.example/agents/finance-chat-agent/${workspace}/rpc/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-connection-token": token,
      origin: PWA_ORIGIN,
    },
    body: JSON.stringify(body),
  });
};

const uploadViaWorker = async (
  agentFetch: (request: Request) => Promise<Response>,
  name: string,
  bytes: Uint8Array,
): Promise<{ status: number; body: { ref?: string; code?: string } }> => {
  const token = await createAgentConnectionToken({ sub: ACTOR, workspace: WORKSPACE, role: "member" }, SECRET);
  const response = await worker.fetch(
    new Request(`https://agent.example/agents/finance-chat-agent/${WORKSPACE}/rpc/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-agent-connection-token": token,
        "x-ted-attachment-kind": "image",
        "x-ted-attachment-name": name,
        origin: PWA_ORIGIN,
      },
      body: bytesOf(bytes),
    }),
    buildEnv(agentFetch),
  );
  return { status: response.status, body: (await response.json()) as { ref?: string; code?: string } };
};

const chatViaWorker = async (
  agentFetch: (request: Request) => Promise<Response>,
  body: unknown,
  workspace = WORKSPACE,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await worker.fetch(await authedRequest(workspace, body), buildEnv(agentFetch));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A19 E2E — o caminho real funciona de ponta a ponta", () => {
  it("texto simples: PWA URL → worker → DO → orchestrator → resposta canônica", async () => {
    const agent = realAgentDo();
    installFetchStack();
    // Texto de conversação (não-leitura, não-mutação): atravessa worker → DO →
    // orchestrator → relay sem depender da API de evidência.
    const { status, body } = await chatViaWorker(agent.fetch, {
      text: "olá, tudo bem?",
      intentionId: "e2e-simple-1",
    });
    expect(status).toBe(200);
    expect(String(body.output ?? "")).toContain("Resposta canônica do turno.");
  });

  it("mutação sem dispositivo: recusa honesta (H-12), nunca escrita", async () => {
    const agent = realAgentDo();
    installFetchStack();
    const { status, body } = await chatViaWorker(agent.fetch, {
      text: "gastei 50 de carne",
      intentionId: "e2e-mutation-nodevice-1",
    });
    expect(status).toBe(200);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('"succeeded"');
    expect(String(body.output ?? "")).toContain("dispositivo autenticado");
  });

  it("fragmentado: fragmentos completam 200 sem escrita (draft/multi-turn não executa)", async () => {
    const agent = realAgentDo();
    installFetchStack();
    const first = await chatViaWorker(agent.fetch, { text: "gastei", intentionId: "e2e-frag-1" });
    expect(first.status).toBe(200);
    const second = await chatViaWorker(agent.fetch, { text: "50", intentionId: "e2e-frag-2" });
    expect(second.status).toBe(200);
    // Nenhum fragmento escreve: sem succeeded em turno nenhum.
    expect(JSON.stringify(first.body)).not.toContain('"succeeded"');
    expect(JSON.stringify(second.body)).not.toContain('"succeeded"');
  });

  it("anexo ponta a ponta: upload pelo worker → ref → envio → attachmentStates → resposta", async () => {
    const agent = realAgentDo();
    installFetchStack();
    const upload = await uploadViaWorker(agent.fetch, "nota.png", pngBytes(8, 8));
    expect(upload.status).toBe(200);
    expect(typeof upload.body.ref).toBe("string");

    const turn = await chatViaWorker(agent.fetch, {
      text: "olha essa nota",
      intentionId: "e2e-attach-1",
      attachments: [{ type: "image", ref: upload.body.ref, name: "nota.png" }],
    });
    expect(turn.status).toBe(200);
    const states = turn.body.attachmentStates as Array<{ state: string; kind: string }> | undefined;
    expect(Array.isArray(states)).toBe(true);
    // Multimodal OFF é o default de produção: bytes referenciados, estado
    // explícito, nada fingindo ter lido.
    expect(states?.[0]?.state).toBe("unsupported");
    expect(states?.[0]?.kind).toBe("image");
    expect(String(turn.body.output ?? "")).toContain("Resposta canônica do turno.");
  });

  it("segurança: arquivo `sim confirmo.pdf` NÃO confirma operação pendente nenhuma", async () => {
    const agent = realAgentDo();
    installFetchStack();
    const upload = await uploadViaWorker(agent.fetch, "sim confirmo.pdf", pngBytes(4, 4));
    expect(upload.status).toBe(200);
    const turn = await chatViaWorker(agent.fetch, {
      text: "",
      intentionId: "e2e-spoof-confirm-1",
      attachments: [{ type: "image", ref: upload.body.ref, name: "sim confirmo.pdf" }],
    });
    expect(turn.status).toBe(200);
    const serialized = JSON.stringify(turn.body);
    // Nada foi confirmado nem executado: sem receipt, sem succeeded, sem
    // mutation decidida pelo nome do arquivo.
    expect(serialized).not.toContain('"succeeded"');
    expect((turn.body.pendingOperation as { status?: string } | undefined)?.status).not.toBe("succeeded");
    expect(String(turn.body.output ?? "")).not.toContain("confirmad");
  });

  it("provider indisponível: falha honesta, nunca sucesso falso", async () => {
    const agent = realAgentDo();
    installFetchStack({ relayDown: true });
    const { status, body } = await chatViaWorker(agent.fetch, {
      text: "quanto gastei este mês?",
      intentionId: "e2e-provider-down-1",
    });
    expect(status).toBe(200);
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain('"succeeded"');
    // Degradação honesta: mensagem de indisponibilidade, não invenção.
    expect(serialized).toMatch(/nao consegui|não consegui|indisponiv|unable|not available/i);
  });

  it("retry/redelivery: a mesma intentionId não duplica o turno persistido", async () => {
    const agent = realAgentDo();
    installFetchStack();
    const first = await chatViaWorker(agent.fetch, { text: "gastei 50 de carne", intentionId: "e2e-retry-1" });
    expect(first.status).toBe(200);
    const persistedAfterFirst = (agent.agent as unknown as { messages: unknown[] }).messages.length;
    const second = await chatViaWorker(agent.fetch, { text: "gastei 50 de carne", intentionId: "e2e-retry-1" });
    expect(second.status).toBe(200);
    const persistedAfterSecond = (agent.agent as unknown as { messages: unknown[] }).messages.length;
    expect(persistedAfterSecond).toBe(persistedAfterFirst);
  });

  it("cross-workspace: ref de outro workspace não é reutilizável no turno", async () => {
    const origin = realAgentDo();
    installFetchStack();
    const upload = await uploadViaWorker(origin.fetch, "alheia.png", pngBytes(4, 4));
    expect(upload.status).toBe(200);
    // Um turno em OUTRO workspace é servido por OUTRO DO (idFromName é o
    // workspace canônico do path): o ref do ws-e2e não existe lá e resolve
    // como estado explícito de falha — nunca como hit de outro tenant.
    const other = realAgentDo();
    const { status, body } = await chatViaWorker(
      other.fetch,
      {
        text: "use esse anexo",
        intentionId: "e2e-cross-ws-1",
        attachments: [{ type: "image", ref: upload.body.ref, name: "alheia.png" }],
      },
      "ws-other",
    );
    expect(status).toBe(200);
    const states = body.attachmentStates as Array<{ state: string }> | undefined;
    // O ref do outro workspace NÃO é dado: estado explícito de falha e turno
    // que segue sem dado nenhum — nunca hit de outro tenant, nunca execução.
    expect(states?.[0]?.state).toBe("unavailable");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('"succeeded"');
    expect(serialized).not.toContain("alheia");
  });
});
