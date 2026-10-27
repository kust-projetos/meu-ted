import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUTHORIZED_RETRY_CASE_ID,
  AUTHORIZED_RETRY_SOURCE_RUN_ID,
  isAuthorizedFatalRetrySource,
  parseExecutionMode,
  planAuthorizedRetry,
  resolveRealExecutionPlan,
} from './real-guard.mjs'
import {
  createAuthorizedRetryReservation,
  listAuthorizedRetryReservations,
} from './real-storage.mjs'

const exactArgv = [
  '--execute-real',
  '--confirm-model=opencode-go/deepseek-v4.1-flash',
  '--confirm-go-quota-available',
  '--confirm-go-extra-usage-disabled',
  '--smoke-only',
  `--retry-authorized-case=${AUTHORIZED_RETRY_CASE_ID}`,
  `--retry-authorized-run=${AUTHORIZED_RETRY_SOURCE_RUN_ID}`,
]

const validReservation = {
  runID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
  runNonce: 'f33c550c-2700-4758-8cde-455d8d762e93',
  caseID: AUTHORIZED_RETRY_CASE_ID,
  status: 'reserved',
  reservedAt: '2026-10-27T15:19:22.536Z',
}

const validResult = {
  caseID: AUTHORIZED_RETRY_CASE_ID,
  fatal: true,
  attemptCount: 1,
  request: {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4.1-flash',
    url: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    requestCount: 1,
  },
  text: '',
  apiText: '',
  metadata: {
    assistantOutcome: {
      terminal: true,
      category: 'assistant-terminal-error',
      error: { type: 'provider.auth', status: 401 },
    },
  },
  hookEvidence: [
    { event: 'http-request-allowed', requestCount: 1, kind: 'primary', toolCount: 0, authorizationPresent: false },
    { event: 'http-response', status: 401 },
    { event: 'retry-decision', attempt: 2, retry: false },
  ],
}

