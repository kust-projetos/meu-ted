import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUTHORIZED_REMAINING22_SOURCE_RUN_ID,
  AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2,
  AUTHORIZED_REMAINING22_SOURCE_RUN_IDS,
  AUTHORIZED_REMAINING22_S4_RESERVATION_PATH,
  REMAINING22_EXCLUDED_CASE_ID,
  MAX_CASES,
  REAL_MODEL,
  REAL_URL,
  isAuthorizedRemaining22Source,
  isAuthorizedRemaining22SourceRunID,
  parseExecutionMode,
  planRemaining22,
  resolveRealExecutionPlan,
} from './real-guard.mjs'
import {
  createRemaining22Reservation,
  listRemaining22Reservations,
  createRemaining22CampaignClaim,
  listRemaining22CampaignClaims,
} from './real-storage.mjs'
import { getF2B0Cases, F2B0_CASE_IDS } from '../f2b0-adapter.ts'

const S1 = '2026-10-29T12-26-34-600Z-4324'
const S2 = '2026-10-29T20-54-25-649Z-6500'
const S3 = '2026-10-29T22-22-00-788Z-21356'
const S4 = '2026-10-29T22-34-44-294Z-10836'
const S5 = '2026-10-29T00-00-00-000Z-0000'

const canonicalCases = getF2B0Cases()
const canonical = {
  caseIDs: canonicalCases.map((entry) => entry.id),
  prompts: canonicalCases.map((entry) => ({ id: entry.id, input: entry.input, prompt: entry.prompt })),
}
const canonicalCampaignOrdered = canonical.caseIDs.filter((id) => id !== REMAINING22_EXCLUDED_CASE_ID)

const RUN_NONCE = '6b75c23e-657a-4230-85ac-7b37a573bbb4'
const SESSION_KEY = '75887b18e017'
const BODY_SHA = '7008bd43749116eb91f11bff72ee686b410d2ecd7ae74fd802b6db63080d13d3'

const exactArgvFor = (runID) => [
  '--execute-real',
  '--confirm-model=opencode-go/muse-spark-1.3-contributor',
  '--confirm-go-quota-available',
  '--confirm-go-extra-usage-disabled',
  `--remaining22-authorized-run=${runID}`,
]

const buildValidS4Source = () => {
  const caseIDs = [...canonical.caseIDs]
  const remaining = [...canonicalCampaignOrdered]
  const manifest = {
    runID: S4,
    provider: REAL_MODEL.providerID,
    model: REAL_MODEL.modelID,
    nativeURL: REAL_URL,
    caseIDs,
    prompts: canonical.prompts.map((entry) => ({ id: entry.id, input: entry.input, prompt: entry.prompt })),
  }
  const smokeEvaluation = {
    schemaVersion: 'f2b0-go-single-smoke-v1',
    status: 'SMOKE_PASS_OPERATOR_ATTESTED_NO_CONTINUATION',
    runID: S4,
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
    reservation: 'reservations/opencode-go-muse-spark-1.3-contributor/F1-B005.fresh-smoke-2026-10-29T22-34-44-294Z-10836.json',
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
    runID: S4,
    runNonce: RUN_NONCE,
    sourceMarker: 'fresh',
    caseID: 'F1-B005',
    status: 'reserved',
    freshSmoke: true,
  }
  return { manifest, smokeEvaluation: smokeEvaluationWithResponse, caseResult, catalogPreflight, hookEvents, reservationRecord, remaining, canonical }
}

