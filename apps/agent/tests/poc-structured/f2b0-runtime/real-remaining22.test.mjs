import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUTHORIZED_REMAINING22_SOURCE_RUN_ID,
  AUTHORIZED_REMAINING22_RESERVATION_PATH,
  REMAINING22_EXCLUDED_CASE_ID,
  REMAINING22_EXPECTED_COUNT,
  MAX_CASES,
  REAL_MODEL,
  REAL_URL,
  buildRemaining22Attestation,
  isAuthorizedRemaining22Source,
  parseExecutionMode,
  planRemaining22,
  resolveRealExecutionPlan,
} from './real-guard.mjs'
import {
  createRemaining22Reservation,
  listRemaining22Reservations,
  remaining22FileName,
  createRemaining22CampaignClaim,
  listRemaining22CampaignClaims,
  remaining22CampaignFileName,
} from './real-storage.mjs'
import { evaluateF2B0Attempts, F2B0_CASE_IDS, getF2B0Cases } from '../f2b0-adapter.js'
import { F2A1_LOCAL_CANDIDATES, F2A1_LOCAL_JOURNEYS } from '../f2a1-candidates.js'

const exactArgv = [
  '--execute-real',
  '--confirm-model=opencode-go/muse-spark-1.3-contributor',
  '--confirm-go-quota-available',
  '--confirm-go-extra-usage-disabled',
  `--remaining22-authorized-run=${AUTHORIZED_REMAINING22_SOURCE_RUN_ID}`,
]

const campaignCaseIDs = F2B0_CASE_IDS.filter((id) => id !== REMAINING22_EXCLUDED_CASE_ID)
const canonicalCases = getF2B0Cases()
const canonical = {
  caseIDs: canonicalCases.map((entry) => entry.id),
  prompts: canonicalCases.map((entry) => ({ id: entry.id, input: entry.input, prompt: entry.prompt })),
}
const canonicalCampaignOrdered = canonical.caseIDs.filter((id) => id !== REMAINING22_EXCLUDED_CASE_ID)

const RUN_NONCE = '9b2e0380-4af5-4ce1-9334-ffcc178f4238'
const SESSION_KEY = '86bfbf6e6dd8'
const BODY_SHA = '8fb0abcd2b50f95798a4aab5e1b488ca490fc709645256875f9c9f949d991ac1'

