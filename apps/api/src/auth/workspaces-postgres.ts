import type { Pool } from 'pg';
import { withTransaction, queryInTransaction } from '../db/pool.js';
import type { WorkspaceKind, WorkspaceMember, WorkspaceRevocationHooks, WorkspaceRole, WorkspaceStatus, WorkspaceStore, WorkspaceSummary } from './workspaces-store.js';
import { WorkspaceError } from './workspaces-store.js';

type Row = Record<string, unknown>;

const mapWorkspace = (row: Row): WorkspaceSummary => ({
  id: row['id'] as string,
  name: row['name'] as string,
  kind: row['kind'] as WorkspaceKind,
  role: row['role'] as WorkspaceRole,
  status: (row['status'] as WorkspaceStatus | undefined) ?? 'active',
});

export const createPostgresWorkspaceStore = (pool: Pool, hooks?: WorkspaceRevocationHooks): WorkspaceStore => {
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
        const result = await client.query<Row>(
          `UPDATE households
              SET name = $1
            WHERE id = $2
            RETURNING id, name, kind, status`,
          [name, householdId],
        );
        const workspace = result.rows[0];
        if (!workspace) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
        return mapWorkspace({ ...workspace, role: 'owner' });
      });
    },

    async setStatus({ authUserId, householdId, status }) {
      await assertActiveMembershipRole(authUserId, householdId, ['owner']);
      return withTransaction(pool, async (client) => {
        const result = await client.query<Row>(
          `UPDATE households
              SET status = $1,
                  archived_at = CASE WHEN $1 = 'archived' THEN COALESCE(archived_at, NOW()) ELSE NULL END
            WHERE id = $2
            RETURNING id, name, kind, status`,
          [status, householdId],
        );
        const workspace = result.rows[0];
        if (!workspace) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
        return mapWorkspace({ ...workspace, role: 'owner' });
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
          `SELECT kind, owner_user_id FROM households WHERE id = $1`,
          [householdId],
        );
        const household = householdResult.rows[0];
        if (!household) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
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
          `SELECT kind, owner_user_id FROM households WHERE id = $1`,
          [householdId],
        );
        const household = householdResult.rows[0];
        if (!household) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
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
