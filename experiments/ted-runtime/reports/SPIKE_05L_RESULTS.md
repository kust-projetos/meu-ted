# MEU TED — SPIKE 05L RESULTS
## Segunda inferência live (propose) verificada em snapshot + confirmação sintética — evidência ponta a ponta

**Projeto:** `kust-projetos/meu-ted`
**Worktree:** `D:/projetos/pi-ted-runtime-spike`
**Branch:** `experiment/ted-opencode-runtime`
**Data:** 2026-10-31
**Veredito:** `SPIKE_05_PARTIAL` — execução funcional live (propose via modelo real + confirmação sintética), mas prova durável cross-process da proposta live incompleta; follow-up `ted-local`/Postgres obrigatório.

> Sem push, PR, merge, deploy ou produção. Sem nova inferência nesta escrita. Nenhum banco real, PWA real, Cloudflare ou harness de produção tocado.

Evidências primárias (somente leitura nesta tarefa):
- `experiments/ted-runtime/reports/SPIKE_05L_TRACE_live_2026-10-31T15-48-43-100Z.json` — **snapshot imutável timestamped do SEGUNDO turno live** (`mode:"live"`, `sessionPromptCalled:true`, `sessionPromptCount:1`, `at 2026-10-31T15:48:43.100Z`, sessão `ses_e6d5a2719ffe2HhlNpi30qJKTw`): evidência live verificável — B01–B08 `pass`, args observados, latência `elapsedMs 23242`, custo exposto `0`, 2 turnos live dentro do teto operacional US$5.
- `experiments/ted-runtime/reports/SPIKE_05L_TRACE.json` — trace **dryrun atual** (`mode:"dryrun"`, `sessionPromptCalled:false`, `at 2026-10-31T15:34:51.134Z`): prova o harness determinístico, **NÃO** a inferência live.
- **CORREÇÃO 2026-10-31 (HIGH, parcialmente superada): o PRIMEIRO turno live não teve trace imutável preservado** (busca em `reports/` + `spike-05/traces/` + histórico git encontrou só o latest sobrescrito pelo dryrun; o harness escrevia dryrun e live no mesmo `SPIKE_05L_TRACE.json`). Detalhes do primeiro turno (`66635d44`, `elapsedMs 24867`, sessão `ses_e6d6e30f…`) seguem **EVIDÊNCIA INDIRETA**. O **segundo** turno live tem snapshot imutável acima — os §§4–5/9–10 citam fatos verificáveis do snapshot onde aplicável.
- `experiments/ted-runtime/spike-05/traces/SPIKE_05L_CONFIRM_TRACE.json` — confirmação sintética + R1/R2/R3 (double não-autoritativo; sem prova do turno live)
- `experiments/ted-runtime/reports/SPIKE_05_RESULTS.md` — base determinística (§§2–4 reutilizados, sem reexecução de campanha paga)

---

## §1 — Preparação (preservação, diffs, catálogo, regressões, contratos, bridge)

