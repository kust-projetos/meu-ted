# MEU TED — SPIKE 05 RESULTS
## Primeira operação financeira completa com OpenCode e Pending V2

**Projeto:** `kust-projetos/meu-ted`
**Worktree:** `D:/projetos/pi-ted-runtime-spike`
**Branch:** `experiment/ted-opencode-runtime`
**Data:** 2026-10-31
**Veredito:** `PARTIAL` — determinístico PASS (S05-01..S05-10 no escopo sintético); prova com LLM real pelo prompt-loop PENDENTE (modelo autorizado, sem campanha paga executada).

> Sem push, PR, merge ou deploy. Sem modificação de produção, PWA real, banco financeiro real ou harness Cloudflare.

---

## 1. Objetivo e resultado

Demonstrar ponta a ponta: mensagem do usuário → compreensão LLM → proposta financeira → confirmação autenticada → execução API → recibo verdadeiro, com dados sintéticos e contratos financeiros existentes, mínimo de código novo, sem reconstruir o harness antigo.

**Alcançado (determinístico):** `propose_expense` nativa registrada no loop OpenCode 2.2.4, proposta via Pending V2 real (mesma instância), confirmação por CLI experimental isolado com ação explícita (nunca "sim" textual), recibo só com efeito persistido, idempotência mesma-instância provada (replay 200 + conflito 409), limite one-shot provado (R3: 2 processos = 2 ids distintos).

**Pendente (LLM real):** turno conversacional real `session.prompt → modelo → propose_expense → confirmação` com modelo autorizado `opencode-go/deepseek-v4.1-flash`. Não executado: sem teto de orçamento informado + histórico `provider.no-route` em 3 tentativas na SPIKE 04L. Custo de inferência nesta etapa: **0** (nenhum call pago; harnesses determinísticos chamam os mesmos `execute` com contexto host-bound).

---

## 2. Fechamento SPIKE 04 (item 1 do spec)

- **Preservação:** 14 traces copiados byte a byte para `spike-05/traces/originals/` (SHA256 ALL MATCH); originais em `reports/` intactos. Verificado por tester: 14/14 idênticos.
- **Reavaliação com extrator corrigido, sem inferência adicional:** extrator localizado (não era `saldo-extrato.ts`, que é só metadado de Skill): `lastAssistantText` em `bootstrap/run-03b-turn.mjs:619-658` + `checkAllCallsArgs` em `bootstrap/run-04-journey.mjs:609-639`, regressão `tests/spike-04l-extract.test.mjs` 7/7. Reavaliação factual original × regrade `*LR` preexistente: J06LR/J07ALR grounded reais; J07BLR vereditos inalterados (U pass / E incomplete / R incomplete); traces 04 sem regrade preservam R vácuo (follow-up 04L §10.4).
- **J07-B:** registrado como defeito comportamental não bloqueante em `spike-05/04-closure/J07-B-defect.md` (sessão fresca, "E em maio?" assume 2026-05 sem clarificar; sem fabricação, só read-only).
- **Restart com LLM:** prova pendente em `spike-05/04-closure/restart-pending-proof.md` (recovery 2 processos provado; 3× `provider.no-route` documentado).
- **Checkpoint local:** só instruções em `spike-05/04-closure/checkpoint-local.md` (tag sugerida `spike-05-04-closure-local`); nada commitado/pusheado por workers. Nenhuma campanha extensa nova iniciada.

---

## 3. Arquitetura efetivamente utilizada

```
LLM (pendente) → propose_expense (tool nativa OpenCode 2.2.4)
  → Plugin.define({id:'ted-finance'}) + ctx.tool.transform(editor.add({name,input,output,execute}))
  → execute(input, ctx{sessionID,agent,messageID,id:CallID,signal})
  → resolveHost(sessionID→session-bindings) + deriveIntentionId({sessionID,messageID})
  → validateToolArgs (FORBIDDEN_KEYS: actor/workspace/token/session/intention/key/call)
  → POST /pending-operations/v2/propose (Idempotency-Key host-derivada + proposalHash)
  → Pending V2 (autoridade única) → 201 proposed / 200 existing:true / 409 idempotency.conflict
  → CLI experimental isolado --action confirm|cancel (ação explícita autenticada sintética)
  → GET /:id/outcome (recibo só se succeeded + receipt canônico)
```

