import type { FastifyInstance } from "fastify";
import { type ReadModelStore } from "../read-models/store.js";
import {
  type DeviceTokenStore,
  createInMemoryDeviceTokenStore,
  DEVICE_TOKEN_HEADER,
} from "../auth/device-token.js";
import { type WriteStore } from "../writes/store.js";
import {
  type IdempotencyStore,
  createInMemoryIdempotencyStore,
  requireIdempotencyKey,
} from "../writes/idempotency.js";
import type { AuthResolver } from "./auth.js";
import type { CardStore } from "../cards/store.js";
import type { PayableStore } from "../payables/store.js";
import type { BudgetStore } from "../budgets/store.js";
import type { GoalStore } from "../goals/store.js";
import type { SubscriptionStore } from "../subscriptions/store.js";
import type { ProfileStore } from "../profile/store.js";
import type { PendingExecutor, PendingOperationExecutor, PendingOperationStore } from "../approvals/pending.js";
import { createInMemoryPendingOperationStore } from "../approvals/pending.js";
import type { PushSubscriptionStore } from "../push/store.js";
import type { PushDelivery } from "../push/delivery.js";
import {
  createInMemoryAdoptionStore,
  type AdoptionStore,
} from "../observability/adoption.js";
import {
  createInMemoryShadowDivergenceStore,
  type ShadowDivergenceStore,
} from "../observability/shadow-divergence.js";
import { registerShadowObservabilityRoutes } from "./shadow-observability.js";
import { registerAuthRoutes } from "./auth.js";
import { registerPendingOperationRoutes } from "./pending-operations.js";
import { registerAccountRoutes } from "./accounts.js";
import { registerCategoryRoutes } from "./categories.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { createStoreAnalyticsSource, type AnalyticsSource } from "../analytics/source.js";
import { registerTransactionRoutes } from "./transactions.js";
import { registerTransactionWriteRoutes } from "./transactions-write.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerInsightRoutes } from "./insights.js";
import { registerProfileRoutes } from "./profile.js";
import { registerCardRoutes } from "./cards.js";
import { registerPayableRoutes } from "./payables.js";
import { registerBudgetRoutes } from "./budgets.js";
import { registerGoalRoutes } from "./goals.js";
import { registerSubscriptionRoutes } from "./subscriptions.js";
import { registerPushRoutes } from "./push.js";
import { registerAdoptionRoutes } from "./adoption.js";
import { registerClientEventsRoutes } from "./client-events.js";
import { registerAuditRoutes } from "./audit.js";
import { registerDuplicateDetectRoutes } from "./duplicate-detect.js";
import { registerOwnershipTransferRoutes } from "../auth/ownership-transfers-http.js";
import type { OwnershipTransferStore } from "../auth/ownership-transfers-postgres.js";
import type { AuditLogStore } from "../audit/store.js";
import { createInMemoryAuditLogStore } from "../audit/store.js";
import { registerBetterAuthRoutes } from "../auth/better-auth-http.js";
import { registerInviteRoutes } from "../auth/invites-http.js";
import { registerWorkspaceRoutes } from "../auth/workspaces-http.js";
import { registerAdminInviteRoutes } from "./admin-invites.js";
import { registerAccountInviteRoutes } from "../auth/account-invites-http.js";
import type { AdminInviteDelivery } from "../auth/admin-invite-service.js";
import type { BetterAuth } from "../auth/better-auth.js";
import type { InviteService } from "../auth/invites.js";
import type { WorkspaceStore } from "../auth/workspaces-http.js";
import type { AccountInviteService } from "../auth/account-invites.js";

import type { WorkspaceAccessStore } from "../auth/workspace-access.js";
import { getBetterAuthSessionContext } from "../auth/better-auth.js";
import { buildObservabilityEvent } from "../audit/events.js";
import { createInMemoryPriceAlertStore, type PriceAlertStore } from "../price-alerts/store.js";
import { isPriceAlertsEnabled, registerPriceAlertRoutes } from "./price-alerts.js";
import { registerAgentAuthRoutes } from "./agent-auth.js";
import { registerAdminAgentLlmConfigRoutes, type AdminLlmReadAudit } from "./admin-agent-llm-config.js";
import { registerInternalAgentLlmConfigRoutes } from "./internal-agent-llm-config.js";
import { registerAgentLlmRelayRoutes } from "./internal-agent-llm-relay.js";
import { createInMemoryLlmConfigStore } from "../agent/llm-config-memory.js";
import type { LlmConfigStore } from "../agent/llm-config-store.js";
import { createInMemoryAgentReplayStore, type AgentReplayStore } from "../auth/agent-connection-token-replay.js";
import { registerWorkspaceAliasRoutes } from "../auth/workspace-alias.js";
import { requireApprovalToolContract } from "../approvals/tool-registry.js";
import { createUndoService } from "../approvals/undo.js";

