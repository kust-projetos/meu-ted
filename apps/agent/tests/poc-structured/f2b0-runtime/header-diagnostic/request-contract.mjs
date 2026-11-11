import { createHmac, timingSafeEqual } from 'node:crypto'

export const MODEL = Object.freeze({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' })
export const NATIVE_URL = 'https://opencode.ai/inference/openai/v1/chat/completions'
export const MOCK_URL = 'http://127.0.0.1:43193/v1/chat/completions'
export const OFFICIAL_HEADERS = Object.freeze(['x-opencode-session-id', 'x-opencode-parent-session-id', 'x-session-affinity', 'x-session-id', 'x-parent-session-id', 'user-agent', 'x-opencode-project', 'x-opencode-session', 'x-opencode-client'])

export function validateRequest({ providerID, modelID, kind, url, count, body }) {
  if (providerID !== MODEL.providerID || modelID !== MODEL.modelID) throw new Error('provider/model mismatch blocked')
  if (kind !== 'primary') throw new Error('non-primary request blocked')
  if (url !== NATIVE_URL) throw new Error('unexpected native URL blocked')
  if (count !== 1) throw new Error('second provider request blocked')
  if (!body || !Array.isArray(body.messages) || body.tools?.length) throw new Error('unexpected request shape/tools blocked')
}

export function headerShape(headers) {
  const names = [...new Headers(headers).keys()].map((name) => name.toLowerCase()).sort()
  return {
    authorizationPresent: names.includes('authorization'),
    apiKeyPresent: names.includes('x-api-key') || names.includes('api-key'),
    sessionHeaderPresent: names.includes('x-opencode-session'),
    clientHeaderPresent: names.includes('x-opencode-client'),
    userAgentPresent: names.includes('user-agent'),
    headerNames: names.filter((name) => !['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie'].includes(name)),
  }
}

export function inspectNativeHeaders(headers, eventSessionID) {
  const normalized = new Headers(headers)
  const affinityNames = ['x-session-affinity', 'x-session-id', 'x-opencode-session']
  const affinityValues = affinityNames.map((name) => normalized.get(name))
  const affinityHeadersPresent = affinityValues.every((value) => typeof value === 'string' && value.length > 0)
  return {
    sessionIdHeaderMatchesHookEvent: normalized.get('x-opencode-session-id') === eventSessionID,
    affinityHeadersPresent,
    affinityHeadersEqual: affinityHeadersPresent && affinityValues.every((value) => value === affinityValues[0]),
    affinityValueUsedForPromptCacheKey: affinityHeadersPresent && /^ses_[0-9a-f]{64}$/.test(affinityValues[0]),
    parentSessionHeaderPresent: normalized.has('x-opencode-parent-session-id'),
    parentAffinityHeaderPresent: normalized.has('x-parent-session-id'),
  }
}

export function nativeIdentityHeaderValidity(headers, app) {
  const normalized = new Headers(headers)
  const expectedUserAgent = `opencode/${app.channel}/${app.version}/${app.name}`
  return {
    userAgentMatchesNativeConstructor: normalized.get('user-agent') === expectedUserAgent,
    clientMatchesNativeConstructor: normalized.get('x-opencode-client') === app.name,
  }
}

export function classifyAuthorizationHeader(headers, localServerPassword, implicitPublicPlaceholder = 'public') {
  const value = new Headers(headers).get('authorization')
  if (value === null) return { present: false, class: 'absent', matchesLocalServerPassword: false, matchesImplicitPublicPlaceholder: false }
  if (value === '') return { present: true, class: 'empty', matchesLocalServerPassword: false, matchesImplicitPublicPlaceholder: false }
  const bearer = /^Bearer(?:\s+(.*))?$/i.exec(value)
  if (!bearer) return { present: true, class: 'non-bearer-opaque', matchesLocalServerPassword: false, matchesImplicitPublicPlaceholder: false }
  if (!bearer[1]) return { present: true, class: 'bearer-empty', matchesLocalServerPassword: false, matchesImplicitPublicPlaceholder: false }
  const matchesLocalServerPassword = value === `Bearer ${localServerPassword}`
  const matchesImplicitPublicPlaceholder = value === `Bearer ${implicitPublicPlaceholder}`
  return { present: true, class: matchesImplicitPublicPlaceholder ? 'implicit-public-placeholder' : 'bearer-nonempty-opaque', matchesLocalServerPassword, matchesImplicitPublicPlaceholder }
}

const officialHeaderPayload = (headers) => {
  const normalized = new Headers(headers)
  return OFFICIAL_HEADERS.filter((name) => normalized.has(name)).sort().map((name) => [name, normalized.get(name)])
}

export function createOfficialHeaderProof(headers, key) {
  const payload = officialHeaderPayload(headers)
  return { names: payload.map(([name]) => name), mac: createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex') }
}

export function verifyOfficialHeaderProof(headers, expected, key) {
  const actual = createOfficialHeaderProof(headers, key)
  const namesMatch = JSON.stringify(actual.names) === JSON.stringify(expected.names)
  const expectedMac = Buffer.from(String(expected.mac ?? ''), 'hex')
  const actualMac = Buffer.from(actual.mac, 'hex')
  const valuesMatch = expectedMac.length === actualMac.length && timingSafeEqual(expectedMac, actualMac)
  return { namesMatch, valuesMatch, matches: namesMatch && valuesMatch }
}

export async function requestPayloadExactlyEqual(left, right) {
  const [leftBody, rightBody] = await Promise.all([left.clone().arrayBuffer(), right.clone().arrayBuffer()])
  return left.method === right.method && headersExactlyEqual(left.headers, right.headers) && Buffer.compare(Buffer.from(leftBody), Buffer.from(rightBody)) === 0
}

export function validateLoopbackMockRequest(url, method) {
  const target = new URL(url)
  return method === 'POST' && target.origin === new URL(MOCK_URL).origin && target.pathname === new URL(MOCK_URL).pathname && !target.search
}

export function headersExactlyEqual(left, right) {
  const a = new Headers(left)
  const b = new Headers(right)
  const names = [...a.keys()].sort()
  return JSON.stringify(names) === JSON.stringify([...b.keys()].sort()) && names.every((name) => a.get(name) === b.get(name))
}