- **Sem segunda máquina de estados:** Pending V2 é a única autoridade. O store em `spike-05/scripts/confirm-cli.mjs` é **TEST-DOUBLE NÃO-AUTORITATIVO** explícito (só UX: lista, exige ação, recusa "sim"); asserções de autoridade (R1/R2/R3) vão contra o Pending V2 real via bridge.
- **Sem MCP, subagentes, roteador de intenções, memória própria ou confirmação alternativa.**
- **Host-bound:** identidade/workspace/token/intention nunca vêm de args LLM. `ctx.id` (CallID) só correlação. Sem `sessionID`/host → `host_context_required` fail-closed. `signal` abortado → `tool.cancelled`.
- **OpenCode 2.2.4 nativo:** `input` JSON Schema `additionalProperties:false` obrigatório; `output` JSON Schema obrigatório (loop rejeita output sem schema — erro 03B-T1); `ctx.tool.add` direto não existe; callback `transform` sem side-effect. Config do spike em `experiments/ted-runtime/bootstrap/` + `manifest.json` (pins 2.2.4); sem `opencode.json`/`.opencode/` na raiz (descoberta via `oc.plugin()`, provado por `ctx.tool.list()`).

---

## 4. Contratos Pending V2 reaproveitados (API como autoridade)

Fonte: `D:/projetos/pi-financeiro` (só leitura).

- **Propose:** `POST /pending-operations/v2/propose` (e alias `/v2`), capability `financial.approval.propose`, `Idempotency-Key` obrigatório (`requireIdempotencyKey`), `validateApprovalToolArgs` contra registry, replay-first + hash-bound, clamp TTL server-side (30 min), `proposalHash = computePendingOperationV2Hash(base)`, `INSERT ... ON CONFLICT (workspace_id,idempotency_key) WHERE protocol_version=2` → conflito de hash = `idempotency.conflict`. Retorna 201 ou 200 `existing:true`.
- **Consulta:** `GET /v2/active` (lista via `listActive(identity)` + lazy-expiry + apresentação server-side) ; `GET /v2/:id/outcome` (schema `pendingOperationOutcomeSchema`: proposed/confirmed/executing/succeeded+receipt/favavailed/cancelled/expired/unverified).
- **Confirmação autenticada:** `POST /v2/:id/confirm` (identity sempre `authenticatedContext` server-side + `requireActionablePresentation` fail-closed + `approvalPolicy.evaluateMutation` → manual/auto/destructive/high_value). `POST /v2/:id/authorize` para path autoexecute (`TED_RISK_BASED_AUTOEXECUTE` off/shadow/on).
- **Execução:** attestation token, `store.execute` com TX1 (`executing` + lease 60s + `executionAttemptCount`), executor fora da transação com `idempotencyKey` persistida, guarda stale-finalization (TX2 só se ainda `executing` mesmo attempt), `withTedReceipt` fail-closed, `succeeded` com `execution.result` + `mutationId` ou `failed` sanitizado. `reconcileExpiredExecuting` renova lease e reexecuta mesma chave.
- **intentionId:** opcional em confirm/execute, gerado pelo host (`deriveIntentionId({sessionID,messageID})`, estável por intenção, nunca `toolCallId`/`messageId` volátil). Binding durável em `pending_operation_confirmation_intentions` via `bindConfirmationIntention` + `bindIntentionToOperation` (CAS primeiro vence; divergente = `approval.intention_conflict`). Ledger: `apps/agent/src/tools/intention-ledger.ts`.
- **Recibo:** `withTedReceipt` → `buildTedReceipt(tool, pendingId, {type,id})`, validado por `mutationReceiptSchema` + `MUTATION_EFFECTS_REGISTRY`. Só `succeeded` com recibo autoriza afirmar execução.
- **Incerteza:** `approval.execution_uncertain` (409) mantém `executing` (sem `failed`, sem retry direto), lease para reconciliador mesma chave.
- **Cancel:** `store.cancel` só `proposed`/`confirmed` → `cancelled`; retry só após `failed`. Rota real `POST /v2/:id/cancel` + `:id/reject` existe (capability cancel) mas **não exposta** pelo bridge one-shot — CLI `--origin --action cancel` rejeitado explicitamente (exit 2, sem simular via confirm).

