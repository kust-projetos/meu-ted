import { describe, expect, it } from 'vitest'
import { classifyAuthorizationHeader, createOfficialHeaderProof, headerShape, headersExactlyEqual, inspectNativeHeaders, nativeIdentityHeaderValidity, requestPayloadExactlyEqual, validateLoopbackMockRequest, verifyOfficialHeaderProof, validateRequest } from './request-contract.mjs'

describe('header diagnostic request contract', () => {
  it('accepts only the exact primary native target and model', () => {
    expect(() => validateRequest({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free', kind: 'primary', url: 'https://opencode.ai/inference/openai/v1/chat/completions', count: 1, body: { messages: [{ role: 'user', content: 'synthetic' }], tools: [] } })).not.toThrow()
    for (const change of [{ kind: 'title' }, { count: 2 }, { url: 'https://example.invalid/' }, { modelID: 'other' }]) {
      expect(() => validateRequest({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free', kind: 'primary', url: 'https://opencode.ai/inference/openai/v1/chat/completions', count: 1, body: { messages: [] }, ...change })).toThrow()
    }
  })

  it('reports sensitive-header presence and non-secret header names only', () => {
    const shape = headerShape({ authorization: 'Bearer must-not-escape', 'x-opencode-session': 'session-value', 'x-opencode-client': 'cli', 'user-agent': 'opencode/2.1.4', cookie: 'cookie-value', 'content-type': 'application/json' })
    expect(shape).toMatchObject({ authorizationPresent: true, sessionHeaderPresent: true, clientHeaderPresent: true, userAgentPresent: true })
    expect(JSON.stringify(shape)).not.toMatch(/must-not-escape|session-value|cookie-value/)
    expect(shape.headerNames).toContain('content-type')
  })

  it('reconstructing a Request with a loopback URL preserves all headers', () => {
    const original = new Request('https://opencode.ai/inference/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session': 'opaque', authorization: 'Bearer synthetic' }, body: JSON.stringify({ messages: [] }) })
    const routed = new Request('http://127.0.0.1:43193/v1/chat/completions', original)
    expect(headersExactlyEqual(original.headers, routed.headers)).toBe(true)
    expect(routed.url).toContain('127.0.0.1')
  })

  it('checks native session-ID binding separately from affinity aliases', () => {
    const headers = { 'x-opencode-session-id': 'session-from-hook', 'x-session-affinity': 'affinity-key', 'x-session-id': 'affinity-key', 'x-opencode-session': 'affinity-key' }
    expect(inspectNativeHeaders(headers, 'session-from-hook')).toMatchObject({ sessionIdHeaderMatchesHookEvent: true, affinityHeadersPresent: true, affinityHeadersEqual: true, affinityValueUsedForPromptCacheKey: false })
    expect(inspectNativeHeaders({ ...headers, 'x-opencode-session': 'different' }, 'session-from-hook').affinityHeadersEqual).toBe(false)
    expect(inspectNativeHeaders(headers, 'other').sessionIdHeaderMatchesHookEvent).toBe(false)
    const documentedSessionKey = `ses_${'a'.repeat(64)}`
    expect(inspectNativeHeaders({ 'x-session-affinity': documentedSessionKey, 'x-session-id': documentedSessionKey, 'x-opencode-session': documentedSessionKey }, 'unused').affinityValueUsedForPromptCacheKey).toBe(true)
  })

  it('validates User-Agent and client value from the native constructor', () => {
    const app = { name: 'opencode', version: '2.1.4', channel: 'stable' }
    const headers = { 'user-agent': 'opencode/stable/2.1.4/opencode', 'x-opencode-client': 'opencode' }
    expect(nativeIdentityHeaderValidity(headers, app)).toEqual({ userAgentMatchesNativeConstructor: true, clientMatchesNativeConstructor: true })
    expect(nativeIdentityHeaderValidity({ ...headers, 'user-agent': 'invented/ua' }, app).userAgentMatchesNativeConstructor).toBe(false)
    expect(nativeIdentityHeaderValidity({ ...headers, 'x-opencode-client': 'invented-client' }, app).clientMatchesNativeConstructor).toBe(false)
  })

  it('detects changed selected official header values at the mock without exposing them', () => {
    const key = Buffer.alloc(32, 7)
    const before = { 'x-opencode-session-id': 'opaque-session', 'x-session-affinity': 'opaque-affinity', 'x-session-id': 'opaque-affinity', 'x-opencode-session': 'opaque-affinity', 'user-agent': 'opencode/stable/2.1.4/opencode', 'x-opencode-client': 'opencode' }
    const expected = createOfficialHeaderProof(before, key)
    expect(verifyOfficialHeaderProof(before, expected, key).matches).toBe(true)
    for (const changed of [
      { ...before, 'user-agent': 'changed-agent' },
      { ...before, 'x-opencode-client': 'changed-client' },
      { ...before, 'x-session-affinity': 'changed-session-value' },
    ]) expect(verifyOfficialHeaderProof(changed, expected, key).matches).toBe(false)
    expect(JSON.stringify(expected)).not.toMatch(/opaque-session|opaque-affinity|opencode\/stable/)
  })

  it('rejects non-loopback or modified transport targets and verifies both Request reconstructions', async () => {
    expect(validateLoopbackMockRequest('http://127.0.0.1:43193/v1/chat/completions', 'POST')).toBe(true)
    expect(validateLoopbackMockRequest('https://opencode.ai/inference/openai/v1/chat/completions', 'POST')).toBe(false)
    expect(validateLoopbackMockRequest('http://127.0.0.1:43193/other', 'POST')).toBe(false)
    expect(validateLoopbackMockRequest('http://127.0.0.1:43193/v1/chat/completions', 'GET')).toBe(false)
    const original = new Request('https://opencode.ai/inference/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-client': 'opencode' }, body: JSON.stringify({ messages: [] }) })
    const originalBody = await original.clone().text()
    const guarded = new Request(original, { redirect: 'error' })
    const routed = new Request('http://127.0.0.1:43193/v1/chat/completions', guarded.clone())
    expect(original.redirect).not.toBe('error')
    expect(guarded.redirect).toBe('error')
    expect(routed.redirect).toBe('error')
    expect(guarded.url).toBe(original.url)
    expect(guarded.method).toBe(original.method)
    expect(headersExactlyEqual(original.headers, guarded.headers)).toBe(true)
    expect(await guarded.clone().text()).toBe(originalBody)
    expect(await requestPayloadExactlyEqual(guarded, routed)).toBe(true)
    const changed = new Request('http://127.0.0.1:43193/v1/chat/completions', { ...{}, method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-client': 'changed' }, body: JSON.stringify({ messages: [] }) })
    expect(await requestPayloadExactlyEqual(guarded, changed)).toBe(false)
    const changedBody = new Request('https://opencode.ai/inference/openai/v1/chat/completions', { method: 'POST', headers: guarded.headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'changed' }] }) })
    expect(await requestPayloadExactlyEqual(guarded, changedBody)).toBe(false)
    const changedMethod = new Request('https://opencode.ai/inference/openai/v1/chat/completions', { method: 'GET', headers: guarded.headers })
    expect(await requestPayloadExactlyEqual(guarded, changedMethod)).toBe(false)
  })

  it('classifies auth header presence without exposing or equating it to credentials', () => {
    expect(classifyAuthorizationHeader({ authorization: 'Bearer local-synthetic-only' }, 'local-synthetic-only')).toMatchObject({ present: true, class: 'bearer-nonempty-opaque', matchesLocalServerPassword: true, matchesImplicitPublicPlaceholder: false })
    expect(classifyAuthorizationHeader({ authorization: 'Bearer public' }, 'local-synthetic-only')).toMatchObject({ present: true, class: 'implicit-public-placeholder', matchesLocalServerPassword: false, matchesImplicitPublicPlaceholder: true })
    expect(classifyAuthorizationHeader({ authorization: 'Bearer opaque' }, 'local-synthetic-only')).toMatchObject({ present: true, class: 'bearer-nonempty-opaque', matchesLocalServerPassword: false })
    expect(classifyAuthorizationHeader({}, 'local-synthetic-only')).toMatchObject({ present: false, class: 'absent' })
  })
})
