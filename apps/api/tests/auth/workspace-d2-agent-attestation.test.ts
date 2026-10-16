import { describe, expect, it } from 'vitest';
import {
  agentEmptyProofCanonical,
  signAgentEmptyProof,
  verifyAgentEmptyProof,
  type AgentEmptyCounts,
} from '../../src/auth/workspace-deletion.js';

const TEST_SECRET = 'test-only-workspace-deletion-hmac-secret';
const WS_ID = '11111111-1111-4111-8111-111111111111';
const VERSION = 'a'.repeat(64);
const ZERO: AgentEmptyCounts = { sessions: 0, messages: 0, memories: 0, attachments: 0 };

/**
 * FIX-WS-D2-R4 — atestação HMAC server-side Agent→API (substitui o
 * bloqueio total da R3-item-1, mantendo fail-closed sem ela).
 * RED first: `signAgentEmptyProof`/`verifyAgentEmptyProof` não existem.
 */
describe('R4 — atestação HMAC do lado Agent (emissão/verificação puras)', () => {
  it('prova válida verifica (vazio real, HMAC íntegro, dentro da janela)', () => {
    const proof = signAgentEmptyProof({ workspaceId: WS_ID, inventoryVersion: VERSION, counts: ZERO }, TEST_SECRET);
    expect(proof.workspaceId).toBe(WS_ID);
    expect(proof.inventoryVersion).toBe(VERSION);
    expect(proof.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      verifyAgentEmptyProof(proof, { workspaceId: WS_ID, inventoryVersion: VERSION, secret: TEST_SECRET }),
    ).not.toThrow();
  });

  it('emissão recusa assinar não-vazio (fail-closed na origem)', () => {
    expect(() =>
      signAgentEmptyProof(
        { workspaceId: WS_ID, inventoryVersion: VERSION, counts: { ...ZERO, memories: 2 } },
        TEST_SECRET,
      ),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
  });

  it('HMAC adulterado é recusado (409 agent_unverified)', () => {
    const proof = signAgentEmptyProof({ workspaceId: WS_ID, inventoryVersion: VERSION, counts: ZERO }, TEST_SECRET);
    expect(() =>
      verifyAgentEmptyProof(
        { ...proof, hmac: '0'.repeat(64) },
        { workspaceId: WS_ID, inventoryVersion: VERSION, secret: TEST_SECRET },
      ),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
  });

  it('contagem adulterada após a assinatura é recusada (vínculo HMAC)', () => {
    const proof = signAgentEmptyProof({ workspaceId: WS_ID, inventoryVersion: VERSION, counts: ZERO }, TEST_SECRET);
    // Atacante troca sessions 0→3 mantendo o HMAC original: diverge.
    expect(() =>
      verifyAgentEmptyProof(
        { ...proof, counts: { ...ZERO, sessions: 3 } },
        { workspaceId: WS_ID, inventoryVersion: VERSION, secret: TEST_SECRET },
      ),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
  });

  it('prova expirada é recusada (janela curta de 5 min)', () => {
    const proof = signAgentEmptyProof({ workspaceId: WS_ID, inventoryVersion: VERSION, counts: ZERO }, TEST_SECRET);
    const afterExpiry = Date.parse(proof.expiresAt) + 1000;
    expect(() =>
      verifyAgentEmptyProof(proof, { workspaceId: WS_ID, inventoryVersion: VERSION, secret: TEST_SECRET }, afterExpiry),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
  });

  it('workspace divergente é recusado (confirmation_invalid, sem efeito)', () => {
    const proof = signAgentEmptyProof({ workspaceId: WS_ID, inventoryVersion: VERSION, counts: ZERO }, TEST_SECRET);
    expect(() =>
      verifyAgentEmptyProof(proof, {
        workspaceId: '22222222-2222-4222-8222-222222222222',
        inventoryVersion: VERSION,
        secret: TEST_SECRET,
      }),
    ).toThrow(expect.objectContaining({ code: 'workspace.confirmation_invalid' }));
  });

  it('inventoryVersion divergente é recusado (confirmation_invalid)', () => {
    const proof = signAgentEmptyProof({ workspaceId: WS_ID, inventoryVersion: VERSION, counts: ZERO }, TEST_SECRET);
    expect(() =>
      verifyAgentEmptyProof(proof, { workspaceId: WS_ID, inventoryVersion: 'b'.repeat(64), secret: TEST_SECRET }),
    ).toThrow(expect.objectContaining({ code: 'workspace.confirmation_invalid' }));
  });

  it('sem segredo configurado = indisponível (409 agent_unverified, nunca conclui)', () => {
    const proof = signAgentEmptyProof({ workspaceId: WS_ID, inventoryVersion: VERSION, counts: ZERO }, TEST_SECRET);
    const saved = process.env.WORKSPACE_DELETION_HMAC_SECRET;
    delete process.env.WORKSPACE_DELETION_HMAC_SECRET;
    try {
      expect(() =>
        verifyAgentEmptyProof(proof, { workspaceId: WS_ID, inventoryVersion: VERSION, secret: undefined }),
      ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
    } finally {
      if (saved !== undefined) process.env.WORKSPACE_DELETION_HMAC_SECRET = saved;
    }
  });

  it('segredo errado nunca verifica (409 agent_unverified)', () => {
    const proof = signAgentEmptyProof({ workspaceId: WS_ID, inventoryVersion: VERSION, counts: ZERO }, TEST_SECRET);
    expect(() =>
      verifyAgentEmptyProof(proof, { workspaceId: WS_ID, inventoryVersion: VERSION, secret: 'attacker-without-secret' }),
    ).toThrow(expect.objectContaining({ code: 'workspace.agent_unverified' }));
  });

  it('canônico é byte-idêntico ao do Agent (vetor fixo cross-runtime)', () => {
    // Pino contra o Agent (`agentEmptyProofCanonical` em
    // `apps/agent/src/workspace-deletion-attestation.ts`): chaves
    // ordenadas, mesma ordem de campos. Mudar aqui sem mudar lá quebra
    // fail-closed.
    expect(agentEmptyProofCanonical(WS_ID, VERSION, ZERO, '2026-10-16T00:00:00.000Z')).toBe(
      `{"workspaceId":"${WS_ID}","inventoryVersion":"${VERSION}","counts":[["attachments",0],["memories",0],["messages",0],["sessions",0]],"expiresAt":"2026-10-16T00:00:00.000Z"}`,
    );
  });
});