const buildValidSource = () => {
  const caseIDs = [...canonical.caseIDs]
  const remaining = [...canonicalCampaignOrdered]
  const manifest = {
    runID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID,
    provider: REAL_MODEL.providerID,
    model: REAL_MODEL.modelID,
    nativeURL: REAL_URL,
    caseIDs,
    prompts: canonical.prompts.map((entry) => ({ id: entry.id, input: entry.input, prompt: entry.prompt })),
  }
  const smokeEvaluation = {
    schemaVersion: 'f2b0-go-single-smoke-v1',
    status: 'SMOKE_PASS_OPERATOR_ATTESTED_NO_CONTINUATION',
    runID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID,
    caseID: REMAINING22_EXCLUDED_CASE_ID,
    providerID: REAL_MODEL.providerID,
    modelID: REAL_MODEL.modelID,
    endpoint: REAL_URL,
    physicalRequests: 1,
    noRetry: true,
    stdinPromptObserved: true,
    jsonValid: true,
    schemaValid: true,
    semanticVerdict: 'PASS',
    continuationAllowed: false,
    extraUsageStatus: 'operator-attested-disabled',
    costObserved: true,
    costUSD: { api: { value: 0, observed: true }, cli: { value: null, observed: false } },
    remainingCaseIDs: remaining,
    goUsageBefore: { source: 'operator-attestation', status: 'go-usage-unavailable', usage: null },
    goUsageAfter: { source: 'operator-attestation', status: 'go-usage-unavailable', usage: null },
  }
  const smokeManifestEntry = manifest.prompts.find((entry) => entry.id === REMAINING22_EXCLUDED_CASE_ID)
  const interpretation = {
    interpretation: {
      intent: 'read',
      operation: 'list_payables',
      args: {},
      contextProvenance: { origin: 'f1-corpus-text', corpusId: 'F1-B005' },
      entities: [],
      ambiguities: [],
      clarification: null,
      missingFields: [],
      requestedAction: 'list_payables',
    },
  }
  const text = JSON.stringify(interpretation)
  const smokeEvaluationWithResponse = { ...smokeEvaluation, responseText: text }
  const hookEvidence = [
    { event: 'context', sessionKey: SESSION_KEY, effectiveToolCount: 0, runNonce: RUN_NONCE },
    { event: 'http-request-allowed', sessionKey: SESSION_KEY, provider: REAL_MODEL.providerID, model: REAL_MODEL.modelID, kind: 'primary', url: REAL_URL, method: 'POST', requestCount: 1, redirect: 'error', bodySha256: BODY_SHA, bodyModel: REAL_MODEL.modelID, toolCount: 0, authorizationPresent: true, runNonce: RUN_NONCE },
    { event: 'http-response', sessionKey: SESSION_KEY, status: 200, runNonce: RUN_NONCE },
  ]
  const caseResult = {
    caseID: REMAINING22_EXCLUDED_CASE_ID,
    reservation: 'reservations\\opencode-go-muse-spark-1.3-contributor\\F1-B005.consumed-smoke-2026-10-29T10-55-14-534Z-21048.json',
    fatal: false,
    attemptCount: 1,
    request: { providerID: REAL_MODEL.providerID, modelID: REAL_MODEL.modelID, url: REAL_URL, requestCount: 1 },
    text,
    apiText: text,
    apiTextMatchesStdout: true,
    assistantTextValid: true,
    input: smokeManifestEntry.input,
    prompt: smokeManifestEntry.prompt,
    stop: { stop: false, category: 'schema-check-or-success' },
    metadata: {
      stdinPromptObserved: true,
      assistantOutcome: { terminal: false, category: 'assistant-nonterminal' },
      apiCostByCase: { value: 0, observed: true, observedCount: 1, missingCount: 0 },
      requestBodySha256: BODY_SHA,
      requestBodyModel: REAL_MODEL.modelID,
      toolCount: 0,
    },
    hookEvidence,
  }
  const catalogPreflight = {
    catalog: { providerID: REAL_MODEL.providerID, modelID: REAL_MODEL.modelID, catalogPriceAllowed: true },
    extraUsageStatus: 'operator-attested-disabled',
  }
  const hookEvents = [
    { event: 'plugin-ready', provider: REAL_MODEL.providerID, model: REAL_MODEL.modelID, mcpCount: 0, skillCount: 0, runNonce: RUN_NONCE },
    { event: 'context', sessionKey: SESSION_KEY, effectiveToolCount: 0, runNonce: RUN_NONCE },
    { event: 'http-request-allowed', sessionKey: SESSION_KEY, provider: REAL_MODEL.providerID, model: REAL_MODEL.modelID, kind: 'primary', url: REAL_URL, method: 'POST', requestCount: 1, redirect: 'error', bodySha256: BODY_SHA, bodyModel: REAL_MODEL.modelID, toolCount: 0, authorizationPresent: true, runNonce: RUN_NONCE },
    { event: 'http-response', sessionKey: SESSION_KEY, status: 200, runNonce: RUN_NONCE },
  ]
  const reservationRecord = {
    runID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID,
    runNonce: RUN_NONCE,
    sourceRunID: '2026-10-29T10-55-14-534Z-21048',
    caseID: 'F1-B005',
    status: 'reserved',
    consumedSmoke: true,
  }
  return { manifest, smokeEvaluation: smokeEvaluationWithResponse, caseResult, catalogPreflight, hookEvents, reservationRecord, remaining, canonical }
}

