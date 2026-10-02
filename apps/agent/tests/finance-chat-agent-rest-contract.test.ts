import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { UIMessage } from "agents/ai-chat-agent";
import { FinanceChatAgent } from "../src/finance-chat-agent.js";
import { attachRelayUsageStorage } from "./helpers/relay-usage-storage.js";
import worker from "../src/worker.js";
import * as apiClient from "../src/tools/api-client.js";
import { createAgentConnectionToken } from "../../api/src/auth/agent-connection-token.js";
import { decodeDelegatedTurnToken } from "../src/delegated-token.js";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const createTestAgent = () => {
  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: UIMessage[];
    persistMessages: (msgs: UIMessage[]) => Promise<void>;
  };
  agent.messages = persisted;

  agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
    persisted.push(...msgs);
  });

  Object.defineProperty(agent, "state", {
    value: {
      storage: {},
    },
    writable: true,
    configurable: true,
  });

  // Usage-attempt ledger: the relay leg reserves per dispatch (fail-closed
  // 503 without atomic storage), so the harness provides it like production.
  attachRelayUsageStorage(agent);

  Object.defineProperty(agent, "env", {
    value: {
      API_ORIGIN: "https://api.test.local",
      AGENT_RUNTIME_ADMIN_TOKEN: "admin-test-token",
      AGENT_CONFIG_TOKEN: "config-test-token",
    },
    writable: true,
    configurable: true,
  });

  (agent as unknown as { resolveIntentionSnapshot: () => Promise<unknown> }).resolveIntentionSnapshot = async () => ({
    intention_id: "intent-test-1",
    version: 1,
    provider_id: "opencode-zen",
    model_id: "opencode-zen:zen-free-model",
    protocol: "chat-completions",
    rollout_percentage: 100,
    security_epoch: 1,
    fallback_provider_id: null,
    fallback_model_id: null,
    model_name: "zen-free-model",
    fallback_model_name: null,
    created_at: new Date().toISOString(),
  });

  return { agent, persisted };
};

// H-14: valid authority snapshot for URL-routed fetch mocks (fail-closed
// when the authority is unreachable — tests must serve this explicitly).
// securityEpoch 1 matches createTestAgent's stubbed snapshot above.
const snapshotBody = () => ({
  runtime: {
    singleton: 'active',
    version: 3,
    securityEpoch: 1,
    activeProviderId: 'opencode-zen',
    activeModelId: 'opencode-zen:zen-1',
    activeProtocol: 'chat-completions',
    activeRolloutPercentage: 100,
    activeRolloutMode: 'all',
    fallbackProviderId: null,
    fallbackModelId: null,
    updatedBy: null,
  },
  activeProvider: null,
  activeModel: null,
  fallbackProvider: null,
  fallbackModel: null,
  activeDisabled: false,
  fallbackDisabled: false,
});

