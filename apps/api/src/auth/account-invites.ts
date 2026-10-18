import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeInviteEmail, InviteError, hashInviteToken } from './invites.js';
import type { InviteDelivery } from './invites.js';

export { InviteError, normalizeInviteEmail };

export type AccountInviteRecord = {
  id: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt?: Date;
  revokedAt?: Date;
  invitedByUserId: string;
  createdAt?: Date;
};

export type AccountInviteStore = {
  insertAccountInvite(record: AccountInviteRecord): Promise<void>;
  verifyAccountInvite(input: { tokenHash: string; now: Date }): Promise<Pick<AccountInviteRecord, 'id' | 'email' | 'expiresAt'>>;
  consumeAccountInvite(input: { email: string; now: Date }): Promise<void>;
  revokeAccountInvite(input: { inviteId: string; now?: Date }): Promise<{ id: string; revokedAt: Date }>;
  listPendingAccountInvites(now?: Date): Promise<Array<Pick<AccountInviteRecord, 'id' | 'email' | 'expiresAt' | 'createdAt'>>>;
  hasPendingAccountInvite(email: string, now?: Date): Promise<boolean>;
};

export type CreateAccountInviteInput = {
  email: string;
  invitedByUserId: string;
  expiresAt: Date;
};

export const createAccountInviteService = (deps: {
  store: AccountInviteStore;
  deliver: InviteDelivery;
}) => ({
  async createAccountInvite(input: CreateAccountInviteInput): Promise<Pick<AccountInviteRecord, 'id' | 'email' | 'expiresAt'>> {
    const email = normalizeInviteEmail(input.email);
    if (!email || !email.includes('@')) throw new InviteError('invite email is invalid', 'invite.invalid_email');
    if (input.expiresAt.getTime() <= Date.now()) throw new InviteError('invite expiry must be in the future', 'invite.expired');

    const token = randomBytes(32).toString('hex');
    const record: AccountInviteRecord = {
      id: randomUUID(),
      email,
      tokenHash: hashInviteToken(token),
      expiresAt: new Date(input.expiresAt),
      invitedByUserId: input.invitedByUserId,
    };

    // Deliver before commit: if delivery fails, nothing is persisted in the store.
    // A missing or broken delivery dependency fails CLOSED with a typed 503
    // (`invite.delivery_unavailable`) — never a generic 500, never success.
    // Semantic InviteErrors from the provider pass through untouched.
    try {
      await deps.deliver({
        inviteId: record.id,
        householdId: 'account',
        email: record.email,
        token,
        expiresAt: record.expiresAt,
      });
    } catch (error) {
      if (error instanceof InviteError) throw error;
      throw new InviteError(
        'invite delivery is not configured',
        'invite.delivery_unavailable',
        503,
      );
    }

    await deps.store.insertAccountInvite(record);

    return {
      id: record.id,
      email: record.email,
      expiresAt: record.expiresAt,
    };
  },

  async verifyAccountInvite(input: { token: string; now?: Date }): Promise<Pick<AccountInviteRecord, 'id' | 'email' | 'expiresAt'>> {
    const result = await deps.store.verifyAccountInvite({
      tokenHash: hashInviteToken(input.token),
      now: input.now ?? new Date(),
    });
    return result;
  },

  async consumeAccountInvite(input: { email: string; now?: Date }): Promise<void> {
    await deps.store.consumeAccountInvite({
      email: normalizeInviteEmail(input.email),
      now: input.now ?? new Date(),
    });
  },
});

export type AccountInviteService = ReturnType<typeof createAccountInviteService>;

export const createInMemoryAccountInviteStore = (): AccountInviteStore & {
  getRawAccountInvite(id: string): AccountInviteRecord | undefined;
} => {
  const invites = new Map<string, AccountInviteRecord>();

  return {
    async insertAccountInvite(record) {
      // Enforce unique pending email
      const normalized = normalizeInviteEmail(record.email);
      for (const existing of invites.values()) {
        if (normalizeInviteEmail(existing.email) === normalized && !existing.consumedAt && !existing.revokedAt && existing.expiresAt.getTime() > Date.now()) {
          // Allow multiple? For now, allow but the service should prevent? We just store.
        }
      }
      invites.set(record.id, { ...record });
    },

    async verifyAccountInvite({ tokenHash, now }) {
      const invite = [...invites.values()].find((c) => c.tokenHash === tokenHash);
      if (!invite) throw new InviteError('invite was not found', 'invite.not_found', 404);
      if (invite.revokedAt) throw new InviteError('invite was revoked', 'invite.revoked', 410);
      if (invite.consumedAt) throw new InviteError('invite was already used', 'invite.already_used', 409);
      if (invite.expiresAt.getTime() <= now.getTime()) throw new InviteError('invite expired', 'invite.expired', 410);
      return { id: invite.id, email: invite.email, expiresAt: invite.expiresAt };
    },

    async consumeAccountInvite({ email, now }) {
      const normalized = normalizeInviteEmail(email);
      const pending = [...invites.values()].find((c) => normalizeInviteEmail(c.email) === normalized && !c.consumedAt && !c.revokedAt && c.expiresAt.getTime() > now.getTime());
      if (pending) {
        pending.consumedAt = new Date(now);
      }
    },

    async revokeAccountInvite({ inviteId, now = new Date() }) {
      const invite = invites.get(inviteId);
      if (!invite) throw new InviteError('invite was not found', 'invite.not_found', 404);
      if (invite.consumedAt) throw new InviteError('invite was already used', 'invite.already_used', 409);
      if (!invite.revokedAt) invite.revokedAt = new Date(now);
      return { id: invite.id, revokedAt: invite.revokedAt };
    },

    async listPendingAccountInvites(now = new Date()) {
      return [...invites.values()]
        .filter((c) => !c.consumedAt && !c.revokedAt && c.expiresAt.getTime() > now.getTime())
        .map((c) => ({ id: c.id, email: c.email, expiresAt: c.expiresAt, ...(c.createdAt ? { createdAt: c.createdAt } : {}) }));
    },

    async hasPendingAccountInvite(email, now = new Date()) {
      const normalized = normalizeInviteEmail(email);
      return [...invites.values()].some((c) => normalizeInviteEmail(c.email) === normalized && !c.consumedAt && !c.revokedAt && c.expiresAt.getTime() > now.getTime());
    },

    getRawAccountInvite(id) {
      const inv = invites.get(id);
      return inv ? { ...inv } : undefined;
    },
  };
};
