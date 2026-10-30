export const LEGACY_FREE_MODEL = Object.freeze({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' })
export const LEGACY_FREE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions'
export const REAL_MODEL = Object.freeze({ providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' })
export const REAL_URL = 'https://opencode.ai/inference/go/openai/v1/responses'
export const MAX_CASES = 23
export const REAL_CONFIRMATION = '--confirm-model=opencode-go/muse-spark-1.3-contributor'
export const GO_QUOTA_CONFIRMATION = '--confirm-go-quota-available'
export const GO_EXTRA_USAGE_CONFIRMATION = '--confirm-go-extra-usage-disabled'
const APPROVED_INFRA_ENDINGS = new Map([
  ['2026-10-27T01-04-23-758Z-13588', new Set(['F1-B005'])],
])
export const AUTHORIZED_RETRY_CASE_ID = 'F1-B005'
export const AUTHORIZED_RETRY_SOURCE_RUN_ID = '2026-10-27T15-19-19-424Z-5620'
export const AUTHORIZED_CONSUMED_SMOKE_CASE_ID = 'F1-B005'
export const AUTHORIZED_CONSUMED_SMOKE_RUN_ID = '2026-10-29T10-55-14-534Z-21048'
export const AUTHORIZED_FRESH_SMOKE_CASE_ID = 'F1-B005'
export const AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER = 'fresh'
export const AUTHORIZED_CONSUMED_SMOKE_RESERVATION_PATH = `reservations/${REAL_MODEL.providerID}-${REAL_MODEL.modelID}/${AUTHORIZED_CONSUMED_SMOKE_CASE_ID}.authorized-retry-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`
export const AUTHORIZED_REMAINING22_SOURCE_RUN_ID = '2026-10-29T12-26-34-600Z-4324'
export const AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2 = '2026-10-29T20-54-25-649Z-6500'
export const AUTHORIZED_REMAINING22_SOURCE_RUN_ID_3 = '2026-10-29T22-34-44-294Z-10836'
export const AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID = 'F1-B005'
export const BOOTSTRAP_FRESH_CHAIN_FLAG = '--bootstrap-fresh-chain-F1-B005'
export const BOOTSTRAP_FRESH_CHAIN_AUTHORIZATION = 'docs/decisions/2026-10-29-fechar-f2.md F2-muse-spark-excecao (POC sintetica, opt-in/regiao OK, teto SPEC S7)'
export const AUTHORIZED_REMAINING22_SOURCE_RUN_IDS = Object.freeze([AUTHORIZED_REMAINING22_SOURCE_RUN_ID, AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2, AUTHORIZED_REMAINING22_SOURCE_RUN_ID_3])
export function isAuthorizedRemaining22SourceRunID(sourceRunID) {
  return sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID || sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2 || sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID_3
}
export const AUTHORIZED_REMAINING22_S2_RESERVATION_PATH = `reservations/${REAL_MODEL.providerID}-${REAL_MODEL.modelID}/F1-B005.fresh-smoke-${AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2}.json`
export const AUTHORIZED_REMAINING22_S4_RESERVATION_PATH = `reservations/${REAL_MODEL.providerID}-${REAL_MODEL.modelID}/F1-B005.fresh-smoke-${AUTHORIZED_REMAINING22_SOURCE_RUN_ID_3}.json`
export const REMAINING22_EXCLUDED_CASE_ID = 'F1-B005'
export const REMAINING22_EXPECTED_COUNT = 22
export const REMAINING22_SUPERSEDE_SUFFIX = '-r2'
export const AUTHORIZED_REMAINING22_RESERVATION_PATH = `reservations/${REAL_MODEL.providerID}-${REAL_MODEL.modelID}/${REMAINING22_EXCLUDED_CASE_ID}.consumed-smoke-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`
const normalizeReservationSeparators = (value) => String(value).replace(/\\/g, '/')
const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}
const RETRY_CASE_FLAG = '--retry-authorized-case='
const RETRY_RUN_FLAG = '--retry-authorized-run='
const CONSUMED_SMOKE_CASE_FLAG = '--consumed-smoke-authorized-case='
const CONSUMED_SMOKE_RUN_FLAG = '--consumed-smoke-authorized-run='
const FRESH_SMOKE_CASE_FLAG = '--fresh-smoke-authorized-case='
const FRESH_SMOKE_RUN_FLAG = '--fresh-smoke-authorized-run='
const REMAINING22_RUN_FLAG = '--remaining22-authorized-run='
// Single-price model (muse-spark POC swap): one allowlisted tier, no off-peak/peak
// price split. The deepseek tiers were removed (clean swap: the harness has a
// single active model). A tier label, when present, must still be a known Go
// label but is not price-bearing.
const APPROVED_GO_CATALOG_TIERS = [
  { input: 0.10, output: 0.20, read: 0.002, write: 0 },
]

export function parseExecutionMode(argv) {
  const execute = argv.includes('--execute-real')
  const preflightOnly = argv.includes('--preflight-only')
  const selfTestGuard = argv.includes('--self-test-guard')
  const smokeOnly = argv.includes('--smoke-only')
  const confirmation = argv.includes(REAL_CONFIRMATION)
  const quotaConfirmation = argv.includes(GO_QUOTA_CONFIRMATION)
  const extraUsageConfirmation = argv.includes(GO_EXTRA_USAGE_CONFIRMATION)
  const resumeArg = argv.find((arg) => arg.startsWith('--resume='))
  const resumeID = resumeArg?.slice('--resume='.length)
  const retryCaseArg = argv.find((arg) => arg.startsWith(RETRY_CASE_FLAG))
  const retryRunArg = argv.find((arg) => arg.startsWith(RETRY_RUN_FLAG))
  const retryCaseID = retryCaseArg?.slice(RETRY_CASE_FLAG.length)
  const retryRunID = retryRunArg?.slice(RETRY_RUN_FLAG.length)
  const consumedSmokeCaseArg = argv.find((arg) => arg.startsWith(CONSUMED_SMOKE_CASE_FLAG))
  const consumedSmokeRunArg = argv.find((arg) => arg.startsWith(CONSUMED_SMOKE_RUN_FLAG))
  const consumedSmokeCaseID = consumedSmokeCaseArg?.slice(CONSUMED_SMOKE_CASE_FLAG.length)
  const consumedSmokeRunID = consumedSmokeRunArg?.slice(CONSUMED_SMOKE_RUN_FLAG.length)
  const remaining22Arg = argv.find((arg) => arg.startsWith(REMAINING22_RUN_FLAG))
  const remaining22RunID = remaining22Arg?.slice(REMAINING22_RUN_FLAG.length)
  const freshSmokeCaseArg = argv.find((arg) => arg.startsWith(FRESH_SMOKE_CASE_FLAG))
  const freshSmokeRunArg = argv.find((arg) => arg.startsWith(FRESH_SMOKE_RUN_FLAG))
  const freshSmokeCaseID = freshSmokeCaseArg?.slice(FRESH_SMOKE_CASE_FLAG.length)
  const freshSmokeRunID = freshSmokeRunArg?.slice(FRESH_SMOKE_RUN_FLAG.length)
  const exportArg = argv.find((arg) => arg.startsWith('--export-stopped-run='))
  const exportStoppedRunID = exportArg?.slice('--export-stopped-run='.length)
  const bootstrapFreshChain = argv.includes(BOOTSTRAP_FRESH_CHAIN_FLAG)
  if (argv.includes('--help') || (!execute && !preflightOnly && !selfTestGuard && !smokeOnly && !resumeID && !exportStoppedRunID && !retryCaseID && !retryRunID && !consumedSmokeCaseID && !consumedSmokeRunID && !freshSmokeCaseID && !freshSmokeRunID && remaining22RunID === undefined && !bootstrapFreshChain)) return { help: true, execute, preflightOnly, selfTestGuard, smokeOnly, confirmation, quotaConfirmation, extraUsageConfirmation, resumeID, exportStoppedRunID, retryCaseID, retryRunID, consumedSmokeCaseID, consumedSmokeRunID, freshSmokeCaseID, freshSmokeRunID, remaining22RunID, bootstrapFreshChain }
  if (remaining22RunID !== undefined) {
    if (!isAuthorizedRemaining22SourceRunID(remaining22RunID)) throw new Error(`remaining22 campaign is limited to source allowlist [${AUTHORIZED_REMAINING22_SOURCE_RUN_IDS.join(',')}]`)
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(remaining22RunID)) throw new Error('remaining22 source run id is not a safe run-id')
    if (!execute || !confirmation || !quotaConfirmation || !extraUsageConfirmation) throw new Error('remaining22 campaign requires --execute-real plus exact confirmations')
    if (smokeOnly) throw new Error('remaining22 campaign cannot be combined with --smoke-only')
    if (resumeID || preflightOnly || selfTestGuard || exportStoppedRunID) throw new Error('remaining22 campaign cannot be combined with preflight, self-test, resume, or export')
    if (retryCaseID !== undefined || retryRunID !== undefined) throw new Error('remaining22 campaign is incompatible with authorized retry flags')
    if (consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined) throw new Error('remaining22 campaign is incompatible with consumed smoke flags')
    if (freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined) throw new Error('remaining22 campaign is incompatible with fresh smoke flags')
  }
  if ((retryCaseID !== undefined || retryRunID !== undefined)) {
    if (retryCaseID === undefined || retryRunID === undefined) throw new Error('authorized retry requires both case and run: --retry-authorized-case plus --retry-authorized-run')
    if (retryCaseID !== AUTHORIZED_RETRY_CASE_ID || retryRunID !== AUTHORIZED_RETRY_SOURCE_RUN_ID) throw new Error(`authorized retry is limited to F1-B005 from ${AUTHORIZED_RETRY_SOURCE_RUN_ID}`)
    if (!execute || !smokeOnly || !confirmation || !quotaConfirmation || !extraUsageConfirmation) throw new Error('authorized retry requires --execute-real --smoke-only plus exact confirmations')
    if (resumeID || preflightOnly || selfTestGuard || exportStoppedRunID) throw new Error('authorized retry cannot be combined with preflight, self-test, resume, or export')
    if (consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined) throw new Error('authorized retry is incompatible with consumed smoke authorization flags')
    if (freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined) throw new Error('authorized retry is incompatible with fresh smoke authorization flags')
    if (remaining22RunID !== undefined) throw new Error('authorized retry is incompatible with remaining22 campaign flags')
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(retryRunID)) throw new Error('authorized retry run id is not a safe run-id')
  }
  if ((consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined)) {
    if (consumedSmokeCaseID === undefined || consumedSmokeRunID === undefined) throw new Error('consumed smoke requires both case and run: --consumed-smoke-authorized-case plus --consumed-smoke-authorized-run')
    if (consumedSmokeCaseID !== AUTHORIZED_CONSUMED_SMOKE_CASE_ID || consumedSmokeRunID !== AUTHORIZED_CONSUMED_SMOKE_RUN_ID) throw new Error(`consumed smoke is limited to F1-B005 from ${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}`)
    if (!execute || !smokeOnly || !confirmation || !quotaConfirmation || !extraUsageConfirmation) throw new Error('consumed smoke requires --execute-real --smoke-only plus exact confirmations')
    if (resumeID || preflightOnly || selfTestGuard || exportStoppedRunID) throw new Error('consumed smoke cannot be combined with preflight, self-test, resume, or export')
    if (retryCaseID !== undefined || retryRunID !== undefined) throw new Error('consumed smoke is incompatible with authorized retry flags')
    if (freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined) throw new Error('consumed smoke is incompatible with fresh smoke authorization flags')
    if (remaining22RunID !== undefined) throw new Error('consumed smoke is incompatible with remaining22 campaign flags')
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(consumedSmokeRunID)) throw new Error('consumed smoke run id is not a safe run-id')
  }
  if ((freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined)) {
    if (freshSmokeCaseID === undefined || freshSmokeRunID === undefined) throw new Error('fresh smoke requires both case and run: --fresh-smoke-authorized-case plus --fresh-smoke-authorized-run')
    if (freshSmokeCaseID !== AUTHORIZED_FRESH_SMOKE_CASE_ID || freshSmokeRunID !== AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER) throw new Error(`fresh smoke is limited to F1-B005 from ${AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER}`)
    if (!execute || !smokeOnly || !confirmation || !quotaConfirmation || !extraUsageConfirmation) throw new Error('fresh smoke requires --execute-real --smoke-only plus exact confirmations')
    if (resumeID || preflightOnly || selfTestGuard || exportStoppedRunID) throw new Error('fresh smoke cannot be combined with preflight, self-test, resume, or export')
    if (retryCaseID !== undefined || retryRunID !== undefined) throw new Error('fresh smoke is incompatible with authorized retry flags')
    if (consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined) throw new Error('fresh smoke is incompatible with consumed smoke authorization flags')
    if (remaining22RunID !== undefined) throw new Error('fresh smoke is incompatible with remaining22 campaign flags')
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(freshSmokeRunID)) throw new Error('fresh smoke run id is not a safe run-id')
  }
  if (exportStoppedRunID && (execute || preflightOnly || selfTestGuard || smokeOnly || resumeID || retryCaseID || retryRunID || consumedSmokeCaseID || consumedSmokeRunID || freshSmokeCaseID || freshSmokeRunID || remaining22RunID !== undefined || quotaConfirmation || extraUsageConfirmation || !/^[a-zA-Z0-9._-]{1,80}$/.test(exportStoppedRunID))) throw new Error('--export-stopped-run requires only a safe run-id and performs no server/catalog call')
