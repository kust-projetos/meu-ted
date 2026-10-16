import type { Pool } from 'pg';
import { withTransaction, queryInTransaction } from '../db/pool.js';
import type { WorkspaceKind, WorkspaceMember, WorkspaceRevocationHooks, WorkspaceRole, WorkspaceStatus, WorkspaceStore, WorkspaceSummary } from './workspaces-store.js';
import { WorkspaceError } from './workspaces-store.js';
import type { DeleteConfirmation, DeletionInventory, DeletionInventoryCounts } from './workspace-deletion.js';
import {
  agentAttestationUnavailable,
  boundInventoryVersion,
  deletionInventoryExpiry,
  hashInventoryCounts,
  resolveDeletionHmacSecret,
  verifyDeleteConfirmation,
} from './workspace-deletion.js';

type Row = Record<string, unknown>;

const mapWorkspace = (row: Row): WorkspaceSummary => ({
  id: row['id'] as string,
  name: row['name'] as string,
  kind: row['kind'] as WorkspaceKind,
  role: row['role'] as WorkspaceRole,
  status: (row['status'] as WorkspaceStatus | undefined) ?? 'active',
});

const deletedWorkspace = (householdId: string): WorkspaceError =>
  new WorkspaceError('workspace.deleted', 410, 'Workspace excluído permanentemente.');

/**
 * D2 (ADR-027) — prova autoritativa de "vazio" em UMA statement (scalar
 * subselects, sem N+1). Inclui soft-deleted (COUNT(*) sem filtro de
 * deleted_at), histórico de domínio, pendings/incertos V1+V2, intentions
 * não-vinculadas, convites pendentes, transfers pendentes e exige
 * exatamente 1 membership ativo (o owner).
 *
 * EXCLUÍDO por desenho (evidência append-only preservada pelo delete,
 * nunca apagada para "esvaziar"): audit_logs, operation_records
 * terminais, idempotency_keys. operation_records `processing` AINDA
 * acionável (retry_until futuro) bloqueia como "incerto". device_tokens
 * (material de auth) morre com o workspace via gates de acesso e não
 * bloqueia; push_subscriptions ATIVAS bloqueiam (entrega para workspace
 * morto seria resíduo). account_invites é signup-level (sem household).
 * Lado Agent (DO/R2/memória) não é observável daqui: barreira
 * cross-store pendente, atestação registrada como unverified.
 */
const INVENTORY_SELECT = `
  SELECT
    (SELECT COUNT(*) FROM accounts WHERE household_id = $1) AS accounts,
    (SELECT COUNT(*) FROM categories WHERE household_id = $1) AS categories,
    (SELECT COUNT(*) FROM transactions WHERE household_id = $1) AS transactions,
    (SELECT COUNT(*) FROM statements WHERE household_id = $1) AS statements,
    (SELECT COUNT(*) FROM recurring_purchases WHERE household_id = $1) AS recurring_purchases,
    (SELECT COUNT(*) FROM accounts_payable WHERE household_id = $1) AS accounts_payable,
    (SELECT COUNT(*) FROM payable_templates WHERE household_id = $1) AS payable_templates,
    (SELECT COUNT(*) FROM notification_configs WHERE household_id = $1) AS notification_configs,
    (SELECT COUNT(*) FROM budgets WHERE household_id = $1) AS budgets,
    (SELECT COUNT(*) FROM goals WHERE household_id = $1) AS goals,
    (SELECT COUNT(*) FROM goal_contributions gc JOIN goals g ON g.id = gc.goal_id WHERE g.household_id = $1) AS goal_contributions,
    (SELECT COUNT(*) FROM subscriptions WHERE household_id = $1) AS subscriptions,
    (SELECT COUNT(*) FROM profiles WHERE household_id = $1) AS profiles,
    (SELECT COUNT(*) FROM card_purchases WHERE household_id = $1) AS card_purchases,
    (SELECT COUNT(*) FROM push_subscriptions WHERE workspace_id = $2) AS push_subscriptions,
    (SELECT COUNT(*) FROM pending_operations WHERE workspace_id = $2 AND status NOT IN ('rejected', 'expired')) AS pending_operations_v1,
    (SELECT COUNT(*) FROM pending_operations WHERE workspace_id = $2 AND protocol_version = 2 AND (execution_status IS NULL OR execution_status IN ('proposed', 'confirmed', 'executing'))) AS pending_operations_v2,
    (SELECT COUNT(*) FROM operation_records WHERE workspace_id = $2 AND status = 'processing' AND retry_until > NOW()) AS operation_records_processing,
    (SELECT COUNT(*) FROM pending_operation_confirmation_intentions WHERE workspace_id = $2::text AND operation_id IS NULL) AS confirmation_intentions,
    (SELECT COUNT(*) FROM invites WHERE household_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()) AS invites,
    (SELECT COUNT(*) FROM ownership_transfers WHERE household_id = $1 AND status = 'pending') AS ownership_transfers,
    (SELECT COUNT(*) FROM memberships WHERE household_id = $1 AND status = 'active') AS memberships_active
`;

