/**
 * Past sessions registry (Part B, item 15): `agent_sessions` tracks one row
 * per chat session so the model can list/resume earlier context and a fresh
 * session starts clean without losing history. Rows are scoped by
 * (workspace_id, actor_id) — never expose another workspace's or actor's
 * sessions.
 */

import { randomUUID } from 'node:crypto';
import { scrubForPersistence } from '../../privacy/dlp.js';
import type { MemorySql } from './store.js';

export type ChatSession = {
  id: string;
  workspaceId: string;
  actorId: string;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  summary: string | null;
  /**
   * ADR-027 D3 — audiência aditiva da conversa (default coletivo).
   * `visibility`: `workspace` (coletivo-com-atribuição) | `private` (só dono).
   * `ownerActorId`: dono; `conversationId`: identidade estável da conversa.
   * Legado sem colunas = sem audiência (classificado na leitura).
   */
  visibility: 'workspace' | 'private';
  ownerActorId: string;
  conversationId: string;
};

const nowIso = (): string => new Date().toISOString();

export const initializeSessionSchema = (sql: MemorySql): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      visibility TEXT NOT NULL DEFAULT 'workspace',
      owner_actor_id TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT ''
    );
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS agent_sessions_workspace_idx ON agent_sessions (workspace_id, actor_id);`);
  // D3: DOs com tabela antiga ganham as colunas aditivamente (sem migração
  // destrutiva; rollback = desabilita novas privadas, o existente permanece).
  ensureConversationVisibilityColumns(sql);
};

/** D3 — colunas aditivas de audiência (idempotente, sem reescrever dados). */
export const ensureConversationVisibilityColumns = (sql: MemorySql): void => {
  for (const statement of [
    `ALTER TABLE agent_sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace'`,
    `ALTER TABLE agent_sessions ADD COLUMN owner_actor_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE agent_sessions ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''`,
  ]) {
    try { sql.exec(statement); } catch { /* já presente ou adapter de teste */ }
  }
};

const mapRow = (row: Record<string, unknown>): ChatSession => ({
  id: String(row['id']),
  workspaceId: String(row['workspace_id']),
  actorId: String(row['actor_id'] ?? ''),
  startedAt: String(row['started_at']),
  endedAt: row['ended_at'] == null ? null : String(row['ended_at']),
  messageCount: Number(row['message_count'] ?? 0),
  summary: row['summary'] == null ? null : String(row['summary']),
  visibility: row['visibility'] === 'private' ? 'private' : 'workspace',
  ownerActorId: typeof row['owner_actor_id'] === 'string' && row['owner_actor_id'] ? String(row['owner_actor_id']) : String(row['actor_id'] ?? ''),
  conversationId: typeof row['conversation_id'] === 'string' && row['conversation_id'] ? String(row['conversation_id']) : String(row['id']),
});

export const currentSession = (
  sql: MemorySql,
  workspaceId: string,
  actorId: string,
  opts?: { visibility?: 'workspace' | 'private'; ownerActorId?: string; conversationId?: string },
): ChatSession => {
  const open = [
    ...sql.exec<Record<string, unknown>>(
      `SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      workspaceId,
      actorId,
    ),
  ].map(mapRow);
  // D3: trocar de modo NUNCA converte a sessão aberta — cria-se nova conversa.
  if (open[0]) return open[0];
  const session: ChatSession = {
    id: randomUUID(),
    workspaceId,
    actorId,
    startedAt: nowIso(),
    endedAt: null,
    messageCount: 0,
    summary: null,
    visibility: opts?.visibility === 'private' ? 'private' : 'workspace',
    ownerActorId: opts?.ownerActorId ?? actorId,
    conversationId: opts?.conversationId ?? '',
  };
  if (!session.conversationId) session.conversationId = session.id;
  sql.exec(
    `INSERT INTO agent_sessions (id, workspace_id, actor_id, started_at, ended_at, message_count, summary, visibility, owner_actor_id, conversation_id)
     VALUES (?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?)`,
    session.id,
    session.workspaceId,
    session.actorId,
    session.startedAt,
    session.visibility,
    session.ownerActorId,
    session.conversationId,
  );
  return session;
};

/**
 * D3 — leitura da sessão aberta SEM criar (carimbo de audiência dos turnos).
 * Ausente ⇒ default coletivo-com-atribuição (nada é criado por leitura).
 */
export const peekOpenSession = (sql: MemorySql, workspaceId: string, actorId: string): ChatSession | null => {
  const open = [
    ...sql.exec<Record<string, unknown>>(
      `SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      workspaceId,
      actorId,
    ),
  ].map(mapRow);
  return open[0] ?? null;
};