Estados UX do TED (projeções, não estados persistidos): proposta criada / aguardando confirmação (`proposed`) / operação executada (`succeeded`+receipt) / operação rejeitada (cancel explícito) / resultado desconhecido (`executing`/`unverified`/incerto). Nunca afirmar registro antes do recibo.

---

## 5. Cenário principal (sintético, determinístico)

Mensagem: *"TED, gastei 35 reais no mercado ontem, pelo Nubank."*

- Fixture congelada `spike-05/fixtures/synthetic-case-35-mercado.json`: `ACCOUNT_A2` Nubank `11111111-1111-4111-8111-111111111112`, `CATEGORY_FOOD_A` Mercado `22222222-2222-4222-8222-222222222221`, `household …000a`, `amountCents: 3500`, `dateRule: YESTERDAY_DYNAMIC_UTC` (nunca data congelada; prova: 2026-10-31 → `date: 2026-10-30`).
- `propose_expense({amountCents, description, date, accountId, categoryId?})` — só dados financeiros. Host injeta workspace/actor/device/token/intention. Chave `ted-<sha256(workspace,NUL,intentionId,NUL,tool)>` estável por intenção.
- Fluxo determinístico: harness chama o mesmo `execute` com contexto host-bound → 201 `proposed` → CLI `--list`/`--show` (0 efeitos) → `--action confirm` identidade correta → `confirmed`, 1 efeito, recibo `{operationId, entityId: synth-tx-…, 3500}`. "sim" textual (posicional ou `--text`) recusado exit 2.
- Extração pela LLM real ("35 reais / mercado / ontem / Nubank") **não exercitada** — pendente (modelo autorizado, sem campanha paga).

---

## 6. Testes e evidências (determinísticos, 0 custo LLM)

| Suite | Resultado |
|---|---|
| `spike-05/tests/spike-05-negatives.test.mjs` | **19/19 PASS** (~5–6s): 16 UX `[DOUBLE-ONLY]` (0–14 + PRINCIPAL) + 3 `[REAL-PENDING-V2]` R1/R2/R3 via bridge STDIO real |
| `tests/spike-02.test.mjs` | **20/20 PASS** (~35–40s, bridge tsx in-memory, sem container/banco real) |
| `tests/spike-04l-extract.test.mjs` | **7/7 PASS** |
| `node --check` (confirm-cli, negatives, finance-transport) | exit 0 |
| CLI manual | `--list` 0 efeitos; `sim` recusado exit 2; `confirm` correto → confirmed 1 efeito + recibo; `--origin cancel` → exit 2 "HTTP cancellation not supported"; sem `SPIKE05_ALLOW_HTTP=1` → recusado |
| Traces | 14/14 SHA256 MATCH `spike-05/traces/originals/` × `reports/SPIKE_04_TRACE_*.json` |
| R1/R2/R3 (autoridade real) | R1 replay mesma chave+payload → 200 `existing:true` mesmo id; R2 mesma chave payload divergente → 409 `idempotency.conflict`; R3 mesma chave 2 processos → 2×201 ids distintos (prova de não-persistência cross-processo one-shot) |

Negativos cobertos (16 UX + autoridade): conta ambígua, inexistente, valor inválido, workspace incorreto, confirmação por outro usuário, proposta expirada, confirmação duplicada (idempotente), repetição da chamada LLM (mesma intentionId reusa), timeout após envio (pending, 0 efeitos), falha da API (fail-closed), restart entre proposta e confirmação (save/load correlação, autoridade = follow-up ted-local), recibo ausente (`unverified`), execução direta negada (`confirm first`), "sim" textual negado. Critério principal verificado: confirmada ≤1 efeito; não confirmada = 0 lançamentos.

---

## 7. Traces sanitizados

Originais preservados em `spike-05/traces/originals/` (14 arquivos, nomes idênticos, sem mover originais). Nenhum dado real, secreto ou credencial nos traces novos (IDs sintéticos, HMAC de teste rotulado). `--origin` agora loopback-only + `redirect:'manual'` sem seguir 3xx + sem credenciais em URL.

---

## 8. Código próprio adicionado (só worktree spike, sem push)

