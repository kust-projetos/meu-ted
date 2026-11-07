/**
 * P3 — narrow proposal broker RPC (A4).
 *
 * The OpenCode runtime has NO delegation secret and must never mint financial
 * capabilities. This route is the ONLY legitimate bridge: the authenticated
 * PWA sends the runtime's proposal INTENT; the existing Agent mints the
 * approval-scoped delegated token and calls the authoritative Pending V2
 * propose endpoint. It cannot confirm, execute or cancel anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'agents/ai-chat-agent';
import { FinanceChatAgent } from '../src/finance-chat-agent.js';
import { decodeDelegatedTurnToken } from '../src/delegated-token.js';

const DELEGATION_SECRET = 'test-delegation-secret-32-chars-min!!';
const CONNECTION_TOKEN = 'connection-token-present';
const WS = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'user-real';
const DEVICE = 'device-binding-1';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const CATEGORY = '44444444-4444-4444-8444-444444444444';
const API_ORIGIN = 'https://api.example.test';

const createTestAgent = (envOverrides: Record<string, unknown> = {}) => {
  const persisted: UIMessage[] = [];
  const agent = Object.create(FinanceChatAgent.prototype) as FinanceChatAgent & {
    messages: UIMessage[];
    persistMessages: (msgs: UIMessage[]) => Promise<void>;
  };
  agent.messages = persisted;
  agent.persistMessages = vi.fn(async (msgs: UIMessage[]) => {
    persisted.push(...msgs);
  });
  Object.defineProperty(agent, 'state', { value: { storage: {} }, writable: true, configurable: true });
  Object.defineProperty(agent, 'env', {
    value: {
      API_ORIGIN,
      AGENT_DELEGATION_SECRET: DELEGATION_SECRET,
      ...envOverrides,
    },
    writable: true,
    configurable: true,
  });
  return { agent, persisted };
};

const identityHeaders = (overrides: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  'x-agent-connection-token': CONNECTION_TOKEN,
  'x-agent-actor': ACTOR,
  'x-agent-workspace': WS,
  'x-agent-device': DEVICE,
  'x-agent-role': 'owner',
  ...overrides,
});

const validBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'transactions.expense.create',
  intentionId: 'int-abc123',
  normalizedArgs: {
    amountCents: 5000,
    description: 'mercado',
    date: '2026-11-06',
    accountId: ACCOUNT,
    categoryId: CATEGORY,
  },
  ...overrides,
});

const validIncomeBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'transactions.income.create',
  intentionId: 'int-income-abc123',
  normalizedArgs: {
    amountCents: 250000,
    description: 'salário',
    date: '2026-11-07',
    accountId: ACCOUNT,
    categoryId: CATEGORY,
  },
  ...overrides,
});

const proposeRequest = (body: unknown, headers = identityHeaders()) =>
  new Request('https://agent.test.local/rpc/pending-operations/propose', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

const captureFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
};

describe('P3 — POST /rpc/pending-operations/propose (Agent A4 broker)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('mints a propose-only delegated token and calls Pending V2 once', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'op-1', existing: false }, { status: 201 }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    const res = await agent.fetch(proposeRequest(validBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'op-1', existing: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_ORIGIN}/pending-operations/v2/propose`);
    expect(calls[0]!.init?.method).toBe('POST');

    const headers = new Headers(calls[0]!.init?.headers);
    const auth = headers.get('authorization')!;
    expect(auth.startsWith('Bearer ')).toBe(true);
    const claims = await decodeDelegatedTurnToken(auth.slice('Bearer '.length), DELEGATION_SECRET);
    expect(claims.iss).toBe('pi-agent');
    expect(claims.sub).toBe(ACTOR);
    expect(claims.workspace).toBe(WS);
    expect(claims.deviceId).toBe(DEVICE);
    expect(claims.request).toBe('int-abc123');
    expect(claims.capabilities).toEqual(['financial.approval.propose']);

    const key = headers.get('idempotency-key');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(headers.get('x-workspace-id')).toBe(WS);
    expect(headers.get('x-actor-id')).toBe(ACTOR);
    expect(headers.get('x-device-id')).toBe(DEVICE);

    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.tool).toBe('transactions.expense.create');
    expect(sent.normalizedArgs).toEqual(validBody().normalizedArgs);
    expect(typeof sent.expiresAt).toBe('string');
  });

  it('is idempotent: a redelivery reuses the same key and relays existing:true', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      return Response.json({ id: 'op-1', existing: true }, { status: 200 });
    }) as unknown as typeof fetch;
    const { agent } = createTestAgent();

    const first = await agent.fetch(proposeRequest(validBody()));
    const second = await agent.fetch(proposeRequest(validBody()));
    expect((await first.json()).existing).toBe(true);
    expect((await second.json()).existing).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('accepts transactions.income.create with the same propose-only A4 path', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'op-income-1', existing: false }, { status: 201 }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    const res = await agent.fetch(proposeRequest(validIncomeBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'op-income-1', existing: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_ORIGIN}/pending-operations/v2/propose`);
    const headers = new Headers(calls[0]!.init?.headers);
    const auth = headers.get('authorization')!;
    const claims = await decodeDelegatedTurnToken(auth.slice('Bearer '.length), DELEGATION_SECRET);
    expect(claims.capabilities).toEqual(['financial.approval.propose']);
    expect(claims.request).toBe('int-income-abc123');
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.tool).toBe('transactions.income.create');
    expect(sent.normalizedArgs).toEqual(validIncomeBody().normalizedArgs);
  });

  it('refuses any tool other than the two proposal tools with zero transport', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    for (const tool of ['transactions.update', 'accounts.deactivate', 'transactions.transfer.create', 'evil']) {
      const res = await agent.fetch(proposeRequest(validBody({ tool })));
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects identity/unknown normalizedArgs keys with zero transport', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    for (const extra of [{ workspaceId: WS }, { idempotencyKey: 'x' }, { token: 'x' }, { bogus: 1 }]) {
      const body = validBody();
      const res = await agent.fetch(
        proposeRequest({ ...body, normalizedArgs: { ...(body.normalizedArgs as object), ...extra } }),
      );
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('validates the transaction contract strictly for expense AND income (amount/description/date/uuids)', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    const invalid = [
      { amountCents: 0 },
      { amountCents: 12.5 },
      { description: '   ' },
      { date: '06/11/2026' },
      { accountId: 'nope' },
      { categoryId: 'nope' },
    ];
    for (const makeBody of [validBody, validIncomeBody]) {
      for (const patch of invalid) {
        const body = makeBody();
        const res = await agent.fetch(
          proposeRequest({ ...body, normalizedArgs: { ...(body.normalizedArgs as object), ...patch } }),
        );
        expect(res.status).toBe(400);
      }
      const missing = await agent.fetch(proposeRequest(makeBody({ intentionId: '' })));
      expect(missing.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('fails closed without device binding, delegation secret or connection token', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
    globalThis.fetch = fn;

    const noDevice = createTestAgent();
    const r1 = await noDevice.agent.fetch(proposeRequest(validBody(), identityHeaders({ 'x-agent-device': '' })));
    expect(r1.status).toBe(401);

    const noSecret = createTestAgent({ AGENT_DELEGATION_SECRET: undefined });
    const r2 = await noSecret.agent.fetch(proposeRequest(validBody()));
    expect(r2.status).toBe(401);

    const noToken = createTestAgent();
    const r3 = await noToken.agent.fetch(proposeRequest(validBody(), identityHeaders({ 'x-agent-connection-token': '' })));
    expect(r3.status).toBe(401);

    expect(calls).toHaveLength(0);
  });

  it('never exposes confirm/execute/cancel through this broker', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    for (const path of ['confirm', 'execute', 'cancel', 'authorize', 'retry']) {
      const res = await agent.fetch(
        new Request(`https://agent.test.local/rpc/pending-operations/op-1/${path}`, {
          method: 'POST',
          headers: identityHeaders(),
          body: JSON.stringify({ decision: 'confirm', requestId: 'r-1' }),
        }),
      );
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});
