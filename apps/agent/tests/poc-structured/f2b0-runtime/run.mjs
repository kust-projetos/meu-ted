import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { REAL_MODEL } from './real-guard.mjs'

const root = path.resolve(import.meta.dirname)
const exe = process.env.OPENCODE_EXE ?? 'C:/Users/walis/AppData/Roaming/npm/node_modules/@opencode/cli/node_modules/@opencode/cli-windows-x64/bin/opencode.exe'
const base = 'C:/Users/walis/AppData/Local/Temp/opencode/f2b0-retry-proof'
const runID = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`
const runDir = path.join(base, runID)
const cases = ['429', '500', '503', 'timeout', 'reset', 'refused', 'proxy-refused', 'stream', 'valid']
const allowedModel = REAL_MODEL.modelID
const portFor = (mode) => mode === 'refused' ? 43192 : 43191
await mkdir(runDir, { recursive: true })

const envBase = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  USERPROFILE: undefined,
  APPDATA: undefined,
  LOCALAPPDATA: undefined,
  TEMP: undefined,
  TMP: undefined,
  HOME: undefined,
}

async function runCase(mode, nativeEndpoint = null) {
  const dir = path.join(runDir, mode)
  for (const name of ['config', 'data', 'cache', 'state', 'work', 'home', 'appdata', 'localappdata', 'tmp']) await mkdir(path.join(dir, name), { recursive: true })
  const mockLog = path.join(dir, 'requests.ndjson'), connLog = path.join(dir, 'connections.ndjson'), evidence = path.join(dir, 'hooks.ndjson')
  await writeFile(mockLog, '')
  await writeFile(connLog, '')
  await writeFile(evidence, '')
  const port = portFor(mode)
  const cfg = {
    '$schema': 'https://opencode.ai/config.json', model: `${REAL_MODEL.providerID}/${REAL_MODEL.modelID}`, default_agent: 'build',
    plugins: [path.join(root, 'plugin').replaceAll('\\', '/')], compaction: { auto: false }, mcp: { servers: {} },
    agents: { build: { model: `${REAL_MODEL.providerID}/${REAL_MODEL.modelID}`, mode: 'primary', system: 'Reply exactly OK.', permissions: [{ action: '*', resource: '*', effect: 'deny' }] } },
    providers: { [REAL_MODEL.providerID]: { settings: { apiKey: 'local-mock-only-not-a-credential', timeout: 500, headerTimeout: 300, chunkTimeout: 300, transport: 'http' } } },
  }
  await writeFile(path.join(dir, 'config', 'opencode.json'), JSON.stringify(cfg))
  const env = { ...envBase, USERPROFILE: path.join(dir, 'home'), APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'localappdata'), TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), HOME: path.join(dir, 'home'), OPENCODE_CONFIG_DIR: path.join(dir, 'config'), OPENCODE_DATA_DIR: path.join(dir, 'data'), OPENCODE_CACHE_DIR: path.join(dir, 'cache'), OPENCODE_STATE_DIR: path.join(dir, 'state'), OPENCODE_DISABLE_PROJECT_CONFIG: '1', XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_STATE_HOME: path.join(dir, 'state'), F2B0_EVIDENCE: evidence, F2B0_MOCK_LOG: mockLog, F2B0_CONN_LOG: connLog, F2B0_MODE: mode, F2B0_MODEL: allowedModel, F2B0_PROVIDER: REAL_MODEL.providerID, F2B0_PROBE_NATIVE_URL: mode === 'probe-native' ? '1' : '0', F2B0_EXPECTED_ORIGIN: nativeEndpoint?.origin ?? '', F2B0_EXPECTED_PATH: nativeEndpoint?.path ?? '' }
  const mock = spawn(process.execPath, [path.join(root, 'mock.mjs')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const mockExit = once(mock, 'exit')
  let mockErr = '', ready = false
  mock.stderr.on('data', (b) => { mockErr += b.toString() })
  const startup = new Promise((resolve, reject) => {
    mock.stdout.on('data', (b) => { if (b.toString().includes('READY')) { ready = true; resolve() } })
    mock.once('error', reject)
    mock.once('exit', (code) => { if (!ready) reject(new Error(`mock exited during startup: ${code} ${mockErr}`)) })
  })
  let cli, timedOut = false
  try {
    await Promise.race([startup, new Promise((_, reject) => setTimeout(() => reject(new Error('mock startup timed out')), 3000))])
    cli = spawn(exe, ['run', '--standalone', '--print-logs', '--log-level', 'debug', '--model', `${REAL_MODEL.providerID}/${REAL_MODEL.modelID}`, '--agent', 'build', '--format', 'json', 'Reply exactly OK.'], { cwd: path.join(dir, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    cli.stdout.on('data', (b) => { stdout += b.toString() })
    cli.stderr.on('data', (b) => { stderr += b.toString() })
    cli.once('error', (error) => { stderr += `SPAWN_ERROR:${error.message}` })
    const resultExit = await Promise.race([once(cli, 'exit').then(([code]) => code), new Promise((resolve) => setTimeout(() => { timedOut = true; cli.kill(); resolve(null) }, 15000))])
    const requests = (await readFile(mockLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    const connections = (await readFile(connLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    const hooks = (await readFile(evidence, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    const stdoutEvents = stdout.trim().split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
    const assistantText = stdoutEvents.filter((x) => x.type === 'text' || x.part?.type === 'text').map((x) => x.part?.text ?? x.text ?? '').filter(Boolean)
    const terminalErrors = stdoutEvents.filter((x) => x.type === 'error').map((x) => {
      const error = x.error ?? {}
      return { type: error.type ?? error.code ?? error.name ?? 'unknown', message: String(error.message ?? '').replace(/https?:\/\/[^\s"']+/gi, '[url]').replace(/(bearer\s+)\S+/gi, '$1[redacted]').slice(0, 180) }
    })
    const eventTypes = stdoutEvents.map((x) => x.type)
    const knownError = ['ECONNREFUSED', 'provider.invalid-output', 'provider.rate-limit', 'provider.server-error', 'provider.transport'].find((code) => stderr.includes(code)) ?? null
    const result = { mode, exitCode: resultExit, timedOut, acceptedLocalConnections: connections.length, physicalRequestsReceived: requests.length, requests, hooks, assistantText, terminalErrors, eventTypes, stdoutBytes: Buffer.byteLength(stdout), stderrError: knownError }
    await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2))
    if (mode === 'probe-native') {
      const probe = hooks.find((x) => x.event === 'native-url-probe')
      if (!probe || requests.length !== 0 || connections.length !== 0 || probe.provider !== REAL_MODEL.providerID || probe.model !== allowedModel || probe.kind !== 'primary' || probe.queryPresent) throw new Error(`native URL probe failed closed: ${dir}`)
      const url = new URL(probe.origin)
      if (url.protocol !== 'https:' || !url.hostname.endsWith('opencode.ai') || resultExit === 0 || timedOut) throw new Error(`native provider target not verified before block: ${dir}`)
      return { origin: probe.origin, path: probe.path, provider: probe.provider, model: probe.model, kind: probe.kind, noTransportObserved: true }
    }
    const expectedRequests = ['refused', 'proxy-refused'].includes(mode) ? 0 : 1
    if (requests.length !== expectedRequests) throw new Error(`${mode}: expected ${expectedRequests} mock-received request(s), got ${requests.length}; ${dir}`)
    if (mode === 'proxy-refused' && connections.length !== 1) throw new Error(`proxy-refused: expected one accepted local TCP connection, got ${connections.length}; ${dir}`)
    if (mode === 'refused' && connections.length !== 0) throw new Error(`refused: expected zero accepted local TCP connections, got ${connections.length}; ${dir}`)
    const retry = hooks.filter((x) => x.event === 'retry')
    if (mode === 'valid') {
      if (resultExit !== 0 || assistantText.join('') !== 'OK' || retry.length !== 0) throw new Error(`valid SSE failed: ${dir}`)
    } else if (retry.length !== 1 || retry[0].attempt !== 2 || !hooks.some((x) => x.event === 'retry-veto' && x.attempt === 2 && x.retry === false)) {
      throw new Error(`${mode}: retry veto proof missing: ${dir}`)
    }
    if (mode !== 'valid' && (resultExit === 0 || timedOut || !terminalErrors.length || eventTypes.includes('step_finish'))) throw new Error(`${mode}: watchdog/terminal-error/final-success contract failed: ${dir}`)
    if (mode === 'stream') {
      const textIndex = eventTypes.indexOf('text'), errorIndex = eventTypes.indexOf('error')
      if (!assistantText.join('').includes('partial') || !hooks.some((x) => x.event === 'http.response' && x.status === 200) || textIndex < 0 || errorIndex <= textIndex) throw new Error(`stream: partial output/response-before-terminal-error evidence missing: ${dir}`)
    }
    if (requests.some((x) => x.toolsCount !== 0 || x.toolNames.length !== 0)) throw new Error(`${mode}: tools present in payload: ${dir}`)
    if (requests.some((x) => x.model !== allowedModel || x.authorizationPresent)) throw new Error(`${mode}: native model mismatch or credential unexpectedly present: ${dir}`)
    const reqHooks = hooks.filter((x) => x.event === 'http.request')
    if (reqHooks.length !== 1 || reqHooks[0].sessionRequestCount !== 1) throw new Error(`${mode}: expected one primary HTTP hook: ${dir}`)
    const localOrigin = `http://127.0.0.1:${port}`
    if (reqHooks.some((x) => x.kind !== 'primary' || x.provider !== REAL_MODEL.providerID || x.model !== allowedModel || x.originalOrigin !== nativeEndpoint.origin || x.originalPath !== nativeEndpoint.path || x.routeOrigin !== localOrigin || !x.localOnly || x.authPresentAfterStrip)) throw new Error(`${mode}: native URL/model/kind or local-route assertion failed: ${dir}`)
    if (hooks.some((x) => x.event === 'context' && x.toolCountAfterStrip !== 0)) throw new Error(`${mode}: tools not stripped: ${dir}`)
    if (hooks.some((x) => x.event === 'http.request' && x.kind !== 'primary')) throw new Error(`${mode}: auxiliary HTTP request escaped hook: ${dir}`)
    if (!hooks.some((x) => x.event === 'auxiliary-blocked' && x.kind === 'title')) throw new Error(`${mode}: title inference was not fail-closed at its hook: ${dir}`)
    const active = hooks.find((x) => x.event === 'effective-config')
    if (!active || active.mcp.length !== 0 || active.skills.length !== 0) throw new Error(`${mode}: MCP/skill isolation failed: ${dir}`)
    if (mode === 'valid') await writeFile(path.join(dir, 'extractor-sample.ndjson'), `${assistantText.map((text) => JSON.stringify({ type: 'text', text })).join('\n')}\n`)
    return { mode, exitCode: resultExit, timedOut, acceptedLocalConnections: connections.length, physicalRequestsReceived: requests.length, retryAttempts: retry.map((x) => x.attempt), toolCounts: requests.map((x) => x.toolsCount), assistantText, terminalErrors, eventTypes, hooks: hooks.map((x) => x.event) }
  } finally {
    if (cli && cli.exitCode === null) cli.kill()
    if (mock.exitCode === null) { mock.kill(); await mockExit }
  }
}

const nativeEndpoint = await runCase('probe-native')
const results = []
for (const mode of cases) results.push(await runCase(mode, nativeEndpoint))
const summary = { runID, cliVersion: '2.2.0', environment: 'local mock only; synthetic placeholder credential stripped before send; no real provider credentials', nativeEndpoint, cases: results }
await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))
await mkdir(path.join(root, 'evidence'), { recursive: true })
await writeFile(path.join(root, 'evidence', `${runID}-summary.json`), JSON.stringify(summary, null, 2))
for (const mode of ['probe-native', ...cases]) {
  const source = path.join(runDir, mode)
  await writeFile(path.join(root, 'evidence', `${runID}-${mode}.json`), await readFile(path.join(source, 'result.json')))
  if (mode === 'valid') await writeFile(path.join(root, 'evidence', `${runID}-valid-extractor-sample.ndjson`), await readFile(path.join(source, 'extractor-sample.ndjson')))
}
console.log(JSON.stringify(summary, null, 2))
