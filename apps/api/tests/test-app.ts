import Fastify, { type FastifyInstance } from "fastify";
import { createPendingOperationV2Executor, registerRoutes } from "../src/routes/index.js";
import { createInMemoryAuditLogStore, type AuditLogStore } from "../src/audit/store.js";
import type { OwnershipTransferStore } from "../src/auth/ownership-transfers-postgres.js";
import type { BetterAuth } from "../src/auth/better-auth.js";
import type { InviteService } from "../src/auth/invites.js";
import { createInMemoryWorkspaceStore, type WorkspaceStore } from "../src/auth/workspaces-http.js";
import { createInMemoryPriceAlertStore, type PriceAlertStore } from "../src/price-alerts/store.js";

import {
  createInMemoryReadModelStore,
  type ReadModelStore,
} from "../src/read-models/store.js";
import {
  createInMemoryStores,
  type InMemoryState,
} from "../src/writes/in-memory.js";
import { createInMemoryIdempotencyStore } from "../src/writes/idempotency.js";
import { type DeviceTokenStore, getDeviceRotationWindowMs } from "../src/auth/device-token.js";
import { registerCors } from "../src/server/cors.js";
import { HOUSEHOLD_A, HOUSEHOLD_B } from "./fixtures/seed.js";
import type { Account, Category, Transaction } from "../src/types/domain.js";
import { createInMemoryCardStore } from "../src/cards/in-memory.js";
import { createInMemoryPayableStore } from "../src/payables/in-memory.js";
import { createInMemoryBudgetStore } from "../src/budgets/in-memory.js";
import { createInMemoryGoalStore } from "../src/goals/in-memory.js";
import { createInMemorySubscriptionStore } from "../src/subscriptions/in-memory.js";
import { createInMemoryProfileStore } from "../src/profile/in-memory.js";
import { createInMemoryPushSubscriptionStore } from "../src/push/store.js";
import type { PushDelivery } from "../src/push/delivery.js";
import type { AdoptionStore } from "../src/observability/adoption.js";
import type { PendingOperationStore } from "../src/approvals/pending.js";
import type { PendingOperationV2Store } from "../src/approvals/pending-v2.js";
import { createUndoService } from "../src/approvals/undo.js";
export type TestAppOptions = {
  clock?: () => Date;
};

export type TestApp = {
  app: FastifyInstance;
  store: ReadModelStore;
  state: InMemoryState;
};

const createTestTokenStore = (): DeviceTokenStore => {
  const tokens = new Map<string, { deviceId: string; householdId: string; expiresAt: number | null; userId: string | null }>();
  tokens.set("dev-token-1", {
    deviceId: "dev-device-1",
    householdId: HOUSEHOLD_A,
    expiresAt: null,
    userId: null,
  });
  tokens.set("dev-token-2", {
    deviceId: "dev-device-2",
    householdId: HOUSEHOLD_B,
    expiresAt: null,
    userId: null,
  });
  return {
    async resolve(token) {
      if (!token || token.trim() === "")
        throw Object.assign(new Error("missing"), {
          statusCode: 401,
          code: "auth.missing_token",
        });
      const ctx = tokens.get(token);
      if (!ctx)
        throw Object.assign(new Error("invalid"), {
          statusCode: 401,
          code: "auth.invalid_token",
        });
      if (ctx.expiresAt !== null && ctx.expiresAt <= Date.now()) {
        tokens.delete(token);
        throw Object.assign(new Error("invalid"), {
          statusCode: 401,
          code: "auth.invalid_token",
        });
      }
      return { deviceId: ctx.deviceId, householdId: ctx.householdId, userId: ctx.userId };
    },
    async register(deviceName, householdId, opts?: { userId?: string }) {
      const tok = crypto.randomUUID();
      const devId = crypto.randomUUID();
      tokens.set(tok, { deviceId: devId, householdId, expiresAt: null, userId: opts?.userId ?? null });
      return { token: tok, deviceId: devId, householdId };
    },
    async revoke(token) {
      tokens.delete(token);
    },
    async revokeAllForUserWorkspace(userId, householdId) {
      let revoked = 0;
      for (const [token, record] of tokens) {
        if (record.userId === userId && record.householdId === householdId) {
          tokens.delete(token);
          revoked += 1;
        }
      }
      return revoked;
    },
    async rotate(currentToken, deviceName, householdId, opts?: { userId?: string }) {
      if (typeof currentToken === "string" && currentToken.trim() !== "") {
        const prev = tokens.get(currentToken);
        if (!prev || (prev.expiresAt !== null && prev.expiresAt <= Date.now())) {
          if (prev) tokens.delete(currentToken);
          throw Object.assign(new Error("invalid"), {
            statusCode: 401,
            code: "auth.invalid_token",
          });
        }
        if (householdId && prev.householdId !== householdId) {
          throw Object.assign(new Error("invalid"), {
            statusCode: 401,
            code: "auth.invalid_token",
          });
        }
      }
      const tok = crypto.randomUUID();
      const devId = crypto.randomUUID();
      tokens.set(tok, { deviceId: devId, householdId, expiresAt: null, userId: opts?.userId ?? null });
      if (typeof currentToken === "string" && currentToken.trim() !== "") {
        const prev = tokens.get(currentToken);
        if (prev) {
          const deadline = Date.now() + getDeviceRotationWindowMs();
          prev.expiresAt = prev.expiresAt === null ? deadline : Math.min(prev.expiresAt, deadline);
        }
      }
      return { token: tok, deviceId: devId, householdId };
    },
  };
};

