import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  classifyProviderFailure,
  classifyLocalServerFailure,
  classifyAssistantOutcome,
  extractCliOutput,
  aggregateObservedMetric,
  isTerminalAssistantFailure,
  nearestRankPercentile,
  normalizeTokenUsage,
  limitRealAttempts,
  isApprovedInfrastructureEndedCase,
  summarizeRealRunMetrics,
  buildSafeStoppedReport,
  summarizeStoppedRun,
  planAttempts,
  parseExecutionMode,
  REAL_MODEL,
  REAL_URL,
  validateCatalogCost,
  validateGoUsageLimits,
  evaluateGoSmoke,
  validateNativeRequest,
  redactPersistedOutput,
} from './real-guard.mjs'
import { createCaseReservation, createExclusiveRunLock, finalizeStoppedRun, listReservationIDs } from './real-storage.mjs'
import { evaluateF2B0Attempts, F2B0_CASE_IDS } from '../f2b0-adapter.js'
import { F2A1_LOCAL_CANDIDATES, F2A1_LOCAL_JOURNEYS } from '../f2a1-candidates.js'

const exactRequest = {
  providerID: 'opencode-go',
  modelID: 'muse-spark-1.3-contributor',
  kind: 'primary',
  url: 'https://opencode.ai/inference/go/openai/v1/responses',
  method: 'POST',
  sessionRequestCount: 1,
  redirect: 'error',
  body: { model: 'muse-spark-1.3-contributor', input: 'synthetic', tools: [] },
}