- `experiments/ted-runtime/bootstrap/ted-finance-tools.mjs` — `TOOL_DEFS.propose_expense` (input/output schemas), `deriveExpenseIdempotencyKey`, `PROPOSE_EXPENSE_TOOL`, `FORBIDDEN_KEYS` (+8), `validateToolArgs` (ramo propose_expense), `createToolExecutors` (POST propose, 409→`tool.conflict`/422→`tool.invalid`). Sem segunda máquina; Pending V2 é autoridade.
- `experiments/ted-runtime/bootstrap/finance-transport.mjs` — allowlist (`ALLOWED_PATHS` + propose, métodos GET reads / POST propose), gate body/idempotencyKey/delegado, passthrough `verifyReplay`/`verifyConflictBody` (test-only), comentários limite one-shot.
- `experiments/ted-runtime/bootstrap/finance-bridge.ts` — `runPropose` (rotas reais + `createInMemoryPendingOperationV2Store` + executor + `createDelegatedTurnToken` + mint host-side + `SYNTHETIC_TOKENS` teste), comentários one-shot (store fresco por processo; probes mesma-instância).
- `experiments/ted-runtime/bootstrap/plugins/ted-finance/index.mjs` — **sem alteração** (genérico cobre: `for (const def of TOOL_DEFS)` + transform).
- `experiments/ted-runtime/tests/spike-02.test.mjs` — 1 linha (contagem 2→3).
- `spike-05/fixtures/synthetic-case-35-mercado.json` — caso congelado (novo).
- `spike-05/scripts/confirm-cli.mjs` — store double + CLI (novo; + fix loopback-only + cancel HTTP recusado).
- `spike-05/tests/spike-05-negatives.test.mjs` — 19 testes (novo; double-only + R1/R2/R3 reais).
- `spike-05/04-closure/{04-reevaluation,J07-B-defect,restart-pending-proof,checkpoint-local}.md` + `spike-05/traces/originals/` (14 cópias).
- Harness de prova throwaway removido após uso.

---

## 9. Revisão independente

- **Tester S05-TEST-01/02/03:** PASS (determinístico; LLM = pendente explícito). 19/19 + 20/20 + 7/7, CLI manual, traces 14/14.
- **Reviewer S05-REV-01:** CHANGES_REQUIRED (P1 double como autoridade; P1 replay cross-call falso; P2 cancel via confirm). **S05-FIX-01** endereçou: double marcado não-autoritativo, R1/R2 mesma-instância + R3 prova limite, cancel HTTP rejeitado. **S05-REV-02:** APPROVED, zero P0/P1/P2.
- **Security S05-SEC-02:** CHANGES_REQUIRED (MEDIUM: `--origin` blocklist bypassável por alias/IP). **S05-FIX-02:** allowlist loopback-only (`http:` + `127.0.0.1`/`localhost`/`::1` + porta explícita + sem path/query/creds + `redirect:'manual'` + exit 2). **S05-SEC-03:** APPROVED.

---

## 10. Limitações (não bloqueiam o determinístico, bloqueiam o veredito full)

1. **Prompt-loop com LLM real não exercitado** (exige inferência paga; modelo autorizado `opencode-go/deepseek-v4.1-flash`, sem teto informado + histórico `no-route`). Não afirmar fluxo completo aprovado.
2. **Bridge one-shot:** store in-memory fresco por processo; replay/conflito provados mesma-instância (R1/R2); cross-processo/restart durável exige `ted-local`/Postgres (R3 prova a ausência; follow-up obrigatório).
3. **`categoryId` opcional na tool mas obrigatório no `createExpenseInputSchema`** → 422 real quando omitido (autoridade decide, não bug).
4. **Token HMAC sintético fixo** só no harness; produção exige mint pelo Agent.
5. **CLI `--origin` é demonstração explícita** (só loopback + env opt-in); confirmação autenticada de produção deve ser revista separadamente.
6. **J07-B + restart-com-modelo** seguem pendentes da 04L (sem nova campanha extensa neste SPIKE).
7. **J01 copiado em modo dryrun** (efeito documentado em 04R §1.i); traces 04 sem regrade mantêm R vácuo (follow-up 04L §10.4).

---

## 11. Custos de inferência

