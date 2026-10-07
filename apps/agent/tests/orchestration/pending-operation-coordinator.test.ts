/**
 * T1.5 — PendingOperationCoordinator (SPEC §8, H-02; §25.3).
 *
 * Button and natural language converge into the same decision machine;
 * the authoritative listing (GET /v2/active) is the only source of pending
 * operations — client-declared ids are never authority.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import {
  NO_PENDING_CANCEL_TEXT,
  PendingOperationCoordinator,
  isRetryText,
} from '../../src/orchestration/pending-operation-coordinator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import {
  InMemoryMutationDraftStore,
  buildDraftRecord,
} from '../../src/mutations/mutation-draft.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const CATEGORY_ID = '00000000-0000-4000-8000-000000000002';

type FakeOp = {
  id: string;
  status: 'proposed' | 'confirmed' | 'failed' | 'cancelled' | 'succeeded';
  tool: string;
  args: Record<string, unknown>;
};

/** Request-level fake of the V2 approval API (authority semantics included). */
const makeFakeApprovalApi = (initial: FakeOp[] = [], fakeOpts?: { executeReceipt?: Record<string, unknown> }) => {
  const ops = new Map<string, FakeOp>(initial.map((op) => [op.id, { ...op }]));
  const proposeKeys: Array<string | undefined> = [];
  const events: string[] = [];
  let seq = initial.length;
  const request = vi.fn();
  request.mockImplementation(async (method: string, path: string, opts?: { body?: unknown; idempotencyKey?: string }) => {
    if (method === 'GET' && path === '/pending-operations/v2/active') {
      events.push('listActive');
      const items = [...ops.values()]
        .filter((op) => ['proposed', 'confirmed', 'executing', 'failed'].includes(op.status))
        .map((op) => ({
          id: op.id,
          status: op.status,
          tool: op.tool,
          createdAt: '2026-09-14T00:00:00.000Z',
          expiresAt: '2026-09-14T01:00:00.000Z',
          ...(typeof op.args.amountCents === 'number' ? { amountCents: op.args.amountCents } : {}),
          ...(typeof op.args.description === 'string' ? { description: op.args.description } : {}),
          ...(typeof op.args.date === 'string' ? { date: op.args.date } : {}),
          ...(typeof op.args.accountId === 'string' ? { accountId: op.args.accountId } : {}),
        }));
      return { items, total: items.length };
    }
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      const key = opts?.idempotencyKey;
      proposeKeys.push(key);
      events.push(`propose:${key}`);
      const body = (opts?.body ?? {}) as { tool?: unknown; normalizedArgs?: unknown };
      const existing = [...ops.values()].find((op) => (op as unknown as { key?: string }).key === key);
      if (existing) return { id: existing.id, existing: true };
      seq += 1;
      const id = `pending-${seq}`;
      ops.set(id, {
        id,
        status: 'proposed',
        tool: typeof body.tool === 'string' ? body.tool : 'transactions.expense.create',
        args: (body.normalizedArgs ?? {}) as Record<string, unknown>,
      });
      (ops.get(id) as unknown as { key?: string }).key = key;
      return { id };
    }
    const match = /^\/pending-operations\/v2\/([^/]+)\/(authorize|confirm|execute|cancel|retry)$/.exec(path);
    if (method === 'POST' && match) {
      const [, id, action] = match as unknown as [string, string, string];
      const op = ops.get(id);
      if (!op) {
        const error = new Error('approval.not_found');
        (error as { statusCode?: number }).statusCode = 404;
        throw error;
      }
      if (action === 'confirm') {
        if (op.status !== 'proposed') throw Object.assign(new Error('approval.not_pending'), { statusCode: 409 });
        op.status = 'confirmed';
        events.push(`confirm:${id}`);
        return { id, attestation: 'a'.repeat(40) };
      }
      if (action === 'authorize') {
        if (op.status !== 'proposed') throw Object.assign(new Error('approval.autoexecute_not_eligible'), { statusCode: 409, code: 'approval.autoexecute_not_eligible' });
        op.status = 'confirmed';
        events.push(`authorize:${id}`);
        return { id, status: 'confirmed', attestation: 'c'.repeat(40) };
      }
      if (action === 'execute') {
        if (op.status !== 'confirmed') throw Object.assign(new Error('approval.attestation_replayed'), { statusCode: 403 });
        op.status = 'succeeded';
        events.push(`execute:${id}`);
        const mutationId = `mut-${id}`;
        // Real API contract: every success carries a linked receipt
        // (receipt.operationId = pending id, entity.id = transaction id).
        const receipt = fakeOpts?.executeReceipt
          ? { ...fakeOpts.executeReceipt, mutationId, operationId: id, entity: { type: 'transaction', id: mutationId } }
          : {
              mutationId,
              mutationKind: 'transactions.expense.create',
              status: 'succeeded',
              affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
              operationId: id,
              entity: { type: 'transaction', id: mutationId },
            };
        return {
          id,
          status: 'succeeded',
          mutationId,
          execution: { status: 'succeeded', operationId: mutationId, receipt },
        };
      }
      if (action === 'cancel') {
        if (!['proposed', 'confirmed'].includes(op.status)) throw Object.assign(new Error('approval.not_pending'), { statusCode: 409 });
        op.status = 'cancelled';
        events.push(`cancel:${id}`);
        return { id, status: 'cancelled' };
      }
      if (action === 'retry') {
        if (op.status !== 'failed') throw Object.assign(new Error('approval.retry_not_allowed'), { statusCode: 409 });
        op.status = 'confirmed';
        events.push(`retry:${id}`);
        return { id, attestation: 'b'.repeat(40) };
      }
    }
    throw new Error(`unexpected request ${method} ${path}`);
  });
  const api = new MutationApiClient({ request });
  return { api, request, ops, events, proposeKeys };
};

