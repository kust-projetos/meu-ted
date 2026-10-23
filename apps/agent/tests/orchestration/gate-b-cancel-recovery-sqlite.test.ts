import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { PendingOperationCoordinator } from '../../src/orchestration/pending-operation-coordinator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { initializeMutationDraftSchema, SqlMutationDraftStore, buildDraftRecord } from '../../src/mutations/mutation-draft.js';

type SqlShim = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T>; transactionSync?: <T>(fn: () => T) => T };
const createSql = (): { sql: SqlShim } => {
  const db = new DatabaseSync(':memory:');
  const sql: SqlShim = { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(query) || /\bRETURNING\b/i.test(query)) return statement.all(...(bindings as any)) as T[];
    statement.run(...(bindings as any)); return [] as T[];
  }, transactionSync: <T>(fn: () => T) => fn() };
  initializeMutationDraftSchema(sql as any); return { sql };
};

const identity = { actorId: 'a2', workspaceId: 'w2', role: 'member' as const, deviceId: 'd2' };
const T0 = Date.parse('2026-10-21T12:00:00Z');

describe('GATE-B cancel recovery proposal committed response lost (SQLite real)', () => {
  it('stateful keyed propose: transport throw then recovery returns stored original and cancels once', async () => {
    const { sql } = createSql();
    const store1 = new SqlMutationDraftStore(sql as any);
    const draft = buildDraftRecord({
      workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null,
      intentionId: 'intent-gateb-1', tool: 'categories.create',
      resolvedArgs: { kind: 'category-create', amountCents: 0, description: 'Viagem', date: '', categoryName: 'Viagem', categoryKind: 'expense' },
      missingFields: [], question: 'q', ttlMs: 60000, nowMs: T0,
    });
    store1.getOrCreate(draft);
    store1.update(draft.draftId, { status: 'proposing', resolvedArgs: { kind: 'category-create', amountCents: 0, description: 'Viagem', date: '', categoryName: 'Viagem', categoryKind: 'expense' }, missingFields: [] });

    // Stateful fake upstream API keyed by idempotency key.
    const committed = new Map<string, { id: string; payloadHash: string; normalizedArgs: any }>();
    const hashPayload = (body: any) => JSON.stringify(body?.normalizedArgs ?? {});
    let cancelCalls = 0;
    const request = vi.fn().mockImplementation(async (method: string, path: string, options: any) => {
      if (method === 'POST' && path === '/pending-operations/v2/propose') {
        const key = options?.idempotencyKey;
        const body = options?.body ?? {};
        const payloadHash = hashPayload(body);
        if (committed.has(key)) {
          const saved = committed.get(key)!;
          if (saved.payloadHash !== payloadHash) throw new Error('payload hash mismatch');
          return { id: saved.id, existing: true, summary: 'Categoria Viagem', operation: { id: saved.id, expiresAt: new Date(T0 + 10*60000).toISOString() } };
        }
        // first call: register committed record BEFORE throwing transport
        const id = 'op-original';
        committed.set(key, { id, payloadHash, normalizedArgs: body.normalizedArgs });
        throw new Error('transport');
      }
      if (method === 'GET' && path === '/pending-operations/v2/active') {
        const id = committed.size ? [...committed.values()][0].id : 'op-original';
        return { items: [{ id, status: 'proposed', tool: 'categories.create', createdAt: '2026-10-21T12:00:00Z', expiresAt: new Date(T0 + 10*60000).toISOString() }], total: committed.size ? 1 : 0 };
      }
      if (method === 'POST' && path.startsWith('/pending-operations/v2/') && path.endsWith('/cancel')) {
        cancelCalls += 1;
        const id = path.split('/')[3];
        const rec = [...committed.values()].find((r) => r.id === id);
        if (rec) (rec as any).status = 'cancelled';
        return { id, status: 'cancelled' };
      }
      throw new Error(method + ' ' + path);
    });

    const ctx = { workspaceId: identity.workspaceId, actorId: identity.actorId, deviceId: identity.deviceId ?? null };
    const api1 = new MutationApiClient({ request });
    const coord1 = new PendingOperationCoordinator({ client: api1, draftStore: store1, now: () => T0 });
    const firstResolution = await coord1.resolveCancel(identity as any, { store: store1, ctx, intentionId: 'intent-gateb-1', deviceId: identity.deviceId ?? 'd2', nowMs: T0 });
    expect(firstResolution.kind).toBe('inconclusive');
    expect(committed.size).toBe(1);

    // If map were empty, a second call must not magically succeed: simulate by
    // ensuring we do not clear it; the real recovery uses the same map.
    const store2 = new SqlMutationDraftStore(sql as any);
    const api2 = new MutationApiClient({ request });
    const coord2 = new PendingOperationCoordinator({ client: api2, draftStore: store2, now: () => T0 });
    const resolution = await coord2.resolveCancel(identity as any, { store: store2, ctx, intentionId: 'intent-gateb-1', deviceId: identity.deviceId ?? 'd2', nowMs: T0 });

    const saved = [...committed.values()][0];
    expect(committed.size).toBe(1);
    expect(saved.id).toBe('op-original');
    expect(saved.normalizedArgs).toEqual({ name: 'Viagem', kind: 'expense' });
    // first and second keys strictly equal the draft key
    const draftRows = [...(sql as any).exec('SELECT proposal_idempotency_key FROM mutation_drafts')];
    const draftKey = draftRows[0]?.proposal_idempotency_key;
    // capture keys from request calls
    const proposeCalls = request.mock.calls.filter((c: any[]) => c[0] === 'POST' && c[1] === '/pending-operations/v2/propose');
    expect(proposeCalls.length).toBe(2);
    expect((proposeCalls[0][2] as any).idempotencyKey).toBe(draftKey);
    expect((proposeCalls[1][2] as any).idempotencyKey).toBe(draftKey);
    expect((proposeCalls[0][2] as any).idempotencyKey).toBe((proposeCalls[1][2] as any).idempotencyKey);
    expect(resolution.kind).toBe('cancelled');
    expect((resolution as any).operationId).toBe('op-original');
    expect(cancelCalls).toBe(1);
    expect((saved as any).status).toBe('cancelled');
  });
});