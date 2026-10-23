import { z } from 'zod';
import {
  AUTH_MODES,
  MUTATION_EFFECTS_REGISTRY,
  MUTATION_KINDS,
  PRIVACY_CLASSES,
  PROTOCOLS,
  PROVIDER_ELIGIBILITIES,
  PROVIDER_KINDS,
  REFRESH_TARGETS,
  ROLLOUT_MODES,
  SECRET_ALIASES,
  TED_APPROVAL_TOOLS,
  TRANSPORTS,
  type MutationEffectsEntry,
  type MutationKind,
  type PendingOperationV2,
  type PendingOperationV2JsonValue,
} from './types.js';

export const providerKindSchema = z.enum(PROVIDER_KINDS);
export const secretAliasSchema = z.enum(SECRET_ALIASES);
export const transportSchema = z.enum(TRANSPORTS);
export const authModeSchema = z.enum(AUTH_MODES);
export const protocolSchema = z.enum(PROTOCOLS);
export const privacyClassSchema = z.enum(PRIVACY_CLASSES);
export const rolloutModeSchema = z.enum(ROLLOUT_MODES);
export const providerEligibilitySchema = z.enum(PROVIDER_ELIGIBILITIES);

export const providerIdSchema = z
  .string()
  .trim()
  .min(1, 'provider id is required')
  .max(64, 'provider id must be at most 64 characters')
  .regex(/^[a-z0-9-]+$/, 'provider id must match ^[a-z0-9-]+$');

export const modelIdSchema = z
  .string()
  .trim()
  .min(1, 'model id is required')
  .max(120, 'model id must be at most 120 characters')
  .regex(/^[A-Za-z0-9._/-]+$/, 'model id contains disallowed characters')
  .refine((v) => !v.split('/').some((seg) => seg === '' || seg === '..'), {
    message: 'model id contains disallowed characters',
  });

export const toggleEnabledSchema = z
  .object({ enabled: z.boolean({ invalid_type_error: 'enabled must be boolean' }) })
  .strict();

export const testConnectionSchema = z
  .object({ providerId: providerIdSchema.optional(), dryRun: z.boolean().optional() })
  .strict();

export const retentionSchema = z.string().trim().max(120, 'retention must be at most 120 characters');

export const createProviderSchema = z.object({
  id: providerIdSchema,
  kind: providerKindSchema,
  transport: transportSchema,
  authMode: authModeSchema,
  secretAlias: secretAliasSchema.nullable(),
  name: z.string().trim().min(1).max(120).optional(),
  eligibility: providerEligibilitySchema.optional(),
  enabled: z.boolean().optional(),
});