if (bootstrapFreshChain) {
  if (!execute || !smokeOnly || !confirmation || !quotaConfirmation || !extraUsageConfirmation) throw new Error('bootstrap fresh chain requires --execute-real --smoke-only plus exact confirmations')
  if (resumeID || preflightOnly || selfTestGuard || exportStoppedRunID) throw new Error('bootstrap fresh chain cannot be combined with preflight, self-test, resume, or export')
  if (retryCaseID !== undefined || retryRunID !== undefined) throw new Error('bootstrap fresh chain is incompatible with authorized retry flags')
  if (consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined) throw new Error('bootstrap fresh chain is incompatible with consumed smoke flags')
  if (freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined) throw new Error('bootstrap fresh chain is incompatible with fresh smoke flags')
  if (remaining22RunID !== undefined) throw new Error('bootstrap fresh chain is incompatible with remaining22 campaign flags')
}
  if (execute && !confirmation) throw new Error(`real inference requires exact confirmation ${REAL_CONFIRMATION}`)
  if (execute && !quotaConfirmation) throw new Error(`real Go inference requires explicit quota confirmation ${GO_QUOTA_CONFIRMATION}`)
  if (execute && !extraUsageConfirmation) throw new Error(`real Go inference requires explicit Extra Usage confirmation ${GO_EXTRA_USAGE_CONFIRMATION}`)
  if (smokeOnly && !execute) throw new Error('--smoke-only requires --execute-real and exact model confirmation')
  if (execute && !resumeID && !smokeOnly && remaining22RunID === undefined) throw new Error('the first real F2B0 invocation must use --smoke-only')
  if (smokeOnly && (preflightOnly || selfTestGuard || resumeID || remaining22RunID !== undefined)) throw new Error('--smoke-only cannot be combined with preflight, self-test, resume, or remaining22 campaign')
  if ((preflightOnly || selfTestGuard) && (execute || resumeID || remaining22RunID !== undefined || (preflightOnly && selfTestGuard))) throw new Error('preflight/self-test modes cannot be combined with real execution/resume/remaining22 or each other')
  if (resumeID && (!execute || !/^[a-zA-Z0-9._-]{1,80}$/.test(resumeID))) throw new Error('--resume requires --execute-real and a safe run-id')
  if (resumeID && remaining22RunID !== undefined) throw new Error('remaining22 campaign cannot be combined with preflight, self-test, resume, or export')
  if ((freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined) && (preflightOnly || selfTestGuard || resumeID || exportStoppedRunID || remaining22RunID !== undefined)) throw new Error('fresh smoke cannot be combined with preflight, self-test, resume, remaining22, or export')
  return { help: false, execute, preflightOnly, selfTestGuard, smokeOnly, confirmation, quotaConfirmation, extraUsageConfirmation, resumeID, exportStoppedRunID, retryCaseID, retryRunID, consumedSmokeCaseID, consumedSmokeRunID, freshSmokeCaseID, freshSmokeRunID, remaining22RunID, bootstrapFreshChain }
}

export function validateCatalogCost(cost) {
  if (!Array.isArray(cost) || cost.length === 0) return { ok: false, reason: 'cost-missing' }
  const validated = []
  for (const tier of cost) {
    for (const key of ['input', 'output']) {
      if (typeof tier?.[key] !== 'number' || !Number.isFinite(tier[key])) return { ok: false, reason: 'cost-unknown' }
    }
    for (const key of ['read', 'write']) {
      if (typeof tier?.cache?.[key] !== 'number' || !Number.isFinite(tier.cache[key])) return { ok: false, reason: 'cost-unknown' }
    }
    const matched = APPROVED_GO_CATALOG_TIERS.find((approved) => tier.input === approved.input
      && tier.output === approved.output
      && tier.cache.read === approved.read
      && tier.cache.write === approved.write)
    if (!matched || (tier.tier !== undefined && !['off-peak', 'peak'].includes(tier.tier))) return { ok: false, reason: 'cost-not-allowlisted' }
    validated.push(matched)
  }
  if (new Set(validated.map((tier) => tier.input)).size !== validated.length) return { ok: false, reason: 'cost-tier-duplicate' }
  return { ok: true, tiers: cost.length }
}

export function validateFreeCatalogCost(cost) {
  if (!Array.isArray(cost) || cost.length === 0) return { ok: false, reason: 'cost-missing' }
  for (const tier of cost) {
    for (const key of ['input', 'output']) {
      if (typeof tier?.[key] !== 'number' || !Number.isFinite(tier[key])) return { ok: false, reason: 'cost-unknown' }
    }
    for (const key of ['read', 'write']) {
      if (typeof tier?.cache?.[key] !== 'number' || !Number.isFinite(tier.cache[key])) return { ok: false, reason: 'cost-unknown' }
    }
    if (tier.input !== 0 || tier.output !== 0 || tier.cache.read !== 0 || tier.cache.write !== 0) return { ok: false, reason: 'cost-nonzero' }
  }
  return { ok: true, tiers: cost.length }
}

export function validateGoUsageLimits(info) {
  if (!info || typeof info !== 'object') return { ok: false, reason: 'go-usage-unavailable' }
  if (!info.go || typeof info.go !== 'object') return { ok: false, reason: 'go-subscription-unavailable' }
  const usage = {}
  for (const window of ['rolling', 'weekly', 'monthly']) {
    const meter = info.go[window]
    if (!meter || typeof meter !== 'object'
      || typeof meter.percent !== 'number' || !Number.isFinite(meter.percent) || meter.percent < 0 || meter.percent > 100
      || typeof meter.limited !== 'boolean'
      || typeof meter.resetsAt !== 'number' || !Number.isFinite(meter.resetsAt)) {
      return { ok: false, reason: 'go-usage-unknown' }
    }
    usage[window] = { percent: meter.percent, limited: meter.limited, resetsAt: meter.resetsAt }
  }
  const limitedWindow = Object.entries(usage).find(([, meter]) => meter.limited || meter.percent >= 100)?.[0]
  if (limitedWindow) return { ok: false, reason: 'go-quota-limited', window: limitedWindow, usage }
  return { ok: true, usage }
}

export function evaluateGoSmoke({
  jsonValid,
  schemaValid,
  semanticVerdict,
  requestCount,
  noRetry,
  tokensObserved,
  costObserved,
  costUSD,
  quotaAfterStatus,
  quotaAttested,
  extraUsageDisabledAttested,
}) {
  if (!quotaAttested || !extraUsageDisabledAttested) {
    return { casePassed: false, continuationAllowed: false, status: 'SMOKE_BLOCKED_UNVERIFIED_BUDGET' }
  }
  if (!jsonValid || !schemaValid || semanticVerdict === 'FAIL' || requestCount !== 1 || !noRetry || (costObserved && costUSD !== 0)) {
    return { casePassed: false, continuationAllowed: false, status: 'SMOKE_FAILED_STOP' }
  }
  if (semanticVerdict !== 'PASS' || !tokensObserved || !costObserved) {
    return { casePassed: false, continuationAllowed: false, status: 'SMOKE_INCONCLUSIVE_STOP' }
  }
  if (quotaAfterStatus === 'go-quota-limited') {
    return { casePassed: true, continuationAllowed: false, status: 'SMOKE_PASS_QUOTA_STOP' }
  }
  if (quotaAfterStatus) {
    return { casePassed: true, continuationAllowed: false, status: 'SMOKE_PASS_OPERATOR_ATTESTED_NO_CONTINUATION' }
  }
  return {
    casePassed: true,
    continuationAllowed: true,
    status: 'SMOKE_PASS',
  }
}

export function validateNativeRequest(request) {
  if (request.providerID !== REAL_MODEL.providerID) return { ok: false, reason: 'provider-mismatch' }
  if (request.modelID !== REAL_MODEL.modelID) return { ok: false, reason: 'model-mismatch' }
  if (request.kind !== 'primary') return { ok: false, reason: 'request-kind-mismatch' }
  if (request.method !== 'POST') return { ok: false, reason: 'method-mismatch' }
  if (request.sessionRequestCount !== 1) return { ok: false, reason: 'request-count-exceeded' }
  if (request.redirect !== 'error') return { ok: false, reason: 'redirect-policy-mismatch' }
  let url
  try { url = new URL(request.url) } catch { return { ok: false, reason: 'url-invalid' } }
  if (url.href !== REAL_URL || url.username || url.password || url.search || url.hash) return { ok: false, reason: 'url-mismatch' }
  const body = request.body
  if (!body || body.model !== REAL_MODEL.modelID) return { ok: false, reason: 'body-model-mismatch' }
  // Native responses shape: `input` carries the prompt; the legacy
  // chat/completions `messages` array must never appear here.
  if (!('input' in body)) return { ok: false, reason: 'body-input-missing' }
  if ('messages' in body) return { ok: false, reason: 'body-messages-present' }
  if ('tools' in body && (!Array.isArray(body.tools) || body.tools.length !== 0)) return { ok: false, reason: 'tools-present' }
  if ('tool_choice' in body && body.tool_choice !== 'none') return { ok: false, reason: 'tool-choice-present' }
  return { ok: true, model: body.model }
}

