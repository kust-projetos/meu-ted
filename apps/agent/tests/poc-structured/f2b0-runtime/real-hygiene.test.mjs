import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Branch no-retry-controlled, security-reviewer P2: todo artefato privado do
// harness deve estar coberto pelo gitignore do harness, e nenhuma publicacao
// pode carregar estado privado. Cobertura transitiva (tudo sob
// /evidence/real/*) mais linhas explicitas por familia (linhas citadas).
describe('no-retry-controlled: private-artifact hygiene', () => {
  it('documents every private family in the harness .gitignore', async () => {
    const root = path.resolve(import.meta.dirname)
    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8')
    const lines = gitignore.split(/\r?\n/)
    // Citas explicitas exigidas pelo achado P2:
    expect(gitignore).toContain('/evidence/real/*') // linha 5: guarda-chuva
    expect(gitignore).toContain('/evidence/real/reservations/') // reservas
    expect(gitignore).toContain('private-data/') // dados por run (OPENCODE_DB)
    expect(gitignore).toContain('private-config/') // config isolada por run
    expect(gitignore).toContain('work/') // workdir por run
    expect(gitignore).toContain('.db') // bancos por run (*.db / *.db-journal)
    expect(lines.some((line) => line.includes('private-temp/'))).toBe(true)
    expect(lines.some((line) => line.includes('private-cache/'))).toBe(true)
    expect(lines.some((line) => line.includes('private-state/'))).toBe(true)
  })

  it('keeps every representative private path ignored by git', async () => {
    const root = path.resolve(import.meta.dirname)
    const repo = path.resolve(root, '..', '..', '..', '..', '..')
    const samples = [
      'apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-27T01-04-23-758Z-13588/cases/F1-B005.json',
      'apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/reservations/opencode-go-muse-spark-1.3-contributor/F1-B005.reserved',
      'apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-27T01-04-23-758Z-13588/private-data/opencode.db',
      'apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-27T01-04-23-758Z-13588/private-config/opencode.json',
      'apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-27T01-04-23-758Z-13588/work/session.json',
      'apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/2026-10-27T01-04-23-758Z-13588/plugin-hooks.ndjson',
    ]
    for (const sample of samples) {
      const { stdout } = await execFileAsync('git', ['check-ignore', '-v', sample], { cwd: repo })
      expect(stdout).toContain('.gitignore')
      expect(stdout).toContain(sample)
    }
  })

  it('carries a sanitize-before-publication note in the runner (code comment)', async () => {
    // P2(b): nota operacional preferida como comentario no codigo.
    const root = path.resolve(import.meta.dirname)
    const source = await readFile(path.join(root, 'real-runner.ts'), 'utf8')
    expect(source).toContain('sanitize')
    expect(source).toContain('private-')
    expect(source).toContain('ONLY synthetic fixtures')
  })

  it('references the synthetic fixture source for the real campaign (no re-audit)', async () => {
    // P2(c): a campanha real so envia fixtures sinteticas de
    // F2A1_INPUTS via getF2B0Cases (f2b0-adapter.ts) — ja verificado pelo
    // researcher; aqui apenas referenciamos o fio, sem re-auditar conteudo.
    const root2 = path.resolve(import.meta.dirname)
    const adapter = await readFile(path.resolve(root2, '..', 'f2b0-adapter.ts'), 'utf8')
    expect(adapter).toContain('F2A1_INPUTS')
    expect(adapter).toContain('getF2B0Cases')
    const runner = await readFile(path.join(root2, 'real-runner.ts'), 'utf8')
    expect(runner).toContain('getF2B0Cases')
  })
})