- **Preservação 14/14:** 14 traces 04 copiados byte a byte para `spike-05/traces/originals/` (SHA256 ALL MATCH), originais em `reports/` intactos — `SPIKE_05_RESULTS.md §2`, verificado por tester (14/14 idênticos).
- **Branch/diffs:** branch `experiment/ted-opencode-runtime`; nenhum commit/push nesta tarefa. Working tree contém apenas o escopo do spike (harness `bootstrap/run-05l-turn.mjs` + testes `run-05l-turn.test.mjs`, `spike-05l-category-tool.test.mjs`, `spike-05/{fixtures,scripts,tests,traces}`, reports). Nada em `apps/`, `docs/` ou produção.
- **Catálogo efetivo (pré-inferência, relatado pelo executor — NÃO verificável no trace atual, que é dryrun):** 8 agents (incl. `ted`), 3 commands, 3 skills, 93 plugins, 1 provider (`opencode-go`), 30 modelos; `ted-finance` ativo; finance **EXACT-ONLY**: `list_accounts`, `list_categories`, `propose_expense` (facade 8 chaves, `facadeKeysMatch=true`).
- **Regressões executadas nesta sessão:** `bootstrap/run-05l-turn.test.mjs` **34/34 PASS** (8 dryrun-harness + 14 hardening units + 10 polling/trace + 2 snapshot-imutável HIGH, sem inferência); `bootstrap/spike-05l-category-tool.test.mjs` **6/6 PASS** (autoridade real). Herdado de `SPIKE_05_RESULTS.md §6` (sem reexecução total — suíte completa excedeu o timeout do harness nesta sessão): `spike-05-negatives` 19/19, `spike-02` 20/20, `spike-04l-extract` 7/7.
- **Contratos Pending V2 reaproveitados** (`SPIKE_05_RESULTS.md §4`, fonte `D:/projetos/pi-financeiro` somente leitura): propose 201/200 `existing:true`/409 `idempotency.conflict`; consulta `GET /v2/active` + `GET /v2/:id/outcome`; confirmação autenticada server-side; execução com attestation + TX1/TX2 + `withTedReceipt` fail-closed; `intentionId` host-derivado; recibo só em `succeeded`.
- **Bridge real:** `bootstrap/finance-bridge.ts` (`runPropose` contra Pending V2 real via transporte allowlisted `bootstrap/finance-transport.mjs`: `ALLOWED_PATHS` + propose, GET reads / POST propose, gate de body/idempotencyKey). R1/R2/R3 vão contra o Pending V2 real via bridge STDIO — não contra o double. O store do `spike-05/scripts/confirm-cli.mjs` é **TEST-DOUBLE NÃO-AUTORITATIVO** explícito (só UX).

---

## §2 — Categoria (`list_categories` mínima, autoridade real)

- **GET `/categories` legível GET-only; prefixos e POST barrados pré-spawn** (allowlist exata do transporte; `spike-05l-category-tool.test.mjs`: rota 6/6).
- **`CATEGORY_FOOD_A` válida:** `list_categories({kind:"expense"})` retornou `Mercado` id `22222222-2222-4222-8222-222222222221` (household `00000000-0000-4000-8000-00000000000a`, `kind expense`, `status active`) — e foi **esse** id que o `propose_expense` usou (nunca inventado). Segunda categoria listada: `Aluguel` `…222222`.
- **kind inválida → 400 `validation.error` da autoridade real**, sem dado fabricado.
- **Outro workspace → negação da autoridade real + isolamento A/B disjunto** (sem vazamento entre identidades).
- Sem expansão além de `list_categories`: nenhuma categoria criada/alterada; nenhuma outra ferramenta de leitura adicionada.

---

## §3 — Cenário congelado

- **Mensagem exata (única, 1 prompt):** `"TED, gastei 35 reais no mercado ontem, pelo Nubank."`
- **Fixture:** `spike-05/fixtures/synthetic-case-35-mercado.json` (`caseId S05-35-mercado-nubank-ontem`): Nubank `11111111-1111-4111-8111-111111111112`, Mercado `22222222-2222-4222-8222-222222222221`, household `00000000-0000-4000-8000-00000000000a`, `amountCents 3500`, `dateRule YESTERDAY_DYNAMIC_UTC` (nunca data congelada).
- **Date-base:** `2026-10-31` (UTC) → ontem `2026-10-30`; avaliação em `America/Sao_Paulo` com divergência documentada de ±1 dia perto da meia-noite (trace `dates.tzNote`; nunca congelar data absoluta).

---

## §4 — Inferência (1 cenário, 1 modelo, teto consumido)

