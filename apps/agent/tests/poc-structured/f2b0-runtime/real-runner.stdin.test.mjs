import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { captureCli, classifyStdinWriteError, diagnoseReadback, isPromptConfirmed, extractAssistantApiText, decideAssistantTextStop, minimalEnvironment, goProviderSettings, writeConfig, loadGoApiKey } from './real-runner.ts'

describe('real runner CLI stdin prompt capture', () => {
  it('sends exact UTF-8 prompt via stdin with no prompt argv and retains JSON NDJSON output', async () => {
    const prompt = 'Mostre "minhas faturas" — café 🧾\nlinha dois'
    const childCode = [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk });",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'text', text: input }));",
      "  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 3, output: 2 }, cost: 0 }, promptFoundInArgv: process.argv.includes(input) }));",
      "});",
    ].join('\n')
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR'].flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []))

    const result = await captureCli(process.execPath, ['-e', childCode], process.cwd(), env, [], prompt)

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdinErrorCode).toBe(null)
    expect(result.text).toBe(prompt)
    expect(result.eventTypes).toEqual(['text', 'step_finish'])
    const events = result.rawStdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    expect(events[1].promptFoundInArgv).toBe(false)
    expect(result.usage.input).toMatchObject({ value: 3, observed: true })
    expect(result.usage.output).toMatchObject({ value: 2, observed: true })
    expect(result.cost).toBe(0)
  })

  it('captures an early child stdin close as a sanitized EPIPE and does not hang', async () => {
    const childCode = "process.stdin.destroy(); setImmediate(() => process.exit(0));"
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR'].flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []))
    const prompt = 'p'.repeat(8 * 1024 * 1024)

    const result = await captureCli(process.execPath, ['-e', childCode], process.cwd(), env, [], prompt)

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(['EPIPE', 'EOF']).toContain(result.stdinErrorCode)
    expect(result.stderr).not.toContain('write EOF')
    expect(classifyStdinWriteError(result.stdinErrorCode)).toMatchObject({ stop: true, category: 'stdin-write-error', errorCode: result.stdinErrorCode })
  })

  it('fails closed when a child closes stdin before reading a short prompt', async () => {
    const childCode = "process.stdin.destroy(); setImmediate(() => process.exit(0));"
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR'].flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []))
    const prompt = 'x'
    const result = await captureCli(process.execPath, ['-e', childCode], process.cwd(), env, [], prompt)

    expect(result.stdinErrorCode).toBe(null)
    expect(isPromptConfirmed([], prompt)).toBe(false)
    expect(isPromptConfirmed([{ type: 'user', content: [{ type: 'text', text: prompt }] }], prompt)).toBe(true)
  })

  it('keeps success eligible only when stdin had no write error', () => {
    expect(classifyStdinWriteError(null)).toBe(null)
  })

  it('propagates the reserved plugin evidence path into the spawned CLI process', async () => {
    const runDir = path.join(process.cwd(), 'temporary-f2b0-run', randomUUID())
    const { env } = minimalEnvironment(runDir, 'test-nonce', 'test-server-password')
    const result = await captureCli(process.execPath, [
      '-e',
      "console.log(JSON.stringify({ type: 'text', text: process.env.F2B0_REAL_EVIDENCE }))",
    ], process.cwd(), env, [])

    expect(result.exitCode).toBe(0)
    expect(result.text).toBe(path.join(runDir, 'plugin-hooks.ndjson'))
  })

  it('uses native auth data with a per-run database and no forwarded provider key', () => {
    const runDir = path.join(process.cwd(), 'temporary-f2b0-run', randomUUID())
    const { env, paths } = minimalEnvironment(runDir, 'test-nonce', 'test-server-password')
    const nativeHome = process.env.USERPROFILE ?? homedir()
    const nativeAppData = process.env.APPDATA ?? path.join(nativeHome, 'AppData', 'Roaming')
    const nativeLocalAppData = process.env.LOCALAPPDATA ?? path.join(nativeHome, 'AppData', 'Local')
    const nativeXdgData = process.env.XDG_DATA_HOME ?? path.join(nativeHome, '.local', 'share')
    const nativeDataDir = process.env.OPENCODE_DATA_DIR
      ?? path.join(nativeXdgData, 'opencode')

    expect(env.USERPROFILE).toBe(nativeHome)
    expect(env.HOME).toBe(nativeHome)
    expect(env.APPDATA).toBe(nativeAppData)
    expect(env.LOCALAPPDATA).toBe(nativeLocalAppData)
    expect(env.XDG_DATA_HOME).toBe(nativeXdgData)
    expect(env.OPENCODE_DATA_DIR).toBe(nativeDataDir)
    expect(env.OPENCODE_DB).toBe(path.join(paths.data, 'opencode.db'))
    expect(env.OPENCODE_DB).not.toContain(path.join(nativeDataDir, 'opencode.db'))
    expect(env.OPENCODE_CONFIG_DIR).toBe(paths.config)
    expect(env.XDG_CONFIG_HOME).toBe(paths.config)
    expect(env.OPENCODE_API_KEY).toBeUndefined()
  })

  it('passes the Go credential only through the child environment and references it without persisting it in config', () => {
    const prior = process.env.OPENCODE_GO_API_KEY
    const mockCredential = 'mock-go-credential-never-persist'
    process.env.OPENCODE_GO_API_KEY = mockCredential
    try {
      const { env } = minimalEnvironment(path.join(process.cwd(), 'temporary-f2b0-run', randomUUID()), 'test-nonce', 'test-server-password')
      expect(env.OPENCODE_GO_API_KEY).toBe(mockCredential)
      expect(goProviderSettings().apiKey).toBe('{env:OPENCODE_GO_API_KEY}')
      expect(JSON.stringify(goProviderSettings())).not.toContain(mockCredential)
    } finally {
      if (prior === undefined) delete process.env.OPENCODE_GO_API_KEY
      else process.env.OPENCODE_GO_API_KEY = prior
    }
  })

  it('writes the Go env reference into the isolated effective config, never the credential value', async () => {
    const configRoot = await mkdtemp(path.join(tmpdir(), 'f2b0-go-config-'))
    const mockCredential = 'mock-go-credential-never-persist'
    try {
      const { env } = minimalEnvironment(configRoot, 'test-nonce', 'test-server-password')
      const prior = process.env.OPENCODE_GO_API_KEY
      process.env.OPENCODE_GO_API_KEY = mockCredential
      try {
        const paths = minimalEnvironment(configRoot, 'test-nonce', 'test-server-password').paths
        await writeConfig(paths.config, path.join(configRoot, 'work'), false)
      } finally {
        if (prior === undefined) delete process.env.OPENCODE_GO_API_KEY
        else process.env.OPENCODE_GO_API_KEY = prior
      }
      const configText = await readFile(path.join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')
      const config = JSON.parse(configText)
      expect(config.providers['opencode-go'].settings.apiKey).toBe('{env:OPENCODE_GO_API_KEY}')
      expect(configText).not.toContain(mockCredential)
    } finally {
      await rm(configRoot, { recursive: true, force: true })
    }
  })

  it('loads only the OPENCODE_GO entry from dotenv into memory', async () => {
    const envRoot = await mkdtemp(path.join(tmpdir(), 'f2b0-go-env-'))
    const envFile = path.join(envRoot, '.env')
    const priorKey = process.env.OPENCODE_GO_API_KEY
    const priorAlias = process.env.OPENCODE_GO
    delete process.env.OPENCODE_GO_API_KEY
    delete process.env.OPENCODE_GO
    try {
      await writeFile(envFile, 'UNRELATED_SECRET=must-not-be-selected\nOPENCODE_GO="mock-go-credential-in-memory-only"\n')
      expect(await loadGoApiKey(envFile)).toBe('mock-go-credential-in-memory-only')
    } finally {
      if (priorKey === undefined) delete process.env.OPENCODE_GO_API_KEY
      else process.env.OPENCODE_GO_API_KEY = priorKey
      if (priorAlias === undefined) delete process.env.OPENCODE_GO
      else process.env.OPENCODE_GO = priorAlias
      await rm(envRoot, { recursive: true, force: true })
    }
  })

  describe('sanitized message-list readback diagnostic (F2-B0, no content)', () => {
    const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

    it('never copies untrusted message types into diagnostics', () => {
      const secret = 'sensitive-unexpected-message-type'
      const result = diagnoseReadback([{ type: secret }, { type: '__proto__' }], 'prompt')
      expect(result.typeCounts).toEqual({ user: 0, assistant: 0, other: 2, missing: 0 })
      expect(result.promptConfirmed).toBe(false)
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain('__proto__')
    })

    it('fails closed on invalid structure without leaking content', () => {
      const prompt = 'prompt-exato-f2b0-somente-diagnostico'
      for (const invalid of [null, undefined, 'not-an-array', {}, [{ content: [] }], [{ type: 42 }]]) {
        const result = diagnoseReadback(invalid, prompt)
        expect(result.structureValid).toBe(false)
        expect(result.promptConfirmed).toBe(false)
        expect(result.promptConfirmed).toBe(isPromptConfirmed(invalid, prompt))
        expect(result.userTextLength).toBe(null)
        expect(result.userTextSha256).toBe(null)
        expect(result.assistantTextLength).toBe(null)
        expect(result.assistantTextSha256).toBe(null)
        expect(JSON.stringify(result)).not.toContain(prompt)
      }
    })

    it('fails closed on multiple user messages while reporting sanitized counts', () => {
      const first = 'primeira-parte-do-prompt-f2b0'
      const second = 'segunda-parte-do-prompt-f2b0'
      const assistantText = 'resposta-do-modelo-f2b0'
      const messages = [
        { type: 'user', content: [{ type: 'text', text: first }] },
        { type: 'user', content: [{ type: 'text', text: second }] },
        { type: 'assistant', content: [{ type: 'text', text: assistantText }] },
      ]
      const prompt = `${first}${second}`
      const result = diagnoseReadback(messages, prompt)

      expect(result.messageCount).toBe(3)
      expect(result.userMessageCount).toBe(2)
      expect(result.assistantMessageCount).toBe(1)
      expect(result.typeCounts).toMatchObject({ user: 2, assistant: 1 })
      expect(result.structureValid).toBe(true)
      expect(result.promptConfirmed).toBe(false)
      expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
      expect(result.userTextLength).toBe(`${first}${second}`.length)
      expect(result.userTextSha256).toBe(sha256(`${first}${second}`))
      expect(result.assistantTextLength).toBe(assistantText.length)
      expect(result.assistantTextSha256).toBe(sha256(assistantText))
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(first)
      expect(serialized).not.toContain(second)
      expect(serialized).not.toContain(assistantText)
      expect(serialized).not.toContain(prompt)
    })

    it('confirms the exact single prompt via hash/length only, preserving exact comparison', () => {
      const prompt = 'prompt-f2b0-exato — café 🧾'
      const messages = [{ type: 'user', content: [{ type: 'text', text: prompt }] }]
      const result = diagnoseReadback(messages, prompt)

      expect(result.structureValid).toBe(true)
      expect(result.messageCount).toBe(1)
      expect(result.userMessageCount).toBe(1)
      expect(result.promptConfirmed).toBe(true)
      expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
      expect(result.userTextLength).toBe(prompt.length)
      expect(result.userTextSha256).toBe(sha256(prompt))
      expect(JSON.stringify(result)).not.toContain(prompt)

      const nearMiss = diagnoseReadback(messages, `${prompt} `)
      expect(nearMiss.promptConfirmed).toBe(false)
      expect(nearMiss.promptConfirmed).toBe(isPromptConfirmed(messages, `${prompt} `))
    })

    it('hashes joined assistant text across multiple messages without content', () => {
      const prompt = 'prompt-f2b0-leitura'
      const messages = [
        { type: 'user', content: [{ type: 'text', text: prompt }] },
        { type: 'assistant', content: [{ type: 'text', text: 'parte-um-f2b0-' }] },
        { type: 'assistant', content: [{ type: 'text', text: 'parte-dois-f2b0' }, { type: 'other', text: 'ignorado-f2b0' }] },
      ]
      const joinedAssistant = 'parte-um-f2b0-parte-dois-f2b0'
      const result = diagnoseReadback(messages, prompt)

      expect(result.promptConfirmed).toBe(true)
      expect(result.assistantMessageCount).toBe(2)
      expect(result.assistantTextLength).toBe(joinedAssistant.length)
      expect(result.assistantTextSha256).toBe(sha256(joinedAssistant))
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('parte-um-f2b0')
      expect(serialized).not.toContain('parte-dois-f2b0')
      expect(serialized).not.toContain(prompt)
    })

    describe('opencode 2.2.1 top-level user text (narrow)', () => {
      it('accepts single user with top-level text string keeping exact equality', () => {
        const prompt = 'prompt-f2b0-toptext — café 🧾'
        const messages = [{ type: 'user', id: 'msg-1', time: 123, text: prompt, files: [], content: undefined }]
        const cleaned = messages.map(({ content, ...rest }) => (content === undefined ? rest : { ...rest, content }))

        expect(isPromptConfirmed(cleaned, prompt)).toBe(true)
        const result = diagnoseReadback(cleaned, prompt)
        expect(result.structureValid).toBe(true)
        expect(result.promptConfirmed).toBe(true)
        expect(result.promptConfirmed).toBe(isPromptConfirmed(cleaned, prompt))
        expect(result.userMessageCount).toBe(1)
        expect(result.userTextLength).toBe(prompt.length)
        expect(result.userTextSha256).toBe(sha256(prompt))
        expect(JSON.stringify(result)).not.toContain(prompt)

        const nearMiss = diagnoseReadback(cleaned, `${prompt} `)
        expect(nearMiss.promptConfirmed).toBe(false)
        expect(nearMiss.promptConfirmed).toBe(isPromptConfirmed(cleaned, `${prompt} `))
      })

      it('preserves content[] confirmation when 2.2.1 envelope fields are present', () => {
        const prompt = 'prompt-f2b0-envelope'
        const messages = [{ type: 'user', id: 'msg-2', time: 456, files: [], content: [{ type: 'text', text: prompt }] }]

        expect(isPromptConfirmed(messages, prompt)).toBe(true)
        const result = diagnoseReadback(messages, prompt)
        expect(result.structureValid).toBe(true)
        expect(result.promptConfirmed).toBe(true)
        expect(result.userTextLength).toBe(prompt.length)
        expect(result.userTextSha256).toBe(sha256(prompt))
        expect(JSON.stringify(result)).not.toContain(prompt)
      })

      it('accepts convergent dual representation (content[] equals top-level text)', () => {
        const prompt = 'prompt-f2b0-convergente'
        const messages = [{ type: 'user', id: 'msg-3', time: 789, files: [], text: prompt, content: [{ type: 'text', text: prompt }] }]

        expect(isPromptConfirmed(messages, prompt)).toBe(true)
        const result = diagnoseReadback(messages, prompt)
        expect(result.promptConfirmed).toBe(true)
        expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
        expect(result.userTextLength).toBe(prompt.length)
        expect(result.userTextSha256).toBe(sha256(prompt))
        expect(JSON.stringify(result)).not.toContain(prompt)
      })

      it('rejects fail-closed when content[] and top-level text diverge', () => {
        const prompt = 'prompt-f2b0-esperado'
        const other = 'texto-divergente-f2b0'
        const messages = [{ type: 'user', id: 'msg-4', time: 101, files: [], text: other, content: [{ type: 'text', text: prompt }] }]

        expect(isPromptConfirmed(messages, prompt)).toBe(false)
        expect(isPromptConfirmed(messages, other)).toBe(false)
        const result = diagnoseReadback(messages, prompt)
        expect(result.structureValid).toBe(true)
        expect(result.promptConfirmed).toBe(false)
        expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain(prompt)
        expect(serialized).not.toContain(other)
      })

      it('never confirms invalid top-level text types', () => {
        const prompt = 'prompt-f2b0-tipo'
        for (const invalidText of [42, null, {}, [], true]) {
          const messages = [{ type: 'user', id: 'msg-x', time: 1, files: [], text: invalidText }]
          expect(isPromptConfirmed(messages, prompt)).toBe(false)
          const result = diagnoseReadback(messages, prompt)
          expect(result.promptConfirmed).toBe(false)
          expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
          expect(JSON.stringify(result)).not.toContain(prompt)
        }
      })

      it('rejects multiple users even when one top-level text matches exactly', () => {
        const prompt = 'prompt-f2b0-unico'
        const messages = [
          { type: 'user', id: 'a', time: 1, files: [], text: prompt },
          { type: 'user', id: 'b', time: 2, files: [], text: 'outro-f2b0' },
        ]
        expect(isPromptConfirmed(messages, prompt)).toBe(false)
        const result = diagnoseReadback(messages, prompt)
        expect(result.userMessageCount).toBe(2)
        expect(result.promptConfirmed).toBe(false)
        expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
        expect(JSON.stringify(result)).not.toContain(prompt)
      })

      it('rejects ambiguous split top-level text that only joins to the prompt', () => {
        const first = 'primeira-f2b0-toptext'
        const second = 'segunda-f2b0-toptext'
        const messages = [
          { type: 'user', id: 'a', time: 1, files: [], text: first },
          { type: 'user', id: 'b', time: 2, files: [], text: second },
        ]
        const prompt = `${first}${second}`
        expect(isPromptConfirmed(messages, prompt)).toBe(false)
        const result = diagnoseReadback(messages, prompt)
        expect(result.promptConfirmed).toBe(false)
        expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain(first)
        expect(serialized).not.toContain(second)
        expect(serialized).not.toContain(prompt)
      })
    })
  })

  describe('extractAssistantApiText (assistant top-level text, no-throw + validity)', () => {
    it('ignores non-textual parts but fails closed on malformed text parts', () => {
      const okMessages = [
        { type: 'assistant', content: [{ type: 'text', text: 'parte-um-' }, { type: 'other', text: 'ignorado' }, { type: 'tool', foo: 1 }] },
      ]
      expect(extractAssistantApiText(okMessages)).toMatchObject({ text: 'parte-um-', valid: true, reason: 'ok' })
      for (const badContent of [
        [{ type: 'text', text: 'parte-um-' }, { type: 'text', text: 42 }],
        [{ type: 'text', text: 'parte-um-' }, { type: 'text' }],
        [{ type: 'text', text: 42 }],
      ]) {
        let result
        expect(() => { result = extractAssistantApiText([{ type: 'assistant', content: badContent }]) }).not.toThrow()
        expect(result.valid).toBe(false)
        expect(result.reason).toBe('invalid-text-part')
      }
    })

    it('accepts top-level text when content is absent without throwing (reviewer RED)', () => {
      const messages = [{ type: 'assistant', text: 'ola-top-level' }]
      let result
      expect(() => { result = extractAssistantApiText(messages) }).not.toThrow()
      expect(result).toMatchObject({ text: 'ola-top-level', valid: true, reason: 'ok' })
    })

    it('accepts convergent dual representation without duplication', () => {
      const text = 'convergente-f2b0'
      const messages = [{ type: 'assistant', text, content: [{ type: 'text', text }] }]
      expect(extractAssistantApiText(messages)).toMatchObject({ text, valid: true, reason: 'ok' })
    })

    it('marks divergent dual representation invalid while preserving evidence (no throw)', () => {
      const fromContent = 'conteudo-f2b0-'
      const fromTop = 'topo-f2b0'
      const messages = [{ type: 'assistant', text: fromTop, content: [{ type: 'text', text: fromContent }] }]
      let result
      expect(() => { result = extractAssistantApiText(messages) }).not.toThrow()
      expect(result.text).toBe(`${fromContent}${fromTop}`)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe('ambiguous-dual-representation')
    })

    it('fails closed to invalid on bad shapes without throwing', () => {
      for (const invalid of [null, undefined, 'not-an-array', {}, 42, [], [null], [42], ['x'], [{ type: 'assistant' }], [{ type: 'assistant', content: 'str', text: 42 }], [{ type: 'assistant', content: [{ type: 'text' }] }], [{ type: 'assistant', text: 42 }], [{ type: 'assistant', content: [{ type: 'text', text: 'A' }] , text: 42 }]]) {
        let result
        expect(() => { result = extractAssistantApiText(invalid) }).not.toThrow()
        expect(result.valid).toBe(false)
        expect(typeof result.text).toBe('string')
        expect(typeof result.reason).toBe('string')
      }
      expect(extractAssistantApiText(null)).toMatchObject({ text: '', valid: false })
      expect(extractAssistantApiText(undefined)).toMatchObject({ text: '', valid: false })
      expect(extractAssistantApiText([])).toMatchObject({ text: '', valid: false, reason: 'empty' })
      expect(extractAssistantApiText([{ type: 'assistant' }])).toMatchObject({ valid: false })
    })

    it('marks empty-text extraction invalid even when shapes are well-formed', () => {
      expect(extractAssistantApiText([{ type: 'assistant', content: [] }]).valid).toBe(false)
    })

    it('stays consistent with diagnoseReadback assistant hashing for top-level text', () => {
      const prompt = 'prompt-f2b0-leitura'
      const assistantText = 'resposta-top-level-f2b0'
      const messages = [
        { type: 'user', content: [{ type: 'text', text: prompt }] },
        { type: 'assistant', text: assistantText },
      ]
      const extraction = extractAssistantApiText(messages.filter((m) => m.type === 'assistant'))
      expect(extraction.valid).toBe(true)
      const result = diagnoseReadback(messages, prompt)
      expect(result.assistantTextLength).toBe(extraction.text.length)
      expect(result.assistantTextSha256).toBe(createHash('sha256').update(extraction.text, 'utf8').digest('hex'))
    })
  })

  describe('decideAssistantTextStop (decision path: ambiguous/invalid never passes)', () => {
    it('stops assistant-text-invalid on divergent A/B even when stdout equals concatenated AB (reviewer regression)', () => {
      const extraction = extractAssistantApiText([{ type: 'assistant', content: [{ type: 'text', text: 'A' }], text: 'B' }])
      expect(extraction.valid).toBe(false)
      expect(extraction.text).toBe('AB')
      const stop = decideAssistantTextStop(extraction, 'AB')
      expect(stop).toMatchObject({ stop: true, category: 'assistant-text-invalid' })
    })

    it('stops assistant-text-invalid on empty/invalid extraction even when stdout is also empty (reviewer regression)', () => {
      for (const invalid of [[], [{ type: 'assistant' }], null, undefined, 'x']) {
        const extraction = extractAssistantApiText(invalid)
        expect(extraction.valid).toBe(false)
        const stop = decideAssistantTextStop(extraction, '')
        expect(stop).toMatchObject({ stop: true, category: 'assistant-text-invalid' })
      }
    })

    it('passes (null) only when valid extraction equals stdout text', () => {
      const extraction = extractAssistantApiText([{ type: 'assistant', text: 'ok-f2b0' }])
      expect(decideAssistantTextStop(extraction, 'ok-f2b0')).toBe(null)
    })

    it('stops cli-api-output-mismatch when valid extraction diverges from stdout', () => {
      const extraction = extractAssistantApiText([{ type: 'assistant', text: 'A' }])
      expect(decideAssistantTextStop(extraction, 'B')).toMatchObject({ stop: true, category: 'cli-api-output-mismatch' })
    })

    it('never throws on non-object extraction or non-string stdout', () => {
      for (const bad of [null, undefined, 42, 'x', {}, { valid: true }]) {
        let stop
        expect(() => { stop = decideAssistantTextStop(bad, 'AB') }).not.toThrow()
        expect(stop).toMatchObject({ stop: true, category: 'assistant-text-invalid' })
      }
      const valid = extractAssistantApiText([{ type: 'assistant', text: 'A' }])
      expect(() => decideAssistantTextStop(valid, undefined)).not.toThrow()
      expect(decideAssistantTextStop(valid, undefined)).toMatchObject({ stop: true, category: 'cli-api-output-mismatch' })
    })

    it('stops assistant-text-invalid when stdout equals the silently-accepted prefix (reviewer adversarial)', () => {
      const extraction = extractAssistantApiText([{ type: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 42 }] }])
      expect(extraction.valid).toBe(false)
      expect(extraction.reason).toBe('invalid-text-part')
      expect(extraction.text).toBe('A')
      expect(decideAssistantTextStop(extraction, 'A')).toMatchObject({ stop: true, category: 'assistant-text-invalid' })
    })

    it('passes non-textual parts mixed with valid text through the integrated decision', () => {
      const extraction = extractAssistantApiText([{ type: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'other', text: 'ignorado' }, { type: 'tool', foo: 1 }] }])
      expect(extraction).toMatchObject({ text: 'A', valid: true, reason: 'ok' })
      expect(decideAssistantTextStop(extraction, 'A')).toBe(null)
    })
  })

  describe('isPromptConfirmed with malformed text parts (reviewer adversarial)', () => {
    it('rejects when a text part is malformed even if valid parts join to the prompt', () => {
      const prompt = 'A'
      const messages = [{ type: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 42 }] }]
      expect(isPromptConfirmed(messages, prompt)).toBe(false)
      const result = diagnoseReadback(messages, prompt)
      expect(result.promptConfirmed).toBe(false)
      expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
    })

    it('rejects text parts with missing or non-string text', () => {
      const prompt = 'A'
      for (const badContent of [
        [{ type: 'text', text: 'A' }, { type: 'text' }],
        [{ type: 'text', text: 'A' }, { type: 'text', text: null }],
        [{ type: 'text', text: 42 }],
      ]) {
        const messages = [{ type: 'user', content: badContent }]
        expect(isPromptConfirmed(messages, prompt)).toBe(false)
        expect(diagnoseReadback(messages, prompt).promptConfirmed).toBe(false)
      }
    })

    it('allows non-textual parts alongside valid text', () => {
      const prompt = 'prompt-f2b0-misto'
      const messages = [{ type: 'user', content: [{ type: 'text', text: prompt }, { type: 'other', text: 'ignorado' }, { type: 'tool', foo: 1 }] }]
      expect(isPromptConfirmed(messages, prompt)).toBe(true)
      const result = diagnoseReadback(messages, prompt)
      expect(result.promptConfirmed).toBe(true)
      expect(result.promptConfirmed).toBe(isPromptConfirmed(messages, prompt))
      expect(result.userTextLength).toBe(prompt.length)
    })
  })
})
