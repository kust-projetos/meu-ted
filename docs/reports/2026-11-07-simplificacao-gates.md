# Simplificação de gates, CI e políticas — 2026-11-07

## Objetivo

Reduzir etapas e repetição no desenvolvimento do Meu TED sem tocar na lógica
financeira, autenticação, confirmação, idempotência, Pending V2 ou deploy.

## Antes → depois

| Métrica | Antes | Depois |
|---|---|---|
| Comandos obrigatórios no pre-commit | 9 | 1 (`commit:check`) |
| Tempo do pre-commit (medido local) | 116 s | 2,2 s |
| Jobs de CI por PR | 16 | 6 típicos (até 9) |
| Jobs nos workflows de PR | 18 (CI 16 + PWA 2) | 13 (CI 11 + PWA 2) |
| Required checks | 2 | 2 (nomes preservados) |
| E2E completo no PR | sempre | main ou label `run-full-e2e` |
| Lighthouse/auditorias/scan | no PR | workflow `Audits` (semanal/sob demanda) |
| `AGENTS.md` | 73,7 KB | 8,9 KB |

Os dois required checks continuam com os mesmos nomes — `Gate — all checks` e
`quality (22, 10)` — para não bloquear PRs abertos nem exigir mudança em branch
protection.

## Mudanças

### 1. AGENTS.md enxuto

- `AGENTS.md` agora tem regras operacionais curtas, stack/topologia e o fluxo de
  validação.
- O conteúdo histórico completo foi preservado em
  [`docs/reference/AGENTS-HISTORICO.md`](../reference/AGENTS-HISTORICO.md).
- O bloco gerenciado do ai-memory foi mantido intacto.

### 2. Pré-commit leve

- `.husky/pre-commit` roda apenas `pnpm commit:check`.
- `scripts/check-commit-diff.mjs` valida o diff staged: marcadores de conflito,
  JSON/JSONC/YAML, nomes de arquivo com aparência de segredo e arquivos > 2 MB.
- `scripts/check-changed-areas.mjs` (novo `pnpm check:area`) seleciona gates por
  área: docs, governança, agent, PWA, workflows e testes.

### 3. CI reduzido e sem duplicação

- `ci.yml` cobre backend/agent/contratos: `changes`, `quality`, `functional`,
  `gate` + jobs condicionais (`postgres-financial`, `docs-policies`,
  `agent-policy`, `workflows-gates`) + artefatos main-only
  (`agent-manifest`, `api-image`, `release-manifest`).
- `pwa-ci.yml` cobre somente a PWA: `quality (22, 10)` (lint, typecheck, build
  Cloudflare, testes, headers, orçamento de JS) e E2E completo em main/label.
- `audits.yml` concentra Lighthouse, auditoria de dependências e scan de
  containers em schedule semanal ou sob demanda.
- Nenhum job de PWA roda no `ci.yml` e nenhum job de API/Agent roda no
  `pwa-ci.yml`.

### 4. Políticas

- Gates documentais, de governança, capability, write-policy e boundary deixam de
  rodar em todo commit e passam a rodar quando a área muda.
- Validações financeiras de runtime, autenticação, autorização, confirmação,
  Pending V2 e idempotência não foram alteradas.
- A suíte financeira (API unit + approvals + idempotência + integração +
  concorrência) roda no job `postgres-financial` quando `apps/api` ou
  `packages/llm-contracts` mudam, ou com o label `run-financial`.
- `docs:lint`, `governance:check`, `capabilities:check`, `write-policy:check`,
  `boundary:check`, `action-pins:check`, `workflows-yaml:check` e
  `test:skip-gate` continuam disponíveis em `pnpm check:area` e no CI
  condicional.

## Validação

Comandos locais executados neste worktree (Node do ambiente, `yaml` do store):

- `pnpm commit:check` — 18 arquivos staged OK, 2,2 s.
- `node scripts/lint-docs.mjs` — 17 documentos, 0 issues.
- `node scripts/check-workflows-yaml.mjs` — 10 workflows parseados.
- `node scripts/check-action-pins.mjs` — 78 `uses:` pinados, 0 exceções.
- `node scripts/check-test-skips.mjs` — 127 arquivos críticos, 0 skips novos.
- `node scripts/check-public-safety.mjs --strict` — 0 findings.
- `node --test scripts/check-commit-diff.test.mjs scripts/check-changed-areas.test.mjs`
  — 10/10.
- `node --test scripts/root-ci-workflow.test.mjs` — 22/22.
- `node --test scripts/check-decision-governance.test.mjs` — 14/14.
- `node --test scripts/documentation-gates-t13.test.mjs` — 13/13.
- `node --test scripts/security-gates.test.mjs` — 18/18.
- `node --test scripts/validate-deploy-workflows.test.mjs` — 54/54.
- `node --test scripts/pwa-audit-workspace.test.mjs` — 24/24.
- `node --test scripts/canonical-docs-contract.test.mjs scripts/documentation-facts-contract.test.mjs scripts/check-engines-contract.test.mjs`
  — 27 pass / 1 skip (wrangler não instalado localmente).

Resultado do CI do PR e do smoke funcional:

### Resultado do PR #295

- **CI** run `42371605653` — `success` em 5m10s de parede:
  - `Detect changed areas` 7s; `Quality` 17s; `Functional` 31s;
    `Docs + governance` 22s; `Workflow pins + YAML` 27s;
    `Financial integrity — Postgres` 4m53s; `Gate` 4s.
  - `Agent policies` e jobs main-only (`agent-manifest`, `api-image`,
    `release-manifest`) ficaram `skipped`, como esperado.
- **PWA CI** run `42371605845` — `quality (22, 10)` `success` em 6m34s;
  `e2e` `skipped` (sem o label `run-full-e2e`).
- **Suíte financeira** (label `run-financial`): API unit + approvals +
  integração + concorrência contra Postgres real. A suíte de concorrência fechou
  `18 files / 123 tests passed`, incluindo:
  - confirmação/rejeição: `tests/approvals/pending-v2-contract.test.ts`,
    `pending-v2-idempotency.test.ts`, `executor.test.ts`,
    `pending-adversarial.test.ts`;
  - duplicação financeira impedida:
    `tests/routes/transactions-idempotency-uow.test.ts`,
    `tests/integration/postgres-idempotency-containment.test.ts`,
    `tests/writes/postgres-idempotency-lease.test.ts`,
    `tests/routes/idempotency-route-identity.test.ts`.
- Nenhum arquivo de `apps/api` ou `apps/agent` foi alterado; os workflows de
  deploy não foram tocados; `validate-deploy-workflows` passou 54/54.
- Observação operacional: adicionar labels **depois** de criar o PR. Passar
  `--label` na criação dispara `opened` + `labeled`; o run mais novo cancela o
  primeiro pela concorrência por ref, o que aparece como um run cancelado.


## Pendências reais

- O E2E completo deixou de rodar em todo PR; para validar uma mudança de PWA,
  aplicar o label `run-full-e2e`.
- Auditorias (Lighthouse, dependências, containers) agora são semanais/sob
  demanda; não são required checks.
- `run-financial` é o override manual para rodar a suíte financeira em um PR que
  não altera `apps/api`/`packages/llm-contracts`.
