import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { OpenCode } from '@opencode/client'
import { fileURLToPath } from 'node:url'
import { MOCK_URL, MODEL, NATIVE_URL } from './request-contract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeRoot = path.resolve(here, '..')
const executable = process.env.OPENCODE_EXE ?? 'C:/Users/walis/AppData/Roaming/npm/node_modules/@opencode/cli/node_modules/@opencode/cli-windows-x64-baseline/bin/opencode.exe'
const evidenceSource = path.join(runtimeRoot, 'evidence/real/published-b0-stop.json')
const tempRoot = path.join('C:/Users/walis/AppData/Local/Temp/opencode', `header-diagnostic-${Date.now()}-${process.pid}`)
const EXPECTED_VERSION = '2.1.4'
const HEADER_SOURCE_OFFSET = 173540824
const ERROR_MAPPING_SOURCE_OFFSET = 173432938
const APP_IDENTITY_SOURCE_OFFSET = 173350188
const AFFINITY_SOURCE_OFFSET = 173521125
const PROVIDER_AUTH_SOURCE_OFFSET = 173426849
const AUTH_HELPER_SOURCE_OFFSET = 173694560
const AUTH_STORE_PATH_SOURCE_OFFSET = 175376236
const PUBLIC_API_KEY_FALLBACK_SOURCE_OFFSET = 174169369
const PROVIDER_ENV_NAMES = ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY', 'OPENAI_API_KEY']

const baseEnv = () => Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []))
const parseLines = (text) => text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const digest = (text) => ({ bytes: Buffer.byteLength(text), sha256: (awaitlessHash(text)) })
import { createHash } from 'node:crypto'
function awaitlessHash(value) { return createHash('sha256').update(value).digest('hex') }
async function fileExistsMetadata(file) {
  try { const info = await stat(file); return { exists: true, isFile: info.isFile() } }
  catch (error) { if (error?.code === 'ENOENT') return { exists: false, isFile: false }; throw error }
}

