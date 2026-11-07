# P3.2 — receita por conversa (OpenCode-first)

**Data:** 2026-11-07
**Base:** `33e067f` (head do PR #293, P3.1)
**Branch:** `feat/p3-income-slice`
**Ambiente:** desenvolvimento local, dados sintéticos, provider HTTP scriptado
**Veredito:** `P3_INCOME_SLICE_PASS` no escopo local/determinístico; sem merge,
deploy ou escrita financeira real.

## 1. Fluxo funcional implementado

```
PWA (mensagem)
  → /api/agent → gateway ted-runtime (loopback)
  → prompt loop OpenCode 2.2.4 (provider scriptado local)
  → tool propose_income: valida args + identidade host-bound
  → registra INTENÇÃO (sem HTTP, sem escrita)
  → gateway anexa `proposal` ao turno (uma vez)
  → TedChat → Agent broker `POST /rpc/pending-operations/propose`
  → Agent emite SOMENTE `financial.approval.propose` (A4)
  → API `POST /pending-operations/v2/propose` (Pending V2, idempotente)
  → TedChat reidrata o card da lista ativa autoritativa
  → usuário Confirma/Rejeita (caminho de decisão existente)
  → API confirma/executa → recibo canônico → refresh financeiro
```

Com a mensagem exata **“Registre uma receita de R$ 2.500 de salário na conta
Nubank.”**, o teste determinístico com o SDK real comprova: a mensagem chega ao
loop, o catálogo oferece `propose_income`, a tool registra
`{amountCents: 250000, description: "salário", date, accountId, categoryId}` e
**zero** chamadas ao transporte financeiro. O card de R$ 2.500,00 aparece
somente após a proposta persistir; antes disso, zero lançamentos.

## 2. Componentes reutilizados

- **Nenhum segundo broker.** `proposeTransactionFromIntent` é o único caminho
  A4; `transactions.expense.create` (P3.1) e `transactions.income.create`
  (P3.2) compartilham validação, mint do token, idempotência e persistência.
- `financial.approval.propose` continua sendo a ÚNICA capability emitida.
- Pending V2, executor, apresentação, recibos canônicos e a decisão
  confirm/cancel existentes na API não foram alterados.
- PWA: `TedChat`, `TedApprovalCard`, lista de operações pendentes, recuperação
  da intenção no reload, retry direto ao broker e reconciliação financeira
  existentes foram reutilizados. O card já identificava `income` como
  "Receita" (título "Confirmar receita").
- Runtime: o mesmo registry process-local e o mesmo executor intent-only;
  `propose_income` apenas mapeia para `transactions.income.create`.

## 3. Arquivos modificados

**Runtime (`apps/ted-runtime`)**
- `src/tool-defs.mjs`: def/validação de `propose_income` + executor único
  intent-only compartilhado.
- `src/plugin.mjs`: opt-in P3 expõe `propose_expense` + `propose_income`;
  allowlist de recursos inclui ambos.
- `src/bootstrap.mjs`: `tedConfig(profile, { p3Writes })` adiciona a permissão
  exata de `propose_income` somente no opt-in local.
- `README.md`: catálogo/limites atualizados.

**Agent (`apps/agent`)**
- `src/mutations/pending-proposal-broker.ts`: schema discriminado para os dois
  tools; `proposeTransactionFromIntent` (broker único) e resumo Receita/Despesa.
  `proposeExpenseFromIntent` permanece como alias compatível.
- `src/finance-chat-agent.ts`: a rota propose aceita a união fechada e chama o
  broker único.

**PWA (`apps/pwa`)**
- `src/lib/api/agent-client.ts`: `ProposalIntent` (união despesa/receita),
  sanitização estrita dos dois contratos, `proposePendingOperation` (alias
  `proposePendingExpense` mantido).
- `src/features/ted/TedChat.tsx`: copy de erro por tipo (despesa/receita),
  mesmo fluxo de broker/recuperação.

**Testes**
- `apps/ted-runtime/tests/p3-propose-income.test.mjs` (novo)
- `apps/ted-runtime/tests/p3-propose-expense.test.mjs` (catálogo)
- `apps/ted-runtime/tests/p3-propose-loop.test.mjs` (loop real de receita)
- `apps/ted-runtime/tests/tool-defs.test.mjs`,
  `apps/ted-runtime/tests/policy-denies.test.mjs`
- `apps/agent/tests/pending-propose-rpc.test.ts`
- `apps/pwa/src/lib/api/__tests__/agent-client.proposal.test.ts`
- `apps/pwa/src/features/ted/__tests__/TedChat.propose.test.tsx`
- `apps/api/tests/integration/p3-income-broker-flow.test.ts` (novo)
- `apps/pwa/e2e/p2d/p3-income.spec.ts` (novo E2E de navegador)

**Harness E2E**
- `apps/pwa/e2e/playwright.config.ts`, `apps/pwa/e2e/support/p2d-browser-stack.mts`,
  `apps/pwa/e2e/support/p2d-synthetic-read-probe.mjs` aceitam
  `P2D_INCOME=1`, emitem `propose_income` e expõem saldos no control server.

## 4. Como a autorização Pending V2/A4 foi reutilizada

- O gateway OpenCode **não** recebeu `AGENT_DELEGATION_SECRET`, não mintou
  capability e não chamou a API de proposta.
- O único emissor continua sendo `apps/agent` (`createDelegatedTurnToken`). O
  broker emite **exatamente** `['financial.approval.propose']`, com
  `deviceId` do device verificado, `requestId` = `intentionId` estável e
  expiração de 300 s do contrato existente.
- A API não foi alterada: `createIncomeInputSchema`, o tool registry, o
  preHandler delegado e `requireV2Capability('financial.approval.propose')`
  continuam a autoridade.
- `Idempotency-Key` é derivada por
  `deriveIdempotencyKey(workspace, intentionId, tool)` — repetição do mesmo
  intent devolve a MESMA operação.
- O LLM não tem ferramenta de confirmar/executar; os testes provam ausência de
  `confirm_income`/`execute_income` no catálogo.
- O card continua vindo da lista ativa autoritativa; a confirmação reutiliza
  `/rpc/pending-operations/:id/decision` e o recibo canônico existentes.

## 5. Resultado dos testes

| Verificação | Resultado |
|---|---|
| `ted-runtime` completo (`node --test tests/`) | **254/254 PASS** — inclui `propose_income`, catálogo, permissões e o prompt loop REAL 2.2.4 com provider scriptado local (despesa + receita) |
| Agent completo | **3960 PASS / 1 skip** — 1 timeout transitório de 5 s em `real-hygiene` sob carga; o arquivo passa 4/4 isolado e a suíte completa passou na repetição |
| API (unit, `tests/integration` excluído pelo script do pacote) | **2867 PASS / 172 skips** |
| API focada de integração (`p3-income-broker-flow`, `p3-expense-broker-flow`, `p3-expense-slice`) | **15/15 PASS** — broker real + verificador delegado real; income: 0 antes, 1 depois, reject 0, replay sem duplicata, workspace estranho 403 |
| PWA completa | **2928 PASS / 9 skips** — inclui 2 testes novos de receita (cliente + TedChat) |
| `pnpm typecheck` (6 workspaces) | **PASS** |
| `pnpm lint` | **PASS** (0 errors; 27 warnings preexistentes) |
| `pnpm docs:lint` | **PASS** (17 docs, 0 issues) |
| `pnpm governance:check` | **PASS** (sem mudança D01–D19) |
| `pnpm capabilities:check` | **PASS** (54 tools / 75 rows) |
| `pnpm write-policy:check` | **PASS** (183/183) |
| `pnpm boundary:check` | **PASS** |
| `pnpm action-pins:check` | **PASS** (94 uses) |
| `pnpm test:skip-gate` | **PASS** (0 novos skips incondicionais) |
| `pnpm public-safety --strict` | **PASS** (nenhum achado) |
| E2E de receita (`P2D_INCOME=1`, Chromium real → Next → gateway → SDK real → provider scriptado → Agent Worker real → Pending V2) | **1 passed (2.9m)** |
| E2E de despesa P3.1 (regressão, `P2D_EXPENSE=1`) | **1 passed (1.0m)** |

Evidência do E2E de receita (`apps/pwa/test-results/p3-income/evidence.json`):

| Métrica | Resultado |
|---|---|
| `brokerAttempts` | 3 (1 falha + 1 recuperação + 1 segunda proposta) |
| `promptCalls` / `stubTurns` | 2 / 4 |
| `reloadNewPrompts` | 0 |
| `proposeRequests` / `confirmRequests` / `executeRequests` / `cancelRequests` | 2 / 1 / 1 / 1 |
| `syntheticIncomeRows` | 1 |
| `balanceBeforeCents` / `balanceAfterCents` / `balanceDeltaCents` | 50000 / 300000 / **250000** |
| `duplicateLaunch` | `false` |
| `recoveredAfterReload` | `true` |
| `rejectedWrites` | 0 |

Comandos (em `apps/pwa`):

```bash
P2D_INCOME=1 pnpm exec playwright test --config e2e/playwright.config.ts --project p2d-synthetic
P2D_EXPENSE=1 pnpm exec playwright test --config e2e/playwright.config.ts --project p2d-synthetic
```

## 6. Limitações e riscos residuais

- O provider é scriptado; isto prova o fluxo do produto, não a qualidade de um
  modelo externo.
- O card terminal ("Operação registrada") é transitório no comportamento P3.1:
  a lista ativa só contém operações pendentes. O recibo canônico é provado pela
  resposta de decisão consumida pela PWA e pela reconciliação financeira
  (saldo/extrato), não por um widget persistente novo.
- `workerd` pode emitir `SQLITE_BUSY` transitório no boot do Agent (risco do
  harness local, não do fluxo).
- Sem alteração de provider, autorização, policy da API, deploy ou produção.