export const createModelSchema = z.object({
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  protocol: protocolSchema,
  privacyClass: privacyClassSchema,
  retention: retentionSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

export const syncCatalogItemSchema = z.object({
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  protocol: protocolSchema.optional(),
  privacyClass: privacyClassSchema.optional(),
  retention: retentionSchema.optional(),
});

export const syncCatalogSchema = z.object({
  items: z.array(syncCatalogItemSchema).max(100, 'at most 100 items per sync').default([]),
});

export const expectedVersionSchema = z
  .number({ invalid_type_error: 'expectedVersion must be a number' })
  .int('expectedVersion must be an integer')
  .min(1, 'expectedVersion must be at least 1');

export const canaryAllowlistSchema = z
  .array(z.string().trim().min(1, 'canary entry must not be empty').max(64, 'canary entry too long'))
  .max(32, 'at most 32 canary entries');

/** Composite `provider:model` ids travel through activate/fallback lookups. */
export const modelRefSchema = z
  .string()
  .trim()
  .min(1, 'model id is required')
  .max(185, 'model id too long')
  .superRefine((v, ctx) => {
    // M-01: single resolver discipline — a ref is either a bare upstream
    // name (modelIdSchema) or a `providerId:modelId` composite with valid
    // parts. Free-form/opaque strings fail here, not at execution time.
    if (modelIdSchema.safeParse(v).success) return;
    const sep = v.indexOf(':');
    if (sep > 0 && sep < v.length - 1) {
      const providerPart = v.slice(0, sep);
      const modelPart = v.slice(sep + 1);
      if (providerIdSchema.safeParse(providerPart).success && modelIdSchema.safeParse(modelPart).success) {
        return;
      }
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'model ref must be a bare upstream name or a provider:model composite',
    });
  });

export const activateSchema = z.object({
  providerId: providerIdSchema,
  modelId: modelRefSchema,
  rolloutMode: rolloutModeSchema.optional(),
  expectedVersion: expectedVersionSchema,
});

export const rolloutSchema = z.object({
  rolloutMode: rolloutModeSchema.optional(),
  canaryAllowlist: canaryAllowlistSchema.optional(),
  expectedVersion: expectedVersionSchema,
});

export const fallbackSchema = z
  .object({
    providerId: providerIdSchema.nullable(),
    modelId: modelRefSchema.nullable(),
    expectedVersion: expectedVersionSchema,
  })
  .refine((v) => (v.providerId === null) === (v.modelId === null), {
    message: 'providerId and modelId must both be null or both be set',
  });

export const patchProviderSchema = z
  .object({
    enabled: z.boolean().optional(),
    eligibility: providerEligibilitySchema.optional(),
    secretAlias: secretAliasSchema.nullable().optional(),
  })
  .strict();

export const securityEpochSchema = z.object({}).strict();

/**
 * Credential CRUD (item 2). The key travels ONLY on write (POST credential);
 * reads always return the masked status. `dryRun` performs validation +
 * masking without persisting — used by tests and connection checks so no
 * real key is ever required in CI.
 */
export const apiKeyValueSchema = z
  .string()
  .trim()
  .min(8, 'api key is too short')
  .max(256, 'api key is too long');

export const setCredentialSchema = z
  .object({
    apiKey: apiKeyValueSchema,
    dryRun: z.boolean().optional(),
  })
  .strict();

export const credentialStatusSchema = z.object({
  providerId: providerIdSchema,
  configured: z.boolean(),
  masked: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const remoteModelItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  ownedBy: z.string().trim().max(120).nullable().optional(),
});

export const remoteModelsResponseSchema = z.object({
  providerId: providerIdSchema,
  models: z.array(remoteModelItemSchema).max(500),
  cached: z.boolean(),
  manualEntryAllowed: z.boolean(),
});

const pendingJsonValueSchema: z.ZodType<PendingOperationV2JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(pendingJsonValueSchema),
    z.record(z.string(), pendingJsonValueSchema),
  ]),
);

export const pendingOperationV2BindingsSchema = z.object({
  workspaceId: z.string().trim().min(1),
  actorId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
}).strict();

