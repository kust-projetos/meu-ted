import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID,
  BOOTSTRAP_FRESH_CHAIN_AUTHORIZATION,
  BOOTSTRAP_FRESH_CHAIN_FLAG,
  REAL_MODEL,
  REAL_URL,
  isBootstrapFreshChainAllowed,
  parseExecutionMode,
} from './real-guard.mjs'
import {
  createAuthorizedRetryReservation,
  createCaseReservation,
  createConsumedSmokeReservation,
  createFreshSmokeReservation,
  createRemaining22CampaignClaim,
  createRemaining22Reservation,
} from './real-storage.mjs'

const S1 = '2026-10-29T12-26-34-600Z-4324'

const exactBootstrapArgv = () => [
  '--execute-real',
  '--confirm-model=opencode-go/muse-spark-1.3-contributor',
  '--confirm-go-quota-available',
  '--confirm-go-extra-usage-disabled',
  '--smoke-only',
  BOOTSTRAP_FRESH_CHAIN_FLAG,
]

const emptySlugState = () => ({
  caseID: 'F1-B005',
  reservationIDs: [],
  freshReservations: [],
  consumedReservations: [],
  retryReservations: [],
  remaining22Reservations: [],
  campaignClaims: [],
})

describe('F1-B005 bootstrap fresh chain (one-time slug anchor, no inference)', () => {
  it('pins the bootstrap to F1-B005 with the registered POC authorization', () => {
    expect(AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID).toBe('F1-B005')
    expect(BOOTSTRAP_FRESH_CHAIN_FLAG).toBe('--bootstrap-fresh-chain-F1-B005')
    expect(BOOTSTRAP_FRESH_CHAIN_AUTHORIZATION).toContain('2026-10-29-fechar-f2.md')
    expect(BOOTSTRAP_FRESH_CHAIN_AUTHORIZATION).toContain('muse-spark')
  })

  it('accepts the bootstrap flag only with --execute-real --smoke-only plus the 3 confirms', () => {
    expect(parseExecutionMode(exactBootstrapArgv())).toMatchObject({ execute: true, smokeOnly: true, bootstrapFreshChain: true })
    expect(() => parseExecutionMode(exactBootstrapArgv().filter((a) => a !== '--smoke-only'))).toThrow(
      'bootstrap fresh chain requires --execute-real --smoke-only plus exact confirmations',
    )
    expect(() => parseExecutionMode(exactBootstrapArgv().filter((a) => a !== '--execute-real'))).toThrow()
    expect(() => parseExecutionMode(exactBootstrapArgv().filter((a) => !a.startsWith('--confirm-go-quota')))).toThrow()
    expect(() => parseExecutionMode([BOOTSTRAP_FRESH_CHAIN_FLAG])).toThrow()
  })

  it('refuses every combination with retry/consumed/fresh/remaining22/resume/preflight/self-test/export', () => {
    const base = exactBootstrapArgv()
    expect(() => parseExecutionMode([...base, '--retry-authorized-case=F1-B005', '--retry-authorized-run=2026-10-27T15-19-19-424Z-5620'])).toThrow(/incompatible|cannot be combined/)
    expect(() => parseExecutionMode([...base, '--consumed-smoke-authorized-case=F1-B005', '--consumed-smoke-authorized-run=2026-10-29T10-55-14-534Z-21048'])).toThrow(/incompatible|cannot be combined/)
    expect(() => parseExecutionMode([...base, '--fresh-smoke-authorized-case=F1-B005', '--fresh-smoke-authorized-run=fresh'])).toThrow(/incompatible|cannot be combined/)
    expect(() => parseExecutionMode([...base, `--remaining22-authorized-run=${S1}`])).toThrow(/incompatible|cannot be combined/)
    expect(() => parseExecutionMode([...base, '--resume=prior-run'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--preflight-only'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--self-test-guard'])).toThrow('cannot be combined')
    expect(() => parseExecutionMode([...base, '--export-stopped-run=prior-run'])).toThrow()
  })

  it('allows the bootstrap only on a slug with zero reservations/claims (single-use per slug)', () => {
    expect(isBootstrapFreshChainAllowed(emptySlugState())).toEqual({ ok: true })
    expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), caseID: 'F1-B010' }).ok).toBe(false)
    expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), reservationIDs: ['F1-B005'] }).ok).toBe(false)
    expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), freshReservations: ['x'] }).ok).toBe(false)
    expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), consumedReservations: ['x'] }).ok).toBe(false)
    expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), retryReservations: ['x'] }).ok).toBe(false)
    expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), remaining22Reservations: ['x'] }).ok).toBe(false)
    expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), campaignClaims: ['x'] }).ok).toBe(false)
  })

  it('creates the F1-B005 anchor once; a second anchor attempt fails closed (EEXIST)', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-bootstrap-chain-'))
    try {
      const created = await createCaseReservation(directory, 'F1-B005', {
        runID: 'bootstrap-run-1',
        runNonce: 'nonce-1',
        provider: REAL_MODEL.providerID,
        model: REAL_MODEL.modelID,
        nativeURL: REAL_URL,
        authorization: BOOTSTRAP_FRESH_CHAIN_AUTHORIZATION,
        bootstrapFreshChain: true,
      })
      expect(created).toContain('F1-B005.reserved')
      expect(JSON.parse(await readFile(created, 'utf8'))).toMatchObject({
        caseID: 'F1-B005',
        status: 'reserved',
        runID: 'bootstrap-run-1',
        model: REAL_MODEL.modelID,
        authorization: BOOTSTRAP_FRESH_CHAIN_AUTHORIZATION,
        bootstrapFreshChain: true,
      })
      await expect(
        createCaseReservation(directory, 'F1-B005', { runID: 'bootstrap-run-2', runNonce: 'nonce-2' }),
      ).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('treats any pre-existing slug reservation family as a consumed bootstrap', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-bootstrap-consumed-'))
    try {
      await createCaseReservation(directory, 'F1-B005', { runID: 'prior', runNonce: 'n0' })
      const seedCases = [
        async () => createFreshSmokeReservation(directory, 'F1-B005', 'fresh-run', { runID: 'fresh-run', runNonce: 'n1', sourceMarker: 'fresh' }),
        async () => createConsumedSmokeReservation(directory, 'F1-B005', '2026-10-29T10-55-14-534Z-21048', { runID: 'r', runNonce: 'n2' }),
        async () => createAuthorizedRetryReservation(directory, 'F1-B005', 'retry-run', { runID: 'r', runNonce: 'n3' }),
        async () => createRemaining22CampaignClaim(directory, S1, { runID: 'r', runNonce: 'n4', sourceRunID: S1 }),
      ]
      for (const seed of seedCases) await seed()
      const remainingDir = await mkdtemp(path.join(os.tmpdir(), 'f2b0-bootstrap-remaining-'))
      try {
        await createRemaining22Reservation(remainingDir, 'F1-B010', S1, { runID: 'r', runNonce: 'n5', sourceRunID: S1 })
        expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), remaining22Reservations: ['x'] }).ok).toBe(false)
      } finally {
        await rm(remainingDir, { recursive: true, force: true })
      }
      expect(isBootstrapFreshChainAllowed({ ...emptySlugState(), reservationIDs: ['F1-B005'] }).ok).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('wires the bootstrap in the runner before any credential/server/inference path and without a smoke evaluation', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    expect(runnerSource).toContain(BOOTSTRAP_FRESH_CHAIN_FLAG)
    expect(runnerSource).toContain('isBootstrapFreshChainAllowed')
    expect(runnerSource).toContain('createCaseReservation(reservationDir, AUTHORIZED_BOOTSTRAP_FRESH_CHAIN_CASE_ID')
    const bootstrapIdx = runnerSource.indexOf('bootstrapFreshChain')
    const credentialIdx = runnerSource.indexOf('await loadGoApiKey()')
    const serverIdx = runnerSource.indexOf('await startServer(')
    const captureIdx = runnerSource.indexOf('await captureCli(CLI,')
    const smokeEvalIdx = runnerSource.indexOf('smoke-evaluation.json', bootstrapIdx)
    expect(bootstrapIdx).toBeGreaterThan(-1)
    for (const idx of [credentialIdx, serverIdx, captureIdx, smokeEvalIdx]) expect(idx).toBeGreaterThan(bootstrapIdx)
    const dispatchSites = (runnerSource.match(/await captureCli\(CLI,/g) ?? []).length
    expect(dispatchSites).toBe(1)
  })
})