describe('F1-B005 authorized fatal-401 retry', () => {
  it('pins the authorized pair to the exact fatal 401 run', () => {
    expect(AUTHORIZED_RETRY_CASE_ID).toBe('F1-B005')
    expect(AUTHORIZED_RETRY_SOURCE_RUN_ID).toBe('2026-10-27T15-19-19-424Z-5620')
  })

  it('requires exact smoke-only authorization for the retry', () => {
    expect(parseExecutionMode(exactArgv)).toMatchObject({
      execute: true,
      smokeOnly: true,
      retryCaseID: 'F1-B005',
      retryRunID: '2026-10-27T15-19-19-424Z-5620',
    })
    expect(() => parseExecutionMode(exactArgv.filter((a) => a !== '--smoke-only'))).toThrow('authorized retry requires')
    expect(() => parseExecutionMode(exactArgv.filter((a) => !a.startsWith('--confirm-go-quota')))).toThrow()
    expect(() => parseExecutionMode([...exactArgv, '--resume=prior-run'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode(exactArgv.map((a) => a.startsWith('--retry-authorized-case=') ? '--retry-authorized-case=F1-B010' : a))).toThrow('limited to F1-B005')
    expect(() => parseExecutionMode(exactArgv.map((a) => a.startsWith('--retry-authorized-run=') ? '--retry-authorized-run=other-run' : a))).toThrow('limited to F1-B005')
    expect(() => parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/deepseek-v4.1-flash', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only', '--retry-authorized-case=F1-B005'])).toThrow('both case and run')
  })

  it('validates the historic reservation and its associated fatal 401 result', () => {
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: validResult })).toEqual({ ok: true })
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: null, sourceResult: validResult }).ok).toBe(false)
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: null }).ok).toBe(false)
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B010', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: validResult }).ok).toBe(false)
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: { ...validReservation, runID: 'other-run' }, sourceResult: validResult })).toMatchObject({ ok: false })
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: { ...validResult, fatal: false } })).toMatchObject({ ok: false })
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: { ...validResult, text: '{"interpretation":{}}' } })).toMatchObject({ ok: false })
  })

  it('refuses non-401, auth-present, or retried sources', () => {
    const no401 = { ...validResult, hookEvidence: validResult.hookEvidence.filter((e) => e.event !== 'http-response') }
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: no401 }).ok).toBe(false)
    const authPresent = { ...validResult, hookEvidence: validResult.hookEvidence.map((e) => e.event === 'http-request-allowed' ? { ...e, authorizationPresent: true } : e) }
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: authPresent }).ok).toBe(false)
    const retried = { ...validResult, hookEvidence: validResult.hookEvidence.map((e) => e.event === 'retry-decision' ? { ...e, retry: true } : e), request: { ...validResult.request, requestCount: 2 }, attemptCount: 2 }
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: retried }).ok).toBe(false)
    const missingToolCount = { ...validResult, hookEvidence: [{ event: 'http-request-allowed', requestCount: 1, kind: 'primary', authorizationPresent: false }, { event: 'http-response', status: 401 }, { event: 'retry-decision', attempt: 2, retry: false }] }
    expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord: validReservation, sourceResult: missingToolCount })).toMatchObject({ ok: false, reason: 'result-tools-present' })
  })

  it('selects only the authorized case and never other cases', () => {
    const caseIDs = ['F1-B005', 'F1-B010', 'F1-B012']
    expect(planAuthorizedRetry({ caseIDs, unresolvedReservations: ['F1-B005'], retryCaseID: 'F1-B005' })).toEqual({ run: ['F1-B005'], deferred: ['F1-B010', 'F1-B012'] })
    expect(() => planAuthorizedRetry({ caseIDs, unresolvedReservations: ['F1-B005'], retryCaseID: 'F1-B010' })).toThrow()
    expect(() => planAuthorizedRetry({ caseIDs, unresolvedReservations: ['F1-B005', 'F1-B010'], retryCaseID: 'F1-B005' })).toThrow('exactly')
  })

  it('reaches the authorized branch offline with F1-B005 reservation and exact flags, without provider or real evidence', () => {
    const caseIDs = ['F1-B005', 'F1-B010', 'F1-B012']
    expect(() => resolveRealExecutionPlan({ caseIDs, existingIDs: [], reservedIDs: ['F1-B005'], options: { smokeOnly: true } })).toThrow()
    const authorized = resolveRealExecutionPlan({
      caseIDs,
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: { smokeOnly: true, retryCaseID: 'F1-B005', retryRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID },
    })
    expect(authorized.authorized).toBe(true)
    expect(authorized.executionPlan).toEqual({ run: ['F1-B005'], deferred: ['F1-B010', 'F1-B012'] })
    expect(authorized.plan.unresolvedReservations).toEqual(['F1-B005'])
    expect(() => resolveRealExecutionPlan({
      caseIDs,
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: { smokeOnly: true, retryCaseID: 'F1-B010', retryRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID },
    })).toThrow()
    expect(() => resolveRealExecutionPlan({
      caseIDs,
      existingIDs: ['F1-B005'],
      reservedIDs: ['F1-B005'],
      options: { smokeOnly: true, retryCaseID: 'F1-B005', retryRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID },
    })).toThrow()
    expect(() => resolveRealExecutionPlan({
      caseIDs,
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: { smokeOnly: false, retryCaseID: 'F1-B005', retryRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID },
    })).toThrow()
  })

  it('creates the authorized reservation only after preflight/quota, never on preflight failure', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    const planIdx = runnerSource.lastIndexOf('resolveRealExecutionPlan({')
    const startIdx = runnerSource.indexOf('await startServer(', planIdx)
    const preflightIdx = runnerSource.indexOf('await preflightCatalog(', startIdx)
    const quotaIdx = runnerSource.indexOf('await requireGoUsage(server.client', preflightIdx)
    const sessionIdx = runnerSource.indexOf('session.create(', quotaIdx)
    const readyIdx = runnerSource.indexOf('await waitForPluginReady(', sessionIdx)
    const createIdx = runnerSource.indexOf('await createAuthorizedRetryReservation(', readyIdx)
    const captureIdx = runnerSource.indexOf('await captureCli(', createIdx)
    expect(planIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeGreaterThan(planIdx)
    expect(preflightIdx).toBeGreaterThan(startIdx)
    expect(quotaIdx).toBeGreaterThan(preflightIdx)
    expect(sessionIdx).toBeGreaterThan(quotaIdx)
    expect(readyIdx).toBeGreaterThan(sessionIdx)
    expect(createIdx).toBeGreaterThan(readyIdx)
    expect(captureIdx).toBeGreaterThan(createIdx)
    const betweenPlanAndServer = runnerSource.slice(planIdx, startIdx)
    expect(betweenPlanAndServer).not.toContain('createAuthorizedRetryReservation')
    const betweenSessionAndCreate = runnerSource.slice(sessionIdx, createIdx)
    expect(betweenSessionAndCreate).toContain('waitForPluginReady')
    const postPreflight = runnerSource.slice(preflightIdx, createIdx)
    expect(postPreflight).toContain('listAuthorizedRetryReservations')

    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-authorized-retry-order-'))
    try {
      await writeFile(path.join(directory, 'F1-B005.reserved'), JSON.stringify(validReservation, null, 2))
      const resolved = resolveRealExecutionPlan({
        caseIDs: ['F1-B005', 'F1-B010', 'F1-B012'],
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: { smokeOnly: true, retryCaseID: 'F1-B005', retryRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID },
      })
      expect(resolved.authorized).toBe(true)
      const reservationRecord = JSON.parse(await readFile(path.join(directory, 'F1-B005.reserved'), 'utf8'))
      expect(isAuthorizedFatalRetrySource({ caseID: 'F1-B005', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, reservationRecord, sourceResult: validResult })).toEqual({ ok: true })
      expect(await listAuthorizedRetryReservations(directory, 'F1-B005')).toEqual([])
      try {
        throw new Error('simulated-preflight-failure')
      } catch {
        expect(await listAuthorizedRetryReservations(directory, 'F1-B005')).toEqual([])
      }
      const created = await createAuthorizedRetryReservation(directory, 'F1-B005', 'post-preflight-run', { runID: 'post-preflight-run', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID })
      expect(created).toContain('authorized-retry-post-preflight-run')
      expect(await listAuthorizedRetryReservations(directory, 'F1-B005')).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('creates an independent auditable reservation without mutating the historic one and blocks a second attempt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-authorized-retry-'))
    try {
      const historicFile = path.join(directory, 'F1-B005.reserved')
      await writeFile(historicFile, JSON.stringify(validReservation, null, 2))
      const before = await readFile(historicFile, 'utf8')
      expect(await listAuthorizedRetryReservations(directory, 'F1-B005')).toEqual([])
      const retryFile = await createAuthorizedRetryReservation(directory, 'F1-B005', 'new-run-1', { runID: 'new-run-1', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID })
      expect(retryFile).not.toBe(historicFile)
      expect(await readFile(historicFile, 'utf8')).toBe(before)
      const listed = await listAuthorizedRetryReservations(directory, 'F1-B005')
      expect(listed).toHaveLength(1)
      expect(JSON.parse(await readFile(listed[0], 'utf8'))).toMatchObject({ caseID: 'F1-B005', authorizedRetry: true, sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID, runID: 'new-run-1' })
      await expect(createAuthorizedRetryReservation(directory, 'F1-B005', 'new-run-1', { runID: 'new-run-1', sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await listAuthorizedRetryReservations(directory, 'F1-B005')).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
