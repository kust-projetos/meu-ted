import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Plugin } from '@opencode/plugin'
import { REAL_MODEL, REAL_URL, validateCatalogCost, validateNativeRequest } from '../real-guard.mjs'

const evidence = process.env.F2B0_REAL_EVIDENCE
const runNonce = process.env.F2B0_REAL_NONCE
const requestCounts = new Map()
const write = async (record) => appendFile(evidence, `${JSON.stringify({ ...record, runNonce })}\n`)
const key = (sessionID) => createHash('sha256').update(sessionID).digest('hex').slice(0, 12)

const collection = (value) => {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    for (const name of ['data', 'servers', 'skills', 'items']) if (name in value) return collection(value[name])
  }
  return []
}

const fail = async (reason, fields = {}) => {
  await write({ event: 'guard-failed', reason, ...fields })
  throw new Error(`F2B0 real guard blocked: ${reason}`)
}

export default Plugin.define({
  id: 'f2b0.real-run-guard',
  async setup(ctx) {
    const models = await ctx.model.list()
    const selected = collection(models).find((model) => model.providerID === REAL_MODEL.providerID && model.id === REAL_MODEL.modelID)
    if (!selected) await fail('target-model-not-in-catalog')
    const cost = validateCatalogCost(selected.cost)
    if (!cost.ok) await fail(cost.reason, { provider: selected.providerID, model: selected.id })

    const configuredMcp = await ctx.mcp.list()
    if (collection(configuredMcp).length !== 0) await fail('mcp-configured')
    await ctx.skill.transform((editor) => { for (const item of editor.list()) editor.remove(item.id) })
    const skills = await ctx.skill.list()
    if (collection(skills).length !== 0) await fail('skills-not-empty')
    const plugins = collection(await ctx.plugin.list()).map((plugin) => plugin.id ?? plugin.name ?? 'unknown')
    const otherPlugins = plugins.filter((id) => id !== 'f2b0.real-run-guard')
    if (otherPlugins.length !== 0) await fail('unexpected-plugin-configured', { pluginCount: otherPlugins.length })

    await ctx.session.hook('context', async (event) => {
      for (const name of Object.keys(event.tools)) delete event.tools[name]
      const count = Object.keys(event.tools).length
      await write({ event: 'context', sessionKey: key(event.sessionID), effectiveToolCount: count })
      if (count !== 0) await fail('tools-remain-in-context', { sessionKey: key(event.sessionID), count })
    })
    await ctx.session.hook('generate', async (event) => {
      await write({ event: 'auxiliary-blocked', kind: 'generate', provider: event.model.providerID, model: event.model.id })
      throw new Error('auxiliary generation blocked')
    })
    await ctx.session.hook('title', async () => {
      await write({ event: 'auxiliary-blocked', kind: 'title' })
      throw new Error('title generation blocked')
    })
    await ctx.session.hook('compaction', async () => {
      await write({ event: 'auxiliary-blocked', kind: 'compaction' })
      throw new Error('compaction generation blocked')
    })
    await ctx.session.hook('retry', async (event) => {
      if (event.model.providerID !== REAL_MODEL.providerID || event.model.id !== REAL_MODEL.modelID) {
        await fail('retry-model-mismatch', { sessionKey: key(event.sessionID) })
      }
      await write({ event: 'retry-veto', sessionKey: key(event.sessionID), attempt: event.attempt, type: event.error.type, status: event.error.status ?? null, proposedRetry: event.decision.retry })
      event.decision = { retry: false }
      await write({ event: 'retry-decision', sessionKey: key(event.sessionID), attempt: event.attempt, retry: false })
    })
    await ctx.session.hook('http.request', async (event) => {
      const sessionKey = key(event.sessionID)
      const count = (requestCounts.get(event.sessionID) ?? 0) + 1
      requestCounts.set(event.sessionID, count)
      const bodyText = await event.request.clone().text()
      let body
      try { body = JSON.parse(bodyText) } catch { await fail('request-body-not-json', { sessionKey }) }
      const guardedRequest = new Request(event.request, { redirect: 'error' })
      const verdict = validateNativeRequest({
        providerID: event.model.providerID,
        modelID: event.model.id,
        kind: event.kind,
        url: event.request.url,
        method: event.request.method,
        sessionRequestCount: count,
        redirect: guardedRequest.redirect,
        body,
      })
      if (!verdict.ok) await fail(verdict.reason, { sessionKey })
      if (guardedRequest.url !== event.request.url || guardedRequest.method !== event.request.method) {
        await fail('native-request-mutated', { sessionKey })
      }
      event.request = guardedRequest
      await write({
        event: 'http-request-allowed',
        sessionKey,
        provider: event.model.providerID,
        model: event.model.id,
        kind: event.kind,
        url: guardedRequest.url,
        method: guardedRequest.method,
        requestCount: count,
        redirect: guardedRequest.redirect,
        bodySha256: createHash('sha256').update(bodyText).digest('hex'),
        bodyModel: body.model,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        authorizationPresent: guardedRequest.headers.has('authorization'),
      })
    })
    await ctx.session.hook('http.response', async (event) => {
      const status = event.response.status
      await write({ event: 'http-response', sessionKey: key(event.sessionID), status })
      if (status >= 300 && status < 400) await fail('redirect-response-blocked', { sessionKey: key(event.sessionID), status })
      if (status >= 400) await write({ event: 'provider-response-failure', sessionKey: key(event.sessionID), status })
    })

    await write({
      event: 'plugin-ready',
      version: ctx.app.version,
      provider: REAL_MODEL.providerID,
      model: REAL_MODEL.modelID,
      cost: { zero: true, tiers: cost.tiers },
      mcpCount: 0,
      skillCount: 0,
      otherPluginCount: 0,
    })
  },
})
