/**
 * Shared isomorphic LLM governance contracts.
 * Pure types + const enums only. This module MUST NOT import server-side code
 * (no pg, no fastify, no Cloudflare bindings) so API, PWA and Agent can share it.
 */

export const PROVIDER_KINDS = [
  'opencode-zen',
  'opencode-go',
  'openai-api',
  'openai-codex-subscription',
  'openai',
  'anthropic',
  'deepseek',
  'qwen',
  'glm',
  'minimax',
  'kimi',
  'google',
  'openrouter',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const SECRET_ALIASES = [
  'OPENCODE_ZEN_API_KEY',
  'OPENCODE_GO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'QWEN_API_KEY',
  'GLM_API_KEY',
  'MINIMAX_API_KEY',
  'KIMI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
] as const;
export type SecretAlias = (typeof SECRET_ALIASES)[number];

/**
 * Kinds the direct-execution registry intentionally cannot run.
 * Single source shared by the agent registry, the API domain/routes and V042.
 */
export const REGISTRY_UNSUPPORTED_KINDS = ['openai-codex-subscription'] as const;
export type RegistryUnsupportedKind = (typeof REGISTRY_UNSUPPORTED_KINDS)[number];

export const isKindExecutable = (kind: string): kind is Exclude<ProviderKind, RegistryUnsupportedKind> =>
  (PROVIDER_KINDS as readonly string[]).includes(kind) &&
  !(REGISTRY_UNSUPPORTED_KINDS as readonly string[]).includes(kind);

/** Single source: which secret aliases each provider kind may use. */
export const KIND_SECRET_ALIASES: Record<ProviderKind, readonly SecretAlias[]> = {
  'opencode-zen': ['OPENCODE_ZEN_API_KEY'],
  'opencode-go': ['OPENCODE_GO_API_KEY'],
  'openai-api': ['OPENAI_API_KEY'],
  'openai-codex-subscription': [],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  qwen: ['QWEN_API_KEY'],
  glm: ['GLM_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  kimi: ['KIMI_API_KEY'],
  google: ['GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

export const TRANSPORTS = ['direct', 'private-broker'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const AUTH_MODES = ['api-key', 'chatgpt-browser'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const PROTOCOLS = ['responses', 'messages', 'chat-completions', 'google-generative-ai'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** Canonical privacy classes (server enum is the source of truth). */
export const PRIVACY_CLASSES = ['training_prohibited', 'training_allowed'] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

export const ROLLOUT_MODES = ['disabled', 'canary', 'all'] as const;
export type RolloutMode = (typeof ROLLOUT_MODES)[number];

export const PROVIDER_ELIGIBILITIES = ['approved', 'candidate', 'experimental_blocked'] as const;
export type ProviderEligibility = (typeof PROVIDER_ELIGIBILITIES)[number];

export const RUNTIME_STATUSES = ['not_configured', 'ready', 'reauth_required', 'unavailable'] as const;
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

export const isProviderKind = (value: string): value is ProviderKind =>
  (PROVIDER_KINDS as readonly string[]).includes(value);

/**
 * H-08: single compatibility layer for provider id aliases. `openai-api`
 * is the canonical id; the legacy `openai` id resolves to it. Normalize
 * BEFORE persisting or activating (stores do this); never branch behavior
 * on the alias downstream.
 */
export const PROVIDER_ID_ALIASES: Record<string, ProviderKind> = {
  openai: 'openai-api',
};

export const normalizeProviderId = (id: string): string => PROVIDER_ID_ALIASES[id] ?? id;

export const isProtocol = (value: string): value is Protocol =>
  (PROTOCOLS as readonly string[]).includes(value);

/**
 * Single source: which protocols each executable kind can actually run.
 * Derived from the agent model-factory wiring (OpenAI-native vs
 * OpenAI-compatible vs Anthropic messages vs Google generative-ai).
 * Unsupported kinds (codex) have no entry: nothing is compatible with them.
 */
export const KIND_PROTOCOL_COMPAT: Record<
  Exclude<ProviderKind, RegistryUnsupportedKind>,
  readonly Protocol[]
> = {
  'opencode-zen': ['chat-completions', 'responses'],
  'opencode-go': ['chat-completions', 'responses'],
  'openai-api': ['chat-completions', 'responses'],
  openai: ['chat-completions', 'responses'],
  anthropic: ['messages'],
  deepseek: ['chat-completions', 'responses'],
  qwen: ['chat-completions', 'responses'],
  glm: ['chat-completions', 'responses'],
  minimax: ['chat-completions', 'responses'],
  kimi: ['chat-completions', 'responses'],
  google: ['google-generative-ai'],
  openrouter: ['chat-completions', 'responses'],
};

export const isProtocolCompatibleWithKind = (kind: string, protocol: string): boolean => {
  const list = (KIND_PROTOCOL_COMPAT as Record<string, readonly string[]>)[kind];
  return list !== undefined && list.includes(protocol);
};

/**
 * Explicit admin runtime DTO. field names with the `active` prefix are the
 * contract — consumers MUST NOT read legacy `providerId`/`modelId` names.
 */
export interface AdminRuntimeDto {
  singleton: 'active';
  version: number;
  securityEpoch: number;
  activeProviderId: string | null;
  activeModelId: string | null;
  activeProtocol: Protocol | null;
  activeRolloutPercentage: number;
  activeRolloutMode: RolloutMode;
  canaryAllowlist: string[];
  fallbackProviderId: string | null;
  fallbackModelId: string | null;
  updatedBy: string | null;
  updatedAt?: string;
}

/** Internal snapshot reuses the same runtime DTO shape. */
export type InternalRuntimeDto = AdminRuntimeDto;

export interface LlmProviderSlot {
  id: string;
  kind: ProviderKind;
  transport: Transport;
  authMode: AuthMode;
  secretAlias: SecretAlias | null;
  serviceAlias: string | null;
  eligibility: ProviderEligibility;
}

export interface LlmModelSlot {
  id: string;
  modelId: string;
  protocol: Protocol;
  privacyClass: PrivacyClass;
}

export interface InternalLlmSnapshot {
  runtime: InternalRuntimeDto;
  activeProvider: LlmProviderSlot | null;
  activeModel: LlmModelSlot | null;
  fallbackProvider: LlmProviderSlot | null;
  fallbackModel: LlmModelSlot | null;
  /** True when an active pair is configured but not usable (disabled or missing): fail closed. */
  activeDisabled: boolean;
  /** True when a fallback pair is configured but not usable: fail closed. */
  fallbackDisabled: boolean;
}

/** Agent-side view of the runtime contract (active* names only). */
export interface RuntimeSnapshot {
  version: number;
  securityEpoch: number;
  activeProviderId: string | null;
  activeModelId: string | null;
  activeProtocol: Protocol | null;
  activeRolloutPercentage: number;
  /** H-03: rollout mode travels to the agent so the executor enforces it (never serializes-only). */
  activeRolloutMode: RolloutMode;
  /** H-03: canary cohort (workspace or actor ids) enforced by the executor. */
  canaryAllowlist: string[];
  fallbackProviderId: string | null;
  fallbackModelId: string | null;
  /**
   * Bare upstream model id (no `providerId:` prefix), taken from the validated
   * model slot. `activeModelId` is the store row id used for configuration
   * references; the bare name is what the upstream provider API expects.
   * Fase 3 item 5: executing with the row id fails provider-side validation.
   */
  activeModelName: string | null;
  /** Bare upstream model id for the fallback slot (same semantics). */
  fallbackModelName: string | null;
}

/**
 * Fixed provider catalog (refactor item 1). The 10 entries below are the
 * ONLY providers the "Gerenciador de IA" UI offers — provider CRUD for
 * arbitrary ids stays available on the legacy advanced path for backwards
 * compatibility, but new credentials are managed per catalog entry only.
 * Kimi = Moonshot AI (https://api.moonshot.ai/v1, OpenAI-compatible).
 * Codex = Coding-plan subscription via the private broker (browser login,
 * no API key, no public model listing — manual model id only).
 */
export type ProviderAuthFormat = 'bearer-key' | 'browser-session';

export interface ProviderCatalogEntry {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string | null;
  modelsPath: string | null;
  authFormat: ProviderAuthFormat;
  secretAlias: SecretAlias | null;
  supportsDynamicModels: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'minimax', kind: 'minimax', displayName: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'MINIMAX_API_KEY', supportsDynamicModels: true },
  { id: 'qwen', kind: 'qwen', displayName: 'Qwen (DashScope)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'QWEN_API_KEY', supportsDynamicModels: true },
  { id: 'glm', kind: 'glm', displayName: 'GLM (Zhipu)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'GLM_API_KEY', supportsDynamicModels: true },
  { id: 'opencode-zen', kind: 'opencode-zen', displayName: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'OPENCODE_ZEN_API_KEY', supportsDynamicModels: true },
  { id: 'opencode-go', kind: 'opencode-go', displayName: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'OPENCODE_GO_API_KEY', supportsDynamicModels: true },
  { id: 'openai', kind: 'openai', displayName: 'OpenAI (alias legado — resolve para openai-api)', baseUrl: 'https://api.openai.com/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'OPENAI_API_KEY', supportsDynamicModels: true },
  { id: 'openai-api', kind: 'openai-api', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'OPENAI_API_KEY', supportsDynamicModels: true },
  { id: 'openrouter', kind: 'openrouter', displayName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'OPENROUTER_API_KEY', supportsDynamicModels: true },
  { id: 'deepseek', kind: 'deepseek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'DEEPSEEK_API_KEY', supportsDynamicModels: true },
  { id: 'kimi', kind: 'kimi', displayName: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.ai/v1', modelsPath: '/models', authFormat: 'bearer-key', secretAlias: 'KIMI_API_KEY', supportsDynamicModels: true },
  { id: 'openai-codex-subscription', kind: 'openai-codex-subscription', displayName: 'Codex (plano Coding)', baseUrl: null, modelsPath: null, authFormat: 'browser-session', secretAlias: null, supportsDynamicModels: false },
];

export const getCatalogEntry = (id: string): ProviderCatalogEntry | undefined =>
  PROVIDER_CATALOG.find((e) => e.id === id || e.kind === id);

export const isCatalogProvider = (id: string): boolean => getCatalogEntry(id) !== undefined;

/**
 * Credential CRUD surface (refactor item 2). The full key is NEVER returned
 * to the front — only `masked` (ex. `sk-…abcd`) plus a boolean. `maskApiKey`
 * is the single masking implementation shared by API responses and tests.
 */
export interface ProviderCredentialStatus {
  providerId: string;
  configured: boolean;
  masked: string | null;
  updatedAt: string | null;
}

export const maskApiKey = (key: string): string => {
  const trimmed = (key ?? '').trim();
  if (trimmed.length === 0) return '…';
  if (trimmed.length <= 4) return `…${trimmed}`;
  const prefix = trimmed.length >= 3 && trimmed[2] === '-' ? trimmed.slice(0, 3) : trimmed.slice(0, 2);
  return `${prefix}…${trimmed.slice(-4)}`;
};

/** UI status per provider (refactor item 7). Exactly one provider/model pair
 * is ATIVO and at most one is FALLBACK; anything with a key is configurado. */
export type ProviderDisplayStatus = 'nao-configurado' | 'configurado' | 'ativo' | 'fallback';

export const resolveProviderDisplayStatus = (input: {
  configured: boolean;
  isActive: boolean;
  isFallback: boolean;
}): ProviderDisplayStatus => {
  if (input.isActive) return 'ativo';
  if (input.isFallback) return 'fallback';
  return input.configured ? 'configurado' : 'nao-configurado';
};

/** Remote model item returned by the dynamic listing endpoint (item 3). */
export interface RemoteModelItem {
  id: string;
  ownedBy?: string | null;
}

export interface RemoteModelsResponse {
  providerId: string;
  models: RemoteModelItem[];
  cached: boolean;
  manualEntryAllowed: boolean;
}

/** Failover log/metric payload (item 5). Never carries secrets. */
export interface LlmFailoverEvent {
  intentionId: string;
  primaryProviderId: string;
  primaryModelId: string;
  fallbackProviderId: string | null;
  fallbackModelId: string | null;
  usedFallback: boolean;
  failoverReason: string | null;
}

export type PendingOperationV2JsonValue =
  | string
  | number
  | boolean
  | null
  | PendingOperationV2JsonValue[]
  | { [key: string]: PendingOperationV2JsonValue };

export interface PendingOperationV2Bindings {
  workspaceId: string;
  actorId: string;
  deviceId: string;
}

/**
 * Authoritative approval proposal shared by API and Agent. `summary`, status,
 * timestamps and idempotency are deliberately not part of the proposal hash.
 */
export interface PendingOperationV2 {
  version: 2;
  workspaceId: string;
  actorId: string;
  deviceId: string;
  tool: string;
  normalizedArgs: { [key: string]: PendingOperationV2JsonValue };
  proposalHash: string;
  idempotencyKey: string;
  createdAt: string;
  expiresAt: string;
  bindings: PendingOperationV2Bindings;
}

/* ── TED V3 hardening (SPEC §15, §16, §7.8) ──────────────────────────────
 * Canonical shared contracts for mutation receipts, reconciliation effects,
 * the approval-card presentation and the draft clarification channel.
 * Pure types + const tables only — same discipline as the rest of this
 * module (no server-side imports), so API, PWA and Agent can share them. */

/**
 * Closed set of refresh targets a MutationReceipt may invalidate (SPEC
 * §15.1.1). Derived from the real PWA domains (snapshot DomainKey:
 * accounts, categories, transactions, payables, budgets, goals,
 * subscriptions, cardStatements) plus server-computed views
 * (dashboard-summary, quick-insights) and the TED chat surface
 * (agent-conversation). `statement` covers card statements; `subscription`
 * covers the subscriptions domain.
 */
export const REFRESH_TARGETS = [
  'transactions',
  'accounts',
  'dashboard-summary',
  'budgets',
  'quick-insights',
  'payables',
  'statement',
  'goals',
  'categories',
  'subscription',
  'agent-conversation',
] as const;
export type RefreshTarget = (typeof REFRESH_TARGETS)[number];

/**
 * V2 approval-protocol tools (SPEC §7.5) — the only TED-origin mutation
 * kinds. Mirrors the API Approval Tool Contract ids; the single source for
 * "receipt requires operationId" validation lives on the schema side.
 */
export const TED_APPROVAL_TOOLS = [
  'transactions.expense.create',
  'transactions.income.create',
  'accounts.create',
  'accounts.deactivate',
] as const;
export type TedApprovalTool = (typeof TED_APPROVAL_TOOLS)[number];

/**
 * Every mutation kind that may produce a MutationReceipt: the V2 protocol
 * tools (§7.5) plus the normal PWA/API writes (§15.6). A receipt carrying a
 * kind outside this union fails validation; a known kind without a
 * registered effects entry is an error at resolve time (never silent).
 */
export const MUTATION_KINDS = [
  ...TED_APPROVAL_TOOLS,
  'transaction.create',
  'transaction.update',
  'transaction.delete',
  'transfer.create',
  'payable.create',
  'payable.update',
  'payable.delete',
  'payable.pay',
  'payable.payment.undo',
  'statement.create',
  'statement.update',
  'statement.delete',
  'budget.create',
  'budget.update',
  'budget.delete',
  'goal.create',
  'goal.update',
  'goal.delete',
  'account.create',
  'account.update',
  'account.delete',
  'category.create',
  'category.update',
  'category.delete',
  'subscription.create',
  'subscription.update',
  'subscription.delete',
] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

/**
 * Keys that must NEVER appear in browser-facing channel types (approval
 * card, receipt, draft clarification). The runtime ban is enforced by
 * `.strict()` schemas plus the BROWSER_FACING_SCHEMAS sweep test; this
 * const is the single list both sides share.
 */
export const FORBIDDEN_BROWSER_KEYS = [
  'authorization',
  'attestation',
  'attestationHash',
  'proposalHash',
  'normalizedArgs',
  'executableArgs',
  'args',
] as const;
export type ForbiddenBrowserKey = (typeof FORBIDDEN_BROWSER_KEYS)[number];

export interface PendingOperationPresentationLabel {
  id: string;
  label: string;
}

/**
 * Safe projection of a proposed operation for the approval card (SPEC §16).
 * Derived server-side from the same canonical/hash-bound args that will
 * execute — never invented by the PWA, never carrying attestation.
 */
export interface PendingOperationPresentation {
  id: string;
  status: string;
  tool: string;
  title: string;
  amountCents?: number;
  description?: string;
  date?: string;
  account?: PendingOperationPresentationLabel;
  category?: PendingOperationPresentationLabel;
  /**
   * Account-creation display fields (tool `accounts.create` only): the card
   * shows the account name/kind/initial balance instead of the
   * transaction tuple (amount/description/date/account/category).
   *
   * Account-deactivation display fields (tool `accounts.deactivate` only):
   * the card shows the account id/label plus the display-only
   * accountName/accountKind/balanceCents snapshot carried in
   * normalizedArgs (never execution keys — the executor uses only
   * accountId). balanceCents is the display-time balance, not an input.
   */
  accountName?: string;
  accountKind?: string;
  initialBalanceCents?: number;
  balanceCents?: number;
  expiresAt: string;
  warnings: string[];
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPresentationLabel = (value: unknown): value is PendingOperationPresentationLabel => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const label = value as Record<string, unknown>;
  return isNonEmptyString(label.id) && isNonEmptyString(label.label);
};

/**
 * Fail-closed actionability gate (SPEC §16, INV-02): true only when the
 * full financial context the user must see before confirming is present.
 * Transaction tools require title, description, amountCents, date, and
 * both account and category labels. The `accounts.create` tool requires
 * its own display tuple instead — title, accountName, accountKind and a
 * finite initialBalanceCents (a card missing any of them renders
 * degraded/non-actionable: Cancel stays, Confirm never renders). The
 * `accounts.deactivate` tool requires the account key plus a display name
 * — title, account id and a non-empty SERVER-RESOLVED account label
 * (`account.label`, from the authoritative read model). The display-only
 * `accountName` snapshot may render on the card but NEVER gates Confirm:
 * the executor converges `not_found` into success (post-crash reconcile
 * after its own write), so a snapshot-gated confirm on a never-existing
 * id would execute into a false receipt. Kind and balance render when
 * carried, never as actionability gates (the fixed cross-coder contract
 * guarantees only accountId + accountName).
 * The schema keeps every field optional for transport; this predicate is the
 * single rule deciding whether Confirm may be offered.
 */
export const isActionablePendingOperationPresentation = (
  presentation: PendingOperationPresentation,
): boolean => {
  if (!presentation || typeof presentation !== 'object') return false;
  if (!isNonEmptyString(presentation.title)) return false;
  if (presentation.tool === 'accounts.create') {
    if (!isNonEmptyString(presentation.accountName)) return false;
    if (!isNonEmptyString(presentation.accountKind)) return false;
    if (typeof presentation.initialBalanceCents !== 'number' || !Number.isFinite(presentation.initialBalanceCents)) return false;
    return true;
  }
  if (presentation.tool === 'accounts.deactivate') {
    // Fail-closed existence proof: only the server-resolved account label
    // proves the target exists in this workspace. The hash-bound
    // display-only `accountName` snapshot may render, but it never gates
    // Confirm — otherwise a never-existing id carrying a snapshot name
    // would confirm, and the executor's not_found→success convergence
    // would emit a receipt for an account that was never deactivated.
    if (!isPresentationLabel(presentation.account)) return false;
    return true;
  }
  if (!isNonEmptyString(presentation.description)) return false;
  if (typeof presentation.amountCents !== 'number' || !Number.isFinite(presentation.amountCents)) return false;
  if (!isNonEmptyString(presentation.date)) return false;
  if (!isPresentationLabel(presentation.account)) return false;
  if (!isPresentationLabel(presentation.category)) return false;
  return true;
};

/**
 * Receipt emitted once per successful mutation, TED or normal write
 * (SPEC §15.1). `operationId` is present ONLY when the origin is a TED
 * PendingOperation — normal-write receipts are valid without it and must
 * never be converted into PendingOperations to obtain the field.
 */
export interface MutationReceipt {
  mutationId: string;
  mutationKind: MutationKind;
  status: 'succeeded';
  affectedTargets: RefreshTarget[];
  operationId?: string;
  entity?: {
    type: string;
    id: string;
  };
}

/**
 * One Mutation Effects Registry entry (SPEC §15.1.1). Either a deterministic
 * non-empty refresh set, or an explicit `noRefresh: true` exception with
 * zero targets — an empty set without the marker is invalid, and a known
 * kind with no entry at all is a resolve-time error.
 */
export type MutationEffectsEntry =
  | { mutationKind: MutationKind; affectedTargets: RefreshTarget[]; noRefresh?: false }
  | { mutationKind: MutationKind; affectedTargets: []; noRefresh: true };

/**
 * Deterministic reconciliation table shared by the TED path and normal
 * PWA writes (SPEC §15.1.1). Never derived from the LLM, never spread in
 * component-level if/else. New mutations must register here before they
 * may return success (except explicit no-refresh entries).
 */
export const MUTATION_EFFECTS_REGISTRY: Record<MutationKind, MutationEffectsEntry> = {
  'transactions.expense.create': { mutationKind: 'transactions.expense.create', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'] },
  'transactions.income.create': { mutationKind: 'transactions.income.create', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'] },
  'accounts.create': { mutationKind: 'accounts.create', affectedTargets: ['accounts', 'dashboard-summary'] },
  'accounts.deactivate': { mutationKind: 'accounts.deactivate', affectedTargets: ['accounts', 'dashboard-summary'] },
  'transaction.create': { mutationKind: 'transaction.create', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'] },
  'transaction.update': { mutationKind: 'transaction.update', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'] },
  'transaction.delete': { mutationKind: 'transaction.delete', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'budgets', 'quick-insights'] },
  'transfer.create': { mutationKind: 'transfer.create', affectedTargets: ['transactions', 'accounts', 'dashboard-summary', 'quick-insights'] },
  'payable.create': { mutationKind: 'payable.create', affectedTargets: ['payables', 'dashboard-summary', 'quick-insights'] },
  'payable.update': { mutationKind: 'payable.update', affectedTargets: ['payables', 'dashboard-summary', 'quick-insights'] },
  'payable.delete': { mutationKind: 'payable.delete', affectedTargets: ['payables', 'dashboard-summary', 'quick-insights'] },
  'payable.pay': { mutationKind: 'payable.pay', affectedTargets: ['payables', 'dashboard-summary', 'quick-insights'] },
  'payable.payment.undo': { mutationKind: 'payable.payment.undo', affectedTargets: ['payables', 'dashboard-summary', 'quick-insights'] },
  'statement.create': { mutationKind: 'statement.create', affectedTargets: ['statement', 'accounts'] },
  'statement.update': { mutationKind: 'statement.update', affectedTargets: ['statement', 'accounts'] },
  'statement.delete': { mutationKind: 'statement.delete', affectedTargets: ['statement', 'accounts'] },
  'budget.create': { mutationKind: 'budget.create', affectedTargets: ['budgets', 'dashboard-summary'] },
  'budget.update': { mutationKind: 'budget.update', affectedTargets: ['budgets', 'dashboard-summary'] },
  'budget.delete': { mutationKind: 'budget.delete', affectedTargets: ['budgets', 'dashboard-summary'] },
  'goal.create': { mutationKind: 'goal.create', affectedTargets: ['goals', 'dashboard-summary'] },
  'goal.update': { mutationKind: 'goal.update', affectedTargets: ['goals', 'dashboard-summary'] },
  'goal.delete': { mutationKind: 'goal.delete', affectedTargets: ['goals', 'dashboard-summary'] },
  'account.create': { mutationKind: 'account.create', affectedTargets: ['accounts', 'dashboard-summary'] },
  'account.update': { mutationKind: 'account.update', affectedTargets: ['accounts', 'dashboard-summary'] },
  'account.delete': { mutationKind: 'account.delete', affectedTargets: ['accounts', 'dashboard-summary'] },
  'category.create': { mutationKind: 'category.create', affectedTargets: ['categories', 'transactions'] },
  'category.update': { mutationKind: 'category.update', affectedTargets: ['categories', 'transactions'] },
  'category.delete': { mutationKind: 'category.delete', affectedTargets: ['categories', 'transactions'] },
  'subscription.create': { mutationKind: 'subscription.create', affectedTargets: ['subscription', 'dashboard-summary'] },
  'subscription.update': { mutationKind: 'subscription.update', affectedTargets: ['subscription', 'dashboard-summary'] },
  'subscription.delete': { mutationKind: 'subscription.delete', affectedTargets: ['subscription', 'dashboard-summary'] },
};

/**
 * Browser-safe clarification payload for an active MutationDraft (SPEC
 * §7.8/§16): identity, tool, what is missing and the objective question —
 * never authorization, attestation material or executable args. The draft
 * itself is NOT a PendingOperation and cannot be executed.
 */
export interface MutationDraftChannelMessage {
  draftId: string;
  tool: TedApprovalTool;
  missingFields: string[];
  question: string;
  expiresAt: string;
}
