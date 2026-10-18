import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computePendingOperationV2Hash, type PendingOperationV2 } from '@pi-finance/llm-contracts';
import {
  createInMemoryPendingOperationV2Store,
  PENDING_V2_AUDIT_BUFFER_MAX,
} from '../../src/approvals/pending-v2.js';

/**
 * T12b / API-04: buffer diagnóstico `store.audit` com teto explícito.
 *
 * Contexto: `store.audit` é superfície de diagnóstico/teste apenas — nenhum
 * caminho de produção o lê (estado autoritativo vive nos records; auditoria
 * durável de negócio vive em `audit_logs`). Antes do teto, um evento por
 * operação acumulava durante toda a vida do processo (RED provado:
 * 1000 proposes → audit.length 1000, sem bound).
 *
 * Contrato GREEN:
 * - teto PENDING_V2_AUDIT_BUFFER_MAX respeitado (length nunca excede);
 * - política drop-oldest (o mais antigo é evictado; o mais recente permanece);
 * - truncamento determinístico via `auditDropped` (0 sem overflow);
 * - eventos essenciais do fluxo decisório intactos dentro do teto
 *   (propose→confirm→execute em ordem; estado/recibo da operação preservados).
 */
const proposal = async (idempotencyKey: string): Promise<PendingOperationV2> => {
  const base = {
    version: 2 as const,
    workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1',
    tool: 'transactions.expense.create',
    normalizedArgs: {
      description: 'buffer probe',
      amountCents: 100,
      date: '2026-09-14',
      accountId: randomUUID(),
      categoryId: randomUUID(),
    },
    proposalHash: '', idempotencyKey,
    createdAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bindings: { workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1' },
  };
  return { ...base, proposalHash: await computePendingOperationV2Hash(base) };
};

describe('pending-v2 audit buffer bound (T12b/API-04)', () => {
  it('não cresce sem limite: centenas de operações cabem no teto', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const total = PENDING_V2_AUDIT_BUFFER_MAX + 50;
    for (let i = 0; i < total; i += 1) {
      await store.propose(await proposal(`idem-buffer-${i}`));
    }
    expect(store.audit.length).toBe(PENDING_V2_AUDIT_BUFFER_MAX);
  });

  it('evicta o mais antigo e indica truncamento via auditDropped', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const total = PENDING_V2_AUDIT_BUFFER_MAX + 25;
    for (let i = 0; i < total; i += 1) {
      await store.propose(await proposal(`idem-evict-${i}`));
    }
    expect(store.audit.length).toBe(PENDING_V2_AUDIT_BUFFER_MAX);
    // Drop-oldest: os 25 primeiros proposes foram evictados; o buffer retém
    // exatamente os 200 mais recentes, em ordem.
    expect(store.auditDropped).toBe(25);
    expect(store.audit[0]).toMatchObject({ event: 'propose', actorId: 'actor-1' });
    expect(store.audit.at(-1)).toMatchObject({ event: 'propose', actorId: 'actor-1' });
    const firstKeptAt = Date.parse(store.audit[0]!.at);
    const lastKeptAt = Date.parse(store.audit.at(-1)!.at);
    expect(lastKeptAt).toBeGreaterThanOrEqual(firstKeptAt);
    // Nenhum evento retido pertence aos proposes evictados: todos os
    // operationIds retidos são distintos e somam exatamente o teto.
    const ids = new Set(store.audit.map((e) => e.operationId));
    expect(ids.size).toBe(PENDING_V2_AUDIT_BUFFER_MAX);
  });

  it('sem overflow: nenhum descarte e eventos essenciais do fluxo intactos', async () => {
    const store = createInMemoryPendingOperationV2Store();
    const identity = { workspaceId: 'workspace-1', actorId: 'actor-1', deviceId: 'device-1' };
    const p = await proposal('idem-essential-flow');
    const saved = await store.propose(p);
    expect(store.auditDropped).toBe(0);
    const confirmed = await store.confirm(saved.id, identity);
    const result = await store.execute(confirmed.attestation!, identity, async () => ({
      status: 'succeeded', operationId: 'op-essential-flow',
    }));
    expect(result.status).toBe('succeeded');
    // Eventos essenciais do fluxo decisório presentes e ordenados.
    const flow = store.audit.filter((e) => e.operationId === saved.id).map((e) => e.event);
    expect(flow).toEqual(['propose', 'confirm', 'execute']);
    expect(store.auditDropped).toBe(0);
    // O fluxo decisório (estado/recibo) não depende do buffer e segue intacto.
    const reread = await store.get(saved.id, identity);
    expect(reread.status).toBe('succeeded');
    expect(reread.mutationId).toBe(result.mutationId);
  });
});
