import { appendFile } from 'node:fs/promises'
import { Plugin } from '@opencode/plugin'

const evidence = process.env.F2B0_EVIDENCE
const write = async (row) => appendFile(evidence, `${JSON.stringify(row)}\n`)
const perSession = new Map()
const allowedProvider = 'opencode'
const allowedModel = 'deepseek-v4.1-flash-free'
const allowedPort = process.env.F2B0_MODE === 'refused' ? '43192' : '43191'
const expectedOrigin = process.env.F2B0_EXPECTED_ORIGIN
const expectedPath = process.env.F2B0_EXPECTED_PATH
const ids = (value) => {
  if (Array.isArray(value)) return value.map((x) => typeof x === 'string' ? x : x?.id ?? x?.name ?? 'unknown')
  if (value && typeof value === 'object') {
    for (const key of ['data', 'servers', 'skills', 'plugins', 'items']) if (key in value) return ids(value[key])
    return Object.keys(value)
  }
  return []
}

export default Plugin.define({
  id: 'f2b0.retry-proof',
  async setup(ctx) {
    await ctx.skill.transform((editor) => { for (const skill of editor.list()) editor.remove(skill.id) })
    const [tools, mcps, skills, plugins] = await Promise.all([ctx.tool.list(), ctx.mcp.list(), ctx.skill.list(), ctx.plugin.list()])
    await write({ event: 'effective-config', version: ctx.app.version, tools: ids(tools), mcp: ids(mcps), skills: ids(skills), plugins: ids(plugins) })
    await ctx.session.hook('context', async (event) => {
      for (const name of Object.keys(event.tools)) delete event.tools[name]
      await write({ event: 'context', kind: 'primary', toolCountAfterStrip: Object.keys(event.tools).length })
    })
    await ctx.session.hook('generate', async (event) => { await write({ event: 'auxiliary-blocked', kind: 'generate', provider: event.model.providerID, model: event.model.id }); throw new Error('auxiliary inference blocked') })
    await ctx.session.hook('title', async () => { await write({ event: 'auxiliary-blocked', kind: 'title' }); throw new Error('auxiliary inference blocked') })
    await ctx.session.hook('compaction', async () => { await write({ event: 'auxiliary-blocked', kind: 'compaction' }); throw new Error('auxiliary inference blocked') })
    await ctx.session.hook('retry', async (event) => {
      if (event.model.providerID !== allowedProvider || event.model.id !== allowedModel) throw new Error('unexpected retry model; blocked')
      await write({ event: 'retry', type: event.error.type, status: event.error.status ?? null, attempt: event.attempt, proposedRetry: event.decision.retry })
      event.decision = { retry: false }
      await write({ event: 'retry-veto', attempt: event.attempt, retry: event.decision.retry })
    })
    await ctx.session.hook('http.request', async (event) => {
      if (event.kind !== 'primary') throw new Error(`auxiliary HTTP request blocked: ${event.kind}`)
      if (event.model.providerID !== allowedProvider || event.model.id !== allowedModel) throw new Error('unexpected provider/model; blocked')
      const count = (perSession.get(event.sessionID) ?? 0) + 1
      perSession.set(event.sessionID, count)
      if (count > 1) throw new Error('second physical request for session blocked')
      const originalURL = event.request.url
      const original = new URL(originalURL)
      if (process.env.F2B0_PROBE_NATIVE_URL === '1') {
        await write({ event: 'native-url-probe', origin: original.origin, path: original.pathname, queryPresent: Boolean(original.search), kind: event.kind, provider: event.model.providerID, model: event.model.id })
        throw new Error('native URL probe blocked before transport')
      }
      if (event.kind !== 'primary' || original.origin !== expectedOrigin || original.pathname !== expectedPath || original.search) throw new Error('unexpected native URL/kind rejected before transport')
      const localURL = `http://127.0.0.1:${allowedPort}/v1/chat/completions`
      const routed = new Request(localURL, event.request)
      const headers = routed.headers
      const authPresentBeforeStrip = headers.has('authorization') || headers.has('x-api-key') || headers.has('api-key')
      headers.delete('authorization')
      headers.delete('x-api-key')
      headers.delete('api-key')
      const authPresentAfterStrip = headers.has('authorization') || headers.has('x-api-key') || headers.has('api-key')
      if (authPresentAfterStrip) throw new Error('credential header remained after local-strip')
      event.request = routed
      await write({ event: 'http.request', kind: event.kind, provider: event.model.providerID, model: event.model.id, sessionRequestCount: count, method: event.request.method, originalOrigin: original.origin, originalPath: original.pathname, routeOrigin: new URL(event.request.url).origin, target: new URL(event.request.url).pathname, localOnly: true, authPresentBeforeStrip, authPresentAfterStrip })
    })
    await ctx.session.hook('http.response', async (event) => {
      await write({ event: 'http.response', status: event.response.status })
    })
  },
})