- **Modelo:** `opencode-go/deepseek-v4.1-flash`, pinado único — `modelFallback: "none (single pinned model; no fallback, no retry)"`.
- **Orçamento:** 1 cenário × 1 modelo, `sessionPromptCount=1`, `MAX_INTERNAL_STEPS=4` (best-effort pós-observação, não preemptivo — sem sinal confiável pré-execução em 2.2.4), deadline 90s + margens operacionais ≤5s; **sem retry, sem fallback, sem admin**.
- **Teto operacional US$5: 2 turnos live executados, custo exposto US$0/US$0.** Primeiro turno alegado pelo executor (sem trace); segundo turno verificado no snapshot (`session.usage.updated` + 3× `session.step.ended`, todos `cost:0`). Sem nova inferência após o segundo turno live.
- **Sem `provider.no-route` (segundo turno: VERIFICADO no snapshot — `promptError:null`, `promptTimeout:null`, `deadlineInterrupt:null`, `abortInterrupt:null`, `enforcementFailures:[]`, `session.execution.succeeded`).** Primeiro turno segue alegado pelo executor.
- **Tokens/custo (segundo turno, verificados no snapshot):** cumulativo `input 5307 / output 304 / reasoning 108`, `cost 0` em todos os steps — listagem `in 4047/out 81/reasoning 61`, propose `in 602/out 123/reasoning 47`, resposta `in 658/out 100/reasoning 0`. (Primeiro turno: `in 9396/out 312/reasoning 173` relatados pelo executor, sem trace.) **Limitação honesta:** `0` é o valor exposto (`session.usage.updated` + `session.step.ended`), não garantia de faturamento; controle real da campanha foi por contagem (1/1), não por cobrança. Tokens/custo só são registrados quando o SDK os expõe — nunca se alega zero como prova de custo.

---

## §5 — Prompt-loop (propose live do segundo turno — VERIFICADO no snapshot imutável)

> Todo o §5 descreve fatos **verificados no snapshot** `SPIKE_05L_TRACE_live_2026-10-31T15-48-43-100Z.json` (`mode:"live"`, `messageCount:7`, 44 eventos, `session.execution.succeeded`). O snapshot não expõe `proposalId` em campo top-level — a identidade da proposta é citada apenas via args observados validados por B04 (o id interno existe só dentro do payload do evento `session.tool.success`, não como campo auditável do trace).

- **Seleção (verificada — `toolCalls` 3× `completed` via `codemode-metadata`):** o modelo listou contas+categorias em paralelo (`list_accounts {includeInactive:"false"}` + `list_categories {kind:"expense"}`) e selecionou `propose_expense` — **nenhuma ferramenta estrangeira** (B02: só `list_accounts`/`list_categories`/`propose_expense`, todas `completed`).
- **Args corretos, host-bound (observados no snapshot, `toolCalls[propose_expense].args`):** `{amountCents:3500, description:"Mercado", date:"2026-10-30", accountId:"…1112" (Nubank), categoryId:"…2221" (Mercado)}`. Identidade/workspace/token/intention injetados pelo host (nunca via args LLM; `FORBIDDEN_KEYS` + `validateToolArgs`).
- **Proposta pending (verificada via B04 + args observados):** B04 `pass` ("propose observed x3500 account+category resolved", data `2026-10-30` = UTC-yesterday, divergência SP documentada); resposta grounded (tabela Mercado, R$ 35,00, 30/10/2026 ontem, Nubank, Mercado) registrada no `messageExcerpt` + "ainda **não executada** … precisa da sua confirmação" + expiração em 30 minutos — sem afirmação de efeito. Latência `elapsedMs 23242` (~23,2s) e sessão `ses_e6d5a2719ffe2HhlNpi30qJKTw` **constam do snapshot**. (Identificadores do primeiro turno — proposta `66635d44`, `elapsedMs 24867`, sessão `ses_e6d6e30f…` — seguem alegação do executor, sem trace.)
- **Resposta grounded (verificada no `messageExcerpt`):** tabela (Mercado, R$ 35,00, 30/10/2026 ontem, Nubank, Mercado) + "ainda **não executada** … precisa da sua confirmação" + expiração — sem afirmação de efeito.
- **Recibo:** nenhum recibo da proposta live — corretamente **não-executada** (gate propose-only: confirm/cancel/execute não expostos; nenhuma auto-confirmação).

---

## §6 — Confirmação sintética (operador, não modelo)