export const pendingOperationV2Schema = z.object({
  version: z.literal(2),
  workspaceId: z.string().trim().min(1),
  actorId: z.string().trim().min(1),
  deviceId: z.string().trim().min(1),
  tool: z.string().trim().min(1).regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/),
  normalizedArgs: z.record(z.string(), pendingJsonValueSchema),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(256),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  bindings: pendingOperationV2BindingsSchema,
}).strict().superRefine((value, ctx) => {
  if (value.bindings.workspaceId !== value.workspaceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings', 'workspaceId'], message: 'workspace binding does not match workspaceId' });
  if (value.bindings.actorId !== value.actorId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings', 'actorId'], message: 'actor binding does not match actorId' });
  if (value.bindings.deviceId !== value.deviceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings', 'deviceId'], message: 'device binding does not match deviceId' });
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiresAt must be after createdAt' });
});

const stableJson = (value: PendingOperationV2JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const hashInput = (operation: Pick<PendingOperationV2, 'tool' | 'normalizedArgs' | 'workspaceId' | 'actorId' | 'deviceId'>): string =>
  stableJson({
    tool: operation.tool,
    normalizedArgs: operation.normalizedArgs,
    workspaceId: operation.workspaceId,
    actorId: operation.actorId,
    deviceId: operation.deviceId,
  });

export const computePendingOperationV2Hash = async (operation: Pick<PendingOperationV2, 'tool' | 'normalizedArgs' | 'workspaceId' | 'actorId' | 'deviceId'>): Promise<string> => {
  const bytes = new TextEncoder().encode(hashInput(operation));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const verifyPendingOperationV2Hash = async (operation: PendingOperationV2): Promise<boolean> => {
  if (!pendingOperationV2Schema.safeParse(operation).success) return false;
  return (await computePendingOperationV2Hash(operation)) === operation.proposalHash;
};

/** Codex browser-login flow (item 6): callback carries an opaque code, the
 * broker exchanges it server-side and persists via atomic 0600 write. */
export const codexLoginBeginSchema = z
  .object({ callbackUrl: z.string().trim().url().max(500).optional() })
  .strict();

export const codexLoginCallbackSchema = z
  .object({
    code: z.string().trim().min(4).max(500),
    state: z.string().trim().max(128).optional(),
  })
  .strict();

export const llmProviderSlotSchema = z.object({
  id: z.string(),
  kind: providerKindSchema,
  transport: transportSchema,
  authMode: authModeSchema,
  secretAlias: secretAliasSchema.nullable(),
  serviceAlias: z.string().nullable(),
  eligibility: providerEligibilitySchema,
});

export const llmModelSlotSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  protocol: protocolSchema,
  privacyClass: privacyClassSchema,
});

export const internalRuntimeDtoSchema = z.object({
  singleton: z.literal('active'),
  version: z.number(),
  securityEpoch: z.number(),
  activeProviderId: z.string().nullable(),
  activeModelId: z.string().nullable(),
  activeProtocol: protocolSchema.nullable(),
  activeRolloutPercentage: z.number(),
  activeRolloutMode: rolloutModeSchema,
  canaryAllowlist: z.array(z.string()).optional(),
  fallbackProviderId: z.string().nullable(),
  fallbackModelId: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().optional(),
});

/**
 * Internal snapshot boundary schema: unknown keys are ignored (forward compat),
 * known keys are strict. Fase 1b-FIX item 9: flags and ids must agree — a
 * disabled pair carries null ids, so a producer cannot smuggle usable ids
 * past a fail-closed flag.
 */
export const internalSnapshotSchema = z
  .object({
    runtime: internalRuntimeDtoSchema,
    activeProvider: llmProviderSlotSchema.nullable(),
    activeModel: llmModelSlotSchema.nullable(),
    fallbackProvider: llmProviderSlotSchema.nullable(),
    fallbackModel: llmModelSlotSchema.nullable(),
    activeDisabled: z.boolean(),
    fallbackDisabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (
      v.activeDisabled &&
      (v.runtime.activeProviderId !== null || v.runtime.activeModelId !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'activeDisabled requires null active ids',
        path: ['runtime', 'activeProviderId'],
      });
    }
    if (
      v.fallbackDisabled &&
      (v.runtime.fallbackProviderId !== null || v.runtime.fallbackModelId !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fallbackDisabled requires null fallback ids',
        path: ['runtime', 'fallbackProviderId'],
      });
    }
    // Fase 2 item 3: when a pair is enabled, its ids must agree — a present
    // provider id requires a present model id and vice versa, so a
    // structurally valid but half-filled pair cannot become configuration.
    if (
      !v.activeDisabled &&
      (v.runtime.activeProviderId === null) !== (v.runtime.activeModelId === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'active pair requires both activeProviderId and activeModelId',
        path: ['runtime', 'activeProviderId'],
      });
    }
    if (
      !v.fallbackDisabled &&
      (v.runtime.fallbackProviderId === null) !== (v.runtime.fallbackModelId === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fallback pair requires both fallbackProviderId and fallbackModelId',
        path: ['runtime', 'fallbackProviderId'],
      });
    }
  });

/* ── TED V3 hardening (SPEC §15, §16, §7.8) ────────────────────────────── */

export const refreshTargetSchema = z.enum(REFRESH_TARGETS);
export const tedApprovalToolSchema = z.enum(TED_APPROVAL_TOOLS);
export const mutationKindSchema = z.enum(MUTATION_KINDS);

