import { describe, expect, it, vi } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../../src/orchestration/conversation-orchestrator.js';
import { MutationApiClient } from '../../src/mutations/mutation-api-client.js';
import { createSanitizedEvent } from '../../src/observability/events.js';
import { logFailoverEvent } from '../../src/llm/failover.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-authenticated',
  workspaceId: 'workspace-authenticated',
  role: 'member',
  deviceId: 'device-authenticated',
};

const PROMPT = 'Qual é o meu saldo de R$ 1.234,56 secreto?';
const RESPONSE = 'Sua fatura de R$ 9.999,99 vence hoje, token=abc123.';

describe('AGENT-010 sanitized lifecycle events', () => {
  it('emits turn/plan/turn events with allowlisted fields only — no raw prompt, response or financial payload', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const orchestrator = new ConversationOrchestrator({
      plan: () => ({
        version: '2', mode: 'read', domain: 'accounts', skillNames: ['s'],
        requestedOperations: [{ name: 'get_balance', kind: 'read' }], missingFields: [], ambiguity: null, confidence: 1,
      }),
      responseProvider: async () => RESPONSE,
      events: (type, fields) => seen.push({ type, fields }),
    });
    await orchestrator.runTurn(normalizeRestTurn({ text: PROMPT, intentionId: 'intent-evt' }, identity));
    const types = seen.map((e) => e.type);
    expect(types).toContain('turn.started');
    expect(types).toContain('plan.validated');
    expect(types).toContain('turn.completed');
    const blob = JSON.stringify(seen);
    expect(blob).not.toMatch(/1\.234,56|9\.999,99|abc123/);
    expect(blob).not.toContain(PROMPT);
    expect(blob).not.toContain(RESPONSE);
  });

  it('emits tool + approval + mutation events on the mutation flow without payloads', async () => {
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    const request = vi.fn()
      .mockResolvedValueOnce({ id: 'pending-1' })
      .mockResolvedValueOnce({
        items: [{
          id: 'pending-1', status: 'proposed', tool: 'transactions.expense.create',
          createdAt: '2026-09-14T00:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z',
        }],
        total: 1,
      })
      .mockResolvedValueOnce({ id: 'pending-1', attestation: 'a'.repeat(32) })
      .mockResolvedValueOnce({ id: 'pending-1', status: 'succeeded', execution: { status: 'succeeded', operationId: 'mut-pending-1', receipt: { mutationId: 'mut-pending-1', mutationKind: 'transactions.expense.create', status: 'succeeded', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'], operationId: 'pending-1', entity: { type: 'transaction', id: 'mut-pending-1' } } } });
    const api = new MutationApiClient({ request, events: (type, fields) => seen.push({ type, fields }) });
    const planner = vi.fn()
      .mockReturnValueOnce({
        version: '2', mode: 'mutation-proposal', domain: 'transactions', skillNames: ['t'],
        requestedOperations: [{ name: 'create_expense', kind: 'mutation' }], missingFields: [], ambiguity: null, confidence: 1,
      })
      .mockReturnValueOnce({
        version: '2', mode: 'confirmation', domain: 'transactions', skillNames: ['t'],
        requestedOperations: [{ name: 'create_expense', kind: 'mutation' }], missingFields: [], ambiguity: null, confidence: 1,
      });
    const orchestrator = new ConversationOrchestrator({
      mutationApiClient: api, plan: planner, events: (type, fields) => seen.push({ type, fields }),
      // SPEC §7.2/§7.3: single account auto-resolves, UUID category verified.
      entityReader: {
        listAccounts: async () => [{ id: '00000000-0000-4000-8000-0000000000a1', name: 'Nubank' }],
        listCategories: async () => [{ id: '00000000-0000-4000-8000-000000000001', name: 'Mercado' }],
      },
    });
    await orchestrator.runTurn(normalizeRestTurn({ text: 'gastei R$ 12,34 no mercado na categoria 00000000-0000-4000-8000-000000000001', intentionId: 'intent-mut' }, identity));
    await orchestrator.runTurn(normalizeRestTurn({ text: 'confirmo', intentionId: 'intent-mut', pendingOperationIds: ['pending-1'] }, identity));
    const types = seen.map((e) => e.type);
    for (const expected of ['tool.started', 'tool.completed', 'approval.requested', 'approval.confirmed', 'mutation.executed', 'turn.completed']) {
      expect(types).toContain(expected);
    }
    const blob = JSON.stringify(seen);
    expect(blob).not.toMatch(/12,34|pending-1|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  });

  it('createSanitizedEvent never leaks financial values, secrets or technical ids', () => {
    const event = createSanitizedEvent('turn.completed', {
      intentionId: 'intent-secret', channel: 'pwa-rest', domain: 'accounts', mode: 'read',
      status: 'completed', latencyMs: 42, prompt: PROMPT, response: RESPONSE, balance: 1234.56,
    });
    const blob = JSON.stringify(event);
    expect(blob).not.toMatch(/1\.234,56|9\.999,99|abc123|intent-secret|1234\.56/);
    expect(event.eventType).toBe('turn.completed');
  });

  it('provider.fallback carries routing metadata only', () => {
    const lines: string[] = [];
    logFailoverEvent(
      { intentionId: 'intent-fb', primaryProviderId: 'openai', primaryModelId: 'gpt-x', fallbackProviderId: 'anthropic', fallbackModelId: 'claude-y' },
      { usedFallback: true, failoverReason: 'http_500' },
      (line) => lines.push(line),
    );
    const blob = lines.join('\n');
    expect(blob).toContain('provider.fallback');
    expect(blob).toContain('openai');
    expect(blob).not.toMatch(/prompt|transcript|R\$/);
  });
});