export function classifyProviderFailure(failure = {}) {
  if (failure.kind === 'schema-invalid') return { stop: false, category: 'schema-invalid' }
  const status = Number(failure.status ?? failure.error?.status)
  const type = String(failure.type ?? failure.error?.type ?? '')
  const message = String(failure.message ?? failure.error?.message ?? '')
  if (Number.isFinite(status) && status >= 400) return { stop: true, category: status === 401 || status === 403 ? 'auth' : status === 402 ? 'payment' : status === 429 ? 'quota' : status >= 500 ? 'provider-server' : 'provider-client' }
  if (/auth|unauthori[sz]ed|forbidden|payment|billing|quota|credit|rate.?limit/i.test(`${type} ${message}`)) return { stop: true, category: /auth|unauthori[sz]ed|forbidden/i.test(`${type} ${message}`) ? 'auth' : /payment|billing|credit/i.test(`${type} ${message}`) ? 'payment' : 'quota' }
  if (/provider\.(transport|internal|server-error)|ECONN|timed? ?out|connection|network|redirect/i.test(`${type} ${message}`)) return { stop: true, category: 'transport' }
  return { stop: false, category: 'nonfatal' }
}

export function classifyLocalServerFailure(error = {}) {
  const status = Number(error.status ?? error.statusCode ?? error.response?.status ?? error.cause?.status)
  if (Number.isFinite(status) && status > 0) {
    return { retry: false, fatal: true, category: status === 401 || status === 403 ? 'local-auth' : 'local-http', status }
  }
  const codes = [error.code, error.cause?.code, error.cause?.cause?.code].filter((value) => typeof value === 'string')
  if (codes.some((code) => ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code))) {
    // Branch no-retry-controlled: local connection/readiness failures are
    // fail-closed for the inference layer (retry:false). A bounded
    // server-readiness poll (server.info only, never a prompt resend) may
    // still wait in startServer via isReadinessPollRetriable(); no prompt,
    // session, or model call is ever repeated after a local failure.
    return { retry: false, fatal: true, category: 'connection' }
  }
  return { retry: false, fatal: true, category: 'local-client' }
}

// Branch no-retry-controlled: readiness-only poll predicate. server.info()
// carries no prompt, session, or model call, so a bounded wait here cannot
// repeat inference. Any failure once a prompt path is reachable aborts via
// classifyLocalServerFailure (retry:false, fatal:true) with zero resends.
export function isReadinessPollRetriable(error = {}) {
  const status = Number(error.status ?? error.statusCode ?? error.response?.status ?? error.cause?.status)
  if (Number.isFinite(status) && status > 0) return false
  const codes = [error.code, error.cause?.code, error.cause?.cause?.code].filter((value) => typeof value === 'string')
  return codes.some((code) => ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code))
}

const observedNumber = (value) => typeof value === 'number' && Number.isFinite(value)
  ? { value, observed: true }
  : { value: null, observed: false }

export function normalizeTokenUsage(usage) {
  const value = usage && typeof usage === 'object' ? usage : {}
  const cache = value.cache && typeof value.cache === 'object' ? value.cache : {}
  const known = new Set(['input', 'output', 'total', 'reasoning', 'cacheRead', 'cacheWrite', 'cache'])
  const unknown = Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)))
  const cacheUnknown = Object.fromEntries(Object.entries(cache).filter(([key]) => !['read', 'write'].includes(key)))
  if (Object.keys(cacheUnknown).length > 0) unknown.cache = cacheUnknown
  return {
    input: observedNumber(value.input),
    output: observedNumber(value.output),
    total: observedNumber(value.total),
    reasoning: observedNumber(value.reasoning),
    cacheRead: observedNumber(cache.read ?? value.cacheRead),
    cacheWrite: observedNumber(cache.write ?? value.cacheWrite),
    unknown,
  }
}

export function isTerminalAssistantFailure(message) {
  return message?.finish === 'error' || (message?.error !== undefined && message.error !== null)
}

export function classifyAssistantOutcome({ waitError, assistantMessages = [] } = {}) {
  if (waitError) return { terminal: true, category: 'session-wait-error' }
  const failed = assistantMessages.find((message) => isTerminalAssistantFailure(message))
  if (failed) return { terminal: true, category: 'assistant-terminal-error', finish: failed.finish ?? null, error: failed.error ?? null }
  return { terminal: false, category: 'assistant-nonterminal' }
}

export function aggregateObservedMetric(samples) {
  const observed = samples.filter((sample) => sample?.observed === true && typeof sample.value === 'number' && Number.isFinite(sample.value))
  const missingCount = samples.length - observed.length
  return {
    value: missingCount === 0 ? observed.reduce((total, sample) => total + sample.value, 0) : null,
    observed: missingCount === 0 && samples.length > 0,
    observedCount: observed.length,
    missingCount,
  }
}

export function nearestRankPercentile(samples, percentile) {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) throw new Error('percentile must be in (0, 1]')
  const sorted = samples.filter((value) => typeof value === 'number' && Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return { value: null, observedCount: 0, method: 'nearest-rank' }
  const rank = Math.max(1, Math.ceil(percentile * sorted.length))
  return { value: sorted[rank - 1], observedCount: sorted.length, method: 'nearest-rank' }
}

export function extractCliOutput(rawStdout) {
  const events = String(rawStdout).split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const text = events
    .filter((event) => event.type === 'text' || event.part?.type === 'text')
    .map((event) => event.part?.text ?? event.text ?? '')
    .join('')
  const finish = events.find((event) => event.type === 'step_finish' || event.part?.type === 'step-finish')
  const detail = finish?.part ?? finish?.data ?? finish ?? {}
  const tokens = detail.tokens ?? detail.usage ?? {}
  const usage = normalizeTokenUsage(tokens)
  const cost = typeof detail.cost === 'number' && Number.isFinite(detail.cost) ? detail.cost : null
  return { events, text, eventTypes: events.map((event) => event.type), usage, cost }
}

export function planAttempts(caseIDs, existingIDs, { resume = false, reservedIDs = [] } = {}) {
  if (!Array.isArray(caseIDs) || caseIDs.length === 0 || caseIDs.length > MAX_CASES) throw new Error('23-case ceiling exceeded')
  if (new Set(caseIDs).size !== caseIDs.length) throw new Error('duplicate manifest case ID')
  const existing = new Set(existingIDs)
  const reserved = new Set(reservedIDs)
  if ([...existing].some((id) => !caseIDs.includes(id))) throw new Error('unknown existing result')
  if ([...reserved].some((id) => !caseIDs.includes(id))) throw new Error('unknown case reservation')
  if (!resume && (existing.size > 0 || reserved.size > 0)) throw new Error('existing results or reservations require explicit resume')
  return {
    run: caseIDs.filter((id) => !existing.has(id) && !reserved.has(id)),
    skipped: caseIDs.filter((id) => existing.has(id)),
    unresolvedReservations: caseIDs.filter((id) => reserved.has(id) && !existing.has(id)),
  }
}

export function limitRealAttempts(caseIDs, { smokeOnly = false } = {}) {
  if (!Array.isArray(caseIDs)) throw new Error('case plan must be an array')
  if (!smokeOnly) return { run: caseIDs.slice(), deferred: [] }
  if (caseIDs.length === 0) throw new Error('no pending smoke case')
  return { run: caseIDs.slice(0, 1), deferred: caseIDs.slice(1) }
}

export function isAuthorizedFatalRetrySource({ caseID, sourceRunID, reservationRecord, sourceResult } = {}) {
  if (caseID !== AUTHORIZED_RETRY_CASE_ID || sourceRunID !== AUTHORIZED_RETRY_SOURCE_RUN_ID) return { ok: false, reason: 'not-authorized-pair' }
  if (!reservationRecord) return { ok: false, reason: 'reservation-missing' }
  if (reservationRecord.caseID !== AUTHORIZED_RETRY_CASE_ID || reservationRecord.status !== 'reserved' || reservationRecord.runID !== AUTHORIZED_RETRY_SOURCE_RUN_ID) return { ok: false, reason: 'reservation-mismatch' }
  if (!sourceResult) return { ok: false, reason: 'result-missing' }
  if (sourceResult.caseID !== AUTHORIZED_RETRY_CASE_ID) return { ok: false, reason: 'result-case-mismatch' }
  if (sourceResult.fatal !== true) return { ok: false, reason: 'result-not-fatal' }
  const request = sourceResult.request ?? {}
  if (request.providerID !== REAL_MODEL.providerID || request.modelID !== REAL_MODEL.modelID || request.url !== REAL_URL) return { ok: false, reason: 'result-request-mismatch' }
  if (request.requestCount !== 1 || sourceResult.attemptCount !== 1) return { ok: false, reason: 'result-request-count' }
  if (typeof sourceResult.text !== 'string' || sourceResult.text !== '' || typeof sourceResult.apiText !== 'string' || sourceResult.apiText !== '') return { ok: false, reason: 'result-has-output' }
  const evidence = Array.isArray(sourceResult.hookEvidence) ? sourceResult.hookEvidence : []
  const requests = evidence.filter((event) => event.event === 'http-request-allowed')
  if (requests.length !== 1) return { ok: false, reason: 'result-request-count' }
  if (requests[0].authorizationPresent !== false) return { ok: false, reason: 'result-auth-present' }
  if (requests[0].toolCount !== 0) return { ok: false, reason: 'result-tools-present' }
  if (!evidence.some((event) => event.event === 'http-response' && event.status === 401)) return { ok: false, reason: 'result-not-401' }
  const veto = evidence.find((event) => event.event === 'retry-decision')
  if (!veto || veto.retry !== false) return { ok: false, reason: 'result-retry-not-vetoed' }
  const outcomeError = sourceResult.metadata?.assistantOutcome?.error ?? {}
  if (outcomeError.status !== 401) return { ok: false, reason: 'result-outcome-mismatch' }
  return { ok: true }
}

export function planAuthorizedRetry({ caseIDs, unresolvedReservations, retryCaseID } = {}) {
  if (retryCaseID !== AUTHORIZED_RETRY_CASE_ID) throw new Error('authorized retry is limited to F1-B005')
  if (!Array.isArray(unresolvedReservations) || unresolvedReservations.length !== 1 || unresolvedReservations[0] !== AUTHORIZED_RETRY_CASE_ID) throw new Error('authorized retry requires exactly the F1-B005 unresolved reservation')
  if (!Array.isArray(caseIDs) || !caseIDs.includes(AUTHORIZED_RETRY_CASE_ID)) throw new Error('authorized retry case is not in the manifest')
  return {
    run: [AUTHORIZED_RETRY_CASE_ID],
    deferred: caseIDs.filter((id) => id !== AUTHORIZED_RETRY_CASE_ID),
  }
}

