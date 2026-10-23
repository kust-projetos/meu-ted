import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "agents/ai-chat-agent";
import { FinanceChatAgent } from "../src/finance-chat-agent.js";
import { decodeDelegatedTurnToken } from "../src/delegated-token.js";
import { DatabaseSync } from "node:sqlite";
import { initializeUsageSchema, initializeUsageAttemptSchema } from "../src/safety/usage-policy.js";
import { initializeMutationDraftSchema } from "../src/mutations/mutation-draft.js";

const createSqlShim = () => {
  const db = new DatabaseSync(":memory:");
  const sql: any = {
    exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return statement.all(...(bindings as any)) as T[];
      }
      statement.run(...(bindings as any));
      return [] as T[];
    },
    transactionSync<T>(fn: () => T): T {
      return fn();
    },
  };
  try { initializeUsageSchema(sql); } catch {}
  try { initializeUsageAttemptSchema(sql); } catch {}
  try { initializeMutationDraftSchema(sql); } catch {}
  return { db, sql };
};

const createTestAgent = () => {
  const persisted: UIMessage[] = [];
  const agent: any = Object.create(FinanceChatAgent.prototype);
  agent.messages = persisted;
  agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => { persisted.push(...msgs); });
  const { sql } = createSqlShim();
  Object.defineProperty(agent, "ctx", {
    value: { storage: { sql, transactionSync: sql.transactionSync } },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(agent, "state", { value: { storage: {} }, writable: true, configurable: true });
  Object.defineProperty(agent, "env", {
    value: { API_ORIGIN: "https://api.test.local", AGENT_DELEGATION_SECRET: "agent-test-secret" },
    writable: true, configurable: true,
  });
  agent.resolveIntentionSnapshot = async () => ({
    intention_id: "intent-test-1", version: 1, provider_id: "opencode-zen", model_id: "opencode-zen:zen-free-model",
    protocol: "chat-completions", rollout_percentage: 100, security_epoch: 1, fallback_provider_id: null,
    fallback_model_id: null, model_name: "zen-free-model", fallback_model_name: null, created_at: new Date().toISOString(),
  });
  return { agent, persisted, sql };
};

describe("GATE-A REST real finance-chat-agent category propose (device auth)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("category propose flow proposes exactly once with strict args", async () => {
    const { agent, sql } = createTestAgent();
    const secret = "agent-test-secret";
    const proposalRequests: Request[] = [];
    let proposeCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/pending-operations/v2/propose")) {
        proposeCallCount += 1;
        proposalRequests.push(new Request(url, init));
        return new Response(JSON.stringify({ id: "pending-cat-1" }), { status: 200 });
      }
      if (url.includes("/accounts")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/categories")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/pending-operations/v2/active")) return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
      if (url.includes("/pending-operations/v2/confirmation-intentions/bind")) return new Response(JSON.stringify({ firstSeenAt: new Date().toISOString(), fresh: true, operationId: null }), { status: 200 });
      if (url.includes("/internal/agent/llm-config")) {
        return new Response(JSON.stringify({ runtime: { singleton: "active", version: 3, securityEpoch: 1, activeProviderId: "opencode-zen", activeModelId: "opencode-zen:zen-1", activeProtocol: "chat-completions", activeRolloutPercentage: 100, activeRolloutMode: "all", fallbackProviderId: null, fallbackModelId: null, updatedBy: null }, activeProvider: null, activeModel: null, fallbackProvider: null, fallbackModel: null, activeDisabled: false, fallbackDisabled: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected upstream request: ${url}`);
    });

    const makeReq = (text: string, intentionId: string) => new Request("https://agent.test.local/rpc/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-actor": "actor-v2",
        "x-agent-workspace": "workspace-v2",
        "x-agent-device": "device-v2",
      },
      body: JSON.stringify({ text, intentionId }),
    });

    const r1 = await agent.fetch(makeReq("crie categoria Viagem", "intent-gatea-1"));
    const r2 = await agent.fetch(makeReq("de despesa", "intent-gatea-2"));
    const r3 = await agent.fetch(makeReq("sim", "intent-gatea-3"));

    await r1.json().catch(() => ({}));
    await r2.json().catch(() => ({}));
    const b3 = await r3.json().catch(() => ({}));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(proposeCallCount).toBe(1);
    expect(proposalRequests.length).toBe(1);
    const pr = proposalRequests[0]!;
    const auth = pr.headers.get("authorization");
    expect(auth).toMatch(/^Bearer /);
    const claims = await decodeDelegatedTurnToken(auth!.slice("Bearer ".length), secret);
    expect(claims.sub).toBe("actor-v2");
    expect(claims.workspace).toBe("workspace-v2");
    expect(claims.deviceId).toBe("device-v2");
    const proposalBody = await pr.clone().json() as Record<string, unknown>;
    expect(proposalBody.tool).toBe("categories.create");
    const normalizedArgs = proposalBody.normalizedArgs as Record<string, unknown>;
    expect(normalizedArgs).toEqual({ name: "Viagem", kind: "expense" });
    const draftRows = [...(sql as any).exec("SELECT proposal_idempotency_key FROM mutation_drafts")];
    const draftKey = draftRows[0]?.proposal_idempotency_key;
    expect(typeof draftKey).toBe("string");
    expect(draftKey.length).toBeGreaterThan(0);
    expect(pr.headers.get("idempotency-key")).toBe(draftKey);
    expect((b3 as any).pendingOperation?.status).toBe("proposed");
  });

  it("transactions.update traverses the real REST entry with scoped transaction read and strict manual proposal", async () => {
    const { agent } = createTestAgent();
    const proposalRequests: Request[] = [];
    vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      const url=String(input);
      if(url.includes('/pending-operations/v2/propose')) { proposalRequests.push(new Request(url,init)); return new Response(JSON.stringify({id:'pending-desc-1'}),{status:200}); }
      if(url.includes('/transactions?limit=200&offset=0')) return new Response(JSON.stringify({items:[{id:'11111111-1111-4111-8111-111111111111',householdId:'workspace-v2',kind:'expense',description:'  Mercado  ',amountCents:1200,date:'2026-10-20',accountId:'22222222-2222-4222-8222-222222222222'}],total:1,limit:200,offset:0}),{status:200});
      if(url.includes('/pending-operations/v2/active')) return new Response(JSON.stringify({items:[],total:0}),{status:200});
      if(url.includes('/pending-operations/v2/confirmation-intentions/bind')) return new Response(JSON.stringify({firstSeenAt:new Date().toISOString(),fresh:true,operationId:null}),{status:200});
      if(url.includes('/internal/agent/llm-config')) return new Response(JSON.stringify({runtime:{singleton:'active',version:3,securityEpoch:1,activeProviderId:'opencode-zen',activeModelId:'opencode-zen:zen-1',activeProtocol:'chat-completions',activeRolloutPercentage:100,activeRolloutMode:'all',fallbackProviderId:null,fallbackModelId:null,updatedBy:null},activeProvider:null,activeModel:null,fallbackProvider:null,fallbackModel:null,activeDisabled:false,fallbackDisabled:false}),{status:200});
      throw new Error(`unexpected upstream request: ${url}`);
    });
    const makeRequest=(text:string,intentionId:string)=>new Request('https://agent.test.local/rpc/chat',{method:'POST',headers:{'content-type':'application/json','x-agent-actor':'actor-v2','x-agent-workspace':'workspace-v2','x-agent-device':'device-v2'},body:JSON.stringify({text,intentionId})});
    const first=await agent.fetch(makeRequest('altere a descrição do lançamento Mercado','intent-desc-rest-1'));
    expect(first.status).toBe(200);
    expect(proposalRequests).toHaveLength(0);
    const response=await agent.fetch(makeRequest('para Feira semanal','intent-desc-rest-2'));
    expect(response.status).toBe(200);
    expect(proposalRequests).toHaveLength(1);
    const request=proposalRequests[0]!;
    const auth=request.headers.get('authorization');
    expect(auth).toMatch(/^Bearer /);
    const claims=await decodeDelegatedTurnToken(auth!.slice('Bearer '.length),'agent-test-secret');
    expect(claims.workspace).toBe('workspace-v2');
    const body=await request.clone().json() as {tool:string;normalizedArgs:Record<string,unknown>};
    expect(body.tool).toBe('transactions.update');
    expect(body.normalizedArgs).toEqual({transactionId:'11111111-1111-4111-8111-111111111111',description:'Feira semanal',expectedDescription:'  Mercado  '});
  });

  it("transactions.update without device binding never sends a proposal", async()=>{
    const {agent}=createTestAgent();
    const requests:Request[]=[];
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const url=String(input); const request=new Request(url,init); requests.push(request);
      if(url.includes('/transactions?limit=200&offset=0')) return new Response(JSON.stringify({items:[{id:'11111111-1111-4111-8111-111111111111',householdId:'workspace-v2',kind:'expense',description:'Mercado',amountCents:1200,date:'2026-10-20',accountId:'22222222-2222-4222-8222-222222222222'}],total:1}),{status:200});
      if(url.includes('/pending-operations/v2/active')) return new Response(JSON.stringify({items:[],total:0}),{status:200});
      return new Response(JSON.stringify({}),{status:200});
    });
    const response=await agent.fetch(new Request('https://agent.test.local/rpc/chat',{method:'POST',headers:{'content-type':'application/json','x-agent-actor':'actor-v2','x-agent-workspace':'workspace-v2'},body:JSON.stringify({text:'altere a descrição do lançamento Mercado para Feira',intentionId:'intent-desc-nodev'})}));
    expect(response.status).toBe(200);
    expect(requests.some((request)=>request.url.includes('/pending-operations/v2/propose'))).toBe(false);
  });

  it("no device: zero pending writes upstream", async () => {
    const { agent } = createTestAgent();
    const allRequests: { method: string; url: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = String((init as any)?.method ?? "GET").toUpperCase();
      allRequests.push({ method, url });
      if (url.includes("/pending-operations/v2/propose")) { return new Response(JSON.stringify({ id: "x" }), { status: 200 }); }
      if (url.includes("/accounts")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/categories")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/pending-operations/v2/active")) return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const res = await agent.fetch(new Request("https://agent.test.local/rpc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-actor": "actor-v2", "x-agent-workspace": "workspace-v2" },
      body: JSON.stringify({ text: "crie categoria Viagem de despesa", intentionId: "intent-nodev" }),
    }));
    expect(res.status).not.toBe(500);
    const writes = allRequests.filter((r) => r.method !== "GET" || /pending-operations|mutations|propose/i.test(r.url));
    expect(writes).toHaveLength(0);
  });
});
