import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createRemaining22Reservation,
  listRemaining22Reservations,
} from './real-storage.mjs'

// Regression: S1 remaining22 records use historic caseID format with colon
// (e.g. "J01:T1") while the file name uses caseKey ("J01_T1").
// listRemaining22Reservations must scope validation to the requested
// sourceRunID (filter by source BEFORE validating) and must accept the
// historic colon format via caseKey normalization — never poisoning a
// future campaign (B2-S2) with an unrelated source's records.
const S1 = '2026-10-29T12-26-34-600Z-4324'
const S2 = '2026-10-29T20-54-25-649Z-6500'

const s1Record = (caseID) => ({
  runID: '2026-10-29T13-25-07-295Z-6180',
  runNonce: 'b69a97fa-5d10-4720-a1eb-d4ef66e86561',
  sourceRunID: S1,
  caseID,
  status: 'reserved',
  campaign: 'remaining22',
  reservedAt: '2026-10-29T13:31:35.358Z',
})

describe('remaining22 colon-format source isolation (S1 history vs S2 campaign)', () => {
  it('RED: listing S2 ignores historic S1 colon records instead of throwing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-colon-'))
    try {
      const s1File = path.join(directory, `J01_T1.remaining22-${S1}.json`)
      await writeFile(s1File, `${JSON.stringify(s1Record('J01:T1'), null, 2)}\n`)
      const before = await readFile(s1File, 'utf8')
      // S1 history must not poison the S2 campaign listing.
      expect(await listRemaining22Reservations(directory, S2)).toEqual([])
      // No mutation of the historic record.
      expect(await readFile(s1File, 'utf8')).toBe(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('lists S1 colon records for their own source (history stays valid)', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-colon-s1-'))
    try {
      const s1File = path.join(directory, `J01_T1.remaining22-${S1}.json`)
      await writeFile(s1File, `${JSON.stringify(s1Record('J01:T1'), null, 2)}\n`)
      const before = await readFile(s1File, 'utf8')
      expect(await listRemaining22Reservations(directory, S1)).toEqual([s1File])
      expect(await readFile(s1File, 'utf8')).toBe(before)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps per-source namespaces disjoint when S1 history and S2 reservations coexist', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-colon-both-'))
    try {
      const s1File = path.join(directory, `J01_T1.remaining22-${S1}.json`)
      await writeFile(s1File, `${JSON.stringify(s1Record('J01:T1'), null, 2)}\n`)
      const s2File = await createRemaining22Reservation(directory, 'J01:T1', S2, {
        runID: 'campaign-s2',
        runNonce: 's2-nonce',
        sourceRunID: S2,
      })
      expect(await listRemaining22Reservations(directory, S2)).toEqual([s2File])
      expect(await listRemaining22Reservations(directory, S1)).toEqual([s1File])
      expect(await listRemaining22Reservations(directory)).toEqual([s1File, s2File].sort())
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when the S2 file name carries a divergent sourceRunID (no silent skip)', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-colon-spoof-'))
    try {
      const spoofFile = path.join(directory, `J01_T1.remaining22-${S2}.json`)
      await writeFile(spoofFile, `${JSON.stringify(s1Record('J01:T1'), null, 2)}\n`)
      // Record claims S1 but the file name claims S2: listing S2 must throw,
      // never silently ignore the corruption.
      await expect(listRemaining22Reservations(directory, S2)).rejects.toThrow(
        `invalid remaining22 record: J01_T1.remaining22-${S2}.json`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('still fails closed on a corrupt record of the requested source', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2b0-remaining22-colon-bad-'))
    try {
      const badFile = path.join(directory, `J01_T1.remaining22-${S2}.json`)
      await writeFile(
        badFile,
        `${JSON.stringify({ ...s1Record('J01:T1'), sourceRunID: S2, campaign: 'tampered' }, null, 2)}\n`,
      )
      await expect(listRemaining22Reservations(directory, S2)).rejects.toThrow(
        `invalid remaining22 record: J01_T1.remaining22-${S2}.json`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