export function planConsumedSmoke({ caseIDs, unresolvedReservations, consumedSmokeCaseID } = {}) {
  if (consumedSmokeCaseID !== AUTHORIZED_CONSUMED_SMOKE_CASE_ID) throw new Error('consumed smoke is limited to F1-B005')
  if (!Array.isArray(unresolvedReservations) || unresolvedReservations.length !== 1 || unresolvedReservations[0] !== AUTHORIZED_CONSUMED_SMOKE_CASE_ID) throw new Error('consumed smoke requires exactly the F1-B005 unresolved reservation')
  if (!Array.isArray(caseIDs) || !caseIDs.includes(AUTHORIZED_CONSUMED_SMOKE_CASE_ID)) throw new Error('consumed smoke case is not in the manifest')
  return {
    run: [AUTHORIZED_CONSUMED_SMOKE_CASE_ID],
    deferred: caseIDs.filter((id) => id !== AUTHORIZED_CONSUMED_SMOKE_CASE_ID),
  }
}

export function planFreshSmoke({ caseIDs, unresolvedReservations, freshSmokeCaseID } = {}) {
  if (freshSmokeCaseID !== AUTHORIZED_FRESH_SMOKE_CASE_ID) throw new Error('fresh smoke is limited to F1-B005')
  if (!Array.isArray(unresolvedReservations) || unresolvedReservations.length !== 1 || unresolvedReservations[0] !== AUTHORIZED_FRESH_SMOKE_CASE_ID) throw new Error('fresh smoke requires exactly the F1-B005 unresolved reservation')
  if (!Array.isArray(caseIDs) || !caseIDs.includes(AUTHORIZED_FRESH_SMOKE_CASE_ID)) throw new Error('fresh smoke case is not in the manifest')
  return {
    run: [AUTHORIZED_FRESH_SMOKE_CASE_ID],
    deferred: caseIDs.filter((id) => id !== AUTHORIZED_FRESH_SMOKE_CASE_ID),
  }
}

export function isAuthorizedFreshSmokeSource({ caseID, sourceMarker } = {}) {
  if (caseID !== AUTHORIZED_FRESH_SMOKE_CASE_ID || sourceMarker !== AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER) return { ok: false, reason: 'not-authorized-fresh-pair' }
  return { ok: true }
}

export function isBootstrapFreshChainAllowed({ caseID, reservationIDs = [], freshReservations = [], consumedReservations = [], retryReservations = [], remaining22Reservations = [], campaignClaims = [] } = {}) {
  if (caseID !== AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID) return { ok: false, reason: 'not-authorized-bootstrap-case' }
  if (reservationIDs.length > 0) return { ok: false, reason: 'bootstrap-single-use: slug already has case reservations' }
  if (freshReservations.length > 0) return { ok: false, reason: 'bootstrap-single-use: slug already has fresh smoke reservations' }
  if (consumedReservations.length > 0) return { ok: false, reason: 'bootstrap-single-use: slug already has consumed smoke reservations' }
  if (retryReservations.length > 0) return { ok: false, reason: 'bootstrap-single-use: slug already has authorized retry reservations' }
  if (remaining22Reservations.length > 0) return { ok: false, reason: 'bootstrap-single-use: slug already has remaining22 reservations' }
  if (campaignClaims.length > 0) return { ok: false, reason: 'bootstrap-single-use: slug already has remaining22 campaign claims' }
  return { ok: true }
}

export function applyConsumedSmokeTerminalPolicy(smokeOutcome) {
  return { ...smokeOutcome, continuationAllowed: false }
}

// Branch test/ted-f2b0-no-retry-controlled: controlled fresh-smoke retry.
// A new fresh smoke is allowed ONLY when every prior fresh attempt in this
// slug is a terminal FAIL/INCONCLUSIVE (SMOKE_FAILED_STOP /
// SMOKE_INCONCLUSIVE_STOP). A single PASS (casePassed===true or any
// SMOKE_PASS* status) is preserved forever. A missing/unreadable prior
// smoke-evaluation.json refuses fail-closed (no inference). Spend guard:
// at most MAX_FRESH_SMOKE_ATTEMPTS fresh attempts per slug without a new
// explicit decision; the 3rd attempt is refused even when priors are FAIL.
// F2-completar-8 (docs/decisions/2026-10-29-fechar-f2.md): operator authorizes
// a 3rd fresh smoke ONLY for the muse-spark slug
// (opencode-go-muse-spark-1.3-contributor) to complete the 8 missing cases
// of the stopped B3. Deepseek/legacy slug keeps the baseline ceiling of 2.
// The 4th attempt is refused even with FAILs; a PASS always preserves.
export const MAX_FRESH_SMOKE_ATTEMPTS = 2
export const MAX_FRESH_SMOKE_ATTEMPTS_MUSE_SPARK = 3
export const MUSE_SPARK_SLUG = 'opencode-go-muse-spark-1.3-contributor'
export const LEGACY_DEEPSEEK_SLUG = 'opencode-deepseek-v4.1-flash-free'
export function getMaxFreshSmokeAttempts(slug) {
  return slug === MUSE_SPARK_SLUG ? MAX_FRESH_SMOKE_ATTEMPTS_MUSE_SPARK : MAX_FRESH_SMOKE_ATTEMPTS
}
export const FRESH_SMOKE_RETRY_FAIL_STATUSES = Object.freeze(['SMOKE_FAILED_STOP', 'SMOKE_INCONCLUSIVE_STOP'])

export function isFreshSmokeEvaluationPass(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return false
  if (evaluation.casePassed === true) return true
  const status = evaluation.status
  return typeof status === 'string' && status.startsWith('SMOKE_PASS')
}

export function evaluateFreshSmokeRetry(priorEvaluations, slugOrOptions) {
  const maxAttempts = typeof slugOrOptions === 'number'
    ? slugOrOptions
    : typeof slugOrOptions === 'string'
      ? getMaxFreshSmokeAttempts(slugOrOptions)
      : slugOrOptions && typeof slugOrOptions === 'object' && typeof slugOrOptions.maxAttempts === 'number'
        ? slugOrOptions.maxAttempts
        : slugOrOptions && typeof slugOrOptions === 'object' && typeof slugOrOptions.slug === 'string'
          ? getMaxFreshSmokeAttempts(slugOrOptions.slug)
          : MAX_FRESH_SMOKE_ATTEMPTS
  if (!Array.isArray(priorEvaluations)) return { ok: false, reason: 'fresh-smoke-evaluations-invalid' }
  if (priorEvaluations.length >= maxAttempts) return { ok: false, reason: 'fresh-smoke-attempt-limit' }
  for (const evaluation of priorEvaluations) {
    if (!evaluation || typeof evaluation !== 'object') return { ok: false, reason: 'fresh-smoke-evaluation-missing' }
    if (isFreshSmokeEvaluationPass(evaluation)) return { ok: false, reason: 'fresh-smoke-pass-preserved' }
  }
  for (const evaluation of priorEvaluations) {
    if (!FRESH_SMOKE_RETRY_FAIL_STATUSES.includes(evaluation.status)) return { ok: false, reason: 'fresh-smoke-status-not-retryable' }
  }
  return { ok: true }
}

export function isAuthorizedConsumedSingleSmokeSource({ caseID, runID, reservationRecord, sourceResult } = {}) {
  if (caseID !== AUTHORIZED_CONSUMED_SMOKE_CASE_ID || runID !== AUTHORIZED_CONSUMED_SMOKE_RUN_ID) return { ok: false, reason: 'not-authorized-consumed-pair' }
  if (!reservationRecord) return { ok: false, reason: 'reservation-missing' }
  if (reservationRecord.caseID !== AUTHORIZED_CONSUMED_SMOKE_CASE_ID) return { ok: false, reason: 'reservation-case-mismatch' }
  if (reservationRecord.authorizedRetry !== true) return { ok: false, reason: 'reservation-not-authorized-retry' }
  if (reservationRecord.runID !== AUTHORIZED_CONSUMED_SMOKE_RUN_ID) return { ok: false, reason: 'reservation-run-mismatch' }
  if (reservationRecord.sourceRunID !== AUTHORIZED_RETRY_SOURCE_RUN_ID) return { ok: false, reason: 'reservation-source-mismatch' }
  if (reservationRecord.status !== 'reserved') return { ok: false, reason: 'reservation-status-mismatch' }
  if (!sourceResult) return { ok: false, reason: 'result-missing' }
  if (sourceResult.caseID !== AUTHORIZED_CONSUMED_SMOKE_CASE_ID) return { ok: false, reason: 'result-case-mismatch' }
  if (sourceResult.fatal !== true) return { ok: false, reason: 'result-not-fatal' }
  if (typeof sourceResult.reservation !== 'string'
    || normalizeReservationSeparators(sourceResult.reservation) !== AUTHORIZED_CONSUMED_SMOKE_RESERVATION_PATH) return { ok: false, reason: 'result-reservation-mismatch' }
  if (sourceResult.attemptCount !== 1) return { ok: false, reason: 'result-attempt-count' }
  const request = sourceResult.request ?? {}
  if (request.providerID !== REAL_MODEL.providerID || request.modelID !== REAL_MODEL.modelID || request.url !== REAL_URL) return { ok: false, reason: 'result-request-mismatch' }
  if (request.requestCount !== 1) return { ok: false, reason: 'result-request-count' }
  if (typeof sourceResult.text !== 'string' || sourceResult.text.length === 0) return { ok: false, reason: 'result-empty-output' }
  if (typeof sourceResult.apiText !== 'string' || sourceResult.apiText.length === 0) return { ok: false, reason: 'result-empty-apitext' }
  if (sourceResult.apiTextMatchesStdout !== true) return { ok: false, reason: 'result-stdout-mismatch' }
  const outcome = sourceResult.metadata?.assistantOutcome ?? {}
  if (outcome.terminal !== false) return { ok: false, reason: 'result-outcome-not-nonterminal' }
  const evidence = Array.isArray(sourceResult.hookEvidence) ? sourceResult.hookEvidence : []
  const requests = evidence.filter((event) => event.event === 'http-request-allowed')
  if (requests.length !== 1) return { ok: false, reason: 'result-request-count' }
  const single = requests[0]
  if (single.authorizationPresent !== true) return { ok: false, reason: 'result-auth-absent' }
  if (single.toolCount !== 0) return { ok: false, reason: 'result-tools-present' }
  if (single.kind !== 'primary') return { ok: false, reason: 'result-kind-mismatch' }
  if ('provider' in single && single.provider !== REAL_MODEL.providerID) return { ok: false, reason: 'result-request-mismatch' }
  if ('model' in single && single.model !== REAL_MODEL.modelID) return { ok: false, reason: 'result-request-mismatch' }
  const responses = evidence.filter((event) => event.event === 'http-response')
  if (responses.length !== 1) return { ok: false, reason: 'result-response-count' }
  if (responses[0].status !== 200) return { ok: false, reason: 'result-not-200' }
  if (evidence.some((event) => event.event === 'retry-decision' && event.retry === true)) return { ok: false, reason: 'result-retried' }
  const stop = sourceResult.stop ?? {}
  if (stop.category !== 'stdin-prompt-not-confirmed') return { ok: false, reason: 'result-stop-mismatch' }
  if (sourceResult.metadata?.stdinPromptObserved !== false) return { ok: false, reason: 'result-stdin-unexpected' }
  return { ok: true }
}