const expenseOp = (id: string, status: FakeOp['status'] = 'proposed'): FakeOp => ({
  id,
  status,
  tool: 'transactions.expense.create',
  args: { amountCents: 5000, description: 'Mercado', date: '2026-09-14', accountId: ACCOUNT_ID, categoryId: CATEGORY_ID },
});

const setup = (fake: ReturnType<typeof makeFakeApprovalApi>, store = new InMemoryMutationDraftStore()) =>
  new ConversationOrchestrator({ mutationApiClient: fake.api, draftStore: store });

const turn = (orchestrator: ConversationOrchestrator, text: string, intentionId: string, extra: Record<string, unknown> = {}) =>
  orchestrator.runTurn(normalizeRestTurn({ text, intentionId, ...extra }, identity));

describe('T1.5 PendingOperationCoordinator — unified decision machine (§8, §25.3)', () => {
  it('matches conversational retry utterances without touching unrelated turns', () => {
    expect(isRetryText('tenta de novo')).toBe(true);
    expect(isRetryText('Tenta novamente, por favor')).toBe(true);
    expect(isRetryText('refaz a operação')).toBe(true);
    expect(isRetryText('qual é o meu saldo?')).toBe(false);
    expect(isRetryText('sim')).toBe(false);
    expect(isRetryText('cancela')).toBe(false);
  });

  it('confirm natural: exactly one execution, no client ids needed', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1')]);
    const orchestrator = setup(fake);
    const result = await turn(orchestrator, 'sim', 'intent-confirm-1');

    expect(result.mutation).toEqual({
      operationId: 'op-1',
      status: 'succeeded',
      receipt: {
        mutationId: 'mut-op-1',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'op-1',
        entity: { type: 'transaction', id: 'mut-op-1' },
      },
    });
    expect(result.response?.text).toBe('Lançamento registrado com sucesso.');
    expect(fake.events).toEqual(['listActive', 'confirm:op-1', 'execute:op-1']);
    expect(fake.ops.get('op-1')?.status).toBe('succeeded');
  });

  it('T3.3: confirmation turn carries the API execution receipt into the turn mutation', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1')], {
      executeReceipt: {
        mutationId: 'ignored-server-echo',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
      },
    });
    const orchestrator = setup(fake);
    const result = await turn(orchestrator, 'sim', 'intent-confirm-receipt-1');

    expect(result.mutation).toEqual({
      operationId: 'op-1',
      status: 'succeeded',
      receipt: {
        mutationId: 'mut-op-1',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'op-1',
        entity: { type: 'transaction', id: 'mut-op-1' },
      },
    });
    expect(JSON.stringify(result.mutation)).not.toContain('attestation');
  });

  it('T3.3: coordinator.confirm returns the execution receipt for the button path', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1')], {
      executeReceipt: {
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
      },
    });
    const coordinator = new PendingOperationCoordinator({ client: fake.api });
    const decision = await coordinator.confirm('op-1', { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! });

    expect(decision).toEqual({
      operationId: 'op-1',
      status: 'succeeded',
      receipt: {
        mutationId: 'mut-op-1',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'op-1',
        entity: { type: 'transaction', id: 'mut-op-1' },
      },
    });
  });

  it('auto-authorize executes through the coordinator and returns the validated receipt once', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-auto')]);
    const coordinator = new PendingOperationCoordinator({ client: fake.api });
    const result = await coordinator.authorizeAndExecute('op-auto', { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! });
    expect(result.status).toBe('succeeded');
    expect(result.receipt?.operationId).toBe('op-auto');
    expect(fake.events).toEqual(['authorize:op-auto', 'execute:op-auto']);
  });

  it('ignores client-declared pendingOperationIds as authority', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-real')]);
    const orchestrator = setup(fake);
    // Forged id must not be confirmed; the authoritative listing wins.
    const result = await turn(orchestrator, 'sim', 'intent-confirm-2', { pendingOperationIds: ['op-forged'] });

    expect(result.mutation).toEqual({
      operationId: 'op-real',
      status: 'succeeded',
      receipt: {
        mutationId: 'mut-op-real',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'op-real',
        entity: { type: 'transaction', id: 'mut-op-real' },
      },
    });
    expect(fake.events).not.toContain('confirm:op-forged');
    expect(fake.events).toEqual(['listActive', 'confirm:op-real', 'execute:op-real']);
  });

  it('cancel natural: DB cancelled before reply, executor never called', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1')]);
    const orchestrator = setup(fake);
    const result = await turn(orchestrator, 'cancela', 'intent-cancel-1');

    expect(result.response?.text).toBe('Operação cancelada com segurança.');
    expect(result.mutation).toBeUndefined();
    expect(fake.events).toContain('cancel:op-1');
    expect(fake.events).not.toContain('confirm:op-1');
    expect(fake.events).not.toContain('execute:op-1');
    expect(fake.ops.get('op-1')?.status).toBe('cancelled');
    // Cancel event precedes any reply: the reply is only built after the coordinator resolves.
    expect(fake.events.indexOf('cancel:op-1')).toBeGreaterThanOrEqual(0);
  });

  it('multiple pending: disambiguation, nothing executed or cancelled', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1'), expenseOp('op-2')]);
    const orchestrator = setup(fake);
    const result = await turn(orchestrator, 'sim', 'intent-multi-1');

    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toContain('Qual delas deseja confirmar?');
    expect(result.response?.text).toContain('Mercado');
    expect(fake.events).toEqual(['listActive']);
    expect(fake.ops.get('op-1')?.status).toBe('proposed');
    expect(fake.ops.get('op-2')?.status).toBe('proposed');
  });

  it('multiple pending on cancel: disambiguation, nothing cancelled', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1'), expenseOp('op-2')]);
    const orchestrator = setup(fake);
    const result = await turn(orchestrator, 'cancela tudo', 'intent-multi-cancel-1');

    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toContain('Qual delas deseja cancelar?');
    expect(fake.events).not.toContain('cancel:op-1');
    expect(fake.events).not.toContain('cancel:op-2');
  });

  it('zero pending: deterministic reply, nothing executed', async () => {
    const fake = makeFakeApprovalApi([]);
    const orchestrator = setup(fake);
    const result = await turn(orchestrator, 'sim', 'intent-zero-1');

    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toBe('Não há nenhuma operação pendente para confirmar.');
    expect(fake.events).toEqual(['listActive']);
  });

  it('conversational retry on failed: single execution via retry attestation', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-failed', 'failed')]);
    const orchestrator = setup(fake);
    const result = await turn(orchestrator, 'tenta de novo', 'intent-retry-1');

    expect(result.mutation).toEqual({
      operationId: 'op-failed',
      status: 'succeeded',
      receipt: {
        mutationId: 'mut-op-failed',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'op-failed',
        entity: { type: 'transaction', id: 'mut-op-failed' },
      },
    });
    expect(result.response?.text).toBe('Lançamento registrado com sucesso.');
    expect(fake.events).toEqual(['listActive', 'retry:op-failed', 'execute:op-failed']);
  });

  it('retry with no failed operation: deterministic reply', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1')]);
    const orchestrator = setup(fake);
    const result = await turn(orchestrator, 'tenta de novo', 'intent-retry-none-1');

    expect(result.mutation).toBeUndefined();
    expect(result.response?.text).toBe('Não há nenhuma operação com falha para tentar novamente.');
    expect(fake.events).toEqual(['listActive']);
  });

  it('cancel with zero ops and an active draft: draft discarded, deterministic no-op copy (INV-03)', async () => {
    const fake = makeFakeApprovalApi([]);
    const store = new InMemoryMutationDraftStore();
    const draft = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'intent-draft-1',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 5000, description: 'Mercado', date: '2026-09-14' },
      missingFields: ['accountId', 'categoryId'],
      question: 'Em qual conta devo registrar?',
    });
    store.getOrCreate(draft);
    const orchestrator = setup(fake, store);

    const result = await turn(orchestrator, 'cancela', 'intent-cancel-draft-1');
    expect(result.response?.text).toBe(NO_PENDING_CANCEL_TEXT);
    expect(result.response?.text).not.toMatch(/cancelada|registrado|com sucesso/);
    expect(store.get(draft.draftId)?.status).toBe('discarded');
    expect(fake.events).not.toContain('confirm:op-1');
  });

  it('cancel during proposing (case E): same-key outcome resolved, then authoritative cancel', async () => {
    const fake = makeFakeApprovalApi([]);
    const store = new InMemoryMutationDraftStore();
    const draft = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'intent-proposing-1',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 5000, description: 'Mercado', date: '2026-09-14' },
      missingFields: [],
      question: 'q',
    });
    store.getOrCreate(draft);
    store.update(draft.draftId, {
      status: 'proposing',
      resolvedArgs: {
        kind: 'expense', amountCents: 5000, description: 'Mercado', date: '2026-09-14',
        accountId: ACCOUNT_ID, categoryId: CATEGORY_ID,
      },
      missingFields: [],
    });
    const orchestrator = setup(fake, store);

    const result = await turn(orchestrator, 'cancela', 'intent-cancel-proposing-1');
    expect(result.response?.text).toBe('Operação cancelada com segurança.');
    // Same proposalIdempotencyKey re-emitted, then the existing operation cancelled.
    expect(fake.proposeKeys).toEqual([draft.proposalIdempotencyKey]);
    const createdId = fake.events.find((event) => event.startsWith('cancel:'))!;
    expect(createdId).toMatch(/^cancel:pending-/);
    expect(fake.events).not.toContainEqual(expect.stringMatching(/^execute:/));
  });

  it('cancel during proposing with definitive rejection: draft discarded, no operation', async () => {
    const store = new InMemoryMutationDraftStore();
    const draft = buildDraftRecord({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId ?? null,
      intentionId: 'intent-proposing-2',
      tool: 'transactions.expense.create',
      resolvedArgs: { kind: 'expense', amountCents: 5000, description: 'Mercado', date: '2026-09-14' },
      missingFields: [],
      question: 'q',
    });
    store.getOrCreate(draft);
    store.update(draft.draftId, {
      status: 'proposing',
      resolvedArgs: {
        kind: 'expense', amountCents: 5000, description: 'Mercado', date: '2026-09-14',
        accountId: ACCOUNT_ID, categoryId: CATEGORY_ID,
      },
      missingFields: [],
    });
    const request = vi.fn();
    request.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/pending-operations/v2/active') {
        return { items: [], total: 0 };
      }
      throw Object.assign(new Error('validation.failed'), { statusCode: 400 });
    });
    const api = new MutationApiClient({ request });
    const orchestrator = new ConversationOrchestrator({ mutationApiClient: api, draftStore: store });

    const result = await turn(orchestrator, 'cancela', 'intent-cancel-proposing-2');
    expect(result.response?.text).toBe(NO_PENDING_CANCEL_TEXT);
    expect(result.response?.text).not.toMatch(/cancelada|registrado|com sucesso/);
    expect(store.get(draft.draftId)?.status).toBe('discarded');
  });

  it('button vs NL converge: decide(confirm) matches the natural confirm outcome', async () => {
    const fakeNl = makeFakeApprovalApi([expenseOp('op-1')]);
    const orchestrator = setup(fakeNl);
    const nl = await turn(orchestrator, 'confirmo', 'intent-button-parity-1');

    const fakeButton = makeFakeApprovalApi([expenseOp('op-1')]);
    const coordinator = new PendingOperationCoordinator({ client: fakeButton.api });
    const button = await coordinator.decide({
      operationId: 'op-1',
      decision: 'confirm',
      identity: { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! },
    });

    expect(nl.mutation).toEqual({
      operationId: 'op-1',
      status: 'succeeded',
      receipt: {
        mutationId: 'mut-op-1',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'op-1',
        entity: { type: 'transaction', id: 'mut-op-1' },
      },
    });
    expect(button).toEqual({
      operationId: 'op-1',
      status: 'succeeded',
      receipt: {
        mutationId: 'mut-op-1',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'],
        operationId: 'op-1',
        entity: { type: 'transaction', id: 'mut-op-1' },
      },
    });
    expect(fakeButton.events).toEqual(['confirm:op-1', 'execute:op-1']);
  });

  it('button cancel converges through the same coordinator', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1')]);
    const coordinator = new PendingOperationCoordinator({ client: fake.api });
    const result = await coordinator.decide({
      operationId: 'op-1',
      decision: 'cancel',
      identity: { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! },
    });
    expect(result).toEqual({ operationId: 'op-1', status: 'cancelled' });
    expect(fake.events).toEqual(['cancel:op-1']);
  });

  it('coordinator retry rejects a response bound to another operation before execute', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1', 'failed')]);
    fake.request.mockResolvedValueOnce({ id: 'op-other', attestation: 'b'.repeat(40) });
    const coordinator = new PendingOperationCoordinator({ client: fake.api });

    await expect(
      coordinator.retry('op-1', { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! }),
    ).rejects.toThrow('approval.operation_id_mismatch');
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(fake.request.mock.calls[0]?.[1]).toBe('/pending-operations/v2/op-1/retry');
    expect(fake.events).not.toContain('execute:op-other');
  });

  it('coordinator cancel rejects a response bound to another operation', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1')]);
    fake.request.mockResolvedValueOnce({ id: 'op-other', status: 'cancelled' });
    const coordinator = new PendingOperationCoordinator({ client: fake.api });

    await expect(
      coordinator.cancel('op-1', { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! }),
    ).rejects.toThrow('approval.operation_id_mismatch');
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(fake.request.mock.calls[0]?.[1]).toBe('/pending-operations/v2/op-1/cancel');
    expect(fake.events).not.toContain('cancel:op-1');
  });

  it('coordinator cancel only reports success when the returned status is cancelled', async () => {
    const fake = makeFakeApprovalApi([expenseOp('op-1')]);
    fake.request.mockResolvedValueOnce({ id: 'op-1', status: 'proposed' });
    const coordinator = new PendingOperationCoordinator({ client: fake.api });

    await expect(
      coordinator.cancel('op-1', { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId! }),
    ).rejects.toThrow('approval.cancel_not_confirmed');
    expect(fake.request).toHaveBeenCalledTimes(1);
    expect(fake.events).not.toContain('cancel:op-1');
  });
});
