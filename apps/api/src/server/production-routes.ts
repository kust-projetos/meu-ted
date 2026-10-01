import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createPostgresDeviceTokenStore, type DeviceTokenStore } from "../auth/device-token.js";
import type { InviteDelivery, InviteService } from "../auth/invites.js";
import { createPostgresBudgetStore } from "../budgets/postgres.js";
import { createLegacyPostgresCardStore } from "../cards/legacy-postgres.js";
import { createPostgresCardStore } from "../cards/postgres.js";
import { createLegacyPostgresGoalStore } from "../goals/legacy-postgres.js";
import { createPostgresGoalStore } from "../goals/postgres.js";
import { createLegacyPostgresPayableStore } from "../payables/legacy-postgres.js";
import { createPostgresPayableStore } from "../payables/postgres.js";
import { createPostgresProfileStore } from "../profile/postgres.js";
import { createWebPushDelivery } from "../push/delivery.js";
import { createPostgresPushSubscriptionStore } from "../push/postgres.js";
import type { PushSubscriptionStore } from "../push/store.js";
import type { VapidConfig } from "../push/vapid.js";
import { createLegacyPostgresReadModelStore } from "../read-models/legacy-postgres-store.js";
import { createPostgresReadModelStore } from "../read-models/postgres-store.js";
import { registerRoutes } from "../routes/index.js";
import { createSqlAnalyticsSource } from "../analytics/source.js";
import { createLegacyPostgresSubscriptionStore } from "../subscriptions/legacy-postgres.js";
import { createPostgresSubscriptionStore } from "../subscriptions/postgres.js";
import { createLegacyPostgresWriteStore } from "../writes/legacy-postgres.js";
import {
  createPostgresIdempotencyStore,
  createPostgresWriteStore,
} from "../writes/postgres.js";
import { createLegacyPostgresAuditLogStore, createPostgresAuditLogStore } from "../audit/store.js";
import { createLegacyBearerAuditSink } from "../audit/legacy-bearer-sink.js";
import { createUndoService } from "../approvals/undo.js";
import { InviteError, createInviteService } from "../auth/invites.js";
import { createPostgresInviteStore } from "../auth/invites-postgres.js";
import { createPostgresWorkspaceStore } from "../auth/workspaces-postgres.js";
import { createPostgresWorkspaceAccessStore } from "../auth/workspace-access.js";
import { createPostgresOwnershipTransferStore } from "../auth/ownership-transfers-postgres.js";
import { createAccountInviteService } from "../auth/account-invites.js";
import { createPostgresAccountInviteStore } from "../auth/account-invites-postgres.js";
import type { createBetterAuth } from "../auth/better-auth.js";
import type { WorkspaceAccessStore } from "../auth/workspace-access.js";

type BetterAuth = ReturnType<typeof createBetterAuth>;

export type PostgresInviteRuntime = {
  inviteService?: InviteService;
  authorizeInviteCreate?: (input: { userId: string; householdId: string }) => Promise<boolean>;
};

export const createPostgresInviteRuntime = (input: {
  pool: Pool;
  workspaceAccess?: WorkspaceAccessStore | undefined;
  delivery?: InviteDelivery | undefined;
}): PostgresInviteRuntime => {
  const { workspaceAccess, delivery } = input;
  if (!workspaceAccess) return {};

  const deliver = delivery ?? (async () => {
    throw new InviteError(
      "invite delivery is not configured",
      "invite.delivery_unavailable",
      503,
    );
  });

  const inviteService = createInviteService({
    store: createPostgresInviteStore(input.pool),
    deliver,
  });

  return {
    inviteService,
    authorizeInviteCreate: async ({ userId, householdId, email }: { userId: string; householdId: string; email?: string }) => {
      const access = await workspaceAccess.resolve(userId, householdId);
      if (!access || access.kind !== "shared") return false;
      if (access.role === "owner") return true;
      // Member can invite only when target already has an account (email exists in "user")
      if (access.role === "member") {
        if (!email) return false;
        const normalized = email.trim().toLowerCase();
        const result = await input.pool.query(
          `SELECT 1 FROM "user" WHERE lower(email) = $1 LIMIT 1`,
          [normalized],
        );
        return (result.rowCount ?? 0) > 0;
      }
      return false;
    },
  };
};

export type PostgresAccountInviteRuntime = {
  accountInviteService?: import("../auth/account-invites.js").AccountInviteService;
};

export const createPostgresAccountInviteRuntime = (input: {
  pool: Pool;
  delivery?: InviteDelivery | undefined;
}): PostgresAccountInviteRuntime => {
  const deliver = input.delivery ?? (async () => {
    throw new InviteError(
      "invite delivery is not configured",
      "invite.delivery_unavailable",
      503,
    );
  });

  const accountInviteService = createAccountInviteService({
    store: createPostgresAccountInviteStore(input.pool),
    deliver,
  });

  return { accountInviteService };
};

