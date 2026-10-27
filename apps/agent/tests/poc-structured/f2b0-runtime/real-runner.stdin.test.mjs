import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { captureCli, classifyStdinWriteError, isPromptConfirmed, minimalEnvironment, goProviderSettings, writeConfig, loadGoApiKey } from './real-runner.ts'

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
})