export function planRemaining22({ caseIDs, sourceRunID } = {}) {
  if (sourceRunID !== undefined && !isAuthorizedRemaining22SourceRunID(sourceRunID)) throw new Error(`remaining22 campaign is limited to source allowlist [${AUTHORIZED_REMAINING22_SOURCE_RUN_IDS.join(',')}]`)
  if (!Array.isArray(caseIDs) || caseIDs.length !== MAX_CASES) throw new Error('remaining22 campaign requires the complete 23-case manifest')
  if (new Set(caseIDs).size !== MAX_CASES) throw new Error('remaining22 campaign manifest has duplicate case ID')
  if (!caseIDs.includes(REMAINING22_EXCLUDED_CASE_ID)) throw new Error('remaining22 campaign manifest misses the excluded historic smoke case')
  const run = caseIDs.filter((id) => id !== REMAINING22_EXCLUDED_CASE_ID)
  if (run.length !== REMAINING22_EXPECTED_COUNT) throw new Error('remaining22 campaign run must contain exactly 22 cases')
  if (run.includes(REMAINING22_EXCLUDED_CASE_ID)) throw new Error('remaining22 campaign must never re-execute the historic smoke case')
  if (new Set(run).size !== REMAINING22_EXPECTED_COUNT) throw new Error('remaining22 campaign run has duplicate case ID')
  return {
    run,
    deferred: [REMAINING22_EXCLUDED_CASE_ID],
  }
}

// F2-B4-via-S4 (docs/decisions/2026-10-29-fechar-f2.md): one controlled
// second claim per source, ONLY when the first claim references a
// stopped-incomplete run (stopped-summary.json present, evaluation.json
// absent). Complete campaigns never release a second claim; a third claim
// (even with two stops) always refuses and requires a new decision. Full
// 22-case campaign only — no partial/resume path.
export function isStoppedIncompleteRun({ hasStoppedSummary, hasEvaluation } = {}) {
  return hasStoppedSummary === true && hasEvaluation === false
}

export function evaluateRemaining22Supersede({ sourceRunID, baseClaimCount = 0, supersedeClaimCount = 0, priorIsStoppedIncomplete = false } = {}) {
  if (!isAuthorizedRemaining22SourceRunID(sourceRunID)) return { ok: false, reason: 'not-authorized-source-run' }
  if (baseClaimCount === 0) return { ok: false, reason: 'no-prior-claim' }
  if (baseClaimCount > 1) return { ok: false, reason: 'multiple-base-claims-unexpected' }
  if (supersedeClaimCount > 0) return { ok: false, reason: 'supersede-already-consumed' }
  if (priorIsStoppedIncomplete !== true) return { ok: false, reason: 'prior-campaign-complete' }
  return { ok: true }
}

