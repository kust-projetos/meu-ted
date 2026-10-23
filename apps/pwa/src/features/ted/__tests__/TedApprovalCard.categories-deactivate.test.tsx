import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@/lib/test-utils';
import userEvent from '@testing-library/user-event';
import { TedApprovalCard } from '../TedApprovalCard';
import * as agentClient from '@/lib/api/agent-client';

vi.mock('@/lib/api/agent-client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/api/agent-client')>(), decidePendingOperation: vi.fn() }));

const pending = {
  id: 'op-category-deactivate', status: 'proposed' as const, operation: 'categories.deactivate',
  presentation: {
    id: 'op-category-deactivate', status: 'proposed', tool: 'categories.deactivate', title: 'Desativar categoria',
    category: { id: 'cat-jade', label: 'QA Viagem Jade' }, categoryName: 'QA Viagem Jade', categoryKind: 'expense',
    categoryParent: { id: 'parent-food', label: 'QA Alimentação' },
    expiresAt: '2026-10-22T12:10:00.000Z', warnings: [],
  },
};

describe('TedApprovalCard categories.deactivate', () => {
  beforeEach(() => vi.mocked(agentClient.decidePendingOperation).mockReset());

  it('displays the exact category and honest dependency guard; confirmation is target-bound', async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({ operationId: pending.id, status: 'succeeded', receipt: { mutationId: 'm', mutationKind: 'categories.deactivate', status: 'succeeded', affectedTargets: ['categories', 'transactions'], operationId: pending.id, entity: { type: 'category', id: 'cat-jade' } } });
    render(<TedApprovalCard operation={pending} workspaceId="ws" />);
    expect(screen.getByText(/Desativar categoria/)).toBeInTheDocument();
    expect(screen.getByText('QA Viagem Jade')).toBeInTheDocument();
    expect(screen.getByText('Despesa')).toBeInTheDocument();
    expect(screen.getByText('Categoria pai')).toBeInTheDocument();
    expect(screen.getByText('QA Alimentação')).toBeInTheDocument();
    expect(screen.getByText(/apenas se não possuir registros ou dependências vinculados/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(agentClient.decidePendingOperation).toHaveBeenCalledWith('ws', pending.id, 'confirm', { tool: 'categories.deactivate', entityId: 'cat-jade' }));
  });

  it('without authoritative category label the card offers cancel only', () => {
    render(<TedApprovalCard operation={{ ...pending, presentation: { ...pending.presentation, category: undefined } }} workspaceId="ws" />);
    expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
  });

  it('renders authoritative in_use as terminal guidance without success or retry', () => {
    render(<TedApprovalCard operation={{ ...pending, status: 'failed', failureCode: 'in_use' }} workspaceId="ws" />);
    expect(screen.getByText('A categoria possui registros ou dependências vinculados e não foi desativada.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).not.toBeInTheDocument();
    expect(screen.queryByText(/registrada/)).not.toBeInTheDocument();
  });

  it('uses the verified in_use decision response and does not offer retry', async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({ operationId: pending.id, status: 'failed', retryable: false, failureCode: 'in_use' });
    render(<TedApprovalCard operation={pending} workspaceId="ws" />);
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByText('A categoria possui registros ou dependências vinculados e não foi desativada.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).not.toBeInTheDocument();
  });

  it('cancel remains available and targets the same pending proposal', async () => {
    const user = userEvent.setup();
    vi.mocked(agentClient.decidePendingOperation).mockResolvedValue({ operationId: pending.id, status: 'cancelled' });
    render(<TedApprovalCard operation={pending} workspaceId="ws" />);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(agentClient.decidePendingOperation).toHaveBeenCalledWith('ws', pending.id, 'cancel', { tool: 'categories.deactivate', entityId: 'cat-jade' }));
  });
});
