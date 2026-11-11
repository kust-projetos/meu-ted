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

const validTransferBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'transactions.transfer.create',
  intentionId: 'int-transfer-abc123',
  normalizedArgs: {
    amountCents: 30000,
    description: 'Transferência Itaú → Nubank',
    date: '2026-11-07',
    fromAccountId: ACCOUNT,
    toAccountId: '33333333-3333-4333-8333-333333333334',
  },
  ...overrides,
});

const validCardBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'cards.purchase.create',
  intentionId: 'int-card-abc123',
  normalizedArgs: {
    amountCents: 120000,
    description: 'celular',
    date: '2026-11-07',
    accountId: ACCOUNT,
    installmentsTotal: 6,
  },
  ...overrides,
});

const validStatementBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'cards.statement.pay',
  intentionId: 'int-statement-abc123',
  normalizedArgs: {
    statementId: '44444444-4444-4444-8444-444444444444',
    fromAccountId: ACCOUNT,
    amountCents: 85000,
  },
  ...overrides,
});

const validAccountCreateBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'accounts.create',
  intentionId: 'int-account-abc123',
  normalizedArgs: { name: 'Nubank', kind: 'bank', initialBalanceCents: 0 },
  ...overrides,
});

const validCategoryCreateBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'categories.create',
  intentionId: 'int-category-abc123',
  normalizedArgs: { name: 'Alimentação', kind: 'expense' },
  ...overrides,
});

const validTransactionUpdateBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'transactions.update',
  intentionId: 'int-txupdate-abc123',
  normalizedArgs: { transactionId: ACCOUNT, description: 'Mercado novo', expectedDescription: 'Mercado' },
  ...overrides,
});

const validAccountUpdateBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'accounts.update',
  intentionId: 'int-account-update-abc123',
  normalizedArgs: { accountId: ACCOUNT, name: 'Reserva', expectedName: 'Aurora' },
  ...overrides,
});

const validAccountDeactivateBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'accounts.deactivate',
  intentionId: 'int-account-deactivate-abc123',
  normalizedArgs: { accountId: ACCOUNT, accountName: 'Antiga' },
  ...overrides,
});

const validCategoryUpdateBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'categories.update',
  intentionId: 'int-category-update-abc123',
  normalizedArgs: { categoryId: CATEGORY, name: 'Supermercado', expectedName: 'Mercado' },
  ...overrides,
});

const validCategoryDeactivateBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'categories.deactivate',
  intentionId: 'int-category-deactivate-abc123',
  normalizedArgs: { categoryId: CATEGORY, expectedName: 'Mercado' },
  ...overrides,
});

const validPayableCreateBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'payables.create',
  intentionId: 'int-payable-create-abc123',
  normalizedArgs: { accountId: ACCOUNT, description: 'Aluguel', amountCents: 150000, dueDate: '2026-12-05' },
  ...overrides,
});

