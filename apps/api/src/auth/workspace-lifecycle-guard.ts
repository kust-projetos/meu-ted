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
    // Linha ausente NÃO significa "excluído": o delete D2 preserva a
    // linha como marcador `deleted` (nunca há DELETE físico em
    // households), então ausência indica dado pré-lifecycle/legado (sem
    // FK formal) — comportamento legado preservado. A barreira atua
    // onde há linha (active/archived/deleted).
    return;
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
  // Ausência de linha = dado pré-lifecycle (ver comentário acima); permite.
  if ((current.rowCount ?? 0) === 0 || current.rows.length === 0) {
    return;
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
 * Round rename-2: guarda de lifecycle para o writer legado
 * (`renameAccountLegacyInTx`). Mapeia `assertWorkspaceWritableInTx`
 * (mesma query `FOR SHARE`, mesmas regras active/archived/deleted,
 * mesma tolerância a linha ausente = dado pré-lifecycle).
 *
 * Diferença de schema: o ledger legado real (manifest até V054, sem
 * V020/V036) pode NÃO ter a tabela `households` (ou a coluna `status`).
 * Nesse caso NÃO há bypass silencioso nem invenção de schema/migration:
 * falha fechada e explicada (`unsupported`) — o rename exige lifecycle
 * observável. Erros de conexão/query reais propagam intocados.
 */
export const assertWorkspaceWritableLegacyInTx = async (
  client: PoolClient,
  householdId: string,
): Promise<void> => {
  try {
    await assertWorkspaceWritableInTx(client, householdId);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (isMissingLifecycleRelation(error)) {
      throw new DomainError(
        'unsupported',
        'Operação não suportada: renomeação exige lifecycle de workspace observável (households.status).',
        400,
      );
    }
    throw error;
  }
};

/** PG `undefined_table` (42P01) / `undefined_column` (42703). */
const isMissingLifecycleRelation = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42P01' || code === '42703';
};