/**
 * Approval-card projection (SPEC §16). Strict: attestation, auth and args
 * material are rejected — the card carries display data only. `warnings`
 * is required (possibly empty) so the user always sees an explicit list;
 * `date` is a calendar day (YYYY-MM-DD), never a free-form LLM string.
 */
export const pendingOperationPresentationSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    status: z.string().trim().min(1).max(64),
    tool: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/),
    title: z.string().trim().min(1).max(120),
    amountCents: z.number().int().min(0).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
    account: z.object({ id: z.string().trim().min(1).max(128), label: z.string().trim().min(1).max(120) }).strict().optional(),
    category: z.object({ id: z.string().trim().min(1).max(128), label: z.string().trim().min(1).max(120) }).strict().optional(),
    categoryParent: z.object({ id: z.string().trim().min(1).max(128), label: z.string().trim().min(1).max(120) }).strict().optional(),
    accountName: z.string().trim().min(1).max(120).optional(),
    accountKind: z.string().trim().min(1).max(32).optional(),
    initialBalanceCents: z.number().int().optional(),
    balanceCents: z.number().int().optional(),
    categoryName: z.string().trim().min(1).max(120).optional(),
    expectedDescription: z.string().min(1).max(240).refine((value) => value.trim().length > 0).optional(),
    transactionTargetId: z.string().trim().min(1).max(128).optional(),
    transactionAmountCents: z.number().int().min(0).optional(),
    transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    transactionAccount: z.object({id:z.string().trim().min(1).max(128),label:z.string().trim().min(1).max(120)}).strict().optional(),
    categoryKind: z.string().trim().min(1).max(32).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict();

/**
 * Mutation receipt (SPEC §15.1). Identity rule enforced below: receipts
 * whose kind originates from a TED approval tool MUST carry the origin
 * `operationId`; normal-write receipts are valid without it.
 */
export const mutationReceiptSchema = z
  .object({
    mutationId: z.string().trim().min(1).max(128),
    mutationKind: mutationKindSchema,
    status: z.literal('succeeded'),
    affectedTargets: z.array(refreshTargetSchema),
    operationId: z.string().trim().min(1).max(128).optional(),
    entity: z
      .object({
        type: z.string().trim().min(1).max(64),
        id: z.string().trim().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (TED_APPROVAL_TOOLS as readonly string[]).includes(value.mutationKind) &&
      value.operationId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operationId'],
        message: 'TED approval-tool receipts require the origin operationId',
      });
    }
  });

/**
 * Single Mutation Effects Registry entry (SPEC §15.1.1): a deterministic
 * refresh set, or an explicit no-refresh exception with zero targets.
 */
export const mutationEffectsEntrySchema = z.union([
  z
    .object({
      mutationKind: mutationKindSchema,
      affectedTargets: z.array(refreshTargetSchema).min(1),
      noRefresh: z.literal(false).optional(),
    })
    .strict(),
  z
    .object({
      mutationKind: mutationKindSchema,
      affectedTargets: z.array(refreshTargetSchema).max(0),
      noRefresh: z.literal(true),
    })
    .strict(),
]);

/**
 * Browser-safe draft clarification payload (SPEC §7.8). Strict: no
 * authorization, attestation, hash or executable-args keys survive.
 */
