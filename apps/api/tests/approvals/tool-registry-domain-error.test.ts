/**
 * T12c — DomainError pré-commit vs incerteza pós-write no tool-registry.
 *
 * Contrato: um DomainError lançado pelo WriteStore prova validação
 * pré-commit com rollback (todos os throws de DomainError em
 * createExpense/createIncome ocorrem antes do INSERT, dentro da mesma
 * transação) — nada gravou, então o erro determinístico deve propagar
 * para que a pending op vá a `failed` com retry permitido. Qualquer outro
 * erro do writer pode ser pós-commit (commit + perda de resposta) e deve
 * mapear para `approval.execution_uncertain` (operação segue `executing`
 * para reconciliação com a MESMA idempotency key — ADR-013/SPEC §9).
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  APPROVAL_EXECUTION_UNCERTAIN_CODE,
  isApprovalExecutionUncertain,
  requireApprovalToolContract,
} from '../../src/approvals/tool-registry.js';
import { DomainError, domainErrors } from '../../src/writes/errors.js';
import type { WriteStore } from '../../src/writes/store.js';
import { createInMemoryPendingOperationV2Store } from '../../src/approvals/pending-v2.js';
import { computePendingOperationV2Hash } from '@pi-finance/llm-contracts';

const validExpenseArgs = () => ({
  description: 'Lunch',
  amountCents: 1000,
  date: '2026-09-14',
  accountId: randomUUID(),
  categoryId: randomUUID(),
});

const baseCtx = (writes: WriteStore, idempotencyKey = `k-${randomUUID()}`) => ({
  writes,
  workspaceId: 'ws-1',
  args: validExpenseArgs(),
  idempotencyKey,
  actorId: 'actor-1',
});

describe('T12c: tool-registry classifica DomainError pré-write vs incerteza pós-write', () => {
  it('expense: DomainError do writer (ex. conta inexistente) propaga determinístico, nunca uncertain', async () => {
    const contract = requireApprovalToolContract('transactions.expense.create');
    const failingWrites = {
      createExpense: async () => {
        throw domainErrors.notFound('Conta');
      },
    };
    const caught = await contract
      .executor(baseCtx(failingWrites as unknown as WriteStore))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught).toMatchObject({ code: 'not_found', statusCode: 404 });
    expect(isApprovalExecutionUncertain(caught)).toBe(false);
  });

  it('income: DomainError do writer propaga determinístico, nunca uncertain', async () => {
    const contract = requireApprovalToolContract('transactions.income.create');
    const failingWrites = {
      createIncome: async () => {
        throw domainErrors.invalid('categoryId', 'categoria de outro tipo');
      },
    };
    const caught = await contract
      .executor({
        ...baseCtx(failingWrites as unknown as WriteStore),
        args: {
          description: 'Pay',
          amountCents: 500,
          date: '2026-09-14',
          accountId: randomUUID(),
          categoryId: randomUUID(),
        },
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught).toMatchObject({ code: 'validation.invalid' });
    expect(isApprovalExecutionUncertain(caught)).toBe(false);
  });

  it('expense: falha genérica pós-write (efeito gravado + throw) vira uncertain, sem vazar causa', async () => {
    const contract = requireApprovalToolContract('transactions.expense.create');
    let effects = 0;
    const flakyWrites = {
      createExpense: async () => {
        effects += 1;
        throw new Error('connection lost after commit: secret-prompt-content must not leak');
      },
    };
    await expect(
      contract.executor(baseCtx(flakyWrites as unknown as WriteStore)),
    ).rejects.toMatchObject({ code: APPROVAL_EXECUTION_UNCERTAIN_CODE });
    expect(effects).toBe(1);
  });

  it('pending-v2: DomainError do executor persiste failed com retry; retry com mesma key fecha com 1 efeito', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' };
    const key = randomUUID();
    const base = {
      version: 2 as const,
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
      tool: 'transactions.expense.create',
      normalizedArgs: validExpenseArgs(),
      proposalHash: '',
      idempotencyKey: key,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      bindings: { ...identity },
    };
    const saved = await store.propose({ ...base, proposalHash: await computePendingOperationV2Hash(base) });
    const confirmed = await store.confirm(saved.id, identity);

    // Tentativa 1: categoria inexistente — DomainError pré-write, nada gravou.
    let effects = 0;
    const seenKeys: string[] = [];
    const failingWrites = {
      createExpense: async (_ws: string, _args: unknown, opts: { idempotencyKey: string }) => {
        seenKeys.push(opts.idempotencyKey);
        throw domainErrors.notFound('Categoria');
      },
    };
    const contract = requireApprovalToolContract('transactions.expense.create');
    await expect(
      store.execute(confirmed.attestation!, identity, (op) =>
        contract.executor({
          writes: failingWrites as unknown as WriteStore,
          workspaceId: op.workspaceId,
          args: op.normalizedArgs,
          idempotencyKey: op.idempotencyKey,
          actorId: op.actorId,
        }),
      ),
    ).rejects.toBeInstanceOf(DomainError);

    const failed = await store.get(saved.id, identity);
    expect(failed.status).toBe('failed');
    expect(failed.failureCode).toBe('not_found');
    expect(
      store.audit.filter((e) => e.operationId === saved.id && e.event === 'fail'),
    ).toHaveLength(1);
    expect(effects).toBe(0);

    // Retry permitido: mesma key, writer corrigido → 1 efeito, succeeded.
    const retried = await store.retry(saved.id, identity);
    expect(retried.status).toBe('confirmed');
    const fixedWrites = {
      createExpense: async (_ws: string, _args: unknown, opts: { idempotencyKey: string }) => {
        seenKeys.push(opts.idempotencyKey);
        const existing = effects;
        effects += 1;
        return { id: `tx-${opts.idempotencyKey}-${existing}` };
      },
    };
    const recovered = await store.execute(retried.attestation!, identity, (op) =>
      contract.executor({
        writes: fixedWrites as unknown as WriteStore,
        workspaceId: op.workspaceId,
        args: op.normalizedArgs,
        idempotencyKey: op.idempotencyKey,
        actorId: op.actorId,
      }),
    );
    expect(recovered.status).toBe('succeeded');
    expect(effects).toBe(1);
    expect(seenKeys).toEqual([key, key]);
  });
});