export type RouteDeps = {
  store: ReadModelStore;
  writes: WriteStore;
  tokenStore?: DeviceTokenStore;
  idempotency?: IdempotencyStore;
  pendingStore?: PendingOperationStore;
  pendingExecutor?: PendingOperationExecutor;
  undoService?: import('../approvals/undo.js').UndoService;
  defaultHouseholdId?: string;
  cardStore?: CardStore;
  payableStore?: PayableStore;
  budgetStore?: BudgetStore;
  goalStore?: GoalStore;
  subscriptionStore?: SubscriptionStore;
  profileStore?: ProfileStore;
  pushStore?: PushSubscriptionStore;
  pushDelivery?: PushDelivery;
  adoptionStore?: AdoptionStore;
  shadowDivergenceStore?: ShadowDivergenceStore;
  delegationSecret?: string;
  vapidPublicKey?: string;
  auditLogs?: AuditLogStore;
  ownershipTransferStore?: OwnershipTransferStore;
  auth?: BetterAuth;
  workspaceAccess?: WorkspaceAccessStore;
  inviteService?: InviteService;
  authorizeInviteCreate?: (input: { userId: string; householdId: string }) => Promise<boolean>;
  workspaceStore?: WorkspaceStore;
  adminEmails?: string[];
  adminInviteDelivery?: AdminInviteDelivery;
  accountInviteService?: AccountInviteService;
  disableDeviceRegistration?: boolean;
  approvalPolicy?: import('../approvals/policy.js').ApprovalPolicy;
  clock?: () => Date;
  priceAlertStore?: PriceAlertStore;
  /**
   * Phase 7 (V4.1 Task 7.8): explicit opt-in for the price-alerts surface.
   * `true` mounts /alerts/price* (dev/test); `false` leaves them unmounted;
   * `undefined` falls back to the PI_FEATURE_PRICE_ALERTS env flag (default
   * OFF). Production composition passes nothing → OFF.
   */
  enablePriceAlerts?: boolean;
  llmConfigStore?: LlmConfigStore;
  agentConnectionSecret?: string;
  agentConfigToken?: string;
  agentAuthServiceToken?: string;
  agentReplayStore?: AgentReplayStore;
  agentRuntimeOrigin?: string;
  agentRuntimeAdminToken?: string;
  trustedOrigins?: string[];
  /** Fase 3 item 9: optional audit sink for sensitive admin LLM reads. */
  adminLlmAuditLog?: (event: AdminLlmReadAudit) => void;
  /**
   * V4 T2.2 / T0.4.1 (SPEC §24.1): sink para `auth.request.legacy_bearer_used`
   * — emitido SOMENTE quando o cookie/session não autenticou a request E o
   * bearer legado foi o autenticador efetivo do fallback (dimensão:
   * workspace_id; contrato via buildObservabilityEvent, sem credenciais).
   * Segue o padrão de injeção existente das rotas (cf. adminLlmAuditLog):
   * sem sink, o default é o structured logger (best-effort, nunca quebra auth).
   */
  legacyBearerAuditLog?: (event: LegacyBearerUsedAuditEvent) => void;
  inviteSignupGuard?: import('../auth/invite-signup-guard.js').InviteSignupGuard;
  pool?: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> } | null;
  /** Overrides the analytics source (SQL-backed in production, store-backed by default). */
  analyticsSource?: AnalyticsSource;
};

/**
 * V4 T2.2 / T0.4.1 (SPEC §24.1): evento de telemetria de uso EFETIVO do
 * fallback bearer legado. É o evento CANÔNICO do contrato fail-closed
 * (buildObservabilityEvent): { eventType, payload: { workspaceId } } —
 * nunca carrega credencial, cookie, token ou header.
 */
export type LegacyBearerUsedAuditEvent = {
  eventType: 'auth.request.legacy_bearer_used';
  payload: { workspaceId: string };
};

const SESSION_BEARER_FALLBACK_OFF_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * V4 T2.3 B3.7 (SPEC §8 B3 passo 7, ADR-015): gate do fallback bearer de
 * sessão server-side. Default TRUE durante a janela de compatibilidade
 * (janela ADR-011, review 2026-12-01). Com `SESSION_BEARER_FALLBACK_ENABLED`
 * off, o bearer de sessão legado é rejeitado como autenticador — a sessão
 * resolve SOMENTE via cookie HttpOnly (session-first); bearer-only resulta
 * em 401 (ou fallback a device token quando aplicável). Leitura em
 * call-time para permitir toggle em teste. Device tokens e tokens delegados
 * (`pi-agent`) seguem seus próprios caminhos e não são afetados.
 */