export const buildTestApp = (
  seed: {
    accounts?: Account[];
    categories?: Category[];
    transactions?: Transaction[];
  } = {},
  ...optional: unknown[]
): TestApp => {
  const { state, writes } = createInMemoryStores(seed);
  const clock = optional.find(
    (value): value is () => Date => {
      if (typeof value !== "function") return false;
      try {
        return (value as () => unknown)() instanceof Date;
      } catch {
        return false;
      }
    },
  );
  const store = createInMemoryReadModelStore({
    accounts: state.accounts,
    categories: state.categories,
    transactions: state.transactions,
    deletedTransactionIds: state.deletedTransactions,
  });
  const cardStore = createInMemoryCardStore(state);
  const payableStore = createInMemoryPayableStore(state, clock);
  const budgetStore = createInMemoryBudgetStore(state, clock);
  const goalStore = createInMemoryGoalStore(state);
  const subscriptionState = {
    subscriptions: [] as import("../src/types/domain.js").Subscription[],
  };
  const subscriptionStore = createInMemorySubscriptionStore(subscriptionState);
  const profileStore = createInMemoryProfileStore();
  const pushStore = createInMemoryPushSubscriptionStore();
  const pushDelivery = optional.find(
    (value): value is PushDelivery =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { sendToWorkspace?: unknown }).sendToWorkspace ===
        "function",
  );
  const adoptionStore = optional.find(
    (value): value is AdoptionStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { record?: unknown }).record === "function" &&
      typeof (value as { funnel?: unknown }).funnel === "function",
  );
  const pendingStore = optional.find(
    (value): value is PendingOperationStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { create?: unknown }).create === "function" &&
      typeof (value as { findByChatId?: unknown }).findByChatId === "function",
  );
  // P3 E2E: an injected V2 store turns this composition into the real
  // Pending V2 surface (propose/active/confirm/execute). The executor is the
  // SAME API-owned bridge used in production, bound to the in-memory write
  // store; existing tests that inject nothing keep the previous behavior.
  const pendingV2Store = optional.find(
    (value): value is PendingOperationV2Store =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { propose?: unknown }).propose === "function" &&
      typeof (value as { listActive?: unknown }).listActive === "function" &&
      typeof (value as { findByIdempotencyKey?: unknown }).findByIdempotencyKey === "function",
  );
  const auditLogsSeed = (seed as { auditLogs?: Parameters<typeof createInMemoryAuditLogStore>[0] }).auditLogs;
  const auditStore =
    auditLogsSeed !== undefined
      ? createInMemoryAuditLogStore(auditLogsSeed)
      : (optional.find(
          (value): value is AuditLogStore =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as AuditLogStore).listAuditLogs === "function",
        ) ?? createInMemoryAuditLogStore());
  // FIX-P1-UNDO-IDEMPOTENCY: o UndoService compartilha o MESMO
  // IdempotencyStore dos writes (nada de cache paralelo por instância).
  const idempotency = createInMemoryIdempotencyStore();
  const undoService = createUndoService({ auditLogs: auditStore, writes, idempotency });
  const ownershipTransferStore = optional.find(
    (value): value is OwnershipTransferStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as OwnershipTransferStore).create === "function" &&
      typeof (value as OwnershipTransferStore).accept === "function",
  );
  const auth = optional.find(
    (value): value is BetterAuth =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as BetterAuth).api === "object" &&
      typeof (value as BetterAuth).options === "object",
  );
  const inviteService = optional.find(
    (value): value is InviteService =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as InviteService).createInvite === "function" &&
      typeof (value as InviteService).acceptInvite === "function",
  );
  const authorizeInviteCreate = optional.find(
    (value): value is (input: { userId: string; householdId: string }) => Promise<boolean> =>
      typeof value === "function",
  );
  const workspaceStore = optional.find(
    (value): value is WorkspaceStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as WorkspaceStore).list === "function" &&
      typeof (value as WorkspaceStore).create === "function" &&
      typeof (value as WorkspaceStore).listMembers === "function",
  );
  const workspaceAccess = optional.find(
    (value): value is import("../src/auth/workspace-access.js").WorkspaceAccessStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { resolve?: unknown }).resolve === "function",
  );
  const customTokenStore = optional.find(
    (value): value is DeviceTokenStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as DeviceTokenStore).resolve === "function" &&
      typeof (value as DeviceTokenStore).register === "function" &&
      typeof (value as DeviceTokenStore).revoke === "function",
  );
  const disableDeviceRegistration = optional.find(
    (value): value is boolean => typeof value === "boolean",
  ) ?? true;
  const delegationSecret = optional.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const approvalPolicy = optional.find(
    (value): value is import("../src/approvals/policy.js").ApprovalPolicy =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { evaluate?: unknown }).evaluate === "function",
  );
  const priceAlertStore = optional.find(
    (value): value is PriceAlertStore =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as PriceAlertStore).createAlert === "function" &&
      typeof (value as PriceAlertStore).listAlerts === "function",
  );
  const app = Fastify({ logger: false });
  registerCors(app);
  registerRoutes(app, {
    store,
    writes,
    tokenStore: customTokenStore ?? createTestTokenStore(),
    idempotency,
    cardStore,
    payableStore,
    budgetStore,
    goalStore,
    subscriptionStore,
    profileStore,
    pushStore,
    ...(priceAlertStore ? { priceAlertStore } : { priceAlertStore: createInMemoryPriceAlertStore() }),
    // Phase 7 (V4.1 Task 7.8): the test composition explicitly opts into
    // the price-alerts surface (production default is OFF/unmounted).
    enablePriceAlerts: true,
    vapidPublicKey: "test-vapid-public-key",
    disableDeviceRegistration,
    ...(delegationSecret ? { delegationSecret } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(pushDelivery ? { pushDelivery } : {}),
    ...(pendingStore ? { pendingStore } : {}),
    ...(pendingV2Store
      ? {
          pendingV2Store,
          pendingV2Executor: createPendingOperationV2Executor(writes, cardStore),
          pendingV2ReadModel: store,
        }
      : {}),
    ...(adoptionStore ? { adoptionStore } : {}),
    auditLogs: auditStore,
    undoService,
    ...(ownershipTransferStore ? { ownershipTransferStore } : {}),
    ...(auth ? { auth } : {}),
    ...(workspaceAccess ? { workspaceAccess } : {}),
    ...(inviteService ? { inviteService } : {}),
    ...(authorizeInviteCreate ? { authorizeInviteCreate } : {}),
    ...(auth ? { workspaceStore: workspaceStore ?? createInMemoryWorkspaceStore() } : workspaceStore ? { workspaceStore } : {}),
    ...(clock ? { clock } : {}),
  });

  return { app, store, state };
};

export const TOKEN_A = "dev-token-1";
export const TOKEN_B = "dev-token-2";
