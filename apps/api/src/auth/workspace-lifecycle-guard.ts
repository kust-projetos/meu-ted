import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../writes/errors.js';

/**
 * FIX-WS-D2-R2 item 2 — guarda de lifecycle para TODOS os writers
 * financeiros (padrão central; demais stores reutilizam).
 *
 * Todo efeito financeiro roda DENTRO da transação do efeito e começa por
 * aqui: o status do workspace efetivamente mutado é lido na mesma
 * transação, antes de qualquer INSERT/UPDATE/DELETE de domínio.
 *
 * Lock: `FOR SHARE` — writers concorrentes do MESMO workspace não se
 * serializam entre si, mas o delete-vazio (que trava a linha com
 * `FOR UPDATE`) espera os writers em curso e os writers esperam o
 * delete em curso: delete-vs-create e archive-vs-create convergem para
 * exatamente um vencedor, sem escrita em workspace morto.
 *
 * - `archived` → 403 (mutações congeladas até restaurar).
 * - `deleted` (ou tombstone) → 410 (terminal, nunca ressuscita).
 */
export const assertWorkspaceWritableInTx = async (
  client: PoolClient,
  householdId: string,
): Promise<void> => {
  const current = await client.query<{ status: string }>(
    `SELECT status FROM households WHERE id = $1 FOR SHARE`,
    [householdId],
  );
  if ((current.rowCount ?? 0) === 0 || current.rows.length === 0) {
    throw new DomainError('workspace.deleted', 'Workspace não encontrado ou excluído.', 410);
  }
  const status = current.rows[0]!.status;
  if (status === 'deleted') {
    throw new DomainError('workspace.deleted', 'Workspace excluído permanentemente.', 410);
  }
  if (status !== 'active') {
    throw new DomainError(
      'workspace.archived',
      'Workspace arquivado: mutações congeladas até restaurar.',
      403,
    );
  }
};

/**
 * Variante sem transação (uso residual; writers de produto usam
 * `assertWorkspaceWritableInTx` — FIX-WS-D2-R3 item 2 moveu os últimos
 * caminhos check-then-act para dentro da transação do efeito).
 * Leitura simples, sem lock: NUNCA usar antes de efeito financeiro.
 */
export const assertWorkspaceWritable = async (
  pool: Pool,
  householdId: string,
): Promise<void> => {
  const current = await pool.query<{ status: string }>(
    `SELECT status FROM households WHERE id = $1`,
    [householdId],
  );
  if ((current.rowCount ?? 0) === 0 || current.rows.length === 0) {
    throw new DomainError('workspace.deleted', 'Workspace não encontrado ou excluído.', 410);
  }
  const status = current.rows[0]!.status;
  if (status === 'deleted') {
    throw new DomainError('workspace.deleted', 'Workspace excluído permanentemente.', 410);
  }
  if (status !== 'active') {
    throw new DomainError(
      'workspace.archived',
      'Workspace arquivado: mutações congeladas até restaurar.',
      403,
    );
  }
};