const toCounts = (row: Row): DeletionInventoryCounts => {
  const counts: DeletionInventoryCounts = {};
  for (const [key, value] of Object.entries(row)) {
    counts[key] = typeof value === 'number' ? value : Number(value ?? 0);
  }
  return counts;
};

const inventoryFromRow = (householdId: string, row: Row, secret: string): DeletionInventory => {
  const counts = toCounts(row);
  const empty =
    Object.entries(counts).every(([key, value]) =>
      key === 'memberships_active' ? value === 1 : value === 0,
    );
  // A versão vincula contagens + expiração sob HMAC server-side
  // (FIX-WS-D2-R3 item 3): a expiração apresentada no delete precisa
  // ser esta mesma — e só o servidor emite versões válidas.
  const expiresAt = deletionInventoryExpiry();
  return {
    workspaceId: householdId,
    inventoryVersion: hashInventoryCounts(householdId, counts, expiresAt, secret),
    expiresAt,
    empty,
    counts,
    purgeBlocked: true,
    agentAttestation: 'unverified',
  };
};

export type PostgresWorkspaceStoreOptions = {
  /** Segredo HMAC da confirmação de exclusão (item 3); sem ele, emissão/verificação recusam fail-closed. */
  deletionHmacSecret?: string | undefined;
};

