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

  it("(timeout) FIX-melhorias item 5 (#169 retry-timeout): resposta perdida + redelivery tardio converge sem duplicata", async () => {
    // Somente teste: o redelivery intencional (mesmo intentionId, teste (d))
    // existe; faltava o caso timeout — o servidor processou TUDO (par
    // persistido, proposta materializada) mas a resposta HTTP se perdeu no
    // transporte. O redelivery tardio deve convergir: 200, zero linhas
    // extras, MESMA proposta e MESMA resposta — nunca um segundo efeito.
    const { agent, persisted } = createTestAgent();
    mockProposalUpstream();
    const text = "gastei 90 com carne no mercado na categoria 00000000-0000-4000-8000-000000000001";
    const post = (intentionId: string) =>
      agent.fetch(
        new Request("https://agent.test.local/rpc/chat", {
          method: "POST",
          headers: chatHeaders,
          body: JSON.stringify({ text, intentionId }),
        }),
      );

    // 1º POST: processado integralmente; a resposta "se perde" (o teste a
    // descarta como um timeout no transporte a descartaria).
    const r1 = await post("intent-169-timeout");
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { output?: string; pendingOperation?: { id?: string } };
    expect(b1.output).toBeTruthy();
    expect(b1.pendingOperation?.id).toBe("pending-169-1");
    const countAfterLoss = persisted.length;
    expect(countAfterLoss).toBeGreaterThanOrEqual(2);

    // Redelivery tardio com o MESMO intentionId.
    const r2 = await post("intent-169-timeout");
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { output?: string; pendingOperation?: { id?: string } };
    expect(persisted.length).toBe(countAfterLoss);
    expect(b2.pendingOperation?.id).toBe(b1.pendingOperation?.id);
    expect(b2.output).toBe(b1.output);

    // E o histórico segue com UM par (sem duplicata visível).
    const hist = await agent.fetch(historyReq());
    expect(hist.status).toBe(200);
    const data = (await hist.json()) as {
      items: Array<{ role: string; text?: string; content?: string; intentionId?: string }>;
    };
    expect(data.items.filter((i) => i.intentionId === "intent-169-timeout").map((i) => i.role).sort()).toEqual([
      "assistant",
      "user",
    ]);
  });
});

describe("FIX-melhorias item 2: ?limit= no /rpc/history (default 200, shape intacto)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const storedMsg = (
    id: string,
    role: "user" | "assistant",
    text: string,
    createdAt: string,
  ): UIMessage =>
    ({
      id,
      role,
      parts: [{ type: "text", text }],
      metadata: {
        actorId: role === "assistant" ? "ted" : "actor-169",
        workspaceId: "workspace-169",
        createdAt,
      },
    }) as unknown as UIMessage;

  const seedPairs = async (
    agent: { persistMessages: (msgs: UIMessage[]) => Promise<void> },
    count: number,
  ): Promise<void> => {
    const base = Date.parse("2026-10-01T10:00:00.000Z");
    const msgs: UIMessage[] = [];
    for (let i = 0; i < count; i += 1) {
      const stamp = new Date(base + i * 60_000).toISOString();
      msgs.push(storedMsg(`seed-user-${i}`, "user", `pergunta ${i}`, stamp));
      msgs.push(storedMsg(`seed-asst-${i}`, "assistant", `resposta ${i}`, stamp));
    }
    await agent.persistMessages(msgs);
  };

  const historyReqWith = (query: string) =>
    new Request(`https://agent.test.local/rpc/history${query}`, {
      method: "GET",
      headers: {
        "x-agent-actor": "actor-169",
        "x-agent-workspace": "workspace-169",
      },
    });

  it("?limit=2 pagina os mais antigos primeiro, sem mudar o shape {items, total}", async () => {
    const { agent } = createTestAgent();
    await seedPairs(agent, 3);
    const hist = await agent.fetch(historyReqWith("?limit=2"));
    expect(hist.status).toBe(200);
    const data = (await hist.json()) as {
      items: Array<{ id: string; role: string; text?: string; content?: string }>;
      total: number;
    };
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe("number");
    expect(data.items).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.items[0]!.id).toBe("seed-user-0");
    expect(data.items[1]!.id).toBe("seed-asst-0");
  });

  it("sem limit retorna tudo (default alto cobre conversa longa)", async () => {
    const { agent } = createTestAgent();
    await seedPairs(agent, 3);
    const hist = await agent.fetch(historyReqWith(""));
    expect(hist.status).toBe(200);
    const data = (await hist.json()) as { items: Array<{ id: string }>; total: number };
    expect(data.items).toHaveLength(6);
    expect(data.total).toBe(6);
  });

  it("?limit inválido ou <= 0 cai no default (retorna tudo)", async () => {
    const { agent } = createTestAgent();
    await seedPairs(agent, 3);
    for (const query of ["?limit=abc", "?limit=0", "?limit=-5"]) {
      const hist = await agent.fetch(historyReqWith(query));
      expect(hist.status).toBe(200);
      const data = (await hist.json()) as { items: Array<{ id: string }>; total: number };
      expect(data.items).toHaveLength(6);
      expect(data.total).toBe(6);
    }
  });
});