export function isAuthorizedRemaining22Source({ sourceRunID, manifest, smokeEvaluation, caseResult, catalogPreflight, hookEvents, reservationRecord, canonical } = {}) {
  if (!isAuthorizedRemaining22SourceRunID(sourceRunID)) return { ok: false, reason: 'not-authorized-source-run' }
  if (!canonical || !Array.isArray(canonical.caseIDs) || canonical.caseIDs.length !== MAX_CASES || !Array.isArray(canonical.prompts) || canonical.prompts.length !== MAX_CASES) return { ok: false, reason: 'canonical-missing' }
  const canonicalCampaign = canonical.caseIDs.filter((id) => id !== REMAINING22_EXCLUDED_CASE_ID)
  if (canonicalCampaign.length !== REMAINING22_EXPECTED_COUNT) return { ok: false, reason: 'canonical-campaign-mismatch' }
  if (!manifest) return { ok: false, reason: 'manifest-missing' }
  if (manifest.runID !== sourceRunID) return { ok: false, reason: 'manifest-run-mismatch' }
  if (manifest.provider !== REAL_MODEL.providerID || manifest.model !== REAL_MODEL.modelID) return { ok: false, reason: 'manifest-model-mismatch' }
  if (manifest.nativeURL !== REAL_URL && manifest.nativeURL !== undefined) {
    if (manifest.nativeURL !== REAL_URL) return { ok: false, reason: 'manifest-url-mismatch' }
  }
  if (!Array.isArray(manifest.caseIDs) || manifest.caseIDs.length !== MAX_CASES || new Set(manifest.caseIDs).size !== MAX_CASES) return { ok: false, reason: 'manifest-cases-mismatch' }
  if (JSON.stringify(manifest.caseIDs) !== JSON.stringify(canonical.caseIDs)) return { ok: false, reason: 'manifest-canonical-order-mismatch' }
  if (!manifest.caseIDs.includes(REMAINING22_EXCLUDED_CASE_ID)) return { ok: false, reason: 'manifest-misses-smoke-case' }
  if (!Array.isArray(manifest.prompts) || manifest.prompts.length !== MAX_CASES) return { ok: false, reason: 'manifest-prompts-mismatch' }
  for (let index = 0; index < canonical.prompts.length; index += 1) {
    const expected = canonical.prompts[index]
    const actual = manifest.prompts[index]
    if (!actual || actual.id !== expected.id) return { ok: false, reason: 'manifest-canonical-prompt-order-mismatch' }
    if (actual.prompt !== expected.prompt) return { ok: false, reason: 'manifest-canonical-prompt-mismatch' }
    if (stableStringify(actual.input) !== stableStringify(expected.input)) return { ok: false, reason: 'manifest-canonical-input-mismatch' }
  }
  const smokePrompt = manifest.prompts.find((entry) => entry?.id === REMAINING22_EXCLUDED_CASE_ID)
  if (!smokePrompt || typeof smokePrompt.prompt !== 'string' || !smokePrompt.prompt.includes('Manifest case ID: F1-B005')) return { ok: false, reason: 'manifest-prompt-mismatch' }
  if (!smokePrompt.input || smokePrompt.input.caseId !== REMAINING22_EXCLUDED_CASE_ID) return { ok: false, reason: 'manifest-input-mismatch' }
  if (!smokeEvaluation) return { ok: false, reason: 'smoke-evaluation-missing' }
  if (smokeEvaluation.schemaVersion !== 'f2b0-go-single-smoke-v1') return { ok: false, reason: 'smoke-schema-mismatch' }
  if (smokeEvaluation.status !== 'SMOKE_PASS_OPERATOR_ATTESTED_NO_CONTINUATION') return { ok: false, reason: 'smoke-status-mismatch' }
  if (smokeEvaluation.runID !== sourceRunID) return { ok: false, reason: 'smoke-run-mismatch' }
  if (smokeEvaluation.caseID !== REMAINING22_EXCLUDED_CASE_ID) return { ok: false, reason: 'smoke-case-mismatch' }
  if (smokeEvaluation.providerID !== REAL_MODEL.providerID || smokeEvaluation.modelID !== REAL_MODEL.modelID) return { ok: false, reason: 'smoke-model-mismatch' }
  if (smokeEvaluation.endpoint !== REAL_URL) return { ok: false, reason: 'smoke-endpoint-mismatch' }
  if (smokeEvaluation.physicalRequests !== 1 || smokeEvaluation.noRetry !== true) return { ok: false, reason: 'smoke-request-mismatch' }
  if (smokeEvaluation.stdinPromptObserved !== true) return { ok: false, reason: 'smoke-stdin-mismatch' }
  if (smokeEvaluation.jsonValid !== true || smokeEvaluation.schemaValid !== true) return { ok: false, reason: 'smoke-json-schema-mismatch' }
  if (smokeEvaluation.semanticVerdict !== 'PASS') return { ok: false, reason: 'smoke-oracle-mismatch' }
  if (smokeEvaluation.continuationAllowed !== false) return { ok: false, reason: 'smoke-continuation-mismatch' }
  if (smokeEvaluation.extraUsageStatus !== 'operator-attested-disabled') return { ok: false, reason: 'smoke-extra-usage-mismatch' }
  if (!smokeEvaluation.costObserved || smokeEvaluation.costUSD?.api?.value !== 0 || smokeEvaluation.costUSD?.api?.observed !== true) return { ok: false, reason: 'smoke-cost-mismatch' }
  if (!Array.isArray(smokeEvaluation.remainingCaseIDs) || smokeEvaluation.remainingCaseIDs.length !== REMAINING22_EXPECTED_COUNT) return { ok: false, reason: 'smoke-remaining-mismatch' }
  if (JSON.stringify(smokeEvaluation.remainingCaseIDs) !== JSON.stringify(canonicalCampaign)) return { ok: false, reason: 'smoke-remaining-order-mismatch' }
  if (smokeEvaluation.remainingCaseIDs.includes(REMAINING22_EXCLUDED_CASE_ID)) return { ok: false, reason: 'smoke-remaining-includes-excluded' }
  if (typeof smokeEvaluation.responseText !== 'string' || smokeEvaluation.responseText.length === 0) return { ok: false, reason: 'smoke-response-missing' }
  const goBefore = smokeEvaluation.goUsageBefore ?? null
  const goAfter = smokeEvaluation.goUsageAfter ?? null
  for (const snapshot of [goBefore, goAfter]) {
    if (!snapshot || snapshot.source !== 'operator-attestation' || snapshot.status !== 'go-usage-unavailable') return { ok: false, reason: 'smoke-quota-attestation-mismatch' }
  }
  if (!caseResult) return { ok: false, reason: 'result-missing' }
  if (caseResult.caseID !== REMAINING22_EXCLUDED_CASE_ID) return { ok: false, reason: 'result-case-mismatch' }
  if (caseResult.fatal !== false) return { ok: false, reason: 'result-not-completed' }
  if (caseResult.attemptCount !== 1) return { ok: false, reason: 'result-attempt-count' }
  const request = caseResult.request ?? {}
  if (request.providerID !== REAL_MODEL.providerID || request.modelID !== REAL_MODEL.modelID || request.url !== REAL_URL) return { ok: false, reason: 'result-request-mismatch' }
  if (request.requestCount !== 1) return { ok: false, reason: 'result-request-count' }
  if (typeof caseResult.text !== 'string' || caseResult.text.length === 0) return { ok: false, reason: 'result-empty-output' }
  if (typeof caseResult.apiText !== 'string' || caseResult.apiText.length === 0) return { ok: false, reason: 'result-empty-apitext' }
  if (caseResult.apiText !== caseResult.text || caseResult.apiTextMatchesStdout !== true) return { ok: false, reason: 'result-stdout-mismatch' }
  if (caseResult.text !== smokeEvaluation.responseText) return { ok: false, reason: 'result-smoke-text-mismatch' }
  if (caseResult.assistantTextValid !== true) return { ok: false, reason: 'result-assistant-text-invalid' }
  let parsed = null
  try { parsed = JSON.parse(caseResult.text) } catch { return { ok: false, reason: 'result-json-invalid' } }
  const interpretation = parsed?.interpretation
  if (!interpretation || typeof interpretation !== 'object') return { ok: false, reason: 'result-schema-mismatch' }
  if (interpretation.operation !== 'list_payables' || interpretation.intent !== 'read') return { ok: false, reason: 'result-oracle-mismatch' }
  if (interpretation?.contextProvenance?.corpusId !== REMAINING22_EXCLUDED_CASE_ID) return { ok: false, reason: 'result-provenance-mismatch' }
  const stop = caseResult.stop ?? {}
  if (stop.stop !== false) return { ok: false, reason: 'result-stop-mismatch' }
  if (caseResult.metadata?.stdinPromptObserved !== true) return { ok: false, reason: 'result-stdin-mismatch' }
  if (caseResult.metadata?.assistantOutcome?.terminal !== false) return { ok: false, reason: 'result-outcome-mismatch' }
  const apiCost = caseResult.metadata?.apiCostByCase
  if (!apiCost || apiCost.observed !== true || apiCost.value !== 0) return { ok: false, reason: 'result-cost-mismatch' }
  const evidence = Array.isArray(caseResult.hookEvidence) ? caseResult.hookEvidence : []
  const requests = evidence.filter((event) => event.event === 'http-request-allowed')
  if (requests.length !== 1) return { ok: false, reason: 'result-hook-request-count' }
  const single = requests[0]
  if (single.authorizationPresent !== true) return { ok: false, reason: 'result-auth-absent' }
  if (single.toolCount !== 0) return { ok: false, reason: 'result-tools-present' }
  if (single.kind !== 'primary') return { ok: false, reason: 'result-kind-mismatch' }
  if (single.provider !== REAL_MODEL.providerID || single.model !== REAL_MODEL.modelID) return { ok: false, reason: 'result-hook-model-mismatch' }
  if (single.method !== 'POST' || single.redirect !== 'error') return { ok: false, reason: 'result-hook-transport-mismatch' }
  if (single.url !== REAL_URL) return { ok: false, reason: 'result-hook-url-mismatch' }
  const responses = evidence.filter((event) => event.event === 'http-response')
  if (responses.length !== 1 || responses[0].status !== 200) return { ok: false, reason: 'result-response-mismatch' }
  if (evidence.some((event) => event.event === 'retry-decision' && event.retry === true)) return { ok: false, reason: 'result-retried' }
  const smokeManifestEntry = manifest.prompts.find((entry) => entry?.id === REMAINING22_EXCLUDED_CASE_ID)
  const canonicalSmokeEntry = canonical.prompts.find((entry) => entry?.id === REMAINING22_EXCLUDED_CASE_ID)
  if (!smokeManifestEntry || !canonicalSmokeEntry) return { ok: false, reason: 'smoke-entry-missing' }
  if (typeof caseResult.prompt !== 'string' || caseResult.prompt !== smokeManifestEntry.prompt) return { ok: false, reason: 'result-manifest-prompt-mismatch' }
  if (stableStringify(caseResult.input) !== stableStringify(smokeManifestEntry.input)) return { ok: false, reason: 'result-manifest-input-mismatch' }
  if (caseResult.prompt !== canonicalSmokeEntry.prompt) return { ok: false, reason: 'result-canonical-prompt-mismatch' }
  if (stableStringify(caseResult.input) !== stableStringify(canonicalSmokeEntry.input)) return { ok: false, reason: 'result-canonical-input-mismatch' }
  if (!reservationRecord) return { ok: false, reason: 'reservation-missing' }
  if (reservationRecord.caseID !== REMAINING22_EXCLUDED_CASE_ID || reservationRecord.status !== 'reserved') return { ok: false, reason: 'reservation-mismatch' }
  if (reservationRecord.runID !== sourceRunID) return { ok: false, reason: 'reservation-run-mismatch' }
  if (sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID) {
    if (reservationRecord.consumedSmoke !== true) return { ok: false, reason: 'reservation-not-consumed-smoke' }
    if (reservationRecord.sourceRunID !== AUTHORIZED_CONSUMED_SMOKE_RUN_ID) return { ok: false, reason: 'reservation-source-mismatch' }
  } else if (sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2 || sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID_3) {
    if (reservationRecord.freshSmoke !== true) return { ok: false, reason: 'reservation-not-fresh-smoke' }
    if (reservationRecord.sourceMarker !== AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER) return { ok: false, reason: 'reservation-source-mismatch' }
  } else return { ok: false, reason: 'not-authorized-source-run' }
  if (typeof reservationRecord.runNonce !== 'string' || reservationRecord.runNonce.length < 8) return { ok: false, reason: 'reservation-nonce-mismatch' }
  const expectedReservationPath = sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2 ? AUTHORIZED_REMAINING22_S2_RESERVATION_PATH : sourceRunID === AUTHORIZED_REMAINING22_SOURCE_RUN_ID_3 ? AUTHORIZED_REMAINING22_S4_RESERVATION_PATH : AUTHORIZED_REMAINING22_RESERVATION_PATH
  if (typeof caseResult.reservation !== 'string' || normalizeReservationSeparators(caseResult.reservation) !== expectedReservationPath) return { ok: false, reason: 'result-reservation-mismatch' }
  if (!catalogPreflight) return { ok: false, reason: 'catalog-missing' }
  if (catalogPreflight.catalog?.providerID !== REAL_MODEL.providerID || catalogPreflight.catalog?.modelID !== REAL_MODEL.modelID) return { ok: false, reason: 'catalog-model-mismatch' }
  if (catalogPreflight.catalog?.catalogPriceAllowed !== true) return { ok: false, reason: 'catalog-price-mismatch' }
  if (catalogPreflight.extraUsageStatus !== 'operator-attested-disabled') return { ok: false, reason: 'catalog-extra-usage-mismatch' }
  if (!hookEvents) return { ok: false, reason: 'hook-missing' }
  const hooks = Array.isArray(hookEvents) ? hookEvents : []
  if (hooks.some((event) => event.event === 'guard-failed')) return { ok: false, reason: 'hook-guard-failed' }
  const hookRequests = hooks.filter((event) => event.event === 'http-request-allowed')
  const hookResponses = hooks.filter((event) => event.event === 'http-response')
  if (hookRequests.length !== 1 || hookResponses.length !== 1) return { ok: false, reason: 'hook-request-count' }
  if (hookResponses[0].status !== 200) return { ok: false, reason: 'hook-response-mismatch' }
  if (hooks.some((event) => event.event === 'retry-decision' && event.retry === true)) return { ok: false, reason: 'hook-retried' }
  const hookRequest = hookRequests[0]
  if (hookRequest.provider !== REAL_MODEL.providerID || hookRequest.model !== REAL_MODEL.modelID) return { ok: false, reason: 'hook-model-mismatch' }
  if (hookRequest.kind !== 'primary' || hookRequest.method !== 'POST' || hookRequest.redirect !== 'error') return { ok: false, reason: 'hook-transport-mismatch' }
  if (hookRequest.url !== REAL_URL) return { ok: false, reason: 'hook-url-mismatch' }
  if (hookRequest.authorizationPresent !== true || hookRequest.toolCount !== 0) return { ok: false, reason: 'hook-auth-tools-mismatch' }
  const hookNonces = new Set(hooks.filter((event) => typeof event.runNonce === 'string').map((event) => event.runNonce))
  if (hookNonces.size !== 1 || !hookNonces.has(reservationRecord.runNonce)) return { ok: false, reason: 'hook-nonce-mismatch' }
  const evidenceNonces = new Set(evidence.filter((event) => typeof event.runNonce === 'string').map((event) => event.runNonce))
  if (evidenceNonces.size !== 1 || !evidenceNonces.has(reservationRecord.runNonce)) return { ok: false, reason: 'hook-evidence-nonce-mismatch' }
  const hookSessions = new Set([...hooks.filter((event) => typeof event.sessionKey === 'string').map((event) => event.sessionKey), ...evidence.filter((event) => typeof event.sessionKey === 'string').map((event) => event.sessionKey)])
  if (hookSessions.size !== 1) return { ok: false, reason: 'hook-session-mismatch' }
  const [[hookSession]] = [[...hookSessions]]
  if (typeof hookSession !== 'string' || hookSession.length === 0) return { ok: false, reason: 'hook-session-mismatch' }
  if (single.sessionKey !== hookSession || responses[0].sessionKey !== hookSession || hookRequest.sessionKey !== hookSession || hookResponses[0].sessionKey !== hookSession) return { ok: false, reason: 'hook-session-case-mismatch' }
  if (typeof single.bodySha256 !== 'string' || single.bodySha256.length < 16) return { ok: false, reason: 'hook-body-sha-missing' }
  if (typeof hookRequest.bodySha256 !== 'string' || hookRequest.bodySha256.length < 16) return { ok: false, reason: 'hook-body-sha-missing' }
  if (single.bodySha256 !== hookRequest.bodySha256) return { ok: false, reason: 'hook-body-mismatch' }
  if (single.bodyModel !== REAL_MODEL.modelID) return { ok: false, reason: 'hook-body-model-mismatch' }
  if (hookRequest.bodyModel !== REAL_MODEL.modelID) return { ok: false, reason: 'hook-body-model-mismatch' }
  if (typeof single.toolCount !== 'number' || typeof hookRequest.toolCount !== 'number') return { ok: false, reason: 'hook-toolcount-missing' }
  if (typeof caseResult.metadata?.requestBodySha256 !== 'string' || caseResult.metadata.requestBodySha256.length < 16) return { ok: false, reason: 'hook-metadata-hash-missing' }
  if (caseResult.metadata.requestBodySha256 !== hookRequest.bodySha256) return { ok: false, reason: 'hook-body-case-mismatch' }
  if (caseResult.metadata?.requestBodyModel !== REAL_MODEL.modelID) return { ok: false, reason: 'hook-metadata-model-mismatch' }
  if (caseResult.metadata.requestBodyModel !== hookRequest.bodyModel) return { ok: false, reason: 'hook-body-model-mismatch' }
  if (typeof caseResult.metadata?.toolCount !== 'number') return { ok: false, reason: 'hook-metadata-count-missing' }
  if (caseResult.metadata.toolCount !== hookRequest.toolCount) return { ok: false, reason: 'hook-toolcount-mismatch' }
  if (typeof caseResult.text === 'string' && typeof smokeEvaluation.responseText === 'string' && caseResult.text !== smokeEvaluation.responseText) return { ok: false, reason: 'hook-response-text-mismatch' }
  return { ok: true }
}

