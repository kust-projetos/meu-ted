import { randomUUID } from 'node:crypto';

export type WorkspaceKind = 'personal' | 'shared';
export type WorkspaceRole = 'owner' | 'member';
export type WorkspaceStatus = 'active' | 'archived';

export type WorkspaceSummary = {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  status: WorkspaceStatus;
};

export type WorkspaceMember = {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  /** Membership lifecycle status. listMembers only returns active members. */
  status: 'active';
};

export type WorkspaceStore = {
  list(authUserId: string): Promise<WorkspaceSummary[]>;
  create(input: { authUserId: string; name: string; kind: WorkspaceKind }): Promise<WorkspaceSummary>;
  rename(input: { authUserId: string; householdId: string; name: string }): Promise<WorkspaceSummary>;
  setStatus(input: { authUserId: string; householdId: string; status: WorkspaceStatus }): Promise<WorkspaceSummary>;
  listMembers(input: { authUserId: string; householdId: string }): Promise<WorkspaceMember[]>;
  removeMember(input: { authUserId: string; householdId: string; memberUserId: string }): Promise<void>;
  leave(input: { authUserId: string; householdId: string }): Promise<void>;
};

export type WorkspaceRevocationHooks = {
  /**
   * Membership-revocation cleanup (V4.1 task 1.6): invoked after a membership
   * is actually revoked by removeMember/leave, with the revoked application
   * user id and workspace id. The hook runs after the membership transaction
   * commits; a hook failure rejects the call (the membership stays revoked)
   * so cleanup gaps stay visible instead of silent.
   */
  onMemberRevoked?: (input: { userId: string; householdId: string }) => Promise<void>;
};

export class WorkspaceError extends Error {
  constructor(
    readonly code: 'workspace.not_found' | 'workspace.forbidden' | 'workspace.personal' | 'workspace.last_owner' | 'workspace.invalid',
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export const createInMemoryWorkspaceStore = (hooks?: WorkspaceRevocationHooks): WorkspaceStore => {
  type StoredWorkspace = WorkspaceSummary & { ownerAuthUserId: string };
  const workspaces: StoredWorkspace[] = [];
  const members: Array<{ householdId: string; member: WorkspaceMember }> = [];

  const toSummary = (workspace: StoredWorkspace): WorkspaceSummary => ({
    id: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
    role: workspace.role,
    status: workspace.status,
  });

  const ownedWorkspace = (authUserId: string, householdId: string): StoredWorkspace => {
    const workspace = workspaces.find((candidate) => candidate.id === householdId);
    if (!workspace) throw new WorkspaceError('workspace.not_found', 404, 'Workspace não encontrado.');
    if (workspace.ownerAuthUserId !== authUserId) {
      throw new WorkspaceError('workspace.forbidden', 403, 'Usuário não é membro deste workspace.');
    }
    return workspace;
  };

  return {
    async list(authUserId) {
      // D1 (ADR-027) ordering: active first, personal before shared,
      // insertion order within a group (stable sort ≈ created_at, id).
      return workspaces
        .filter((workspace) => workspace.ownerAuthUserId === authUserId)
        .sort(
          (a, b) =>
            Number(b.status === 'active') - Number(a.status === 'active') ||
            Number(b.kind === 'personal') - Number(a.kind === 'personal'),
        )
        .map(toSummary);
    },
    async create(input) {
      // D1 (ADR-027): N personal workspaces per user — no 409 on
      // cardinality (mirrors the Postgres store + V061). Owner-exclusive
      // vetos below (removeMember/leave) are preserved.
      const summary: StoredWorkspace = {
        id: randomUUID(),
        name: input.name,
        kind: input.kind,
        role: 'owner',
        status: 'active',
        ownerAuthUserId: input.authUserId,
      };

      workspaces.push(summary);
      return toSummary(summary);
    },
    async rename(input) {
      const workspace = ownedWorkspace(input.authUserId, input.householdId);
      workspace.name = input.name;
      return toSummary(workspace);
    },
    async setStatus(input) {
      const workspace = ownedWorkspace(input.authUserId, input.householdId);
      workspace.status = input.status;
      return toSummary(workspace);
    },
    async listMembers(input) {
      ownedWorkspace(input.authUserId, input.householdId);
      return members
        .filter((m) => m.householdId === input.householdId)
        .map((m) => ({ ...m.member, status: 'active' as const }));
    },
    async removeMember(input) {
      const workspace = ownedWorkspace(input.authUserId, input.householdId);
      if (workspace.kind === 'personal') {
        throw new WorkspaceError('workspace.personal', 400, 'Workspace pessoal não permite remoção de membros.');
      }
      const idx = members.findIndex((m) => m.householdId === input.householdId && m.member.userId === input.memberUserId);
      if (idx === -1) return;
      members.splice(idx, 1);
      await hooks?.onMemberRevoked?.({ userId: input.memberUserId, householdId: input.householdId });
    },
    async leave(input) {
      const workspace = ownedWorkspace(input.authUserId, input.householdId);
      if (workspace.kind === 'personal') {
        throw new WorkspaceError('workspace.personal', 400, 'O owner não pode sair do workspace pessoal.');
      }
      const idx = members.findIndex((m) => m.householdId === input.householdId && m.member.userId === input.authUserId);
      if (idx !== -1) members.splice(idx, 1);
      await hooks?.onMemberRevoked?.({ userId: input.authUserId, householdId: input.householdId });
    },
  };
};