describe("FIX-melhorias item 6 (#169 conversa-longa): persist em volume 40+ turnos", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("45 turnos (90 msgs) persistem e o history serve tudo sob o default; ?limit= degrada graciosamente", async () => {
    // Somente teste: sem paginação além do item 2 — o default 200 cobre a
    // conversa longa inteira; o slice é ordenado e o shape não muda.
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

    const TURNS = 45;
    const base = Date.parse("2026-10-01T10:00:00.000Z");
    const batch: UIMessage[] = [];
    for (let i = 0; i < TURNS; i += 1) {
      const stamp = new Date(base + i * 60_000).toISOString();
      const intentionId = `vol-turn-${i}`;
      batch.push({
        id: `vol-user-${i}`,
        role: "user",
        parts: [{ type: "text", text: `pergunta volume ${i}` }],
        metadata: { actorId: "actor-169", workspaceId: "workspace-169", createdAt: stamp, intentionId },
      } as unknown as UIMessage);
      batch.push({
        id: `vol-asst-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `resposta volume ${i}` }],
        metadata: { actorId: "ted", workspaceId: "workspace-169", createdAt: stamp, intentionId },
      } as unknown as UIMessage);
    }
    await agent.persistMessages(batch);
    expect(persisted).toHaveLength(TURNS * 2);

    // History completo sob o default: 90 itens ordenados, identidade preservada.
    const full = await agent.fetch(historyReq());
    expect(full.status).toBe(200);
    const fullData = (await full.json()) as {
      items: Array<{ id: string; intentionId?: string }>;
      total: number;
    };
    expect(fullData.items).toHaveLength(TURNS * 2);
    expect(fullData.total).toBe(TURNS * 2);
    expect(fullData.items[0]!.id).toBe("vol-user-0");
    expect(fullData.items[fullData.items.length - 1]!.id).toBe(`vol-asst-${TURNS - 1}`);
    expect(
      fullData.items.filter((i) => i.intentionId === `vol-turn-${TURNS - 1}`).map((i) => i.id).sort(),
    ).toEqual([`vol-asst-${TURNS - 1}`, `vol-user-${TURNS - 1}`]);

    // Degradação graciosa: ?limit=50 pagina os mais antigos primeiro, sem erro.
    const pagedReq = new Request("https://agent.test.local/rpc/history?limit=50", {
      method: "GET",
      headers: {
        "x-agent-actor": "actor-169",
        "x-agent-workspace": "workspace-169",
      },
    });
    const paged = await agent.fetch(pagedReq);
    expect(paged.status).toBe(200);
    const pagedData = (await paged.json()) as {
      items: Array<{ id: string }>;
      total: number;
    };
    expect(pagedData.items).toHaveLength(50);
    expect(pagedData.total).toBe(50);
    expect(pagedData.items[0]!.id).toBe("vol-user-0");
    expect(pagedData.items[49]!.id).toBe("vol-asst-24");
  });
});
