import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { summarizeStoppedRun } from './real-guard.mjs'

const caseKey = (id) => id.replace(/[^a-zA-Z0-9._-]/g, '_')

export async function createExclusiveRunLock(file, metadata) {
  await mkdir(path.dirname(file), { recursive: true })
  const ownerToken = randomUUID()
  const record = { ...metadata, ownerToken, acquiredAt: new Date().toISOString() }
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  let released = false
  return {
    file,
    async release() {
      if (released) return
      const current = JSON.parse(await readFile(file, 'utf8'))
      if (current.ownerToken !== ownerToken) throw new Error('run lock ownership changed; refusing to unlink')
      await unlink(file)
      released = true
    },
  }
}

export async function createCaseReservation(directory, caseID, metadata) {
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${caseKey(caseID)}.reserved`)
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify({ ...metadata, caseID, status: 'reserved', reservedAt: new Date().toISOString() }, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return file
}

export async function listReservationIDs(directory) {
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const reservations = []
  for (const name of names.filter((entry) => entry.endsWith('.reserved'))) {
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (typeof record.caseID !== 'string' || record.status !== 'reserved') throw new Error(`invalid reservation record: ${name}`)
    reservations.push(record.caseID)
  }
  return reservations
}

export async function finalizeStoppedRun(runDir, runID, caseIDs, caseResults, stop) {
  const report = summarizeStoppedRun(runID, caseIDs, caseResults)
  const stopRecord = { runID, stop, stoppedSummary: 'stopped-summary.json' }
  const create = async (file, value) => {
    const handle = await open(path.join(runDir, file), 'wx')
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() }
    finally { await handle.close() }
  }
  await create('stopped-summary.json', report)
  await create('stopped.json', stopRecord)
  return report
}