describe('F2B0 real-run guard', () => {
  it('pins the target to OpenCode Go and admits only its official peak/off-peak prices', () => {
    expect(REAL_MODEL).toEqual({ providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor' })
    expect(REAL_URL).toBe('https://opencode.ai/inference/go/openai/v1/responses')
    const single = { input: 0.10, output: 0.20, cache: { read: 0.002, write: 0 } }
    expect(validateCatalogCost([single])).toMatchObject({ ok: true, tiers: 1 })
    expect(validateCatalogCost([{ ...single, tier: 'off-peak' }])).toMatchObject({ ok: true, tiers: 1 })
    expect(validateCatalogCost([])).toMatchObject({ ok: false, reason: 'cost-missing' })
    expect(validateCatalogCost(undefined)).toMatchObject({ ok: false, reason: 'cost-missing' })
    expect(validateCatalogCost([{ ...single, cache: { read: 0.002 } }])).toMatchObject({ ok: false, reason: 'cost-unknown' })
    expect(validateCatalogCost([{ ...single, output: 9 }])).toMatchObject({ ok: false, reason: 'cost-not-allowlisted' })
    expect(validateCatalogCost([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])).toMatchObject({ ok: false, reason: 'cost-not-allowlisted' })
  })

  it('requires current, complete, unlimited Go quota windows before a real request', () => {
    const available = {
      go: {
        rolling: { percent: 12, limited: false, resetsAt: 10_000 },
        weekly: { percent: 35, limited: false, resetsAt: 20_000 },
        monthly: { percent: 48, limited: false, resetsAt: 30_000 },
      },
    }
    expect(validateGoUsageLimits(available)).toEqual({
      ok: true,
      usage: {
        rolling: { percent: 12, limited: false, resetsAt: 10_000 },
        weekly: { percent: 35, limited: false, resetsAt: 20_000 },
        monthly: { percent: 48, limited: false, resetsAt: 30_000 },
      },
    })
    expect(validateGoUsageLimits(null)).toMatchObject({ ok: false, reason: 'go-usage-unavailable' })
    expect(validateGoUsageLimits({ budgets: [] })).toMatchObject({ ok: false, reason: 'go-subscription-unavailable' })
    expect(validateGoUsageLimits({ go: { ...available.go, rolling: { ...available.go.rolling, limited: true } } })).toMatchObject({ ok: false, reason: 'go-quota-limited', window: 'rolling' })
    expect(validateGoUsageLimits({ go: { ...available.go, monthly: { ...available.go.monthly, percent: 100 } } })).toMatchObject({ ok: false, reason: 'go-quota-limited', window: 'monthly' })
    expect(validateGoUsageLimits({ go: { ...available.go, weekly: { percent: 12, limited: false } } })).toMatchObject({ ok: false, reason: 'go-usage-unknown' })
  })

  it('passes a one-case smoke only with exact oracle/parser, one request, observed zero cost and attestations', () => {
    const valid = {
      jsonValid: true,
      schemaValid: true,
      semanticVerdict: 'PASS',
      requestCount: 1,
      noRetry: true,
      tokensObserved: true,
      costObserved: true,
      costUSD: 0,
      quotaAfterStatus: 'go-usage-unavailable',
      quotaAttested: true,
      extraUsageDisabledAttested: true,
    }
    expect(evaluateGoSmoke(valid)).toMatchObject({
      casePassed: true,
      continuationAllowed: false,
      status: 'SMOKE_PASS_OPERATOR_ATTESTED_NO_CONTINUATION',
    })
    expect(evaluateGoSmoke({ ...valid, quotaAfterStatus: null })).toMatchObject({ casePassed: true, continuationAllowed: true, status: 'SMOKE_PASS' })
    expect(evaluateGoSmoke({ ...valid, requestCount: 2 }).casePassed).toBe(false)
    expect(evaluateGoSmoke({ ...valid, noRetry: false }).casePassed).toBe(false)
    expect(evaluateGoSmoke({ ...valid, costObserved: false }).casePassed).toBe(false)
    expect(evaluateGoSmoke({ ...valid, costUSD: 0.01 })).toMatchObject({ casePassed: false, status: 'SMOKE_FAILED_STOP' })
    expect(evaluateGoSmoke({ ...valid, quotaAfterStatus: 'go-quota-limited' })).toMatchObject({ casePassed: true, continuationAllowed: false, status: 'SMOKE_PASS_QUOTA_STOP' })
    expect(evaluateGoSmoke({ ...valid, quotaAttested: false })).toMatchObject({ casePassed: false, status: 'SMOKE_BLOCKED_UNVERIFIED_BUDGET' })
    expect(evaluateGoSmoke({ ...valid, extraUsageDisabledAttested: false })).toMatchObject({ casePassed: false, status: 'SMOKE_BLOCKED_UNVERIFIED_BUDGET' })
  })

  it('accepts only the exact native primary request, one per session, with exact model/body and redirect denial', () => {
    expect(validateNativeRequest(exactRequest)).toMatchObject({ ok: true, model: 'muse-spark-1.3-contributor' })
    for (const change of [
      { providerID: 'openai' },
      { modelID: 'other-free-or-paid' },
      { kind: 'title' },
      { url: 'http://opencode.ai/inference/go/openai/v1/responses' },
      { url: 'https://opencode.ai/inference/go/openai/v1/responses?redirect=1' },
      { url: 'https://attacker.invalid/inference/go/openai/v1/responses' },
      { sessionRequestCount: 2 },
      { redirect: 'follow' },
      { body: { ...exactRequest.body, model: 'muse-spark-1.3-contributor-free' } },
      { body: { model: 'muse-spark-1.3-contributor', tools: [] } },
      { body: { ...exactRequest.body, tools: [{ name: 'write' }] } },
      { body: { ...exactRequest.body, tools: {} } },
      { body: { ...exactRequest.body, tool_choice: 'auto' } },
    ]) expect(validateNativeRequest({ ...exactRequest, ...change }).ok).toBe(false)
  })

  it('accepts only the native responses shape for muse-spark and refuses the legacy chat/completions shape', () => {
    const responsesRequest = {
      providerID: 'opencode-go',
      modelID: 'muse-spark-1.3-contributor',
      kind: 'primary',
      url: 'https://opencode.ai/inference/go/openai/v1/responses',
      method: 'POST',
      sessionRequestCount: 1,
      redirect: 'error',
      body: { model: 'muse-spark-1.3-contributor', input: 'synthetic', tools: [] },
    }
    expect(validateNativeRequest(responsesRequest)).toMatchObject({ ok: true, model: 'muse-spark-1.3-contributor' })
    // Legacy chat/completions URL with the new model is refused (url-mismatch).
    expect(validateNativeRequest({ ...responsesRequest, url: 'https://opencode.ai/inference/go/openai/v1/chat/completions' }).ok).toBe(false)
    // Messages-based body is refused even on the responses endpoint.
    expect(validateNativeRequest({ ...responsesRequest, body: { model: 'muse-spark-1.3-contributor', messages: [{ role: 'user', content: 'synthetic' }], tools: [] } }).ok).toBe(false)
    // Missing input is refused.
    expect(validateNativeRequest({ ...responsesRequest, body: { model: 'muse-spark-1.3-contributor', tools: [] } }).ok).toBe(false)
  })

  it('stops on provider auth/payment/quota/transport failures but not schema-invalid model text', () => {
    for (const failure of [
      { status: 401 }, { status: 402 }, { status: 403 }, { status: 429 },
      { status: 503 }, { type: 'provider.transport' }, { message: 'account quota exceeded' },
    ]) expect(classifyProviderFailure(failure).stop).toBe(true)
    expect(classifyProviderFailure({ kind: 'schema-invalid', reason: 'invalid-json' })).toMatchObject({ stop: false, category: 'schema-invalid' })
  })

  it('fails closed on loopback-server 401/403 and on connection-level readiness failures (no-retry-controlled: no inference retry)', () => {
    // Branch no-retry-controlled: local connection/readiness failures are
    // fail-closed for the inference layer (retry:false, fatal:true). The only
    // bounded wait is the pre-prompt server.info() poll in startServer, gated
    // by isReadinessPollRetriable(), which never resends a prompt. This test
    // replaces the former expectation that preserved retry:true.
    expect(classifyLocalServerFailure({ status: 401 })).toMatchObject({ retry: false, fatal: true, category: 'local-auth', status: 401 })
    expect(classifyLocalServerFailure({ response: { status: 403 } })).toMatchObject({ retry: false, fatal: true, category: 'local-auth', status: 403 })
    expect(classifyLocalServerFailure({ code: 'ECONNREFUSED' })).toMatchObject({ retry: false, fatal: true, category: 'connection' })
    expect(classifyLocalServerFailure({ cause: { code: 'ETIMEDOUT' } })).toMatchObject({ retry: false, fatal: true, category: 'connection' })
    for (const code of ['ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']) {
      expect(classifyLocalServerFailure({ code })).toMatchObject({ retry: false, fatal: true, category: 'connection' })
    }
    expect(classifyLocalServerFailure({ status: 503 })).toMatchObject({ retry: false, fatal: true, category: 'local-http', status: 503 })
    expect(classifyLocalServerFailure({ code: 'SOME_UNKNOWN' })).toMatchObject({ retry: false, fatal: true, category: 'local-client' })
  })

  it('extracts actual JSON-lines text and usage without synthesizing assistant output', () => {
    const raw = [
      JSON.stringify({ type: 'step_start', timestamp: 100 }),
      JSON.stringify({ type: 'text', timestamp: 110, part: { type: 'text', text: '{"interpretation":{}}' } }),
      JSON.stringify({ type: 'step_finish', timestamp: 120, part: { type: 'step-finish', reason: 'stop', tokens: { input: 40, output: 9 }, cost: 0 } }),
    ].join('\n')
    expect(extractCliOutput(raw)).toMatchObject({
      text: '{"interpretation":{}}',
      eventTypes: ['step_start', 'text', 'step_finish'],
      usage: { input: { value: 40, observed: true }, output: { value: 9, observed: true }, cacheRead: { value: null, observed: false } },
      cost: 0,
    })
    expect(extractCliOutput('not-json').text).toBe('')
  })

  it('normalizes nested cache tokens, preserves unknown fields, and leaves missing counters unknown', () => {
    expect(normalizeTokenUsage({ input: 40, output: 9, cache: { read: 8, write: 2 }, futureCounter: 7 })).toEqual({
      input: { value: 40, observed: true },
      output: { value: 9, observed: true },
      total: { value: null, observed: false },
      reasoning: { value: null, observed: false },
      cacheRead: { value: 8, observed: true },
      cacheWrite: { value: 2, observed: true },
      unknown: { futureCounter: 7 },
    })
  })

  it('does not treat assistant finish:error or an assistant error as success despite matching text/status 200', () => {
    expect(isTerminalAssistantFailure({ finish: 'error', text: 'valid JSON', httpStatus: 200 })).toBe(true)
    expect(isTerminalAssistantFailure({ finish: 'stop', error: { name: 'ProviderError' }, text: 'valid JSON', httpStatus: 200 })).toBe(true)
    expect(isTerminalAssistantFailure({ finish: 'stop', error: null, text: 'valid JSON', httpStatus: 200 })).toBe(false)
    expect(classifyAssistantOutcome({ assistantMessages: [{ finish: 'error', text: 'valid JSON' }] })).toMatchObject({ terminal: true, category: 'assistant-terminal-error' })
    expect(classifyAssistantOutcome({ waitError: new Error('wait failed'), assistantMessages: [{ finish: 'stop' }] })).toMatchObject({ terminal: true, category: 'session-wait-error' })
    expect(classifyAssistantOutcome({ assistantMessages: [{ finish: 'stop', error: null }] })).toMatchObject({ terminal: false })
  })

  it('aggregates only fully observed usage and uses nearest-rank duration percentiles', () => {
    expect(aggregateObservedMetric([{ value: 4, observed: true }, { value: 6, observed: true }])).toEqual({ value: 10, observed: true, observedCount: 2, missingCount: 0 })
    expect(aggregateObservedMetric([{ value: 4, observed: true }, { value: null, observed: false }])).toEqual({ value: null, observed: false, observedCount: 1, missingCount: 1 })
    expect(nearestRankPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toEqual({ value: 5, observedCount: 10, method: 'nearest-rank' })
    expect(nearestRankPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toEqual({ value: 10, observedCount: 10, method: 'nearest-rank' })
    expect(nearestRankPercentile([], 0.95)).toEqual({ value: null, observedCount: 0, method: 'nearest-rank' })
  })

  it('allows only the reviewer-approved zero-attempt infrastructure disposition for its exact run and case', () => {
    const approved = {
      runID: '2026-10-27T01-04-23-758Z-13588', caseID: 'F1-B005', providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free',
      status: 'infrastructure-ended-zero-attempt', fatal: false, attemptCount: 0,
      reviewAudit: [{ action: 'approved-nonfatal-infrastructure-ended-zero-attempt', approvedBy: 'Reviewer' }],
    }
    expect(isApprovedInfrastructureEndedCase(approved.runID, approved)).toBe(true)
    expect(isApprovedInfrastructureEndedCase('another-run', approved)).toBe(false)
    expect(isApprovedInfrastructureEndedCase(approved.runID, { ...approved, caseID: 'F1-B006' })).toBe(false)
    expect(isApprovedInfrastructureEndedCase(approved.runID, { ...approved, attemptCount: 1 })).toBe(false)
    expect(isApprovedInfrastructureEndedCase(approved.runID, { ...approved, reviewAudit: [] })).toBe(false)
  })

  it('keeps a zero-attempt infrastructure case inconclusive while summarizing 22 actual outputs over denominator 23', () => {
    const complete = [
      ...Object.entries(F2A1_LOCAL_CANDIDATES).map(([id, output]) => ({ id, raw: JSON.stringify(output) })),
      ...Object.entries(F2A1_LOCAL_JOURNEYS).flatMap(([journey, turns]) => turns.map((output, index) => ({ id: `${journey}:T${index + 1}`, raw: JSON.stringify(output) }))),
    ]
    const attempts = complete.filter((attempt) => attempt.id !== 'F1-B005')
    expect(F2B0_CASE_IDS).toHaveLength(23)
    expect(attempts).toHaveLength(22)
    const evaluation = evaluateF2B0Attempts(attempts)
    const infrastructureEnded = { caseID: 'F1-B005', status: 'infrastructure-ended-zero-attempt', attemptCount: 0, metadata: {} }
    const actual = attempts.map((attempt, index) => ({
      caseID: attempt.id, status: 'completed-for-evaluation', attemptCount: 1,
      metadata: {
        durationMs: index + 1,
        usageByCase: {
          input: { value: 10, observed: true }, output: { value: 4, observed: true }, total: { value: null, observed: false },
          reasoning: { value: null, observed: false }, cacheRead: { value: 2, observed: true }, cacheWrite: { value: null, observed: false },
        },
        cliUsageByCase: { input: { value: null, observed: false }, output: { value: null, observed: false }, total: { value: null, observed: false }, reasoning: { value: null, observed: false }, cacheRead: { value: null, observed: false }, cacheWrite: { value: null, observed: false } },
        apiCostByCase: { value: null, observed: false }, cliCostByCase: { value: null, observed: false },
      },
    }))
    const summary = summarizeRealRunMetrics(evaluation, [infrastructureEnded, ...actual], 23)
    expect(summary.actualAttemptCount).toBe(22)
    expect(summary.denominator).toBe(23)
    expect(summary.infrastructureEndedCaseIDs).toEqual(['F1-B005'])
    expect(summary.semantic.scenarios.find((row) => row.corpusId === 'F1-B005')?.verdict).toBe('INCONCLUSIVE')
    expect(summary.jsonValidity).toMatchObject({ valid: 22, invalid: 0, notAttempted: 1 })
    expect(summary.schemaValidity).toMatchObject({ valid: 22, invalid: 0, notAttempted: 1 })
    expect(summary.execution.durationMs.p50.value).toBe(11)
    expect(summary.execution.durationMs.p95.value).toBe(21)
    expect(summary.execution.usage.api.total).toMatchObject({ value: null, observed: false, missingCount: 22 })
    expect(summary.execution.usage.api.input).toMatchObject({ value: 220, observed: true })
    expect(summary.execution.observedApiCostUSD).toMatchObject({ value: null, observed: false, missingCount: 22 })
    expect(summary.execution.observedCliCostUSD).toMatchObject({ value: null, observed: false, missingCount: 22 })
  })

  it('exports a bounded 23-row stop report without IDs, raw stdout, auth values, or invented response/usage', () => {
    const caseIDs = Array.from({ length: 23 }, (_, index) => `CASE-${index + 1}`)
    caseIDs[0] = 'F1-B005'
    caseIDs[1] = 'F1-B010'
    const infraCase = {
      runID: '2026-10-27T01-04-23-758Z-13588', caseID: 'F1-B005', providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free',
      status: 'infrastructure-ended-zero-attempt', fatal: false, attemptCount: 0,
      reviewAudit: [{ action: 'approved-nonfatal-infrastructure-ended-zero-attempt', approvedBy: 'Reviewer' }],
    }
    const zeroMetric = { value: null, observed: false, observedCount: 0, missingCount: 1 }
    const providerCase = {
      caseID: 'F1-B010', providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free', fatal: true,
      request: { url: 'https://opencode.ai/inference/openai/v1/chat/completions', requestCount: 1 },
      text: '', apiText: '', metadata: {
        durationMs: 702,
        assistantOutcome: { terminal: true, category: 'assistant-terminal-error', finish: 'error', error: { type: 'provider.free-limit', status: 429 } },
        usageByCase: Object.fromEntries(['input', 'output', 'total', 'reasoning', 'cacheRead', 'cacheWrite'].map((key) => [key, zeroMetric])),
        apiCostByCase: zeroMetric,
      },
      hookEvidence: [
        { event: 'http-request-allowed', requestCount: 1, kind: 'primary', toolCount: 0 },
        { event: 'http-response', status: 429 },
        { event: 'retry-decision', attempt: 2, retry: false },
      ],
      input: { caseId: 'F1-B010', currentText: 'Mostre minhas faturas' },
      prompt: 'full synthetic prompt only',
      rawStdout: '{"sessionID":"ses_secret","error":{"status":429}}',
    }
    const report = buildSafeStoppedReport({
      runID: infraCase.runID,
      caseIDs,
      infraCase,
      providerCase,
      catalogPreflight: { catalog: { zeroCost: true, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }, credentialAvailable: false },
      guardSelfTest: { pluginReady: true, catalog: { zeroCost: true }, mcpCount: 0, skillCount: 0, otherPluginCount: 0, promptRequests: 0, inferenceRequests: 0 },
      mockProof: { cases: 9, capturedRequests: 7, allCapturedRequestsAuthless: true },
    })
    expect(report.counts).toMatchObject({ denominator: 23, infrastructureInconclusive: 1, providerFailures: 1, notRun: 21, actualProviderRequests: 1, generatedResponses: 0 })
    expect(report.cases.find((row) => row.caseID === 'F1-B005')).toMatchObject({ status: 'INCONCLUSIVE_INFRASTRUCTURE', attemptCount: 0, qualityJudgment: 'NOT_EVALUATED' })
    expect(report.cases.find((row) => row.caseID === 'F1-B010')).toMatchObject({ status: 'PROVIDER_FAILURE', attemptCount: 1, responseText: '', jsonValid: null, schemaValid: null, providerError: { type: 'provider.free-limit', status: 429 } })
    expect(report.cases.find((row) => row.caseID === 'F1-B010')?.prompt).toBe('full synthetic prompt only')
    expect(report.latencyMs).toMatchObject({ p50: 702, p95: 702, samples: [702] })
    expect(report.tokens.input).toMatchObject({ value: null, observed: false })
    expect(report.billing.actualChargeUSD).toMatchObject({ value: null, observed: false, authorized: false })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('ses_secret')
    expect(serialized).not.toContain('Authorization')
    expect(report).not.toHaveProperty('rawStdout')
    expect(report.rawStdoutIncluded).toBe(false)
  })

  it('finalizes a fatal partial run across all 23 cases without grading the failed provider output', () => {
    const caseIDs = Array.from({ length: 23 }, (_, index) => `CASE-${index + 1}`)
    caseIDs[0] = 'F1-B005'
    caseIDs[1] = 'F1-B010'
    const results = [
      { caseID: 'F1-B005', status: 'infrastructure-ended-zero-attempt', attemptCount: 0, request: { requestCount: 0 }, text: null, metadata: {} },
      { caseID: 'F1-B010', status: 'fatal-provider-or-guard-error', fatal: true, attemptCount: 1, request: { requestCount: 1 }, text: '', stop: { category: 'assistant-terminal-error' }, metadata: { durationMs: 702, assistantOutcome: { error: { type: 'provider.free-limit', status: 429 } } } },
    ]
    const summary = summarizeStoppedRun('stopped-run', caseIDs, results)
    expect(summary.counts).toMatchObject({ denominator: 23, infrastructureInconclusive: 1, fatal: 1, notRun: 21, actualProviderRequests: 1, generatedResponses: 0 })
    expect(summary.cases.find((row) => row.caseID === 'F1-B005')?.status).toBe('INCONCLUSIVE_INFRASTRUCTURE')
    expect(summary.cases.find((row) => row.caseID === 'F1-B010')).toMatchObject({ status: 'FATAL_STOP', qualityJudgment: 'NOT_JUDGED', providerError: { type: 'provider.free-limit', status: 429 }, responseText: '' })
  })

  it('persists stopped summary before fatal exit data is returned', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-stopped-finalize-'))
    const caseIDs = Array.from({ length: 23 }, (_, index) => `CASE-${index + 1}`)
    caseIDs[0] = 'F1-B005'
    caseIDs[1] = 'F1-B010'
    const cases = [
      { caseID: 'F1-B005', status: 'infrastructure-ended-zero-attempt', attemptCount: 0, request: { requestCount: 0 } },
      { caseID: 'F1-B010', status: 'fatal-provider-or-guard-error', fatal: true, attemptCount: 1, request: { requestCount: 1 }, text: '', stop: { category: 'provider-error' }, metadata: { assistantOutcome: { error: { type: 'provider.free-limit', status: 429 } }, durationMs: 702 } },
    ]
    try {
      const result = await finalizeStoppedRun(directory, 'stop-run', caseIDs, cases, { category: 'provider-error' })
      const summary = JSON.parse(await readFile(path.join(directory, 'stopped-summary.json'), 'utf8'))
      const stopped = JSON.parse(await readFile(path.join(directory, 'stopped.json'), 'utf8'))
      expect(result.counts).toMatchObject({ denominator: 23, fatal: 1, notRun: 21 })
      expect(summary.cases.find((row) => row.caseID === 'F1-B010').qualityJudgment).toBe('NOT_JUDGED')
      expect(stopped.stoppedSummary).toBe('stopped-summary.json')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes only missing IDs, refuses implicit reuse, and enforces the 23-case ceiling', () => {
    const ids = ['A', 'B', 'C']
    expect(planAttempts(ids, [], { resume: false })).toEqual({ run: ids, skipped: [], unresolvedReservations: [] })
    expect(() => planAttempts(ids, ['A'], { resume: false })).toThrow('existing results')
    expect(planAttempts(ids, ['A'], { resume: true })).toEqual({ run: ['B', 'C'], skipped: ['A'], unresolvedReservations: [] })
    expect(planAttempts(ids, [], { resume: true, reservedIDs: ['A'] })).toEqual({ run: ['B', 'C'], skipped: [], unresolvedReservations: ['A'] })
    expect(() => planAttempts(Array.from({ length: 24 }, (_, i) => String(i)), [], { resume: true })).toThrow('23-case ceiling')
    expect(() => planAttempts(ids, ['unknown'], { resume: true })).toThrow('unknown existing result')
  })

  it('limits the first Go smoke to exactly one pending case and defers the rest', () => {
    const ids = Array.from({ length: 23 }, (_, index) => `F1-B${String(index + 1).padStart(3, '0')}`)
    expect(limitRealAttempts(ids, { smokeOnly: true })).toEqual({ run: [ids[0]], deferred: ids.slice(1) })
    expect(limitRealAttempts(ids, { smokeOnly: false })).toEqual({ run: ids, deferred: [] })
    expect(() => limitRealAttempts([], { smokeOnly: true })).toThrow('no pending smoke case')
  })

  it('does not arm inference by default and requires the exact model confirmation', () => {
    expect(parseExecutionMode([])).toMatchObject({ help: true, execute: false })
    expect(parseExecutionMode(['--preflight-only'])).toMatchObject({ preflightOnly: true, execute: false })
    expect(parseExecutionMode(['--self-test-guard'])).toMatchObject({ selfTestGuard: true, execute: false })
    expect(() => parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor'])).toThrow('quota confirmation')
    expect(() => parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--smoke-only'])).toThrow('Extra Usage confirmation')
    expect(parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only'])).toMatchObject({ execute: true, confirmation: true, quotaConfirmation: true, extraUsageConfirmation: true, smokeOnly: true })
    expect(() => parseExecutionMode(['--smoke-only'])).toThrow('requires --execute-real')
    expect(() => parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only', '--resume=prior-run'])).toThrow('cannot be combined')
    expect(parseExecutionMode(['--export-stopped-run=run-id'])).toMatchObject({ exportStoppedRunID: 'run-id', execute: false })
    expect(() => parseExecutionMode(['--execute-real'])).toThrow('exact confirmation')
    expect(() => parseExecutionMode(['--execute-real', '--confirm-model=opencode/deepseek-v4.1-flash-free'])).toThrow('exact confirmation')
    expect(() => parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available'])).toThrow('Extra Usage confirmation')
    expect(() => parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled'])).toThrow('first real F2B0 invocation must use --smoke-only')
    expect(parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only'])).toMatchObject({ execute: true, confirmation: true, quotaConfirmation: true, extraUsageConfirmation: true })
    expect(() => parseExecutionMode(['--preflight-only', '--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode(['--self-test-guard', '--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode(['--export-stopped-run=run-id', '--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled'])).toThrow('requires only a safe run-id')
  })

  it('redacts credential values while preserving token-usage metadata', () => {
    const text = 'Authorization: Bearer secret-value {"tokens":{"input":4},"apiKey":"secret-value"}'
    const safe = redactPersistedOutput(text, 'secret-value')
    expect(safe).not.toContain('secret-value')
    expect(safe).toContain('"tokens":{"input":4}')
    expect(redactPersistedOutput('server-secret provider-secret', ['server-secret', 'provider-secret'])).toBe('[redacted-credential] [redacted-credential]')
  })

  it('uses an exclusive run lock and never auto-clears a crash-stale lock', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-lock-test-'))
    const file = path.join(directory, 'run.lock')
    try {
      const outcomes = await Promise.allSettled([
        createExclusiveRunLock(file, { runID: 'run-one', pid: 1 }),
        createExclusiveRunLock(file, { runID: 'run-two', pid: 2 }),
      ])
      const winners = outcomes.filter((result) => result.status === 'fulfilled')
      expect(winners).toHaveLength(1)
      const winner = winners[0].status === 'fulfilled' ? winners[0].value : undefined
      expect(await stat(file)).toBeTruthy()
      await winner?.release()

      const stale = await createExclusiveRunLock(file, { runID: 'crashed-run', pid: 3 })
      // Simulate a hard crash: deliberately do not call release().
      void stale
      await expect(createExclusiveRunLock(file, { runID: 'crashed-run', pid: 4 })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await stat(file)).toBeTruthy()
    } finally {
      await unlink(file).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('durably consumes a per-case reservation and prevents replay after a simulated crash', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-reservation-test-'))
    try {
      const reservation = await createCaseReservation(directory, 'A', { runID: 'crashed-run' })
      expect(JSON.parse(await readFile(reservation, 'utf8'))).toMatchObject({ caseID: 'A', status: 'reserved' })
      await expect(createCaseReservation(directory, 'A', { runID: 'crashed-run' })).rejects.toMatchObject({ code: 'EEXIST' })
      const plan = planAttempts(['A', 'B', 'C'], [], { resume: true, reservedIDs: await listReservationIDs(directory) })
      expect(plan.run).toEqual(['B', 'C'])
      expect(plan.unresolvedReservations).toEqual(['A'])
      expect(() => planAttempts(['A', 'B', 'C'], [], { resume: false, reservedIDs: ['A'] })).toThrow('existing results or reservations')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