export function buildRemaining22Attestation({ runID, sourceRunID, caseIDs, completedCaseIDs, expectedCampaignCaseIDs, expectedCaseIDs, quotaSource = 'operator-attestation', extraUsageStatus = 'operator-attested-disabled' } = {}) {
  if (!isAuthorizedRemaining22SourceRunID(sourceRunID)) throw new Error(`remaining22 attestation is limited to source allowlist [${AUTHORIZED_REMAINING22_SOURCE_RUN_IDS.join(',')}]`)
  if (!Array.isArray(caseIDs) || caseIDs.length !== MAX_CASES) throw new Error('remaining22 attestation requires the complete 23-case manifest')
  if (!Array.isArray(expectedCaseIDs) || JSON.stringify(caseIDs) !== JSON.stringify(expectedCaseIDs)) throw new Error('remaining22 attestation requires the complete canonical 23-case manifest in order')
  if (!Array.isArray(expectedCampaignCaseIDs) || expectedCampaignCaseIDs.length !== REMAINING22_EXPECTED_COUNT) throw new Error('remaining22 attestation requires the 22 canonical campaign IDs in order')
  if (!Array.isArray(completedCaseIDs) || completedCaseIDs.length !== REMAINING22_EXPECTED_COUNT) throw new Error('remaining22 attestation requires exactly 22 completed campaign cases')
  if (JSON.stringify(completedCaseIDs) !== JSON.stringify(expectedCampaignCaseIDs)) throw new Error('remaining22 attestation requires exactly the 22 canonical campaign IDs in order')
  if (completedCaseIDs.includes(REMAINING22_EXCLUDED_CASE_ID)) throw new Error('remaining22 attestation must never include the historic smoke case as a campaign result')
  if (new Set(completedCaseIDs).size !== REMAINING22_EXPECTED_COUNT) throw new Error('remaining22 attestation has duplicate campaign case ID')
  if (quotaSource !== 'operator-attestation') throw new Error('remaining22 attestation records operator attestation only; automatic quota readback is unavailable')
  if (extraUsageStatus !== 'operator-attested-disabled') throw new Error('remaining22 attestation requires operator-attested Extra Usage disabled')
  return Object.freeze({
    schemaVersion: 'f2b0-remaining22-attestation-v1',
    runID,
    sourceRunID,
    campaign: 'remaining22',
    excludedHistoricCaseID: REMAINING22_EXCLUDED_CASE_ID,
    campaignCaseCount: REMAINING22_EXPECTED_COUNT,
    campaignCaseIDs: Object.freeze([...completedCaseIDs]),
    quota: Object.freeze({ source: quotaSource, readback: 'unavailable', note: 'Quota availability was operator-attested before the campaign; no automatic Go usage readback was observed.' }),
    extraUsage: Object.freeze({ status: extraUsageStatus, note: 'Extra Usage disabled was operator-attested; no automatic verification was performed.' }),
    billingNote: 'No usage-cost or billing amount was independently confirmed; an API-reported cost of 0 is not evidence of a billed amount.',
    serial: true,
    b1Included: false,
    retryIncluded: false,
    fallbackIncluded: false,
  })
}

export function resolveRealExecutionPlan({ caseIDs, existingIDs = [], reservedIDs = [], options = {} } = {}) {
  const retryCaseID = options.retryCaseID
  const retryRunID = options.retryRunID
  const consumedSmokeCaseID = options.consumedSmokeCaseID
  const consumedSmokeRunID = options.consumedSmokeRunID
  const freshSmokeCaseID = options.freshSmokeCaseID
  const freshSmokeRunID = options.freshSmokeRunID
  const remaining22RunID = options.remaining22RunID
  const resumeID = options.resumeID
  const smokeOnly = options.smokeOnly === true
  if (remaining22RunID !== undefined && ((retryCaseID !== undefined || retryRunID !== undefined) || (consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined))) throw new Error('remaining22 campaign is incompatible with authorized retry flags')
  if (remaining22RunID !== undefined && ((consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined))) throw new Error('remaining22 campaign is incompatible with consumed smoke flags')
  if (remaining22RunID !== undefined && (freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined)) throw new Error('remaining22 campaign is incompatible with fresh smoke flags')
  if ((retryCaseID !== undefined || retryRunID !== undefined) && (consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined)) throw new Error('consumed smoke authorization is incompatible with authorized retry flags')
  if ((retryCaseID !== undefined || retryRunID !== undefined) && (freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined)) throw new Error('fresh smoke authorization is incompatible with authorized retry flags')
  if ((consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined) && (freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined)) throw new Error('fresh smoke authorization is incompatible with consumed smoke authorization flags')
  if (retryCaseID !== undefined || retryRunID !== undefined) {
    if (retryCaseID !== AUTHORIZED_RETRY_CASE_ID || retryRunID !== AUTHORIZED_RETRY_SOURCE_RUN_ID) throw new Error(`authorized retry is limited to F1-B005 from ${AUTHORIZED_RETRY_SOURCE_RUN_ID}`)
    if (!smokeOnly) throw new Error('authorized retry requires --smoke-only')
    if (resumeID) throw new Error('authorized retry cannot be combined with preflight, self-test, resume, or export')
    const plan = planAttempts(caseIDs, existingIDs, { resume: true, reservedIDs })
    if (Array.isArray(existingIDs) && existingIDs.includes(AUTHORIZED_RETRY_CASE_ID)) throw new Error('authorized retry already has a durable result in this run; refusing second attempt')
    const executionPlan = planAuthorizedRetry({ caseIDs, unresolvedReservations: plan.unresolvedReservations, retryCaseID })
    return { plan, executionPlan, authorized: true }
  }
  if (consumedSmokeCaseID !== undefined || consumedSmokeRunID !== undefined) {
    if (consumedSmokeCaseID !== AUTHORIZED_CONSUMED_SMOKE_CASE_ID || consumedSmokeRunID !== AUTHORIZED_CONSUMED_SMOKE_RUN_ID) throw new Error(`consumed smoke is limited to F1-B005 from ${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}`)
    if (!smokeOnly) throw new Error('consumed smoke requires --smoke-only')
    if (resumeID) throw new Error('consumed smoke cannot be combined with preflight, self-test, resume, or export')
    const plan = planAttempts(caseIDs, existingIDs, { resume: true, reservedIDs })
    if (Array.isArray(existingIDs) && existingIDs.includes(AUTHORIZED_CONSUMED_SMOKE_CASE_ID)) throw new Error('consumed smoke already has a durable result in this run; refusing second attempt')
    const executionPlan = planConsumedSmoke({ caseIDs, unresolvedReservations: plan.unresolvedReservations, consumedSmokeCaseID })
    return { plan, executionPlan, authorized: true }
  }
  if (freshSmokeCaseID !== undefined || freshSmokeRunID !== undefined) {
    if (freshSmokeCaseID !== AUTHORIZED_FRESH_SMOKE_CASE_ID || freshSmokeRunID !== AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER) throw new Error(`fresh smoke is limited to F1-B005 from ${AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER}`)
    if (!smokeOnly) throw new Error('fresh smoke requires --smoke-only')
    if (resumeID) throw new Error('fresh smoke cannot be combined with preflight, self-test, resume, or export')
    const plan = planAttempts(caseIDs, existingIDs, { resume: true, reservedIDs })
    if (Array.isArray(existingIDs) && existingIDs.includes(AUTHORIZED_FRESH_SMOKE_CASE_ID)) throw new Error('fresh smoke already has a durable result in this run; refusing second attempt')
    const freshCheck = isAuthorizedFreshSmokeSource({ caseID: freshSmokeCaseID, sourceMarker: freshSmokeRunID })
    if (!freshCheck.ok) throw new Error(`fresh smoke refused: ${freshCheck.reason}`)
    const executionPlan = planFreshSmoke({ caseIDs, unresolvedReservations: plan.unresolvedReservations, freshSmokeCaseID })
    return { plan, executionPlan, authorized: true }
  }
  if (remaining22RunID !== undefined) {
    if (!isAuthorizedRemaining22SourceRunID(remaining22RunID)) throw new Error(`remaining22 campaign is limited to source allowlist [${AUTHORIZED_REMAINING22_SOURCE_RUN_IDS.join(',')}]`)
    if (smokeOnly) throw new Error('remaining22 campaign cannot be combined with --smoke-only')
    if (resumeID) throw new Error('remaining22 campaign cannot be combined with preflight, self-test, resume, or export')
    const plan = planAttempts(caseIDs, existingIDs, { resume: true, reservedIDs })
    if (Array.isArray(existingIDs) && existingIDs.length > 0) throw new Error('remaining22 campaign requires an empty run directory; refusing reuse of existing results')
    const nonHistoricUnresolved = plan.unresolvedReservations.filter((id) => id !== REMAINING22_EXCLUDED_CASE_ID)
    if (nonHistoricUnresolved.length > 0) throw new Error(`remaining22 campaign refuses unresolved reservations for campaign cases: ${nonHistoricUnresolved.join(',')}`)
    const executionPlan = planRemaining22({ caseIDs, sourceRunID: remaining22RunID })
    return { plan, executionPlan, authorized: true, campaign: 'remaining22' }
  }
  const plan = planAttempts(caseIDs, existingIDs, { resume: Boolean(resumeID), reservedIDs })
  const executionPlan = limitRealAttempts(plan.run, { smokeOnly })
  if (plan.unresolvedReservations.length > 0) throw new Error(`reserved case has no durable result; refusing replay: ${plan.unresolvedReservations.join(',')}`)
  return { plan, executionPlan, authorized: false }
}

export function isApprovedInfrastructureEndedCase(runID, result) {
  if (!APPROVED_INFRA_ENDINGS.get(runID)?.has(result?.caseID)) return false
  if (result.status !== 'infrastructure-ended-zero-attempt' || result.fatal !== false || result.attemptCount !== 0) return false
  if (result.providerID !== LEGACY_FREE_MODEL.providerID || result.modelID !== LEGACY_FREE_MODEL.modelID) return false
  return Array.isArray(result.reviewAudit) && result.reviewAudit.some((entry) => entry.action === 'approved-nonfatal-infrastructure-ended-zero-attempt' && entry.approvedBy === 'Reviewer')
}

export function summarizeRealRunMetrics(evaluationResult, caseResults, denominator = MAX_CASES) {
  const infrastructureEnded = caseResults.filter((result) => result.status === 'infrastructure-ended-zero-attempt' && result.attemptCount === 0)
  const actual = caseResults.filter((result) => !infrastructureEnded.includes(result))
  const attemptsAreObserved = actual.every((result) => Number.isInteger(result.attemptCount) && result.attemptCount >= 0)
  const actualAttemptCount = attemptsAreObserved ? actual.reduce((total, result) => total + result.attemptCount, 0) : null
  const validity = Object.values(evaluationResult.results)
  const aggregateUsage = (source) => Object.fromEntries(['input', 'output', 'total', 'reasoning', 'cacheRead', 'cacheWrite'].map((field) => [
    field,
    aggregateObservedMetric(actual.map((result) => result.metadata?.[source]?.[field] ?? { value: null, observed: false })),
  ]))
  return {
    actualAttemptCount,
    actualAttemptCountObserved: attemptsAreObserved,
    denominator,
    infrastructureEndedCaseIDs: infrastructureEnded.map((result) => result.caseID),
    semantic: evaluationResult.evaluation,
    jsonValidity: {
      valid: validity.filter((result) => result.jsonValid).length,
      invalid: validity.filter((result) => !result.jsonValid).length,
      notAttempted: evaluationResult.missingIds.length,
    },
    schemaValidity: {
      valid: validity.filter((result) => result.schemaValid).length,
      invalid: validity.filter((result) => !result.schemaValid).length,
      notAttempted: evaluationResult.missingIds.length,
    },
    execution: {
      durationMs: {
        p50: nearestRankPercentile(actual.map((result) => result.metadata?.durationMs).filter((value) => typeof value === 'number'), 0.5),
        p95: nearestRankPercentile(actual.map((result) => result.metadata?.durationMs).filter((value) => typeof value === 'number'), 0.95),
      },
      usage: { api: aggregateUsage('usageByCase'), cli: aggregateUsage('cliUsageByCase') },
      observedApiCostUSD: aggregateObservedMetric(actual.map((result) => result.metadata?.apiCostByCase ?? { value: null, observed: false })),
      observedCliCostUSD: aggregateObservedMetric(actual.map((result) => result.metadata?.cliCostByCase ?? { value: null, observed: false })),
    },
  }
}

