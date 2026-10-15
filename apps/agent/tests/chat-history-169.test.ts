import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "agents/ai-chat-agent";
import { FinanceChatAgent } from "../src/finance-chat-agent.js";
import { InMemoryMutationDraftStore } from "../src/mutations/mutation-draft.js";
import { attachRelayUsageStorage } from "./helpers/relay-usage-storage.js";

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
    value: { storage: {} },
    writable: true,
    configurable: true,
  });
  attachRelayUsageStorage(agent);
  Object.defineProperty(agent, "env", {
    value: {
      API_ORIGIN: "https://api.test.local",
      AGENT_DELEGATION_SECRET: "agent-test-secret-169",
    },
    writable: true,
    configurable: true,
  });
  return { agent, persisted };
};

const mockProposalUpstream = () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).includes("/pending-operations/v2/propose")) {
      return new Response(JSON.stringify({ id: "pending-169-1" }), { status: 200 });
    }
    if (String(input).includes("/accounts")) {
      return new Response(
        JSON.stringify({ items: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Nubank" }] }),
        { status: 200 },
      );
    }
    if (String(input).includes("/categories")) {
      return new Response(
        JSON.stringify({ items: [{ id: "00000000-0000-4000-8000-000000000001", name: "Mercado" }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected upstream request: ${String(input)}`);
  });
};

const chatHeaders = {
  "content-type": "application/json",
  "x-agent-actor": "actor-169",
  "x-agent-workspace": "workspace-169",
  "x-agent-device": "device-169",
};

const historyReq = () =>
  new Request("https://agent.test.local/rpc/history", {
    method: "GET",
    headers: {
      "x-agent-actor": "actor-169",
      "x-agent-workspace": "workspace-169",
    },
  });

describe("FIX-169 RED: mutation turns persist into durable history", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a/b) POST proposal persists user+assistant and GET /rpc/history returns the pair", async () => {
    const { agent, persisted } = createTestAgent();
    mockProposalUpstream();
    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: chatHeaders,
        body: JSON.stringify({
          text: "gastei 90 com carne no mercado na categoria 00000000-0000-4000-8000-000000000001",
          intentionId: "intent-169-a",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: string; pendingOperation?: { id?: string } };
    expect(body.output).toBeTruthy();
    expect(body.pendingOperation?.id).toBe("pending-169-1");

    const roles = persisted.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const userMsg = persisted.find((m) => m.role === "user");
    expect(userMsg?.parts?.[0]?.text).toContain("carne");

    const hist = await agent.fetch(historyReq());
    expect(hist.status).toBe(200);
    const data = (await hist.json()) as { items: Array<{ role: string; text?: string; content?: string }> };
    const texts = data.items.map((i) => i.text ?? i.content ?? "");
    expect(texts.some((t) => t.includes("carne"))).toBe(true);
    expect(data.items.some((i) => i.role === "assistant")).toBe(true);
  });

  it("(d) retry with the same intentionId produces zero duplication", async () => {
    const { agent, persisted } = createTestAgent();
    mockProposalUpstream();
    const send = (intent: string) =>
      agent.fetch(
        new Request("https://agent.test.local/rpc/chat", {
          method: "POST",
          headers: chatHeaders,
          body: JSON.stringify({
            text: "gastei 90 com carne no mercado na categoria 00000000-0000-4000-8000-000000000001",
            intentionId: intent,
          }),
        }),
      );
    const r1 = await send("intent-169-dedupe");
    expect(r1.status).toBe(200);
    const countAfterFirst = persisted.length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(2);
    const r2 = await send("intent-169-dedupe");
    expect(r2.status).toBe(200);
    expect(persisted.length).toBe(countAfterFirst);
  });

  it("(e) two sends with distinct ids persist two pairs", async () => {
    const { agent, persisted } = createTestAgent();
    mockProposalUpstream();
    for (const intent of ["intent-169-e1", "intent-169-e2"]) {
      const r = await agent.fetch(
        new Request("https://agent.test.local/rpc/chat", {
          method: "POST",
          headers: chatHeaders,
          body: JSON.stringify({
            text: "gastei 90 com carne no mercado na categoria 00000000-0000-4000-8000-000000000001",
            intentionId: intent,
          }),
        }),
      );
      expect(r.status).toBe(200);
    }
    expect(persisted.filter((m) => m.role === "user").length).toBe(2);
    expect(persisted.filter((m) => m.role === "assistant").length).toBe(2);
  });

  it("(b-cancel) POST cancel turn persists the Q&A pair", async () => {
    const { agent, persisted } = createTestAgent();
    mockProposalUpstream();
    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: chatHeaders,
        body: JSON.stringify({ text: "cancelar", intentionId: "intent-169-cancel" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(persisted.some((m) => m.role === "user")).toBe(true);
    expect(persisted.some((m) => m.role === "assistant")).toBe(true);
  });

  it("(P2-1) RED: multiturno 'gastei 90 com carne' → 'mercado' → reload tem o Q&A completo; redelivery sem duplicata", async () => {
    const { agent, persisted } = createTestAgent();
    // O draft vive no DO em produção; aqui um store em memória no mesmo
    // agente cumpre o mesmo contrato (continuação multiturbo real).
    const store = new InMemoryMutationDraftStore();
    (agent as unknown as { draftStoreForRequest: () => unknown }).draftStoreForRequest = () => store;
    mockProposalUpstream();
    const post = (text: string, intentionId: string) =>
      agent.fetch(
        new Request("https://agent.test.local/rpc/chat", {
          method: "POST",
          headers: chatHeaders,
          body: JSON.stringify({ text, intentionId }),
        }),
      );
    const r1 = await post("gastei 90 com carne", "intent-169-p21-1");
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { output?: string; pendingOperation?: unknown };
    expect(b1.pendingOperation).toBeUndefined();
    expect(b1.output).toMatch(/qual categoria/i);

    // 'mercado' roteia `unsupported` mas continua o draft e vira proposta.
    const r2 = await post("mercado", "intent-169-p21-2");
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { output?: string; pendingOperation?: { id?: string } };
    expect(b2.pendingOperation?.id).toBe("pending-169-1");

    // Reload: o Q&A dos DOIS turnos está no histórico (o user 'mercado' não some).
    const hist = await agent.fetch(historyReq());
    expect(hist.status).toBe(200);
    const data = (await hist.json()) as {
      items: Array<{ role: string; text?: string; content?: string; intentionId?: string }>;
    };
    const texts = data.items.map((i) => i.text ?? i.content ?? "");
    expect(texts.some((t) => t.includes("gastei 90 com carne"))).toBe(true);
    expect(texts.filter((t) => t === "mercado").length).toBe(1);
    expect(data.items.filter((i) => i.role === "assistant").length).toBe(2);

    // Redelivery do turno de continuação com o mesmo intentionId: zero linhas a mais.
    const countAfterSecond = persisted.length;
    const r3 = await post("mercado", "intent-169-p21-2");
    expect(r3.status).toBe(200);
    expect(persisted.length).toBe(countAfterSecond);
    const hist2 = (await (await agent.fetch(historyReq())).json()) as {
      items: Array<{ role: string; text?: string; content?: string }>;
    };
    expect(hist2.items.map((i) => i.text ?? i.content ?? "").filter((t) => t === "mercado").length).toBe(1);
  });

  it("(P2-2) RED: /rpc/history publica o intentionId do par Q&A de mutação", async () => {
    const { agent } = createTestAgent();
    mockProposalUpstream();
    const res = await agent.fetch(
      new Request("https://agent.test.local/rpc/chat", {
        method: "POST",
        headers: chatHeaders,
        body: JSON.stringify({
          text: "gastei 90 com carne no mercado na categoria 00000000-0000-4000-8000-000000000001",
          intentionId: "intent-169-id-echo",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const hist = await agent.fetch(historyReq());
    expect(hist.status).toBe(200);
    const data = (await hist.json()) as {
      items: Array<{ role: string; text?: string; content?: string; intentionId?: string }>;
    };
    const pair = data.items.filter((i) => i.intentionId === "intent-169-id-echo");
    expect(pair.map((i) => i.role).sort()).toEqual(["assistant", "user"]);
  });
});
