import { createHash } from 'node:crypto';
import { scrubForPersistence } from '../privacy/dlp.js';

export type LegacyMessage = {
  id: string;
  actor_id: string;
  role: string;
  content_json: string;
  created_at: string;
};

export type LegacyTurn = {
  id: string;
  intention_id?: string;
  actor_id: string;
  status: string;
  attempts: number;
  tokens_used: number;
  input_json?: string;
  output_json?: string;
};

export type LegacyFullExport = {
  version: number;
  workspaceId: string;
  turns: LegacyTurn[];
  messages: LegacyMessage[];
  hasInFlightTurns: boolean;
};

export type SdkUIMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: 'text'; text: string }>;
  metadata: {
    actorId: string;
    workspaceId: string;
    createdAt: string;
    intentionId?: string;
    /** ADR-027 D3 — audiência aditiva (ver `privacy/conversation-visibility`). */
    visibility?: 'workspace' | 'private';
    ownerActorId?: string;
    conversationId?: string;
  };
};

export type MigrationResult = {
  success: boolean;
  importedCount: number;
  skipped: boolean;
  reason?: string;
  migrationHash?: string;
};

export const computeHistoryHash = (messages: LegacyMessage[], workspaceId = ''): string => {
  // M-07: the workspace/canonical household is part of the hashed material —
  // identical transcripts in distinct workspaces must never share a hash.
  const structured = [
    { workspace_id: workspaceId },
    ...messages.map((m) => ({
      id: m.id,
      actor_id: m.actor_id,
      role: m.role,
      created_at: m.created_at,
      content_json: m.content_json,
    })),
  ];
  return createHash('sha256').update(JSON.stringify(structured)).digest('hex');
};

export const transformLegacyMessages = (
  messages: LegacyMessage[],
  workspaceId = '',
  turns: LegacyTurn[] = [],
): SdkUIMessage[] => {
  // FIX-R3 (REVIEW-MELHORIAS-R2 residual): o formato legado não carrega
  // NENHUM campo que vincule turno↔mensagem de forma verificável —
  // LegacyTurn não tem created_at/seq/message_ids e LegacyMessage não tem
  // turn_id/intention_id (input_json/output_json são payloads opacos, não
  // vínculo). Toda correspondência seria apenas posicional
  // (turns[i] → i-ésimo grupo cronológico), e dois turnos completed do mesmo
  // ator com o array em ordem inversa aos grupos passam nos gates de
  // contagem/status/ator e TROCAM os intentionIds. Fail-closed: o
  // intentionId legado NUNCA é propagado — mensagens migradas chegam sem
  // intentionId e ficam fora do dedupe de redelivery, em vez de carregar
  // identidade trocada. O parâmetro `turns` é mantido por compatibilidade
  // de assinatura e ignorado. Se o formato um dia ganhar vínculo
  // verificável (ex. turn.created_at ou message.turn_id), reabrir com
  // exigência desse vínculo em teste.
  void turns;

  return messages.map((msg) => {
    let parsedContent = '';
    try {
      const parsed = JSON.parse(msg.content_json);
      parsedContent = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch {
      parsedContent = msg.content_json;
    }

    // H-09: migrated history is re-persisted — full central DLP scrub.
    const sanitized = scrubForPersistence(parsedContent);
    const validRole: 'user' | 'assistant' | 'system' =
      msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user';
    const actorId = validRole === 'assistant' ? 'ted' : msg.actor_id;

    // ADR-027 D3.8 — legado sem audiência: COM proveniência (ator atribuído)
    // ⇒ coletivo; SEM proveniência ⇒ preservado-não-publicado (privado sem
    // dono real: o predicado nega a todos, nunca publica).
    const attributed = typeof actorId === 'string' && actorId.trim().length > 0;
    return {
      id: msg.id,
      role: validRole,
      parts: [{ type: 'text', text: sanitized }],
      metadata: {
        actorId,
        workspaceId,
        createdAt: msg.created_at,
        visibility: attributed ? 'workspace' : 'private',
        ownerActorId: attributed ? actorId : '',
        conversationId: '',
      },
    };
  });
};

export const initializeMigrationSchema = (sql: { exec(query: string): unknown }): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _history_migration_marker (
      workspace_id TEXT PRIMARY KEY,
      migration_hash TEXT NOT NULL,
      imported_count INTEGER NOT NULL,
      migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

export const migrateLegacyHistory = async (
  exportData: LegacyFullExport,
  sql: { exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): Iterable<T> },
  persistCallback?: (messages: SdkUIMessage[]) => Promise<void> | void,
): Promise<MigrationResult> => {
  if (exportData.hasInFlightTurns) {
    return {
      success: false,
      importedCount: 0,
      skipped: false,
      reason: 'migration_blocked_turns_in_flight: workspace has active turns in queued/running state',
    };
  }

  initializeMigrationSchema(sql);

  const migrationHash = computeHistoryHash(exportData.messages, exportData.workspaceId);
  // M-07 bridge: markers written before the workspace entered the hash
  // still match (no re-import), and are upgraded to the new scheme below.
  const legacyHash = computeHistoryHash(exportData.messages);

  // Check if already migrated with exact hash
  const existing = [...sql.exec<{ migration_hash: string; imported_count: number }>(
    `SELECT migration_hash, imported_count FROM _history_migration_marker WHERE workspace_id = ?`,
    exportData.workspaceId,
  )];

  if (existing.length > 0 && (existing[0]?.migration_hash === migrationHash || existing[0]?.migration_hash === legacyHash)) {
    if (existing[0]?.migration_hash === legacyHash && migrationHash !== legacyHash) {
      sql.exec(
        `INSERT INTO _history_migration_marker (workspace_id, migration_hash, imported_count, migrated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (workspace_id) DO UPDATE SET migration_hash = excluded.migration_hash, imported_count = excluded.imported_count, migrated_at = CURRENT_TIMESTAMP`,
        exportData.workspaceId,
        migrationHash,
        existing[0].imported_count,
      );
    }
    return {
      success: true,
      importedCount: existing[0].imported_count,
      skipped: true,
      migrationHash,
      reason: 'already_migrated',
    };
  }

  const transformed = transformLegacyMessages(exportData.messages, exportData.workspaceId, exportData.turns);

  if (transformed.length > 0) {
    if (typeof persistCallback !== 'function') {
      return {
        success: false,
        importedCount: 0,
        skipped: false,
        reason: 'missing_persist_callback: cannot mark migration without persisting messages',
      };
    }
    await persistCallback(transformed);
  }

  sql.exec(
    `INSERT INTO _history_migration_marker (workspace_id, migration_hash, imported_count, migrated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (workspace_id) DO UPDATE SET migration_hash = excluded.migration_hash, imported_count = excluded.imported_count, migrated_at = CURRENT_TIMESTAMP`,
    exportData.workspaceId,
    migrationHash,
    transformed.length,
  );

  return {
    success: true,
    importedCount: transformed.length,
    skipped: false,
    migrationHash,
  };
};