/**
 * D3 — coletivo-com-atribuição é o default: a listagem é por workspace e o
 * predicado de visibilidade decide (privada só ao dono; legado sem
 * proveniência = preservado-não-publicado, invisível).
 */
export const listVisiblePastSessions = (
  sql: MemorySql,
  input: { workspaceId: string; actorId: string; limit?: number },
): ChatSession[] => {
  const capped = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const rows = [
    ...sql.exec<Record<string, unknown>>(
      `SELECT * FROM agent_sessions WHERE workspace_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC`,
      input.workspaceId,
    ),
  ].map(mapRow);
  return rows.filter((session) => canAccessSessionRow(input.actorId, session)).slice(0, capped);
};

/** D3 — detalhe gated pelo predicado (nada de oráculo de existência). */
export const getVisibleSessionSummary = (
  sql: MemorySql,
  input: { workspaceId: string; actorId: string; sessionId: string },
): ChatSession | null => {
  const rows = [
    ...sql.exec<Record<string, unknown>>(`SELECT * FROM agent_sessions WHERE id = ?`, input.sessionId),
  ].map(mapRow);
  const session = rows[0];
  if (!session || session.workspaceId !== input.workspaceId) return null;
  if (!canAccessSessionRow(input.actorId, session)) return null;
  return session;
};

/** D3 — predicado sobre a linha do registry (workspace + visibilidade). */
export const canAccessSessionRow = (actorId: string, session: ChatSession): boolean => {
  if (!actorId || !actorId.trim()) return false;
  if (session.workspaceId == null) return false;
  if (session.visibility === 'private') {
    const owner = session.ownerActorId;
    // 'ted'/sistema nunca é dono válido: privada sem dono real = invisível.
    if (!owner || owner.trim().length === 0) return false;
    const SYSTEM = new Set(['ted', 'assistant', 'unknown', 'system']);
    if (SYSTEM.has(owner.trim()) || SYSTEM.has(actorId.trim())) return false;
    return owner === actorId;
  }
  // Coletivo (incl. legado com atribuição): visível ao membro do workspace.
  // Legado sem proveniência (actor vazio) = preservado-não-publicado.
  if (!session.actorId || session.actorId.trim().length === 0) return false;
  return true;
};

export const endSession = (
  sql: MemorySql,
  workspaceId: string,
  actorId: string,
  input?: { summary?: string | null; messageCount?: number },
): ChatSession | null => {
  const current = [
    ...sql.exec<Record<string, unknown>>(
      `SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      workspaceId,
      actorId,
    ),
  ].map(mapRow)[0];
  if (!current) return null;
  const closed: ChatSession = {
    ...current,
    endedAt: nowIso(),
    messageCount: input?.messageCount ?? current.messageCount,
    // H-09: session summaries are durable — scrub before persisting.
    summary: input?.summary ? scrubForPersistence(input.summary) : current.summary,
  };
  sql.exec(`UPDATE agent_sessions SET ended_at = ?, message_count = ?, summary = ? WHERE id = ?`, closed.endedAt, closed.messageCount, closed.summary, current.id);
  return closed;
};

export const listPastSessions = (sql: MemorySql, workspaceId: string, actorId: string, limit = 5): ChatSession[] => {
  const capped = Math.min(Math.max(limit, 1), 20);
  return [
    ...sql.exec<Record<string, unknown>>(
      `SELECT * FROM agent_sessions WHERE workspace_id = ? AND actor_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?`,
      workspaceId,
      actorId,
      capped,
    ),
  ].map(mapRow);
};

export const getSessionSummary = (sql: MemorySql, workspaceId: string, actorId: string, sessionId: string): ChatSession | null => {
  const rows = [
    ...sql.exec<Record<string, unknown>>(
      `SELECT * FROM agent_sessions WHERE id = ? AND workspace_id = ? AND actor_id = ?`,
      sessionId,
      workspaceId,
      actorId,
    ),
  ].map(mapRow);
  return rows[0] ?? null;
};
