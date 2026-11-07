/**
 * P3 — Worker allowlist for the proposal broker. Only the exact path reaches
 * FinanceChatAgent; identity/device are stamped from the verified connection
 * token, never from client headers.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createAgentConnectionToken } from '../../api/src/auth/agent-connection-token.js';
import worker from '../src/worker.js';

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const CONNECTION_SECRET = 'test-connection-secret-32-chars-minimum!!';
const SERVICE_TOKEN = 'test-service-token-32-chars-minimum!!';
const WS = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'user-uuid-1';
const DEVICE = 'device-1';

const token = () =>
  createAgentConnectionToken({ sub: ACTOR, workspace: WS, role: 'owner', deviceId: DEVICE }, CONNECTION_SECRET);

const apiFetch = () =>
  (async (url: unknown) => {
    const u = String(url);
    if (u.includes('/internal/workspace-alias/')) {
      return new Response(JSON.stringify({ canonicalHouseholdId: WS }), { status: 200 });
    }
    if (u.includes('/internal/agent/consume-token')) {
      return new Response(JSON.stringify({ ok: true, consumed: true }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

describe('P3 — Worker routes the proposal broker only on the exact path', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = apiFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('forwards POST /rpc/pending-operations/propose to the DO with stamped identity', async () => {
    let received: Request | undefined;
    const doFetch = vi.fn(async (request: Request) => {
      received = request;
      return Response.json({ id: 'op-1', existing: false });
    });
    const env = {
      API_ORIGIN: 'https://api.example.test',
      AGENT_CONNECTION_TOKEN_SECRET: CONNECTION_SECRET,
      AGENT_AUTH_SERVICE_TOKEN: SERVICE_TOKEN,
      FINANCE_CHAT_AGENT: { idFromName: vi.fn(() => ({})), get: vi.fn(() => ({ fetch: doFetch })) },
    } as unknown as WorkerEnv;

    const res = await worker.fetch(
      new Request(`https://worker.test/agents/finance-chat-agent/${WS}/rpc/pending-operations/propose`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-connection-token': await token(),
          'x-agent-device': 'attacker-device',
          'x-agent-actor': 'attacker-actor',
        },
        body: JSON.stringify({ tool: 'transactions.expense.create' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'op-1', existing: false });
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(received).toBeDefined();
    expect(new URL(received!.url).pathname).toBe('/rpc/pending-operations/propose');
    expect(received!.method).toBe('POST');
    expect(received!.headers.get('x-agent-actor')).toBe(ACTOR);
    expect(received!.headers.get('x-agent-workspace')).toBe(WS);
    expect(received!.headers.get('x-agent-device')).toBe(DEVICE);
    expect(received!.headers.get('x-agent-role')).toBe('owner');
  });

  it('does not route lookalike write paths', async () => {
    const doFetch = vi.fn(async () => Response.json({ must: 'not run' }));
    const env = {
      API_ORIGIN: 'https://api.example.test',
      AGENT_CONNECTION_TOKEN_SECRET: CONNECTION_SECRET,
      AGENT_AUTH_SERVICE_TOKEN: SERVICE_TOKEN,
      FINANCE_CHAT_AGENT: { idFromName: vi.fn(() => ({})), get: vi.fn(() => ({ fetch: doFetch })) },
    } as unknown as WorkerEnv;

    for (const sub of ['propose-extra', 'propose/confirm', 'execute']) {
      const res = await worker.fetch(
        new Request(`https://worker.test/agents/finance-chat-agent/${WS}/rpc/pending-operations/${sub}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agent-connection-token': await token() },
          body: JSON.stringify({}),
        }),
        env,
      );
      expect(res.status).toBe(404);
    }
    expect(doFetch).not.toHaveBeenCalled();
  });
});
