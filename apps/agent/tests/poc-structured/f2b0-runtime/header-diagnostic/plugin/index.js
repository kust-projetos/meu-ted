import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Plugin } from '@opencode/plugin'
import { classifyAuthorizationHeader, createOfficialHeaderProof, headerShape, headersExactlyEqual, inspectNativeHeaders, MOCK_URL, nativeIdentityHeaderValidity, NATIVE_URL, requestPayloadExactlyEqual, validateRequest } from '../request-contract.mjs'

const log = async (row) => appendFile(process.env.DIAG_HOOK_LOG, `${JSON.stringify(row)}\n`)
const counts = new Map()

export default Plugin.define({
  id: 'f2b0.header-diagnostic.mock-only',
  async setup(ctx) {
    await ctx.session.hook('context', async ({ tools }) => { for (const name of Object.keys(tools)) delete tools[name] })
    await ctx.session.hook('generate', async () => { throw new Error('auxiliary generation disabled by diagnostic guard') })
    await ctx.session.hook('title', async () => { throw new Error('title generation disabled by diagnostic guard') })
    await ctx.session.hook('compaction', async () => { throw new Error('compaction disabled by diagnostic guard') })
    await ctx.session.hook('retry', async (event) => { event.decision = { retry: false }; await log({ event: 'retry-blocked', retry: false }) })
    await ctx.session.hook('http.request', async (event) => {
      const count = (counts.get(event.sessionID) ?? 0) + 1
      counts.set(event.sessionID, count)
      const original = event.request
      const parsed = new URL(original.url)
      if (parsed.origin !== new URL(NATIVE_URL).origin || parsed.pathname !== new URL(NATIVE_URL).pathname || parsed.search) throw new Error('non-native/non-exact request rejected before transport')
      const bodyText = await original.clone().text()
      let body
      try { body = JSON.parse(bodyText) } catch { throw new Error('non-JSON request blocked') }
      validateRequest({ providerID: event.model.providerID, modelID: event.model.id, kind: event.kind, url: original.url, count, body })
      const before = headerShape(original.headers)
      const nativeHeaderRelations = inspectNativeHeaders(original.headers, event.sessionID)
      const nativeIdentity = nativeIdentityHeaderValidity(original.headers, ctx.app)
      if (!nativeIdentity.userAgentMatchesNativeConstructor || !nativeIdentity.clientMatchesNativeConstructor) throw new Error('native User-Agent/client header mismatch')
      const guarded = new Request(original, { redirect: 'error' })
      const nativeRequestUnchanged = guarded.url === original.url && guarded.method === original.method && guarded.redirect === 'error' && headersExactlyEqual(original.headers, guarded.headers) && await guarded.clone().text() === bodyText
      if (!nativeRequestUnchanged) throw new Error('redirect guard changed native request method/body/headers/URL')
      const proofKey = Buffer.from(process.env.DIAG_HEADER_PROOF_KEY, 'base64url')
      const expectedHeaderProof = createOfficialHeaderProof(guarded.headers, proofKey)
      const controlResponse = await fetch('http://127.0.0.1:43193/__expect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(expectedHeaderProof), redirect: 'error' })
      if (controlResponse.status !== 204) throw new Error('mock rejected in-memory official-header proof')
      const routed = new Request(MOCK_URL, guarded.clone())
      const after = headerShape(routed.headers)
      const routedRequestUnchanged = routed.url === MOCK_URL && routed.method === guarded.method && routed.redirect === 'error' && headersExactlyEqual(guarded.headers, routed.headers) && await requestPayloadExactlyEqual(guarded, routed)
      if (!routedRequestUnchanged || new URL(routed.url).hostname !== '127.0.0.1') throw new Error('loopback routing changed method/body/headers/redirect or target')
      event.request = routed
      const userMessages = body.messages.filter((item) => item.role === 'user')
      const userText = userMessages.map((item) => typeof item.content === 'string' ? item.content : Array.isArray(item.content) ? item.content.map((part) => part.text ?? '').join('') : '')
      const textFor = (role) => body.messages.filter((item) => item.role === role).map((item) => typeof item.content === 'string' ? item.content : Array.isArray(item.content) ? item.content.map((part) => part.text ?? '').join('') : '').join('\n')
      const systemText = textFor('system')
      const allText = body.messages.map((item) => typeof item.content === 'string' ? item.content : Array.isArray(item.content) ? item.content.map((part) => part.text ?? '').join('') : '').join('\n')
      const measure = (text) => ({ chars: Array.from(text).length, bytes: Buffer.byteLength(text), estimatedTokensCharsDiv4: Math.ceil(Array.from(text).length / 4) })
      const workDir = process.env.DIAG_WORKDIR
      const normalizedSystem = systemText.split(workDir).join('<WORKDIR>').split(workDir.replaceAll('\\', '/')).join('<WORKDIR>')
      const expectedPrompt = process.env.DIAG_SOURCE_PROMPT
      const expectedSyntheticUserText = process.env.DIAG_EXPECTED_USER_TEXT
      const wholeUserText = userText.join('\n')
      const sourceQuoteCount = expectedPrompt.split('"').length - 1
      const escapedQuote = `\\"`
      const payloadEscapedQuoteCount = wholeUserText.split(escapedQuote).length - 1
      const escapedQuotedArgument = `"${expectedPrompt.split('"').join(escapedQuote)}"`
      const escapedQuotedArgumentMatchesPayload = wholeUserText === escapedQuotedArgument
      const directSourcePromptMatchesPayload = wholeUserText === expectedPrompt
      const sourcePromptPayloadHashMatches = createHash('sha256').update(wholeUserText).digest('hex') === process.env.DIAG_SOURCE_PROMPT_SHA256
      const promptVerbatimIndex = wholeUserText.indexOf(expectedPrompt)
      const normalizedUserText = wholeUserText.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      const normalizedExpectedPrompt = expectedPrompt.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      const promptIndex = normalizedUserText.indexOf(normalizedExpectedPrompt)
      const promptVerbatimIncluded = promptVerbatimIndex >= 0
      const promptIncludedAfterLineEndingNormalization = promptIndex >= 0
      const prefix = promptIncludedAfterLineEndingNormalization ? normalizedUserText.slice(0, promptIndex) : ''
      const suffix = promptIncludedAfterLineEndingNormalization ? normalizedUserText.slice(promptIndex + normalizedExpectedPrompt.length) : ''
      const wrapper = `${prefix}${suffix}`
      const promptLines = normalizedExpectedPrompt.split('\n').filter(Boolean)
      const matchingPromptLineCount = promptLines.filter((line) => normalizedUserText.includes(line)).length
      const sourcePromptLineMatchMap = promptLines.map((line, lineIndex) => ({ lineIndex, chars: Array.from(line).length, bytes: Buffer.byteLength(line), payloadContainsExactLine: normalizedUserText.includes(line) }))
      const authHeader = classifyAuthorizationHeader(original.headers, process.env.OPENCODE_PASSWORD, 'public')
      const normalizedSystemAndMode = normalizedSystem.replaceAll('standalone', '<MODE>').replaceAll('serve-sdk-cli', '<MODE>')
      await log({ event: 'request-routed', provider: event.model.providerID, model: event.model.id, kind: event.kind, requestCount: count, nativeURLMatched: original.url === NATIVE_URL, localMockOnly: new URL(routed.url).origin === new URL(MOCK_URL).origin, headerShapeBefore: before, headerShapeAfter: after, nativeHeaderRelations, nativeIdentity, nativeRequestUnchanged, routedRequestUnchanged, userInputSha256: createHash('sha256').update(JSON.stringify(userText)).digest('hex'), userMessageCount: userMessages.length, expectedSyntheticUserTextPresent: normalizedUserText.includes(expectedSyntheticUserText), promptWrapper: { sourcePromptBytes: Buffer.byteLength(expectedPrompt), promptVerbatimIncluded, promptIncludedAfterLineEndingNormalization, directSourcePromptMatchesPayload, sourcePromptPayloadHashMatches, escapedQuotedArgumentMatchesPayload, sourceQuoteCount, payloadEscapedQuoteCount, escapedQuoteExpansionBytes: Buffer.byteLength(wholeUserText) - Buffer.byteLength(expectedPrompt), payloadBytesMinusCliArgumentBytes: Buffer.byteLength(wholeUserText) - Buffer.byteLength(expectedPrompt), nonemptyPromptLinesMatched: matchingPromptLineCount, nonemptyPromptLineCount: promptLines.length, sourcePromptLineMatchMap, prefixBytes: Buffer.byteLength(prefix), suffixBytes: Buffer.byteLength(suffix), wrapperOverheadBytes: promptIncludedAfterLineEndingNormalization ? Buffer.byteLength(wrapper) : null, wrapperOverheadSha256: promptIncludedAfterLineEndingNormalization ? createHash('sha256').update(wrapper).digest('hex') : null, hasCurrentDateMarker: /current date|today is/i.test(wrapper), hasWorkingDirectoryMarker: /working directory|current directory/i.test(wrapper), hasProjectContextMarker: /project instructions|project context/i.test(wrapper) }, messageMetrics: { system: { ...measure(systemText), normalizedBytes: Buffer.byteLength(normalizedSystem), normalizedSha256: createHash('sha256').update(normalizedSystem).digest('hex'), normalizedWithModeNamesBytes: Buffer.byteLength(normalizedSystemAndMode), normalizedWithModeNamesSha256: createHash('sha256').update(normalizedSystemAndMode).digest('hex'), workDirOccurrences: workDir ? (systemText.split(workDir).length - 1) + (systemText.split(workDir.replaceAll('\\', '/')).length - 1) : 0, standaloneMarkerOccurrences: systemText.split('standalone').length - 1, serverCliMarkerOccurrences: systemText.split('serve-sdk-cli').length - 1 }, user: measure(wholeUserText), estimation: 'characters/4 heuristic; not token usage' }, authHeader, bodyBytes: Buffer.byteLength(bodyText), messageRoles: body.messages.map((item) => item.role), toolCount: Array.isArray(body.tools) ? body.tools.length : 0, unexpectedAgentInstructionPathPresent: /(?:^|[\\/])AGENTS\.md\b/i.test(allText), unexpectedPromptMarkerPresent: /<\|(?:im_start|system|assistant|user)\|>/i.test(allText) })
    })
    await ctx.session.hook('http.response', async (event) => { await log({ event: 'response', status: event.response.status }) })
  },
})