const validPayablePayBody = (overrides: Record<string, unknown> = {}) => ({
  tool: 'payables.pay',
  intentionId: 'int-payable-pay-abc123',
  normalizedArgs: {
    payableId: '55555555-5555-4555-8555-555555555555',
    description: 'Aluguel',
    amountCents: 150000,
    dueDate: '2026-12-05',
    accountId: ACCOUNT,
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

  it('accepts transactions.transfer.create on the same propose-only A4 path', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'op-transfer-1', existing: false }, { status: 201 }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    const res = await agent.fetch(proposeRequest(validTransferBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'op-transfer-1', existing: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_ORIGIN}/pending-operations/v2/propose`);
    const headers = new Headers(calls[0]!.init?.headers);
    const auth = headers.get('authorization')!;
    const claims = await decodeDelegatedTurnToken(auth.slice('Bearer '.length), DELEGATION_SECRET);
    expect(claims.capabilities).toEqual(['financial.approval.propose']);
    expect(claims.request).toBe('int-transfer-abc123');
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.tool).toBe('transactions.transfer.create');
    expect(sent.normalizedArgs).toEqual(validTransferBody().normalizedArgs);
    expect('categoryId' in sent.normalizedArgs).toBe(false);
  });

  it('accepts cards.purchase.create with installmentsTotal on the same propose-only A4 path', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'op-card-1', existing: false }, { status: 201 }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    const res = await agent.fetch(proposeRequest(validCardBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'op-card-1', existing: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_ORIGIN}/pending-operations/v2/propose`);
    const sent = JSON.parse(String(calls[0]!.init?.body)) as {
      tool: string;
      normalizedArgs: Record<string, unknown>;
    };
    expect(sent.tool).toBe('cards.purchase.create');
    expect(sent.normalizedArgs).toEqual(validCardBody().normalizedArgs);
    expect(sent.normalizedArgs.installmentsTotal).toBe(6);
    expect(sent.normalizedArgs.amountCents).toBe(120000);
  });

  it('accepts cards.statement.pay on the same propose-only A4 path', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'op-statement-1', existing: false }, { status: 201 }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    const res = await agent.fetch(proposeRequest(validStatementBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'op-statement-1', existing: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_ORIGIN}/pending-operations/v2/propose`);
    const headers = new Headers(calls[0]!.init?.headers);
    const auth = headers.get('authorization')!;
    const claims = await decodeDelegatedTurnToken(auth.slice('Bearer '.length), DELEGATION_SECRET);
    expect(claims.capabilities).toEqual(['financial.approval.propose']);
    expect(claims.request).toBe('int-statement-abc123');
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.tool).toBe('cards.statement.pay');
    expect(sent.normalizedArgs).toEqual(validStatementBody().normalizedArgs);
    expect('description' in sent.normalizedArgs).toBe(false);
    expect('date' in sent.normalizedArgs).toBe(false);
  });

  it('accepts accounts.create on the same propose-only A4 path', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'op-account-1', existing: false }, { status: 201 }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    const res = await agent.fetch(proposeRequest(validAccountCreateBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'op-account-1', existing: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_ORIGIN}/pending-operations/v2/propose`);
    const headers = new Headers(calls[0]!.init?.headers);
    const claims = await decodeDelegatedTurnToken(headers.get('authorization')!.slice('Bearer '.length), DELEGATION_SECRET);
    expect(claims.capabilities).toEqual(['financial.approval.propose']);
    expect(claims.request).toBe('int-account-abc123');
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.tool).toBe('accounts.create');
    expect(sent.normalizedArgs).toEqual(validAccountCreateBody().normalizedArgs);
    expect('initialBalanceCents' in sent.normalizedArgs).toBe(true);
  });

  it('accepts categories.create on the same propose-only A4 path', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'op-category-1', existing: false }, { status: 201 }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    const res = await agent.fetch(proposeRequest(validCategoryCreateBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'op-category-1', existing: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_ORIGIN}/pending-operations/v2/propose`);
    const headers = new Headers(calls[0]!.init?.headers);
    const claims = await decodeDelegatedTurnToken(headers.get('authorization')!.slice('Bearer '.length), DELEGATION_SECRET);
    expect(claims.capabilities).toEqual(['financial.approval.propose']);
    expect(claims.request).toBe('int-category-abc123');
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.tool).toBe('categories.create');
    expect(sent.normalizedArgs).toEqual(validCategoryCreateBody().normalizedArgs);
  });

  it('accepts the V1 CRUD and payable proposals on the same propose-only A4 path', async () => {
    const cases = [
      validTransactionUpdateBody(),
      validAccountUpdateBody(),
      validAccountDeactivateBody(),
      validCategoryUpdateBody(),
      validCategoryDeactivateBody(),
      validPayableCreateBody(),
      validPayablePayBody(),
    ];
    for (const body of cases) {
      const { fn, calls } = captureFetch(() => Response.json({ id: `op-${body.tool}`, existing: false }, { status: 201 }));
      globalThis.fetch = fn;
      const { agent } = createTestAgent();
      const res = await agent.fetch(proposeRequest(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: `op-${body.tool}`, existing: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${API_ORIGIN}/pending-operations/v2/propose`);
      const headers = new Headers(calls[0]!.init?.headers);
      const claims = await decodeDelegatedTurnToken(headers.get('authorization')!.slice('Bearer '.length), DELEGATION_SECRET);
      expect(claims.capabilities).toEqual(['financial.approval.propose']);
      const sent = JSON.parse(String(calls[0]!.init?.body));
      expect(sent.tool).toBe(body.tool);
      expect(sent.normalizedArgs).toEqual(body.normalizedArgs);
    }
  });

  it('refuses transactions.update without the exact description CAS tuple', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();
    for (const normalizedArgs of [
      { transactionId: ACCOUNT, description: 'Novo' },
      { transactionId: ACCOUNT, description: 'Novo', expectedDescription: '  ' },
      { transactionId: ACCOUNT, description: 'Novo', expectedDescription: 'Velho', amountCents: 100 },
      { transactionId: ACCOUNT, description: 'Novo', expectedDescription: 'Velho', date: '2026-11-10' },
    ]) {
      const res = await agent.fetch(proposeRequest(validTransactionUpdateBody({ normalizedArgs })));
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses invalid P4.2 payloads (unknown kind / non-integer balance / bad parent) before any transport', async () => {
    for (const body of [
      validAccountCreateBody({ normalizedArgs: { name: 'X', kind: 'credit_card', initialBalanceCents: 0 } }),
      validAccountCreateBody({ normalizedArgs: { name: 'X', kind: 'bank', initialBalanceCents: 1.5 } }),
      validAccountCreateBody({ normalizedArgs: { name: '', kind: 'bank', initialBalanceCents: 0 } }),
      validCategoryCreateBody({ normalizedArgs: { name: 'X', kind: 'transfer' } }),
      validCategoryCreateBody({ normalizedArgs: { name: 'X', kind: 'expense', parentId: 'nope' } }),
    ]) {
      const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
      globalThis.fetch = fn;
      const { agent } = createTestAgent();
      const res = await agent.fetch(proposeRequest(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'agent.invalid_payload' });
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses an undefined statement amount or unknown args before any transport', async () => {
    for (const normalizedArgs of [
      { ...validStatementBody().normalizedArgs, amountCents: 'total' },
      { ...validStatementBody().normalizedArgs, description: 'fatura' },
      { ...validStatementBody().normalizedArgs, amountCents: 0 },
    ]) {
      const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
      globalThis.fetch = fn;
      const { agent } = createTestAgent();
      const res = await agent.fetch(proposeRequest(validStatementBody({ normalizedArgs })));
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses an invalid installmentsTotal before any transport', async () => {
    for (const installmentsTotal of [0, 49, 1.5]) {
      const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
      globalThis.fetch = fn;
      const { agent } = createTestAgent();
      const res = await agent.fetch(
        proposeRequest(validCardBody({ normalizedArgs: { ...validCardBody().normalizedArgs, installmentsTotal } })),
      );
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses any tool outside the closed proposal contract with zero transport', async () => {
    const { fn, calls } = captureFetch(() => Response.json({ id: 'never' }));
    globalThis.fetch = fn;
    const { agent } = createTestAgent();

    for (const tool of ['transactions.unknown.create', 'evil']) {
      const res = await agent.fetch(proposeRequest(validBody({ tool })));
      expect(res.status).toBe(400);
    }
    // A valid tool carrying another tool's payload is refused as well.
    expect((await agent.fetch(proposeRequest(validTransferBody({ tool: 'transactions.expense.create' })))).status).toBe(400);
    // A transactions.update payload cannot smuggle amount/date/account/category.
    expect((await agent.fetch(proposeRequest(validBody({ tool: 'transactions.update' })))).status).toBe(400);
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