- **CLI:** `spike-05/scripts/confirm-cli.mjs --action confirm`, identidade do owner verificada (`confirm-cli --action confirm owner verificado`).
- **"sim" textual recusado:** `--text`/posicional recusado exit 2 (`freeTextSim 2`, `textFlag 2`, `noAction 2`); intruso exit 3; workspace divergente exit 3.
- **Efeito:** ledger sintético `confirmed 1 / untouched 0`; recibo `{operationId:"s05-prop-001", entityId:"synth-tx-s05-prop-001", amountCents:3500}` — **recibo do double sintético S05, NÃO de nenhuma proposta live** (primeiro turno `66635d44` ou segundo turno do snapshot). Nenhum recibo de proposta live foi nem será inventado: nenhuma proposta live teve confirmação cross-process.
- **Distinção modelo × operador** (trace `distinction`): chamadas do modelo = live propose (`list_accounts`/`list_categories`/`propose_expense`); ações do operador sintético = `confirm-cli --action confirm`. A confirmação não prova decisão do modelo — prova o mecanismo determinístico.

---

## §7 — Idempotência (mesma-instância provada; distribuída NÃO alegada)

- **R1:** replay mesma chave+payload → `200 existing:true`, mesmo id (mesma instância).
- **R2:** mesma chave, payload divergente → `409 idempotency.conflict` (mesma instância).
- **R3 (limite provado):** mesma chave em 2 processos → 2×201, ids distintos (`7713897c-93b8-4503-80e6-f311b39f730c` × `608120a1-c53e-439e-b23f-4239c389ad20`); one-shot **não persiste cross-processo**.
- **2 despesas legítimas:** `s05-prop-001` × `s05-prop-002`, ids distintos, `replaySameIntentionSameId:true` (replay da mesma intenção reusa o mesmo id).
- **Negativos 19/19 pass** (16 UX double-only + 3 autoridade real R1/R2/R3).
- **`NOT_PROVEN_CROSS_PROCESS`:** a proposta live `66635d44` pertence a um processo one-shot encerrado e **não foi confirmada cross-process**. Idempotência distribuída **não declarada**; sem persistência cross-process, sem alegação de garantia além da mesma instância.

---

## §8 — Segurança

- **Catálogo efetivo:** allowlist-only observada; nenhuma ferramenta admin invocada; nenhum retry executado (B06).
- **Identidade server-side:** `authenticatedContext` no Pending V2; bindings host-derivados (`dev-device-1`, workspace `…000a`); sessão A-only, sem dado de identidade B em mensagens/eventos (B05).
- **Sem credencial exposta:** `OPENCODE_GO` injetada só no processo isolado como `OPENCODE_API_KEY`; só `keyLength` logado, sem valor; traces sem segredos.
- **Sem escrita prévia:** proposta é o único efeito; `executionAttemptCount:0`; não-confirmada = 0 lançamentos (critério principal S05).
- **Sem outro ator / sem prod:** conta/categoria/workspace sintéticos; nenhum Postgres real, container, PWA real, Cloudflare ou produção tocados; `--origin` loopback-only + `redirect:'manual'`.

---

## §9 — Evidências (traces, latências, limites do que se afirma)