export const mutationDraftChannelSchema = z
  .object({
    draftId: z.string().trim().min(1).max(128),
    tool: tedApprovalToolSchema,
    missingFields: z.array(z.string().trim().min(1).max(64)).min(1),
    question: z.string().trim().min(1).max(500),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * HIGH3 (round 3): authoritative expected context for receipt binding.
 * The ORIGINAL tool (+ the pre-existing target id when the operation
 * names one), from the listing record that authorized the decision —
 * never from the execution response, never from client input. Strict:
 * only these two display-safe fields cross to the browser (no
 * attestation/authority material by construction).
 */
export const decisionExpectedContextSchema = z
  .object({
    tool: z.string().trim().min(1).max(64),
    entityId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/**
 * Read-only Pending V2 outcome projection. Known non-terminal statuses are
 * observational only; consumers must not render them as terminal feedback.
 * Success requires the API's canonical receipt and its server-derived context.
 */
const pendingOutcomeBaseSchema = z.object({
  operationId: z.string().uuid(),
  tool: tedApprovalToolSchema,
});
const pendingOutcomeExpectedContextSchema = decisionExpectedContextSchema.optional();

export const pendingOperationOutcomeSchema = z
  .discriminatedUnion('status', [
    pendingOutcomeBaseSchema.extend({ status: z.enum(['proposed', 'confirmed', 'executing']) }).strict(),
    pendingOutcomeBaseSchema.extend({
      status: z.literal('succeeded'),
      receipt: mutationReceiptSchema,
      expectedContext: decisionExpectedContextSchema,
    }).strict(),
    pendingOutcomeBaseSchema.extend({
      status: z.literal('failed'),
      failureCode: z.literal('in_use').optional(),
      expectedContext: pendingOutcomeExpectedContextSchema,
    }).strict(),
    pendingOutcomeBaseSchema.extend({
      status: z.enum(['cancelled', 'expired', 'unverified']),
      expectedContext: pendingOutcomeExpectedContextSchema,
    }).strict(),
  ])
  .superRefine((value, ctx) => {
    const expected = 'expectedContext' in value ? value.expectedContext : undefined;
    if (expected && expected.tool !== value.tool) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedContext', 'tool'], message: 'Outcome context tool must match the operation tool.' });
    }
    if (value.status === 'failed' && value.failureCode === 'in_use' && value.tool !== 'categories.deactivate') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failureCode'], message: 'in_use is only valid for categories.deactivate.' });
    }
    if (value.status !== 'succeeded') return;
    const { receipt, expectedContext } = value;
    const entityType = value.tool.startsWith('categories.') ? 'category'
      : value.tool.startsWith('accounts.') ? 'account' : 'transaction';
    if (
      receipt.status !== 'succeeded' ||
      receipt.operationId !== value.operationId ||
      receipt.mutationKind !== value.tool ||
      !receipt.entity ||
      receipt.entity.type !== entityType ||
      expectedContext.tool !== value.tool ||
      (expectedContext.entityId !== undefined && expectedContext.entityId !== receipt.entity.id)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['receipt'], message: 'Success receipt must match the operation and expected entity.' });
    }
  });

export type PendingOperationOutcome = z.infer<typeof pendingOperationOutcomeSchema>;

/**
 * Every schema whose output may reach the browser. The attestation-ban
 * test sweeps this record, so new channel types are covered by adding
 * them here.
 */
export const BROWSER_FACING_SCHEMAS = {
  pendingOperationPresentation: pendingOperationPresentationSchema,
  mutationReceipt: mutationReceiptSchema,
  mutationDraftChannel: mutationDraftChannelSchema,
  decisionExpectedContext: decisionExpectedContextSchema,
  pendingOperationOutcome: pendingOperationOutcomeSchema,
} as const;

export type BrowserFacingSchemaName = keyof typeof BROWSER_FACING_SCHEMAS;

/**
 * Deterministic effects lookup (SPEC §15.1.1). A known kind with no
 * registration is an error — never an empty silent refresh.
 */
export const resolveMutationEffects = (kind: MutationKind): MutationEffectsEntry => {
  const entry = (MUTATION_EFFECTS_REGISTRY as Record<string, MutationEffectsEntry | undefined>)[kind];
  if (!entry) throw new Error(`no registered mutation effects for kind: ${kind}`);
  return entry;
};

/** Fails listing every registered kind missing from the given table. */
export const assertAllMutationKindsRegistered = (
  registry: Partial<Record<MutationKind, MutationEffectsEntry>> = MUTATION_EFFECTS_REGISTRY,
): void => {
  const missing = MUTATION_KINDS.filter((kind) => registry[kind] === undefined);
  if (missing.length > 0) {
    throw new Error(`mutation kinds without registered effects: ${missing.join(', ')}`);
  }
};
