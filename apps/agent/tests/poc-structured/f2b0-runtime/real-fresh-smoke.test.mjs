import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUTHORIZED_FRESH_SMOKE_CASE_ID,
  AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER,
  MAX_FRESH_SMOKE_ATTEMPTS,
  MAX_FRESH_SMOKE_ATTEMPTS_MUSE_SPARK,
  MUSE_SPARK_SLUG,
  LEGACY_DEEPSEEK_SLUG,
  getMaxFreshSmokeAttempts,
  FRESH_SMOKE_RETRY_FAIL_STATUSES,
  applyConsumedSmokeTerminalPolicy,
  evaluateFreshSmokeRetry,
  evaluateGoSmoke,
  isAuthorizedFreshSmokeSource,
  isAuthorizedRemaining22SourceRunID,
  isFreshSmokeEvaluationPass,
  parseExecutionMode,
  planFreshSmoke,
  resolveRealExecutionPlan,
} from './real-guard.mjs'
import {
  createFreshSmokeReservation,
  listFreshSmokeReservations,
} from './real-storage.mjs'
import { isFreshSmokeResumeBlocked } from './real-runner.ts'

const exactFreshArgv = () => [
  '--execute-real',
  '--confirm-model=opencode-go/muse-spark-1.3-contributor',
  '--confirm-go-quota-available',
  '--confirm-go-extra-usage-disabled',
  '--smoke-only',
  `--fresh-smoke-authorized-case=${AUTHORIZED_FRESH_SMOKE_CASE_ID}`,
  `--fresh-smoke-authorized-run=${AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER}`,
]

