/**
 * TED F1 directed synthetic contracts (TASK F11-DIRECTED-CONTRACTS).
 *
 * Narrows the original eval gaps WITHOUT touching product code:
 * - C004 (F1-B004): unique account rename binds exact expectedName/CAS,
 *   no execution on the proposal turn; gate rejects a changed precondition.
 * - C007/C017 (F1-B007/F1-B031): covers UndoProposalService binding
 *   with a supplied own-only preview (ADR-028 policy as injected
 *   dependency); the REAL product target election remains INCONCLUSIVE
 *   here — no claim that production elects own-only. Explicit cross-actor
 *   naming stays authorized only via the binding-checked decision path,
 *   never via silent election.
 * - C011/C024 (F1-B012/F1-B057): unsupported budget/statement writes do
 *   not claim success; absent/misbound receipts never become `succeeded`.
 *
 * Method: REAL production units (ConversationOrchestrator.runTurn,
 * resolveRenameTarget, UndoProposalService, MutationExecutor) over
 * synthetic in-memory dependencies. No real API/DB/provider, no src
 * writes, no commit/push/deploy. PRODUCTION_AUTHORIZED=false,
 * CREDENTIAL_SCOPE=none.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../src/mutations/mutation-api-client.js';
import { InMemoryMutationDraftStore } from '../src/mutations/mutation-draft.js';
import { MutationExecutor } from '../src/mutations/mutation-executor.js';
import { resolveRenameTarget } from '../src/mutations/account-rename.js';
import {
  SqlUndoProposalStore,
  UndoProposalService,
  initializeUndoProposalSchema,
} from '../src/mutations/undo-proposal.js';
import { createMemorySql } from './helpers/memory-sql.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');

const AURORA_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-8000-000000000002';
const TX_ENTITY_ID = '44444444-4444-4444-8444-444444444444';
const TX_ENTITY_OTHER = '55555555-5555-4555-9555-555555555555';

const ATTEST = 'a'.repeat(32);

// ---------------------------------------------------------------------------
// Shared synthetic orchestrator harness (rename + unsupported paths).
// ---------------------------------------------------------------------------

const directedIdentity: AuthenticatedIdentity = {
  actorId: 'f1-directed-actor',
  workspaceId: 'f1-directed-workspace',
  role: 'member',
  deviceId: 'f1-directed-device',
};

const directedCtx = {
  workspaceId: directedIdentity.workspaceId,
  actorId: directedIdentity.actorId,
  deviceId: directedIdentity.deviceId ?? null,
};

type AccountRow = { id: string; name: string; kind?: string; isActive?: boolean };

const makeOrchestratorHarness = (accounts: AccountRow[]) => {
  let now = T0;
  const store = new InMemoryMutationDraftStore();
  const calls: Array<{ method: string; path: string; options: unknown }> = [];
  const request = vi.fn().mockImplementation(async (method: string, path: string, options: unknown) => {
    calls.push({ method, path, options });
    if (method === 'POST' && path === '/pending-operations/v2/propose') {
      return {
        id: 'op-directed-1',
        existing: false,
        operation: { id: 'op-directed-1', expiresAt: new Date(now + 600_000).toISOString() },
      };
    }
    if (method === 'GET' && path === '/pending-operations/v2/active') return { items: [], total: 0 };
    if (method === 'POST' && path === '/pending-operations/v2/confirmation-intentions/bind') {
      return { firstSeenAt: new Date(now).toISOString(), fresh: true, operationId: null };
    }
    throw new Error(`unexpected directed request ${method} ${path}`);
  });
  const api = new MutationApiClient({ request: request as never });
  const orchestrator = new ConversationOrchestrator({
    mutationApiClient: api,
    entityReader: {
      listAccounts: async () => accounts,
      listCategories: async () => [],
    },
    draftStore: store,
    draftNow: () => now,
    responseProvider: vi.fn(async () => '[directed synthetic relay output; not a product claim]'),
    evidenceProvider: vi.fn(async () => ({
      version: '1' as const,
      items: [
        {
          ref: 'test',
          source: 'api.test',
          retrievedAt: new Date().toISOString(),
          status: 'empty' as const,
          data: [],
          reason: 'setup_incomplete' as const,
        },
      ],
    })) as never,
    events: () => undefined,
  });
  const proposes = () => calls.filter((c) => c.path === '/pending-operations/v2/propose');
  const executes = () => calls.filter((c) => c.path.endsWith('/execute'));
  return { store, calls, orchestrator, proposes, executes };
};

// ---------------------------------------------------------------------------
// C004 — unique resolver + CAS (F1-B004).
// ---------------------------------------------------------------------------

describe('F11 C004 unique-resolver-and-cas (directed, synthetic)', () => {
  it('binds exact {accountId, expectedName, name} with zero execution on the proposal turn', async () => {
    const h = makeOrchestratorHarness([{ id: AURORA_ID, name: 'Aurora', kind: 'bank' }]);
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn({ text: 'Renomeie conta Aurora para Reserva', intentionId: 'f11-c004-t1' }, directedIdentity),
    );
    expect(result.mutation?.status).toBe('proposed');
    expect(result.mutation?.operationId).toBe('op-directed-1');
    expect(h.proposes()).toHaveLength(1);
    expect(h.executes()).toHaveLength(0);
    const body = (h.proposes()[0]!.options as { body?: Record<string, unknown> }).body as Record<string, unknown>;
    expect(body.tool).toBe('accounts.update');
    expect(body.normalizedArgs).toMatchObject({ accountId: AURORA_ID, expectedName: 'Aurora', name: 'Reserva' });
    expect(result.response?.text).toMatch(/reserva/i);
    expect(h.store.listActive(directedCtx, T0 + 1000)).toHaveLength(0);
  });

  it('gate is sensitive: a changed precondition (renamed-away target) never reuses the stale expectedName binding', async () => {
    // The authority now reports the account under its NEW name only: the
    // stale hint "Aurora" must not resolve to a proposal carrying
    // expectedName "Aurora" for that row.
    const stale = resolveRenameTarget('Renomeie conta Aurora para Reserva', [
      { id: AURORA_ID, name: 'Reserva', kind: 'bank' },
    ]);
    expect(stale.kind).not.toBe('resolved');
    // And the execution gate rejects a receipt bound to ANOTHER account
    // even when the response is internally self-consistent (HIGH3).
    const executor = new MutationExecutor({
      request: (async () => ({
        id: 'op-directed-1',
        status: 'succeeded',
        execution: {
          status: 'succeeded',
          operationId: OTHER_ACCOUNT_ID,
          receipt: {
            mutationId: 'm-directed-1',
            mutationKind: 'accounts.update',
            status: 'succeeded',
            affectedTargets: ['accounts'],
            operationId: 'op-directed-1',
            entity: { type: 'account', id: OTHER_ACCOUNT_ID },
          },
        },
      })) as never,
      events: () => undefined,
    });
    await expect(
      executor.execute(
        {
          operationId: 'op-directed-1',
          attestation: ATTEST,
          identity: { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' },
          expected: { tool: 'accounts.update', entityId: AURORA_ID },
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');
  });
});

// ---------------------------------------------------------------------------
// C007/C017 — own-actor undo protocol (F1-B007/F1-B031, ADR-028).
// ---------------------------------------------------------------------------

const makeUndoHarness = (ledger: Array<{ id: string; actorId: string }>) => {
  const mock = createMemorySql();
  initializeUndoProposalSchema(mock);
  const store = new SqlUndoProposalStore(
    mock as unknown as ConstructorParameters<typeof SqlUndoProposalStore>[0],
  );
  const apiUndo = vi.fn(async () => ({ undone: true }));
  // ADR-028 own-only election as the injected preview contract: the service
  // under test owns proposal/binding/execution, the preview only names the
  // authoritative fixed target for this identity.
  const preview = vi.fn(async (identity: { actorId: string }) => {
    const own = ledger.filter((entry) => entry.actorId === identity.actorId);
    return own.length > 0 ? { id: own[0]!.id } : null;
  });
  const service = new UndoProposalService({ store, preview, api: { undo: apiUndo } });
  return { store, preview, apiUndo, service };
};

describe('F11 C007/C017 own-actor-undo-binding (directed, synthetic; election INCONCLUSIVE)', () => {
  it('honors the injected own-only preview; foreign-only ledger yields unavailable with zero effect', async () => {
    const h = makeUndoHarness([
      { id: 'op-own-1', actorId: 'actor-a' },
      { id: 'op-foreign-9', actorId: 'actor-b' },
    ]);
    const own = await h.service.propose({
      requestId: 'f11-c007-own',
      identity: { workspaceId: 'ws', actorId: 'actor-a', deviceId: 'dev' },
    });
    expect(own.kind).toBe('proposed');
    if (own.kind === 'proposed') expect(own.record.targetLastOperationId).toBe('op-own-1');

    const foreignOnly = makeUndoHarness([{ id: 'op-foreign-9', actorId: 'actor-b' }]);
    const none = await foreignOnly.service.propose({
      requestId: 'f11-c007-foreign-only',
      identity: { workspaceId: 'ws', actorId: 'actor-a', deviceId: 'dev' },
    });
    expect(none).toEqual({ kind: 'unavailable' });
    expect(foreignOnly.apiUndo).not.toHaveBeenCalled();
    expect(foreignOnly.store.get('f11-c007-foreign-only')).toBeUndefined();
  });

  it('gate is sensitive: a foreign actor cannot decide another actor proposal; verify binds the exact entity', async () => {
    const h = makeUndoHarness([{ id: 'op-own-1', actorId: 'actor-a' }]);
    const proposed = await h.service.propose({
      requestId: 'f11-c017-explicit',
      identity: { workspaceId: 'ws', actorId: 'actor-a', deviceId: 'dev' },
    });
    expect(proposed.kind).toBe('proposed');

    // Explicit cross-actor decision attempt on actor-a's row: binding
    // mismatch, zero transport, zero effect.
    const foreignDecision = await h.service
      .decide({
        requestId: 'f11-c017-explicit',
        decision: 'confirm',
        identity: { workspaceId: 'ws', actorId: 'actor-b', deviceId: 'dev' },
      })
      .then(
        () => ({ code: 'no-throw' }),
        (error: unknown) => ({ code: (error as { code?: unknown }).code }),
      );
    expect(foreignDecision.code).toBe('undo.binding_mismatch');
    expect(h.apiUndo).not.toHaveBeenCalled();

    // Explicit named-target verification uses the injected audit reader
    // (real UndoProposalService.verify, synthetic audit surface).
    const auditHarness = (() => {
      const mock = createMemorySql();
      initializeUndoProposalSchema(mock);
      const store = new SqlUndoProposalStore(
        mock as unknown as ConstructorParameters<typeof SqlUndoProposalStore>[0],
      );
      const preview = vi.fn(async () => ({ id: 'op-own-1' }));
      const audit = vi.fn(async () => [
        {
          id: 'op-own-1',
          workspaceId: 'ws',
          operation: 'transactions.expense.create',
          metadata: { entityId: TX_ENTITY_ID },
        },
      ]);
      return { service: new UndoProposalService({ store, preview, api: { undo: apiUndoNoop }, audit }) };
    })();
    await auditHarness.service.propose({
      requestId: 'f11-c017-verify',
      identity: { workspaceId: 'ws', actorId: 'actor-a', deviceId: 'dev' },
    });
    const matched = await auditHarness.service.verify({
      requestId: 'f11-c017-verify',
      expectedEntity: { type: 'transaction', id: TX_ENTITY_ID },
      identity: { workspaceId: 'ws', actorId: 'actor-a', deviceId: 'dev' },
    });
    expect(matched).toMatchObject({ kind: 'verified', matches: true });
    const mismatched = await auditHarness.service.verify({
      requestId: 'f11-c017-verify',
      expectedEntity: { type: 'transaction', id: TX_ENTITY_OTHER },
      identity: { workspaceId: 'ws', actorId: 'actor-a', deviceId: 'dev' },
    });
    expect(mismatched).toMatchObject({ kind: 'verified', matches: false });
  });
});

const apiUndoNoop = async () => ({ undone: true });

// ---------------------------------------------------------------------------
// C011/C024 — unsupported writes never claim success; receipts required.
// ---------------------------------------------------------------------------

describe('F11 C011/C024 unsupported-no-write plus receipt gate (directed, synthetic)', () => {
  it('budget creation without a V2 writer: no proposal, no execution, no success claim', async () => {
    const h = makeOrchestratorHarness([]);
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'Crie um orçamento de alimentação de 500 reais', intentionId: 'f11-c011-t1' },
        directedIdentity,
      ),
    );
    expect(result.mutation).toBeUndefined();
    expect(h.proposes()).toHaveLength(0);
    expect(h.executes()).toHaveLength(0);
    expect(result.response?.text ?? '').toMatch(/orçament/i);
    expect(result.response?.text ?? '').not.toMatch(/sucedid|com sucesso/i);
  });

  it('statement payment without a V2 executor: no write, honest limitation, no success claim', async () => {
    const h = makeOrchestratorHarness([]);
    const result = await h.orchestrator.runTurn(
      normalizeRestTurn(
        { text: 'Pague metade da fatura do cartão', intentionId: 'f11-c024-t1' },
        directedIdentity,
      ),
    );
    expect(result.mutation?.status).not.toBe('succeeded');
    expect(h.proposes()).toHaveLength(0);
    expect(h.executes()).toHaveLength(0);
    expect(result.response?.text ?? '').not.toMatch(/sucedid|pagamento efetuado|pago com sucesso/i);
  });

  it('gate is sensitive: missing or misbound receipts never become succeeded (faithful receipt is the control)', async () => {
    const failingWith = (execution: unknown) =>
      new MutationExecutor({
        request: (async () => ({ id: 'op-directed-9', status: 'succeeded', execution })) as never,
        events: () => undefined,
      });
    const identity = { workspaceId: 'ws', actorId: 'actor', deviceId: 'device' };
    const expected = { tool: 'transactions.expense.create' } as const;

    // Absent receipt: the executor fails closed instead of succeeding.
    await expect(
      failingWith({ status: 'succeeded', operationId: TX_ENTITY_ID }).execute(
        { operationId: 'op-directed-9', attestation: ATTEST, identity, expected },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');

    // Misbound receipt (transaction entity where the authorized context is
    // an account tool): also fails closed.
    const misbound = failingWith({
      status: 'succeeded',
      operationId: TX_ENTITY_ID,
      receipt: {
        mutationId: 'm-directed-9',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions'],
        operationId: 'op-directed-9',
        entity: { type: 'transaction', id: TX_ENTITY_ID },
      },
    });
    await expect(
      misbound.execute(
        {
          operationId: 'op-directed-9',
          attestation: ATTEST,
          identity,
          expected: { tool: 'accounts.update', entityId: AURORA_ID },
        },
        'token',
      ),
    ).rejects.toThrow('approval.incomplete_result');

    // Control: a faithful transaction receipt with matching context succeeds.
    const faithful = failingWith({
      status: 'succeeded',
      operationId: TX_ENTITY_ID,
      mutationId: 'm-directed-9',
      receipt: {
        mutationId: 'm-directed-9',
        mutationKind: 'transactions.expense.create',
        status: 'succeeded',
        affectedTargets: ['transactions'],
        operationId: 'op-directed-9',
        entity: { type: 'transaction', id: TX_ENTITY_ID },
      },
    });
    const out = await faithful.execute(
      { operationId: 'op-directed-9', attestation: 'b'.repeat(32), identity, expected },
      'token',
    );
    expect(out.status).toBe('succeeded');
    expect(out.receipt).toMatchObject({ mutationKind: 'transactions.expense.create', operationId: 'op-directed-9' });
  });
});
