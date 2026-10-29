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
    if (name.includes('.authorized-retry-')) continue
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (typeof record.caseID !== 'string' || record.status !== 'reserved') throw new Error(`invalid reservation record: ${name}`)
    reservations.push(record.caseID)
  }
  return reservations
}

export function authorizedRetryFileName(directory, caseID, newRunID) {
  return path.join(directory, `${caseKey(caseID)}.authorized-retry-${caseKey(newRunID)}.json`)
}

export function consumedSmokeFileName(directory, caseID, sourceRunID) {
  return path.join(directory, `${caseKey(caseID)}.consumed-smoke-${caseKey(sourceRunID)}.json`)
}

export async function listAuthorizedRetryReservations(directory, caseID) {
  const prefix = `${caseKey(caseID)}.authorized-retry-`
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const matches = []
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))) {
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (record.caseID !== caseID || record.authorizedRetry !== true) throw new Error(`invalid authorized retry record: ${name}`)
    matches.push(path.join(directory, name))
  }
  return matches.sort()
}

export async function createAuthorizedRetryReservation(directory, caseID, newRunID, metadata) {
  await mkdir(directory, { recursive: true })
  const file = authorizedRetryFileName(directory, caseID, newRunID)
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify({ ...metadata, caseID, status: 'reserved', authorizedRetry: true, reservedAt: new Date().toISOString() }, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return file
}

export async function listConsumedSmokeReservations(directory, caseID) {
  const prefix = `${caseKey(caseID)}.consumed-smoke-`
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const matches = []
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))) {
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (record.caseID !== caseID || record.consumedSmoke !== true) throw new Error(`invalid consumed smoke record: ${name}`)
    matches.push(path.join(directory, name))
  }
  return matches.sort()
}

export async function createConsumedSmokeReservation(directory, caseID, sourceRunID, metadata) {
  await mkdir(directory, { recursive: true })
  const file = consumedSmokeFileName(directory, caseID, sourceRunID)
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify({ ...metadata, caseID, status: 'reserved', consumedSmoke: true, sourceRunID, reservedAt: new Date().toISOString() }, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return file
}

export function remaining22FileName(directory, caseID, sourceRunID) {
  return path.join(directory, `${caseKey(caseID)}.remaining22-${caseKey(sourceRunID)}.json`)
}

export async function listRemaining22Reservations(directory, sourceRunID) {
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const matches = []
  for (const name of names.filter((entry) => entry.includes('.remaining22-') && entry.endsWith('.json'))) {
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (record.caseID !== caseKey(record.caseID)) throw new Error(`invalid remaining22 record: ${name}`)
    if (typeof record.caseID !== 'string' || record.status !== 'reserved') throw new Error(`invalid remaining22 record: ${name}`)
    if (record.campaign !== 'remaining22') throw new Error(`invalid remaining22 record: ${name}`)
    if (typeof record.sourceRunID !== 'string') throw new Error(`invalid remaining22 record: ${name}`)
    if (sourceRunID !== undefined && record.sourceRunID !== sourceRunID) continue
    matches.push(path.join(directory, name))
  }
  return matches.sort()
}

export async function createRemaining22Reservation(directory, caseID, sourceRunID, metadata) {
  if (caseID === 'F1-B005') throw new Error('remaining22 campaign must never reserve the historic smoke case')
  if (sourceRunID !== '2026-10-29T12-26-34-600Z-4324') throw new Error('remaining22 reservation is limited to the fixed historic smoke source')
  await mkdir(directory, { recursive: true })
  const file = remaining22FileName(directory, caseID, sourceRunID)
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify({ ...metadata, caseID, status: 'reserved', campaign: 'remaining22', sourceRunID, reservedAt: new Date().toISOString() }, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return file
}

export function remaining22CampaignFileName(directory, sourceRunID) {
  return path.join(directory, `remaining22-campaign-${caseKey(sourceRunID)}.json`)
}

export async function listRemaining22CampaignClaims(directory, sourceRunID) {
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const matches = []
  for (const name of names.filter((entry) => entry.startsWith('remaining22-campaign-') && entry.endsWith('.json'))) {
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (record.campaign !== 'remaining22-campaign' || record.status !== 'reserved') throw new Error(`invalid remaining22 campaign record: ${name}`)
    if (typeof record.sourceRunID !== 'string' || typeof record.runID !== 'string') throw new Error(`invalid remaining22 campaign record: ${name}`)
    if (sourceRunID !== undefined && record.sourceRunID !== sourceRunID) continue
    matches.push(path.join(directory, name))
  }
  return matches.sort()
}

export async function createRemaining22CampaignClaim(directory, sourceRunID, metadata) {
  if (sourceRunID !== '2026-10-29T12-26-34-600Z-4324') throw new Error('remaining22 campaign claim is limited to the fixed historic smoke source')
  await mkdir(directory, { recursive: true })
  const file = remaining22CampaignFileName(directory, sourceRunID)
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify({ ...metadata, campaign: 'remaining22-campaign', status: 'reserved', sourceRunID, reservedAt: new Date().toISOString() }, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return file
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