describe('F1-B005 fresh controlled smoke S2 (single-use, new source)', () => {
  it('pins the fresh pair to F1-B005 plus the controlled fresh marker (never an invented runID)', () => {
    expect(AUTHORIZED_FRESH_SMOKE_CASE_ID).toBe('F1-B005')
    expect(AUTHORIZED_FRESH_SMOKE_SOURCE_MARKER).toBe('fresh')
  })

  it('accepts the exact fresh flags only with smoke-only plus the 3 confirms', () => {
    expect(parseExecutionMode(exactFreshArgv())).toMatchObject({
      execute: true,
      smokeOnly: true,
      freshSmokeCaseID: 'F1-B005',
      freshSmokeRunID: 'fresh',
    })
    expect(() => parseExecutionMode(exactFreshArgv().filter((a) => a !== '--smoke-only'))).toThrow(
      'fresh smoke requires --execute-real --smoke-only plus exact confirmations',
    )
    expect(() => parseExecutionMode(exactFreshArgv().filter((a) => !a.startsWith('--confirm-go-quota')))).toThrow()
    expect(() =>
      parseExecutionMode(['--execute-real', '--confirm-model=opencode-go/muse-spark-1.3-contributor', '--confirm-go-quota-available', '--confirm-go-extra-usage-disabled', '--smoke-only', '--fresh-smoke-authorized-case=F1-B005']),
    ).toThrow('both case and run')
  })

  it('refuses S3/strange source and mutually exclusive combinations', () => {
    const base = exactFreshArgv()
    expect(() =>
      parseExecutionMode(base.map((a) => (a.startsWith('--fresh-smoke-authorized-case=') ? '--fresh-smoke-authorized-case=F1-B010' : a))),
    ).toThrow('limited to F1-B005')
    expect(() =>
      parseExecutionMode(base.map((a) => (a.startsWith('--fresh-smoke-authorized-run=') ? '--fresh-smoke-authorized-run=other-run' : a))),
    ).toThrow('limited to F1-B005')
    expect(() => parseExecutionMode([...base, '--resume=prior-run'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--preflight-only'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--self-test-guard'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--export-stopped-run=prior-run'])).toThrow()
    expect(() =>
      parseExecutionMode([...base, '--retry-authorized-case=F1-B005', '--retry-authorized-run=2026-10-27T15-19-19-424Z-5620']),
    ).toThrow('incompatible')
    expect(() =>
      parseExecutionMode([...base, '--consumed-smoke-authorized-case=F1-B005', '--consumed-smoke-authorized-run=2026-10-29T10-55-14-534Z-21048']),
    ).toThrow('incompatible')
    expect(() => parseExecutionMode([...base, '--remaining22-authorized-run=2026-10-29T12-26-34-600Z-4324'])).toThrow(
      /incompatible|cannot be combined/,
    )
  })

  it('authorizes only the fresh pair via predicate (S3/strange source refused)', () => {
    expect(isAuthorizedFreshSmokeSource({ caseID: 'F1-B005', sourceMarker: 'fresh' })).toEqual({ ok: true })
    expect(isAuthorizedFreshSmokeSource({ caseID: 'F1-B010', sourceMarker: 'fresh' }).ok).toBe(false)
    expect(isAuthorizedFreshSmokeSource({ caseID: 'F1-B005', sourceMarker: 'other-run' }).ok).toBe(false)
    expect(isAuthorizedFreshSmokeSource({ caseID: 'F1-B005', sourceMarker: undefined }).ok).toBe(false)
    expect(isAuthorizedFreshSmokeSource({ caseID: undefined, sourceMarker: 'fresh' }).ok).toBe(false)
  })

  it('selects only the fresh case via planFreshSmoke', () => {
    const caseIDs = ['F1-B005', 'F1-B010', 'F1-B012']
    expect(planFreshSmoke({ caseIDs, unresolvedReservations: ['F1-B005'], freshSmokeCaseID: 'F1-B005' })).toEqual({
      run: ['F1-B005'],
      deferred: ['F1-B010', 'F1-B012'],
    })
    expect(() => planFreshSmoke({ caseIDs, unresolvedReservations: ['F1-B005'], freshSmokeCaseID: 'F1-B010' })).toThrow()
    expect(() => planFreshSmoke({ caseIDs, unresolvedReservations: ['F1-B005', 'F1-B010'], freshSmokeCaseID: 'F1-B005' })).toThrow('exactly')
    expect(() => planFreshSmoke({ caseIDs: ['F1-B010'], unresolvedReservations: ['F1-B005'], freshSmokeCaseID: 'F1-B005' })).toThrow()
  })

  it('plans the fresh smoke offline as authorized and refuses generic fresh replay', () => {
    const caseIDs = ['F1-B005', 'F1-B010', 'F1-B012']
    expect(() => resolveRealExecutionPlan({ caseIDs, existingIDs: [], reservedIDs: ['F1-B005'], options: { smokeOnly: true } })).toThrow()
    const resolved = resolveRealExecutionPlan({
      caseIDs,
      existingIDs: [],
      reservedIDs: ['F1-B005'],
      options: { smokeOnly: true, freshSmokeCaseID: 'F1-B005', freshSmokeRunID: 'fresh' },
    })
    expect(resolved.authorized).toBe(true)
    expect(resolved.executionPlan).toEqual({ run: ['F1-B005'], deferred: ['F1-B010', 'F1-B012'] })
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs,
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: { smokeOnly: true, freshSmokeCaseID: 'F1-B010', freshSmokeRunID: 'fresh' },
      }),
    ).toThrow('limited to F1-B005')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs,
        existingIDs: ['F1-B005'],
        reservedIDs: ['F1-B005'],
        options: { smokeOnly: true, freshSmokeCaseID: 'F1-B005', freshSmokeRunID: 'fresh' },
      }),
    ).toThrow('refusing second attempt')
    expect(() =>
      resolveRealExecutionPlan({
        caseIDs,
        existingIDs: [],
        reservedIDs: ['F1-B005'],
        options: { smokeOnly: true, resumeID: 'x', freshSmokeCaseID: 'F1-B005', freshSmokeRunID: 'fresh' },
      }),
    ).toThrow('cannot be combined')
  })

  it('claims the fresh reservation disjunta single-use, preservando F1-B005.reserved e sem tocar consumed/retry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-fresh-smoke-'))
    try {
      const historicFile = path.join(directory, 'F1-B005.reserved')
      await writeFile(historicFile, JSON.stringify({ runID: 'historic-run', caseID: 'F1-B005', status: 'reserved' }, null, 2))
      const before = await readFile(historicFile, 'utf8')
      expect(await listFreshSmokeReservations(directory, 'F1-B005')).toEqual([])
      const created = await createFreshSmokeReservation(directory, 'F1-B005', 'new-run-1', {
        runID: 'new-run-1',
        runNonce: 'nonce-1',
        sourceMarker: 'fresh',
      })
      expect(created).toContain('F1-B005.fresh-smoke-new-run-1.json')
      expect(await readFile(historicFile, 'utf8')).toBe(before)
      expect(JSON.parse(await readFile(created, 'utf8'))).toMatchObject({
        caseID: 'F1-B005',
        freshSmoke: true,
        status: 'reserved',
        runID: 'new-run-1',
      })
      expect(await listFreshSmokeReservations(directory, 'F1-B005')).toHaveLength(1)
      await expect(
        createFreshSmokeReservation(directory, 'F1-B005', 'new-run-1', { runID: 'new-run-1', runNonce: 'nonce-2', sourceMarker: 'fresh' }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(
        createFreshSmokeReservation(directory, 'F1-B010', 'new-run-1', { runID: 'new-run-1', runNonce: 'nonce-3', sourceMarker: 'fresh' }),
      ).rejects.toThrow()
      const concurrent = await Promise.allSettled([
        createFreshSmokeReservation(directory, 'F1-B005', 'racer-run', { runID: 'racer-a', runNonce: 'a', sourceMarker: 'fresh' }),
        createFreshSmokeReservation(directory, 'F1-B005', 'racer-run', { runID: 'racer-b', runNonce: 'b', sourceMarker: 'fresh' }),
      ])
      expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(await listFreshSmokeReservations(directory, 'F1-B005')).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects fresh reservations with a divergent or missing sourceMarker (P2)', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-fresh-marker-'))
    try {
      await expect(
        createFreshSmokeReservation(directory, 'F1-B005', 'marker-run-1', {
          runID: 'marker-run-1',
          runNonce: 'nonce-1',
          sourceMarker: 'other-run',
        }),
      ).rejects.toThrow('sourceMarker')
      await expect(
        createFreshSmokeReservation(directory, 'F1-B005', 'marker-run-2', {
          runID: 'marker-run-2',
          runNonce: 'nonce-2',
        }),
      ).rejects.toThrow('sourceMarker')
      expect(await listFreshSmokeReservations(directory, 'F1-B005')).toEqual([])
      const created = await createFreshSmokeReservation(directory, 'F1-B005', 'marker-run-3', {
        runID: 'marker-run-3',
        runNonce: 'nonce-3',
        sourceMarker: 'fresh',
      })
      expect(JSON.parse(await readFile(created, 'utf8'))).toMatchObject({
        caseID: 'F1-B005',
        freshSmoke: true,
        status: 'reserved',
        sourceMarker: 'fresh',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses resume of a fresh single-use run even with a forged continuationAllowed:true smoke report (P1)', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-fresh-resume-'))
    try {
      const freshRunID = '2099-01-01T00-00-00-000Z-1'
      await createFreshSmokeReservation(directory, 'F1-B005', freshRunID, {
        runID: freshRunID,
        runNonce: 'nonce-resume',
        sourceMarker: 'fresh',
      })
      const files = await listFreshSmokeReservations(directory, 'F1-B005')
      expect(files).toHaveLength(1)
      const runIDs = []
      for (const file of files) runIDs.push(JSON.parse(await readFile(file, 'utf8')).runID)
      expect(runIDs).toEqual([freshRunID])
      const forgedSmoke = { status: 'SMOKE_PASS', continuationAllowed: true, runID: freshRunID, caseID: 'F1-B005' }
      expect(
        isFreshSmokeResumeBlocked({ resumeID: freshRunID, smoke: forgedSmoke, freshReservationFiles: files, freshReservationRunIDs: runIDs }),
      ).toBe(true)
      expect(
        isFreshSmokeResumeBlocked({ resumeID: 'other-run', smoke: { ...forgedSmoke, freshSmoke: true }, freshReservationFiles: [], freshReservationRunIDs: [] }),
      ).toBe(true)
      expect(
        isFreshSmokeResumeBlocked({ resumeID: 'other-run', smoke: { ...forgedSmoke, sourceMarker: 'fresh' }, freshReservationFiles: [], freshReservationRunIDs: [] }),
      ).toBe(true)
      expect(
        isFreshSmokeResumeBlocked({ resumeID: 'other-run', smoke: forgedSmoke, freshReservationFiles: [], freshReservationRunIDs: [] }),
      ).toBe(false)
      expect(isFreshSmokeResumeBlocked({})).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('wires the fresh resume refusal in the runner resume block before the continuation gate (P1)', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    const resumeIdx = runnerSource.indexOf('if (options.resumeID) {')
    const refusalIdx = runnerSource.indexOf('isFreshSmokeResumeBlocked(', resumeIdx)
    const gateIdx = runnerSource.indexOf('resume blocked: smoke did not pass', resumeIdx)
    expect(resumeIdx).toBeGreaterThan(-1)
    expect(refusalIdx).toBeGreaterThan(resumeIdx)
    expect(gateIdx).toBeGreaterThan(refusalIdx)
    expect(runnerSource).toContain('fresh smoke run is terminal single-use')
  })

  it('forces the fresh smoke terminal (gera fonte, nunca continua sozinho)', () => {
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
    expect(applyConsumedSmokeTerminalPolicy(evaluateGoSmoke(maxPass))).toMatchObject({ continuationAllowed: false })
  })

  it('wires the fresh authorization in the runner after the lock and history check, before any prompt, terminal even on PASS', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    expect(runnerSource).toContain('--fresh-smoke-authorized-case=F1-B005')
    expect(runnerSource).toContain('freshSmokeCaseID')
    expect(runnerSource).toContain('freshSmokeRunID')
    expect(runnerSource).toContain('evaluateFreshSmokeRetry(')
    expect(runnerSource).toContain('evaluateFreshSmokeRetry(priorEvaluations, MUSE_SPARK_SLUG)')
    expect(runnerSource).toContain('getMaxFreshSmokeAttempts(MUSE_SPARK_SLUG)')
    expect(runnerSource).toContain('loadFreshSmokeRetryEvaluations(')
    expect(runnerSource).toContain('smoke-evaluation.json')
    expect(runnerSource).toContain('single PASS preserved, all-FAIL/INCONCLUSIVE only')
    expect(runnerSource).toContain('createFreshSmokeReservation(reservationDir, AUTHORIZED_FRESH_SMOKE_CASE_ID, runID')
    expect(runnerSource).toContain('isAuthorizedFreshSmokeSource(')
    const planIdx = runnerSource.lastIndexOf('resolveRealExecutionPlan({')
    const freshValidateIdx = runnerSource.indexOf('isAuthorizedFreshSmokeSource(', planIdx)
    const priorIdx = runnerSource.indexOf('evaluateFreshSmokeRetry(', planIdx)
    const serverIdx = runnerSource.indexOf('await startServer(', priorIdx)
    const readyIdx = runnerSource.indexOf('await waitForPluginReady(', serverIdx)
    const createIdx = runnerSource.indexOf('await createFreshSmokeReservation(', readyIdx)
    const captureIdx = runnerSource.indexOf('await captureCli(', createIdx)
    for (const idx of [planIdx, freshValidateIdx, priorIdx, serverIdx, readyIdx, createIdx, captureIdx]) {
      expect(idx).toBeGreaterThan(-1)
    }
    expect(freshValidateIdx).toBeGreaterThan(planIdx)
    expect(priorIdx).toBeGreaterThan(freshValidateIdx)
    expect(serverIdx).toBeGreaterThan(priorIdx)
    expect(createIdx).toBeGreaterThan(readyIdx)
    expect(captureIdx).toBeGreaterThan(createIdx)
  })

  // Branch test/ted-f2b0-no-retry-controlled — TDD RED→GREEN (F2-completar-8):
  // RED: 3º fresh recusado mesmo com prévias FAIL (teto 2/slug).
  // GREEN (decisão F2-completar-8 em docs/decisions/2026-10-29-fechar-f2.md —
  // completar os 8 casos faltantes da B3 parada): teto 3 SÓ no slug
  // muse-spark (opencode-go-muse-spark-1.3-contributor); deepseek/legado
  // segue teto 2. 3º permitido se 2 prévias FAIL/INCONCLUSIVE; 4º recusado
  // mesmo com FAILs; PASS prévio recusa novos. Limite documentado aqui e
  // no guard.
  it('allows exactly one new fresh when the single prior is FAIL, refuses when it is PASS', () => {
    const failEval = { status: 'SMOKE_FAILED_STOP', continuationAllowed: false }
    const inconclusiveEval = { status: 'SMOKE_INCONCLUSIVE_STOP', continuationAllowed: false }
    expect(FRESH_SMOKE_RETRY_FAIL_STATUSES).toEqual(['SMOKE_FAILED_STOP', 'SMOKE_INCONCLUSIVE_STOP'])
    expect(MAX_FRESH_SMOKE_ATTEMPTS).toBe(2)
    expect(MAX_FRESH_SMOKE_ATTEMPTS_MUSE_SPARK).toBe(3)
    expect(MUSE_SPARK_SLUG).toBe('opencode-go-muse-spark-1.3-contributor')
    expect(getMaxFreshSmokeAttempts(MUSE_SPARK_SLUG)).toBe(3)
    expect(getMaxFreshSmokeAttempts(LEGACY_DEEPSEEK_SLUG)).toBe(2)
    expect(getMaxFreshSmokeAttempts('opencode-deepseek-v4.1-flash-free')).toBe(2)
    expect(getMaxFreshSmokeAttempts(undefined)).toBe(2)
    // 2º fresh permitido: 1 prévia FAIL → ok (novo runID distinto, antigas preservadas pelo runner via wx).
    expect(evaluateFreshSmokeRetry([failEval])).toEqual({ ok: true })
    expect(evaluateFreshSmokeRetry([inconclusiveEval])).toEqual({ ok: true })
    expect(evaluateFreshSmokeRetry([failEval], MUSE_SPARK_SLUG)).toEqual({ ok: true })
    // Single PASS preservado: status SMOKE_PASS* ou casePassed===true recusam.
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_PASS', continuationAllowed: false }])).toMatchObject({ ok: false, reason: 'fresh-smoke-pass-preserved' })
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_PASS_OPERATOR_ATTESTED_NO_CONTINUATION', continuationAllowed: false }])).toMatchObject({ ok: false, reason: 'fresh-smoke-pass-preserved' })
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_FAILED_STOP', casePassed: true }])).toMatchObject({ ok: false, reason: 'fresh-smoke-pass-preserved' })
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_FAILED_STOP', casePassed: true }], MUSE_SPARK_SLUG)).toMatchObject({ ok: false, reason: 'fresh-smoke-pass-preserved' })
    expect(isFreshSmokeEvaluationPass({ status: 'SMOKE_PASS_QUOTA_STOP' })).toBe(true)
    expect(isFreshSmokeEvaluationPass({ status: 'SMOKE_FAILED_STOP' })).toBe(false)
    // 2º recusado se o 2º for PASS: prévia PASS persiste mesmo após retry permitido.
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_PASS' }]).ok).toBe(false)
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_PASS' }], MUSE_SPARK_SLUG).ok).toBe(false)
  })

  it('refuses fail-closed on missing/unreadable or non-retryable prior evaluations', () => {
    expect(evaluateFreshSmokeRetry([null])).toMatchObject({ ok: false, reason: 'fresh-smoke-evaluation-missing' })
    expect(evaluateFreshSmokeRetry([undefined])).toMatchObject({ ok: false, reason: 'fresh-smoke-evaluation-missing' })
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_BLOCKED_UNVERIFIED_BUDGET', continuationAllowed: false }])).toMatchObject({ ok: false, reason: 'fresh-smoke-status-not-retryable' })
    expect(evaluateFreshSmokeRetry([{ status: 'UNKNOWN', continuationAllowed: false }])).toMatchObject({ ok: false, reason: 'fresh-smoke-status-not-retryable' })
    // Misto FAIL + PASS → PASS preservado vence.
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_FAILED_STOP' }, { status: 'SMOKE_PASS' }])).toMatchObject({ ok: false })
  })

  it('refuses the 3rd fresh attempt on the baseline slug but allows the 3rd on muse-spark; refuses the 4th even with consecutive FAILs (spend cap)', () => {
    const failEval = { status: 'SMOKE_FAILED_STOP', continuationAllowed: false }
    // Baseline (deepseek/legado, default): 1 prévia FAIL → permite o 2º; 2 prévias FAIL → recusa o 3º sem decisão explícita nova.
    expect(evaluateFreshSmokeRetry([failEval])).toEqual({ ok: true })
    expect(evaluateFreshSmokeRetry([failEval, failEval])).toMatchObject({ ok: false, reason: 'fresh-smoke-attempt-limit' })
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_INCONCLUSIVE_STOP' }, { status: 'SMOKE_FAILED_STOP' }])).toMatchObject({ ok: false, reason: 'fresh-smoke-attempt-limit' })
    expect(evaluateFreshSmokeRetry([failEval, failEval], LEGACY_DEEPSEEK_SLUG)).toMatchObject({ ok: false, reason: 'fresh-smoke-attempt-limit' })
    // Muse-spark (F2-completar-8): 2 prévias FAIL/INCONCLUSIVE → permite o 3º (S5); 3 prévias → recusa o 4º mesmo com FAILs.
    expect(evaluateFreshSmokeRetry([failEval], MUSE_SPARK_SLUG)).toEqual({ ok: true })
    expect(evaluateFreshSmokeRetry([failEval, failEval], MUSE_SPARK_SLUG)).toEqual({ ok: true })
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_INCONCLUSIVE_STOP' }, { status: 'SMOKE_FAILED_STOP' }], MUSE_SPARK_SLUG)).toEqual({ ok: true })
    expect(evaluateFreshSmokeRetry([failEval, failEval, failEval], MUSE_SPARK_SLUG)).toMatchObject({ ok: false, reason: 'fresh-smoke-attempt-limit' })
    expect(evaluateFreshSmokeRetry([{ status: 'SMOKE_INCONCLUSIVE_STOP' }, failEval, failEval], MUSE_SPARK_SLUG)).toMatchObject({ ok: false, reason: 'fresh-smoke-attempt-limit' })
    // PASS prévio recusa novos mesmo no teto estendido.
    expect(evaluateFreshSmokeRetry([failEval, { status: 'SMOKE_PASS', continuationAllowed: false }], MUSE_SPARK_SLUG)).toMatchObject({ ok: false })
  })

  it('keeps future S5 out of the remaining22 allowlist until its own amendment (S5 runID nasce no smoke)', () => {
    const futureS5 = '2026-10-29T00-00-00-000Z-0000'
    expect(isAuthorizedRemaining22SourceRunID(futureS5)).toBe(false)
    expect(() => parseExecutionMode([
      '--execute-real',
      '--confirm-model=opencode-go/muse-spark-1.3-contributor',
      '--confirm-go-quota-available',
      '--confirm-go-extra-usage-disabled',
      `--remaining22-authorized-run=${futureS5}`,
    ])).toThrow(/limited to source/)
  })
})
