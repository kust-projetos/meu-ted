import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  PendingOperationV2Error,
} from '../../src/approvals/pending-v2.js';

const canonicalExpenseArgs = (overrides: Record<string, unknown> = {}) => ({
  description: 'Team lunch with client',
  amountCents: 1250,
  date: '2026-09-14',
  accountId: randomUUID(),
  categoryId: randomUUID(),
  ...overrides,
});

const proposal = async (overrides: Partial<PendingOperationV2> = {}): Promise<PendingOperationV2> => {
  const base = {
    version: 2 as const,
    workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1',
    tool: 'transactions.expense.create', normalizedArgs: canonicalExpenseArgs(),
    proposalHash: '', idempotencyKey: 'idem-1',
    createdAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bindings: { workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1' },
    ...overrides,
  };
  return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
};

describe('authoritative pending operation V2', () => {
  it('rejects wrong device, altered proposal and expired confirmation', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const p = await proposal();
    const saved = await store.propose(p);
    await expect(store.confirm(saved.id, { workspaceId: p.workspaceId, actorId: p.actorId, deviceId: 'other-device' }))
      .rejects.toMatchObject({ code: 'approval.binding_mismatch' });
    const altered = await proposal({ idempotencyKey: 'idem-altered', normalizedArgs: canonicalExpenseArgs({ amountCents: 1251 }) });
    altered.proposalHash = p.proposalHash;
    await expect(store.propose(altered))
      .rejects.toMatchObject({ code: 'approval.invalid_hash' });
    const expiredProposal = await proposal({
      idempotencyKey: 'idem-expired',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // P2 (v2-attestation-route-and-ttl): authoritative server time — a
    // birth-expired proposal fails fast at propose, never persisting a dead
    // row; expiry of a live proposal still fails closed at confirm.
    await expect(store.propose(expiredProposal))
      .rejects.toMatchObject({ code: 'approval.expired' });
  });

  it('proposal replay after confirm/retry stays existing without leaking attestation', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const p = await proposal({ idempotencyKey: 'idem-replay-no-leak' });
    const first = await store.propose(p);
    // Confirm intentionally issues the plaintext attestation.
    const confirmed = await store.confirm(first.id, p);
    const issued = confirmed.attestation!;
    expect(issued).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    // Replay of the same key+hash after confirm: same op, existing:true,
    // same status — but never the plaintext attestation.
    const replay = await store.propose(p);
    expect(replay.existing).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe('confirmed');
    expect('attestation' in replay).toBe(false);
    expect(replay.attestation).toBeUndefined();
    // Same semantics after a failed attempt + retry (new attestation issued).
    await expect(store.execute(issued, p, async () => { throw new Error('temporary'); }))
      .rejects.toThrow('temporary');
    const retried = await store.retry(first.id, p);
    const reissued = retried.attestation!;
    expect(reissued).toBeTruthy();
    expect(reissued).not.toBe(issued);
    const replayAfterRetry = await store.propose(p);
    expect(replayAfterRetry.existing).toBe(true);
    expect(replayAfterRetry.id).toBe(first.id);
    expect(replayAfterRetry.status).toBe('confirmed');
    expect('attestation' in replayAfterRetry).toBe(false);
    expect(replayAfterRetry.attestation).toBeUndefined();
  });

  it('stale malformed execute result after reconcile returns authoritative record without attestation', async () => {
    const store = createInMemoryPendingOperationV2Store({ leaseMs: 40 });
    const key = 'idem-stale-malformed-no-leak';
    const p = await proposal({ idempotencyKey: key });
    const saved = await store.propose(p);
    const confirmed = await store.confirm(saved.id, p);
    // Fake WriteStore keyed by idempotencyKey: same key → same tx id, one effect.
    const receipts = new Map<string, string>();
    let effects = 0;
    const seenKeys: string[] = [];
    const writesExecutor = async (op: { idempotencyKey: string }) => {
      seenKeys.push(op.idempotencyKey);
      const existing = receipts.get(op.idempotencyKey);
      if (existing) return { status: 'succeeded', operationId: existing };
      effects += 1;
      const operationId = `mut-${op.idempotencyKey}`;
      receipts.set(op.idempotencyKey, operationId);
      return { status: 'succeeded', operationId };
    };
    // Original attempt blocks on a gate ("crashed" mid-flight, never finalizes).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const crashed = store.execute(confirmed.attestation!, p, async () => {
      await gate;
      return { ok: true };
    });
    // Allow the TX1 claim to land, then let the lease expire.
    const waitFor = async (done: () => Promise<boolean>, message: string): Promise<void> => {
      const started = Date.now();
      for (;;) {
        if (await done()) return;
        if (Date.now() - started > 5_000) throw new Error(message);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await waitFor(async () => (await store.get(saved.id, p)).status === 'executing', 'timed out waiting for claim');
    await waitFor(
      async () => {
        const record = await store.get(saved.id, p);
        return !!record.executionLeaseExpiresAt && Date.parse(record.executionLeaseExpiresAt) <= Date.now();
      },
      'timed out waiting for lease expiry',
    );
    // Recovery finalizes authoritatively with the SAME idempotencyKey.
    const recovered = await store.reconcileExpiredExecuting(saved.id, p, writesExecutor);
    expect(recovered.status).toBe('succeeded');
    expect(effects).toBe(1);
    // The abandoned attempt lands LATE with a malformed result: the T6.1
    // stale-TX2 guard keeps the authoritative record, and the late result
    // carries no plaintext attestation.
    release();
    const late = await crashed;
    expect(late.status).toBe('succeeded');
    expect(late.mutationId).toBe(recovered.mutationId);
    expect('attestation' in late).toBe(false);
    expect(late.attestation).toBeUndefined();
    const final = await store.get(saved.id, p);
    expect(final.status).toBe('succeeded');
    expect(final.mutationId).toBe(recovered.mutationId);
    expect(seenKeys).toEqual([key]);
    expect(effects).toBe(1);
  });

  it('emits opaque one-use attestation and executes at most once, keeping uncertain post-write outcomes executing', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const p = await proposal();
    const saved = await store.propose(p);
    const confirmed = await store.confirm(saved.id, p);
    expect(confirmed.attestation).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const result = await store.execute(confirmed.attestation!, p, async () => ({ status: 'succeeded', operationId: 'op-1' }));
    expect(result.status).toBe('succeeded');
    await expect(store.execute(confirmed.attestation!, p, async () => ({ status: 'succeeded' })))
      .rejects.toMatchObject({ code: 'approval.attestation_replayed' });
    const second = await store.propose(await proposal({ idempotencyKey: 'idem-2' }));
    const secondConfirmed = await store.confirm(second.id, p);
    // Malformed post-write result: uncertain outcome (the executor may
    // already have written) — kept `executing` for lease recovery, never a
    // retryable `failed`.
    await expect(store.execute(secondConfirmed.attestation!, p, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: 'approval.execution_uncertain' });
    expect((await store.get(second.id, p)).status).toBe('executing');
  });

  it('deduplicates same idempotency request and supports retry with a new attestation', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const p = await proposal();
    const first = await store.propose(p);
    expect(await store.propose(p)).toMatchObject({ id: first.id });
    const confirmed = await store.confirm(first.id, p);
    const firstAttestation = confirmed.attestation;
    await expect(store.execute(firstAttestation!, p, async () => { throw new Error('temporary'); })).rejects.toThrow('temporary');
    const retried = await store.retry(first.id, p);
    expect(retried.attestation).toBeTruthy();
    expect(retried.attestation).not.toBe(firstAttestation);
    await expect(store.propose(await proposal({ idempotencyKey: p.idempotencyKey, normalizedArgs: canonicalExpenseArgs({ amountCents: 2 }) })))
      .rejects.toBeInstanceOf(PendingOperationV2Error);
  });

  it('rejects non-canonical args and unknown tools before persisting (SPEC §7.4)', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const before = store.audit.length;
    await expect(store.propose(await proposal({ idempotencyKey: 'idem-empty', normalizedArgs: {} })))
      .rejects.toMatchObject({ code: 'approval.invalid_args' });
    await expect(store.propose(await proposal({ idempotencyKey: 'idem-legacy', normalizedArgs: { description: 'x', amountCents: 1, date: '2026-09-14', accountId: randomUUID(), categoryQuery: 'food' } })))
      .rejects.toMatchObject({ code: 'approval.invalid_args' });
    await expect(store.propose(await proposal({ idempotencyKey: 'idem-unknown', tool: 'transactions.transfer.create' })))
      .rejects.toMatchObject({ code: 'tool.not_allowed' });
    expect(store.audit.length).toBe(before);
  });

  it('marks idempotent dedup hits as existing', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const p = await proposal();
    const first = await store.propose(p);
    expect(first.existing).not.toBe(true);
    const second = await store.propose(p);
    expect(second.id).toBe(first.id);
    expect(second.existing).toBe(true);
  });

  it('terminal cancel/expire responses omit attestation while confirm issues it (get/list also omit)', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1' };
    // Cancel path: confirm issues attestation, cancel terminal result omits it.
    const p = await proposal({ idempotencyKey: 'idem-cancel-no-leak' });
    const saved = await store.propose(p);
    const confirmed = await store.confirm(saved.id, identity);
    expect(confirmed.attestation).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const cancelled = await store.cancel(saved.id, identity);
    expect(cancelled.status).toBe('cancelled');
    expect('attestation' in cancelled).toBe(false);
    expect(cancelled.attestation).toBeUndefined();
    expect(await store.get(saved.id, identity).then((r) => 'attestation' in r)).toBe(false);
    // Expire path: same non-credentialed terminal surface.
    const q = await proposal({ idempotencyKey: 'idem-expire-no-leak' });
    const savedExpire = await store.propose(q);
    const confirmedExpire = await store.confirm(savedExpire.id, identity);
    expect(confirmedExpire.attestation).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const expired = await store.expire(savedExpire.id, identity);
    expect(expired.status).toBe('expired');
    expect('attestation' in expired).toBe(false);
    expect(expired.attestation).toBeUndefined();
    // Listing never carries plaintext attestations.
    const listed = await store.listActive(identity);
    for (const row of listed) expect('attestation' in row).toBe(false);
    // Status transition + audit intact.
    expect(store.audit.filter((e) => e.event === 'cancel').length).toBe(1);
    expect(store.audit.filter((e) => e.event === 'expire').length).toBe(1);
  });

  it('in-memory executor callbacks never receive plaintext attestation (execute + reconcile)', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const p = await proposal({ idempotencyKey: 'idem-executor-no-attestation' });
    const saved = await store.propose(p);
    const confirmed = await store.confirm(saved.id, p);
    // Intentional issuing paths still carry the token.
    expect(confirmed.attestation).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    let seenExecute: Record<string, unknown> | undefined;
    const result = await store.execute(confirmed.attestation!, p, async (op) => {
      seenExecute = op as unknown as Record<string, unknown>;
      return { status: 'succeeded', operationId: 'op-exec-no-leak' };
    });
    expect(result.status).toBe('succeeded');
    expect(seenExecute).toBeDefined();
    expect('attestation' in seenExecute!).toBe(false);
    expect(seenExecute!.attestation).toBeUndefined();
    expect(seenExecute!.idempotencyKey).toBe('idem-executor-no-attestation');
    expect(seenExecute!.tool).toBe(p.tool);
    expect(seenExecute!.workspaceId).toBe(p.workspaceId);
    expect(seenExecute!.actorId).toBe(p.actorId);
    expect(seenExecute!.deviceId).toBe(p.deviceId);
    expect(seenExecute!.normalizedArgs).toEqual(p.normalizedArgs);
    // Stored record stays stripped on terminal reads.
    expect('attestation' in result).toBe(false);
  });

  it('expired-lease reconcile callback sees no attestation while keeping persisted idempotencyKey', async () => {    const store = createInMemoryPendingOperationV2Store({ leaseMs: 20 });
    const key = 'idem-reconcile-no-attestation';
    const p = await proposal({ idempotencyKey: key });
    const saved = await store.propose(p);
    const confirmed = await store.confirm(saved.id, p);
    expect(confirmed.attestation).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    // Drive to `executing` with an uncertain post-write outcome, then let the
    // short lease lapse so reconcile is allowed.
    await expect(store.execute(confirmed.attestation!, p, async () => ({ ok: true })))
      .rejects.toMatchObject({ code: 'approval.execution_uncertain' });
    expect((await store.get(saved.id, p)).status).toBe('executing');
    await new Promise((r) => setTimeout(r, 60));
    let seenReconcile: Record<string, unknown> | undefined;
    const recovered = await store.reconcileExpiredExecuting(saved.id, p, async (op) => {
      seenReconcile = op as unknown as Record<string, unknown>;
      return { status: 'succeeded', operationId: 'op-reconcile-no-leak' };
    });
    expect(recovered.status).toBe('succeeded');
    expect(seenReconcile).toBeDefined();
    expect('attestation' in seenReconcile!).toBe(false);
    expect(seenReconcile!.attestation).toBeUndefined();
    expect(seenReconcile!.idempotencyKey).toBe(key);
    expect(seenReconcile!.tool).toBe(p.tool);
    expect(seenReconcile!.normalizedArgs).toEqual(p.normalizedArgs);
  });

  it('in-memory store detaches nested args/bindings across propose/get/list/replay/execute boundaries', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1' };
    const nestedArgs = {
      ...canonicalExpenseArgs(),
      metadata: { source: 'ted', tags: ['lunch'] },
    };
    const p = await proposal({ idempotencyKey: 'idem-boundary-copy', normalizedArgs: nestedArgs });
    const expectedArgs = JSON.parse(JSON.stringify(p.normalizedArgs)) as typeof p.normalizedArgs;
    const expectedBindings = { ...p.bindings };
    // Pristine replay input (same key + same hash) for the dedup path below.
    const replayInput = JSON.parse(JSON.stringify(p)) as PendingOperationV2;
    const saved = await store.propose(p);
    // Mutate the caller input after propose: the stored record must not move.
    (p.normalizedArgs as Record<string, unknown>).amountCents = 999999;
    (p.normalizedArgs.metadata as { tags: string[] }).tags.push('caller-tampered');
    p.bindings.deviceId = 'tampered-device';
    // Mutate the propose DTO itself: the stored record must not move.
    (saved.normalizedArgs as Record<string, unknown>).amountCents = 888888;
    (saved.normalizedArgs.metadata as { tags: string[] }).tags.push('dto-tampered');
    saved.bindings.actorId = 'tampered-actor';
    // Mutate get/listActive/replay DTOs: the stored record must not move.
    const seen = await store.get(saved.id, identity);
    (seen.normalizedArgs as Record<string, unknown>).amountCents = 777777;
    const listedRow = (await store.listActive(identity)).find((row) => row.id === saved.id)!;
    (listedRow.normalizedArgs.metadata as { tags: string[] }).tags.push('list-tampered');
    listedRow.bindings.workspaceId = 'tampered-workspace';
    const replay = await store.propose(replayInput);
    expect(replay.existing).toBe(true);
    (replay.normalizedArgs as Record<string, unknown>).amountCents = 666666;
    (replay.normalizedArgs.metadata as { tags: string[] }).tags.push('replay-tampered');
    // The authoritative record still carries the original hash-bound args.
    const canonical = await store.get(saved.id, identity);
    expect(canonical.normalizedArgs).toEqual(expectedArgs);
    expect(canonical.bindings).toEqual(expectedBindings);
    // Confirm intentionally issues plaintext attestation, but nested data
    // must still be detached: mutating the confirm DTO must not move the store.
    const confirmed = await store.confirm(saved.id, identity);
    expect(confirmed.attestation).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    (confirmed.normalizedArgs as Record<string, unknown>).amountCents = 555555;
    // The executor receives the original hash-bound args, and mutating the
    // DTO inside the callback must not move the stored record either.
    let seenByExecutor: { normalizedArgs: unknown; bindings: unknown } | undefined;
    await store.execute(confirmed.attestation!, identity, async (op) => {
      // Snapshot on entry: the callback then mutates its own DTO.
      seenByExecutor = JSON.parse(JSON.stringify(op)) as typeof seenByExecutor;
      (op.normalizedArgs as Record<string, unknown>).amountCents = 444444;
      (op.normalizedArgs.metadata as { tags: string[] }).tags.push('executor-tampered');
      return { status: 'succeeded', operationId: 'op-boundary-copy' };
    });
    expect(seenByExecutor!.normalizedArgs).toEqual(expectedArgs);
    expect(seenByExecutor!.bindings).toEqual(expectedBindings);
    const afterExecute = await store.get(saved.id, identity);
    expect(afterExecute.normalizedArgs).toEqual(expectedArgs);
    expect(afterExecute.bindings).toEqual(expectedBindings);
  });

  it('in-memory store detaches execution receipts across expose boundaries', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const p = await proposal({ idempotencyKey: 'idem-execution-copy' });
    const saved = await store.propose(p);
    const confirmed = await store.confirm(saved.id, p);
    const result = await store.execute(confirmed.attestation!, p, async () => ({
      status: 'succeeded',
      operationId: 'op-execution-copy',
    }));
    expect(result.status).toBe('succeeded');
    const canonicalExecution = JSON.parse(JSON.stringify(result.execution)) as unknown;
    // Mutate the exposed execution receipt/entity/targets: the stored
    // record must keep the canonical values.
    const exposedExecution = result.execution as {
      receipt: { entity: { id: string }; affectedTargets: unknown[] };
    };
    exposedExecution.receipt.entity.id = 'tampered';
    exposedExecution.receipt.affectedTargets.push('tampered');
    const reread = await store.get(saved.id, p);
    expect(reread.execution).toEqual(canonicalExecution);
  });

  it('propose snapshots synchronously: caller mutation after dispatch never executes altered args (TOCTOU)', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1' };
    const p = await proposal({ idempotencyKey: 'idem-toctou-snapshot' });
    const originalArgs = JSON.parse(JSON.stringify(p.normalizedArgs)) as typeof p.normalizedArgs;
    const originalBindings = { ...p.bindings };
    const originalHash = p.proposalHash;
    // Dispatch without awaiting, then synchronously mutate the caller-owned
    // objects inside the async hash-verification window (TOCTOU). The store
    // must honor exactly the already-validated snapshot: it either rejects
    // cleanly or persists the original — never the altered args.
    const proposing = store.propose(p);
    (p.normalizedArgs as Record<string, unknown>).amountCents = 999999;
    (p.bindings as Record<string, unknown>).deviceId = 'tampered-device';
    const saved = await proposing;
    expect(saved.proposalHash).toBe(originalHash);
    expect(saved.normalizedArgs).toEqual(originalArgs);
    expect(saved.bindings).toEqual(originalBindings);
    // The executor receives exactly the validated/hash snapshot, not the
    // caller-mutated object.
    const confirmed = await store.confirm(saved.id, identity);
    let seenArgs: unknown;
    await store.execute(confirmed.attestation!, identity, async (op) => {
      seenArgs = JSON.parse(JSON.stringify(op.normalizedArgs));
      return { status: 'succeeded', operationId: 'op-toctou-snapshot' };
    });
    expect(seenArgs).toEqual(originalArgs);
  });

  it('non-enumerable toJSON on normalizedArgs never leaks into hash/storage/executor', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1' };
    const p = await proposal({ idempotencyKey: 'idem-tojson-snapshot' });
    const originalArgs = JSON.parse(JSON.stringify(p.normalizedArgs)) as typeof p.normalizedArgs;
    const alteredAmount = 424242;
    Object.defineProperty(p.normalizedArgs, 'toJSON', {
      value: () => ({ ...(originalArgs as Record<string, unknown>), amountCents: alteredAmount }),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    // Sanity: a naive JSON.stringify copy WOULD invoke the hidden toJSON.
    expect((JSON.parse(JSON.stringify(p.normalizedArgs)) as Record<string, unknown>).amountCents).toBe(alteredAmount);
    const saved = await store.propose(p);
    // Either rejected before storage or stored original — never toJSON output.
    expect(saved.proposalHash).toBe(p.proposalHash);
    expect(saved.normalizedArgs).toEqual(originalArgs);
    const confirmed = await store.confirm(saved.id, identity);
    let seenArgs: unknown;
    await store.execute(confirmed.attestation!, identity, async (op) => {
      seenArgs = JSON.parse(JSON.stringify(op.normalizedArgs));
      return { status: 'succeeded', operationId: 'op-tojson-snapshot' };
    });
    expect(seenArgs).toEqual(originalArgs);
  });
});
