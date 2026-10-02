import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';
import { createInMemoryPendingOperationV2Store, type PendingIdentity, type PendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { registerPendingOperationRoutes } from '../../src/routes/pending-operations.js';
import type { ReadModelStore } from '../../src/read-models/store.js';

const WS = 'workspace-auto';
const ACTOR = 'actor-auto';
const DEVICE = 'device-auto';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '22222222-2222-4222-8222-222222222222';
const AUTO = 'financial.approval.autoexecute';
const CONFIRM = 'financial.approval.confirm';
const EXECUTE = 'financial.approval.execute';
const PROPOSE = 'financial.approval.propose';
const legacyStore = { async get() { return null; }, async list() { return []; }, async findByChatId() { return null; }, async create() { throw new Error('unused'); }, async approve() { throw new Error('unused'); }, async reject() { throw new Error('unused'); } };
const readModel = {
  listAccounts: async () => [{ id: ACCOUNT, name: 'Conta teste' }],
  listCategories: async () => [{ id: CATEGORY, name: 'Categoria teste' }],
} as unknown as Pick<ReadModelStore, 'listAccounts' | 'listCategories'>;

const setup = (capabilities: string[] = [PROPOSE, AUTO, CONFIRM, EXECUTE], currentWorkspace = WS) => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.delegatedTurn = { iss: 'pi-agent', aud: 'pi-finance-api', sub: ACTOR, workspace: currentWorkspace, role: 'owner', capabilities, jti: randomUUID(), request: 'route-test', deviceId: DEVICE, iat: 1, exp: 301 };
    request.authenticatedContext = { householdId: currentWorkspace, actorId: ACTOR, authUserId: ACTOR, actorType: 'user', deviceId: DEVICE, role: 'owner' };
  });
  const v2Store = createInMemoryPendingOperationV2Store();
  let effects = 0;
  registerPendingOperationRoutes(app, {
    store: legacyStore as never,
    resolveToken: async () => ({ householdId: currentWorkspace, deviceId: DEVICE }),
    v2Store,
    v2Only: true,
    readModel,
    v2Executor: async (operation) => { effects += 1; return { status: 'succeeded', operationId: `financial-effect-${operation.id}` }; },
  });
  return { app, v2Store, get effects() { return effects; } };
};

const identity = (workspaceId = WS): PendingIdentity => ({ workspaceId, actorId: ACTOR, deviceId: DEVICE });
const createProposal = async (store: PendingOperationV2Store, amountCents: number, workspaceId = WS, key = randomUUID()) => {
  const bound = identity(workspaceId);
  const base = { version: 2 as const, ...bound, tool: 'transactions.expense.create', normalizedArgs: { description: 'Test purchase', amountCents, date: '2026-10-02', accountId: ACCOUNT, categoryId: CATEGORY }, proposalHash: '', idempotencyKey: key, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), bindings: bound };
  return store.propose({ ...base, proposalHash: await computePendingOperationV2Hash(base) });
};
const post = (app: ReturnType<typeof setup>['app'], id: string, action: string, payload?: unknown) => app.inject({ method: 'POST', url: `/pending-operations/v2/${id}/${action}`, ...(payload !== undefined ? { payload } : {}) });
afterEach(() => { delete process.env.TED_RISK_BASED_AUTOEXECUTE; vi.restoreAllMocks(); });

