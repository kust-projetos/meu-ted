// P2D live-prep credential + prep-only guards (test-only infra, never bundled).
//
// Thin ESM facade: the single source of truth lives in
// `p2d-live-credential.cjs` (strict CommonJS, no `import.meta`), which the
// Playwright config loader can `require()` — requiring THIS file from a CJS
// transform breaks with `SyntaxError: Cannot use 'import.meta' outside a
// module`. Existing ESM importers (`p2d-live-prep.mjs`, the node:test
// contract) keep importing this facade; no logic is duplicated here.
//
// Secrecy posture: see the `.cjs` (declared once, enforced there).
import pkg from "./p2d-live-credential.cjs";

export const {
  LIVE_BOOT_FAILURE_MESSAGE,
  LIVE_CREDENTIAL_ALIAS,
  LIVE_CREDENTIAL_NATIVE,
  LIVE_CREDENTIAL_TARGET,
  LIVE_MODEL_RE,
  NEXT_ENV_BLOCKED_NAMES,
  OFFLINE_DUMMY_KEY,
  OFFLINE_PROVIDER,
  OFFLINE_PROVIDER_PACKAGE,
  RUNTIME_MODES,
  applyLiveRealCredentialAlias,
  assertIsolatedHome,
  assertNoBlockingNextEnvFiles,
  assertNoFinancialWrites,
  buildLiveRuntimeEnv,
  buildOfflineProviderConfig,
  buildOfflineRuntimeEnv,
  buildPlaywrightEnv,
  defaultSiblingEnvFile,
  expectApiHealthBody,
  expectGatewayNotFound,
  findBlockingNextEnvFiles,
  isCliEntry,
  isLoopbackHttpUrl,
  isLoopbackOrigin,
  loadLiveCredential,
  loadLiveModelSelector,
  loadRuntimeCredentialForMode,
  pickSpawnBase,
  resolveConfiguredLiveModel,
  resolveLiveEnvCandidates,
  sanitizePrepError,
  stripCredentialKeys,
  validateLivePrepReceipt,
  validateOfflineChatReceipt,
  withLiveBootBoundary,
  withScrubbedEnv,
} = pkg;
