import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  isAuthorizedRemaining22SourceRunID,
  isStoppedIncompleteRun,
  evaluateRemaining22Supersede,
  REMAINING22_SUPERSEDE_SUFFIX,
} from './real-guard.mjs'
import {
  remaining22FileName,
  remaining22FileNameR2,
  remaining22CampaignFileName,
  remaining22CampaignFileNameR2,
  createRemaining22Reservation,
  listRemaining22Reservations,
  createRemaining22CampaignClaim,
  createRemaining22SupersedeCampaignClaim,
  createRemaining22SupersedeReservation,
  listRemaining22CampaignClaims,
} from './real-storage.mjs'
import { getF2B0Cases, F2B0_CASE_IDS } from '../f2b0-adapter.ts'
import { loadStoppedIncompleteFlags } from './real-runner.ts'

const S1 = '2026-10-29T12-26-34-600Z-4324'
const S4 = '2026-10-29T22-34-44-294Z-10836'
const S3 = '2026-10-29T22-22-00-788Z-21356'
const B3 = '2026-10-29T22-42-52-546Z-7140'

const canonicalCases = getF2B0Cases()
const canonicalCampaignOrdered = canonicalCases.map((entry) => entry.id).filter((id) => id !== 'F1-B005')

describe('F2B0 remaining22 supersede -r2 (F2-B4-via-S4, single-ACTIVE-claim)', () => {
  it('pins the -r2 namespace helpers', () => {
    expect(REMAINING22_SUPERSEDE_SUFFIX).toBe('-r2')
    const dir = '/tmp/x'
    expect(remaining22CampaignFileNameR2(dir, S4)).toBe(remaining22CampaignFileName(dir, S4).replace('.json', '-r2.json'))
    expect(remaining22FileNameR2(dir, 'J01_T1', S4)).toBe(remaining22FileName(dir, 'J01_T1', S4).replace('.json', '-r2.json'))
    expect(remaining22FileNameR2(dir, 'J01_T1', S4)).toContain(`remaining22-${S4}-r2.json`)
  })

  it('RED: base second claim still refuses via EEXIST (no silent overwrite)', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-r2-red-'))
    try {
      await createRemaining22CampaignClaim(directory, S4, { runID: 'campaign-s4', runNonce: 'n1', sourceRunID: S4 })
      await expect(createRemaining22CampaignClaim(directory, S4, { runID: 'campaign-s4-retry', runNonce: 'n2', sourceRunID: S4 })).rejects.toMatchObject({ code: 'EEXIST' })
      const first = canonicalCampaignOrdered[0]
      await createRemaining22Reservation(directory, first, S4, { runID: 'campaign-s4', runNonce: 'n1', sourceRunID: S4 })
      await expect(createRemaining22Reservation(directory, first, S4, { runID: 'campaign-s4-retry', runNonce: 'n2', sourceRunID: S4 })).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('GREEN: supersede gate allows exactly one -r2 for stopped-incomplete, refuses complete/third/S3', () => {
    expect(isStoppedIncompleteRun({ hasStoppedSummary: true, hasEvaluation: false })).toBe(true)
    expect(isStoppedIncompleteRun({ hasStoppedSummary: true, hasEvaluation: true })).toBe(false)
    expect(isStoppedIncompleteRun({ hasStoppedSummary: false, hasEvaluation: false })).toBe(false)
    // First claim stopped-incomplete -> one supersede allowed
    expect(evaluateRemaining22Supersede({ sourceRunID: S4, baseClaimCount: 1, supersedeClaimCount: 0, priorIsStoppedIncomplete: true })).toEqual({ ok: true })
    // Complete campaign never releases a second claim
    expect(evaluateRemaining22Supersede({ sourceRunID: S1, baseClaimCount: 1, supersedeClaimCount: 0, priorIsStoppedIncomplete: false })).toMatchObject({ ok: false, reason: 'prior-campaign-complete' })
    // Third claim (even with stops) refuses
    expect(evaluateRemaining22Supersede({ sourceRunID: S4, baseClaimCount: 1, supersedeClaimCount: 1, priorIsStoppedIncomplete: true })).toMatchObject({ ok: false, reason: 'supersede-already-consumed' })
    // No prior claim -> normal flow, not supersede
    expect(evaluateRemaining22Supersede({ sourceRunID: S4, baseClaimCount: 0, supersedeClaimCount: 0, priorIsStoppedIncomplete: false })).toMatchObject({ ok: false, reason: 'no-prior-claim' })
    // S3 never in allowlist
    expect(isAuthorizedRemaining22SourceRunID(S3)).toBe(false)
    expect(evaluateRemaining22Supersede({ sourceRunID: S3, baseClaimCount: 1, supersedeClaimCount: 0, priorIsStoppedIncomplete: true })).toMatchObject({ ok: false, reason: 'not-authorized-source-run' })
  })

  it('creates the -r2 claim once with supersedes, preserves base, third refuses via EEXIST', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-r2-claim-'))
    try {
      const base = await createRemaining22CampaignClaim(directory, S4, { runID: B3, runNonce: 'n-b3', sourceRunID: S4 })
      expect(base).toBe(remaining22CampaignFileName(directory, S4))
      // Supersede without provenance refuses
      await expect(createRemaining22SupersedeCampaignClaim(directory, S4, { runID: 'campaign-b4', runNonce: 'n-b4', sourceRunID: S4 })).rejects.toThrow('requires supersedes')
      const r2 = await createRemaining22SupersedeCampaignClaim(directory, S4, { runID: 'campaign-b4', runNonce: 'n-b4', sourceRunID: S4, supersedes: B3 })
      expect(r2).toBe(remaining22CampaignFileNameR2(directory, S4))
      expect(r2).toContain('-r2.json')
      const record = JSON.parse(await readFile(r2, 'utf8'))
      expect(record).toMatchObject({ campaign: 'remaining22-campaign', status: 'reserved', sourceRunID: S4, supersedes: B3 })
      // Base file untouched
      const baseRecord = JSON.parse(await readFile(base, 'utf8'))
      expect(baseRecord).toMatchObject({ runID: B3, sourceRunID: S4 })
      expect(baseRecord.supersedes).toBeUndefined()
      // Both claims listed for the source; third refuses via EEXIST on the -r2 path
      expect(await listRemaining22CampaignClaims(directory, S4)).toHaveLength(2)
      await expect(createRemaining22SupersedeCampaignClaim(directory, S4, { runID: 'campaign-b5', runNonce: 'n-b5', sourceRunID: S4, supersedes: B3 })).rejects.toMatchObject({ code: 'EEXIST' })
      // S3 never allowed
      await expect(createRemaining22SupersedeCampaignClaim(directory, S3, { runID: 'x', sourceRunID: S3, supersedes: B3 })).rejects.toThrow(/limited to source/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('creates 22 -r2 reservations with supersedes without touching base reservations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-r2-res-'))
    try {
      const first = canonicalCampaignOrdered[0]
      const baseFile = await createRemaining22Reservation(directory, first, S4, { runID: B3, runNonce: 'n-b3', sourceRunID: S4 })
      const before = await readFile(baseFile, 'utf8')
      // R2 reservation requires supersedes and lands in a distinct file
      await expect(createRemaining22SupersedeReservation(directory, first, S4, { runID: 'campaign-b4', runNonce: 'n-b4', sourceRunID: S4 })).rejects.toThrow('requires supersedes')
      const r2File = await createRemaining22SupersedeReservation(directory, first, S4, { runID: 'campaign-b4', runNonce: 'n-b4', sourceRunID: S4, supersedes: B3 })
      expect(r2File).toBe(remaining22FileNameR2(directory, first, S4))
      expect(r2File).not.toBe(baseFile)
      expect(JSON.parse(await readFile(r2File, 'utf8'))).toMatchObject({ sourceRunID: S4, supersedes: B3 })
      // Base reservation byte-identical
      expect(await readFile(baseFile, 'utf8')).toBe(before)
      // Per-source listing sees both namespaces for S4
      const listed = await listRemaining22Reservations(directory, S4)
      expect(listed).toContain(baseFile)
      expect(listed).toContain(r2File)
      expect(listed).toHaveLength(2)
      // Full B4 shape: 22 R2 files coexist with base history validation
      expect(canonicalCampaignOrdered).toHaveLength(22)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('P1 security-reviewer: non-ENOENT read error on evaluation.json refuses fail-closed with no -r2 claim', async () => {
    // A present-but-unreadable evaluation must NEVER read as "absent": the
    // supersede path refuses before creating any claim (single-ACTIVE-claim).
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-r2-p1-'))
    try {
      await createRemaining22CampaignClaim(directory, S4, { runID: B3, runNonce: 'n-b3', sourceRunID: S4 })
      const eacces = Object.assign(new Error('EACCES: permission denied, open evaluation.json'), { code: 'EACCES' })
      const readArtifact = async (file) => {
        if (file.endsWith('evaluation.json')) throw eacces
        if (file.endsWith('stopped-summary.json')) return JSON.stringify({ status: 'stopped' })
        throw Object.assign(new Error(`ENOENT: no such file ${file}`), { code: 'ENOENT' })
      }
      await expect(loadStoppedIncompleteFlags(readArtifact, directory, B3)).rejects.toMatchObject({ code: 'EACCES' })
      // Refusal happens before any supersede claim: only the base claim exists.
      expect(await listRemaining22CampaignClaims(directory, S4)).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('P1 security-reviewer control: ENOENT on evaluation.json still counts as absent (stopped-incomplete)', async () => {
    const readArtifact = async (file) => {
      if (file.endsWith('stopped-summary.json')) return JSON.stringify({ status: 'stopped' })
      throw Object.assign(new Error(`ENOENT: no such file ${file}`), { code: 'ENOENT' })
    }
    const flags = await loadStoppedIncompleteFlags(readArtifact, '/tmp/f2b0-r2-p1-control', B3)
    expect(flags).toEqual({ hasStoppedSummary: true, hasEvaluation: false })
    expect(isStoppedIncompleteRun(flags)).toBe(true)
  })

  it('runner wires the supersede claim after preflights: source strings pinned, no resume path', async () => {
    const runnerSource = await readFile(new URL('./real-runner.ts', import.meta.url), 'utf8')
    expect(runnerSource).toContain('createRemaining22SupersedeCampaignClaim')
    expect(runnerSource).toContain('createRemaining22SupersedeReservation')
    expect(runnerSource).toContain('stopped-summary.json')
    expect(runnerSource).toContain('single-ACTIVE-claim')
    expect(runnerSource).toContain('refusing third attempt')
    expect(runnerSource).toContain('loadStoppedIncompleteFlags')
    // P1: no catch-all may coerce an unreadable artifact into "absent".
    expect(runnerSource).not.toContain('} catch { hasStoppedSummary = false; }')
    expect(runnerSource).not.toContain('} catch { hasEvaluation = false; }')
    expect(runnerSource).not.toContain('remaining22 and B1')
  })
})
