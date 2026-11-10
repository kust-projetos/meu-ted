# Aposentadoria de scripts — inventário e decisão (2026-11-10)

**Base:** `chore/arch-simplification-final@754addb` · **Critério:** remover somente script sem nenhum consumidor em código, CI, `package.json`, workspace, Docker ou runbook ativo (`docs/runbooks`, `docs/operations`, `docs/architecture`, `docs/reference`, `README`, `AGENTS.md`). Referência apenas em documento histórico (`docs/superpowers`, `docs/reports`, `docs/recovery`, `docs/goals`, `ESTADO-E-PROXIMOS-PASSOS`) não conta como consumidor.

Busca executada por nome e por stem (para pegar imports `./x.js`) em `package.json`, `pnpm-workspace.yaml`, `.github`, `apps`, `packages`, `docker`, `scripts`, `vitest.config.ts`, `README.md` e docs ativas.

## Removidos (fase encerrada, sem consumidor)

| Script | Por que é seguro remover |
|---|---|
| `scripts/plan-legacy-retirement.mjs` + teste | Descreve estágios de desativação do runtime WhatsApp/Evolution e de `.pi/`, ambos já removidos. Nenhum comando ativo o invoca. |
| `scripts/g6-soak-status.mjs` + teste | Gate de soak de 48h do G6, encerrado; só aparece no snapshot histórico `ESTADO-E-PROXIMOS-PASSOS.md`. |
| `scripts/runtime-transition-soak.mjs` + teste | Avalia a transição Pi owner → Agent owner; a transição terminou e o runtime atual é outro (OpenCode). |
| `scripts/verify-goal-loop-policy.mjs` + teste | Simula o antigo goal-loop (caps de continuação/tempo), processo que não é usado pelo fluxo atual. |
| `scripts/calculate-project-rubric.mjs` + teste | Rubrica de avaliação de projeto usada na campanha antiga; nenhum plano/gate ativo a consome. |
| `scripts/openai-codex-subscription-spike.mjs` | Spike do provider Codex; o `apps/codex-broker` foi removido no PR #316 e o cliente restante falha fechado sem configuração. |

## Mantidos (ferramenta de recuperação/operação ainda válida)

| Script | Motivo |
|---|---|
| `scripts/check-snapshot-policy.mjs` + teste | Gate de snapshot usado em incidentes; os runbooks de recuperação o citam. Reutilizável. |
| `scripts/check-working-tree-inventory.mjs` + teste | Inventário de working tree para recuperação; mesma justificativa. |
| `scripts/f2-prepare-anonymized-dump.sh` | Pipeline de anonimização (PII nunca sai da VPS); procedimento de privacidade reutilizável. |
| `scripts/pwa-vitest-runner-benchmark.mjs` | Benchmark de runner; inofensivo e útil se a flakiness do Vitest voltar. |
| `scripts/shell-vps.bat` | Atalho operacional para a VPS; não é runtime nem migração. |
| `scripts/check-capability-acceptance.mjs` + teste | Valida o inventário de capabilities; complementa (não duplica) `check-tool-capability-inventory.mjs` e pode ser acionado manualmente. |

## Fora de escopo

- `apps/codex-broker/dist` e artefatos untracked (`a0-*`, `p2d_*`, `next_a0*`) são estado local ignorado; não foram tocados.
- `scripts/cutover-check.ts`, `scripts/canary-validation.ts`, `scripts/capability-flags.ts` e `scripts/shadow-config.ts` **não** são órfãos: são importados por testes da API (`apps/api/tests/contract/cutover-readiness.test.ts`, `apps/api/tests/adversarial/cutover-adversarial.test.ts`).
