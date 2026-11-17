import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createBetterAuth } from '../../src/auth/better-auth.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import type { WorkspaceStore } from '../../src/auth/workspaces-store.js';
import { ACCOUNT_A1, CATEGORY_FOOD_A, HOUSEHOLD_A } from '../fixtures/seed.js';
import { buildTestApp } from '../test-app.js';
import { resolveGatewayIdentity } from '../../../ted-runtime/src/gateway.mjs';
import { createGatewayServer } from '../../../ted-runtime/src/server.mjs';
import { createConversationStore } from '../../../ted-runtime/src/conversations.mjs';
import { createPendingClient } from '../../../ted-runtime/src/pending-client.mjs';

const WS = HOUSEHOLD_A;
const OTHER_WS = '00000000-0000-4000-8000-00000000000b';
const EMPTY_WS = '00000000-0000-4000-8000-00000000000c';
const ACTOR_A = '11111111-1111-4111-8111-111111111111';
const ACTOR_B = '11111111-1111-4111-8111-111111111112';
const ACTOR_C = '11111111-1111-4111-8111-111111111113';
const AUTH_SECRET = 'pending-lifecycle-auth-secret-32-characters';
const DELEGATION_SECRET = 'pending-lifecycle-delegation-secret-32';
const MINT_TOKEN = 'pending-lifecycle-mint-service-token-32';
const DEPOSIT_TOKEN = 'pending-lifecycle-deposit-service-token-32';
const ATTESTATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const memberships = new Map<string, string>();
const registeredDevices = new Map<string, { workspace: string; actor: string }>();
const actorDevice = new Map<string, { token: string; deviceId: string }>();
const internalActors = new Map<string, string>();
const workspaceAccess = {
  resolve: async (actorId: string, householdId: string) => {
    const internalId = internalActors.get(actorId) ?? actorId;
    if (memberships.get(internalId) !== householdId) return undefined;
    return { userId: internalId, householdId, role: 'owner' as const, kind: 'shared' as const };
  },
};

const auth = createBetterAuth({
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  disableSignUp: false,
  transaction: false,
  secret: AUTH_SECRET,
  baseURL: 'http://localhost:3001',
  trustedOrigins: ['http://localhost:3000'],
});

const pool = {
  async query(text: string, values: unknown[] = []) {
    if (text.includes('SELECT id FROM households')) {
      const found = [WS, OTHER_WS, EMPTY_WS].includes(String(values[0]));
      return { rows: found ? [{ id: values[0] }] : [], rowCount: found ? 1 : 0 };
    }
    if (text.includes('SELECT household_id FROM invites')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM device_tokens')) {
      const item = registeredDevices.get(String(values[0]));
      const valid = item?.workspace === values[1] && item.actor === values[2];
      return { rows: valid ? [{ device_id: values[0] }] : [], rowCount: valid ? 1 : 0 };
    }
    throw new Error(`Unexpected synthetic pool query: ${text}`);
  },
};
const workspaceStore = {
  list: async () => [],
  create: async () => { throw new Error('not used'); },
  rename: async () => { throw new Error('not used'); },
  setStatus: async () => { throw new Error('not used'); },
  listMembers: async () => [],
  removeMember: async () => {},
  leave: async () => {},
  deletionInventory: async () => { throw new Error('not used'); },
  depositEmptyAttestation: async () => ({ attestationId: ATTESTATION_ID }),
  deleteEmpty: async () => { throw new Error('not used'); },
} as unknown as WorkspaceStore;

const syntheticTokenStore = {
  async resolve(token?: string) {
    for (const [actor, entry] of actorDevice) {
      if (entry.token === token) return { deviceId: entry.deviceId, householdId: memberships.get(internalActors.get(actor) ?? actor) ?? WS, userId: actor };
    }
    throw Object.assign(new Error('invalid synthetic device token'), { statusCode: 401, code: 'auth.invalid_token' });
  },
  async register() { throw new Error('registration not used by this integration'); },
  async revoke() {},
  async revokeAllForUserWorkspace() { return 0; },
  async rotate() { throw new Error('rotation not used by this integration'); },
};

const pendingStore = createInMemoryPendingOperationV2Store();
const built = buildTestApp(
  { accounts: [ACCOUNT_A1], categories: [CATEGORY_FOOD_A] },
  pendingStore,
  auth,
  workspaceAccess,
  false,
  DELEGATION_SECRET,
  syntheticTokenStore,
  workspaceStore,
  {
    pendingMintServiceToken: MINT_TOKEN,
    agentAuthServiceToken: DEPOSIT_TOKEN,
    pool,
  },
);

