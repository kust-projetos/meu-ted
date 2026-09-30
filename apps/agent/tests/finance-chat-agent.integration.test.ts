import { describe, expect, it, vi } from "vitest";
import worker, { FinanceChatAgent } from "../src/worker.js";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

describe("FinanceChatAgent & Worker Integration (Task 4)", () => {
  const API_ORIGIN = "https://api.example.test";
  const WORKSPACE_ID = "workspace-integration-test-1";

  // Realistic empty DO SQLite (ctx.storage.sql is the only storage surface):
  // usage ledgers read zero, intention snapshots miss (remote refetch below),
  // every other statement is a permissive no-op. The provider-gate test runs
  // with storage AVAILABLE so it exercises the provider gate, not the
  // storage gate (covered by tests/durable-sql-accessor.test.ts).
  const makeDurableSql = () => ({
    exec: (<T>(query: string, ..._bindings: unknown[]): Iterable<T> => {
      if (query.includes("SELECT COUNT(*) AS req_count")) {
        return [{ req_count: 0 }] as unknown as Iterable<T>;
      }
      if (query.includes("SELECT COALESCE(SUM")) {
        if (query.includes("WHERE actor_id = ?")) {
          return [{ actor_tokens: 0 }] as unknown as Iterable<T>;
        }
        return [{ total_tokens: 0 }] as unknown as Iterable<T>;
      }
      return [] as unknown as Iterable<T>;
    }),
  });

  const withDurableSql = (agent: FinanceChatAgent) => {
    Object.defineProperty(agent, "ctx", {
      value: { storage: { sql: makeDurableSql() } },
      writable: true,
      configurable: true,
    });
    (agent as unknown as { messages: unknown }).messages = [];
    (agent as unknown as { persistMessages: unknown }).persistMessages = vi.fn(async () => {});
  };

  const mockEnv: WorkerEnv = {
    API_ORIGIN,
    AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    FINANCE_CHAT_AGENT: {
      idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
      get: vi.fn(() => ({
        importLegacyHistory: vi.fn(async () => ({ success: true, importedCount: 0, skipped: true })),
        fetch: vi.fn(async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname.includes("/message")) {
            return new Response(JSON.stringify({ text: "TED response" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("finance-chat-agent ok", { status: 200 });
        }),
      })),
    },
  };

  it("exposes /health/agent and returns binding FINANCE_CHAT_AGENT", async () => {
    const res = await worker.fetch(new Request("https://agent.example.test/health/agent"), mockEnv);
    expect(res.status).toBe(200);
    const body = await res.json() as { status?: string; binding?: string };
    expect(body).toEqual({ status: "ready", binding: "FINANCE_CHAT_AGENT" });
  });

  it("routes /agents/finance-chat-agent/:workspaceId/rpc/history after validating workspace membership", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ userId: "user-1", role: "member" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: "user-1" } }), { status: 200 }))
      // C-05: the cookie fallback resolves the canonical id before naming
      // the DO (fail-closed when the authority is reachable).
      .mockResolvedValueOnce(new Response(JSON.stringify({ canonicalHouseholdId: WORKSPACE_ID }), { status: 200 }));

    const res = await worker.fetch(
      new Request(`https://agent.example.test/agents/finance-chat-agent/${WORKSPACE_ID}/rpc/history`, {
        headers: {
          cookie: "better-auth.session_token=test-session",
          origin: "https://pwa.example.test",
        },
      }),
      mockEnv,
    );

    expect(res.status).toBe(200);
    expect(mockEnv.FINANCE_CHAT_AGENT.get).toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("rejects unauthorized access to /agents/finance-chat-agent/:workspaceId with 401/403", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    const res = await worker.fetch(
      new Request(`https://agent.example.test/agents/finance-chat-agent/${WORKSPACE_ID}`, {
        headers: {
          cookie: "better-auth.session_token=invalid-session",
        },
      }),
      mockEnv,
    );

    expect([401, 403, 503]).toContain(res.status);
    fetchMock.mockRestore();
  });

  it("enforces messageConcurrency='queue' on FinanceChatAgent", () => {
    expect(FinanceChatAgent.messageConcurrency).toBe("queue");
  });

  it("fails closed when provider is not configured rather than echoing raw input or silently falling back", async () => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    // Storage available on purpose: this test guards the PROVIDER gate (no
    // env, no configured pair), not the durable-storage gate.
    withDurableSql(agent);
    // Non-finance utterance on purpose: finance-seeking reads fail closed on
    // missing evidence (SPEC §14) before ever consulting the provider, so the
    // provider-gate premise is exercised with a general question.
    const result = await agent.onChatMessage({ text: "Olá, como você pode me ajudar?", intentionId: "intent-provider-gate-1" }) as { text?: string };
    expect(result).toBeDefined();
    expect(result.text).not.toBe("Olá, como você pode me ajudar?");
    expect(result.text).toContain("provider not configured");
  });

  it("intercepts and rejects clearHistory frames for chat members", async () => {
    const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent;
    const sent: string[] = [];
    const connection = {
      send: (msg: string) => { sent.push(msg); },
    };

    await agent.onMessage(connection, JSON.stringify({ type: "clearHistory" }));
    expect(sent.some((s) => s.includes("agent.clear_forbidden"))).toBe(true);
  });
});