async function runMode(mode, prompt, expectedUserText) {
  const useServer = mode.startsWith('serve-sdk-cli')
  const useStdin = mode.endsWith('-stdin')
  const dir = path.join(tempRoot, mode)
  const paths = Object.fromEntries(['config', 'data', 'cache', 'state', 'home', 'appdata', 'localappdata', 'tmp', 'work'].map((name) => [name, path.join(dir, name)]))
  await Promise.all(Object.values(paths).map((name) => mkdir(name, { recursive: true })))
  const hookLog = path.join(dir, 'hooks.ndjson'), mockLog = path.join(dir, 'mock.ndjson')
  await writeFile(hookLog, ''); await writeFile(mockLog, '')
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: `${MODEL.providerID}/${MODEL.modelID}`,
    default_agent: 'build',
    plugins: [path.join(here, 'plugin').replaceAll('\\', '/')],
    compaction: { auto: false }, warming: false,
    mcp: { servers: {} }, skills: [],
    agents: { build: { mode: 'primary', model: `${MODEL.providerID}/${MODEL.modelID}`, system: 'Return exactly one JSON object matching the supplied closed interpretation contract. Do not use tools or perform any action.', permissions: [{ action: '*', resource: '*', effect: 'deny' }] } },
    providers: { opencode: { settings: { transport: 'http', timeout: 90000, headerTimeout: 30000, chunkTimeout: 30000 } } },
  }
  await writeFile(path.join(paths.config, 'opencode.json'), JSON.stringify(config))
  const proofKey = randomBytes(32).toString('base64url')
  const env = { ...baseEnv(), USERPROFILE: paths.home, APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata, HOME: paths.home, TEMP: paths.tmp, TMP: paths.tmp,
    XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data, XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state,
    OPENCODE_CONFIG_DIR: paths.config, OPENCODE_DATA_DIR: paths.data, OPENCODE_CACHE_DIR: paths.cache, OPENCODE_STATE_DIR: paths.state,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_PASSWORD: 'local-synthetic-only', OPENCODE_LOG_LEVEL: 'silent', DIAG_HOOK_LOG: hookLog, DIAG_MOCK_LOG: mockLog,
    DIAG_HEADER_PROOF_KEY: proofKey, DIAG_WORKDIR: paths.work, DIAG_SOURCE_PROMPT: prompt, DIAG_SOURCE_PROMPT_SHA256: createHash('sha256').update(prompt).digest('hex'), DIAG_EXPECTED_USER_TEXT: expectedUserText,
  }
  let serverProcess, cliProcess, mockProcess
  try {
    mockProcess = spawn(process.execPath, [path.join(here, 'mock.mjs')], { cwd: paths.work, env, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise((resolve, reject) => { let err = ''; mockProcess.stdout.on('data', (chunk) => { if (chunk.toString().includes('READY')) resolve() }); mockProcess.stderr.on('data', (chunk) => { err += chunk }); mockProcess.once('error', reject); mockProcess.once('exit', (code) => reject(new Error(`mock failed startup (${code}): ${err}`))); setTimeout(() => reject(new Error('mock startup timeout')), 4000) })
    let serverURL
    if (useServer) {
      const port = 43194
      serverURL = `http://127.0.0.1:${port}`
      const serverEnv = { ...env, OPENCODE_SERVER_PASSWORD: 'local-synthetic-only' }
      serverProcess = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: paths.work, env: serverEnv, stdio: ['ignore', 'ignore', 'pipe'] })
      const client = OpenCode.make({ baseUrl: serverURL, fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
        if (url.origin !== serverURL) throw new Error('SDK fetch blocked non-loopback destination')
        const headers = new Headers(input instanceof Request ? input.headers : undefined)
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
        headers.set('authorization', `Basic ${Buffer.from('opencode:local-synthetic-only').toString('base64')}`)
        return fetch(input, { ...init, headers, redirect: 'error' })
      } })
      let ready = false
      for (let index = 0; index < 60 && !ready; index++) {
        try { await client.server.info(); ready = true } catch { await new Promise((resolve) => setTimeout(resolve, 200)) }
      }
      if (!ready) throw new Error('local server did not become ready')
      const session = await client.session.create({ title: 'Synthetic header diagnostic', agent: 'build', model: { providerID: MODEL.providerID, id: MODEL.modelID }, location: { directory: paths.work }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] })
      // Session identifier is held only in memory to pass to the CLI; never persisted or printed.
      var sessionID = session.id
    }
    const args = useServer
      ? ['run', '--server', serverURL, '--session', sessionID, '--model', `${MODEL.providerID}/${MODEL.modelID}`, '--agent', 'build', '--format', 'json']
      : ['run', '--standalone', '--model', `${MODEL.providerID}/${MODEL.modelID}`, '--agent', 'build', '--format', 'json']
    if (!useStdin) args.push(prompt)
    cliProcess = spawn(executable, args, { cwd: paths.work, env, stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    cliProcess.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    cliProcess.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    if (useStdin) {
      if (!cliProcess.stdin) throw new Error(`${mode}: stdin pipe unavailable`)
      cliProcess.stdin.end(prompt)
    }
    const startedAt = Date.now()
    const exitCode = await Promise.race([once(cliProcess, 'exit').then(([code]) => code), new Promise((resolve) => setTimeout(() => { cliProcess.kill(); resolve(null) }, 30000))])
    const hookRows = parseLines(await readFile(hookLog, 'utf8'))
    const mockRows = parseLines(await readFile(mockLog, 'utf8'))
    const parsedText = stdout.split(/\r?\n/).flatMap((line) => { try { const row = JSON.parse(line); return row.type === 'text' || row.part?.type === 'text' ? [row.part?.text ?? row.text ?? ''] : [] } catch { return [] } }).join('')
    const request = hookRows.find((row) => row.event === 'request-routed') ?? null
    const mock = mockRows[0] ?? null
    const nativeHeadersAtMock = Boolean(request && mock && request.headerShapeBefore.headerNames.every((name) => mock.headers.headerNames.includes(name)) && request.headerShapeBefore.authorizationPresent === mock.headers.authorizationPresent && request.headerShapeBefore.apiKeyPresent === mock.headers.apiKeyPresent && request.headerShapeBefore.sessionHeaderPresent === mock.headers.sessionHeaderPresent && request.headerShapeBefore.clientHeaderPresent === mock.headers.clientHeaderPresent && request.headerShapeBefore.userAgentPresent === mock.headers.userAgentPresent)
    const originalNames = new Set(request?.headerShapeBefore.headerNames ?? [])
    const officialHeaderNames = ['x-opencode-session-id', 'x-opencode-parent-session-id', 'x-session-affinity', 'x-session-id', 'x-parent-session-id', 'user-agent', 'x-opencode-project', 'x-opencode-session', 'x-opencode-client']
    const officialHeaderPresenceAtHook = Object.fromEntries(officialHeaderNames.map((name) => [name, originalNames.has(name)]))
    const officialHeaderNamesAtMock = Boolean(mock && officialHeaderNames.filter((name) => !['x-opencode-parent-session-id', 'x-parent-session-id'].includes(name)).every((name) => mock.headers.headerNames.includes(name)))
    const officialHeaderValuesAtMock = mock?.officialHeaderValuesMatch === true && mock?.officialHeaderProofMatches === true
    const identityHeadersValid = request?.nativeIdentity?.userAgentMatchesNativeConstructor === true && request?.nativeIdentity?.clientMatchesNativeConstructor === true && officialHeaderValuesAtMock
    const isolatedAuthStore = await fileExistsMetadata(path.join(paths.data, 'opencode', 'auth.json'))
    const result = { mode, inputTransport: useStdin ? 'stdin' : 'argv', exitCode, timedOut: exitCode === null, elapsedMs: Date.now() - startedAt, workDirLength: paths.work.length, mockRequestCount: mockRows.length, hookRequestCount: hookRows.filter((row) => row.event === 'request-routed').length, hookEvents: hookRows.map((row) => row.event ?? 'primary-context'), request, mock, nativeHeadersAtMock, officialHeaderNamesAtMock, officialHeaderValuesAtMock, officialHeaderPresenceAtHook, identityHeadersValid, exactHeaderValuesPreserved: request?.nativeRequestUnchanged === true && request?.routedRequestUnchanged === true, output: digest(parsedText), stderrNonempty: Boolean(stderr.trim()), environment: { apiKeyEnvironmentPresence: Object.fromEntries(PROVIDER_ENV_NAMES.map((name) => [name, Boolean(process.env[name])])), childCredentialEnvironmentPresent: false, providerApiKeyConfigured: false, isolatedConfigPath: true, isolatedAuthStoreExists: isolatedAuthStore.exists } }
    if (useStdin && result.mockRequestCount === 0) return { ...result, stdinAttemptStatus: 'no-provider-request-observed' }
    if (result.mockRequestCount !== 1 || result.hookRequestCount !== 1 || result.request?.localMockOnly !== true || result.request?.kind !== 'primary' || result.request?.toolCount !== 0 || result.request?.requestCount !== 1 || !result.exactHeaderValuesPreserved || !result.nativeHeadersAtMock || !result.officialHeaderNamesAtMock || !result.officialHeaderValuesAtMock || !result.identityHeadersValid || result.request?.nativeHeaderRelations?.sessionIdHeaderMatchesHookEvent !== true || result.request?.nativeHeaderRelations?.affinityHeadersPresent !== true || result.request?.nativeHeaderRelations?.affinityHeadersEqual !== true || result.mock?.transportValid !== true) {
      const safeFailure = { mode, mockRequestCount: result.mockRequestCount, hookRequestCount: result.hookRequestCount, nativeURLMatched: result.request?.nativeURLMatched, localMockOnly: result.request?.localMockOnly, requestKind: result.request?.kind, requestCount: result.request?.requestCount, toolsZero: result.request?.toolCount === 0, nativeRequestUnchanged: result.request?.nativeRequestUnchanged, routedRequestUnchanged: result.request?.routedRequestUnchanged, nativeHeadersAtMock: result.nativeHeadersAtMock, officialHeaderNamesAtMock: result.officialHeaderNamesAtMock, officialHeaderValuesAtMock: result.officialHeaderValuesAtMock, identityHeadersValid: result.identityHeadersValid, nativeHeaderRelations: result.request?.nativeHeaderRelations, mockTransportValid: result.mock?.transportValid, mockProofNamesMatch: result.mock?.officialHeaderNamesMatch, mockProofValuesMatch: result.mock?.officialHeaderValuesMatch }
      throw new Error(`sanitized diagnostic assertion failure ${JSON.stringify(safeFailure)}`)
    }
    if (result.timedOut || exitCode !== 0) throw new Error(`${mode} did not complete successfully (exit ${exitCode})`)
    return result
  } finally {
    const children = [cliProcess, serverProcess, mockProcess].filter(Boolean)
    const exits = children.map((child) => child.exitCode === null ? once(child, 'exit').catch(() => []) : Promise.resolve([]))
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.all(exits.map((exit) => Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3000))])))
  }
}