describe('F2B0 remaining22 campaign (22 cases, fixed smoke source)', () => {
  it('pins the fixed smoke source and exactly F2B0_CASE_IDS minus F1-B005 in canonical order', () => {
    expect(AUTHORIZED_REMAINING22_SOURCE_RUN_ID).toBe('2026-10-29T12-26-34-600Z-4324')
    expect(REMAINING22_EXCLUDED_CASE_ID).toBe('F1-B005')
    expect(REMAINING22_EXPECTED_COUNT).toBe(22)
    expect(MAX_CASES).toBe(23)
    expect(F2B0_CASE_IDS).toHaveLength(23)
    expect(canonical.caseIDs).toEqual([...F2B0_CASE_IDS])
    expect(campaignCaseIDs).toHaveLength(22)
    expect(campaignCaseIDs).toEqual(canonicalCampaignOrdered)
    expect(campaignCaseIDs).not.toContain('F1-B005')
  })

  it('requires the explicit remaining22 flag with exact confirmations and no legacy combination', () => {
    expect(parseExecutionMode(exactArgv)).toMatchObject({ execute: true, remaining22RunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, smokeOnly: false })
    expect(() => parseExecutionMode(exactArgv.filter((a) => !a.startsWith('--confirm-go-quota')))).toThrow('requires --execute-real plus exact confirmations')
    expect(() => parseExecutionMode(exactArgv.filter((a) => !a.startsWith('--confirm-go-extra')))).toThrow('requires --execute-real plus exact confirmations')
    expect(() => parseExecutionMode([...exactArgv, '--smoke-only'])).toThrow('cannot be combined with --smoke-only')
    expect(() => parseExecutionMode([...exactArgv, '--resume=some-run'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...exactArgv, '--preflight-only'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...exactArgv, '--self-test-guard'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...exactArgv, '--export-stopped-run=x'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...exactArgv, '--retry-authorized-case=F1-B005', '--retry-authorized-run=2026-10-27T15-19-19-424Z-5620'])).toThrow('incompatible')
    expect(() => parseExecutionMode([...exactArgv, '--consumed-smoke-authorized-case=F1-B005', '--consumed-smoke-authorized-run=2026-10-29T10-55-14-534Z-21048'])).toThrow('incompatible')
    expect(() => parseExecutionMode(exactArgv.map((a) => a.startsWith('--remaining22-authorized-run=') ? '--remaining22-authorized-run=other-run' : a))).toThrow('limited to source')
    expect(() => parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled'])).toThrow('first real F2B0 invocation must use --smoke-only')
  })

  it('keeps legacy retry/consumed/smoke modes mutually exclusive with remaining22', () => {
    const retryArgv = ['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only', '--retry-authorized-case=F1-B005', '--retry-authorized-run=2026-10-27T15-19-19-424Z-5620', `--remaining22-authorized-run=${AUTHORIZED_REMAINING22_SOURCE_RUN_ID}`]
    expect(() => parseExecutionMode(retryArgv)).toThrow(/remaining22 campaign (is incompatible|cannot be combined)/)
    const consumedArgv = ['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only', '--consumed-smoke-authorized-case=F1-B005', '--consumed-smoke-authorized-run=2026-10-29T10-55-14-534Z-21048', `--remaining22-authorized-run=${AUTHORIZED_REMAINING22_SOURCE_RUN_ID}`]
    expect(() => parseExecutionMode(consumedArgv)).toThrow(/remaining22 campaign (is incompatible|cannot be combined)/)
  })

  it('plans exactly the 22 canonical campaign cases serially, never the smoke case, no B1/retry/fallback', () => {
    const planned = planRemaining22({ caseIDs: [...F2B0_CASE_IDS], sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID })
    expect(planned.run).toEqual(canonicalCampaignOrdered)
    expect(planned.deferred).toEqual(['F1-B005'])
    expect(() => planRemaining22({ caseIDs: [...F2B0_CASE_IDS, 'B1-EXTRA'] })).toThrow()
    expect(() => planRemaining22({ caseIDs: campaignCaseIDs })).toThrow('complete 23-case manifest')
    expect(() => planRemaining22({ caseIDs: [...F2B0_CASE_IDS], sourceRunID: 'other-run' })).toThrow('limited to source')
  })

  it('resolves the remaining22 plan offline without replaying history and blocks campaign reservations collisions', () => {
    const resolved = resolveRealExecutionPlan({
      caseIDs: [...F2B0_CASE_IDS],
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: { remaining22RunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID },
    })
    expect(resolved.authorized).toBe(true)
    expect(resolved.campaign).toBe('remaining22')
    expect(resolved.executionPlan.run).toEqual(canonicalCampaignOrdered)
    expect(() => resolveRealExecutionPlan({
      caseIDs: [...F2B0_CASE_IDS],
      existingIDs: ['F1-B005'],
      reservedIDs: ['F1-B005'],
      options: { remaining22RunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID },
    })).toThrow('empty run directory')
    expect(() => resolveRealExecutionPlan({
      caseIDs: [...F2B0_CASE_IDS],
      existingIDs: [],
      reservedIDs: ['F1-B005', 'F1-B010'],
      options: { remaining22RunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID },
    })).toThrow('refuses unresolved reservations for campaign cases')
    expect(() => resolveRealExecutionPlan({
      caseIDs: [...F2B0_CASE_IDS],
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: { remaining22RunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, smokeOnly: true },
    })).toThrow()
    expect(() => resolveRealExecutionPlan({
      caseIDs: [...F2B0_CASE_IDS],
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: { remaining22RunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, resumeID: 'x' },
    })).toThrow()
  })

  it('verifies the fixed historic source integrity (provider/model/canonical/hook/request/stdin/cost)', () => {
    const valid = buildValidSource()
    expect(isAuthorizedRemaining22Source({ sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, ...valid })).toEqual({ ok: true })
  })

  it('pins the exact consumed-smoke reservation path and source chain per real evidence', () => {
    expect(AUTHORIZED_REMAINING22_RESERVATION_PATH).toBe('reservations/opencode-go-muse-spark-1.3-contributor/F1-B005.consumed-smoke-2026-10-29T10-55-14-534Z-21048.json')
    const valid = buildValidSource()
    expect(valid.caseResult.reservation).toBe('reservations\\opencode-go-muse-spark-1.3-contributor\\F1-B005.consumed-smoke-2026-10-29T10-55-14-534Z-21048.json')
    expect(valid.reservationRecord).toMatchObject({ caseID: 'F1-B005', runID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, sourceRunID: '2026-10-29T10-55-14-534Z-21048', consumedSmoke: true, status: 'reserved' })
  })

  it('refuses historic forgeries: canonical order, prompts, inputs, hook binding, retry, stdin, or nonzero cost', () => {
    const base = buildValidSource()
    const check = (mutate) => {
      const next = structuredClone(base)
      mutate(next)
      return isAuthorizedRemaining22Source({ sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, ...next })
    }
    expect(isAuthorizedRemaining22Source({ sourceRunID: 'other-run', ...base }).ok).toBe(false)
    expect(check((n) => { n.canonical = null }).ok).toBe(false)
    expect(check((n) => { n.manifest.caseIDs = [...n.manifest.caseIDs].reverse() })).toMatchObject({ ok: false, reason: 'manifest-canonical-order-mismatch' })
    expect(check((n) => { n.manifest.prompts = [...n.manifest.prompts].reverse() })).toMatchObject({ ok: false, reason: 'manifest-canonical-prompt-order-mismatch' })
    expect(check((n) => { n.manifest.prompts[0] = { ...n.manifest.prompts[0], prompt: `${n.manifest.prompts[0].prompt} ` } })).toMatchObject({ ok: false, reason: 'manifest-canonical-prompt-mismatch' })
    expect(check((n) => { n.manifest.prompts[1] = { ...n.manifest.prompts[1], input: { ...n.manifest.prompts[1].input, extra: 1 } } })).toMatchObject({ ok: false, reason: 'manifest-canonical-input-mismatch' })
    expect(check((n) => { n.caseResult.prompt = `${n.caseResult.prompt} ` })).toMatchObject({ ok: false, reason: 'result-manifest-prompt-mismatch' })
    expect(check((n) => { n.caseResult.input = { ...n.caseResult.input, extra: 1 } })).toMatchObject({ ok: false, reason: 'result-manifest-input-mismatch' })
    expect(check((n) => { n.smokeEvaluation.remainingCaseIDs = [...n.smokeEvaluation.remainingCaseIDs].reverse() })).toMatchObject({ ok: false, reason: 'smoke-remaining-order-mismatch' })
    expect(check((n) => { n.smokeEvaluation.semanticVerdict = 'FAIL' }).ok).toBe(false)
    expect(check((n) => { n.smokeEvaluation.stdinPromptObserved = false }).ok).toBe(false)
    expect(check((n) => { n.smokeEvaluation.costUSD.api.value = 0.01 }).ok).toBe(false)
    expect(check((n) => { n.caseResult.text = 'not-json' }).ok).toBe(false)
    expect(check((n) => { n.caseResult.apiText = `${n.caseResult.text} ` }).ok).toBe(false)
    expect(check((n) => { n.caseResult.metadata.apiCostByCase.value = 1 }).ok).toBe(false)
    expect(check((n) => { n.caseResult.metadata.stdinPromptObserved = false }).ok).toBe(false)
    expect(check((n) => { n.reservationRecord = null }).ok).toBe(false)
    expect(check((n) => { n.reservationRecord.runNonce = 'other-nonce' })).toMatchObject({ ok: false, reason: 'hook-nonce-mismatch' })
    expect(check((n) => { n.hookEvents = n.hookEvents.map((e) => ({ ...e, runNonce: 'other-nonce' })) })).toMatchObject({ ok: false, reason: 'hook-nonce-mismatch' })
    expect(check((n) => { n.hookEvents = [...n.hookEvents, { event: 'http-request-allowed', sessionKey: 'other-session', runNonce: RUN_NONCE }] })).toMatchObject({ ok: false })
    expect(check((n) => { n.caseResult.hookEvidence = n.caseResult.hookEvidence.map((e) => e.event === 'http-request-allowed' ? { ...e, bodySha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' } : e) })).toMatchObject({ ok: false, reason: 'hook-body-mismatch' })
    expect(check((n) => { n.caseResult.hookEvidence = n.caseResult.hookEvidence.map((e) => e.event === 'http-request-allowed' ? { ...{ ...e }, bodySha256: undefined } : e) })).toMatchObject({ ok: false, reason: 'hook-body-sha-missing' })
    expect(check((n) => { n.caseResult.hookEvidence = n.caseResult.hookEvidence.map((e) => e.event === 'http-request-allowed' ? { ...e, bodyModel: 'other-model' } : e) })).toMatchObject({ ok: false, reason: 'hook-body-model-mismatch' })
    expect(check((n) => { n.caseResult.hookEvidence = n.caseResult.hookEvidence.map((e) => e.event === 'http-request-allowed' ? { ...{ ...e }, toolCount: undefined } : e) }).ok).toBe(false)
    expect(check((n) => { n.caseResult.metadata = { ...n.caseResult.metadata, requestBodySha256: undefined } })).toMatchObject({ ok: false, reason: 'hook-metadata-hash-missing' })
    expect(check((n) => { n.caseResult.metadata = { ...n.caseResult.metadata, requestBodySha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } })).toMatchObject({ ok: false, reason: 'hook-body-case-mismatch' })
    expect(check((n) => { n.caseResult.metadata = { ...n.caseResult.metadata, requestBodyModel: 'other-model' } })).toMatchObject({ ok: false, reason: 'hook-metadata-model-mismatch' })
    expect(check((n) => { n.caseResult.metadata = { ...n.caseResult.metadata, toolCount: undefined } })).toMatchObject({ ok: false, reason: 'hook-metadata-count-missing' })
    expect(check((n) => { n.caseResult.metadata = { ...n.caseResult.metadata, toolCount: 2 } })).toMatchObject({ ok: false, reason: 'hook-toolcount-mismatch' })
    expect(check((n) => { n.caseResult.hookEvidence = n.caseResult.hookEvidence.map((e) => e.event === 'http-request-allowed' ? { ...e, authorizationPresent: false } : e) }).ok).toBe(false)
    expect(check((n) => { n.hookEvents = [...n.hookEvents, { event: 'retry-decision', retry: true, runNonce: RUN_NONCE }] })).toMatchObject({ ok: false, reason: 'hook-retried' })
    expect(check((n) => { n.catalogPreflight.extraUsageStatus = 'enabled' }).ok).toBe(false)
    expect(check((n) => { n.caseResult.stop = { stop: true, category: 'other' } }).ok).toBe(false)
    expect(check((n) => { n.caseResult.reservation = 'reservations/other-model/F1-B005.consumed-smoke-2026-10-29T10-55-14-534Z-21048.json' })).toMatchObject({ ok: false, reason: 'result-reservation-mismatch' })
    expect(check((n) => { n.caseResult.reservation = `${AUTHORIZED_REMAINING22_RESERVATION_PATH}.bak` })).toMatchObject({ ok: false, reason: 'result-reservation-mismatch' })
    expect(check((n) => { n.caseResult.reservation = '' })).toMatchObject({ ok: false, reason: 'result-reservation-mismatch' })
    expect(check((n) => { n.reservationRecord = { ...n.reservationRecord, consumedSmoke: false } }).ok).toBe(false)
    expect(check((n) => { n.reservationRecord = { ...n.reservationRecord, sourceRunID: 'other-run' } })).toMatchObject({ ok: false, reason: 'reservation-source-mismatch' })
    expect(check((n) => { n.smokeEvaluation = { ...n.smokeEvaluation, responseText: '' } })).toMatchObject({ ok: false, reason: 'smoke-response-missing' })
    expect(check((n) => { n.caseResult = { ...n.caseResult, text: n.smokeEvaluation.responseText } }).ok).toBe(true)
    expect(check((n) => { n.smokeEvaluation = { ...n.smokeEvaluation, responseText: '{"interpretation":{"intent":"read"}}' } })).toMatchObject({ ok: false, reason: 'result-smoke-text-mismatch' })
  })

  it('re-evaluates the historic response with the real oracle before any claim: parser/schema/semantic PASS required', () => {
    const valid = buildValidSource()
    const reeval = evaluateF2B0Attempts([{ id: 'F1-B005', raw: valid.caseResult.text }])
    expect(reeval.results['F1-B005']).toMatchObject({ jsonValid: true, schemaValid: true })
    expect(reeval.evaluation.scenarios.find((row) => row.corpusId === 'F1-B005')?.verdict).toBe('PASS')
    expect(typeof valid.caseResult.text).toBe('string')
    expect(valid.caseResult.text.length).toBeGreaterThan(0)
    expect(typeof valid.smokeEvaluation.responseText).toBe('string')
    expect(valid.smokeEvaluation.responseText.length).toBeGreaterThan(0)
    expect(valid.caseResult.text).toBe(valid.smokeEvaluation.responseText)
    const invalidJson = evaluateF2B0Attempts([{ id: 'F1-B005', raw: 'not-json' }])
    expect(invalidJson.results['F1-B005']?.jsonValid).toBe(false)
    const schemaInvalid = evaluateF2B0Attempts([{ id: 'F1-B005', raw: '{"interpretation":{"intent":"read","operation":"none","args":{"unexpected":1},"contextProvenance":{"origin":"f1-corpus-text","corpusId":"F1-B005"},"entities":[],"ambiguities":[],"clarification":null,"missingFields":[]}}' }])
    expect(schemaInvalid.results['F1-B005']?.jsonValid).toBe(true)
    const oracleRow = schemaInvalid.evaluation.scenarios.find((row) => row.corpusId === 'F1-B005')
    expect(['FAIL', 'INCONCLUSIVE']).toContain(oracleRow?.verdict)
  })

  it('registers honest operator attestation only for exactly the 22 canonical ordered IDs', () => {
    const attestation = buildRemaining22Attestation({ runID: 'new-run', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, caseIDs: [...F2B0_CASE_IDS], completedCaseIDs: canonicalCampaignOrdered, expectedCaseIDs: [...F2B0_CASE_IDS], expectedCampaignCaseIDs: canonicalCampaignOrdered })
    expect(attestation).toMatchObject({ campaign: 'remaining22', campaignCaseCount: 22, serial: true, b1Included: false, retryIncluded: false, fallbackIncluded: false })
    expect(attestation.quota).toMatchObject({ source: 'operator-attestation', readback: 'unavailable' })
    expect(attestation.extraUsage).toMatchObject({ status: 'operator-attested-disabled' })
    expect(JSON.stringify(attestation)).toContain('not evidence of a billed amount')
    expect(() => buildRemaining22Attestation({ runID: 'new-run', sourceRunID: 'other', caseIDs: [...F2B0_CASE_IDS], completedCaseIDs: canonicalCampaignOrdered, expectedCaseIDs: [...F2B0_CASE_IDS], expectedCampaignCaseIDs: canonicalCampaignOrdered })).toThrow('limited to source')
    expect(() => buildRemaining22Attestation({ runID: 'new-run', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, caseIDs: [...F2B0_CASE_IDS], completedCaseIDs: [...canonicalCampaignOrdered].reverse(), expectedCaseIDs: [...F2B0_CASE_IDS], expectedCampaignCaseIDs: canonicalCampaignOrdered })).toThrow('exactly the 22 canonical campaign IDs in order')
    expect(() => buildRemaining22Attestation({ runID: 'new-run', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, caseIDs: [...F2B0_CASE_IDS], completedCaseIDs: [...canonicalCampaignOrdered.slice(0, 21), 'F1-B005'], expectedCaseIDs: [...F2B0_CASE_IDS], expectedCampaignCaseIDs: canonicalCampaignOrdered })).toThrow('exactly the 22 canonical campaign IDs in order')
    expect(() => buildRemaining22Attestation({ runID: 'new-run', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, caseIDs: [...F2B0_CASE_IDS], completedCaseIDs: canonicalCampaignOrdered })).toThrow('canonical')
  })

  it('evaluates the composite 22 plus historic smoke with provenance and stops on missing/nonzero cost', () => {
    const complete = [
      ...Object.entries(F2A1_LOCAL_CANDIDATES).map(([id, output]) => ({ id, raw: JSON.stringify(output) })),
      ...Object.entries(F2A1_LOCAL_JOURNEYS).flatMap(([journey, turns]) => turns.map((output, index) => ({ id: `${journey}:T${index + 1}`, raw: JSON.stringify(output) }))),
    ]
    expect(complete).toHaveLength(23)
    const historic = complete.find((attempt) => attempt.id === 'F1-B005')
    const campaign = complete.filter((attempt) => attempt.id !== 'F1-B005')
    expect(campaign.map((a) => a.id)).toEqual(canonicalCampaignOrdered)
    const composite = evaluateF2B0Attempts([historic, ...campaign], { requireComplete: true })
    expect(composite.complete).toBe(true)
    expect(composite.missingIds).toEqual([])
    const attestation = buildRemaining22Attestation({ runID: 'composite-run', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, caseIDs: [...F2B0_CASE_IDS], completedCaseIDs: campaign.map((a) => a.id), expectedCaseIDs: [...F2B0_CASE_IDS], expectedCampaignCaseIDs: canonicalCampaignOrdered })
    expect(attestation.campaignCaseIDs).toEqual(canonicalCampaignOrdered)
  })

  it('claims one exclusive reservation per campaign case deterministically, preserves history, crash fail-closed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-'))
    try {
      const historicFile = path.join(directory, 'F1-B005.reserved')
      await writeFile(historicFile, JSON.stringify({ runID: '2026-10-27T15-19-19-424Z-5620', caseID: 'F1-B005', status: 'reserved' }, null, 2))
      const before = await readFile(historicFile, 'utf8')
      expect(await listRemaining22Reservations(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID)).toEqual([])
      const first = canonicalCampaignOrdered[0]
      const created = await createRemaining22Reservation(directory, first, AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'campaign-run-1', runNonce: 'nonce-1', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID })
      expect(created).toContain(`${first}.remaining22-${AUTHORIZED_REMAINING22_SOURCE_RUN_ID}.json`)
      expect(await readFile(historicFile, 'utf8')).toBe(before)
      expect(remaining22FileName(directory, first, AUTHORIZED_REMAINING22_SOURCE_RUN_ID)).toBe(created)
      await expect(createRemaining22Reservation(directory, first, AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'campaign-run-2', runNonce: 'nonce-2', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await listRemaining22Reservations(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID)).toHaveLength(1)
      await expect(createRemaining22Reservation(directory, 'F1-B005', AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'campaign-run-1', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID })).rejects.toThrow('never reserve the historic smoke case')
      await expect(createRemaining22Reservation(directory, first, 'other-run', { runID: 'campaign-run-1', sourceRunID: 'other-run' })).rejects.toThrow('limited to source allowlist')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed on concurrent remaining22 claims with exactly one winner', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-race-'))
    try {
      const target = canonicalCampaignOrdered[1]
      const concurrent = await Promise.allSettled([
        createRemaining22Reservation(directory, target, AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'racer-a', runNonce: 'a', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID }),
        createRemaining22Reservation(directory, target, AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'racer-b', runNonce: 'b', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID }),
      ])
      expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(concurrent.filter((r) => r.status === 'rejected')).toHaveLength(1)
      expect(await listRemaining22Reservations(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID)).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('claims a single durable campaign record wx/sync before any prompt and blocks continuation after crash', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-campaign-'))
    try {
      expect(await listRemaining22CampaignClaims(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID)).toEqual([])
      const file = await createRemaining22CampaignClaim(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'campaign-run-1', runNonce: 'nonce-1', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID })
      expect(file).toBe(remaining22CampaignFileName(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID))
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ campaign: 'remaining22-campaign', status: 'reserved', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID, runID: 'campaign-run-1' })
      await expect(createRemaining22CampaignClaim(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'campaign-run-2', runNonce: 'nonce-2', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await listRemaining22CampaignClaims(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID)).toHaveLength(1)
      const concurrent = await Promise.allSettled([
        createRemaining22CampaignClaim(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'racer-a', runNonce: 'a', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID }),
        createRemaining22CampaignClaim(directory, AUTHORIZED_REMAINING22_SOURCE_RUN_ID, { runID: 'racer-b', runNonce: 'b', sourceRunID: AUTHORIZED_REMAINING22_SOURCE_RUN_ID }),
      ])
      expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(0)
      await expect(createRemaining22CampaignClaim(directory, 'other-run', { runID: 'x', sourceRunID: 'other-run' })).rejects.toThrow('limited to source allowlist')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('wires the remaining22 campaign claim after all inference-free preflights and readiness, before any prompt, serially without B1/retry', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    expect(runnerSource).toContain('--remaining22-authorized-run=2026-10-29T12-26-34-600Z-4324')
    expect(runnerSource).toContain('isAuthorizedRemaining22Source({')
    expect(runnerSource).toContain('canonical')
    expect(runnerSource).toContain('reservationRecord')
    expect(runnerSource).toContain('evaluateF2B0Attempts([{ id: REMAINING22_EXCLUDED_CASE_ID')
    expect(runnerSource).toContain('historic response failed parser/schema re-evaluation')
    expect(runnerSource).toContain('historic response failed oracle re-evaluation')
    expect(runnerSource).toContain('historic case text does not equal smoke response')
    expect(runnerSource).toContain('model request observed before campaign claim')
    expect(runnerSource).toContain('listRemaining22CampaignClaims(reservationDir, sourceRunID)')
    expect(runnerSource).toContain('createRemaining22CampaignClaim(reservationDir, sourceRunID')
    expect(runnerSource).toContain('listRemaining22Reservations(reservationDir, sourceRunID)')
    expect(runnerSource).toContain('createRemaining22Reservation(reservationDir, id, campaignSourceRunID')
    expect(runnerSource).toContain("campaign: 'remaining22'")
    expect(runnerSource).toContain('remaining22-attestation.json')
    expect(runnerSource).toContain('historicReservationPreserved')
    expect(runnerSource).toContain('expectedCampaignCaseIDs: executionPlan.run')
    const lockIdx = runnerSource.indexOf("createExclusiveRunLock(path.join(OUTPUT_ROOT, '.f2b0-real-run.lock')")
    const serverIdx = runnerSource.indexOf('await startServer(', lockIdx)
    const preflightIdx = runnerSource.indexOf('await preflightCatalog(', serverIdx)
    const quotaIdx = runnerSource.indexOf('await requireGoUsage(server.client', preflightIdx)
    const readyIdx = runnerSource.indexOf('await waitForPluginReady(', quotaIdx)
    const zeroReqIdx = runnerSource.indexOf('model request observed before campaign claim', readyIdx)
    const historyIdx = runnerSource.indexOf('isAuthorizedRemaining22Source({', zeroReqIdx)
    const reevalIdx = runnerSource.indexOf('evaluateF2B0Attempts([{ id: REMAINING22_EXCLUDED_CASE_ID', historyIdx)
    const campaignIdx = runnerSource.indexOf('await createRemaining22CampaignClaim(', reevalIdx)
    const sessionIdx = runnerSource.indexOf('session.create({', campaignIdx)
    const createIdx = runnerSource.indexOf('await createRemaining22Reservation(', sessionIdx)
    const captureIdx = runnerSource.indexOf('await captureCli(', createIdx)
    for (const idx of [lockIdx, serverIdx, preflightIdx, quotaIdx, readyIdx, zeroReqIdx, historyIdx, reevalIdx, campaignIdx, sessionIdx, createIdx, captureIdx]) expect(idx).toBeGreaterThan(-1)
    expect(serverIdx).toBeGreaterThan(lockIdx)
    expect(preflightIdx).toBeGreaterThan(serverIdx)
    expect(quotaIdx).toBeGreaterThan(preflightIdx)
    expect(readyIdx).toBeGreaterThan(quotaIdx)
    expect(zeroReqIdx).toBeGreaterThan(readyIdx)
    expect(historyIdx).toBeGreaterThan(zeroReqIdx)
    expect(reevalIdx).toBeGreaterThan(historyIdx)
    expect(campaignIdx).toBeGreaterThan(reevalIdx)
    expect(sessionIdx).toBeGreaterThan(campaignIdx)
    expect(createIdx).toBeGreaterThan(sessionIdx)
    expect(captureIdx).toBeGreaterThan(createIdx)
    const betweenPlanAndServer = runnerSource.slice(runnerSource.lastIndexOf('resolveRealExecutionPlan({'), serverIdx)
    expect(betweenPlanAndServer).not.toContain('await createRemaining22Reservation(')
    expect(betweenPlanAndServer).not.toContain('await createRemaining22CampaignClaim(')
    expect(runnerSource).not.toContain('remaining22 and B1')
  })

  it('never consumes the campaign when a preflight fails: the claim is unreachable after a preflight throw', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    const serverIdx = runnerSource.indexOf('await startServer(')
    const preflightIdx = runnerSource.indexOf('await preflightCatalog(', serverIdx)
    const quotaIdx = runnerSource.indexOf('await requireGoUsage(server.client', preflightIdx)
    const readyIdx = runnerSource.indexOf('await waitForPluginReady(', quotaIdx)
    const claimIdx = runnerSource.indexOf('await createRemaining22CampaignClaim(', readyIdx)
    for (const idx of [serverIdx, preflightIdx, quotaIdx, readyIdx, claimIdx]) expect(idx).toBeGreaterThan(-1)
    expect(claimIdx).toBeGreaterThan(preflightIdx)
    expect(claimIdx).toBeGreaterThan(quotaIdx)
    expect(claimIdx).toBeGreaterThan(readyIdx)
    const preClaimSegment = runnerSource.slice(serverIdx, claimIdx)
    expect(preClaimSegment).not.toContain('await captureCli(')
    expect(preClaimSegment).not.toContain('session.create({')
    expect(preClaimSegment).not.toContain('await createRemaining22Reservation(')
  })
})
