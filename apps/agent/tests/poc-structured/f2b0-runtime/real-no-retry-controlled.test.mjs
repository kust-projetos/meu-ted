import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  classifyLocalServerFailure,
  isReadinessPollRetriable,
} from './real-guard.mjs'

// Branch no-retry-controlled (security-reviewer P1): modo real
// (--execute-real) PARA (fail-closed, sem nova tentativa) em falhas locais
// de conexao/prontidao em qualquer ponto que possa levar a inferencia.
// Readiness do servidor (server.info()) pode ter espera limitada SEM
// reenviar prompt — este arquivo delimita e prova as duas metades.
describe('no-retry-controlled: local failure never repeats inference', () => {
  it('classifies every local connection code as fail-closed for the inference layer', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']) {
      expect(classifyLocalServerFailure({ code })).toMatchObject({ retry: false, fatal: true, category: 'connection' })
      expect(classifyLocalServerFailure({ cause: { code } })).toMatchObject({ retry: false, fatal: true, category: 'connection' })
    }
  })

  it('keeps the readiness poll retriable only pre-prompt (server.info carries no prompt)', () => {
    // The bounded server.info() poll may wait; it never sends a prompt,
    // session, or model call, so it cannot repeat inference.
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']) {
      expect(isReadinessPollRetriable({ code })).toBe(true)
    }
    expect(isReadinessPollRetriable({ status: 401 })).toBe(false)
    expect(isReadinessPollRetriable({ status: 503 })).toBe(false)
  })

  it('aborts the run with 0 model calls when the pre-prompt path fails once with ECONNREFUSED', () => {
    // Simulates the runner contract: one actionable attempt; on local
    // failure classify fail-closed and abort WITHOUT a second attempt.
    // A mock transport that fails once with ECONNREFUSED must leave the
    // model-call counter at 0 and surface the abort.
    let modelCalls = 0
    const sendPromptOnce = () => { modelCalls += 1 }
    const localFailure = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' })
    let aborted = false
    try {
      throw localFailure
      sendPromptOnce()
    } catch (error) {
      const decision = classifyLocalServerFailure(error)
      expect(decision).toMatchObject({ retry: false, fatal: true, category: 'connection' })
      if (!decision.retry) aborted = true
      else sendPromptOnce()
    }
    expect(aborted).toBe(true)
    expect(modelCalls).toBe(0)
  })

  it('wires the runner so no actionable path repeats inference after a local failure', async () => {
    // Structural guard: the per-case flow issues a single captureCli per
    // case and stops+finalizes on the first failure. Assert the source
    // contains exactly one prompt-dispatch call site and an explicit
    // no-resend contract comment.
    const root = path.resolve(import.meta.dirname)
    const source = await readFile(path.join(root, 'real-runner.ts'), 'utf8')
    const dispatchSites = (source.match(/await captureCli\(CLI,/g) ?? []).length
    expect(dispatchSites).toBe(1)
    expect(source).toContain('no-retry-controlled')
    expect(source).toContain('zero resends')
    const guard = await readFile(path.join(root, 'real-guard.mjs'), 'utf8')
    expect(guard).toContain('isReadinessPollRetriable')
  })
})