describe('POST /pending-operations/v2/:id/authorize', () => {
  it.each([['unset', undefined], ['off', 'off']] as const)('fails closed when flag is %s', async (_label, flag) => {
    if (flag === undefined) delete process.env.TED_RISK_BASED_AUTOEXECUTE; else process.env.TED_RISK_BASED_AUTOEXECUTE = flag;
    const { app, v2Store } = setup(); const saved = await createProposal(v2Store, 3499);
    const response = await post(app, saved.id, 'authorize');
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ code: 'approval.autoexecute_disabled' });
    expect(await v2Store.get(saved.id, identity())).toMatchObject({ status: 'proposed' }); expect(response.json()).not.toHaveProperty('attestation');
  });

  it('shadow records sanitized would-autoexecute evidence without mutating the operation', async () => {
    process.env.TED_RISK_BASED_AUTOEXECUTE = 'shadow';
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { app, v2Store } = setup(); const saved = await createProposal(v2Store, 3499);
    const response = await post(app, saved.id, 'authorize');
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ code: 'approval.autoexecute_disabled' });
    expect(await v2Store.get(saved.id, identity())).toMatchObject({ status: 'proposed' });
    expect(await v2Store.get(saved.id, identity())).not.toHaveProperty('authorizationMode');
    expect(log.mock.calls.flat().join(' ')).toContain('mutation.authorization.evaluated');
  });

  it('auto-authorizes, executes once, persists metadata and rejects attestation replay', async () => {
    process.env.TED_RISK_BASED_AUTOEXECUTE = 'on';
    const harness = setup(); const { app, v2Store } = harness; const saved = await createProposal(v2Store, 3499);
    const authorized = await post(app, saved.id, 'authorize');
    expect(authorized.statusCode).toBe(200); expect(authorized.json().attestation).toEqual(expect.any(String));
    expect(Object.keys(authorized.json()).filter((key) => key === 'attestation' || /token|secret/i.test(key))).toEqual(['attestation']);
    expect(await v2Store.get(saved.id, identity())).not.toHaveProperty('attestation');
    const token = authorized.json().attestation as string;
    const execution = await post(app, saved.id, 'execute', { attestation: token });
    expect(execution.statusCode).toBe(200); expect(execution.json().status).toBe('succeeded'); expect(harness.effects).toBe(1);
    const record = await v2Store.get(saved.id, identity());
    expect(record).toMatchObject({ status: 'succeeded', authorizationMode: 'auto', authorizationReason: 'explicit_low_risk', riskTier: 'low' }); expect(record.authorizedAt).toBeTruthy();
    const replay = await post(app, saved.id, 'execute', { attestation: token });
    expect(replay.statusCode).toBe(403); expect(replay.json().code).toBe('approval.attestation_replayed'); expect(harness.effects).toBe(1);
  });

  it('blocks high-value mutations without leaking an attestation', async () => {
    process.env.TED_RISK_BASED_AUTOEXECUTE = 'on';
    const { app, v2Store } = setup(); const saved = await createProposal(v2Store, 50000);
    const response = await post(app, saved.id, 'authorize');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'approval.autoexecute_not_eligible', details: { decision: { action: 'require_confirmation', risk: 'high', reason: 'high_value' } } });
    expect(JSON.stringify(response.json())).not.toContain('attestation');
    expect(await v2Store.get(saved.id, identity())).toMatchObject({ status: 'proposed' });
    expect(await v2Store.get(saved.id, identity())).not.toHaveProperty('authorizationMode');
  });

  it('requires the narrow capability and hides foreign-workspace ids', async () => {
    process.env.TED_RISK_BASED_AUTOEXECUTE = 'on';
    const noCapability = setup([CONFIRM]); const saved = await createProposal(noCapability.v2Store, 3499);
    const forbidden = await post(noCapability.app, saved.id, 'authorize');
    expect(forbidden.statusCode).toBe(403); expect(forbidden.json().code).toBe('auth.delegation_scope_forbidden');
    const foreignHarness = setup();
    const foreign = await createProposal(foreignHarness.v2Store, 3499, 'other-workspace');
    const hidden = await post(foreignHarness.app, foreign.id, 'authorize');
    expect(hidden.statusCode).toBe(403); expect(hidden.json().code).toBe('approval.forbidden');
  });

  it('rejects a non-empty body without changing the proposed operation', async () => {
    process.env.TED_RISK_BASED_AUTOEXECUTE = 'on';
    const { app, v2Store } = setup(); const saved = await createProposal(v2Store, 3499);
    const response = await post(app, saved.id, 'authorize', { mode: 'auto' });
    expect(response.statusCode).toBe(400); expect(response.json().code).toBe('validation.error');
    expect(response.json()).not.toHaveProperty('attestation');
    expect(await v2Store.get(saved.id, identity())).toMatchObject({ status: 'proposed' });
    expect(await v2Store.get(saved.id, identity())).not.toHaveProperty('authorizationMode');
  });

  it.each([
    ['confirmed', 'not_pending'], ['executing', 'not_pending'], ['succeeded', 'not_pending'],
    ['cancelled', 'not_pending'], ['failed', 'not_pending'], ['expired', 'expired'],
  ] as const)('returns authoritative error for %s status without attestation or metadata changes', async (status, errorCode) => {
    process.env.TED_RISK_BASED_AUTOEXECUTE = 'on';
    const harness = setup(); const { app, v2Store } = harness; const saved = await createProposal(v2Store, 3499);
    let finishExecution: ((result: { status: string; operationId: string }) => void) | undefined;
    let inFlight: Promise<unknown> | undefined;
    if (status === 'confirmed' || status === 'executing' || status === 'succeeded' || status === 'failed') {
      const confirmed = await v2Store.confirm(saved.id, identity());
      if (status === 'executing') {
        inFlight = v2Store.execute(confirmed.attestation!, identity(), () => new Promise((resolve) => { finishExecution = resolve; }), saved.id);
        for (let attempt = 0; attempt < 100 && (await v2Store.get(saved.id, identity())).status !== 'executing'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
        expect((await v2Store.get(saved.id, identity())).status).toBe('executing');
      } else if (status === 'succeeded') {
        await v2Store.execute(confirmed.attestation!, identity(), async () => ({ status: 'succeeded', operationId: randomUUID() }), saved.id);
      } else if (status === 'failed') {
        await expect(v2Store.execute(confirmed.attestation!, identity(), async () => { throw new Error('expected failure'); }, saved.id)).rejects.toThrow('expected failure');
      }
    } else if (status === 'cancelled') {
      await v2Store.cancel(saved.id, identity());
    }
    const before = await v2Store.get(saved.id, identity());
    if (status === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(saved.expiresAt) + 1);
    const response = await post(app, saved.id, 'authorize');
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe(status === 'expired' ? 'approval.expired' : 'approval.not_pending');
    expect(response.json()).not.toHaveProperty('attestation');
    const after = await v2Store.get(saved.id, identity());
    expect(after.status).toBe(status);
    expect({ authorizationMode: after.authorizationMode, authorizationReason: after.authorizationReason, riskTier: after.riskTier, authorizedAt: after.authorizedAt }).toEqual({ authorizationMode: before.authorizationMode, authorizationReason: before.authorizationReason, riskTier: before.riskTier, authorizedAt: before.authorizedAt });
    if (status === 'executing') finishExecution?.({ status: 'succeeded', operationId: randomUUID() });
    await inFlight;
  });

  it('persists high-value manual confirmation and rejects a client auto mode', async () => {
    const { app, v2Store } = setup(); const saved = await createProposal(v2Store, 50000);
    const confirmed = await post(app, saved.id, 'confirm');
    expect(confirmed.statusCode).toBe(200);
    expect(await v2Store.get(saved.id, identity())).toMatchObject({ authorizationMode: 'manual', authorizationReason: 'high_value', riskTier: 'high' });
    expect((await v2Store.get(saved.id, identity())).authorizedAt).toBeTruthy();
    const forced = await post(app, saved.id, 'confirm', { mode: 'auto' });
    expect(forced.statusCode).toBe(400); expect(forced.json().code).toBe('validation.error');
  });
});