let apiBase = '';
let gatewayBase = '';
let cookieA = '';
let cookieB = '';
let cookieC = '';
let userA = '';
let userB = '';
let userC = '';
let deviceA = '';
let deviceB = '';
let deviceC = '';
let persistDir = '';
let gatewayStore: ReturnType<typeof createConversationStore>;
let gateway: ReturnType<typeof createGatewayServer>;
const categoryMemoryStore = { countByWorkspace: () => 0 };

const firstCookie = (header: string | null) => String(header ?? '').split(';')[0]!.split(',')[0]!.trim();
const authHeaders = (cookie: string, deviceToken: string) => ({
  cookie,
  'x-device-token': deviceToken,
  'content-type': 'application/json',
});
const expectNoSecretLeak = (value: unknown, proposalHash?: string) => {
  const serialized = JSON.stringify(value);
  for (const secret of [MINT_TOKEN, DEPOSIT_TOKEN, DELEGATION_SECRET, 'synthetic-hmac-secret-with-sufficient-length', proposalHash].filter(Boolean) as string[]) {
    expect(serialized).not.toContain(secret);
  }
};
const rpc = (route: string) => `${gatewayBase}/agents/finance-chat-agent/${encodeURIComponent(WS)}/rpc/${route}`;
const rpcAt = (workspaceId: string, route: string) => `${gatewayBase}/agents/finance-chat-agent/${encodeURIComponent(workspaceId)}/rpc/${route}`;
const propose = async (cookie: string, deviceToken: string, intentionId = randomUUID(), description = 'Almoço sintético', amountCents = 1250) =>
  fetch(rpc('pending-operations/propose'), {
    method: 'POST',
    headers: authHeaders(cookie, deviceToken),
    body: JSON.stringify({
      tool: 'transactions.expense.create',
      intentionId,
      normalizedArgs: {
        description, amountCents, date: '2026-11-17',
        accountId: ACCOUNT_A1.id, categoryId: CATEGORY_FOOD_A.id,
      },
    }),
  });
const active = (cookie: string, deviceToken: string) =>
  fetch(rpc('pending-operations/active'), { headers: authHeaders(cookie, deviceToken) });
const decision = (id: string, cookie: string, deviceToken: string, requestId = randomUUID(), action: 'confirm' | 'cancel' = 'confirm') =>
  fetch(rpc(`pending-operations/${encodeURIComponent(id)}/decision`), {
    method: 'POST', headers: authHeaders(cookie, deviceToken),
    body: JSON.stringify({ decision: action, requestId }),
  });
const mint = async (actorId: string, deviceId: string, requestId = randomUUID()) => {
  const response = await fetch(`${apiBase}/auth/agent/pending-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-pending-service-token': MINT_TOKEN },
    body: JSON.stringify({ workspaceId: WS, actorId, deviceId, requestId }),
  });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return (await response.json() as { token: string }).token;
};
const directApi = async (token: string, route: string, method = 'GET', body?: unknown, key?: string, actorId = ACTOR_A, workspaceId = WS) =>
  fetch(`${apiBase}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
      'x-actor-id': actorId,
      'x-device-id': actorId === ACTOR_C ? deviceC : actorId === ACTOR_B ? deviceB : deviceA,
      ...(key ? { 'Idempotency-Key': key } : {}),
      'content-type': 'application/json',
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });

