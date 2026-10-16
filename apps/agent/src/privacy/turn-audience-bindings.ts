/**
 * FIX-WS-D3-R3 — vínculo durável (workspace, actor, intentionId) → audiência.
 *
 * Residual HIGH do REVIEW-WS-D3-R2: turno privado persistido → resposta
 * perdida → renovação para coletiva → redelivery com o MESMO intentionId
 * capturava a audiência da sessão corrente (coletiva) e re-persistia a
 * pergunta privada como coletiva (republicação).
 *
 * Contrato:
 * - a audiência é vinculada ANTES dos awaits do turno, em tabela PRÓPRIA
 *   (`agent_turn_audience_bindings`, domínio distinto de
 *   `mutation_draft_intentions` e dos recibos/vínculos do forget — NUNCA
 *   reutilizar essas tabelas);
 * - first-writer-wins: o redelivery reutiliza o vínculo, nunca a sessão
 *   corrente; segunda escrita com audiência distinta perde sem erro;
 * - identidade canônica `(workspace_id, actor_id, intention_id)` (mesma
 *   disciplina do issue #102: `intentionId` é client-owned e colidiria
 *   globalmente);
 * - fail-closed: falha REAL de leitura/escrita propaga (o chamador converte
 *   em `agent.persistence_unavailable`); ausência de vínculo = `undefined`
 *   (intenção ainda livre), nunca default silencioso.
 */

import { normalizeVisibility, type ConversationAudience } from './conversation-visibility.js';
import type { MemorySql } from '../agent-config/memory/store.js';

export type TurnAudienceBindingInput = {
  workspaceId: string;
  actorId: string;
  intentionId: string;
  audience: ConversationAudience;
  createdAt: string;
};

export type TurnAudienceBindingKey = {
  workspaceId: string;
  actorId: string;
  intentionId: string;
};

/** Tabela própria do vínculo (aditiva, idempotente; sem migração destrutiva). */
export const initializeTurnAudienceBindingSchema = (sql: MemorySql): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_turn_audience_bindings (
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL DEFAULT '',
      intention_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'workspace',
      owner_actor_id TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, actor_id, intention_id)
    );
  `);
};

const mapRow = (row: Record<string, unknown>, fallback: TurnAudienceBindingKey): ConversationAudience => ({
  workspaceId: typeof row['workspace_id'] === 'string' ? String(row['workspace_id']) : fallback.workspaceId,
  visibility: normalizeVisibility(row['visibility']),
  ownerActorId:
    typeof row['owner_actor_id'] === 'string' && row['owner_actor_id']
      ? String(row['owner_actor_id'])
      : fallback.actorId,
  conversationId:
    typeof row['conversation_id'] === 'string' && row['conversation_id']
      ? String(row['conversation_id'])
      : '',
});

/** Vínculo existente (`undefined` = intenção ainda livre). Sem TTL: permanente. */
export const getTurnAudienceBinding = (
  sql: MemorySql,
  input: TurnAudienceBindingKey,
): ConversationAudience | undefined => {
  if (!input.intentionId) return undefined;
  const rows = [
    ...sql.exec<Record<string, unknown>>(
      `SELECT * FROM agent_turn_audience_bindings WHERE intention_id = ? AND workspace_id = ? AND actor_id = ?`,
      input.intentionId,
      input.workspaceId,
      input.actorId,
    ),
  ];
  if (rows.length === 0) return undefined;
  return mapRow(rows[0]!, input);
};

/**
 * Vincula a audiência à intenção (first-writer-wins): com vínculo existente,
 * devolve o VENCEDOR sem escrever; sem vínculo, insere e devolve a audiência
 * de entrada. Corrida no UNIQUE re-lê e devolve o vencedor. Falha REAL de
 * escrita propaga: sem vínculo durável não há autoridade para persistir o
 * turno com outra audiência (fail-closed no chamador).
 */
export const ensureTurnAudienceBinding = (
  sql: MemorySql,
  input: TurnAudienceBindingInput,
): ConversationAudience => {
  if (!input.intentionId) throw Object.assign(new Error('agent.invalid_message'), { code: 'agent.invalid_message', status: 400 });
  const existing = getTurnAudienceBinding(sql, input);
  if (existing) return existing;
  try {
    sql.exec(
      `INSERT INTO agent_turn_audience_bindings (workspace_id, actor_id, intention_id, visibility, owner_actor_id, conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.workspaceId,
      input.actorId,
      input.intentionId,
      input.audience.visibility,
      input.audience.ownerActorId,
      input.audience.conversationId,
      input.createdAt,
    );
    return { ...input.audience, workspaceId: input.workspaceId };
  } catch {
    const winner = getTurnAudienceBinding(sql, input);
    if (winner) return winner;
    throw new Error('turn audience binding write failed');
  }
};