describe("FinanceChatAgent REST Contract & Shared Transcript Security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not retain an unreachable legacy relay after the canonical REST runTurn", async () => {
    const source = await readFile(new URL("../src/finance-chat-agent.ts", import.meta.url), "utf8");
    const chatStart = source.indexOf('if (url.pathname === "/rpc/chat" && request.method === "POST")');
    const memoryStart = source.indexOf('if (url.pathname === "/rpc/memory/prefs" && request.method === "POST")');
    expect(chatStart).toBeGreaterThanOrEqual(0);
    expect(memoryStart).toBeGreaterThan(chatStart);

    const restHandler = source.slice(chatStart, memoryStart);
    expect(restHandler).not.toContain("return this.enqueueChat(async () => {");
    expect(restHandler).not.toContain("/internal/agent/llm-relay");
    expect(restHandler).not.toContain("generatedHttpTools.find");
  });

  it("routes REST mutation proposals through the same canonical orchestrator", async () => {
    const source = await readFile(new URL("../src/finance-chat-agent.ts", import.meta.url), "utf8");
    const chatStart = source.indexOf('if (url.pathname === "/rpc/chat" && request.method === "POST")');
    const memoryStart = source.indexOf('if (url.pathname === "/rpc/memory/prefs" && request.method === "POST")');
    const restHandler = source.slice(chatStart, memoryStart);

    expect(source).not.toContain("tryV2MutationProposal");
    expect(restHandler).toContain("this.orchestratorForChannel(");
    expect(restHandler).toContain("mutationApiClient");
    expect(restHandler).not.toContain("new ConversationOrchestrator");
  });

  it("(1) POST /rpc/chat returns 401 when x-agent-actor or x-agent-workspace is missing", async () => {
    const { agent } = createTestAgent();

    // Missing both x-agent-actor and x-agent-workspace
    const resNoHeaders = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Qual o meu saldo?" }),
      }),
    );
    expect(resNoHeaders.status).toBe(401);

    // Missing x-agent-workspace
    const resNoWorkspace = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-actor": "user-123",
        },
        body: JSON.stringify({ text: "Qual o meu saldo?" }),
      }),
    );
    expect(resNoWorkspace.status).toBe(401);

    // Missing x-agent-actor
    const resNoActor = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-workspace": "ws-123",
        },
        body: JSON.stringify({ text: "Qual o meu saldo?" }),
      }),
    );
    expect(resNoActor.status).toBe(401);
  });

  it("(2) POST /rpc/chat with trusted headers and forged body actorId persists user message with header actor metadata, followed by relay assistant message", async () => {
    const { agent, persisted } = createTestAgent();
    // T3.1 (SPEC §14): "Quanto gastei este mês?" is a finance-seeking read,
    // so it requires evidence. Empty evidence keeps the grounded path: the
    // relay text carries no financial claim and passes validation unchanged.
    vi.spyOn(apiClient, "requestPiApiJson").mockResolvedValue({ transactions: [] });
    // Claim-free relay text (no amounts/dates/names): grounded validation
    // passes it through verbatim, preserving this test's attribution focus.
    const RELAY_TEXT = "Aqui está o resumo das suas movimentações.";
    // Fresh Response per call: a Response body can only be consumed once,
    // and each turn performs 2+ fetches (H-03 authority re-verify + relay).
    // H-14: the authority URL serves a valid snapshot (fail-closed when
    // unreachable); only the relay URL serves the model text.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      if (String(info).includes("/internal/agent/llm-config")) {
        return new Response(JSON.stringify(snapshotBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ text: RELAY_TEXT, providerAttempted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const trustedActor = "user-genuine-456";
    const trustedWorkspace = "ws-shared-family-789";

    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-actor": trustedActor,
          "x-agent-workspace": trustedWorkspace,
        },
        body: JSON.stringify({
          text: "Quanto gastei este mês?",
          intentionId: "intent-forged-actor-1",
          actorId: "attacker-spoofed-999",
          metadata: { actorId: "attacker-spoofed-999" },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: string; status?: string };
    expect(body.status).toBe("completed");
    expect(body.output).toBe(RELAY_TEXT);

    // Contract: Must call persistMessages with user message (attributed to trusted header actor, never body) and assistant message
    expect(agent.persistMessages).toHaveBeenCalled();
    expect(persisted.length).toBeGreaterThanOrEqual(2);

    const userMessage = persisted[0]!;
    expect(userMessage.role).toBe("user");
    const userText = userMessage.parts?.[0]?.text;
    expect(userText).toBe("Quanto gastei este mês?");
    const resolvedUserActor = userMessage.metadata?.actorId;
    expect(resolvedUserActor).toBe(trustedActor);
    expect(resolvedUserActor).not.toBe("attacker-spoofed-999");

    const assistantMessage = persisted[1]!;
    expect(assistantMessage.role).toBe("assistant");
    const assistantText = assistantMessage.parts?.[0]?.text;
    expect(assistantText).toBe(RELAY_TEXT);
  });

  it("POST /rpc/chat creates a V2 proposal through the Agent and returns only the safe pending DTO", async () => {
    const { agent } = createTestAgent();
    const secret = "agent-test-secret";
    Object.defineProperty(agent, "env", {
      value: {
        API_ORIGIN: "https://api.test.local",
        AGENT_DELEGATION_SECRET: secret,
      },
      writable: true,
      configurable: true,
    });
    let proposalRequest: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("/pending-operations/v2/propose")) {
        proposalRequest = new Request(String(input), init);
        return new Response(JSON.stringify({ id: "pending-v2-1" }), { status: 200 });
      }
      // SPEC §7.2/§7.3 authoritative entity reads: single account
      // auto-resolves; the UUID category is verified against the real list.
      if (String(input).includes("/accounts")) {
        return new Response(JSON.stringify({ items: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Nubank" }] }), { status: 200 });
      }
      if (String(input).includes("/categories")) {
        return new Response(JSON.stringify({ items: [{ id: "00000000-0000-4000-8000-000000000001", name: "Mercado" }] }), { status: 200 });
      }
      throw new Error(`unexpected upstream request: ${String(input)}`);
    });

    const res = await agent.fetch(new Request("https://agent.test.local/rpc/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-actor": "actor-v2",
        "x-agent-workspace": "workspace-v2",
        "x-agent-device": "device-v2",
      },
      body: JSON.stringify({
        text: "gastei R$ 12,34 no mercado na categoria 00000000-0000-4000-8000-000000000001",
        intentionId: "intent-v2-proposal",
      }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual(expect.objectContaining({ status: "completed" }));
    expect(body).not.toHaveProperty("attestation");
    expect(body).not.toHaveProperty("bindings");
    expect(body).not.toHaveProperty("normalizedArgs");
    expect(body.pendingOperation).toEqual({
      id: "pending-v2-1",
      status: "proposed",
      operation: "transactions.expense.create",
      summary: expect.any(String),
      // T3.4 (SPEC §16, INV-02): the card projection rides the same DTO,
      // derived from the canonical args — never attestation material.
      presentation: expect.objectContaining({
        id: "pending-v2-1",
        status: "proposed",
        tool: "transactions.expense.create",
        title: "Confirmar despesa",
        amountCents: 1234,
        account: { id: "00000000-0000-4000-8000-0000000000a1", label: "Nubank" },
        category: { id: "00000000-0000-4000-8000-000000000001", label: "Mercado" },
        warnings: [],
      }),
    });
    expect(JSON.stringify(body.pendingOperation)).not.toContain("attestation");

    expect(proposalRequest).toBeDefined();
    const proposalBody = await proposalRequest!.json() as Record<string, unknown>;
    expect(proposalBody.tool).toBe("transactions.expense.create");
    expect(proposalBody).not.toHaveProperty("actorId");
    expect(proposalBody).not.toHaveProperty("workspaceId");
    expect(proposalBody).not.toHaveProperty("deviceId");
    // SPEC §7 (H-01): only canonical, fully-resolved args reach propose.
    expect(proposalBody.normalizedArgs).toMatchObject({
      amountCents: 1234,
      accountId: "00000000-0000-4000-8000-0000000000a1",
      categoryId: "00000000-0000-4000-8000-000000000001",
    });
    expect(proposalBody.normalizedArgs).not.toHaveProperty("categoryQuery");
    const auth = proposalRequest!.headers.get("authorization");
    expect(auth).toMatch(/^Bearer /);
    const claims = await decodeDelegatedTurnToken(auth!.slice("Bearer ".length), secret);
    // T1.5 (SPEC §8.1): one decision-scoped token serves propose + the
    // coordinator's confirm/cancel/retry/read — still narrowly approval-only,
    // device-bound, and bound to this turn's requestId.
    expect(claims.capabilities).toEqual([
      "financial.read",
      "financial.approval.propose",
      "financial.approval.read",
      "financial.approval.confirm",
      "financial.approval.execute",
      "financial.approval.retry",
      "financial.approval.cancel",
    ]);
  });

  it("(3) GET /rpc/history returns persisted messages with isOwn derived by comparing authenticated actor to server metadata", async () => {
    const { agent, persisted } = createTestAgent();
    persisted.push(
      {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Mensagem enviada pelo User A" }],
        metadata: { actorId: "user-a", createdAt: "2026-08-30T10:00:00Z" },
      },
      {
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "Resposta do assistente TED para User A" }],
        metadata: { actorId: "ted", createdAt: "2026-08-30T10:00:05Z" },
      },
      {
        id: "msg-3",
        role: "user",
        parts: [{ type: "text", text: "Mensagem enviada pelo User B" }],
        metadata: { actorId: "user-b", createdAt: "2026-08-30T10:01:00Z" },
      },
    );

    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/history", {
        method: "GET",
        headers: {
          "x-agent-actor": "user-a",
          "x-agent-workspace": "ws-shared-family-789",
        },
      }),
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { items?: Array<{ id: string; role: string; text?: string; isOwn: boolean; actorId?: string }> } | Array<{ id: string; role: string; text?: string; isOwn: boolean; actorId?: string }>;
    const items = Array.isArray(data) ? data : data.items!;
    expect(items).toHaveLength(3);

    // Message 1 from user-a viewed by user-a -> isOwn = true
    expect(items[0]!.id).toBe("msg-1");
    expect(items[0]!.isOwn).toBe(true);

    // Message 2 from assistant -> isOwn = false
    expect(items[1]!.id).toBe("msg-2");
    expect(items[1]!.isOwn).toBe(false);

    // Message 3 from user-b viewed by user-a -> isOwn = false
    expect(items[2]!.id).toBe("msg-3");
    expect(items[2]!.isOwn).toBe(false);
  });

  it("(4) GET /rpc/history disregards client-forged actorId in query or payload and enforces header identity", async () => {
    const { agent, persisted } = createTestAgent();
    persisted.push(
      {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "Mensagem do User A" }],
        metadata: { actorId: "user-a", createdAt: "2026-08-30T10:00:00Z" },
      },
      {
        id: "msg-2",
        role: "user",
        parts: [{ type: "text", text: "Mensagem do User B" }],
        metadata: { actorId: "user-b", createdAt: "2026-08-30T10:01:00Z" },
      },
    );

    // Client attempts to spoof identity via query param ?actorId=user-b while authenticated as user-a
    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/history?actorId=user-b", {
        method: "GET",
        headers: {
          "x-agent-actor": "user-a",
          "x-agent-workspace": "ws-shared-family-789",
        },
      }),
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { items?: Array<{ id: string; isOwn: boolean; actorId?: string }> } | Array<{ id: string; isOwn: boolean; actorId?: string }>;
    const items = Array.isArray(data) ? data : data.items!;

    // Server-verified actor is user-a; query parameter ?actorId=user-b must not make user-b's message isOwn = true
    const userBItem = items.find((m) => m.id === "msg-2");
    expect(userBItem?.isOwn).toBe(false);

    const userAItem = items.find((m) => m.id === "msg-1");
    expect(userAItem?.isOwn).toBe(true);

    // Unauthenticated GET /rpc/history returns 401
    const unauthRes = await agent.fetch(
      new Request("https://agent.test.local/rpc/history", {
        method: "GET",
      }),
    );
    expect(unauthRes.status).toBe(401);
  });

  it("(5) Worker routing replaces forged x-agent-actor header with authenticated token claims and rewrites URL to DO", async () => {
    const SECRET = "secret-for-testing-purposes-at-least-32-chars!";
    const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
    const GENUINE_USER = "user-authenticated-uuid";

    const token = await createAgentConnectionToken(
      {
        sub: GENUINE_USER,
        workspace: WORKSPACE_ID,
        role: "owner",
      },
      SECRET,
    );

    let capturedDoRequest: Request | null = null;

    const mockEnv: WorkerEnv = {
      FINANCE_CHAT_AGENT: {
        idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
        get: vi.fn(() => ({
          importLegacyHistory: vi.fn(async () => ({ success: true, importedCount: 0, skipped: true })),
          fetch: vi.fn(async (req: Request) => {
            capturedDoRequest = req;
            return new Response(JSON.stringify({ items: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }),
        })),
      },
      API_ORIGIN: "https://api.test.local",
      AGENT_CONNECTION_TOKEN_SECRET: SECRET,
      AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };

    // Client sends request with valid signed token, but also tries to inject forged header x-agent-actor
    // C-01/C-02: Worker resolves the canonical workspace and consumes the
    // single-use token before routing — mock both internal endpoints.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/internal/workspace-alias/")) {
        return new Response(JSON.stringify({ canonicalHouseholdId: WORKSPACE_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/internal/agent/consume-token")) {
        return new Response(JSON.stringify({ ok: true, consumed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected upstream", { status: 500 });
    });
    const req = new Request(
      `https://agent.test.local/agents/finance-chat-agent/${WORKSPACE_ID}/rpc/history`,
      {
        method: "GET",
        headers: {
          "x-agent-connection-token": token,
          "x-agent-actor": "attacker-spoofed-id",
          "x-agent-workspace": "attacker-spoofed-workspace",
          origin: "https://pwa.example",
        },
      },
    );

    const res = await worker.fetch(req, mockEnv);
    expect(res.status).toBe(200);

    // The Durable Object must have received the request with verified actor header, NOT forged header
    expect(capturedDoRequest).not.toBeNull();
    expect(capturedDoRequest!.headers.get("x-agent-actor")).toBe(GENUINE_USER);
    expect(capturedDoRequest!.headers.get("x-agent-actor")).not.toBe("attacker-spoofed-id");
    expect(capturedDoRequest!.headers.get("x-agent-workspace")).toBe(WORKSPACE_ID);

    // URL must be rewritten to /rpc/history
    const doUrl = new URL(capturedDoRequest!.url);
    expect(doUrl.pathname).toBe("/rpc/history");
  });

  it("(6) RED: redacts sensitive secrets from user input, relay prompt, persisted messages, output and error bodies", async () => {
    const { agent, persisted } = createTestAgent();
    let capturedRelayBody: { prompt?: string } = {};
    // H-14: authority URL serves the snapshot; every other URL serves relay.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      if (String(info).includes("/internal/agent/llm-config")) {
        return new Response(JSON.stringify(snapshotBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.body) {
        capturedRelayBody = JSON.parse(init.body as string);
      }
      return new Response(JSON.stringify({ text: "Relay response containing api_key: leaked-relay-key-xyz987", providerAttempted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const userPromptWithSecret = "Meu segredo é password: my-secret-pass-123 e api_key: user-secret-key-abc999";
    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-actor": "user-test-1",
          "x-agent-workspace": "ws-test-1",
        },
        body: JSON.stringify({ text: userPromptWithSecret, intentionId: "intent-redaction-1" }),
      }),
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { output: string };

    // Output must not contain the raw relay secret
    expect(data.output).not.toContain("leaked-relay-key-xyz987");
    expect(data.output).toContain("[REDACTED]");

    // Prompt sent to relay must not contain the raw user secrets
    expect(capturedRelayBody.prompt).toBeDefined();
    expect(capturedRelayBody.prompt).not.toContain("my-secret-pass-123");
    expect(capturedRelayBody.prompt).not.toContain("user-secret-key-abc999");
    expect(capturedRelayBody.prompt).toContain("[REDACTED]");

    // Persisted messages must not contain user or assistant secrets
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    const userMsg = persisted[0]!;
    const userContent = userMsg.parts?.[0]?.text ?? "";
    expect(userContent).not.toContain("my-secret-pass-123");
    expect(userContent).not.toContain("user-secret-key-abc999");
    expect(userContent).toContain("[REDACTED]");

    const asstMsg = persisted[1]!;
    const asstContent = asstMsg.parts?.[0]?.text ?? "";
    expect(asstContent).not.toContain("leaked-relay-key-xyz987");
    expect(asstContent).toContain("[REDACTED]");
  });

  it("(7) RED: non-RPC route under /agents/finance-chat-agent/:workspace with valid token returns 404 and does not reach DO/SDK", async () => {
    const SECRET = "secret-for-testing-purposes-at-least-32-chars!";
    const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
    const GENUINE_USER = "user-authenticated-uuid";

    const token = await createAgentConnectionToken(
      {
        sub: GENUINE_USER,
        workspace: WORKSPACE_ID,
        role: "owner",
      },
      SECRET,
    );

    const mockDoFetch = vi.fn();
    const mockEnv: WorkerEnv = {
      FINANCE_CHAT_AGENT: {
        idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
        get: vi.fn(() => ({
          importLegacyHistory: vi.fn(async () => ({ success: true, importedCount: 0, skipped: true })),
          fetch: mockDoFetch,
        })),
      },
      API_ORIGIN: "https://api.test.local",
      AGENT_CONNECTION_TOKEN_SECRET: SECRET,
      AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };

    // Non-RPC subpath, e.g. /other-action or /websocket
    // C-01/C-02: auth (alias resolution + single-use consumption) runs
    // before the 404 — mock both internal endpoints.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/internal/workspace-alias/")) {
        return new Response(JSON.stringify({ canonicalHouseholdId: WORKSPACE_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/internal/agent/consume-token")) {
        return new Response(JSON.stringify({ ok: true, consumed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected upstream", { status: 500 });
    });
    const req = new Request(
      `https://agent.test.local/agents/finance-chat-agent/${WORKSPACE_ID}/other-action`,
      {
        method: "GET",
        headers: {
          "x-agent-connection-token": token,
          origin: "https://pwa.example",
        },
      },
    );

    const res = await worker.fetch(req, mockEnv);
    expect(res.status).toBe(404);
    expect(mockDoFetch).not.toHaveBeenCalled();
  });

  it("(8) RED: POST /rpc/chat fails closed with 503 if persistMessages is absent, preventing unpersisted memory mutation", async () => {
    const { agent } = createTestAgent();
    // Overwrite persistMessages to undefined
    (agent as unknown as { persistMessages: unknown }).persistMessages = undefined;
    // H-14: serve the authority so the turn reaches the persistence gate
    // (an unreachable authority now fails closed before it).
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      if (String(info).includes("/internal/agent/llm-config")) {
        return new Response(JSON.stringify(snapshotBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ text: "relay" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-actor": "user-test-1",
          "x-agent-workspace": "ws-test-1",
        },
        body: JSON.stringify({ text: "Olá TED", intentionId: "intent-no-persist-1" }),
      }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("agent.persistence_unavailable");
    // Ensure messages array was not mutated as fallback
    expect(agent.messages).toHaveLength(0);
  });
});
