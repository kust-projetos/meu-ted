/**
 * T0.1 — Approval Tool Contract registry (SPEC §7.5).
 *
 * Single source of contract per V2 approval tool:
 * { tool, inputSchema, approvalRequired, executor }.
 *
 * Reuses the canonical zod schemas from writes/types.ts (no copies).
 * Reconciliation effects (affectedTargets) belong to the future Mutation
 * Effects Registry (T3.2) and MUST NOT appear here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_TOOL_IDS,
  deactivateAccountArgsSchema,
  getApprovalToolContract,
  requireApprovalToolContract,
  validateApprovalToolArgs,
} from '../../src/approvals/tool-registry.js';
import {
  createAccountInputSchema,
  createExpenseInputSchema,
  createIncomeInputSchema,
} from '../../src/writes/types.js';
import { createPendingOperationV2Executor } from '../../src/routes/index.js';
import { createInMemoryStores } from '../../src/writes/in-memory.js';

const EXPECTED_TOOLS = ['transactions.expense.create', 'transactions.income.create', 'transactions.update', 'accounts.create', 'accounts.deactivate', 'accounts.update', 'categories.create', 'categories.update', 'categories.deactivate'] as const;

// Manual-only tools: never auto-executed (absent from
// AUTOEXECUTION_ELIGIBLE_TOOLS, contract pin autoExecutionEligible=false).
const MANUAL_ONLY_TOOLS = ['transactions.update', 'accounts.create', 'accounts.deactivate', 'accounts.update', 'categories.create', 'categories.update', 'categories.deactivate'] as const;

describe('T0.1: Approval Tool Contract registry', () => {
  it('registers exactly the six V2 mutable tools', () => {
    expect([...APPROVAL_TOOL_IDS].sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of EXPECTED_TOOLS) {
      expect(getApprovalToolContract(tool)).toBeDefined();
    }
  });

  it('entries expose the required contract fields', () => {
    for (const tool of EXPECTED_TOOLS) {
      const contract = requireApprovalToolContract(tool);
      expect(contract.tool).toBe(tool);
      expect(contract.inputSchema).toBeDefined();
      expect(contract.approvalRequired).toBe(true);
      expect(typeof contract.executor).toBe('function');
    }
  });

  it('categories.deactivate has strict target+CAS arguments and is manual-only', () => {
    const contract = requireApprovalToolContract('categories.deactivate');
    const valid = { categoryId: '00000000-0000-4000-8000-000000000001', expectedName: 'QA Viagem Jade' };
    expect(contract.inputSchema.safeParse(valid).success).toBe(true);
    expect(contract.inputSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    expect(contract.inputSchema.safeParse({ categoryId: valid.categoryId }).success).toBe(false);
    expect(contract.autoExecutionEligible).toBe(false);
  });

  it('transactions.update accepts only a target and description CAS pair and is manual-only', () => {
    const contract = requireApprovalToolContract('transactions.update');
    const valid = {
      transactionId: '00000000-0000-4000-8000-000000000001',
      description: 'Mercado da semana',
      expectedDescription: 'Mercado',
    };
    expect(contract.inputSchema.safeParse(valid).success).toBe(true);
    expect(contract.inputSchema.safeParse({ ...valid, amountCents: 500 }).success).toBe(false);
    expect(contract.inputSchema.safeParse({ ...valid, date: '2026-10-20' }).success).toBe(false);
    expect(contract.inputSchema.safeParse({ ...valid, accountId: '00000000-0000-4000-8000-000000000002' }).success).toBe(false);
    expect(contract.inputSchema.safeParse({ ...valid, expectedDescription:'   ' }).success).toBe(false);
    expect(contract.autoExecutionEligible).toBe(false);
  });

  it('transactions.update refuses missing server-bound actor before invoking the keyed writer', async()=>{
    const {writes}=createInMemoryStores();
    const writer=vi.spyOn(writes,'editTransactionDescription');
    await expect(requireApprovalToolContract('transactions.update').executor({
      writes,workspaceId:'ws',args:{transactionId:'00000000-0000-4000-8000-000000000001',description:'Novo',expectedDescription:'Atual'},idempotencyKey:'server-bound-key',actorId:'',
    })).rejects.toThrow('validation.invalid_actor');
    expect(writer).not.toHaveBeenCalled();
  });

  it('reuses the canonical zod schemas from writes/types.ts (no duplicated copies)', () => {
    expect(requireApprovalToolContract('transactions.expense.create').inputSchema).toBe(
      createExpenseInputSchema,
    );
    expect(requireApprovalToolContract('transactions.income.create').inputSchema).toBe(
      createIncomeInputSchema,
    );
    expect(requireApprovalToolContract('accounts.create').inputSchema).toBe(
      createAccountInputSchema,
    );
    // accounts.deactivate is a V2-protocol envelope (accountId key +
    // display-only extras), not a WriteStore input shape, so its schema is
    // protocol-owned here — keyed on accountId, strict against unknowns.
    expect(requireApprovalToolContract('accounts.deactivate').inputSchema).toBe(
      deactivateAccountArgsSchema,
    );
    expect(
      deactivateAccountArgsSchema.safeParse({ accountId: '00000000-0000-4000-8000-000000000001' }).success,
    ).toBe(true);
    expect(deactivateAccountArgsSchema.safeParse({ accountId: 'not-a-uuid' }).success).toBe(false);
    expect(
      deactivateAccountArgsSchema.safeParse({ accountId: '00000000-0000-4000-8000-000000000001', bogus: 1 }).success,
    ).toBe(false);
  });

  it('unknown/unregistered mutable tool lookup resolves to undefined', () => {
    expect(getApprovalToolContract('transactions.transfer.create')).toBeUndefined();
    expect(getApprovalToolContract('whatever.else')).toBeUndefined();
  });

  it('unknown/unregistered mutable tool is rejected with code tool.not_allowed', () => {
    try {
      requireApprovalToolContract('transactions.transfer.create');
      expect.unreachable('should have thrown tool.not_allowed');
    } catch (error) {
      expect((error as Error).message).toBe('tool.not_allowed');
      expect((error as { code?: string }).code).toBe('tool.not_allowed');
    }
  });

  it('validateApprovalToolArgs rejects unknown tools with tool.not_allowed', () => {
    const result = validateApprovalToolArgs('transactions.transfer.create', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('tool.not_allowed');
    }
  });

  it('validateApprovalToolArgs validates known tools against the canonical schema', () => {
    const valid = validateApprovalToolArgs('transactions.expense.create', {
      description: 'Lunch',
      amountCents: 1000,
      date: '2026-09-14',
      accountId: '00000000-0000-4000-8000-000000000001',
      categoryId: '00000000-0000-4000-8000-000000000002',
    });
    expect(valid.success).toBe(true);
    const invalid = validateApprovalToolArgs('transactions.expense.create', {});
    expect(invalid.success).toBe(false);
  });

  it('entries expose no affectedTargets (Mutation Effects Registry separation, T3.2)', () => {
    for (const tool of EXPECTED_TOOLS) {
      const contract = requireApprovalToolContract(tool) as unknown as Record<string, unknown>;
      expect(contract).not.toHaveProperty('affectedTargets');
      expect(Object.keys(contract).sort()).toEqual(
        ['approvalRequired', 'authorizationPolicy', 'autoExecutionEligible', 'executor', 'inputSchema', 'tool'].sort(),
      );
      expect(contract.authorizationPolicy).toBe('risk_based');
      // Manual-only pin: transaction tools stay auto-executable-eligible,
      // account tools never are.
      expect(contract.autoExecutionEligible).toBe(
        !(MANUAL_ONLY_TOOLS as readonly string[]).includes(tool),
      );
    }
  });

  it('the V2 executor consumes the registry and still rejects unknown tools', async () => {
    const { writes } = createInMemoryStores();
    const executor = createPendingOperationV2Executor(writes);
    const base = {
      version: 2 as const,
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      deviceId: 'device-1',
      normalizedArgs: {},
      proposalHash: 'h',
      idempotencyKey: 'k-unknown-tool',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      bindings: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
    };
    await expect(
      executor({ ...base, tool: 'transactions.transfer.create' }),
    ).rejects.toMatchObject({ message: 'tool.not_allowed' });
  });

  it('the V2 executor still executes both registered tools end to end', async () => {
    const { state, writes } = createInMemoryStores();
    const acc = await writes.createAccount('ws-1', { name: 'A', kind: 'bank', initialBalanceCents: 10_000 });
    const catExp = await writes.createCategory('ws-1', { name: 'Food', kind: 'expense' });
    const catInc = await writes.createCategory('ws-1', { name: 'Salary', kind: 'income' });
    const executor = createPendingOperationV2Executor(writes);
    const base = {
      version: 2 as const,
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      deviceId: 'device-1',
      proposalHash: 'h',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      bindings: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
    };
    const expense = (await executor({
      ...base,
      tool: 'transactions.expense.create',
      normalizedArgs: {
        description: 'Lunch', amountCents: 1000, date: '2026-09-14',
        accountId: acc.id, categoryId: catExp.id,
      },
      idempotencyKey: 'k-exec',
    })) as { status: string; operationId: string };
    const income = (await executor({
      ...base,
      tool: 'transactions.income.create',
      normalizedArgs: {
        description: 'Pay', amountCents: 500, date: '2026-09-14',
        accountId: acc.id, categoryId: catInc.id,
      },
      idempotencyKey: 'k-inc',
    })) as { status: string; operationId: string; receipt: { mutationId: string; mutationKind: string; status: string; affectedTargets: string[]; operationId: string } };
    expect(expense.status).toBe('succeeded');
    expect(income.status).toBe('succeeded');
    expect(state.transactions).toHaveLength(2);
    // T3.2 (SPEC §15.1): the TED executor result carries a receipt with the
    // origin operationId and registry-derived targets (additive envelope).
    expect(expense.receipt).toBeTruthy();
    expect(expense.receipt.mutationKind).toBe('transactions.expense.create');
    expect(expense.receipt.status).toBe('succeeded');
    expect(expense.receipt.operationId).toBe(expense.operationId);
    expect(expense.receipt.affectedTargets.length).toBeGreaterThan(0);
    expect(income.receipt.operationId).toBe(income.operationId);
    expect(income.receipt.mutationId).not.toBe(expense.receipt.mutationId);
  });

  it('categories.deactivate uses the keyed writer and returns a bound category receipt', async () => {
    const { state, writes } = createInMemoryStores({
      categories: [{ id: '00000000-0000-4000-8000-000000000001', householdId: 'ws-1', name: 'QA Viagem Jade', kind: 'expense', status: 'active' }],
    });
    const executor = createPendingOperationV2Executor(writes);
    const result = await executor({
      version: 2, workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1',
      tool: 'categories.deactivate',
      normalizedArgs: { categoryId: '00000000-0000-4000-8000-000000000001', expectedName: 'QA Viagem Jade' },
      proposalHash: 'h', idempotencyKey: 'key-deactivate-category',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      bindings: { workspaceId: 'ws-1', actorId: 'actor-1', deviceId: 'device-1' },
    }) as { status: string; operationId: string; receipt: { mutationKind: string; operationId: string; entity: { type: string; id: string } } };
    expect(result.status).toBe('succeeded');
    expect(result.operationId).toBe('00000000-0000-4000-8000-000000000001');
    expect(result.receipt).toMatchObject({ mutationKind: 'categories.deactivate', operationId: result.operationId, entity: { type: 'category', id: result.operationId } });
    expect(state.categories[0]?.status).toBe('inactive');
  });
});