export const registerPostgresProductionRoutes = (
  app: FastifyInstance,
  pool: Pool,
  legacy: boolean,
  defaultHouseholdId: string,
  betterAuth?: BetterAuth,
  inviteDelivery?: InviteDelivery,
  vapid?: VapidConfig,
): void => {
  const pushStore = createPostgresPushSubscriptionStore(pool);
  const pushDelivery = vapid
    ? createWebPushDelivery({ store: pushStore, config: vapid })
    : undefined;
  const vapidPublicKey = vapid?.publicKey;

  const workspaceAccess = betterAuth ? createPostgresWorkspaceAccessStore(pool) : undefined;
  const revocationTargets: { tokens?: DeviceTokenStore; push?: PushSubscriptionStore } = {};
  revocationTargets.push = pushStore;
  const workspaceStore = betterAuth
    ? createPostgresWorkspaceStore(pool, {
        onMemberRevoked: async ({ userId, householdId }) => {
          if (!revocationTargets.tokens || !revocationTargets.push) {
            throw new Error('membership revocation cleanup stores are not wired');
          }
          await revocationTargets.tokens.revokeAllForUserWorkspace(userId, householdId);
          await revocationTargets.push.removeAllForUserWorkspace(householdId, userId);
        },
      })
    : undefined;
  const ownershipTransferStore = betterAuth ? createPostgresOwnershipTransferStore(pool) : undefined;
  const inviteRuntime = betterAuth
    ? createPostgresInviteRuntime({ pool, workspaceAccess, delivery: inviteDelivery })
    : {};
  const accountInviteRuntime = betterAuth
    ? createPostgresAccountInviteRuntime({ pool, delivery: inviteDelivery })
    : {};

  if (legacy) {
    const store = createLegacyPostgresReadModelStore({ pool });
    const writes = createLegacyPostgresWriteStore({ pool });
    const tokenStore = createPostgresDeviceTokenStore(pool);
    revocationTargets.tokens = tokenStore;
    const idempotency = createPostgresIdempotencyStore({ pool, legacy: true });
    const cardStore = createLegacyPostgresCardStore(pool);
    const payableStore = createLegacyPostgresPayableStore(pool);
    const budgetStore = createPostgresBudgetStore(pool);
    const goalStore = createLegacyPostgresGoalStore(pool);
    const subscriptionStore = createLegacyPostgresSubscriptionStore(pool);
    const profileStore = createPostgresProfileStore({ pool });
    const auditLogs = createLegacyPostgresAuditLogStore(pool);
    // FIX-P1-UNDO-BOOTSTRAP: UndoService com deps reais (antes /audit/undo
    // respondia `unsupported` neste bootstrap).
    // FIX-P1-UNDO-IDEMPOTENCY: MESMO IdempotencyStore dos writes.
    const undoService = createUndoService({ auditLogs, writes, idempotency });
    registerRoutes(app, {
      store,
      writes,
      tokenStore,
      idempotency,
      defaultHouseholdId,
      cardStore,
      payableStore,
      budgetStore,
      goalStore,
      subscriptionStore,
      profileStore,
      pushStore,
      auditLogs,
      undoService,
      legacyBearerAuditLog: createLegacyBearerAuditSink(pool),
      disableDeviceRegistration: true,
      analyticsSource: createSqlAnalyticsSource(pool, {
        legacy: true,
        stores: { store, cardStore, budgetStore, subscriptionStore },
      }),
      ...(betterAuth ? { auth: betterAuth } : {}),
      ...(workspaceAccess ? { workspaceAccess } : {}),
      ...(workspaceStore ? { workspaceStore } : {}),
      ...(ownershipTransferStore ? { ownershipTransferStore } : {}),
      ...inviteRuntime,
      ...accountInviteRuntime,
      ...(pushDelivery ? { pushDelivery } : {}),
      ...(vapidPublicKey ? { vapidPublicKey } : {}),
    });
    return;
  }

  const store = createPostgresReadModelStore({ pool });
  const writes = createPostgresWriteStore({ pool });
  const tokenStore = createPostgresDeviceTokenStore(pool);
  revocationTargets.tokens = tokenStore;
  const idempotency = createPostgresIdempotencyStore({ pool });
  const cardStore = createPostgresCardStore(pool);
  const payableStore = createPostgresPayableStore(pool);
  const budgetStore = createPostgresBudgetStore(pool);
  const goalStore = createPostgresGoalStore(pool);
  const subscriptionStore = createPostgresSubscriptionStore(pool);
  const profileStore = createPostgresProfileStore({ pool });
  const auditLogs = createPostgresAuditLogStore(pool);
  // FIX-P1-UNDO-BOOTSTRAP: UndoService com deps reais (antes /audit/undo
  // respondia `unsupported` neste bootstrap).
  // FIX-P1-UNDO-IDEMPOTENCY: MESMO IdempotencyStore dos writes.
  const undoService = createUndoService({ auditLogs, writes, idempotency });
  registerRoutes(app, {
    store,
    writes,
    tokenStore,
    idempotency,
    defaultHouseholdId,
    cardStore,
    payableStore,
    budgetStore,
    goalStore,
    subscriptionStore,
    profileStore,
    pushStore,
    auditLogs,
    undoService,
    legacyBearerAuditLog: createLegacyBearerAuditSink(pool),
    disableDeviceRegistration: true,
    analyticsSource: createSqlAnalyticsSource(pool, {
      stores: { store, cardStore, budgetStore, subscriptionStore },
    }),
    ...(betterAuth ? { auth: betterAuth } : {}),
    ...(workspaceAccess ? { workspaceAccess } : {}),
    ...(workspaceStore ? { workspaceStore } : {}),
    ...(ownershipTransferStore ? { ownershipTransferStore } : {}),
    ...inviteRuntime,
    ...accountInviteRuntime,
    ...(pushDelivery ? { pushDelivery } : {}),
    ...(vapidPublicKey ? { vapidPublicKey } : {}),
  });
};
