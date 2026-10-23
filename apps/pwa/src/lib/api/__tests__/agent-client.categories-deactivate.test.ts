import { afterEach, describe, expect, it, vi } from 'vitest';
import { decidePendingOperation, fetchActivePendingOperations, sendAgentMessage } from '../agent-client';
import * as agentAuth from '../agent-auth';

const presentation = {
  id: 'op-category-deactivate', status: 'proposed', tool: 'categories.deactivate', title: 'Desativar categoria',
  category: { id: 'cat-jade', label: 'QA Viagem Jade' }, categoryName: 'QA Viagem Jade', categoryKind: 'expense',
  categoryParent: { id: 'parent-food', label: 'QA Alimentação' },
  expiresAt: '2026-10-22T12:10:00.000Z', warnings: [],
};
const receipt = {
  mutationId: 'mut-category-deactivate', mutationKind: 'categories.deactivate', status: 'succeeded',
  affectedTargets: ['categories', 'transactions'], operationId: 'op-category-deactivate',
  entity: { type: 'category', id: 'cat-jade' },
};
const stub = () => {
  vi.stubEnv('NEXT_PUBLIC_PI_FINANCE_AGENT_BASE_URL', 'https://agent.example.test');
  vi.spyOn(agentAuth, 'fetchAgentConnectionToken').mockResolvedValue('signed-token');
};

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('categories.deactivate PWA contract', () => {
  it('active list parser keeps server presentation and category label', async () => {
    stub();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ items: [{ id: presentation.id, status: presentation.status, tool: presentation.tool, createdAt: '2026-10-22T12:00:00.000Z', expiresAt: presentation.expiresAt, categoryId: 'cat-jade', presentation }], total: 1 }));
    const items = await fetchActivePendingOperations('ws');
    expect(items[0]?.presentation).toMatchObject({ tool: 'categories.deactivate', category: { id: 'cat-jade', label: 'QA Viagem Jade' }, categoryKind: 'expense', categoryParent: { id: 'parent-food', label: 'QA Alimentação' } });
  });

  it('decision parser accepts only a succeeded receipt for the exact pending tool and category target', async () => {
    stub();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ operationId: 'op-category-deactivate', status: 'succeeded', receipt }));
    const decision = await decidePendingOperation('ws', 'op-category-deactivate', 'confirm', { tool: 'categories.deactivate', entityId: 'cat-jade' });
    expect(decision.status).toBe('succeeded');
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ operationId: 'op-category-deactivate', status: 'succeeded', receipt: { ...receipt, entity: { type: 'category', id: 'cat-other' } } }));
    await expect(decidePendingOperation('ws', 'op-category-deactivate', 'confirm', { tool: 'categories.deactivate', entityId: 'cat-jade' })).rejects.toMatchObject({ code: 'agent.execution_outcome_unknown' });
    await expect(decidePendingOperation('ws', 'op-category-deactivate', 'confirm')).rejects.toMatchObject({ code: 'agent.execution_outcome_unknown' });
  });

  it('turn parser rejects a receipt that names another category', async () => {
    stub();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      turnId: 'turn-deactivate', status: 'completed', output: 'Desativada.',
      pendingOperation: { id: 'op-category-deactivate', status: 'succeeded', operation: 'categories.deactivate', presentation, receipt: { ...receipt, entity: { type: 'category', id: 'cat-other' } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(sendAgentMessage('ws', 'desative categoria QA Viagem Jade')).rejects.toMatchObject({ code: 'agent.execution_outcome_unknown' });
  });
});
