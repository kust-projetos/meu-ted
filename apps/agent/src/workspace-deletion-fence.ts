/**
 * FIX-WS-D2-FENCE — fence durável de exclusão de workspace (lado Agent).
 *
 * Fecha a janela attest→consume por construção (REVIEW-WS-D2-FINAL HIGH):
 * o attest-empty instala o fence ANTES do snapshot; todo caminho de escrita
 * do Agent (chat turn REST/SDK, upload/ingest, prefs de memória, nova sessão,
 * decisão de approval/undo, importação de histórico legado) verifica o fence
 * e recusa fail-closed; o attest drena os writers admitidos em voo
 * (assentamento limitado — sem assentamento, o attest RECUSA em vez de
 * atestar sobre estado parcial).
 *
 * Durável: tabela `workspace_deletion_fence` no SQLite do DO
 * (`workspace_id` PK, `epoch`, `expires_at` ISO). Expiração curta nomeada
 * (5min, igual ao TTL da atestação): fence expirado é removido e NÃO
 * bloqueia nada (fail-open seguro — delete com handle expirado é recusado
 * pela API de todo modo).
 *
 * R2 (REVIEW-WS-D2-FENCE):
 * - install RECUSA nova tentativa com fence válido ativo (R3: 409
 *   `agent.deletion_fence_active` — nunca compartilha o epoch alheio);
 * - clear aceita `expectedEpoch` e SÓ remove com epoch igual (depósito falho
 *   nunca limpa fence alheio/válido);
 * - leitura distingue ausente/expirado (allow) de erro de storage
 *   (`WorkspaceDeletionFenceUnavailableError`, 503 — writers recusam como
 *   indisponível, nunca fail-open).
 */

export const WORKSPACE_DELETION_FENCE_TTL_MS = 5 * 60 * 1000;

export const WORKSPACE_DELETION_FENCED_CODE = 'agent.workspace_deletion_fenced' as const;
export const WORKSPACE_DELETION_FENCE_UNAVAILABLE_CODE = 'agent.persistence_unavailable' as const;
export const WORKSPACE_DELETION_FENCE_ACTIVE_CODE = 'agent.deletion_fence_active' as const;

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

/**
 * R2 finding 5 — storage ilegível: o chamador NÃO pode presumir ausência
 * (fail-open). Writers recusam como indisponível (503); o attest recusa
 * como `agent.attestation_unavailable`.
 */
export class WorkspaceDeletionFenceUnavailableError extends Error {
  readonly code = WORKSPACE_DELETION_FENCE_UNAVAILABLE_CODE;
  readonly status = 503;
  constructor(message = 'Fence de exclusão ilegível: escrita recusada como indisponível.') {
    super(message);
    this.name = 'WorkspaceDeletionFenceUnavailableError';
  }
}

/**
 * R3 — geração ATIVA: nova tentativa de attest enquanto houver fence válido
 * é RECUSADA fail-closed (409 `agent.deletion_fence_active`) em vez de
 * compartilhar o epoch. Cada attest bem-sucedido é dono exclusivo da sua
 * geração; se B falhasse limpando o epoch compartilhado de A, a janela de
 * A reabriria. O chamador (attest) NÃO limpa nada neste caminho — o fence
 * de A segue intacto.
 */
export class WorkspaceDeletionFenceActiveError extends Error {
  readonly code = WORKSPACE_DELETION_FENCE_ACTIVE_CODE;
  readonly status = 409;
  constructor(message = 'Exclusão em andamento: já existe uma atestação ativa para este workspace.') {
    super(message);
    this.name = 'WorkspaceDeletionFenceActiveError';
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
 * Sem storage (sql null) retorna null — o chamador decide fail-closed
 * (writers sem storage já falham closed nas próprias checagens).
 *
 * R2 finding 5 — storage PRESENTE porém ilegível (schema ilegível, SELECT
 * falhando) LANÇA `WorkspaceDeletionFenceUnavailableError` (nunca retorna
 * null fail-open): writers recusam como indisponível. A remoção
 * best-effort do fence EXPIRADO continua sem bloquear: falhou o DELETE, o
 * fence expirado ainda retorna null.
 */
export const readWorkspaceDeletionFence = (
  sql: WorkspaceDeletionFenceSqlLike | null,
  workspaceId: string,
  now = Date.now(),
): WorkspaceDeletionFence | null => {
  if (!sql || !workspaceId) return null;
  let rows: FenceRow[];
  try {
    ensureWorkspaceDeletionFenceSchema(sql);
    rows = [...sql.exec<FenceRow>(
      `SELECT epoch, expires_at FROM workspace_deletion_fence WHERE workspace_id = ?`,
      workspaceId,
    )];
  } catch {
    throw new WorkspaceDeletionFenceUnavailableError();
  }
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
};

/**
 * Instala o fence ANTES do snapshot. Chamado pelo attest-empty antes de
 * observar o inventário — writers concorrentes passam a recusar a partir
 * daqui, fechando a janela por construção.
 *
 * R3 — NUNCA compartilha geração: com fence válido ativo, LANÇA
 * `WorkspaceDeletionFenceActiveError` (409 `agent.deletion_fence_active`,
 * fail-closed). A tentativa recusada NÃO é dona de geração alguma e NÃO
 * limpa nada; cada attest bem-sucedido é dono exclusivo da sua geração e
 * toda limpeza é condicional ao epoch próprio. Só instala quando
 * ausente/expirado. Storage ilegível lança indisponível (o attest recusa,
 * nunca atesta sem fechar a janela).
 */
export const installWorkspaceDeletionFence = (
  sql: WorkspaceDeletionFenceSqlLike,
  workspaceId: string,
  now = Date.now(),
): WorkspaceDeletionFence => {
  let existing: WorkspaceDeletionFence | null;
  try {
    existing = readWorkspaceDeletionFence(sql, workspaceId, now);
  } catch (error) {
    if (error instanceof WorkspaceDeletionFenceUnavailableError) throw error;
    throw new WorkspaceDeletionFenceUnavailableError();
  }
  if (existing) throw new WorkspaceDeletionFenceActiveError();
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

/**
 * Remove o fence (delete consumiu, attest observou não-vazio, ou expirou).
 *
 * R2 finding 3 — com `expectedEpoch`, a remoção é CONDICIONAL à geração
 * (`DELETE ... AND epoch = ?`): depósito falho ou attest recusado nunca
 * limpa fence alheio/válido. Sem epoch, remove incondicional (expiração
 * best-effort e chamadores legados).
 */
export const clearWorkspaceDeletionFence = (
  sql: WorkspaceDeletionFenceSqlLike | null,
  workspaceId: string,
  expectedEpoch?: string,
): void => {
  if (!sql || !workspaceId) return;
  try {
    if (typeof expectedEpoch === 'string' && expectedEpoch) {
      sql.exec(
        `DELETE FROM workspace_deletion_fence WHERE workspace_id = ? AND epoch = ?`,
        workspaceId,
        expectedEpoch,
      );
    } else {
      sql.exec(`DELETE FROM workspace_deletion_fence WHERE workspace_id = ?`, workspaceId);
    }
  } catch {
    // Limpeza best-effort.
  }
};

/**
 * Guarda de escrita: fence ativo → lança `WorkspaceDeletionFencedError`
 * (409 tipado, fail-closed, nunca escreve); ausente/expirado → libera.
 *
 * R2 finding 5 — storage ilegível → lança
 * `WorkspaceDeletionFenceUnavailableError` (503, recusar como indisponível).
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
