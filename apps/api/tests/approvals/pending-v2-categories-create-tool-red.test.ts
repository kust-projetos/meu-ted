/**
 * RED (categories-create-v2-endtoend): contrato estrito + executor + receipt.
 * - tool `categories.create` registrado, manual-only, strict {name,kind,parentId?}
 * - executor keyed propaga idempotencyKey, receipt kind categories.create + entity category
 * - mismatch (entity transaction / kind divergente) nunca success
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getApprovalToolContract, validateApprovalToolArgs } from '../../src/approvals/tool-registry.js';
import { buildPendingOperationPresentation } from '../../src/approvals/presentation.js';
import { isActionablePendingOperationPresentation } from '@pi-finance/llm-contracts/types';

describe('RED categories.create tool contract', () => {
  it('registra categories.create como manual-only strict', () => {
    const contract = getApprovalToolContract('categories.create');
    expect(contract).toBeDefined();
    expect(contract!.approvalRequired).toBe(true);
    expect(contract!.autoExecutionEligible).toBe(false);
  });

  it('aceita args estritos name/kind/parentId?', () => {
    const parentId = randomUUID();
    const ok = validateApprovalToolArgs('categories.create', { name: 'Mercado', kind: 'expense', parentId });
    expect(ok.success).toBe(true);
    const noParent = validateApprovalToolArgs('categories.create', { name: 'Salário', kind: 'income' });
    expect(noParent.success).toBe(true);
  });

  it('rejeita kind fora do vocabulário e campo extra', () => {
    expect(validateApprovalToolArgs('categories.create', { name: 'X', kind: 'bank' }).success).toBe(false);
    expect(validateApprovalToolArgs('categories.create', { name: 'X', kind: 'expense', icon: 'Y' }).success).toBe(false);
    expect(validateApprovalToolArgs('categories.create', { name: '  ', kind: 'expense' }).success).toBe(false);
    expect(validateApprovalToolArgs('categories.create', { name: 'X', kind: 'expense', parentId: 'not-uuid' }).success).toBe(false);
  });

  it('presentation carrega nome/tipo/pai reais e é acionável', () => {
    const parentId = randomUUID();
    const presentation = buildPendingOperationPresentation({
      id: 'op-1',
      status: 'proposed',
      tool: 'categories.create',
      normalizedArgs: { name: 'Mercado', kind: 'expense', parentId },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      categoryLabel: 'Alimentação',
    });
    expect(presentation).not.toBeNull();
    expect(presentation!.tool).toBe('categories.create');
    expect(isActionablePendingOperationPresentation(presentation!)).toBe(true);
  });

  it('presentation sem nome ou kind não é acionável', () => {
    const missing = buildPendingOperationPresentation({
      id: 'op-1',
      status: 'proposed',
      tool: 'categories.create',
      normalizedArgs: { name: 'Mercado', kind: 'expense' },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    // sem pai ainda é acionável (raiz); sem nome/kind nunca
    expect(missing).not.toBeNull();
    const noKind = buildPendingOperationPresentation({
      id: 'op-1',
      status: 'proposed',
      tool: 'categories.create',
      normalizedArgs: { name: 'Mercado' },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(noKind === null || !isActionablePendingOperationPresentation(noKind!)).toBe(true);
  });

  it('R7-F7a: parentId sem label resolvido → presentation nula (nunca acionável)', () => {
    const parentId = randomUUID();
    // Pai resolvido: card com Pai + acionável.
    const resolved = buildPendingOperationPresentation({
      id: 'op-1',
      status: 'proposed',
      tool: 'categories.create',
      normalizedArgs: { name: 'Mercado', kind: 'expense', parentId },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      categoryLabel: 'Alimentação',
    });
    expect(resolved).not.toBeNull();
    expect(isActionablePendingOperationPresentation(resolved!)).toBe(true);
    // Pai exigido mas sem label (removido/nunca existiu aqui): nulo —
    // raiz explícita (sem parentId) segue acionável pelo caso acima.
    const gone = buildPendingOperationPresentation({
      id: 'op-1',
      status: 'proposed',
      tool: 'categories.create',
      normalizedArgs: { name: 'Mercado', kind: 'expense', parentId },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(gone).toBeNull();
  });

  it('executor propaga idempotencyKey e emite receipt category', async () => {
    const { createInMemoryStores } = await import('../../src/writes/in-memory.js');
    const { writes } = createInMemoryStores();
    const contract = getApprovalToolContract('categories.create')!;
    const out = await contract.executor({
      writes,
      workspaceId: 'ws-1',
      args: { name: 'Mercado', kind: 'expense' },
      idempotencyKey: 'cat-key-1',
      actorId: 'actor-1',
    }) as { status: string; operationId: string; receipt: { mutationKind: string; operationId: string; entity?: { type: string; id: string } } };
    expect(out.status).toBe('succeeded');
    expect(out.receipt.mutationKind).toBe('categories.create');
    expect(out.receipt.operationId).toBe(out.operationId);
    expect(out.receipt.entity?.type).toBe('category');
    expect(out.receipt.entity?.id).toBe(out.operationId);
    const replay = await contract.executor({
      writes,
      workspaceId: 'ws-1',
      args: { name: 'Mercado', kind: 'expense' },
      idempotencyKey: 'cat-key-1',
      actorId: 'actor-1',
    }) as { operationId: string };
    expect(replay.operationId).toBe(out.operationId);
  });
});