- **Traces preservados:** `reports/SPIKE_05L_TRACE_live_2026-10-31T15-48-43-100Z.json` (**snapshot live imutável do segundo turno**: `mode:"live"`, `at 2026-10-31T15:48:43.100Z`, `sessionPromptCalled:true`, `sessionPromptCount:1`, sessão `ses_e6d5a2719ffe2HhlNpi30qJKTw`, `messageCount:7`, 44 eventos, `session.execution.succeeded`, `elapsedMs 23242`); `reports/SPIKE_05L_TRACE.json` (**dryrun atual**, `at 2026-10-31T15:34:51.134Z`, `sessionPromptCalled:false`) e `spike-05/traces/SPIKE_05L_CONFIRM_TRACE.json` (`at 2026-10-31T15:30:17.610Z`); originais 04 preservados em `spike-05/traces/originals/`. Valores do **primeiro** turno (`elapsedMs 24867` ≈ 24,9s, sessão `ses_e6d6e30f…`, proposta `66635d44`) seguem citação do executor, sem artefato.
- **B01–B08: 8× pass VERIFICADOS no snapshot do segundo turno** (campo top-level `verdict`: B01 superfície pré-inferência ok; B02 seleção finance-only sem ferramentas estrangeiras; B03 executor host-bound sem erro; B04 propose x3500 conta+categoria resolvidas; B05 A-only; B06 allowlist-only sem retry; B07 evidência grounded; B08 `steps=0 eventTools=29 budget=4 latencyMs=23241` best-effort). O trace dryrun atual prova B01/B03/B04/B05/B07 apenas do dryrun.
- **Limites registrados:** pré-execução total não-enforçável no wrapper `execute` 2.2.4 (hook vê `{code}`, alvo resolve pós-execução; mitigação = config denies + facade sem shell/prompt + abort + propose-only); contagem de steps honesta (assistant/agent contam, user não); custo `0` = valor exposto, não prova de faturamento.
- **O que este relatório NÃO afirma:** confirmação live durável; idempotência distribuída; custo faturado; comportamento cross-process do one-shot.

---

## §10 — Encerramento e veredito

**Veredito: `SPIKE_05_PARTIAL`.**

- **Funciona (live VERIFICADO, segundo turno — snapshot imutável):** prompt-loop `session.prompt → modelo opencode-go/deepseek-v4.1-flash → list_accounts/list_categories → propose_expense(3500/Nubank/Mercado/2026-10-30)` com args observados validados por B04, B01–B08 `pass` no campo `verdict`, sessão `ses_e6d5a2719…`, latência `23242ms`, custo exposto `0` (teto operacional US$5, 2 turnos) — **fatos do snapshot `SPIKE_05L_TRACE_live_2026-10-31T15-48-43-100Z.json`, auditáveis independentemente**. (Primeiro turno — proposta `66635d44`, `24867ms` — segue evidência indireta do executor.) A preservação do primeiro latest falhou (dryrun sobrescreveu); o harness agora escreve snapshots timestamped imutáveis (`run-05l-turn.mjs: traceTimestampedPath/writeTraceFiles` + testes).
- **Funciona (sintético, determinístico):** confirmação explícita + recibo + R1/R2 mesma-instância + R3 limite + 19/19 negativos (herdado S05 + reconfirmado nesta sessão via 34/34 + 6/6).
- **Incompleto (bloqueia PASS):** a proposta live **não teve confirmação durável cross-process** — o processo one-shot encerrou; `NOT_PROVEN_CROSS_PROCESS`. Declarar PASS exigiria: Pending V2 durável (`ted-local`/Postgres) + confirmação da proposta live (ou de nova proposta live) com recibo canônico + replay cross-process.
- **NÃO é `BLOCKED_PROVIDER`:** o provider funcionou (inferência completa — 23,2s verificados no snapshot do segundo turno + 24,9s alegados do primeiro — sem `no-route`).
- **Revisão independente:** tester PASS (determinístico + 34/34 + 6/6; live = pendente-explícito-na-época, agora executado neste 05L mas sem trace preservado — ver caveat no topo); reviewers com `CHANGES_REQUIRED` endereçados (double marcado não-autoritativo, R1/R2 mesma-instância + R3-limite, cancel HTTP rejeitado, `--origin` loopback-only) e `APPROVED`s parciais subsequentes; residuais **MEDIUM** documentados (pré-execução total não-enforçável em 2.2.4; polling/step-budget best-effort; `cost 0` exposto ≠ faturado) — nenhum bloqueia o parcial, todos bloqueiam o full.
- **Próxima decisão — NÃO iniciar SPIKE 06.** Follow-up obrigatório antes de qualquer novo spike: API sintética durável (`ted-local`/Postgres) + re-propose/confirm live com recibo + R1/R2 cross-process. **Se PASS futuro:** síntese A0/A1/B (arquitetura efetiva, contratos Pending V2, bridge/host-bound) como base de handoff — somente após recibo live durável.
