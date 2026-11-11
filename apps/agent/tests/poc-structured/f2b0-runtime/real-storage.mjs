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

export function freshSmokeFileName(directory, caseID, newRunID) {
  return path.join(directory, `${caseKey(caseID)}.fresh-smoke-${caseKey(newRunID)}.json`)
}

export async function listFreshSmokeReservations(directory, caseID) {
  const prefix = `${caseKey(caseID)}.fresh-smoke-`
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const matches = []
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))) {
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (record.caseID !== caseID || record.freshSmoke !== true) throw new Error(`invalid fresh smoke record: ${name}`)
    matches.push(path.join(directory, name))
  }
  return matches.sort()
}

export async function createFreshSmokeReservation(directory, caseID, newRunID, metadata) {
  if (caseID !== 'F1-B005') throw new Error('fresh smoke reservation is limited to F1-B005')
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(newRunID)) throw new Error('fresh smoke run id is not a safe run-id')
  if (!metadata || metadata.sourceMarker !== 'fresh') throw new Error('fresh smoke reservation requires sourceMarker fresh')
  await mkdir(directory, { recursive: true })
  const file = freshSmokeFileName(directory, caseID, newRunID)
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify({ ...metadata, caseID, status: 'reserved', freshSmoke: true, sourceMarker: 'fresh', reservedAt: new Date().toISOString() }, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return file
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

export const REMAINING22_SUPERSEDE_SUFFIX = '-r2'

export function remaining22FileNameR2(directory, caseID, sourceRunID) {
  return path.join(directory, `${caseKey(caseID)}.remaining22-${caseKey(sourceRunID)}${REMAINING22_SUPERSEDE_SUFFIX}.json`)
}

export function remaining22CampaignFileNameR2(directory, sourceRunID) {
  return path.join(directory, `remaining22-campaign-${caseKey(sourceRunID)}${REMAINING22_SUPERSEDE_SUFFIX}.json`)
}

export async function listRemaining22Reservations(directory, sourceRunID) {
  const names = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const matches = []
  const marker = '.remaining22-'
  for (const name of names.filter((entry) => entry.includes(marker) && entry.endsWith('.json'))) {
    const fileSourceKey = name.slice(name.indexOf(marker) + marker.length, -'.json'.length)
    if (sourceRunID !== undefined && fileSourceKey !== caseKey(sourceRunID) && fileSourceKey !== `${caseKey(sourceRunID)}${REMAINING22_SUPERSEDE_SUFFIX}`) continue
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
    if (typeof record.caseID !== 'string' || record.status !== 'reserved') throw new Error(`invalid remaining22 record: ${name}`)
    if (record.campaign !== 'remaining22') throw new Error(`invalid remaining22 record: ${name}`)
    if (typeof record.sourceRunID !== 'string') throw new Error(`invalid remaining22 record: ${name}`)
    const isR2File = fileSourceKey === `${caseKey(record.sourceRunID)}${REMAINING22_SUPERSEDE_SUFFIX}`
    const isBaseFile = fileSourceKey === caseKey(record.sourceRunID)
    if (!isBaseFile && !isR2File) throw new Error(`invalid remaining22 record: ${name}`)
    if (sourceRunID !== undefined && record.sourceRunID !== sourceRunID) throw new Error(`invalid remaining22 record: ${name}`)
    const expectedBase = `${caseKey(record.caseID)}.remaining22-${caseKey(record.sourceRunID)}.json`
    const expectedR2 = `${caseKey(record.caseID)}.remaining22-${caseKey(record.sourceRunID)}${REMAINING22_SUPERSEDE_SUFFIX}.json`
    if (name !== expectedBase && name !== expectedR2) throw new Error(`invalid remaining22 record: ${name}`)
    if (name === expectedR2 && (typeof record.supersedes !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(record.supersedes))) throw new Error(`invalid remaining22 record: ${name}`)
    matches.push(path.join(directory, name))
  }
  return matches.sort()
}

export async function createRemaining22Reservation(directory, caseID, sourceRunID, metadata) {
  if (caseID === 'F1-B005') throw new Error('remaining22 campaign must never reserve the historic smoke case')
  if (sourceRunID !== '2026-10-29T12-26-34-600Z-4324' && sourceRunID !== '2026-10-29T20-54-25-649Z-6500' && sourceRunID !== '2026-10-29T22-34-44-294Z-10836') throw new Error('remaining22 reservation is limited to source allowlist [2026-10-29T12-26-34-600Z-4324,2026-10-29T20-54-25-649Z-6500,2026-10-29T22-34-44-294Z-10836]')
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

export async function createRemaining22SupersedeReservation(directory, caseID, sourceRunID, metadata) {
  if (caseID === 'F1-B005') throw new Error('remaining22 campaign must never reserve the historic smoke case')
  if (sourceRunID !== '2026-10-29T12-26-34-600Z-4324' && sourceRunID !== '2026-10-29T20-54-25-649Z-6500' && sourceRunID !== '2026-10-29T22-34-44-294Z-10836') throw new Error('remaining22 reservation is limited to source allowlist [2026-10-29T12-26-34-600Z-4324,2026-10-29T20-54-25-649Z-6500,2026-10-29T22-34-44-294Z-10836]')
  if (!metadata || typeof metadata.supersedes !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(metadata.supersedes)) throw new Error('remaining22 supersede reservation requires supersedes stopped runID')
  await mkdir(directory, { recursive: true })
  const file = remaining22FileNameR2(directory, caseID, sourceRunID)
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
    if (name.endsWith(`${REMAINING22_SUPERSEDE_SUFFIX}.json`) && (typeof record.supersedes !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(record.supersedes))) throw new Error(`invalid remaining22 campaign record: ${name}`)
    matches.push(path.join(directory, name))
  }
  return matches.sort()
}

export async function createRemaining22CampaignClaim(directory, sourceRunID, metadata) {
  if (sourceRunID !== '2026-10-29T12-26-34-600Z-4324' && sourceRunID !== '2026-10-29T20-54-25-649Z-6500' && sourceRunID !== '2026-10-29T22-34-44-294Z-10836') throw new Error('remaining22 campaign claim is limited to source allowlist [2026-10-29T12-26-34-600Z-4324,2026-10-29T20-54-25-649Z-6500,2026-10-29T22-34-44-294Z-10836]')
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

export async function createRemaining22SupersedeCampaignClaim(directory, sourceRunID, metadata) {
  if (sourceRunID !== '2026-10-29T12-26-34-600Z-4324' && sourceRunID !== '2026-10-29T20-54-25-649Z-6500' && sourceRunID !== '2026-10-29T22-34-44-294Z-10836') throw new Error('remaining22 campaign claim is limited to source allowlist [2026-10-29T12-26-34-600Z-4324,2026-10-29T20-54-25-649Z-6500,2026-10-29T22-34-44-294Z-10836]')
  if (!metadata || typeof metadata.supersedes !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(metadata.supersedes)) throw new Error('remaining22 supersede claim requires supersedes stopped runID')
  await mkdir(directory, { recursive: true })
  const file = remaining22CampaignFileNameR2(directory, sourceRunID)
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