beforeAll(async () => {
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  apiBase = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const signup = async (email: string) => {
    const response = await auth.api.signUpEmail({
      body: { email, password: 'synthetic-password-123', name: 'Synthetic user' },
      headers: new Headers({ origin: 'http://localhost:3000' }),
      asResponse: true,
    });
    expect(response.status).toBe(200);
    return firstCookie(response.headers.get('set-cookie'));
  };
  cookieA = await signup('pending-a@example.test');
  cookieB = await signup('pending-b@example.test');
  cookieC = await signup('pending-c@example.test');
  userA = String((await auth.api.getSession({ headers: new Headers({ cookie: cookieA }) }))?.user.id ?? '');
  userB = String((await auth.api.getSession({ headers: new Headers({ cookie: cookieB }) }))?.user.id ?? '');
  userC = String((await auth.api.getSession({ headers: new Headers({ cookie: cookieC }) }))?.user.id ?? '');
  internalActors.set(userA, ACTOR_A);
  internalActors.set(userB, ACTOR_B);
  internalActors.set(userC, ACTOR_C);
  memberships.set(ACTOR_A, WS);
  memberships.set(ACTOR_B, OTHER_WS);
  memberships.set(ACTOR_C, EMPTY_WS);
  const a = { deviceId: randomUUID(), token: `synthetic-device-a-${randomUUID()}` };
  const b = { deviceId: randomUUID(), token: `synthetic-device-b-${randomUUID()}` };
  const c = { deviceId: randomUUID(), token: `synthetic-device-c-${randomUUID()}` };
  deviceA = a.deviceId;
  deviceB = b.deviceId;
  deviceC = c.deviceId;
  actorDevice.set(userA, a);
  actorDevice.set(userB, b);
  actorDevice.set(userC, c);
  registeredDevices.set(deviceA, { workspace: WS, actor: ACTOR_A });
  registeredDevices.set(deviceB, { workspace: OTHER_WS, actor: ACTOR_B });
  registeredDevices.set(deviceC, { workspace: EMPTY_WS, actor: ACTOR_C });
  // resolveGatewayIdentity validates the registered API device output; the
  // gateway carries the opaque device token, not the device id.
  (globalThis as typeof globalThis & { __pendingDeviceTokens?: Map<string, string> }).__pendingDeviceTokens =
    new Map([[deviceA, a.token], [deviceB, b.token], [deviceC, c.token]]);
  persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ted-pending-lifecycle-'));
  gatewayStore = createConversationStore({ persistDir });
  gateway = createGatewayServer({
    resolveIdentity: ({ cookie, deviceToken, workspaceId, signal }: { cookie: string; deviceToken: string; workspaceId: string; signal?: AbortSignal }) =>
      resolveGatewayIdentity({ apiBaseUrl: apiBase, cookie, deviceToken, workspaceId, signal }),
    store: gatewayStore,
    promptHost: { chat: async () => { throw new Error('provider must not be called'); } },
    createRuntimeSession: async () => ({ runtimeSessionId: `unused-${randomUUID()}` }),
    withAuthenticatedSession: async (_id: string, _host: unknown, fn: () => Promise<unknown>) => fn(),
    pendingClient: createPendingClient({
      apiBaseUrl: apiBase,
      pendingMintToken: MINT_TOKEN,
      workspaceDeletionServiceToken: DEPOSIT_TOKEN,
    }),
    workspaceDeletionSecret: 'synthetic-hmac-secret-with-sufficient-length',
    categoryMemoryStoreOverride: categoryMemoryStore,
    stateDir: persistDir,
  });
  const address = await gateway.listen({ port: 0, host: '127.0.0.1' });
  gatewayBase = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  await gateway?.close().catch(() => {});
  await built.app.close().catch(() => {});
  await auth.close().catch(() => {});
  if (persistDir) fs.rmSync(persistDir, { recursive: true, force: true });
});

const tokenForA = () => {
  const token = (globalThis as typeof globalThis & { __pendingDeviceTokens?: Map<string, string> }).__pendingDeviceTokens?.get(deviceA);
  if (!token) throw new Error('test device token missing');
  return token;
};
const tokenForC = () => (globalThis as typeof globalThis & { __pendingDeviceTokens?: Map<string, string> }).__pendingDeviceTokens?.get(deviceC) ?? '';