const source = JSON.parse(await readFile(evidenceSource, 'utf8'))
const caseFixture = source.cases.find((item) => item.caseID === 'F1-B010')
const prompt = caseFixture?.prompt
const expectedUserText = caseFixture?.input?.currentText
if (typeof prompt !== 'string' || !prompt.includes('Mostre minhas faturas')) throw new Error('exact synthetic F1-B010 prompt unavailable')
if (expectedUserText !== 'Mostre minhas faturas') throw new Error('synthetic F1-B010 user text mismatch')
const sourceQuoteCount = prompt.split('"').length - 1
const versionResult = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true })
const cliVersion = versionResult.status === 0 ? versionResult.stdout.trim().match(/v?(\d+\.\d+\.\d+)/)?.[1] : null
if (cliVersion !== EXPECTED_VERSION) throw new Error(`installed OpenCode version mismatch: expected ${EXPECTED_VERSION}`)
async function readBinarySlice(offset, length) {
  const handle = await open(executable, 'r')
  try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, offset); return buffer.subarray(0, bytesRead) }
  finally { await handle.close() }
}
const headerSource = (await readBinarySlice(HEADER_SOURCE_OFFSET, 2048)).toString('utf8')
const headerSourceLower = headerSource.toLowerCase()
const errorMappingSource = (await readBinarySlice(ERROR_MAPPING_SOURCE_OFFSET, 1024)).toString('utf8')
const appIdentitySource = (await readBinarySlice(APP_IDENTITY_SOURCE_OFFSET, 180)).toString('utf8')
const affinitySource = (await readBinarySlice(AFFINITY_SOURCE_OFFSET, 180)).toString('utf8')
const providerAuthSource = (await readBinarySlice(PROVIDER_AUTH_SOURCE_OFFSET, 520)).toString('utf8')
const authHelperSource = (await readBinarySlice(AUTH_HELPER_SOURCE_OFFSET, 300)).toString('utf8')
const authStorePathSource = (await readBinarySlice(AUTH_STORE_PATH_SOURCE_OFFSET, 250)).toString('utf8')
const publicApiKeyFallbackSource = (await readBinarySlice(PUBLIC_API_KEY_FALLBACK_SOURCE_OFFSET, 720)).toString('utf8')
const sourceProof = {
  cliVersion,
  binaryBytes: (await stat(executable)).size,
  headerBlockOffset: HEADER_SOURCE_OFFSET,
  headerBlockSha256: createHash('sha256').update(headerSource).digest('hex'),
  headerNamesFound: Object.fromEntries(['x-opencode-session-id', 'x-opencode-parent-session-id', 'x-session-affinity', 'x-session-id', 'x-parent-session-id', 'user-agent', 'x-opencode-project', 'x-opencode-session', 'x-opencode-client'].map((name) => [name, headerSourceLower.includes(name)])),
  sourceBindsSessionIdToSessionID: headerSourceLower.includes('x-opencode-session-id":_.id'),
  sourceBindsAffinityAliasesToSameValue: headerSourceLower.includes('x-session-affinity":q,"x-session-id":q') && headerSourceLower.includes('x-opencode-session":q'),
  sourceUsesSessionKeyRegexOnlyForPromptCacheKey: headerSourceLower.includes('promptcachekey:/^ses_[0-9a-f]{64}$/.test(q)?q.slice(4):q'),
  sourceBuildsUserAgentAndClientFromRuntime: headerSourceLower.includes('user-agent":fl(a)') && headerSourceLower.includes('x-opencode-client":a.name'),
  appIdentityFunctionOffset: APP_IDENTITY_SOURCE_OFFSET,
  appIdentityFunctionSha256: createHash('sha256').update(appIdentitySource).digest('hex'),
  userAgentConstructorUsesChannelVersionName: appIdentitySource.includes('opencode/${H.channel}/${H.version}/${H.name}'),
  affinityFunctionOffset: AFFINITY_SOURCE_OFFSET,
  affinityFunctionSha256: createHash('sha256').update(affinitySource).digest('hex'),
  affinityPrecedenceParentThenForkThenSession: affinitySource.includes('EN=(H)=>H.parentID??H.fork?.sessionID??H.id'),
  providerAuthMappingOffset: PROVIDER_AUTH_SOURCE_OFFSET,
  providerAuthMappingSha256: createHash('sha256').update(providerAuthSource).digest('hex'),
  providerAuthMappingSupportsConfiguredKeyOrOAuth: providerAuthSource.includes('if(A.type==="key")return{apiKey:A.key}') && providerAuthSource.includes('if(A.type==="oauth")return Fu(e,A.access)'),
  authHeaderBuilderOffset: AUTH_HELPER_SOURCE_OFFSET,
  authHeaderBuilderSha256: createHash('sha256').update(authHelperSource).digest('hex'),
  authHeaderBuilderUsesConfiguredAuthOrApiKeyBearer: authHelperSource.includes('if("auth"in e&&e.auth)return e.auth') && authHelperSource.includes('kE("apiKey"in e?e.apiKey:void 0,"apiKey")).bearer()'),
  publicApiKeyFallbackOffset: PUBLIC_API_KEY_FALLBACK_SOURCE_OFFSET,
  publicApiKeyFallbackSha256: createHash('sha256').update(publicApiKeyFallbackSource).digest('hex'),
  providerUsesPublicPlaceholderWhenNoEnvConnectionOrConfiguredKey: publicApiKeyFallbackSource.includes('process.env.OPENCODE_API_KEY||q.connection||Me.provider.settings?.apiKey') && publicApiKeyFallbackSource.includes('oe.settings={...oe.settings,apiKey:"public"}'),
  authStorePathSourceOffset: AUTH_STORE_PATH_SOURCE_OFFSET,
  authStorePathSourceSha256: createHash('sha256').update(authStorePathSource).digest('hex'),
  authStorePathUsesXdgDataHomeOrHomeDotOpenCode: authStorePathSource.includes('if(t)return Hc.join(t,"opencode","auth.json");return Hc.join(e,".opencode","auth.json")'),
  errorMappingBlockOffset: ERROR_MAPPING_SOURCE_OFFSET,
  errorMappingBlockSha256: createHash('sha256').update(errorMappingSource).digest('hex'),
  freeUsageMapsQuotaExceededToProviderFreeLimit: errorMappingSource.includes('case"QuotaExceeded"') && errorMappingSource.includes('FreeUsageLimitError') && errorMappingSource.includes('provider.free-limit'),
}
if (Object.values(sourceProof.headerNamesFound).some((found) => !found) || !sourceProof.sourceBindsSessionIdToSessionID || !sourceProof.sourceBindsAffinityAliasesToSameValue || !sourceProof.sourceUsesSessionKeyRegexOnlyForPromptCacheKey || !sourceProof.sourceBuildsUserAgentAndClientFromRuntime || !sourceProof.userAgentConstructorUsesChannelVersionName || !sourceProof.affinityPrecedenceParentThenForkThenSession || !sourceProof.providerAuthMappingSupportsConfiguredKeyOrOAuth || !sourceProof.authHeaderBuilderUsesConfiguredAuthOrApiKeyBearer || !sourceProof.providerUsesPublicPlaceholderWhenNoEnvConnectionOrConfiguredKey || !sourceProof.authStorePathUsesXdgDataHomeOrHomeDotOpenCode || !sourceProof.freeUsageMapsQuotaExceededToProviderFreeLimit) throw new Error('installed binary source fingerprint did not match reviewed header/auth/error contract')
const currentAuthStorePath = process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json') : path.join(homedir(), '.opencode', 'auth.json')
const currentAuthStore = await fileExistsMetadata(currentAuthStorePath)
const run = { schemaVersion: 'header-diagnostic-safe-v3', cliVersion, model: `${MODEL.providerID}/${MODEL.modelID}`, nativeURL: NATIVE_URL, mockURL: MOCK_URL, binarySourceProof: sourceProof, input: { caseID: 'F1-B010', userText: 'Mostre minhas faturas', promptSha256: createHash('sha256').update(prompt).digest('hex'), promptBytes: Buffer.byteLength(prompt), sourceQuoteCount, expectedArgQuotedExpansionBytes: sourceQuoteCount + 2, sourcePromptHas960QuoteExpansion: sourceQuoteCount === 960, sourceFixtureCounts: { history: source.cases.find((item) => item.caseID === 'F1-B010').input.history.length, accounts: source.cases.find((item) => item.caseID === 'F1-B010').input.accounts.length, categories: source.cases.find((item) => item.caseID === 'F1-B010').input.categories.length, displayedOptions: source.cases.find((item) => item.caseID === 'F1-B010').input.displayedOptions.length } }, comparisons: [] }
try {
  await mkdir(tempRoot, { recursive: true })
  for (const mode of ['standalone-argv', 'serve-sdk-cli-argv', 'standalone-stdin', 'serve-sdk-cli-stdin']) run.comparisons.push(await runMode(mode, prompt, expectedUserText))
  const argvResults = run.comparisons.filter((result) => result.inputTransport === 'argv')
  const stdinResults = run.comparisons.filter((result) => result.inputTransport === 'stdin')
  const observedRequests = run.comparisons.filter((result) => result.request)
  run.argvPayloadHashesMatchAcrossPaths = argvResults.length === 2 && argvResults[0].request?.userInputSha256 === argvResults[1].request?.userInputSha256
  run.stdinPayloadHashesMatchAcrossPaths = stdinResults.length === 2 && stdinResults.every((result) => result.request?.userInputSha256) && stdinResults[0].request.userInputSha256 === stdinResults[1].request.userInputSha256
  run.stdinSupportedInBothPaths = stdinResults.length === 2 && stdinResults.every((result) => result.exitCode === 0 && result.mockRequestCount === 1 && result.request?.localMockOnly === true)
  run.stdinSourcePromptByteIdentityInBothPaths = run.stdinSupportedInBothPaths && stdinResults.every((result) => result.request.promptWrapper.directSourcePromptMatchesPayload && result.request.promptWrapper.sourcePromptPayloadHashMatches)
  run.argvQuotedRepresentationMatchesInBothPaths = argvResults.length === 2 && argvResults.every((result) => result.request?.promptWrapper.escapedQuotedArgumentMatchesPayload)
  run.syntheticUserTextPresentInAllObservedPayloads = observedRequests.every((result) => result.request.expectedSyntheticUserTextPresent)
  run.onlyLoopbackMockRequestsObserved = observedRequests.every((result) => result.request.localMockOnly && result.mockRequestCount === 1 && result.nativeHeadersAtMock && result.officialHeaderValuesAtMock && result.exactHeaderValuesPreserved && result.identityHeadersValid)
  run.promptInclusion = run.comparisons.map((result) => ({ mode: result.mode, transport: result.inputTransport, verbatim: result.request?.promptWrapper.promptVerbatimIncluded ?? false, directSourcePrompt: result.request?.promptWrapper.directSourcePromptMatchesPayload ?? false, sourceHashMatch: result.request?.promptWrapper.sourcePromptPayloadHashMatches ?? false, escapedQuotedArgument: result.request?.promptWrapper.escapedQuotedArgumentMatchesPayload ?? false, sourceQuoteCount: result.request?.promptWrapper.sourceQuoteCount ?? null, escapedQuoteCount: result.request?.promptWrapper.payloadEscapedQuoteCount ?? null, payloadBytesDelta: result.request?.promptWrapper.payloadBytesMinusCliArgumentBytes ?? null, noRequestObserved: !result.request }))
  const argvSystemResults = argvResults.filter((result) => result.request)
  const systems = argvSystemResults.slice(0, 2).map((result) => result.request.messageMetrics.system)
  run.systemContextComparison = systems.length === 2 ? { byteDelta: systems[1].bytes - systems[0].bytes, workDirLengthDelta: argvSystemResults[1].workDirLength - argvSystemResults[0].workDirLength, normalizedHashEqualAfterReplacingWorkDir: systems[0].normalizedSha256 === systems[1].normalizedSha256, normalizedBytesEqualAfterReplacingWorkDir: systems[0].normalizedBytes === systems[1].normalizedBytes, normalizedHashEqualAfterReplacingWorkDirAndModeLabels: systems[0].normalizedWithModeNamesSha256 === systems[1].normalizedWithModeNamesSha256, normalizedBytesEqualAfterReplacingWorkDirAndModeLabels: systems[0].normalizedWithModeNamesBytes === systems[1].normalizedWithModeNamesBytes, modeLabelOccurrences: argvSystemResults.map((result) => ({ standalone: result.request.messageMetrics.system.standaloneMarkerOccurrences, serveSdkCli: result.request.messageMetrics.system.serverCliMarkerOccurrences })), explainedByWorkDirAndModeLabelSubstitution: systems[0].normalizedWithModeNamesSha256 === systems[1].normalizedWithModeNamesSha256 && systems[0].normalizedWithModeNamesBytes === systems[1].normalizedWithModeNamesBytes } : { observed: false }
  run.status = run.stdinSourcePromptByteIdentityInBothPaths && run.argvQuotedRepresentationMatchesInBothPaths && run.onlyLoopbackMockRequestsObserved && run.syntheticUserTextPresentInAllObservedPayloads ? 'PASS' : 'STDIN_NOT_SOURCE_IDENTICAL_OR_UNAVAILABLE'
  if (!run.argvPayloadHashesMatchAcrossPaths || !run.onlyLoopbackMockRequestsObserved || !argvResults.every((result) => result.request)) throw new Error(`sanitized argv/mock baseline failure ${JSON.stringify({ argvHashesMatch: run.argvPayloadHashesMatchAcrossPaths, onlyLoopbackMock: run.onlyLoopbackMockRequestsObserved })}`)
  run.authAndGlobalConfigScope = { currentProcessApiKeyEnvironmentPresence: Object.fromEntries(PROVIDER_ENV_NAMES.map((name) => [name, Boolean(process.env[name])])), currentGlobalAuthStoreExists: currentAuthStore.exists, currentGlobalAuthStoreIsFile: currentAuthStore.isFile, currentGlobalAuthStoreContentsRead: false, childApiKeyEnvironmentPresent: false, childProviderApiKeyConfigured: false, isolatedChildAuthStoreExists: run.comparisons.some((result) => result.environment.isolatedAuthStoreExists), globalConfigImported: false, authorizationHeaderPresent: run.comparisons.map((result) => result.request?.authHeader.present ?? null), authorizationHeaderClass: run.comparisons.map((result) => result.request?.authHeader.class ?? null), authorizationMatchesLocalServerPassword: run.comparisons.map((result) => result.request?.authHeader.matchesLocalServerPassword ?? null), authorizationMatchesSourceProvenPublicPlaceholder: run.comparisons.map((result) => result.request?.authHeader.matchesImplicitPublicPlaceholder ?? null), sourceAttributionForObservedAuthorization: 'source-proven public-key fallback; the value was equality-checked in memory and never persisted' }
  run.comparisonScope = 'controlled CLI transport-path comparison with isolated homes/config; not equivalent to the active global configuration/auth context'
  const evidencePath = path.join(here, `evidence-v3-${Date.now()}-${process.pid}.json`)
  await writeFile(evidencePath, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ status: run.status, evidencePath, ...run }, null, 2))
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
