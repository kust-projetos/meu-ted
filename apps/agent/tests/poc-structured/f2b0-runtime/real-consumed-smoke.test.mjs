import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUTHORIZED_CONSUMED_SMOKE_CASE_ID,
  AUTHORIZED_CONSUMED_SMOKE_RESERVATION_PATH,
  AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
  AUTHORIZED_RETRY_CASE_ID,
  AUTHORIZED_RETRY_SOURCE_RUN_ID,
  applyConsumedSmokeTerminalPolicy,
  evaluateGoSmoke,
  isAuthorizedConsumedSingleSmokeSource,
  isAuthorizedFatalRetrySource,
  parseExecutionMode,
  planConsumedSmoke,
  resolveRealExecutionPlan,
} from './real-guard.mjs'
import {
  createAuthorizedRetryReservation,
  createConsumedSmokeReservation,
  listAuthorizedRetryReservations,
  listConsumedSmokeReservations,
} from './real-storage.mjs'

const consumedReservation = {
  runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
  runNonce: '27ad5f3b-2171-4e2e-8545-4dc405354369',
  sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
  caseID: 'F1-B005',
  status: 'reserved',
  authorizedRetry: true,
}

const consumedResult = {
  caseID: 'F1-B005',
  fatal: true,
  attemptCount: 1,
  // Exact historic path as persisted in evidence (Windows separators, single backslashes at runtime).
  reservation: 'reservations\\opencode-go-deepseek-v4.1-flash\\F1-B005.authorized-retry-2026-10-29T10-55-14-534Z-21048.json',
  request: {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4.1-flash',
    url: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    requestCount: 1,
  },
  text: '{"interpretation":{"intent":"read","operation":"list_accounts_payable"}}',
  apiText: '{"interpretation":{"intent":"read","operation":"list_accounts_payable"}}',
  apiTextMatchesStdout: true,
  stop: { stop: true, category: 'stdin-prompt-not-confirmed' },
  metadata: {
    stdinPromptObserved: false,
    assistantOutcome: { terminal: false, category: 'assistant-nonterminal' },
  },
  hookEvidence: [
    {
      event: 'http-request-allowed',
      requestCount: 1,
      kind: 'primary',
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      toolCount: 0,
      authorizationPresent: true,
    },
    { event: 'http-response', status: 200 },
  ],
}