export function isSessionBearerFallbackEnabled(env?: Record<string, string | undefined>): boolean {
  try {
    const source = env ?? (typeof process !== 'undefined' ? process.env : undefined);
    const raw = source?.['SESSION_BEARER_FALLBACK_ENABLED'];
    if (raw === undefined) return true;
    return !SESSION_BEARER_FALLBACK_OFF_VALUES.has(raw.trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * True when `authorization` carries a pi-agent delegated turn token
 * (`iss: "pi-agent"`). Delegated tokens follow their own verification path
 * and are NEVER treated as legacy session bearers (kill-switch exempt).
 */
function isPiAgentBearer(authorization: unknown): boolean {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  try {
    const [, p] = authorization.slice('Bearer '.length).trim().split('.');
    if (!p) return false;
    const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { iss?: string };
    return j.iss === 'pi-agent';
  } catch {
    return false;
  }
}
/**
 * The API-owned V2 executor is the only bridge from a canonical pending tool
 * to financial WriteStore methods. It deliberately accepts only the two TED
 * transaction tool ids and never trusts identity fields from normalizedArgs.
 *
 * P1 (audit item 7): every mutation executes with the pending operation's
 * persisted idempotencyKey, so a retry after partial failure replays the
 * first attempt's transaction instead of booking a second one.
 *
 * V2 execution audit: the server-persisted actorId (pending-operation
 * record binding, verified at execute-claim time) is threaded into the
 * executor so the keyed write commits its undo-eligible audit row with the
 * correct actor. No actor identity is ever read from normalizedArgs.
 */
export const createPendingOperationV2Executor = (writes: WriteStore): PendingExecutor => async (operation) => {
  const contract = requireApprovalToolContract(operation.tool);
  return contract.executor({
    writes,
    workspaceId: operation.workspaceId,
    args: operation.normalizedArgs,
    idempotencyKey: operation.idempotencyKey,
    actorId: operation.actorId,
  });
};


export const registerRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const tokenStore = deps.tokenStore ?? createInMemoryDeviceTokenStore();
  const idempotency = deps.idempotency ?? createInMemoryIdempotencyStore();
  const pendingStore = deps.pendingStore ?? createInMemoryPendingOperationStore();
  // FIX-P1-UNDO-BOOTSTRAP: nenhum bootstrap de produção injetava
  // `undoService`, então POST /audit/undo respondia `unsupported` em runtime
  // apesar dos testes de rota injetarem o serviço. Fallback autoritativo com
  // deps reais — a mesma instância serve /audit/undo e
  // /pending-operations/undo. `deps.undoService` explícito tem precedência.
  // FIX-P1-UNDO-IDEMPOTENCY: o fallback compartilha o MESMO IdempotencyStore
  // dos writes (nada de cache paralelo por instância).
  const auditLogs = deps.auditLogs ?? createInMemoryAuditLogStore();
  const undoService = deps.undoService ?? createUndoService({ auditLogs, writes: deps.writes, idempotency });
  const resolveToken: AuthResolver = async (token) => tokenStore.resolve(token);
  const clock = deps.clock ?? (() => new Date());

  if (deps.auth && deps.workspaceAccess) {
    const auth = deps.auth;
    const workspaceAccess = deps.workspaceAccess;
    app.addHook("preHandler", async (request, reply) => {
      const isAuthRoute =
        request.url.startsWith('/auth/') ||
        request.url.startsWith('/api/auth');
      // FIX-AUTH-BOOT FINDING 1 (HIGH): o kill-switch do fallback bearer
      // legado (T2.3) vale para TODA chamada a Better-Auth, incluindo /auth/*
      // e /api/auth/* — sem exceção para auth. Com a flag OFF, o bearer de
      // sessão legado é removido do request ANTES de qualquer resolução, de
      // modo que register/rotate/session por bearer legado falham
      // fail-closed (nenhum device token mintado). Preservados: pi-agent
      // (delegated), X-Device-Token e cookie (só `authorization` é removido).
      if (!isSessionBearerFallbackEnabled() && !isPiAgentBearer(request.headers.authorization)) {
        delete request.headers.authorization;
      }
      if (
        request.url === '/health' ||
        isAuthRoute ||
        request.url.startsWith('/bridge/')
      ) {
        return;
      }

      if (isPiAgentBearer(request.headers.authorization)) return;

      const workspaceIdHeader = request.headers['x-workspace-id'];
      const workspaceId = Array.isArray(workspaceIdHeader) ? workspaceIdHeader[0] : workspaceIdHeader;

      const headers = new Headers();
      for (const [key, val] of Object.entries(request.headers)) {
        if (val !== undefined) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
      }
      // T2.3 B3.7: fallback desligado => resolução de sessão cookie-only
      // (o bearer legado não autentica; pi-agent já retornou acima e o
      // device token resolve no branch próprio abaixo).
      if (!isSessionBearerFallbackEnabled()) headers.delete('authorization');
      const session = await getBetterAuthSessionContext(auth, headers);

      if (workspaceId) {
        if (session) {
          const access = await workspaceAccess.resolve(session.userId, workspaceId);
          if (!access) {
            return reply.code(403).send({ code: 'auth.workspace_forbidden', message: 'Acesso ao workspace proibido.' });
          }

          // T2.2 / T0.4.1 (SPEC §24.1): conta o uso EFETIVO do fallback bearer
          // legado — somente quando o cookie/session NÃO autenticaria sozinho
          // e o bearer foi o autenticador efetivo. Sonda fail-closed: qualquer
          // falha → nenhuma emissão (nunca superconta, nunca quebra auth).
          // Login nunca chega aqui (early-return de /auth/* acima); fallback
          // de device token tem telemetria própria (T2.4) e não emite.
          const authorization = request.headers.authorization;
          if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
            try {
              const cookieOnly = new Headers(headers);
              cookieOnly.delete('authorization');
              const cookieSession = await getBetterAuthSessionContext(auth, cookieOnly).catch(() => undefined);
              if (!cookieSession) {
                // The CANONICAL contract event flows to the sink (same
                // reference validated by buildObservabilityEvent) — never a
                // detached copy.
                const entry = buildObservabilityEvent('auth.request.legacy_bearer_used', {
                  workspaceId: access.householdId,
                }) as LegacyBearerUsedAuditEvent;
                try {
                  const sink = deps.legacyBearerAuditLog;
                  if (sink) sink(entry);
                  else request.log.info({ event: entry.eventType, ...entry.payload });
                } catch {
                  // Telemetry never breaks authentication.
                }
              }
            } catch {
              // Probe failure → no emission (fail-closed against overcounting).
            }
          }

          request.betterAuthContext = session;
          request.workspaceAccess = access;
          request.authenticatedContext = {
            householdId: access.householdId,
            actorId: access.userId,
            authUserId: session.userId,
            actorType: 'user',
            deviceId: '',
            role: access.role,
          };
          return;
        }

        const deviceHeader = request.headers[DEVICE_TOKEN_HEADER];
        const deviceToken = Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader;
        if (deviceToken) {
          try {
            const { resolveAuthorizedDevice } = await import("../auth/device-access.js");
            const authorized = await resolveAuthorizedDevice(
              {
                tokenStore,
                workspaceAccess,
                ...(deps.workspaceStore ? { workspaceStore: deps.workspaceStore } : {}),
              },
              deviceToken,
              workspaceId,
            );
            request.workspaceAccess = authorized.access;
            request.authenticatedContext = {
              householdId: authorized.workspaceId,
              actorId: authorized.deviceId,
              authUserId: authorized.userId,
              actorType: 'device',
              deviceId: authorized.deviceId,
              role: authorized.access.role,
            };
            return;
          } catch (e) {
            const err = e as { statusCode?: number; code?: string; message?: string };
            if (err.statusCode === 403) {
              return reply.code(403).send({ code: err.code ?? 'auth.workspace_forbidden', message: err.message ?? 'Acesso ao workspace proibido.' });
            }
            return reply.code(401).send({ code: 'auth.session_required', message: 'Token de autenticação inválido ou expirado.' });
          }
        }

        return reply.code(401).send({ code: 'auth.session_required', message: 'Sessão ou token de autenticação obrigatório.' });
      }

      if (session) {
        if (request.url === '/workspaces' || request.url.startsWith('/workspaces?')) {
          return;
        }

        return reply.code(403).send({ code: 'auth.workspace_required', message: 'Header x-workspace-id é obrigatório.' });
      }
    });
  }

  if (deps.delegationSecret || process.env.PI_DELEGATED_TOKEN_SECRET) {
    const delegationSecret = deps.delegationSecret ?? process.env.PI_DELEGATED_TOKEN_SECRET ?? "";
    app.addHook("preHandler", async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) return;
      const token = authHeader.slice("Bearer ".length).trim();
      // Only treat as delegated when the payload declares the delegation
      // issuer; session tokens from Better Auth must keep flowing to the
      // normal session/device resolution path.
      let headerPayload: string | undefined;
      try {
        const [, payload] = token.split(".");
        if (payload) {
          const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: string };
          if (json.iss === "pi-agent") headerPayload = payload;
        }
      } catch {
        headerPayload = undefined;
      }
      if (!headerPayload) return;

      let claims: import("../auth/delegated-token.js").DelegatedTurnClaims;
      try {
        const { verifyDelegatedTurnToken } = await import("../auth/delegated-token.js");
        claims = await verifyDelegatedTurnToken(token, delegationSecret, Date.now());
      } catch (err) {
        return reply.code(401).send({ code: "auth.invalid_token", message: (err as Error).message });
      }

      const isRead = request.method === "GET" || request.method === "HEAD";
      const isV2Approval = request.url.startsWith("/pending-operations/v2");
      // debt-undo-confirmation-protocol: the conversational-undo confirm call
      // uses the NARROW `financial.undo.execute` capability — never the
      // generic `financial.write`. Device-token (non-delegated) callers
      // bypass this preHandler entirely (no pi-agent bearer), so their path
      // is unchanged; the route handler re-checks the narrow capability
      // for delegated callers as defense in depth.
      const isUndo = !isRead && request.url.startsWith("/pending-operations/undo");
      if (isUndo && !claims.capabilities.includes("financial.undo.execute")) {
        return reply.code(403).send({ code: "auth.delegation_scope_forbidden", message: "Permissão insuficiente no token delegado." });
      }
      // A4 (architecture:check): the delegated write scope is enforced here
      // with the OPEN capability literal — never obfuscated (no join/concat
      // tricks). This preHandler is the API-side VERIFIER (fail-closed scope
      // check); it never mints or grants capabilities. Issuance stays
      // forbidden outside MutationExecutor (Agent) by the A4 gate.
      const mutationCapability = 'financial.write';
      const requiredCapability = isRead ? 'financial.read' : mutationCapability;
      const hasScopedApprovalCapability = claims.capabilities.some((capability) => capability.startsWith("financial.approval."));
      // debt-undo-confirmation-protocol: a token holding ONLY the narrow
      // `financial.undo.execute` grant is authorized for exactly the undo
      // route (checked above; the route handler re-checks it as defense in
      // depth) — the generic `financial.write` requirement must not veto it,
      // otherwise every conversational undo confirm fails closed with 403.
      const undoScopeAdmitted = isUndo && claims.capabilities.includes("financial.undo.execute");
      if (isV2Approval ? !hasScopedApprovalCapability : (!undoScopeAdmitted && !claims.capabilities.includes(requiredCapability))) {
        return reply.code(403).send({ code: "auth.delegation_scope_forbidden", message: "Permissão insuficiente no token delegado." });
      }

      // H-12: device binding end-to-end. The deviceId claim is signature-bound
      // (same contract the Agent emits). Identity is derived from claims —
      // never from free headers — but when the caller ALSO presents device
      // proof (x-device-token), it must resolve to the SAME device, otherwise
      // a token minted for device A cannot be used from device B. A revoked
      // device fails here (401). Tokens without any device are explicitly
      // read-only: sensitive mutations are rejected (403).
      const rawDeviceHeader = request.headers[DEVICE_TOKEN_HEADER];
      const deviceToken = Array.isArray(rawDeviceHeader) ? rawDeviceHeader[0] : rawDeviceHeader;
      let presentedDeviceId: string | undefined;
      if (typeof deviceToken === "string" && deviceToken.trim() !== "") {
        try {
          presentedDeviceId = (await resolveToken(deviceToken)).deviceId;
        } catch {
          return reply.code(401).send({ code: "auth.session_required", message: "Token de autenticação inválido ou expirado." });
        }
      }
      const boundDeviceId = claims.deviceId;
      if (presentedDeviceId !== undefined) {
        if (!boundDeviceId || presentedDeviceId !== boundDeviceId) {
          return reply.code(403).send({ code: "auth.device_mismatch", message: "Token vinculado a outro dispositivo." });
        }
      }
      if (!boundDeviceId && (!isRead || isV2Approval)) {
        return reply.code(403).send({ code: "auth.device_binding_required", message: "Operação sensível exige token vinculado a um dispositivo." });
      }

      if (deps.workspaceAccess) {
        const access = await deps.workspaceAccess.resolve(claims.sub, claims.workspace);
        if (!access) {
          return reply.code(403).send({ code: "auth.workspace_forbidden", message: "Acesso ao workspace revogado ou inexistente." });
        }
      }

      request.authenticatedContext = {
        householdId: claims.workspace,
        actorId: claims.sub,
        authUserId: claims.sub,
        actorType: "user",
        deviceId: claims.deviceId ?? "",
        role: claims.role,
      };
      request.delegatedTurn = claims;
    });
  }

  // G2.2.4 — centralized idempotency-key enforcement.
  // Financial mutations REQUIRE the header (400 before any producer);
  // every other mutation keeps the legacy validate-if-present behavior so
  // auth and explicitly non-financial endpoints are untouched. Per-route
  // lookupOrRecord (claim → effect → receipt in one tx) is preserved.
  const FINANCIAL_MUTATION_PREFIXES = [
    '/transactions',
    '/transfers',
    '/accounts',
    '/cards',
    '/payables',
    '/budgets',
    '/goals',
    '/subscriptions',
    '/categories',
  ];
  // Read-only helpers under a financial prefix are NOT mutations.
  const FINANCIAL_MUTATION_EXCEPTIONS = ['/transactions/detect-duplicate'];
  app.addHook("preHandler", async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (
        req.url.startsWith('/auth/') ||
        req.url.startsWith('/api/auth') ||
        req.url.startsWith('/bridge/') ||
        req.url === '/health'
      ) {
        return;
      }
      const path = req.url.split('?')[0] ?? req.url;
      const isFinancial =
        FINANCIAL_MUTATION_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) &&
        !FINANCIAL_MUTATION_EXCEPTIONS.some((exception) => path === exception || path.startsWith(`${exception}/`));
      if (isFinancial) {
        // Auth wins over idempotency: a present-but-invalid credential must
        // surface 401 from auth, never 400 validation.required. Prior hooks
        // (session/workspace, delegated) already authenticated into
        // req.authenticatedContext or rejected — enforce the key only for
        // authenticated callers. Handler-level device auth (the default test
        // and device-only composition) resolves AFTER this hook, so validate
        // the device token here: invalid → 401, valid → 400 when the key is
        // missing. Bearer/cookie material without a device token and without
        // prior authentication is left to downstream auth (401/403).
        if (req.authenticatedContext) {
          try {
            requireIdempotencyKey(req.headers);
          } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode ?? 400;
            const code = (err as { code?: string }).code ?? 'validation.required';
            const message = (err as Error).message ?? 'Idempotency-Key é obrigatório.';
            return reply.code(statusCode).send({ code, message });
          }
          return;
        }
        const deviceHeader = req.headers[DEVICE_TOKEN_HEADER];
        if (deviceHeader !== undefined) {
          const deviceToken = Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader;
          try {
            await resolveToken(deviceToken);
          } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
            const code = (err as { code?: string }).code ?? 'auth.session_required';
            const message = (err as Error).message ?? 'Token de autenticação inválido ou expirado.';
            return reply.code(statusCode).send({ code, message });
          }
          try {
            requireIdempotencyKey(req.headers);
          } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode ?? 400;
            const code = (err as { code?: string }).code ?? 'validation.required';
            const message = (err as Error).message ?? 'Idempotency-Key é obrigatório.';
            return reply.code(statusCode).send({ code, message });
          }
          return;
        }
        return;
      }
      if (req.headers['idempotency-key'] !== undefined || req.headers['Idempotency-Key'] !== undefined) {
        requireIdempotencyKey(req.headers);
      }
    }
  });

  // V4.1 Phase 9 (Task 9.9) — release identity. Build/deploy injects
  // BUILD_SHA/BUILD_ID/BUILD_TIME; dev falls back to 'dev'. The production
  // smoke (Task 9.10) confirms the deployed SHA through these fields.
  app.get("/health", async () => ({
    status: "ok",
    gitSha: process.env.BUILD_SHA || "dev",
    buildId: process.env.BUILD_ID || "dev",
    builtAt: process.env.BUILD_TIME || "dev",
  }));
  registerPendingOperationRoutes(app, {
    store: deps.pendingStore ?? createInMemoryPendingOperationStore(),
    resolveToken,
    ...(deps.pendingExecutor ? { executor: deps.pendingExecutor } : {}),
    undoService,
  });
  registerAdoptionRoutes(app, {
    store: deps.adoptionStore ?? createInMemoryAdoptionStore(),
    resolveToken,
  });
  registerClientEventsRoutes(app, { resolveToken });

  registerShadowObservabilityRoutes(app, {
    shadowDivergence: deps.shadowDivergenceStore ?? createInMemoryShadowDivergenceStore(),
    resolveToken,
  });
  const authOpts: Parameters<typeof registerAuthRoutes>[1] = {
    resolveToken,
    tokenStore,
    disableDeviceRegistration: deps.disableDeviceRegistration ?? false,
    ...(deps.auth ? { auth: deps.auth } : {}),
    ...(deps.workspaceAccess ? { workspaceAccess: deps.workspaceAccess } : {}),
    ...(deps.workspaceStore ? { workspaceStore: deps.workspaceStore } : {}),
  };
  if (deps.defaultHouseholdId !== undefined)
    authOpts.defaultHouseholdId = deps.defaultHouseholdId;
  registerAuthRoutes(app, authOpts);

  registerAccountRoutes(app, {
    store: deps.store,
    writes: deps.writes,
    resolveToken,
    idempotency,
    ...(deps.approvalPolicy ? { approvalPolicy: deps.approvalPolicy, pendingStore } : {}),
  });
  registerCategoryRoutes(app, {
    store: deps.store,
    writes: deps.writes,
    resolveToken,
    idempotency,
    ...(deps.approvalPolicy ? { approvalPolicy: deps.approvalPolicy, pendingStore } : {}),
  });
  registerTransactionRoutes(app, { store: deps.store, resolveToken });
  registerTransactionWriteRoutes(app, {
    store: deps.store,
    writes: deps.writes,
    resolveToken,
    idempotency,
    ...(deps.cardStore ? { cardStore: deps.cardStore } : {}),
  });
  registerDashboardRoutes(app, { store: deps.store, resolveToken, clock });
  registerAnalyticsRoutes(app, {
    source:
      deps.analyticsSource ??
      createStoreAnalyticsSource({
        store: deps.store,
        ...(deps.cardStore ? { cardStore: deps.cardStore } : {}),
        ...(deps.budgetStore ? { budgetStore: deps.budgetStore } : {}),
        ...(deps.subscriptionStore ? { subscriptionStore: deps.subscriptionStore } : {}),
      }),
    resolveToken,
    clock,
  });
  registerInsightRoutes(app, {
    store: deps.store,
    resolveToken,
    ...(deps.payableStore ? { payableStore: deps.payableStore } : {}),
    ...(deps.cardStore ? { cardStore: deps.cardStore } : {}),
    clock,
  });
  if (deps.profileStore) {
    registerProfileRoutes(app, {
      resolveToken,
      profileStore: deps.profileStore,
      ...(deps.adminEmails ? { adminEmails: deps.adminEmails } : {}),
      ...(deps.auth
? {
              resolveSessionEmail: async (headers: Headers) => {
                const session = await getBetterAuthSessionContext(deps.auth as BetterAuth, headers).catch(() => undefined);
                return session?.email;
              },
            }
        : {}),
    });
  }
  if (deps.cardStore) {
    registerCardRoutes(app, {
      cardStore: deps.cardStore,
      resolveToken,
      idempotency,
      ...(deps.approvalPolicy ? { approvalPolicy: deps.approvalPolicy, pendingStore } : {}),
    });
  }
  if (deps.payableStore) {
    registerPayableRoutes(app, {
      payableStore: deps.payableStore,
      resolveToken,
      idempotency,
      ...(deps.approvalPolicy ? { approvalPolicy: deps.approvalPolicy, pendingStore } : {}),
    });
  }
  if (deps.budgetStore) {
    registerBudgetRoutes(app, {
      budgetStore: deps.budgetStore,
      resolveToken,
      idempotency,
      ...(deps.approvalPolicy ? { approvalPolicy: deps.approvalPolicy, pendingStore } : {}),
    });
  }
  if (deps.goalStore) {
    registerGoalRoutes(app, {
      goalStore: deps.goalStore,
      resolveToken,
      idempotency,
      ...(deps.approvalPolicy ? { approvalPolicy: deps.approvalPolicy, pendingStore } : {}),
    });
  }
  if (deps.subscriptionStore) {
    registerSubscriptionRoutes(app, {
      subscriptionStore: deps.subscriptionStore,
      resolveToken,
      idempotency,
      ...(deps.approvalPolicy ? { approvalPolicy: deps.approvalPolicy, pendingStore } : {}),
    });
  }
  if (deps.pushStore) {
    registerPushRoutes(app, {
      pushStore: deps.pushStore,
      idempotency,
      resolveToken,
      ...(deps.vapidPublicKey ? { vapidPublicKey: deps.vapidPublicKey } : {}),
      ...(deps.pushDelivery ? { delivery: deps.pushDelivery } : {}),
      ...(deps.adoptionStore ? { adoption: deps.adoptionStore } : {}),
    });
  }
  // Price alerts — Phase 7 (V4.1 Task 7.8, SPEC §14.3 option A): OFF by
  // default. Mounted only under explicit opt-in (RouteDeps flag or
  // PI_FEATURE_PRICE_ALERTS), so the in-memory mock never serves production.
  if (deps.enablePriceAlerts ?? isPriceAlertsEnabled()) {
    registerPriceAlertRoutes(app, {
      priceAlertStore: deps.priceAlertStore ?? createInMemoryPriceAlertStore(),
      resolveToken,
    });
  }
  registerAuditRoutes(app, {
    auditLogs,
    resolveToken,
    undoService,
  });
  registerDuplicateDetectRoutes(app, { resolveToken });
  if (deps.ownershipTransferStore) {
    registerOwnershipTransferRoutes(app, deps.ownershipTransferStore);
  }
  const llmStore = deps.llmConfigStore ?? createInMemoryLlmConfigStore();
  registerInternalAgentLlmConfigRoutes(app, {
    store: llmStore,
    configToken: deps.agentConfigToken ?? process.env.AGENT_CONFIG_TOKEN ?? 'dev-agent-config-token-32-chars-minimum!',
  });

  const replayStore = deps.agentReplayStore ?? createInMemoryAgentReplayStore();
  const agentServiceToken = deps.agentAuthServiceToken ?? process.env.AGENT_AUTH_SERVICE_TOKEN ?? 'dev-agent-auth-service-token-32-chars!';

  registerAgentAuthRoutes(app, {
    auth: deps.auth,
    workspaceAccess: deps.workspaceAccess,
    connectionSecret: deps.agentConnectionSecret ?? process.env.AGENT_CONNECTION_TOKEN_SECRET ?? 'dev-agent-connection-secret-at-least-32-chars!',
    agentAuthServiceToken: agentServiceToken,
    replayStore,
    pool: deps.pool ?? null,
    // H-12: device binding at mint time (server-side resolution).
    resolveDeviceToken: resolveToken,
  });

  registerWorkspaceAliasRoutes(app, {
    pool: deps.pool ?? null,
    serviceToken: agentServiceToken,
  });

  registerAgentLlmRelayRoutes(app, {
    adminToken: deps.agentRuntimeAdminToken ?? process.env.AGENT_RUNTIME_ADMIN_TOKEN ?? 'dev-agent-runtime-admin-token-32-chars!',
    ...(process.env.OPENCODE_ZEN_API_KEY ? { zenApiKey: process.env.OPENCODE_ZEN_API_KEY } : {}),
    ...(process.env.OPENCODE_GO_API_KEY ? { opencodeGoApiKey: process.env.OPENCODE_GO_API_KEY } : {}),
    ...(process.env.OPENAI_API_KEY ? { openaiApiKey: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.OPENROUTER_API_KEY ? { openrouterApiKey: process.env.OPENROUTER_API_KEY } : {}),
    llmConfigStore: llmStore,
  });

  if (deps.auth) {
    registerAdminAgentLlmConfigRoutes(app, {
      auth: deps.auth,
      store: llmStore,
      // DEBT2: last-resort non-prod placeholders — production composition
      // always injects these deps explicitly (server/index.ts), so the
      // literals below never serve production traffic.
      adminEmails: deps.adminEmails ?? ['admin@example.com'],
      agentRuntimeOrigin: deps.agentRuntimeOrigin ?? 'https://agent.example',
      agentRuntimeToken: deps.agentRuntimeAdminToken ?? 'dev-agent-runtime-admin-token-32-chars!',
      ...(deps.trustedOrigins ? { trustedOrigins: deps.trustedOrigins } : {}),
      // Fase 3 item 9: sensitive admin reads are audit-logged best-effort;
      // production defaults to the server log, tests may inject a collector.
      auditLog: deps.adminLlmAuditLog ?? ((event) => app.log.info({ audit: event.action, ...event })),
    });
  }
  if (deps.auth) {
    const consumeAccountInvite = deps.accountInviteService
      ? async (email: string) => {
          try {
            await deps.accountInviteService!.consumeAccountInvite({ email });
          } catch {
            // best-effort
          }
        }
      : undefined;
    registerBetterAuthRoutes(app, deps.auth, undefined, undefined, deps.inviteSignupGuard, consumeAccountInvite);
    const adminEmails = deps.adminEmails ?? ['admin@example.com'];
    registerAdminInviteRoutes(app, {
      auth: deps.auth,
      adminEmails,
      delivery: deps.adminInviteDelivery,
    });
    if (deps.accountInviteService) {
      registerAccountInviteRoutes(app, {
        auth: deps.auth,
        service: deps.accountInviteService,
        adminEmails,
        idempotency,
      });
    }
    if (deps.inviteService && deps.authorizeInviteCreate) {
      registerInviteRoutes(app, {
        auth: deps.auth,
        service: deps.inviteService,
        authorizeCreate: deps.authorizeInviteCreate,
        idempotency,
      });
    }
    if (deps.workspaceStore) {
      registerWorkspaceRoutes(app, {
        auth: deps.auth,
        store: deps.workspaceStore,
        idempotency,
        ...(deps.workspaceAccess ? { workspaceAccess: deps.workspaceAccess } : {}),
      });
    }

  }
};