**0.** Nenhum call pago nesta etapa. Todas as provas determinísticas chamam os mesmos `execute` com contexto host-bound sem modelo. Campanha LLM real requer: modelo `opencode-go/deepseek-v4.1-flash` (autorizado) + teto de orçamento explícito + provider roteável + harness de prompt-loop isolado (sem PWA/banco real).

---

## 12. Critérios S05-01..S05-10 (determinístico / full)

| ID | Critério | Determinístico | Full (com LLM) |
|---|---|---|---|
| S05-01 | Tool nativa registrada e utilizável | PASS (list + 20/20) | PENDENTE (prompt-loop real) |
| S05-02 | Proposta criada corretamente pela API sintética | PASS (201/200/409 reais) | PENDENTE (extração real "35…") |
| S05-03 | Identidade host-bound preservada | PASS (7 forbidden + hostless/cancel) | PENDENTE |
| S05-04 | Nenhuma execução antes de confirmação autenticada | PASS (só propose allowlisted) | PENDENTE |
| S05-05 | Confirmação resulta em operação correta | PASS (CLI explícito, sem "sim") | PENDENTE (turno real) |
| S05-06 | Recibo corresponde ao efeito persistido | PASS (só succeeded+receipt; unverified senão) | PENDENTE |
| S05-07 | Repetições/retries sem duplicação | PASS mesma-instância; cross-processo = limite provado (R3) | PENDENTE (durable) |
| S05-08 | Erros/incertos sem recibos falsos | PASS (fail-closed, uncertain sem receipt) | PENDENTE |
| S05-09 | Isolamento entre identidades | PASS (workspace/actor negados, 0 efeitos) | PENDENTE (prod boundary separada) |
| S05-10 | Nenhuma nova infra de orquestração | PASS (só node:fs/path/url no CLI) | PASS |

---

## 13. Veredito

**`PARTIAL`.**

Determinístico: PASS em S05-01..S05-10 no escopo sintético, com tester PASS + reviewer APPROVED + security APPROVED, sem regressões (19/19 + 20/20 + 7/7), sem push/deploy, sem tocar produção.

Full (ponta a ponta com LLM real pelo prompt-loop): **não aprovado** — execução real pelo prompt-loop não foi exercitada (regra do spec §9). Próximo passo exige campanha mínima autorizada com teto explícito: 1 turno "35 reais mercado ontem Nubank" → `propose_expense` → CLI confirm → outcome+recibo, contra API sintética durável (`ted-local`), sem PWA/banco real.

**Não implementar outras operações financeiras nesta etapa.** `propose_expense` é a única escrita; nada além dela foi criado.

---

## 14. Addendum — provider conectado + 1 turno live read-only (2026-10-31)

**Status:** provider `opencode-go` / modelo `deepseek-v4.1-flash` CONECTADO no harness isolado. Teto de 1 chamada consumido; sem novas chamadas sem nova autorização.

- **Comando (único autorizado):** `TED_03B_LIVE=1 node experiments/ted-runtime/bootstrap/run-03b-turn.mjs --mode=live --message='Qual o resumo de junho de 2026 e quais contas eu tenho?'` — 1 `session.prompt` só, sem `--host/--route/--token`, sem frase dos 35 reais.
- **Resultado:** exit 0, `sessionPromptCalled=true`, `promptError=null`, 20,8s; `get_month_summary {2026-06}` + `list_accounts` completed; `propose_expense` não chamado (runner read-only fail-closed); veredito B01–B08 = 8× pass (summary 1200000/288050/911950/4 + Itaú 100000 / Nubank 50000).
- **Credencial:** `OPENCODE_GO` do `.env` do pi-financeiro injetada só no processo isolado como `OPENCODE_API_KEY` (só `keyLength` logado, sem valor); `build03BConfig` mantém deny-all + allow só `opencode-go` + denies shell/edit/subagent/write.
- **Custos:** harness não expõe tokens/custo — controle por contagem (1/1 usada).
- **Escopo preservado:** nada commitado/pusheado; nenhum dado real, PWA real, banco real ou produção tocados.
- **Pendente:** turno live de escrita (`propose_expense` no prompt-loop) exige task própria com expansão de `FINANCE_TOOLS` + facade + B02/B04 e gate de confirmação explícita — não executado aqui.
