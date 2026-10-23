/**
 * RED (ted-local.account-idempotency): accounts.create via Pending V2 deve
 * executar no máximo uma vez por (workspace, idempotencyKey).
 *
 * Hoje executeAccountCreate ignora o idempotencyKey (WriteStore.createAccount
 * não aceita opções keyed), então um replay pós-efeito (lease recovery com a
 * MESMA chave e MESMOS args) cria uma segunda conta em vez de retornar o
 * resultado original — caindo no guard de nome duplicado em vez de replay.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import { createInMemoryStores } from '../../src/writes/in-memory.js';
import { requireApprovalToolContract } from '../../src/approvals/tool-registry.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';

const H = 'workspace-1';
const OTHER = 'workspace-2';
const IDENTITY = { workspaceId: H, actorId: 'actor-1', deviceId: 'device-1' };

const accountArgs = (name = 'Conta Corrente TED') => ({
  name,
  kind: 'bank' as const,
  initialBalanceCents: 0,
});

const proposal = async (
  normalizedArgs: Record<string, unknown>,
  key: string,
  workspaceId = H,
): Promise<PendingOperationV2> => {
  const base = {
    version: 2 as const,
    workspaceId,
    actorId: 'actor-1',
    deviceId: 'device-1',
    tool: 'accounts.create',
    normalizedArgs,
    proposalHash: '',
    idempotencyKey: key,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bindings: { workspaceId, actorId: 'actor-1', deviceId: 'device-1' },
  };
  return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
};

const exec = (
  writes: ReturnType<typeof createInMemoryStores>['writes'],
  workspaceId: string,
  args: unknown,
  idempotencyKey: string,
) =>
  requireApprovalToolContract('accounts.create').executor({
    writes,
    workspaceId,
    args,
    idempotencyKey,
    actorId: 'actor-1',
  });

describe('RED: accounts.create V2 ignora idempotencyKey', () => {
  it('replay mesma chave + mesmos args retorna a mesma conta, exatamente uma conta', async () => {
    const { state, writes } = createInMemoryStores();
    const args = accountArgs();
    const first = await exec(writes, H, args, 'op-key-acct');
    const second = await exec(writes, H, args, 'op-key-acct');
    expect(second.operationId).toBe(first.operationId);
    expect(state.accounts.filter((a) => a.householdId === H)).toHaveLength(1);
  });

  it('recovery pós-efeito persistido: crash após write + reconcile mesma chave retorna o id original sem duplicar', async () => {
    const { state, writes } = createInMemoryStores();
    const store = createInMemoryPendingOperationV2Store();
    const args = accountArgs();
    const saved = await store.propose(await proposal(args, 'op-key-acct-recovery'));
    const confirmed = await store.confirm(saved.id, IDENTITY);
    const crashAfterWrite = async (operation: PendingOperationV2) => {
      await exec(writes, operation.workspaceId, args, operation.idempotencyKey);
      throw new Error('crash-after-write');
    };
    await expect(store.execute(confirmed.attestation!, IDENTITY, crashAfterWrite)).rejects.toThrow(
      'crash-after-write',
    );
    expect(state.accounts.filter((a) => a.householdId === H)).toHaveLength(1);
    const firstId = state.accounts[0]!.id;

    const retried = await store.retry(saved.id, IDENTITY);
    const result = await store.execute(
      retried.attestation!,
      IDENTITY,
      async (op: PendingOperationV2) =>
        exec(writes, op.workspaceId, op.normalizedArgs, op.idempotencyKey),
    );
    expect(result.status).toBe('succeeded');
    expect((result.execution as { operationId: string }).operationId).toBe(firstId);
    expect(state.accounts.filter((a) => a.householdId === H)).toHaveLength(1);
  });

  it('mesma chave com payload divergente rejeita com idempotency.conflict', async () => {
    const { writes } = createInMemoryStores();
    await exec(writes, H, accountArgs('Conta A'), 'op-key-acct-conflict');
    await expect(
      exec(writes, H, accountArgs('Conta B'), 'op-key-acct-conflict'),
    ).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('mesma chave em workspace distinto não conflita', async () => {
    const { state, writes } = createInMemoryStores();
    const first = await exec(writes, H, accountArgs(), 'op-key-shared');
    const second = await exec(writes, OTHER, accountArgs(), 'op-key-shared');
    expect(second.operationId).not.toBe(first.operationId);
    expect(state.accounts).toHaveLength(2);
  });

  it('guard de duplicado preservado: chaves distintas com mesmo nome seguem 409 in_use', async () => {
    const { writes } = createInMemoryStores();
    await exec(writes, H, accountArgs('Dup'), randomUUID());
    await expect(exec(writes, H, accountArgs('dup'), randomUUID())).rejects.toMatchObject({
      code: 'in_use',
    });
  });
});

describe('round2 achado 3: snapshot do resultado keyed em memória', () => {
  const input = () => ({ name: 'Orig', kind: 'bank' as const, initialBalanceCents: 0 });

  it('replay após updateAccount retorna o snapshot original com o ID original', async () => {
    const { writes } = createInMemoryStores();
    const first = await writes.createAccount(H, input(), { idempotencyKey: 'k-snap' });
    expect(first.name).toBe('Orig');
    await writes.updateAccount(H, first.id, { name: 'Edited' });
    const replayed = await writes.createAccount(H, input(), { idempotencyKey: 'k-snap' });
    expect(replayed.id).toBe(first.id);
    expect(replayed.name).toBe('Orig');
  });

  it('mutar o objeto retornado não corrompe o snapshot persistido', async () => {
    const { writes } = createInMemoryStores();
    await writes.createAccount(H, input(), { idempotencyKey: 'k-snap2' });
    const r1 = await writes.createAccount(H, input(), { idempotencyKey: 'k-snap2' });
    r1.name = 'Corrupted';
    const r2 = await writes.createAccount(H, input(), { idempotencyKey: 'k-snap2' });
    expect(r2.name).toBe('Orig');
  });
});
