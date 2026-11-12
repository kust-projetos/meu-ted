import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { parseLiveProtocolOffer } from "../src/worker.js";
import { createAgentConnectionToken } from "../../api/src/auth/agent-connection-token.js";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const secret = "secret-for-testing-purposes-at-least-32-chars!";
const alias = "workspace-alias";
const canonical = "00000000-0000-4000-8000-000000000001";

afterEach(() => vi.restoreAllMocks());

describe("live-sync websocket upgrade", () => {
  it("parses a strict protocol offer", () => {
    expect(parseLiveProtocolOffer("ted.v1, bearer.secret-token")).toEqual({ protocol: true, token: "secret-token" });
    expect(parseLiveProtocolOffer("bearer.secret-token, ted.v1")).toEqual({ protocol: true, token: "secret-token" });
    expect(parseLiveProtocolOffer("bearer.secret-token")).toEqual({ protocol: false, token: "secret-token" });
    expect(parseLiveProtocolOffer("ted.v1, bearer.bad token")).toEqual({ protocol: true });
    expect(parseLiveProtocolOffer("ted.v1, bearer.x, bearer.y")).toEqual({ protocol: true });
    expect(parseLiveProtocolOffer("ted.v1, bearer.")).toEqual({ protocol: true });
    expect(parseLiveProtocolOffer("ted.v1, ted.v1, bearer.x")).toEqual({ protocol: false, token: "x" });
    expect(parseLiveProtocolOffer("Bearer.x, TED.V1")).toEqual({ protocol: false });
    expect(parseLiveProtocolOffer("ted.v1,,bearer.x")).toEqual({ protocol: true, token: "x" });
    expect(parseLiveProtocolOffer("ted.v1, unknown.proto, bearer.x")).toEqual({ protocol: true, token: "x" });
  });

  it("uses bearer when the connection-token header is blank, but gives any nonblank header precedence", async () => {
    const headerActorToken = await createAgentConnectionToken({ sub: "header-actor", workspace: canonical, role: "owner" }, secret);
    const bearerActorToken = await createAgentConnectionToken({ sub: "bearer-actor", workspace: canonical, role: "member" }, secret);
    const doFetch = vi.fn(async (_request: Request) => new Response(null, { status: 200 }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/internal/workspace-alias/")) return Response.json({ canonicalHouseholdId: canonical });
      if (url.includes("/internal/agent/consume-token")) return Response.json({ ok: true, consumed: true });
      return new Response("unexpected", { status: 500 });
    });
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName: (name) => ({ name }) as unknown as DurableObjectId, get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example", TED_LIVE_SYNC_ENABLED: "1",
      AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };
    const live = (tokenHeader: string, bearer: string) => worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, {
      headers: { origin: "https://pwa.example", upgrade: "websocket", "x-agent-connection-token": tokenHeader, "sec-websocket-protocol": `ted.v1, bearer.${bearer}` },
    }), env);

    expect((await live("   ", bearerActorToken)).status).toBe(200);
    expect(doFetch.mock.calls[0]![0].headers.get("x-agent-actor")).toBe("bearer-actor");
    expect([401, 403]).toContain((await live("invalid-header", bearerActorToken)).status);
    expect(doFetch).toHaveBeenCalledOnce();
    expect((await live(headerActorToken, bearerActorToken)).status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(doFetch.mock.calls[1]![0].headers.get("x-agent-actor")).toBe("header-actor");
  });

  it("authenticates bearer subprotocol, strips offered credentials, and stamps canonical identity", async () => {
    const token = await createAgentConnectionToken({ sub: "protocol-actor", workspace: canonical, role: "owner" }, secret);
    const doFetch = vi.fn(async (request: Request) => new Response(null, { status: 200, headers: { "x-seen-upgrade": request.headers.get("upgrade") ?? "" } }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/internal/workspace-alias/")) return Response.json({ canonicalHouseholdId: canonical });
      if (url.includes("/internal/agent/consume-token")) return Response.json({ ok: true, consumed: true });
      return new Response("unexpected", { status: 500 });
    });
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName: (name) => ({ name }) as unknown as DurableObjectId, get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example", TED_LIVE_SYNC_ENABLED: "1",
      AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };
    const response = await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, {
      headers: { origin: "https://pwa.example", upgrade: "websocket", "sec-websocket-protocol": `ted.v1, bearer.${token}` },
    }), env);
    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledOnce();
    const forwarded = doFetch.mock.calls[0]![0];
    expect(forwarded.headers.has("sec-websocket-protocol")).toBe(false);
    expect(forwarded.headers.has("x-agent-connection-token")).toBe(false);
    let forwardedValues = "";
    forwarded.headers.forEach((value) => { forwardedValues += ` ${value}`; });
    expect(forwardedValues).not.toContain(token);
    expect(forwarded.headers.get("x-agent-actor")).toBe("protocol-actor");
    expect(forwarded.headers.get("x-agent-workspace")).toBe(canonical);
    expect(forwarded.headers.get("x-agent-role")).toBe("owner");
    expect(forwarded.headers.get("x-partykit-room")).toBe(canonical);
  });

  it("rejects protocol offer without ted.v1 before calling auth or the DO", async () => {
    const doFetch = vi.fn();
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName: () => ({} as DurableObjectId), get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example", TED_LIVE_SYNC_ENABLED: "1",
    };
    const authFetch = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, {
      headers: { origin: "https://pwa.example", upgrade: "websocket", "sec-websocket-protocol": "bearer.anything" },
    }), env);
    expect(response.status).toBe(400);
    expect(authFetch).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("rejects ted.v1 without bearer or header before auth and DO", async () => {
    const doFetch = vi.fn();
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName: () => ({} as DurableObjectId), get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example", TED_LIVE_SYNC_ENABLED: "1",
    };
    const authFetch = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, {
      headers: { origin: "https://pwa.example", upgrade: "websocket", "sec-websocket-protocol": "ted.v1" },
    }), env);
    expect(response.status).toBe(400);
    expect(authFetch).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("gates flag, origin, authorization and stamps only authorized headers", async () => {
    const token = await createAgentConnectionToken({ sub: "verified-actor", workspace: canonical, role: "owner", deviceId: "verified-device" }, secret);
    const doFetch = vi.fn(async (request: Request) => new Response(null, { status: 200, headers: { "x-seen-upgrade": request.headers.get("upgrade") ?? "" } }));
    const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName, get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example",
      AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };
    const call = (headers: HeadersInit = {}, enabled?: string) => worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live?_pk=forged&keep=1`, { headers: { origin: "https://pwa.example", upgrade: "WebSocket", "x-agent-connection-token": token, ...headers } }), { ...env, TED_LIVE_SYNC_ENABLED: enabled } as WorkerEnv);
    expect((await call({}, "0")).status).toBe(404);
    expect(doFetch).not.toHaveBeenCalled();
    expect((await call({ "sec-websocket-protocol": "ted.v1, bearer.any" }, "0")).status).toBe(404);
    expect((await call({ origin: "https://evil.example", "x-agent-connection-token": "invalid" }, undefined)).status).toBe(404);
    for (const invalidFlag of ["true", "01", " 1"]) expect((await call({}, invalidFlag)).status).toBe(404);
    expect((await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, { headers: { origin: "https://pwa.example" } }), { ...env, TED_LIVE_SYNC_ENABLED: "1" } as WorkerEnv)).status).toBe(404);
    expect((await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, { headers: { upgrade: "websocket" } }), { ...env, TED_LIVE_SYNC_ENABLED: "1" } as WorkerEnv)).status).toBe(403);
    expect((await call({ origin: "https://evil.example" }, "1")).status).toBe(403);
    expect((await call({ origin: "https://evil.example", "sec-websocket-protocol": "ted.v1, bearer.any" }, "1")).status).toBe(403);
    expect(doFetch).not.toHaveBeenCalled();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/internal/workspace-alias/")) return Response.json({ canonicalHouseholdId: canonical });
      if (url.includes("/internal/agent/consume-token")) return Response.json({ ok: true, consumed: true });
      return new Response("unexpected", { status: 500 });
    });
    const response = await call({ "sec-websocket-protocol": "ted.v1, bearer.invalid-token", cookie: "session=secret", authorization: "Bearer forged", "x-agent-actor": "forged", "x-agent-role": "member", "x-agent-workspace": "forged", "x-agent-device": "forged", "x-agent-runtime-admin-token": "forged", "x-partykit-props": "forged", "x-partykit-namespace": "forged", "x-partykit-jurisdiction": "forged" }, "1");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-seen-upgrade")).toBe("WebSocket");
    expect(doFetch).toHaveBeenCalledOnce();
    const forwarded = doFetch.mock.calls[0]![0];
    for (const key of ["cookie", "authorization", "sec-websocket-protocol", "x-agent-connection-token", "x-agent-runtime-admin-token", "x-partykit-props", "x-partykit-namespace", "x-partykit-jurisdiction"]) expect(forwarded.headers.has(key)).toBe(false);
    expect(forwarded.headers.get("x-agent-actor")).toBe("verified-actor");
    expect(forwarded.headers.get("x-agent-workspace")).toBe(canonical);
    expect(forwarded.headers.get("x-agent-role")).toBe("owner");
    expect(forwarded.headers.get("x-partykit-room")).toBe(canonical);
    expect(forwarded.headers.get("x-agent-device")).toBe("verified-device");
    expect(new URL(forwarded.url).search).toBe("?keep=1");
    expect(idFromName).toHaveBeenCalledWith(canonical);
  });

  it("returns authorization failure without forwarding when token is absent", async () => {
    const doFetch = vi.fn();
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName: () => ({} as DurableObjectId), get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example", TED_LIVE_SYNC_ENABLED: "1",
      AGENT_CONNECTION_TOKEN_SECRET: secret,
      AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ canonicalHouseholdId: canonical }));
    const response = await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/live`, { headers: { origin: "https://pwa.example", upgrade: "websocket", "x-agent-connection-token": "invalid-token" } }), env);
    expect([401, 403]).toContain(response.status);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("strips client SDK headers from authenticated REST forwarding too", async () => {
    const token = await createAgentConnectionToken({ sub: "rest-actor", workspace: canonical, role: "member" }, secret);
    const doFetch = vi.fn(async (_request: Request) => new Response("ok", { status: 200 }));
    const env: WorkerEnv = {
      FINANCE_CHAT_AGENT: { idFromName: (name: string) => ({ name }) as unknown as DurableObjectId, get: () => ({ fetch: doFetch }) },
      API_ORIGIN: "https://api.test.local", PWA_ORIGIN: "https://pwa.example",
      AGENT_CONNECTION_TOKEN_SECRET: secret, AGENT_AUTH_SERVICE_TOKEN: "test-auth-service-token",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/internal/workspace-alias/")) return Response.json({ canonicalHouseholdId: canonical });
      if (url.includes("/internal/agent/consume-token")) return Response.json({ ok: true, consumed: true });
      return new Response("unexpected", { status: 500 });
    });
    const response = await worker.fetch(new Request(`https://agent.test.local/agents/finance-chat-agent/${alias}/rpc/history`, {
      headers: { origin: "https://pwa.example", "x-agent-connection-token": token, "x-agent-runtime-admin-token": "forged", "x-agent-props": "forged", "x-partykit-props": "forged", "x-partykit-namespace": "forged" },
    }), env);
    expect(response.status).toBe(200);
    const forwarded = doFetch.mock.calls[0]![0];
    expect(forwarded.headers.get("x-agent-connection-token")).toBe(token);
    for (const key of ["x-agent-runtime-admin-token", "x-agent-props", "x-partykit-props", "x-partykit-namespace"]) expect(forwarded.headers.has(key)).toBe(false);
    expect(forwarded.headers.get("x-agent-actor")).toBe("rest-actor");
    expect(forwarded.headers.get("x-agent-workspace")).toBe(canonical);
    expect(forwarded.headers.get("x-agent-role")).toBe("member");
  });
});