export const createPostgresWorkspaceStore = (pool: Pool, hooks?: WorkspaceRevocationHooks, opts?: PostgresWorkspaceStoreOptions): WorkspaceStore => {
  const assertMembership = async (authUserId: string, householdId: string): Promise<{ userId: string; role: WorkspaceRole }> => {
    const result = await queryInTransaction<Row>(
      pool,
      `SELECT u.id AS user_id, m.role
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.household_id = $2 AND m.status = 'active'
        WHERE u.auth_user_id = $1 AND u.status = 'active'`,
      [authUserId, householdId],
    );
    const row = result.rows[0];
    if (!row) throw new WorkspaceError('workspace.forbidden', 403, 'Usuário não é membro deste workspace.');
    return { userId: row['user_id'] as string, role: row['role'] as WorkspaceRole };
  };

  const assertActiveMembershipRole = async (authUserId: string, householdId: string, allowed: WorkspaceRole[]): Promise<{ userId: string; role: WorkspaceRole }> => {
    const membership = await assertMembership(authUserId, householdId);
    if (!allowed.includes(membership.role)) {
      throw new WorkspaceError('workspace.forbidden', 403, 'Ação requer permissão de owner.');
    }
    return membership;
  };

  return {
    async list(authUserId) {
      const result = await queryInTransaction<Row>(
        pool,
        `SELECT h.id AS id, h.name AS name, h.kind AS kind, h.status AS status, m.role AS role
           FROM memberships m
           JOIN households h ON h.id = m.household_id
           JOIN users u ON u.id = m.user_id
          WHERE (u.auth_user_id = $1 OR u.id::text = $1)
            AND u.status = 'active'
            AND m.status = 'active'
            AND h.status <> 'deleted'
          ORDER BY (h.status = 'active') DESC, (h.kind = 'personal') DESC, h.created_at ASC, h.id ASC`,
        [authUserId],
      );
      return result.rows.map(mapWorkspace);
    },

    async create({ authUserId, name, kind }) {
      const userResult = await queryInTransaction<Row>(
        pool,
        `SELECT id FROM users WHERE auth_user_id = $1 AND status = 'active'`,
        [authUserId],
      );
      const userRow = userResult.rows[0];
      if (!userRow) throw new WorkspaceError('workspace.invalid', 400, 'Usuário ativo não encontrado.');
      const userId = userRow['id'] as string;

      // D1 (ADR-027): N personal workspaces per user. The one-personal
      // 409 refusal was removed together with the V021 partial unique
      // index (see V061 — V021 itself is never edited). Personal stays
      // owner-exclusive via the preserved V021 triggers (no invites, no
      // transfer, no leave, no conversion); only the cardinality is
      // lifted. Concurrency: each create inserts an independent household
      // row (no per-user lock needed); same-Idempotency-Key dedup is
      // enforced by the workspace.create idempotency record in the HTTP
      // layer, distinct keys create distinct workspaces.

      return withTransaction(pool, async (client) => {
        const householdResult = await client.query<Row>(
          `INSERT INTO households (name, kind, owner_user_id)
           VALUES ($1, $2, $3)
           RETURNING id, name, kind, status`,
          [name, kind, userId],
        );
        const household = householdResult.rows[0]!;
        if (kind === 'shared') {
          await client.query(
            `INSERT INTO memberships (user_id, household_id, role, kind, status)
             VALUES ($1, $2, 'owner', 'shared', 'active')
             ON CONFLICT (user_id, household_id) DO UPDATE SET role = 'owner', kind = 'shared', status = 'active'`,
            [userId, household['id']],
          );
        }
        // Personal workspaces create the owner membership via V021 trigger.
        return mapWorkspace({ ...household, role: 'owner' });
      });
    },

    async rename({ authUserId, householdId, name }) {
      await assertActiveMembershipRole(authUserId, householdId, ['owner']);
      return withTransaction(pool, async (client) => {
        // FIX-WS-D2-R2 itens 3–4: lifecycle serializado sob o lock da
        // linha; o congelamento de archived vale pelo workspace
        // efetivamente mutado (path), nunca pelo header opcional.
        const current = await client.query<Row>(
          `SELECT status FROM households WHERE id = $1 FOR UPDATE`,
          [householdId],
        );
        if (current.rows[0]?.['status'] === 'deleted') throw deletedWorkspace(householdId);
        // D2 §1: rename sobre archived congela (só restore/re-archive
        // idempotente, delete-vazio, saída e revogação passam).
        if (current.rows[0]?.['status'] === 'archived') {
          throw new WorkspaceError('workspace.archived', 403, 'Workspace arquivado: mutações congeladas até restaurar.');
        }
        const result = await client.query<Row>(
          `UPDATE households
              SET name = $1
            WHERE id = $2 AND status <> 'deleted'
            RETURNING id, name, kind, status`,
          [name, householdId],
        );
        const workspace = result.rows[0];
        if (!workspace) throw deletedWorkspace(householdId);
        return mapWorkspace({ ...workspace, role: 'owner' });
      });
    },

    async setStatus({ authUserId, householdId, status }) {
      await assertActiveMembershipRole(authUserId, householdId, ['owner']);
      return withTransaction(pool, async (client) => {
        // FIX-WS-D2-R2 item 3: lifecycle serializado sob o MESMO lock do
        // efeito (FOR UPDATE); o tombstone é a proibição autoritativa de
        // reativação — restore de tombstone recusa mesmo em corrida.
        const current = await client.query<Row>(
          `SELECT status FROM households WHERE id = $1 FOR UPDATE`,
          [householdId],
        );
        if (!current.rows[0]) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
        // D2: delete é permanente — restore de tombstone recusa.
        if (current.rows[0]?.['status'] === 'deleted') throw deletedWorkspace(householdId);
        const tombstone = await client.query<Row>(
          `SELECT 1 FROM workspace_tombstones WHERE household_id = $1`,
          [householdId],
        );
        if ((tombstone.rowCount ?? 0) > 0) throw deletedWorkspace(householdId);
        const result = await client.query<Row>(
          `UPDATE households
              SET status = $1,
                  archived_at = CASE WHEN $1 = 'archived' THEN COALESCE(archived_at, NOW()) ELSE NULL END
            WHERE id = $2 AND status <> 'deleted'
            RETURNING id, name, kind, status`,
          [status, householdId],
        );
        const workspace = result.rows[0];
        // UPDATE condicional: zero linhas = delete concorrente venceu a
        // corrida — o tombstone (proibição autoritativa) decide.
        if (!workspace) throw deletedWorkspace(householdId);
        return mapWorkspace({ ...workspace, role: 'owner' });
      });
    },

    async deletionInventory({ authUserId, householdId }) {
      await assertActiveMembershipRole(authUserId, householdId, ['owner']);
      const household = await queryInTransaction<Row>(
        pool,
        `SELECT id, status FROM households WHERE id = $1`,
        [householdId],
      );
      if (!household.rows[0]) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
      if (household.rows[0]['status'] === 'deleted') throw deletedWorkspace(householdId);
      const result = await queryInTransaction<Row>(pool, INVENTORY_SELECT, [householdId, householdId]);
      let secret: string;
      try {
        secret = resolveDeletionHmacSecret(opts?.deletionHmacSecret);
      } catch {
        // FIX-WS-D2-R4: sem segredo, a emissão é indisponível — 409
        // fail-closed (nunca emite versão forjável sem HMAC).
        throw agentAttestationUnavailable();
      }
      return inventoryFromRow(householdId, result.rows[0] ?? {}, secret);
    },

    async deleteEmpty({ authUserId, householdId, confirmation, purge }) {
      await assertActiveMembershipRole(authUserId, householdId, ['owner']);
      return withTransaction(pool, async (client) => {
        // Barreira de concorrência: trava a linha antes do inventário final.
        const locked = await client.query<Row>(
          `SELECT id, name, kind, status FROM households WHERE id = $1 FOR UPDATE`,
          [householdId],
        );
        const household = locked.rows[0];
        if (!household) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
        if (household['status'] === 'deleted') throw deletedWorkspace(householdId);
        // Purge com-dados BLOQUEADO: recusa dedicada, sem tocar nos dados.
        if (purge === true) {
          throw new WorkspaceError(
            'workspace.purge_blocked',
            409,
            'Purge com-dados bloqueado: retenção/exportação/política pendentes (D2).',
          );
        }
        // Inventário final recomputado SOB o lock: vínculo (contagens +
        // expiração apresentada, sob HMAC server-side), vazio real e
        // prova HMAC do lado Agent antes de qualquer efeito. A ordem é
        // intencional: `not_empty` precede a prova para preservar o
        // diagnóstico, e a prova fail-closed (ausente/inválida, ou
        // string declarada pelo cliente) BLOQUEIA tudo antes de
        // qualquer efeito — o delete nunca conclui sem atestação
        // emitida server-side pelo Agent (FIX-WS-D2-R4).
        const probed = await client.query<Row>(INVENTORY_SELECT, [householdId, householdId]);
        const liveCounts = toCounts(probed.rows[0] ?? {});
        const liveEmpty = Object.entries(liveCounts).every(([key, value]) =>
          key === 'memberships_active' ? value === 1 : value === 0,
        );
        if (!liveEmpty) {
          throw new WorkspaceError(
            'workspace.not_empty',
            409,
            'Workspace com dados: delete só é permitido vazio; purge com-dados está bloqueado (D2).',
          );
        }
        let secret: string;
        try {
          secret = resolveDeletionHmacSecret(opts?.deletionHmacSecret);
        } catch {
          // FIX-WS-D2-R4: sem segredo, a verificação é indisponível —
          // 409 fail-closed (nunca conclui sem prova verificável).
          throw agentAttestationUnavailable();
        }
        verifyDeleteConfirmation(confirmation, {
          workspaceId: householdId,
          actor: authUserId,
          inventoryVersion: boundInventoryVersion(
            householdId,
            liveCounts,
            confirmation.expiresAt,
            secret,
          ),
          agentProofSecret: secret,
        });
        await client.query(
          `INSERT INTO workspace_tombstones (household_id, deleted_by, inventory_version)
           VALUES ($1, $2, $3)
           ON CONFLICT (household_id) DO NOTHING`,
          [householdId, authUserId, confirmation.inventoryVersion],
        );
        await client.query(
          `INSERT INTO workspace_closure_log (household_id, closed_by, action, inventory_version, agent_attestation)
           VALUES ($1, $2, 'workspace.delete', $3, $4)
           ON CONFLICT (household_id) DO NOTHING`,
          [householdId, authUserId, confirmation.inventoryVersion, confirmation.agentAttestation],
        );
        const flipped = await client.query(
          `UPDATE households SET status = 'deleted' WHERE id = $1 AND status <> 'deleted'`,
          [householdId],
        );
        // UPDATE condicional: zero linhas = corrida perdida (segundo
        // delete) — sem reescrever nada, recusa como tombstone.
        if ((flipped.rowCount ?? 0) === 0) throw deletedWorkspace(householdId);
        return {
          id: householdId,
          deletedAt: new Date().toISOString(),
          inventoryVersion: confirmation.inventoryVersion,
        };
      });
    },

    async listMembers({ authUserId, householdId }) {
      await assertMembership(authUserId, householdId);
      const result = await queryInTransaction<Row>(
        pool,
        `SELECT u.auth_user_id AS user_id, COALESCE(u.name, u.email) AS name, u.email AS email, m.role AS role
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.household_id = $1 AND m.status = 'active'
          ORDER BY (m.role = 'owner') DESC, u.name ASC`,
        [householdId],
      );
      return result.rows.map((row) => ({
        userId: row['user_id'] as string,
        name: row['name'] as string,
        email: row['email'] as string,
        role: row['role'] as WorkspaceMember['role'],
        status: 'active' as const,
      }));
    },

    async removeMember({ authUserId, householdId, memberUserId }) {
      const { role } = await assertActiveMembershipRole(authUserId, householdId, ['owner']);
      if (role !== 'owner') {
        throw new WorkspaceError('workspace.forbidden', 403, 'Somente o owner pode remover membros.');
      }
      const revokedUserId = await withTransaction(pool, async (client) => {
        const householdResult = await client.query<Row>(
          `SELECT kind, owner_user_id, status FROM households WHERE id = $1`,
          [householdId],
        );
        const household = householdResult.rows[0];
        if (!household) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
        if (household['status'] === 'deleted') throw deletedWorkspace(householdId);
        if (household['kind'] === 'personal') {
          throw new WorkspaceError('workspace.personal', 400, 'Workspace pessoal não permite remoção de membros.');
        }
        // memberUserId is the Better Auth user id (auth_user_id); resolve to users.id
        const targetResult = await client.query<Row>(
          `SELECT id, auth_user_id FROM users WHERE auth_user_id = $1 OR id::text = $1`,
          [memberUserId],
        );
        const targetUser = targetResult.rows[0];
        if (!targetUser) throw new WorkspaceError('workspace.not_found', 404, 'Membro não encontrado.');
        const targetUsersId = targetUser['id'] as string;
        const ownerResult = await client.query<Row>(
          `SELECT COUNT(*)::int AS count FROM memberships WHERE household_id = $1 AND role = 'owner' AND status = 'active'`,
          [householdId],
        );
        const ownerCount = (ownerResult.rows[0]!['count'] as number) ?? 0;
        if (household['owner_user_id'] === targetUsersId || ownerCount <= 1) {
          const target = await client.query<Row>(
            `SELECT role FROM memberships WHERE household_id = $1 AND user_id = $2 AND status = 'active'`,
            [householdId, targetUsersId],
          );
          if (target.rows[0]?.['role'] === 'owner') {
            throw new WorkspaceError('workspace.last_owner', 400, 'Não é possível remover o último owner do workspace.');
          }
        }
        const updateResult = await client.query(
          `UPDATE memberships SET status = 'removed' WHERE household_id = $1 AND user_id = $2`,
          [householdId, targetUsersId],
        );
        return (updateResult.rowCount ?? 0) > 0 ? targetUsersId : undefined;
      });
      if (typeof revokedUserId === 'string' && revokedUserId.length > 0) {
        await hooks?.onMemberRevoked?.({ userId: revokedUserId, householdId });
      }
    },

    async leave({ authUserId, householdId }) {
      const { userId, role } = await assertMembership(authUserId, householdId);
      const revoked = await withTransaction(pool, async (client) => {
        const householdResult = await client.query<Row>(
          `SELECT kind, owner_user_id, status FROM households WHERE id = $1`,
          [householdId],
        );
        const household = householdResult.rows[0];
        if (!household) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
        if (household['status'] === 'deleted') throw deletedWorkspace(householdId);
        if (household['kind'] === 'personal' && household['owner_user_id'] === userId) {
          throw new WorkspaceError('workspace.personal', 400, 'O owner não pode sair do workspace pessoal.');
        }
        if (role === 'owner') {
          const ownerResult = await client.query<Row>(
            `SELECT COUNT(*)::int AS count FROM memberships WHERE household_id = $1 AND role = 'owner' AND status = 'active'`,
            [householdId],
          );
          const ownerCount = (ownerResult.rows[0]!['count'] as number) ?? 0;
          if (ownerCount <= 1) {
            throw new WorkspaceError('workspace.last_owner', 400, 'O último owner não pode sair do workspace.');
          }
        }
        const updateResult = await client.query(
          `UPDATE memberships SET status = 'removed' WHERE household_id = $1 AND user_id = $2`,
          [householdId, userId],
        );
        return updateResult.rowCount ?? 0;
      });
      if (revoked > 0) {
        await hooks?.onMemberRevoked?.({ userId, householdId });
      }
    },
  };
};

export type { WorkspaceSummary };
