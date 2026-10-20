/**
 * CODER-H-STATEMENTS — ausência de statements responde "faturas".
 *
 * "Mostre minhas faturas" tem domain `payables` (não há domain `statements`
 * no contrato) mas a leitura que prova a ausência é `api.statements`
 * (READ_SOURCE.statements — channel-evidence.ts). O render de ausência
 * usava só `plan.domain`, então a fatura nua respondia "contas a pagar".
 */
import { describe, expect, it } from 'vitest';
import {
  ConversationOrchestrator,
  normalizeRestTurn,
  type AuthenticatedIdentity,
} from '../src/orchestration/conversation-orchestrator.js';

const identity: AuthenticatedIdentity = {
  actorId: 'actor-h-statements',
  workspaceId: 'ws-h-statements',
  role: 'member',
  deviceId: 'device-h-statements',
};

const turn = (text: string, intentionId: string) =>
  normalizeRestTurn({ text, intentionId }, identity);

const absenceEnvelope = (source: string) => ({
  version: '1' as const,
  items: [
    {
      ref: 'absence',
      source,
      retrievedAt: new Date().toISOString(),
      status: 'empty' as const,
      data: [],
      reason: 'setup_incomplete' as const,
    },
  ],
});

// Plano real do roteador para "Mostre minhas faturas": domain `payables`
// com `list_statements` (S3/#257) — nunca `list_cards`.
const faturaPlan = () =>
  ({
    version: '2' as const,
    mode: 'read' as const,
    domain: 'payables',
    skillNames: [],
    requestedOperations: [{ name: 'list_statements', kind: 'read' as const }],
    missingFields: [],
    ambiguity: null,
    confidence: 0.95,
  }) as never;

const payablesPlan = () =>
  ({
    version: '2' as const,
    mode: 'read' as const,
    domain: 'payables',
    skillNames: [],
    requestedOperations: [{ name: 'list_payables', kind: 'read' as const }],
    missingFields: [],
    ambiguity: null,
    confidence: 0.95,
  }) as never;

describe('H-STATEMENTS: ausência de statements responde "faturas"', () => {
  it('plano fatura + statements empty → "fatura", nunca "conta a pagar"', async () => {
    const orchestrator = new ConversationOrchestrator({
      plan: () => faturaPlan(),
      evidenceProvider: async () => absenceEnvelope('api.statements'),
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(turn('Mostre minhas faturas', 'intent-h-statements'));
    expect(result.response?.text).toMatch(/fatura/i);
    expect(result.response?.text).not.toMatch(/conta a pagar/i);
  });

  it('regressão: plano payables + payables empty → "contas a pagar"', async () => {
    const orchestrator = new ConversationOrchestrator({
      plan: () => payablesPlan(),
      evidenceProvider: async () => absenceEnvelope('api.payables'),
      events: () => undefined,
    });
    const result = await orchestrator.runTurn(turn('mostre os boletos', 'intent-h-payables'));
    expect(result.response?.text).toContain('contas a pagar');
  });
});
