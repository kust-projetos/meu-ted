# Simplificação arquitetural final — resultado

**Base:** `main@420f90c` · **Branch:** `chore/arch-simplification-final`
**Data:** 2026-11-10 · **Escopo:** local/sintético; sem deploy, merge ou dado real.

**Status:** SIMPLIFICAÇÃO ARQUITETURAL — CONCLUÍDA (2026-11-10; PR #316 com CI verde).

## O que foi alterado

### Removido

| Item | Evidência |
|---|---|
| `apps/codex-broker` (app, testes, Dockerfile, manifests) | Sem `CODEX_BROKER_ORIGIN` em wrangler/compose/deploy; adapter sempre lança `codex_runtime_not_configured`; consumido apenas por CI/audits/smoke. Wiring de build, CI, scripts, lockfile e docs foi removido junto. |
| `apps/agent/src/shadow/shadow-runner.ts` + emissão no gerador | `runShadowRead` era `async () => {}`; todo GET recebia uma chamada no-op. |
| `apps/agent/src/poc-minimal/*` + teste próprio | POC A1 rejeitado pela ADR-031; sem import no worker, evals ou orquestrador. |

### Simplificado / corrigido

| Item | Mudança |
|---|---|
| Ferramentas geradas do A0 | Regeneração removeu o hook de shadow e sincronizou o contrato vigente (`get_month_summary.basis` e as tools P4). |
| Teste de wiring do runtime | Cobre o repasse da allowlist de origem do `main` para o transporte (o transporte em si já foi corrigido no `main` por #314/#315). |
| Docs de arquitetura | `ARCHITECTURE-CURRENT`, `ARCHITECTURE-TARGET`, `runtime-ownership-matrix` e `runtime-facts.json` descrevem OpenCode como runtime principal e A0 como rollback. |

### Preservado para rollback

`apps/agent` (A0, broker de propostas, confirmação/execução, settings),
`poc-structured`/oráculos de avaliação e o cliente opcional
`private-broker-client` (inerte sem `CODEX_BROKER_ORIGIN`).

## Validação executada

| Verificação | Resultado |
|---|---|
| `node --test apps/ted-runtime/tests/` | **PASS** 341/341 |
| `deployment-origin` (inclui wiring de origem interna → transporte) | **PASS** 10/10 |
| `tests/generated-tools.test.ts` + `tests/cognitive-tools.test.ts` | **PASS** 12/12 |
| `tests/cognitive-wiring.test.ts` + `tests/private-broker-client.test.ts` | **PASS** 20/20 |
| `tsc` do Agent (src, config temporária src-only) | **PASS** |
| Scripts alterados (`root-scripts`, `security-gates`, `check-engines`, `run-final-validation`, `container-smoke`) | **PASS** 36/36 |
| `pnpm test:scripts` | **PASS** 11/11 |
| `canonical-docs-contract` + `documentation-gates-t13` + `documentation-facts-contract` | **PASS** 37/37 |
| `pnpm docs:lint` | **PASS** (17 docs, 0 issues) |
| `pnpm governance:check` | **PASS** |
| `pnpm capabilities:check` | **PASS** (54 tools / 75 rows) |
| `pnpm write-policy:check` | **PASS** (183/183) |
| `pnpm boundary:check` | **PASS** |
| `pnpm architecture:check` | **PASS** (536 arquivos) |
| `pnpm test:skip-gate` | **PASS** (129 arquivos; 0 novos skips) |
| `pnpm plans:check` | **PASS** |
| PWA: ativação de runtime + rota P2D + rota P2 | **PASS** 36/36 |
| API: slices P3 (expense/income/transfer/statement + broker flows) | **PASS** 36/36 |
| Piloto integrado P2D_P3_PILOT (browser, provider scriptado) | **PASS** (7 confirmações, 7 execuções, 1 cancelamento, 0 writes diretos, 0 mismatches) |
| `pnpm install --frozen-lockfile --offline` | Lockfile aceito (“Lockfile is up to date”); resolução parou por pacotes ausentes no cache offline |
| `git diff --check` | **PASS** |

## Regressão integrada (PASS)

Comando: `P2D_P3_PILOT=1 pnpm exec playwright test --config=e2e/playwright.config.ts --project=p2d-synthetic --workers=1`.

A primeira execução falhou porque o proxy PWA selecionava A0: a allowlist obrigatória `TED_OPENCODE_WORKSPACES` (#306) não incluía o `HOUSEHOLD_A` sintético, e `readProxyEnv()` prioriza o ambiente Cloudflare local sobre `process.env`. A correção ficou restrita ao harness: o config P2D gera `apps/pwa/.dev.vars` (mecanismo local de bindings, sem segredo, ignorado pelo Git) com o workspace sintético e o gateway loopback. Nenhuma mudança em `readProxyEnv`, `wrangler.jsonc` de produção, autenticação, API, gateway ou A0.

Resultado: **1 passed (1.1m)**. Evidência `test-results/p3-integrated/evidence.json`:

- 7 turnos confirmados; `proposes=8`, `confirms=7`, `executes=7`, `cancels=1`, `directFinancialWrites=0`, `stubMismatches=[]`.
- Despesa, receita, transferência, compra 1x, parcelamento 3x, pagamento parcial e quitação da fatura.
- Saldos/fatura: A1 `126500`, A2 `65000`, dívida do cartão `40000`; fatura Nov `32000/32000 paid`.
- `month-summary`: liquidez `70500`, competência `38500`.
- Reload com proposta pendente reidratada sem novo prompt; cancelamento sem escrita; contexto e pedido de esclarecimento sem proposta.
- `promptCalls=11`, `stubTurns=19`; provider scriptado local, sem inferência paga.

## Não executado / limitações

- **Typecheck completo do Agent (`tsc --noEmit` com tests):** o processo ficou
  bloqueado sem progresso de CPU neste host; o `src` foi validado com a mesma
  configuração, restrito a `src/**/*.ts` + typings do Worker. O CI executa o
  comando integral.
- **Biome agregado:** excedeu 300 s sem saída (issue histórica #291 de
  performance no Windows); não foi convertido em PASS.
- **PWA/API completos, Postgres, browser E2E e modelo real:** a suíte PWA e os
  gates de API rodaram no CI (verdes). O piloto integrado de browser passou com
  provider scriptado local; nenhuma inferência real foi usada.
- **Dados financeiros, credenciais, deploy e merge:** não tocados.

## Pendências reais

- O A0 mantém orquestração e roteamento próprios porque é o rollback aprovado;
  removê-los exigiria eliminar o rollback e provar o OpenCode em todos os
  fluxos, fora do escopo.
- `poc-structured`/oráculos F2 permanecem como evidência de paridade.
