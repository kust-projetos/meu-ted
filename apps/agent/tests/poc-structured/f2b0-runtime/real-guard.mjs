export const REAL_MODEL = Object.freeze({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' })
export const REAL_URL = 'https://opencode.ai/inference/openai/v1/chat/completions'
export const MAX_CASES = 23
export const REAL_CONFIRMATION = '--confirm-model=opencode/deepseek-v4.1-flash-free'
const APPROVED_INFRA_ENDINGS = new Map([
  ['2026-10-27T01-04-23-758Z-13588', new Set(['F1-B005'])],
])

export function approvedProviderCredential(environment) {
  const value = environment?.OPENCODE_API_KEY
  return typeof value === 'string' && value.length > 0 ? { available: true, value } : { available: false, value: undefined }
}

export function parseExecutionMode(argv) {
  const execute = argv.includes('--execute-real')
  const preflightOnly = argv.includes('--preflight-only')
  const selfTestGuard = argv.includes('--self-test-guard')
  const confirmation = argv.includes(REAL_CONFIRMATION)
  const resumeArg = argv.find((arg) => arg.startsWith('--resume='))
  const resumeID = resumeArg?.slice('--resume='.length)
  const exportArg = argv.find((arg) => arg.startsWith('--export-stopped-run='))
  const exportStoppedRunID = exportArg?.slice('--export-stopped-run='.length)
  if (argv.includes('--help') || (!execute && !preflightOnly && !selfTestGuard && !resumeID && !exportStoppedRunID)) return { help: true, execute, preflightOnly, selfTestGuard, confirmation, resumeID, exportStoppedRunID }
  if (exportStoppedRunID && (execute || preflightOnly || selfTestGuard || resumeID || !/^[a-zA-Z0-9._-]{1,80}$/.test(exportStoppedRunID))) throw new Error('--export-stopped-run requires only a safe run-id and performs no server/catalog call')
  if (execute && !confirmation) throw new Error(`real inference requires exact confirmation ${REAL_CONFIRMATION}`)
  if ((preflightOnly || selfTestGuard) && (execute || resumeID || (preflightOnly && selfTestGuard))) throw new Error('preflight/self-test modes cannot be combined with real execution/resume or each other')
  if (resumeID && (!execute || !/^[a-zA-Z0-9._-]{1,80}$/.test(resumeID))) throw new Error('--resume requires --execute-real and a safe run-id')
  return { help: false, execute, preflightOnly, selfTestGuard, confirmation, resumeID, exportStoppedRunID }
}

export function validateCatalogCost(cost) {
  if (!Array.isArray(cost) || cost.length === 0) return { ok: false, reason: 'cost-missing' }
  const values = []
  for (const tier of cost) {
    for (const key of ['input', 'output']) {
      if (typeof tier?.[key] !== 'number' || !Number.isFinite(tier[key])) return { ok: false, reason: 'cost-unknown' }
      values.push(tier[key])
    }
    for (const key of ['read', 'write']) {
      if (typeof tier?.cache?.[key] !== 'number' || !Number.isFinite(tier.cache[key])) return { ok: false, reason: 'cost-unknown' }
      values.push(tier.cache[key])
    }
  }
  return values.every((value) => value === 0)
    ? { ok: true, tiers: cost.length }
    : { ok: false, reason: 'cost-nonzero' }
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
    return { retry: true, fatal: false, category: 'connection' }
  }
  return { retry: false, fatal: true, category: 'local-client' }
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

export function isApprovedInfrastructureEndedCase(runID, result) {
  if (!APPROVED_INFRA_ENDINGS.get(runID)?.has(result?.caseID)) return false
  if (result.status !== 'infrastructure-ended-zero-attempt' || result.fatal !== false || result.attemptCount !== 0) return false
  if (result.providerID !== REAL_MODEL.providerID || result.modelID !== REAL_MODEL.modelID) return false
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
  if (providerCase?.caseID !== 'F1-B010' || providerCase.fatal !== true || providerID !== REAL_MODEL.providerID || modelID !== REAL_MODEL.modelID || providerCase.request?.url !== REAL_URL || providerCase.request?.requestCount !== 1) {
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
  const costVerdict = validateCatalogCost(catalogCost)
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
    provider: REAL_MODEL.providerID,
    model: REAL_MODEL.modelID,
    nativeURL: REAL_URL,
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