describe('TED runtime Pending V2 lifecycle (synthetic loopback)', () => {
  it('proposes through gateway and returns a bounded active projection with presentation', async () => {
    await mint(ACTOR_A, deviceA);
    const response = await propose(cookieA, tokenForA());
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const result = await response.json() as { id: string; existing: boolean };
    expectNoSecretLeak(result);
    expect(result).toMatchObject({ existing: false });
    const listing = await active(cookieA, tokenForA());
    expect(listing.status).toBe(200);
    const body = await listing.json() as { items: Array<Record<string, unknown>> };
    expectNoSecretLeak(body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: result.id, presentation: expect.any(Object) });
    expect(Object.keys(body.items[0]!).every((key) =>
      ['id','status','tool','createdAt','expiresAt','amountCents','description','date','accountId','categoryId','statementId','fromAccountId','supersedes','failureCode','presentation'].includes(key),
    )).toBe(true);
    const cancelled = await decision(result.id, cookieA, tokenForA(), randomUUID(), 'cancel');
    expect(cancelled.status).toBe(200);
  });

  it('rejects a non-UUID actor at the pending-token mint boundary', async () => {
    const response = await fetch(`${apiBase}/auth/agent/pending-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-pending-service-token': MINT_TOKEN },
      body: JSON.stringify({ workspaceId: WS, actorId: userA, deviceId: deviceA, requestId: randomUUID() }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expectNoSecretLeak(body);
    expect(body).toEqual({ code: 'validation.error' });
  });

  it('supersedes with corrected args and exposes only the replacement as active', async () => {
    const created = await propose(cookieA, tokenForA(), randomUUID(), 'Valor inicial', 1250);
    expect(created.status).toBe(200);
    const { id } = await created.json() as { id: string };
    const delegated = await mint(ACTOR_A, deviceA);
    const original = await directApi(delegated, `/pending-operations/v2/${encodeURIComponent(id)}`);
    expect(original.status).toBe(200);
    const record = await original.json() as { proposalHash: string };
    const previousFlag = process.env.PENDING_V2_SUPERSEDE_ENABLED;
    process.env.PENDING_V2_SUPERSEDE_ENABLED = '1';
    try {
      const replacement = await directApi(
        delegated,
        `/pending-operations/v2/${encodeURIComponent(id)}/supersede`,
        'POST',
        {
          tool: 'transactions.expense.create',
          normalizedArgs: {
            description: 'Valor corrigido', amountCents: 3450, date: '2026-11-17',
            accountId: ACCOUNT_A1.id, categoryId: CATEGORY_FOOD_A.id,
          },
          expectedProposalHash: record.proposalHash,
        },
        randomUUID(),
      );
      expect(replacement.status).toBe(201);
      const replacementBody = await replacement.json() as { id: string; supersedes: string };
      expect(replacementBody.supersedes).toBe(id);
      const listing = await active(cookieA, tokenForA());
      const activeBody = await listing.json() as { items: Array<Record<string, unknown>> };
      expectNoSecretLeak(activeBody, record.proposalHash);
      expect(activeBody.items).toHaveLength(1);
      expect(activeBody.items[0]).toMatchObject({
        id: replacementBody.id, description: 'Valor corrigido', amountCents: 3450, supersedes: id,
      });
      const cancelled = await decision(replacementBody.id, cookieA, tokenForA(), randomUUID(), 'cancel');
      expect(cancelled.status).toBe(200);
    } finally {
      if (previousFlag === undefined) delete process.env.PENDING_V2_SUPERSEDE_ENABLED;
      else process.env.PENDING_V2_SUPERSEDE_ENABLED = previousFlag;
    }
  });

  it('executes confirm exactly once and replays the canonical succeeded receipt', async () => {
    const create = await propose(cookieA, tokenForA(), randomUUID(), 'Compra única', 2345);
    const { id } = await create.json() as { id: string };
    const first = await decision(id, cookieA, tokenForA(), 'confirm-once');
    expect(first.status).toBe(200);
    const outcome = await first.json() as { status: string; receipt: Record<string, unknown> };
    expectNoSecretLeak(outcome);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.receipt).toMatchObject({ mutationKind: 'transactions.expense.create', status: 'succeeded' });
    expect(built.state.transactions).toHaveLength(1);
    expect(built.state.transactions[0]).toMatchObject({ description: 'Compra única', amountCents: 2345 });
    const replay = await decision(id, cookieA, tokenForA(), 'confirm-replay');
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expectNoSecretLeak(replayBody);
    expect(replayBody).toEqual(outcome);
    expect(built.state.transactions).toHaveLength(1);
  });

  it('cancels a separate proposal without writing a transaction', async () => {
    const creation = await propose(cookieA, tokenForA(), randomUUID(), 'Não registrar');
    const { id } = await creation.json() as { id: string };
    const response = await decision(id, cookieA, tokenForA(), randomUUID(), 'cancel');
    expect(response.status).toBe(200);
    const body = await response.json();
    expectNoSecretLeak(body);
    expect(body).toMatchObject({ operationId: id, status: 'cancelled' });
    expect(built.state.transactions).toHaveLength(1);
  });

  it('denies a different workspace actor and device without changing financial state', async () => {
    const creation = await propose(cookieA, tokenForA(), randomUUID(), 'Isolamento');
    const { id } = await creation.json() as { id: string };
    const before = built.state.transactions.length;
    const response = await decision(id, cookieB, (globalThis as typeof globalThis & { __pendingDeviceTokens?: Map<string, string> }).__pendingDeviceTokens!.get(deviceB)!);
    expect(response.status).toBe(403);
    expectNoSecretLeak(await response.clone().json());
    expect(built.state.transactions).toHaveLength(before);
  });

  it('attests nonempty workspace as conflict and deposits an empty workspace attestation', async () => {
    gatewayStore.create({ workspace: WS, ownerActor: ACTOR_A, deviceId: deviceA, visibility: 'workspace' });
    const nonempty = await fetch(rpcAt(WS, `workspace/${encodeURIComponent(WS)}/attest-empty`), {
      method: 'POST', headers: authHeaders(cookieA, tokenForA()),
      body: JSON.stringify({ inventoryVersion: 'a'.repeat(64) }),
    });
    expect(nonempty.status).toBe(409);
    const nonemptyBody = await nonempty.json();
    expectNoSecretLeak(nonemptyBody);
    expect(nonemptyBody).toMatchObject({ code: 'agent.workspace_not_empty' });

    const empty = await fetch(rpcAt(EMPTY_WS, `workspace/${encodeURIComponent(EMPTY_WS)}/attest-empty`), {
      method: 'POST', headers: authHeaders(
        cookieC, tokenForC(),
      ),
      body: JSON.stringify({ inventoryVersion: 'b'.repeat(64) }),
    });
    expect(empty.status).toBe(201);
    const emptyBody = await empty.json();
    expectNoSecretLeak(emptyBody);
    expect(emptyBody).toEqual({ attestationId: ATTESTATION_ID });
  });
});
