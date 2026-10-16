/**
 * FIX-WS-D2-FENCE — fence durável de exclusão de workspace (lado Agent).
 *
 * Fecha a janela attest→consume por construção (REVIEW-WS-D2-FINAL HIGH):
 * o attest-empty instala o fence ANTES do snapshot; todo caminho de escrita
 * do Agent (chat turn, upload/ingest, prefs de memória, nova sessão)
 * verifica o fence e recusa fail-closed; o attest drena turnos em voo
 * (assentamento limitado) antes do snapshot.
 *
 * Durável: tabela `workspace_deletion_fence` no SQLite do DO
 * (`workspace_id` PK, `epoch`, `expires_at` ISO). Expiração curta nomeada
 * (5min, igual ao TTL da atestação): fence expirado é removido e NÃO
 * bloqueia nada (fail-open seguro — delete com handle expirado é recusado
 * pela API de todo modo).
 */

export const WORKSPACE_DELETION_FENCE_TTL_MS = 5 * 60 * 1000;

export const WORKSPACE_DELETION_FENCED_CODE = 'agent.workspace_deletion_fenced' as const;

export type WorkspaceDeletionFenceSqlLike = {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>;
};

export type WorkspaceDeletionFence = {
  workspaceId: string;
  epoch: string;
  expiresAt: string;
};

export class WorkspaceDeletionFencedError extends Error {
  readonly code = WORKSPACE_DELETION_FENCED_CODE;
  readonly status = 409;
  constructor(message = 'Exclusão em andamento: escrita bloqueada até a conclusão.') {
    super(message);
    this.name = 'WorkspaceDeletionFencedError';
  }
}

export const ensureWorkspaceDeletionFenceSchema = (
  sql: WorkspaceDeletionFenceSqlLike,
): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS workspace_deletion_fence (
      workspace_id TEXT PRIMARY KEY,
      epoch TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
};

type FenceRow = { epoch: unknown; expires_at: unknown };

const parseRow = (
  workspaceId: string,
  row: FenceRow | undefined,
): WorkspaceDeletionFence | null => {
  if (!row || typeof row.epoch !== 'string' || !row.epoch || typeof row.expires_at !== 'string') {
    return null;
  }
  return { workspaceId, epoch: row.epoch, expiresAt: row.expires_at };
};

/**
 * Lê o fence ativo. Fence expirado é removido (fail-open) e retorna null.
 * Sem storage (sql null) retorna null — o chamador decide fail-closed.
 */
export const readWorkspaceDeletionFence = (
  sql: WorkspaceDeletionFenceSqlLike | null,
  workspaceId: string,
  now = Date.now(),
): WorkspaceDeletionFence | null => {
  if (!sql || !workspaceId) return null;
  try {
    ensureWorkspaceDeletionFenceSchema(sql);
    const rows = [...sql.exec<FenceRow>(
      `SELECT epoch, expires_at FROM workspace_deletion_fence WHERE workspace_id = ?`,
      workspaceId,
    )];
    const fence = parseRow(workspaceId, rows[0]);
    if (!fence) return null;
    if (Date.parse(fence.expiresAt) <= now) {
      try {
        sql.exec(`DELETE FROM workspace_deletion_fence WHERE workspace_id = ?`, workspaceId);
      } catch {
        // Remoção best-effort: o fence expirado nunca bloqueia.
      }
      return null;
    }
    return fence;
  } catch {
    // Leitura ilegível nunca bloqueia por si (o attest trata storage
    // ausente como indisponível; writers sem storage já falham closed).
    return null;
  }
};

/**
 * Instala (upsert) o fence ANTES do snapshot. Chamado pelo attest-empty
 * antes de observar o inventário — writers concorrentes passam a recusar
 * a partir daqui, fechando a janela por construção.
 */
export const installWorkspaceDeletionFence = (
  sql: WorkspaceDeletionFenceSqlLike,
  workspaceId: string,
  now = Date.now(),
): WorkspaceDeletionFence => {
  ensureWorkspaceDeletionFenceSchema(sql);
  const epoch =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `fence-${now}-${Math.random().toString(36).slice(2)}`;
  const expiresAt = new Date(now + WORKSPACE_DELETION_FENCE_TTL_MS).toISOString();
  sql.exec(
    `INSERT INTO workspace_deletion_fence (workspace_id, epoch, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET epoch = excluded.epoch, expires_at = excluded.expires_at`,
    workspaceId,
    epoch,
    expiresAt,
  );
  return { workspaceId, epoch, expiresAt };
};

/** Remove o fence (delete consumiu, attest observou não-vazio, ou expirou). */
export const clearWorkspaceDeletionFence = (
  sql: WorkspaceDeletionFenceSqlLike | null,
  workspaceId: string,
): void => {
  if (!sql || !workspaceId) return;
  try {
    sql.exec(`DELETE FROM workspace_deletion_fence WHERE workspace_id = ?`, workspaceId);
  } catch {
    // Limpeza best-effort.
  }
};

/**
 * Guarda de escrita: fence ativo → lança `WorkspaceDeletionFencedError`
 * (409 tipado, fail-closed, nunca escreve); ausente/expirado → libera.
 */
export const assertNoActiveWorkspaceDeletionFence = (
  sql: WorkspaceDeletionFenceSqlLike | null,
  workspaceId: string,
  now = Date.now(),
): void => {
  const fence = readWorkspaceDeletionFence(sql, workspaceId, now);
  if (fence) {
    throw new WorkspaceDeletionFencedError();
  }
};