describe('F2B0 remaining22 third source S4 (allowlist [S1,S2,S4], per-source single-claim)', () => {
  it('pins exactly three authorized sources (S1, S2, S4 literais, nunca curinga); S3 segue fora', async () => {
    const guardSource = await readFile(new URL('./real-guard.mjs', import.meta.url), 'utf8')
    expect(guardSource).toContain(S1)
    expect(guardSource).toContain(S2)
    expect(guardSource).toContain(S4)
    expect(AUTHORIZED_REMAINING22_SOURCE_RUN_ID).toBe(S1)
    expect(AUTHORIZED_REMAINING22_SOURCE_RUN_ID_2).toBe(S2)
    expect(AUTHORIZED_REMAINING22_SOURCE_RUN_IDS).toEqual([S1, S2, S4])
    expect(isAuthorizedRemaining22SourceRunID(S1)).toBe(true)
    expect(isAuthorizedRemaining22SourceRunID(S2)).toBe(true)
    expect(isAuthorizedRemaining22SourceRunID(S4)).toBe(true)
    expect(isAuthorizedRemaining22SourceRunID(S3)).toBe(false)
    expect(isAuthorizedRemaining22SourceRunID(S5)).toBe(false)
    expect(isAuthorizedRemaining22SourceRunID(undefined)).toBe(false)
  })

  it('accepts the S4 flag with exact confirmations; refuses S3/S5', () => {
    expect(parseExecutionMode(exactArgvFor(S4))).toMatchObject({ execute: true, remaining22RunID: S4, smokeOnly: false })
    expect(parseExecutionMode(exactArgvFor(S1))).toMatchObject({ execute: true, remaining22RunID: S1 })
    expect(parseExecutionMode(exactArgvFor(S2))).toMatchObject({ execute: true, remaining22RunID: S2 })
    expect(() => parseExecutionMode(exactArgvFor(S3))).toThrow(/limited to source|not-authorized/)
    expect(() => parseExecutionMode(exactArgvFor(S5))).toThrow(/limited to source|not-authorized/)
  })

  it('plans the 22 canonical cases for S4; refuses S3/S5', () => {
    expect(planRemaining22({ caseIDs: [...F2B0_CASE_IDS], sourceRunID: S4 }).run).toEqual(canonicalCampaignOrdered)
    expect(() => planRemaining22({ caseIDs: [...F2B0_CASE_IDS], sourceRunID: S3 })).toThrow(/limited to source/)
    expect(() => planRemaining22({ caseIDs: [...F2B0_CASE_IDS], sourceRunID: S5 })).toThrow(/limited to source/)
  })

  it('pins the exact S4 fresh-smoke reservation path and authorizes the S4 fresh chain; S3 sempre recusa', () => {
    expect(AUTHORIZED_REMAINING22_S4_RESERVATION_PATH).toBe('reservations/opencode-go-muse-spark-1.3-contributor/F1-B005.fresh-smoke-2026-10-29T22-34-44-294Z-10836.json')
    const valid = buildValidS4Source()
    expect(valid.caseResult.reservation).toBe('reservations/opencode-go-muse-spark-1.3-contributor/F1-B005.fresh-smoke-2026-10-29T22-34-44-294Z-10836.json')
    expect(isAuthorizedRemaining22Source({ sourceRunID: S4, ...valid })).toEqual({ ok: true })
    expect(isAuthorizedRemaining22Source({ sourceRunID: S3, ...valid }).ok).toBe(false)
    expect(isAuthorizedRemaining22Source({ sourceRunID: S5, ...valid }).ok).toBe(false)
  })

  it('keeps single-claim per source: S4 accepts once then refuses; S1/S2 namespaces intact; S3/S5 recusadas', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-s4-'))
    try {
      const first = canonicalCampaignOrdered[0]
      await createRemaining22CampaignClaim(directory, S1, { runID: 'campaign-s1', runNonce: 'n1', sourceRunID: S1 })
      expect(await listRemaining22CampaignClaims(directory, S1)).toHaveLength(1)
      await createRemaining22CampaignClaim(directory, S2, { runID: 'campaign-s2', runNonce: 'n2', sourceRunID: S2 })
      expect(await listRemaining22CampaignClaims(directory, S2)).toHaveLength(1)
      const s4claim = await createRemaining22CampaignClaim(directory, S4, { runID: 'campaign-s4', runNonce: 'n3', sourceRunID: S4 })
      expect(s4claim).toContain(S4)
      expect(await listRemaining22CampaignClaims(directory, S4)).toHaveLength(1)
      await expect(createRemaining22CampaignClaim(directory, S4, { runID: 'campaign-s4-retry', runNonce: 'n4', sourceRunID: S4 })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await listRemaining22CampaignClaims(directory, S1)).toHaveLength(1)
      expect(await listRemaining22CampaignClaims(directory, S2)).toHaveLength(1)
      expect(await listRemaining22CampaignClaims(directory)).toHaveLength(3)
      await expect(createRemaining22Reservation(directory, first, S4, { runID: 'campaign-s4', runNonce: 'n3', sourceRunID: S4 })).resolves.toContain(`remaining22-${S4}.json`)
      await expect(createRemaining22Reservation(directory, first, S4, { runID: 'campaign-s4-retry', runNonce: 'n4', sourceRunID: S4 })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await listRemaining22Reservations(directory, S4)).toHaveLength(1)
      expect(await listRemaining22Reservations(directory, S1)).toHaveLength(0)
      expect(await listRemaining22Reservations(directory, S2)).toHaveLength(0)
      await expect(createRemaining22Reservation(directory, first, S3, { runID: 'x', sourceRunID: S3 })).rejects.toThrow(/limited to|not-authorized/)
      await expect(createRemaining22CampaignClaim(directory, S3, { runID: 'x', sourceRunID: S3 })).rejects.toThrow(/limited to|not-authorized/)
      await expect(createRemaining22Reservation(directory, first, S5, { runID: 'x', sourceRunID: S5 })).rejects.toThrow(/limited to|not-authorized/)
      await expect(createRemaining22CampaignClaim(directory, S5, { runID: 'x', sourceRunID: S5 })).rejects.toThrow(/limited to|not-authorized/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resolves the S4 plan offline; S1/S2 still claimed in separate namespaces', () => {
    const resolved = resolveRealExecutionPlan({
      caseIDs: [...F2B0_CASE_IDS],
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: { remaining22RunID: S4 },
    })
    expect(resolved.authorized).toBe(true)
    expect(resolved.campaign).toBe('remaining22')
    expect(resolved.executionPlan.run).toEqual(canonicalCampaignOrdered)
    expect(MAX_CASES).toBe(23)
  })
})