describe('F1-B005 consumed single smoke 2026-10-29T10-55-14-534Z-21048 (closed exception)', () => {
  it('pins the consumed pair without reopening the 401 retry', () => {
    expect(AUTHORIZED_CONSUMED_SMOKE_CASE_ID).toBe('F1-B005')
    expect(AUTHORIZED_CONSUMED_SMOKE_RUN_ID).toBe('2026-10-29T10-55-14-534Z-21048')
    expect(AUTHORIZED_RETRY_CASE_ID).toBe('F1-B005')
    expect(AUTHORIZED_RETRY_SOURCE_RUN_ID).toBe('2026-10-27T15-19-19-424Z-5620')
    expect(AUTHORIZED_CONSUMED_SMOKE_RUN_ID).not.toBe(AUTHORIZED_RETRY_SOURCE_RUN_ID)
  })

  it('accepts the observed single-request HTTP200 shape with auth, no tools, no retry, stdin stop', () => {
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        caseID: 'F1-B005',
        runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        reservationRecord: consumedReservation,
        sourceResult: consumedResult,
      }),
    ).toEqual({ ok: true })
  })

  it('refuses wrong pair, missing reservation/result, or non-authorized reservation', () => {
    const base = {
      caseID: 'F1-B005',
      runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
      reservationRecord: consumedReservation,
      sourceResult: consumedResult,
    }
    expect(isAuthorizedConsumedSingleSmokeSource({ ...base, caseID: 'F1-B010' }).ok).toBe(false)
    expect(isAuthorizedConsumedSingleSmokeSource({ ...base, runID: 'other-run' }).ok).toBe(false)
    expect(isAuthorizedConsumedSingleSmokeSource({ ...base, reservationRecord: null }).ok).toBe(false)
    expect(isAuthorizedConsumedSingleSmokeSource({ ...base, sourceResult: null }).ok).toBe(false)
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        reservationRecord: { ...consumedReservation, authorizedRetry: false },
      }).ok,
    ).toBe(false)
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        reservationRecord: { ...consumedReservation, sourceRunID: 'other-run' },
      }).ok,
    ).toBe(false)
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        reservationRecord: { ...consumedReservation, runID: 'other-run' },
      }).ok,
    ).toBe(false)
  })

  it('refuses crossed reservation/result bindings (runID, sourceRunID, and result reservation must agree)', () => {
    const base = {
      caseID: 'F1-B005',
      runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
      reservationRecord: consumedReservation,
      sourceResult: consumedResult,
    }
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        sourceResult: { ...consumedResult, reservation: undefined },
      }),
    ).toMatchObject({ ok: false, reason: 'result-reservation-mismatch' })
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        sourceResult: {
          ...consumedResult,
          reservation: `reservations/opencode-go-deepseek-v4.1-flash/F1-B005.authorized-retry-other-run.json`,
        },
      }),
    ).toMatchObject({ ok: false, reason: 'result-reservation-mismatch' })
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        reservationRecord: { ...consumedReservation, runID: 'other-run' },
        sourceResult: consumedResult,
      }),
    ).toMatchObject({ ok: false, reason: 'reservation-run-mismatch' })
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        reservationRecord: { ...consumedReservation, sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID },
        sourceResult: consumedResult,
      }),
    ).toMatchObject({ ok: false, reason: 'reservation-source-mismatch' })
  })

  it('pins the exact historic reservation path and accepts only Windows/POSIX separator equivalence', () => {
    expect(AUTHORIZED_CONSUMED_SMOKE_RESERVATION_PATH).toBe(
      'reservations/opencode-go-deepseek-v4.1-flash/F1-B005.authorized-retry-2026-10-29T10-55-14-534Z-21048.json',
    )
    const base = {
      caseID: 'F1-B005',
      runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
      reservationRecord: consumedReservation,
    }
    // Exact historic form persisted in evidence (single backslashes at runtime).
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        sourceResult: {
          ...consumedResult,
          reservation:
            'reservations\\opencode-go-deepseek-v4.1-flash\\F1-B005.authorized-retry-2026-10-29T10-55-14-534Z-21048.json',
        },
      }),
    ).toEqual({ ok: true })
    // POSIX separator form is the only accepted equivalence.
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        sourceResult: { ...consumedResult, reservation: AUTHORIZED_CONSUMED_SMOKE_RESERVATION_PATH },
      }),
    ).toEqual({ ok: true })
  })

  it('refuses forged reservation paths: prefix, suffix, directory, absolute, traversal, or case variants', () => {
    const base = {
      caseID: 'F1-B005',
      runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
      reservationRecord: consumedReservation,
      sourceResult: consumedResult,
    }
    const exact = AUTHORIZED_CONSUMED_SMOKE_RESERVATION_PATH
    const forgeries = [
      `evil/${exact}`,
      `./${exact}`,
      `${exact}.bak`,
      `${exact}/`,
      `${exact} `,
      `reservations/other-model/F1-B005.authorized-retry-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`,
      `other/reservations/opencode-go-deepseek-v4.1-flash/F1-B005.authorized-retry-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`,
      `/reservations/opencode-go-deepseek-v4.1-flash/F1-B005.authorized-retry-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`,
      `RESERVATIONS/opencode-go-deepseek-v4.1-flash/F1-B005.authorized-retry-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`,
      `reservations/opencode-go-deepseek-v4.1-flash/../opencode-go-deepseek-v4.1-flash/F1-B005.authorized-retry-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`,
      `reservations/opencode-go-deepseek-v4.1-flash/F1-B005.authorized-retry-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json `,
      '',
    ]
    for (const reservation of forgeries) {
      expect(
        isAuthorizedConsumedSingleSmokeSource({ ...base, sourceResult: { ...consumedResult, reservation } }),
        `forgery must refuse: ${reservation}`,
      ).toMatchObject({ ok: false, reason: 'result-reservation-mismatch' })
    }
  })

  it('refuses auth-absent, tools-present, retried, non-200, or empty-output variants', () => {
    const base = {
      caseID: 'F1-B005',
      runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
      reservationRecord: consumedReservation,
    }
    const authAbsent = {
      ...consumedResult,
      hookEvidence: consumedResult.hookEvidence.map((e) =>
        e.event === 'http-request-allowed' ? { ...e, authorizationPresent: false } : e,
      ),
    }
    expect(isAuthorizedConsumedSingleSmokeSource({ ...base, sourceResult: authAbsent }).ok).toBe(false)
    const toolsPresent = {
      ...consumedResult,
      hookEvidence: consumedResult.hookEvidence.map((e) =>
        e.event === 'http-request-allowed' ? { ...e, toolCount: 1 } : e,
      ),
    }
    expect(isAuthorizedConsumedSingleSmokeSource({ ...base, sourceResult: toolsPresent }).ok).toBe(false)
    const retried = {
      ...consumedResult,
      request: { ...consumedResult.request, requestCount: 2 },
      attemptCount: 2,
      hookEvidence: [
        ...consumedResult.hookEvidence,
        { event: 'retry-decision', attempt: 2, retry: true },
      ],
    }
    expect(isAuthorizedConsumedSingleSmokeSource({ ...base, sourceResult: retried }).ok).toBe(false)
    const not200 = {
      ...consumedResult,
      hookEvidence: consumedResult.hookEvidence.map((e) =>
        e.event === 'http-response' ? { ...e, status: 401 } : e,
      ),
    }
    expect(isAuthorizedConsumedSingleSmokeSource({ ...base, sourceResult: not200 }).ok).toBe(false)
    expect(
      isAuthorizedConsumedSingleSmokeSource({ ...base, sourceResult: { ...consumedResult, text: '' } }).ok,
    ).toBe(false)
    expect(
      isAuthorizedConsumedSingleSmokeSource({
        ...base,
        sourceResult: { ...consumedResult, stop: { stop: true, category: 'other' } },
      }).ok,
    ).toBe(false)
  })

  it('never accepts the consumed run as a retry source flags even with exact smoke-only confirmations', () => {
    const argv = [
      '--execute-real',
      '--confirm-model=opencode-go/deepseek-v4.1-flash',
      '--confirm-go-quota-available',
      '--confirm-go-extra-usage-disabled',
      '--smoke-only',
      '--retry-authorized-case=F1-B005',
      `--retry-authorized-run=${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}`,
    ]
    expect(() => parseExecutionMode(argv)).toThrow('limited to F1-B005')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs: ['F1-B005', 'F1-B010'],
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: { smokeOnly: true, retryCaseID: 'F1-B005', retryRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID },
      }),
    ).toThrow('limited to F1-B005')
  })

  it('blocks any continuation via resume for the consumed smoke even with PASS-like usage', () => {
    expect(() =>
      parseExecutionMode([
        '--execute-real',
        '--confirm-model=opencode-go/deepseek-v4.1-flash',
        '--confirm-go-quota-available',
        '--confirm-go-extra-usage-disabled',
        '--smoke-only',
        '--resume=2026-10-29T10-55-14-534Z-21048',
        '--retry-authorized-case=F1-B005',
        `--retry-authorized-run=${AUTHORIZED_RETRY_SOURCE_RUN_ID}`,
      ]),
    ).toThrow('cannot be combined')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs: ['F1-B005', 'F1-B010'],
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: {
          smokeOnly: true,
          resumeID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
          retryCaseID: 'F1-B005',
          retryRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
        },
      }),
    ).toThrow('cannot be combined')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs: ['F1-B005', 'F1-B010'],
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: { smokeOnly: true, resumeID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID },
      }),
    ).toThrow('refusing replay')
  })

  it('claims the consumed reservation deterministically via wx/sync without touching the historic reservation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-consumed-smoke-'))
    try {
      const historicFile = path.join(directory, 'F1-B005.reserved')
      await writeFile(
        historicFile,
        JSON.stringify({ runID: AUTHORIZED_RETRY_SOURCE_RUN_ID, caseID: 'F1-B005', status: 'reserved' }, null, 2),
      )
      const before = await readFile(historicFile, 'utf8')
      expect(await listAuthorizedRetryReservations(directory, 'F1-B005')).toEqual([])
      const created = await createAuthorizedRetryReservation(directory, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
        runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
      })
      expect(created).toContain(`F1-B005.authorized-retry-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}`)
      expect(await readFile(historicFile, 'utf8')).toBe(before)
      expect(await listAuthorizedRetryReservations(directory, 'F1-B005')).toHaveLength(1)
      await expect(
        createAuthorizedRetryReservation(directory, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
          runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
          sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
        }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      const concurrent = await Promise.allSettled([
        createAuthorizedRetryReservation(directory, 'F1-B005', 'concurrent-run', {
          runID: 'concurrent-run',
          sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
        }),
        createAuthorizedRetryReservation(directory, 'F1-B005', 'concurrent-run', {
          runID: 'concurrent-run',
          sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
        }),
      ])
      expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(concurrent.filter((r) => r.status === 'rejected')).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps the authorized retry claim after the run lock and readiness, before any prompt', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    const lockIdx = runnerSource.indexOf("createExclusiveRunLock(path.join(OUTPUT_ROOT, '.f2b0-real-run.lock')")
    const readyIdx = runnerSource.indexOf('await waitForPluginReady(', lockIdx)
    const createIdx = runnerSource.indexOf('await createAuthorizedRetryReservation(', readyIdx)
    const captureIdx = runnerSource.indexOf('await captureCli(', createIdx)
    expect(lockIdx).toBeGreaterThan(-1)
    expect(readyIdx).toBeGreaterThan(lockIdx)
    expect(createIdx).toBeGreaterThan(readyIdx)
    expect(captureIdx).toBeGreaterThan(createIdx)
  })

  it('accepts the explicit consumed smoke flags only with smoke-only model and exact confirmations', () => {
    const exactConsumed = [
      '--execute-real',
      '--confirm-model=opencode-go/deepseek-v4.1-flash',
      '--confirm-go-quota-available',
      '--confirm-go-extra-usage-disabled',
      '--smoke-only',
      `--consumed-smoke-authorized-case=${AUTHORIZED_CONSUMED_SMOKE_CASE_ID}`,
      `--consumed-smoke-authorized-run=${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}`,
    ]
    expect(parseExecutionMode(exactConsumed)).toMatchObject({
      execute: true,
      smokeOnly: true,
      consumedSmokeCaseID: 'F1-B005',
      consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
    })
    expect(() => parseExecutionMode(exactConsumed.filter((a) => a !== '--smoke-only'))).toThrow(
      'consumed smoke requires --execute-real --smoke-only plus exact confirmations',
    )
    expect(() => parseExecutionMode(exactConsumed.filter((a) => !a.startsWith('--confirm-go-quota')))).toThrow()
    expect(() =>
      parseExecutionMode([
        '--execute-real',
        '--confirm-model=opencode-go/deepseek-v4.1-flash',
        '--confirm-go-quota-available',
        '--confirm-go-extra-usage-disabled',
        '--smoke-only',
        '--consumed-smoke-authorized-case=F1-B005',
      ]),
    ).toThrow('both case and run')
    expect(() =>
      parseExecutionMode(
        exactConsumed.map((a) =>
          a.startsWith('--consumed-smoke-authorized-case=') ? '--consumed-smoke-authorized-case=F1-B010' : a,
        ),
      ),
    ).toThrow('limited to F1-B005')
    expect(() =>
      parseExecutionMode(
        exactConsumed.map((a) =>
          a.startsWith('--consumed-smoke-authorized-run=') ? '--consumed-smoke-authorized-run=other-run' : a,
        ),
      ),
    ).toThrow('limited to F1-B005')
  })

  it('refuses consumed smoke combined with resume, preflight, export, or the old retry flags', () => {
    const base = [
      '--execute-real',
      '--confirm-model=opencode-go/deepseek-v4.1-flash',
      '--confirm-go-quota-available',
      '--confirm-go-extra-usage-disabled',
      '--smoke-only',
      `--consumed-smoke-authorized-case=${AUTHORIZED_CONSUMED_SMOKE_CASE_ID}`,
      `--consumed-smoke-authorized-run=${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}`,
    ]
    expect(() => parseExecutionMode([...base, '--resume=prior-run'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--preflight-only'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--self-test-guard'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--export-stopped-run=prior-run'])).toThrow('cannot be combined')
    expect(() =>
      parseExecutionMode([
        ...base,
        '--retry-authorized-case=F1-B005',
        `--retry-authorized-run=${AUTHORIZED_RETRY_SOURCE_RUN_ID}`,
      ]),
    ).toThrow('incompatible')
    expect(() => parseExecutionMode([...base, '--export-stopped-run=x'].filter((a) => a !== '--smoke-only'))).toThrow()
  })

  it('plans only the consumed case offline and refuses other cases, missing smoke-only, resume, double flags, or existing result', () => {
    const caseIDs = ['F1-B005', 'F1-B010', 'F1-B012']
    const resolved = resolveRealExecutionPlan({
      caseIDs,
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: {
        smokeOnly: true,
        consumedSmokeCaseID: 'F1-B005',
        consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
      },
    })
    expect(resolved.authorized).toBe(true)
    expect(resolved.executionPlan).toEqual({ run: ['F1-B005'], deferred: ['F1-B010', 'F1-B012'] })
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs,
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: { smokeOnly: true, consumedSmokeCaseID: 'F1-B010', consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID },
      }),
    ).toThrow('limited to F1-B005')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs,
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: { smokeOnly: false, consumedSmokeCaseID: 'F1-B005', consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID },
      }),
    ).toThrow('consumed smoke requires --smoke-only')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs,
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: {
          smokeOnly: true,
          resumeID: 'some-run',
          consumedSmokeCaseID: 'F1-B005',
          consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        },
      }),
    ).toThrow('cannot be combined')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs,
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: {
          smokeOnly: true,
          retryCaseID: 'F1-B005',
          retryRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
          consumedSmokeCaseID: 'F1-B005',
          consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        },
      }),
    ).toThrow('incompatible')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs,
        existingIDs: ['F1-B005'],
        reservedIDs: ['F1-B005'],
        options: {
          smokeOnly: true,
          consumedSmokeCaseID: 'F1-B005',
          consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        },
      }),
    ).toThrow('refusing second attempt')
  })

  it('selects only the consumed case via planConsumedSmoke and never other cases', () => {
    const caseIDs = ['F1-B005', 'F1-B010', 'F1-B012']
    expect(planConsumedSmoke({ caseIDs, unresolvedReservations: ['F1-B005'], consumedSmokeCaseID: 'F1-B005' })).toEqual({
      run: ['F1-B005'],
      deferred: ['F1-B010', 'F1-B012'],
    })
    expect(() => planConsumedSmoke({ caseIDs, unresolvedReservations: ['F1-B005'], consumedSmokeCaseID: 'F1-B010' })).toThrow()
    expect(() => planConsumedSmoke({ caseIDs, unresolvedReservations: ['F1-B005', 'F1-B010'], consumedSmokeCaseID: 'F1-B005' })).toThrow('exactly')
    expect(() => planConsumedSmoke({ caseIDs: ['F1-B010'], unresolvedReservations: ['F1-B005'], consumedSmokeCaseID: 'F1-B005' })).toThrow()
  })

  it('claims the new single-use consumed reservation without touching historic or retry reservations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-consumed-smoke-new-'))
    try {
      const historicFile = path.join(directory, 'F1-B005.reserved')
      await writeFile(
        historicFile,
        JSON.stringify({ runID: AUTHORIZED_RETRY_SOURCE_RUN_ID, caseID: 'F1-B005', status: 'reserved' }, null, 2),
      )
      const retryFile = await createAuthorizedRetryReservation(directory, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
        runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
      })
      const beforeHistoric = await readFile(historicFile, 'utf8')
      const beforeRetry = await readFile(retryFile, 'utf8')
      expect(await listConsumedSmokeReservations(directory, 'F1-B005')).toEqual([])
      const created = await createConsumedSmokeReservation(directory, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
        runID: 'new-run-1',
        runNonce: 'nonce-1',
        sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
      })
      expect(created).toContain(`F1-B005.consumed-smoke-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`)
      expect(await readFile(historicFile, 'utf8')).toBe(beforeHistoric)
      expect(await readFile(retryFile, 'utf8')).toBe(beforeRetry)
      expect(JSON.parse(await readFile(created, 'utf8'))).toMatchObject({
        caseID: 'F1-B005',
        consumedSmoke: true,
        sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        runID: 'new-run-1',
        status: 'reserved',
      })
      expect(await listAuthorizedRetryReservations(directory, 'F1-B005')).toHaveLength(1)
      expect(await listConsumedSmokeReservations(directory, 'F1-B005')).toHaveLength(1)
      // Deterministic per source/case: a second claim for the same source refuses even with a different new runID.
      await expect(
        createConsumedSmokeReservation(directory, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
          runID: 'new-run-2',
          runNonce: 'nonce-2',
          sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      // Simulated crash: the claim file is left behind (no release/delete API); nothing auto-clears it.
      expect(await listConsumedSmokeReservations(directory, 'F1-B005')).toHaveLength(1)
      await expect(
        createConsumedSmokeReservation(directory, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
          runID: 'crashed-run-retry',
          runNonce: 'nonce-3',
          sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed on concurrent consumed claims with exactly one winner', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-consumed-smoke-race-'))
    try {
      const concurrent = await Promise.allSettled([
        createConsumedSmokeReservation(directory, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
          runID: 'racer-a',
          runNonce: 'nonce-a',
          sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        }),
        createConsumedSmokeReservation(directory, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
          runID: 'racer-b',
          runNonce: 'nonce-b',
          sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        }),
      ])
      expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(concurrent.filter((r) => r.status === 'rejected')).toHaveLength(1)
      expect(await listConsumedSmokeReservations(directory, 'F1-B005')).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('wires the consumed authorization in the runner after the lock and history check, before any prompt, terminal even on PASS', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    expect(runnerSource).toContain('--consumed-smoke-authorized-case=F1-B005')
    expect(runnerSource).toContain('consumedSmokeCaseID: options.consumedSmokeCaseID')
    expect(runnerSource).toContain('if (authorized && options.retryCaseID !== undefined)')
    expect(runnerSource).toContain('consumed smoke refused: historic chain broken')
    expect(runnerSource).toContain('consumed smoke already consumed; refusing second attempt')
    expect(runnerSource).toContain('createConsumedSmokeReservation(reservationDir, AUTHORIZED_CONSUMED_SMOKE_CASE_ID, AUTHORIZED_CONSUMED_SMOKE_RUN_ID')
    expect(runnerSource).toContain('applyConsumedSmokeTerminalPolicy(smokeOutcome)')
    const planIdx = runnerSource.lastIndexOf('resolveRealExecutionPlan({')
    const consumedValidateIdx = runnerSource.indexOf('isAuthorizedConsumedSingleSmokeSource(', planIdx)
    const fatalValidateIdx = runnerSource.indexOf('isAuthorizedFatalRetrySource(', planIdx)
    const priorIdx = runnerSource.indexOf('consumed smoke already consumed; refusing second attempt', planIdx)
    const serverIdx = runnerSource.indexOf('await startServer(', priorIdx)
    const readyIdx = runnerSource.indexOf('await waitForPluginReady(', serverIdx)
    const createIdx = runnerSource.indexOf('await createConsumedSmokeReservation(', readyIdx)
    const captureIdx = runnerSource.indexOf('await captureCli(', createIdx)
    for (const idx of [planIdx, consumedValidateIdx, fatalValidateIdx, priorIdx, serverIdx, readyIdx, createIdx, captureIdx]) {
      expect(idx).toBeGreaterThan(-1)
    }
    expect(consumedValidateIdx).toBeGreaterThan(planIdx)
    expect(priorIdx).toBeGreaterThan(consumedValidateIdx)
    expect(serverIdx).toBeGreaterThan(priorIdx)
    expect(readyIdx).toBeGreaterThan(serverIdx)
    expect(createIdx).toBeGreaterThan(readyIdx)
    expect(captureIdx).toBeGreaterThan(createIdx)
    const betweenPlanAndServer = runnerSource.slice(planIdx, serverIdx)
    expect(betweenPlanAndServer).not.toContain('await createConsumedSmokeReservation(')
    expect(betweenPlanAndServer).not.toContain('await createAuthorizedRetryReservation(')
  })

  it('forces the consumed smoke terminal even when the oracle and usage evidence pass', () => {
    const maxPass = {
      jsonValid: true,
      schemaValid: true,
      semanticVerdict: 'PASS',
      requestCount: 1,
      noRetry: true,
      tokensObserved: true,
      costObserved: true,
      costUSD: 0,
      quotaAfterStatus: null,
      quotaAttested: true,
      extraUsageDisabledAttested: true,
    }
    const baseline = evaluateGoSmoke(maxPass)
    expect(baseline).toMatchObject({ casePassed: true, continuationAllowed: true, status: 'SMOKE_PASS' })
    expect(applyConsumedSmokeTerminalPolicy(baseline)).toMatchObject({
      casePassed: true,
      status: 'SMOKE_PASS',
      continuationAllowed: false,
    })
    expect(applyConsumedSmokeTerminalPolicy({ ...baseline, status: 'SMOKE_FAILED_STOP' })).toMatchObject({
      continuationAllowed: false,
    })
  })

  it('integrates plan, historic chain validation, single-use claim, repeat blocking, and resume-after-PASS blocking without inference', async () => {
    const reservationDir = await mkdtemp(path.join(os.tmpdir(), 'f2b0-consumed-smoke-flow-'))
    try {
      const caseIDs = ['F1-B005', 'F1-B010', 'F1-B012']
      const historicReservation = {
        runID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
        runNonce: 'f33c550c-2700-4758-8cde-455d8d762e93',
        caseID: 'F1-B005',
        status: 'reserved',
        reservedAt: '2026-10-27T15:19:22.536Z',
      }
      const fatal401Result = {
        caseID: 'F1-B005',
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
        metadata: { assistantOutcome: { terminal: true, error: { status: 401 } } },
        hookEvidence: [
          { event: 'http-request-allowed', requestCount: 1, kind: 'primary', toolCount: 0, authorizationPresent: false },
          { event: 'http-response', status: 401 },
          { event: 'retry-decision', attempt: 2, retry: false },
        ],
      }
      await writeFile(
        path.join(reservationDir, 'F1-B005.reserved'),
        JSON.stringify(historicReservation, null, 2),
      )
      // Plan like the runner does: exactly the unresolved F1-B005 reservation, smoke-only, consumed flags.
      const resolved = resolveRealExecutionPlan({
        caseIDs,
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: {
          smokeOnly: true,
          consumedSmokeCaseID: 'F1-B005',
          consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        },
      })
      expect(resolved.authorized).toBe(true)
      expect(resolved.executionPlan).toEqual({ run: ['F1-B005'], deferred: ['F1-B010', 'F1-B012'] })
      // Historic 401 chain must hold before the consumed chain is even examined.
      expect(
        isAuthorizedFatalRetrySource({
          caseID: 'F1-B005',
          sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
          reservationRecord: historicReservation,
          sourceResult: fatal401Result,
        }),
      ).toEqual({ ok: true })
      const consumedReservationRecord = {
        runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        runNonce: '27ad5f3b-2171-4e2e-8545-4dc405354369',
        sourceRunID: AUTHORIZED_RETRY_SOURCE_RUN_ID,
        caseID: 'F1-B005',
        status: 'reserved',
        authorizedRetry: true,
      }
      // Broken chain: crossed reservation (runID of another run) is refused even with a valid result.
      expect(
        isAuthorizedConsumedSingleSmokeSource({
          caseID: 'F1-B005',
          runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
          reservationRecord: { ...consumedReservationRecord, runID: 'other-run' },
          sourceResult: consumedResult,
        }),
      ).toMatchObject({ ok: false })
      // Broken chain: auth-absent HTTP200-shaped result is refused even with a valid reservation.
      expect(
        isAuthorizedConsumedSingleSmokeSource({
          caseID: 'F1-B005',
          runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
          reservationRecord: consumedReservationRecord,
          sourceResult: {
            ...consumedResult,
            hookEvidence: consumedResult.hookEvidence.map((event) =>
              event.event === 'http-request-allowed' ? { ...event, authorizationPresent: false } : event,
            ),
          },
        }),
      ).toMatchObject({ ok: false, reason: 'result-auth-absent' })
      // Intact chain passes.
      expect(
        isAuthorizedConsumedSingleSmokeSource({
          caseID: 'F1-B005',
          runID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
          reservationRecord: consumedReservationRecord,
          sourceResult: consumedResult,
        }),
      ).toEqual({ ok: true })
      // Single-use claim: first claim wins deterministically per source/case; repeat refuses via EEXIST.
      expect(await listConsumedSmokeReservations(reservationDir, 'F1-B005')).toEqual([])
      const claim = await createConsumedSmokeReservation(reservationDir, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
        runID: 'flow-new-run',
        runNonce: 'flow-nonce',
        sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
      })
      expect(claim).toContain(`F1-B005.consumed-smoke-${AUTHORIZED_CONSUMED_SMOKE_RUN_ID}.json`)
      await expect(
        createConsumedSmokeReservation(reservationDir, 'F1-B005', AUTHORIZED_CONSUMED_SMOKE_RUN_ID, {
          runID: 'flow-second-run',
          runNonce: 'flow-nonce-2',
          sourceRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
        }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      // Runner-equivalent repeat gate: a non-empty consumed claim list blocks a second attempt.
      expect(await listConsumedSmokeReservations(reservationDir, 'F1-B005')).toHaveLength(1)
      // Resume after PASS is blocked: even a maximal PASS evaluation is forced terminal for the consumed path,
      // and the runner resume gate requires SMOKE_PASS plus continuationAllowed true.
      const maxPass = evaluateGoSmoke({
        jsonValid: true,
        schemaValid: true,
        semanticVerdict: 'PASS',
        requestCount: 1,
        noRetry: true,
        tokensObserved: true,
        costObserved: true,
        costUSD: 0,
        quotaAfterStatus: null,
        quotaAttested: true,
        extraUsageDisabledAttested: true,
      })
      const isResumeAllowed = (smoke) => smoke.status === 'SMOKE_PASS' && smoke.continuationAllowed === true
      expect(isResumeAllowed(maxPass)).toBe(true)
      expect(isResumeAllowed(applyConsumedSmokeTerminalPolicy(maxPass))).toBe(false)
      // And any resume invocation carrying the consumed flags is refused before any file is read.
      expect(() =>
        resolveRealExecutionPlan({
          caseIDs,
          existingIDs: [],
          reservedIDs: ['F1-B005'],
          options: {
            smokeOnly: true,
            resumeID: 'flow-new-run',
            consumedSmokeCaseID: 'F1-B005',
            consumedSmokeRunID: AUTHORIZED_CONSUMED_SMOKE_RUN_ID,
          },
        }),
      ).toThrow('cannot be combined')
    } finally {
      await rm(reservationDir, { recursive: true, force: true })
    }
  })

  // Limitation (documented, no second marker added): local reservation files cannot survive manual
  // deletion by an operator with filesystem access (rm/unlink). Crash-safety holds (stale files persist
  // and block), but deliberate removal is outside the model; detection relies on out-of-band review
  // (git status of the evidence dir, run lock, and the immutable historic chain), not on another file.
})