export function buildSafeStoppedReport({ runID, caseIDs, infraCase, providerCase, catalogPreflight, guardSelfTest, mockProof }) {
  if (!Array.isArray(caseIDs) || caseIDs.length !== MAX_CASES || new Set(caseIDs).size !== MAX_CASES) throw new Error('stop report requires the complete 23-case manifest')
  if (!caseIDs.includes('F1-B005') || !caseIDs.includes('F1-B010')) throw new Error('stop report manifest misses the approved infrastructure/provider cases')
  if (!isApprovedInfrastructureEndedCase(runID, infraCase)) throw new Error('infrastructure-ended case is not in the reviewer allowlist')
  const providerID = providerCase?.providerID ?? providerCase?.request?.providerID
  const modelID = providerCase?.modelID ?? providerCase?.request?.modelID
  if (providerCase?.caseID !== 'F1-B010' || providerCase.fatal !== true || providerID !== LEGACY_FREE_MODEL.providerID || modelID !== LEGACY_FREE_MODEL.modelID || providerCase.request?.url !== LEGACY_FREE_URL || providerCase.request?.requestCount !== 1) {
    throw new Error('provider-failure case does not match the observed native one-request run')
  }
  const providerError = providerCase.metadata?.assistantOutcome?.error
  if (providerError?.type !== 'provider.free-limit' || providerError?.status !== 429 || providerCase.text !== '' || providerCase.apiText !== '') {
    throw new Error('provider-failure record is not the observed empty-output free-limit response')
  }
  if (providerCase.metadata?.durationMs !== 702) throw new Error('provider-failure duration does not match the observed run')
  const requestHooks = providerCase.hookEvidence?.filter((event) => event.event === 'http-request-allowed') ?? []
  const response429 = providerCase.hookEvidence?.some((event) => event.event === 'http-response' && event.status === 429) ?? false
  const veto = providerCase.hookEvidence?.some((event) => event.event === 'retry-decision' && event.retry === false) ?? false
  if (requestHooks.length !== 1 || requestHooks[0].toolCount !== 0 || !response429 || !veto) throw new Error('provider-failure hook evidence is incomplete')

  const catalogCost = catalogPreflight?.catalog?.cost
  const costVerdict = validateFreeCatalogCost(catalogCost)
  if (!costVerdict.ok || catalogPreflight?.catalog?.zeroCost !== true) throw new Error('stop report lacks a zero-cost catalog proof')
  if (guardSelfTest?.pluginReady !== true || guardSelfTest?.inferenceRequests !== 0 || guardSelfTest?.promptRequests !== 0) throw new Error('stop report lacks the no-inference native plugin self-test')
  if (mockProof?.cases !== 9 || mockProof?.allCapturedRequestsAuthless !== true) throw new Error('stop report lacks the approved mock proof/auth-header audit')

  const tokenFields = ['input', 'output', 'total', 'reasoning', 'cacheRead', 'cacheWrite']
  const tokens = Object.fromEntries(tokenFields.map((field) => {
    const observed = providerCase.metadata?.usageByCase?.[field]
    return [field, observed?.observed === true && typeof observed.value === 'number'
      ? { value: observed.value, observed: true }
      : { value: null, observed: false }]
  }))
  const actualCost = providerCase.metadata?.apiCostByCase
  const actualChargeUSD = actualCost?.observed === true && typeof actualCost.value === 'number'
    ? { value: actualCost.value, observed: true, authorized: false }
    : { value: null, observed: false, authorized: false }
  const commonNotRun = { status: 'NOT_RUN', attemptCount: 0, responseText: null, qualityJudgment: 'NOT_EVALUATED' }
  const cases = caseIDs.map((caseID) => {
    if (caseID === 'F1-B005') return {
      caseID,
      status: 'INCONCLUSIVE_INFRASTRUCTURE',
      attemptCount: 0,
      responseText: null,
      qualityJudgment: 'NOT_EVALUATED',
      reason: infraCase.stop?.reason ?? 'plugin setup failed before readiness',
      reservationConsumed: true,
    }
    if (caseID === 'F1-B010') return {
      caseID,
      status: 'PROVIDER_FAILURE',
      attemptCount: 1,
      requestCount: 1,
      responseStatus: 429,
      providerError: { type: 'provider.free-limit', status: 429 },
      elapsedMs: 702,
      responseGenerated: false,
      responseText: '',
      jsonValid: null,
      schemaValid: null,
      qualityJudgment: 'NOT_JUDGED_PROVIDER_FAILURE',
      retryRequests: 0,
      retryVetoed: true,
      input: providerCase.input,
      prompt: providerCase.prompt,
    }
    return { caseID, ...commonNotRun }
  })
  const notRun = cases.filter((entry) => entry.status === 'NOT_RUN').length
  if (notRun !== MAX_CASES - 2) throw new Error('stop report case accounting is inconsistent')

  return {
    schemaVersion: 'f2b0-safe-stop-v1',
    status: 'STOPPED_NO_FURTHER_INFERENCE',
    sourceRunID: runID,
    provider: LEGACY_FREE_MODEL.providerID,
    model: LEGACY_FREE_MODEL.modelID,
    nativeURL: LEGACY_FREE_URL,
    counts: {
      denominator: MAX_CASES,
      infrastructureInconclusive: 1,
      providerFailures: 1,
      notRun,
      actualProviderRequests: 1,
      generatedResponses: 0,
    },
    catalogCostUSDPerMillionTokens: catalogCost.map((tier) => ({ tier: tier.tier ?? null, input: tier.input, output: tier.output, cacheRead: tier.cache.read, cacheWrite: tier.cache.write })),
    billing: { actualChargeUSD, note: 'No usage-cost or billing amount was observed; catalog free pricing is not evidence of a billed amount.' },
    tokens,
    latencyMs: { observed: true, samples: [702], p50: 702, p95: 702, method: 'nearest-rank' },
    authHeaderValuesIncluded: false,
    sessionIdentifiersIncluded: false,
    rawStdoutIncluded: false,
    mockProof,
    nativePluginSelfTest: {
      pluginReady: guardSelfTest.pluginReady,
      zeroCost: guardSelfTest.catalog.zeroCost,
      mcpCount: guardSelfTest.mcpCount,
      skillCount: guardSelfTest.skillCount,
      otherPluginCount: guardSelfTest.otherPluginCount,
      promptRequests: guardSelfTest.promptRequests,
      inferenceRequests: guardSelfTest.inferenceRequests,
    },
    cases,
  }
}

export function summarizeStoppedRun(runID, caseIDs, caseResults) {
  if (!Array.isArray(caseIDs) || caseIDs.length !== MAX_CASES || new Set(caseIDs).size !== MAX_CASES) throw new Error('stopped run summary requires the complete 23-case manifest')
  if (caseResults.some((result) => !caseIDs.includes(result.caseID))) throw new Error('stopped run summary has an unknown case result')
  if (new Set(caseResults.map((result) => result.caseID)).size !== caseResults.length) throw new Error('stopped run summary has duplicate case results')
  const byID = new Map(caseResults.map((result) => [result.caseID, result]))
  const cases = caseIDs.map((caseID) => {
    const result = byID.get(caseID)
    if (!result) return { caseID, status: 'NOT_RUN', attemptCount: 0, requestCount: 0, responseGenerated: false, qualityJudgment: 'NOT_EVALUATED' }
    if (result.status === 'infrastructure-ended-zero-attempt' && result.attemptCount === 0) {
      return { caseID, status: 'INCONCLUSIVE_INFRASTRUCTURE', attemptCount: 0, requestCount: 0, responseGenerated: false, qualityJudgment: 'NOT_EVALUATED' }
    }
    const requestCount = Number.isInteger(result.request?.requestCount) ? result.request.requestCount : Number.isInteger(result.attemptCount) ? result.attemptCount : 0
    const responseGenerated = typeof result.text === 'string' && result.text.length > 0
    if (result.fatal === true) {
      const error = result.metadata?.assistantOutcome?.error ?? {}
      return {
        caseID,
        status: 'FATAL_STOP',
        attemptCount: result.attemptCount ?? requestCount,
        requestCount,
        responseGenerated,
        responseText: typeof result.text === 'string' ? result.text : null,
        qualityJudgment: 'NOT_JUDGED',
        stopCategory: result.stop?.category ?? 'fatal-case-result',
        providerError: { ...(error.type ? { type: error.type } : {}), ...(typeof error.status === 'number' ? { status: error.status } : {}) },
        durationMs: typeof result.metadata?.durationMs === 'number' ? result.metadata.durationMs : null,
      }
    }
    return {
      caseID,
      status: 'RESPONSE_RECORDED_BATCH_STOPPED',
      attemptCount: result.attemptCount ?? requestCount,
      requestCount,
      responseGenerated,
      responseText: typeof result.text === 'string' ? result.text : null,
      qualityJudgment: 'NOT_EVALUATED_BATCH_STOPPED',
      durationMs: typeof result.metadata?.durationMs === 'number' ? result.metadata.durationMs : null,
    }
  })
  const actualProviderRequests = cases.reduce((total, row) => total + row.requestCount, 0)
  const generatedResponses = cases.filter((row) => row.responseGenerated).length
  return {
    runID,
    status: 'STOPPED_PARTIAL_NO_FURTHER_INFERENCE',
    denominator: MAX_CASES,
    actualProviderRequests,
    generatedResponses,
    counts: {
      denominator: MAX_CASES,
      actualProviderRequests,
      generatedResponses,
      infrastructureInconclusive: cases.filter((row) => row.status === 'INCONCLUSIVE_INFRASTRUCTURE').length,
      fatal: cases.filter((row) => row.status === 'FATAL_STOP').length,
      notRun: cases.filter((row) => row.status === 'NOT_RUN').length,
      responseRecordedBatchStopped: cases.filter((row) => row.status === 'RESPONSE_RECORDED_BATCH_STOPPED').length,
    },
    cases,
  }
}

export function redactPersistedOutput(value, credential = '') {
  let text = String(value)
  const credentials = Array.isArray(credential) ? credential : [credential]
  for (const secret of credentials) if (typeof secret === 'string' && secret.length > 0) text = text.replaceAll(secret, '[redacted-credential]')
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[-_]?key|secret|password|credential)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
}
