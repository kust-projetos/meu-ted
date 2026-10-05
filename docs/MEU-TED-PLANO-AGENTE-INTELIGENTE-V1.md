# Meu TED — PLAN: agente inteligente V1 (refinamento)

**Status:** plano executável derivado da [SPEC V1](MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md) §2.1 (baseline por inspeção estática). Nenhuma tarefa foi executada; nenhuma autorização de produção, deploy, migration, canary ou alteração de flag é concedida aqui.
**Data:** 2026-10-03 · **Baseline:** `ec088ab9caf158db22f7e487b7c82143cf693842` + working tree preexistente (`AGENTS.md`, `.github/workflows/release-b-reminder.yml`, `docs/reports/2026-10-03-vps-migration-contabo.md`).
**Sem greens declarados:** nenhuma suíte foi executada para produzir este documento. `Inspeção não é teste verde` (SPEC §2.1).

## 1. Como executar

TDD obrigatório (AGENTS.md regra 1): **nenhuma tarefa de código começa sem teste RED que falhe**.

**Uma tarefa não é obrigatoriamente um PR.** Prefira fatias pequenas e independentes; uma tarefa pode abrir vários PRs. **Separe ownership de arquivos compartilhados** (`conversation-orchestrator.ts`, `finance-chat-agent.ts`, `capabilities.ts`, `analytics.ts`, `store.ts`) para evitar escrita concorrente. **Review e tester são obrigatórios em qualquer mudança significativa** — não apenas nas marcadas 🔴; a marcação 🔴 só indica risco financeiro/segurança que exige, além disso, revisor com foco em adversarial.

## 2. Base canônica já aceita (não reabrir aqui)

Vigentes por ADR e SPEC — este plano apenas os preserva:

| ID | Base aceita | Efeito no plano |
| --- | --- | --- |
| C1 | ADR-014: CAS, `proposing` congelado, TTL e handoff 0-ou-1 | A07 propõe metadados/revisão aditivos, sem atribuí-los ao contrato antigo |
| C2 | ADR-021: PendingOperation V2 só `expense`/`income`; undo é serviço separado | Nenhuma tarefa religa V1/undo ao modelo (AC29) |
| C3 | ADR-026 / V5: elegibilidade por risco já aprovada | Não ampliar elegibilidade; V5 segue `shadow` em produção |
| C4 | Autoridade, binding, idempotência, receipt e isolamento já exigidos pelo projeto | INV-01..INV-12 da SPEC explicitam sua aplicação à proposta; não aprovam capacidades novas |

## 3. Recomendações deste plano (sujeitas a aceite; não são aprovação)

| ID | Recomendação | Sujeito a |
| --- | --- | --- |
| P1 | Falar de "snapshot validado" como contrato novo para a mensagem de sucesso, separado de `renderMutationResult` | Aceite do Planner |
| P2 | Guard textual ampliado como **defesa adicional**, nunca mecanismo único de garantia | Aceite |
| P3 | Capability de anexo por tipo (hoje o gate liga os três de uma vez) | Aceite + G05 |
| P4 | Evolução do `MutationDraft` com `goalId` reaproveitando identidade existente | Aceite + G01/G02 |

> O título não é "decisões fechadas": nada aqui foi aprovado por operador. G01–G08 (SPEC §11) permanecem abertos e bloqueiam apenas as fatias que os listam.

## 4. Estado verificado (inspeção estática, lida nesta sessão)

| ID | Âncora real | Fato |
| --- | --- | --- |
| V1 | `apps/agent/src/mutations/entity-resolver.ts:156` | `parsed.categoryQuery ?? parsed.description` mistura descrição com consulta de categoria |
| V2 | `apps/agent/src/orchestration/conversation-orchestrator.ts:1319` | Único caminho de sucesso que **não** usa `renderMutationResult`: monta a frase com `parsed.amountCents`/`parsed.description` (payload proposto) e inclui `executed.receipt` |
| V3 | `apps/agent/src/responses/deterministic-responses.ts:48-64` | `MutationOutcome = proposed\|succeeded\|failed\|cancelled\|expired`; `succeeded` → texto fixo |
| V4 | `apps/agent/src/evidence/evidence-envelope.ts:1-9,57-60` | `ok\|empty\|error` sem `reason`; `serializeEvidenceForPrompt` serializa **apenas** `ok` |
| V5 | `apps/agent/src/orchestration/financial-claim-guard.ts:1-45` | Heurística estreita; header declara que turnos de mutação nunca são interceptados; aplicado só em `mode === 'unsupported'` (`conversation-orchestrator.ts:1419`) |
| V6 | `apps/agent/src/agent-config/tools.ts:269` | `webFetchUrl(url, { fetchImpl: ctx.fetchImpl })` — **não passa `lookup`** |
| V7 | `apps/agent/src/security/ssrf-guard.ts:25,205,223` | `HostResolver` sempre injetado; sem imports de runtime |
| V8 | `apps/agent/src/security/ssrf-guard.ts:235-237` | `const raw = await res.text()` lê o **corpo inteiro** e só depois trunca (`raw.slice(0, maxChars)`) |
| V9 | `apps/pwa/src/lib/capabilities.ts:59-66` | `NEXT_PUBLIC_TED_ATTACHMENT_INGESTION === "1"` liga `image`/`pdf`/`audio` juntos; default `false` |
| V10 | `apps/pwa/src/lib/api/agent-client.ts:280,294,470` | Anexos trafegam como `{type,url,name}`; sem binário |
| V11 | `apps/agent/src/privacy/dlp.ts:25,149,162` | `REDACTED`, `ScrubAttachmentsResult`, `scrubAttachments` |
| V12 | `apps/api/src/analytics/types.ts:12,23-28,34` | `period = last30days\|lastMonth\|thisYear\|custom`; `custom` exige `from`/`to`; `from` não pode ser após `to`; `AnalyticsRange = {from,to}` |
| V13 | `apps/api/src/routes/analytics.ts:56,127,150,172,200,219` | 6 rotas (`kpis`, `cashflow-series`, `category-breakdown`, `budget-consumption`, `daily-heatmap`, `net-worth-history`); `resolveRange` de `analytics/compute.ts`; escopo por `analytics/source.ts:scopeFromQuery`. **Sem `yearMonth` público**; `from`/`to` são silenciosamente ignorados sem `period=custom` |
| V14 | `apps/agent/src/agent-config/memory/store.ts:300,309` | Recall inclui compartilhadas de workspace: `item.actor === input.actor \|\| (includeShared && item.actor === '')` |
| V15 | `apps/agent/src/agent-config/memory/store.ts:266,316,318,322` | `isCurrentFinancialState` já filtra estado financeiro atual; decay `Math.exp(-ageDays/180)`; `MEMORY_BUDGET_CHARS = 1200`; `scored.slice(0, limit)` |
| V16 | `apps/agent/src/agent-config/memory/learn.ts:16,80` | `LEARN_EVERY_TURNS = 5` |
| V17 | `apps/agent/src/agent-config/select-skill.ts:13,40,52` | `SKILL_BUDGET_CHARS = 6000`; seleção por keyword; sem store de user/candidate skills |
| V18 | `apps/agent/src/finance-chat-agent.ts:902-903` | `input.text.slice(0, 15_000)` e `cognition.system.slice(0, 7_900)` — **truncamentos antes de `estimateTokens`**, não budgets de prompt |
| V19 | `apps/agent/src/finance-chat-agent.ts:1168,1405`, `:466` | `stopWhen: stepCountIs(5)` nos dois caminhos; janela 20 req/60s |
| V20 | `apps/agent/src/safety/usage-policy.ts:26,31` (comentário `:21`) | `maxInputTokens: 2000`; `actorDailyBudget: 200_000`; 400k por workspace |
| V21 | `apps/agent/src/orchestration/turn-plan.ts:39` | `correctionCount` inteiro `0..1` |
| V22 | `apps/agent/src/mutations/mutation-draft.ts` (`DEFAULT_DRAFT_TTL_MS = 15 min`), `mutation-proposal.ts:9` (30 min) | TTLs vigentes; `conversationId` já existe como opcional no binding |
| V23 | `scripts/lint-docs.mjs:8,29,60,63-95` | `lintMarkdownDocument` retorna **array**; `lintAllDocumentation` itera lista fixa de 12; CLI só faz `exit(1)` quando executado diretamente |
| V24 | `.husky/pre-commit` | 7 gates: `docs:lint`, `action-pins:check`, `test:skip-gate`, `capabilities:check`, `write-policy:check`, `governance:check`, `public-safety --strict` |

### 4.1 Ferramentas e comandos

- **Lint dos 3 docs novos** — `docs:lint` **não** os cobre (V23). Comando sob demanda, com saída e código de retorno corretos:
  ```bash
  node -e "const p=['docs/MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md','docs/MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md','docs/reports/2026-10-03-ted-agente-inteligente-autoreview.md'];import('./scripts/lint-docs.mjs').then(m=>{const issues=p.flatMap(f=>m.lintMarkdownDocument(f));for(const i of issues)console.error(' -',i);console.log('checked',p.length,'issues',issues.length);process.exit(issues.length?1:0)})"
  ```
  (`flatMap` porque `lintMarkdownDocument` retorna array.)
- **Testes direcionados** — use `exec`, sem `--` (o wrapper geraria ambiguidade):
  `pnpm --filter pi-finance-agent exec vitest run tests/orchestration` · `... tests/security` · `... tests/evidence`
  · `pnpm --filter pwa exec vitest run src/features/ted` · `pnpm --filter meu-ted-api exec vitest run tests`
- **Gates pesados (AGENTS.md regra 5):** `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm docs:lint`, `pnpm governance:check`.
- **Hook (V24):** `docs:lint`, `action-pins:check`, `test:skip-gate`, `capabilities:check`, `write-policy:check`, `governance:check`, `public-safety --strict`. `typecheck`/`test`/`lint` continuam obrigatórios pela regra 5, mas não integram o hook rápido. `architecture:check` e `boundary:check` são adicionais.
- **`pnpm test:e2e` = `pnpm --filter pwa test` (raiz): suíte unitária, NÃO E2E de navegador.** E2E real exige o Playwright de `apps/pwa/e2e/`. Nenhuma fatia pode alegar "E2E verde" pelo script da raiz.

## 5. DAG e dependências

```text
A00 → A01, A02, A03, A04-base, A05, A10, A11, A17, A09-spike
A03 + A10 → A06 → A07
A03 + A06 → A08
A09-spike + A04-base + A08 → A09-integração
A10 + A11 → A12
A10 + G05 → A13 → A14 e A15 (integração de drafts exige A07)
A10 + G04 → A16
A17 → A18
Cada fatia implementada → A19 daquela fatia
```

| Tarefa | Depende de | Gate |
| --- | --- | --- |
| A00 | — | — |
| A01, A02, A03, A04(base), A05, A10 | A00 | — |
| A06 | A03, A10 | — |
| A07 | A06 | G01, G02 |
| A08 | A03, A06 (+ aliases só se A17 já existir) | — |
| A09 spike | A00; resolver leitura em `analytics/source.ts`+`compute.ts` | Produz evidência para G03; não exige a decisão antes de investigar |
| A09 integração | A04, A08 | G03 |
| A11 | A00, independente de NLU | — |
| A12 | A10, A11 | — |
| A13 | A00, A10 | G05 |
| A14, A15 | A13 | G05 (paralelas; PDF scan em subfatias) |
| A16 | A10 | G04 (independe de multimodal) |
| A17 | A00 | G06 |
| A18 | A17 | — |
| A19 | cada fatia faz **seu** rollout | — |

**P0 não é bloqueado por gates de serviço externo.** G04/G05/G06 bloqueiam apenas A13–A18.

## 6. Fatias

Roteiro: **RED** (falha observável) → **GREEN** → **Gates** → **Review/Tester**.

### A00 — Baseline e linha de comando
- **Entrega:** inventário executável dos budgets reais (V18–V21): note que 7.900/15.000 são `slice` de entrada, e que a baseline R10 é *5 steps de modelo, ≤2 chamadas fast-path, `correctionCount` 0–1, 1 retry de grounding, ≤2 pernas de relay — eixos diferentes*. Rodar o lint sob demanda (§4.1) e registrar quais documentos ele cobre.
- Registrar HEAD/dirty tree e reproduzir P0 sem alterar produção. Congelar as expectativas existentes, não impedir acréscimo de testes: reutilizar `apps/agent/evals/ted-v2-regression-matrix.json`, `evals/ted-v2-behavioral-suite.ts` e `tests/ted-v2-regression-evals.test.ts`. Mapear AC01–AC30 a fixtures sintéticas/consentidas; não duplicar o harness.
- Medir baseline de qualidade, chamadas, P50/P95 e custo por turno com configuração/dataset registrados. Medições de provider real são opt-in com autorização/budget próprios; sem elas, rotular custo/latência como pendentes, não estimar um resultado verde. `evals/ted-v3-real-model-suite.ts` depende de `TED_REAL_MODEL_EVAL=1` e credenciais aprovadas; não executar automaticamente.
- **Aceite:** números citados separados por eixo; nenhuma suíte declarada verde sem execução.

### A01 — Prova de resultado e guard determinístico nos **dois** canais (R01) 🔴
- **Ponto:** V2 (`conversation-orchestrator.ts:1319`) e V5 (guard).
- **Characterization primeiro — NÃO afirmar bug.** O schema de receipt **não carrega montantes**; portanto um teste "receipt com amount normalizado diferente" é inválido. O que se prova: qual origem (snapshot validado vs `parsed.*`) alimenta cada token da frase, e se existe **contraexemplo real** onde os dois divergem. Sem contraexemplo, a tarefa fecha como teste de caracterização + garantia determinística (que já existe em parte via `renderMutationResult`), sem mudança de código.
- **RED:** (a) canal de escrita usa render determinístico para `succeeded`; (b) claim de leitura ("registrei", "está lançado") sem prova → resposta neutra, incluindo perífrase/sinônimo/múltiplas ações/sucesso antigo citado como atual; (c) receipt de outra operação/entidade/escopo → fail-closed, **sem** reconciliação financeira; (d) escrita cuja resposta se perde reconcilia pela **mesma** chave (INV-06). Undo não fabrica receipt V2.
- **GREEN:** Guard permanece defesa adicional; a garantia é receipt + evidence. Undo segue serviço separado.
- **Aceite:** AC01, AC02, AC03, AC04. **Testes:** `tests/orchestration/autoexecute-fast-path.test.ts`, `unsupported-financial-claim-guard.test.ts`, `financial-grounding-fail-closed.test.ts`, `tests/t2-1-conversation-orchestrator.test.ts`.

### A02 — Identidade de mensagem (R02) 🔴
- **Método obrigatório: reproduzir primeiro.** Relato de "mensagem que some" é **hipótese** (SPEC §2.1). Escrever teste de caracterização (retry, redelivery, truncamento/paginação de histórico, troca de workspace/logout no meio do request) e só então classificar o que for provado. Se a deduplicação estiver íntegra, fecha como evidência + teste de regressão.
- **RED:** AC05 (um balão por `messageId`, dedup server-side, sem desaparecimento silencioso), AC06 (dois textos iguais com IDs distintos = duas mensagens; **nunca** dedup por texto), AC07 (resultado tardio não entra no escopo novo).
- **GREEN:** reaproveitar `messageId`/`intentionId` já existentes (`agent-client.ts:448,470`; `conversation-orchestrator.ts:160`); **não** criar ID paralelo.
- **Testes:** `tests/orchestration/turn-idempotency.test.ts`, `tests/intention-ledger.test.ts`, `src/features/ted/__tests__/TedChat.optimistic.test.tsx`.

### A03 — Descrição não é categoria (R03) 🔴
- **Ponto real:** V1 (`entity-resolver.ts:156`).
- **RED:** "gastei 50 de carne" → 5.000 centavos, descrição `carne`, e categoria **real do workspace ou esclarecimento**. Prova: quando existe categoria cujo nome é literalmente "carne" no catálogo daquele workspace, esse match **legítimo continua válido** (A08) — o que se proíbe é o **fallback obrigatório de inferência automática**, não a entidade.
- **GREEN:** remover o `?? parsed.description` **somente** onde o teste demonstrar; preservar explicitação válida de categoria/subcategoria por UUID ou nome.
- **Aceite:** AC08. **Testes:** `tests/mutations/entity-resolver.test.ts`, `tests/orchestration/mutation-entity-resolution.test.ts`.

### A04 — Base de vazio, erro e evidência (R04)
- **Dois blocos.** (a) **Base, independente de A09:** eixos tipados — leitura (`workspace_empty`, `setup_incomplete`, `period_empty`, `category_empty`, `filter_empty`, `entity_not_found`), resolução (`found`/`ambiguous`), falha (`retryable_error`, `permanent_error`, `forbidden`, `unavailable`). `totalCents=0` com lançamentos ≠ "sem lançamentos"; erro em consulta necessária impede diagnóstico de vazio; filtro vazio nunca amplia período/categoria. Evidência: `reason` **sanitizado** para `empty`/`error` (sem vazar raw), e estado explícito de "sem evidência" em vez de `[]` ambíguo (V4) — preservando o teto de payload e o filtro técnico.
- (b) **Diagnóstico de vazio global depende de A09**: afirmação de "workspace vazio" exige snapshot consistente; consultas parciais não provam. Marcar como dependência, não travar A04 por isso.
- **Aceite:** AC09, AC10, AC04. **Testes:** `tests/evidence/evidence-envelope.test.ts`, `tests/orchestration/channel-evidence-isolation.test.ts`, `tests/responses/read-grounding-wiring.test.ts`.

### A05 — Markdown seguro (R05)
- **RED:** HTML bruto, `javascript:`/`data:`/`file:`, imagem remota/tracking e tabela longa renderizam inerte; link externo só `http`/`https`, com `rel="noopener noreferrer"`; mensagem do usuário é texto literal; estado de streaming não revela claim mutante antes da verificação.
- **GREEN:** renderer restrito em `apps/pwa/src/features/ted/TedMessage.tsx`; `TedMarkdown.tsx` é arquivo novo proposto, caso a separação seja útil. `react-markdown`+`remark-gfm` é opção de dependência a verificar e auditar; streaming sem claim antecipado, tabela com scroll, foco/hierarquia e emojis acompanhados por texto. Consultar os guias locais Next.js conforme `apps/pwa/AGENTS.md` antes de código.
- **Aceite:** AC11. **Testes:** `src/features/ted/__tests__/` (componente de render) + `tests/responses/tool-call-sanitizer.test.ts`.

### A06 — Interpretação semântica delimitada (R06)
- **RED:** AC12 (`gstei 50 d carne hj no nubnk` → 5.000 centavos + pistas hoje/Nubank, resolvendo conta/data, **sem autorização inferida**); AC13 ("uns 80", moeda não suportada, separador ambíguo, datas contraditórias, negação → esclarecimento, sem arredondar nem registrar).
- **GREEN:** interpretação validada por schema com proveniência por campo, consumida por `mutations/financial-parser.ts`, `orchestration/intent-router.ts` e `conversation-orchestrator.ts`; fallback semântico só quando trouxer valor demonstrável, sem pasta/motor universal novo. Data relativa do instante da mensagem + timezone autorizado; sem timezone, apresentar data explícita ou esclarecer. Confiança é advisory, sem limiar de autoexecução. Evals incluem abreviação, valor em palavras, informalidade e linguagem imperfeita, não apenas o exemplo AC12.
- **Aceite:** AC12, AC13. **Testes:** `tests/fast-paths/fast-paths.test.ts`, `tests/orchestration/intent-router.test.ts`, `tests/cognitive-skills.test.ts`.

### A07 — Metadados de goal no MutationDraft (R07) 🔴
- **RED:** AC14 (mesmo goal em "gastei 50" → "de carne" → "ontem" → conta, no máximo uma proposta/efeito), AC15 ("não, 500" corrige sem escrita precoce nem herança; nova intenção substitui; cancelar/expirar não efetua), AC16 (duas abas, `proposing` imutável, CAS/revisão/fingerprint).
- **GREEN:** `goalId` reaproveitando a identidade do draft; revisão, referências de mensagem e origem por campo. **Preservar TTL de 15 min do draft e o segundo check de 30 min da proposta** (V22). `consumed` não aceita patch retroativo. Debounce/probabilidade não são consentimento: fragmento monta draft/proposta e a confirmação vigente encerra. Verificar o preenchimento de `conversationId` no transporte antes de acrescentar identidade (gate G02).
- **Aceite:** AC14, AC15, AC16. **Testes:** `tests/orchestration/mutation-draft.test.ts`, `mutation-draft-sql.test.ts`, `tests/mutations/binding-manifest.test.ts`.

### A08 — Resolução de entidades (R08) 🔴
- **Ordem:** escolha explícita atual > alias confirmado no escopo > match determinístico > ranking semântico entre candidatos atuais > esclarecimento.
- **RED:** revalidar existência/atividade/workspace/tipo/uso permitido **imediatamente antes** de propor/executar; alias para ID removido/inativo/fora do escopo é invalidado e re-resolvido; categoria sugerida sem referência segura é **candidata**, não seleção; homônimo visível; conflict com escolha explícita pede decisão. Regressão do match legítimo de A03 (categoria "carne" real continua válida).
- **Aceite:** AC08, AC17. **Testes:** `tests/mutations/entity-resolver.test.ts`, `tests/orchestration/mutation-entity-resolution.test.ts`, `tests/workspace-alias.service-token.test.ts`.

### A09 — Analytics: SPIKE primeiro, implementação condicional (R09)
- **Não arbitrário:** A09 não bloqueia ingestão. Depende apenas de A00; a **integração** com o resto depende de A04/A08.
- **Spike (sem alterar código de produção):** (1) matriz pergunta × read model existente (`analytics/source.ts`, `compute.ts`, 6 rotas); (2) semântica financeira fechada por fixtures — competência vs. pagamento, status, soft-delete, estorno/undo, transferências, compra de cartão nunca somada com pagamento da mesma fatura, ancestrais sem duplicação, safe integers, dataset maior que uma página sem perder linhas; (3) `includeDescendants` com travessia limitada e ciclo tratado; (4) conclusão: reuso ou rota nova com a lacuna nomeada.
- **Prioridade de forma:** `period=custom` com `from`/`to` normalizados (V12 já valida `from`/`to` e `from <= to`) e serviço reutilizado. **`yearMonth` só se o spike provar lacuna** — nesse caso **patch da SPEC antes de nova API** (G03).
- O range atual da API é inclusivo. O intervalo normalizado de resposta proposto na SPEC termina de forma exclusiva: adaptar a fronteira no contrato/metadata e em fixtures sem trocar silenciosamente a semântica existente de `from`/`to` ou incluir o primeiro dia do mês seguinte.
- **Aceite:** AC18, AC19. Bloqueio: sem fixtures e sem conclusão, rota nova **não** é aberta.
- **Depois do gate:** teste RED da lacuna real em `apps/api/tests/`, implementação mínima em `apps/api/src/analytics/{source,compute,types}.ts`/`routes/analytics.ts`, integração de evidência no Agent. Novo endpoint/filtro exige schema/OpenAPI, capability de leitura e regeneração via `scripts/generate-agent-tools.mjs`; não editar `generated/http-tools.ts` manualmente. Testar PG canônico com dataset maior que uma página, hierarquia, cartões/undo e dois workspaces. Reservar migration apenas se realmente necessária, pelo runner do projeto e sem produção.

### A10 — Ledger de budgets, recovery e observabilidade (R10) — **fundacional**
- **Vem cedo por dependência:** A06, A12, A13 e A16 consomem o teto compartilhado.
- **RED:** teto único de turno; máx. **2 recuperações read-only de resolução contabilizando o retry de grounding existente**; repetição idêntica bloqueada por fingerprint (tipo/args/escopo/revisão); paradas seguras; 429 de uso **não** vira failover nem loop; 401 só pela recuperação autenticada já suportada; reservas conservadoras preservadas (não reduzir reserva em falha para aparentar economia). Registro de accounting **por eixo** (model steps, fast-path, grounding, relay legs) para provar que nada subiu.
- **GREEN:** integrar accounting/stop conditions em `conversation-orchestrator.ts`, `orchestration/turn-plan.ts`, `responses/grounded-response.ts`, `safety/usage-policy.ts` e failover vigente, sem segundo loop de tools. Reusar instrumentação por eixo, sem conteúdo bruto em telemetry; verificar se existe sink durável suficiente e definir retenção/cardinalidade antes de presumir persistência. G07 aprova SLO/custo antes de habilitar serviços.
- **Aceite:** AC20, AC30. **Testes:** `tests/llm-attempts.test.ts`, `llm-failover.test.ts`, `grounding-quota-propagation.test.ts`, `relay-broker-deadline.test.ts`, `tests/metrics/metrics.test.ts`, `tests/observability/`.

### A11 — Segurança web: DNS/egress e teto de leitura (R14 fundacional) 🔴
- **Ponto:** V6/V7/V8. Hoje `tools.ts:269` **não** passa `lookup`, então a proteção de IP resolvido não é exercida pelo caminho real — e o teste com resolver injetado não prova produção. Lookup **pré-resolvido não prova** proteção contra rebinding.
- **RED:** (a) destino efetivo do fetch controlado no Worker/egress, não apenas pré-resolução DNS; se isso não for comprovado, manter fetch arbitrário indisponível ou restringir a fontes allowlisted com garantia de egress equivalente — hostname/porta isolados não fecham o gate; (b) hardcap de leitura em stream — hoje `res.text()` (V8) carrega o corpo inteiro antes de truncar; (c) redirect revalidado a cada hop; (d) sem cookies/headers pessoais.
- **GREEN:** é a **Trilha 1**; A12 não começa antes.
- **Aceite:** AC24 (parcial: bloqueio SSRF), AC30. **Testes:** `tests/security/ssrf-guard.test.ts`, `tests/cognitive-web.test.ts`.

### A12 — Web research com evidência (R14)
- **Depende:** A10 (orçamento) + A11 (segurança).
- **RED:** envelope com query sanitizada, URL final validada, título/origem/`retrievedAt`, data de publicação quando disponível, trechos e associação claim→fonte; sem saldo/ID/conta/documento bruto na query externa; conteúdo externo nunca como instrução nem garantia; sem web → limitação declarada, nunca "atualização" inventada.
- **Aceite:** AC24. Sem novo crawler; budgets do teto compartilhado.

### A13 — Ingestão binária com identidade (R11) 🔴
- **Depende:** A00, A10 + **G05**. Integração com goals depende de A07.
- **Decisões antes de codar:** referência opaca server-side; **sem** URL pública do browser; **sem** base64 no DLP; **sem** caminho local; storage binário privado real (decisão de arquitetura); autorização por leitura; expiração/cleanup idempotente; raw fora de log/telemetria/memória.
- **RED:** AC21 — upload cruzado, MIME falso, oversized, expirado → rejeição fail-closed; reprocessar mesmo anexo/turno não cria segunda intenção nem segunda escrita; tetos de pixels/dimensões/tamanho descompactado/CPU do parser (o limite de bruto não impede decompression bomb); parsers não executam script nem seguem referência externa embutida.
- **GREEN:** definir contrato de upload/referência server-side após G05; rotas/storage novos são propostos, não existentes. Evoluir `apps/pwa/src/lib/capabilities.ts`, `lib/api/agent-client.ts`, `features/ted/TedChat.tsx`, gateway/`finance-chat-agent.ts` e `privacy/dlp.ts` de modo compatível. DLP continua sanitizando metadata/histórico, enquanto bytes seguem pipeline privado separado; não tentar fazê-los atravessar `scrubAttachments`. Capability por tipo reflete o backend (P3); enforcement no servidor; tipo indisponível não é anunciado pela PWA.
- **Aceite:** AC21, AC29.

### A14 — Áudio via Groq (R12)
- **Depende:** A13 + G05.
- **RED:** AC22 — arquivo real → conteúdo real; timeout do STT → estado de falha explícito + entrada textual preservada; número/negação mal transcritos → confirmação explícita de campos críticos. Áudio **nunca** vira autoexecução.
- **GREEN:** adapter STT novo proposto em `apps/agent/src/multimodal/groq-stt.ts`, se G05 confirmar este runtime; caso escolhido processamento pela API, ajustar a SPEC/paths antes de implementação. `GROQ_API_KEY`/modelo/timeout server-side; sem fallback para modelo que treine com dados financeiros; sem upload por URL pública; não inventar `confidence` que o provider não retorna. STT indisponível preserva o anexo/estado de falha apenas pela retenção aprovada.
- **Aceite:** AC22, AC30.

### A15 — Imagem e PDF (R13)
- **Depende:** A13 + G05; **paralela** a A14. PDF escaneado é **subfatia própria** (OCR/vision validado explicitamente).
- **RED:** AC23 — extração com proveniência por campo/página, `unknown`/`ambiguous` suportados; injeção via conteúdo do anexo sem efeito; múltiplos itens/páginas **não** viram bulk write; PDF grande pede redução, sem chunking ilimitado.
- **GREEN:** adapters de vision/extração PDF novos propostos em `apps/agent/src/multimodal/`, condicionados a viabilidade/CPU e G05; escolher parser/provider em spike bounded antes de dependência. Comprovante monta candidato/draft e exige confirmação manual; o que não existe é escrita a partir de anexo sem confirmação.
- **Aceite:** AC23.

### A16 — Jev opcional (R15)
- **Depende:** A10 + **G04**; independente de multimodal.
- **Estado:** não existe integração Jev no Worker. Harness local/stdio **não** é deploy no Worker e não prova remoto, modelo, preço ou privacidade. Egress do repo **não implica** que o judge deva entrar no catálogo `must registered llm`; se for integração separada, isso é **decisão explícita**, não inferência.
- **RED:** AC25 — timeout/401/malformado/escolha inexistente → fallback determinístico/esclarecimento, sem conceder permissão nem sucesso; circuit breaker por provider/configuração; nada de estado financeiro no judge; teto por chamada (sugerido 2 s, máx. 1 por turno) **medido em A10**, não herdado dos 30 s da origem.
- **GREEN:** `JudgmentProvider`/adapter em `apps/agent/src/judgment/` são módulos novos propostos, com só os métodos realmente usados, abstinência tipada e allowlist. Se seguir relay/API, cumprir `apps/api/src/agent/llm-config.ts`; integração MCP separada exige gate equivalente de egress/privacidade. Não copiar auth store/config ou instalar gateway sem decisão. Validar transporte remoto no SDK/versionamento real, não a ferramenta do harness.
- **Aceite:** AC25. Gate G04; se incompatível, Jev **permanece desligado**.

### A17 — Memória com proveniência (R16)
- **Depende:** A00 + **G06**.
- **Baseline real:** `source`, `confidence`, salience, `expires_at`, decay 180 d, opt-out/`agent_prefs` **já existem** (V14–V16). **Recall inclui compartilhadas de workspace (`actor=''`) por default** (`includeWorkspaceLevel !== false`) — não assumir isolamento estrito por ator; qualquer regra nova precisa considerar esse compartilhamento. Estado financeiro atual **já é filtrado** (V15).
- **RED:** AC26 — correção repetida não duplica alias em redelivery; esquecimento invalida derivados e o job de aprendizado (a cada 5 turnos) não ressuscita; ID de conta/categoria revalidado sempre; escopo explícito no contrato, incluindo a camada compartilhada. **Persistir correção não é regra permanente**: só há regra durável com consentimento explícito.
- **GREEN:** evolução do store; inferência comportamental permanece candidata; ai-memory (engenharia) não é banco de usuários.
- **Aceite:** AC26. **Testes:** `tests/memory-store.test.ts`, `memory-learn.test.ts`, `memory-v2/memory-v2-red.test.ts`, `tests/dlp-persistence.test.ts`.

### A18 — User skills e candidates (R17)
- **Depende:** A17.
- **Baseline real:** skills estáticas versionadas, seleção por keyword, budget 6000 chars (V17). **Não existe** store de user skills nem de candidate skills.
- **RED:** AC27 — regra pedindo tool/SQL/fetch/política é rejeitada no schema; core e capabilities intactos. AC28 — candidate que melhora média mas falha safety **não** é promovido; rollback restaura versão anterior.
- **GREEN:** regras declarativas restritas (alias merchant→categoria existente) reaproveitando representação existente; sem framework de plugins. Promoção exige replay **offline/somente leitura** + fixtures + evals congeladas + aprovação humana. Rotina periódica nunca promove core skills.
- **Aceite:** AC27, AC28. **Testes:** `tests/cognitive-skills.test.ts`, novo caso em `tests/memory-v2/`.

### A19 — Hardening, evals e rollout — **por fatia**
- **Cada fatia faz seu próprio rollout**; não esperar todos os opcionais. Sequência: (1) suíte do app + gates pesados; (2) Reviewer independente; (3) Tester; (4) E2E de navegador via Playwright de `apps/pwa/e2e/` (**não** `pnpm test:e2e` da raiz); (5) decisão de rollout da própria fatia com flag default-off.
- **Evals:** dataset versionado pt-BR, seed/config registradas; 100% em casos críticos (negação/escopo/valor incerto) sem escrita indevida; qualquer teste crítico falhando bloqueia independentemente da média; avaliador probabilístico não substitui oráculo determinístico de dinheiro/identidade/receipt.
- **Aceite:** matriz AC01–AC30 verde por fatia; AC29 sem ativação implícita de V5.

## 7. Matriz AC → tarefa (cobertura completa)

| AC | Tarefa | AC | Tarefa | AC | Tarefa |
| --- | --- | --- | --- | --- | --- |
| AC01 | A01, A04 | AC11 | A05 | AC21 | A13 |
| AC02 | A01 | AC12 | A06 | AC22 | A14 |
| AC03 | A01 | AC13 | A06 | AC23 | A15 |
| AC04 | A01, A04 | AC14 | A07 | AC24 | A11, A12 |
| AC05 | A02 | AC15 | A07 | AC25 | A16 |
| AC06 | A02 | AC16 | A07 | AC26 | A17 |
| AC07 | A02 | AC17 | A08 | AC27 | A18 |
| AC08 | A03, A08 | AC18 | A09 | AC28 | A18 |
| AC09 | A04, A09 | AC19 | A09 | AC29 | A13, A19 |
| AC10 | A04 | AC20 | A10 | AC30 | A10, A11, A14, A16, A19 |

## 8. Flags, rollback, gates

- Flags novas **default-off**, nome definido na fatia. Nenhuma ativa `TED_RISK_BASED_AUTOEXECUTE=on`, não toca bearer/Release B, não autoriza migrations nem deploy (INV-12).
- Rollback por fatia: desligar novas entradas/capacidades e restaurar release compatível; flags não apagam drafts/propostas/anexos/receipts nem suspendem reconciliação de operações em voo. Flag não desfaz escrita confirmada. Schemas DO/API só aditivos, com leitor compatível com registros anteriores e rollback testado (G08); simular restart/eviction e upgrade→downgrade local antes de release, sem downmigration destrutiva.
- Rollout futuro da API exige wrapper autoritativo na Contabo, backup verificado/rollback tag e manifest; migrations via runner explícito, nunca no boot. PWA/Agent seguem pipelines Cloudflare, com smokes/build SHA e decisão de produção própria. Este plano apenas descreve gates, não executa nem autoriza esses comandos. Não mudar `shadow`, Release B ou cutover como efeito colateral.
- Integração documental futura: o relatório de migração referenciado na SPEC é trabalho preexistente ainda não rastreado nesta baseline. Antes de um PR, verificar que todas as referências estarão presentes no checkout publicado; aguardar integração aprovada pelo owner ou escolher fonte versionada. Não incluir/commitar silenciosamente aquele relatório, `AGENTS.md` ou o workflow preexistente apenas para fazer links passarem.
- Gates repo por PR: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm docs:lint` + lint sob demanda (§4.1), `pnpm governance:check`. Hook = 7 gates (V24).
- **G01–G08 (SPEC §11) permanecem abertos.** Este plano não fecha nenhum. P0 (A01–A05) não depende de serviço externo.
- **Atualização 2026-10-04b:** G04, G05 e G06 foram formalmente resolvidos com condições (SPEC §11.2; [reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md](reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md)) — **A13–A18 desbloqueadas** para implementação com flags default-off; habilitação em produção continua rollout por fatia (A19). G01/G02/G07/G08 permanecem abertos.
- **Atualização 2026-10-05 (closure A19 final, issue #89):** os residuais estruturais da revisão independente foram fechados por TDD — caminho real de `/rpc/attachments` pelo Worker (identidade só da autenticação), tetos de corpo por rota (chat 2 MB; anexos derivados de `ATTACHMENT_LIMITS`, no Worker e no proxy da PWA), `body.text` exclusivamente o digitado (metadata só no array `attachments`), **veto estrutural de autoexecute por presença de anexo** (assinatura + todos os call sites + cliente elevado não construído), cleanup TTL retomável (cursor persistido no DO com wrap e fail-safe), **A17 conectada ao runtime** (learning com resposta real; forget com tombstone duplo — fingerprint E conteúdo — sem ressurreição pelo job), **A18 conectada ao runtime** (`userSkills` nos 2 call sites de `assembleCognition`, custo zero sem skills) e E2E pelo caminho real (Worker→DO→relay). Evals de provider real continuam pendentes de configuração (G07); E2E de navegador do fluxo de anexo segue follow-up. Relatório: [reports/2026-10-05-ted-agent-inteligente-a19-final-closure.md](reports/2026-10-05-ted-agent-inteligente-a19-final-closure.md).
- Review/Tester em **toda** mudança significativa; 🔴 exige revisor adversarial adicional.

## 9. Riscos

1. **A02 é hipótese, não diagnóstico** — sem RED que reproduza, não há mudança de código.
2. **A01 `:1319` não é bug confirmado** — receipt não carrega montantes; o plano exige characterization e contraexemplo real antes de qualquer alteração.
3. **V8 (corpo inteiro antes de truncar)** é achado de inspeção; o impacto real (corpo enorme) precisa de teste antes de dimensionar correção.
4. **Rebinding**: resolver pré-resolvido não prova proteção; o caminho de produção hoje não passa `lookup` (V6).
5. **Recall compartilhado (`actor=''`)** pode vazar preferência entre atores do mesmo workspace se regras novas não distinguirem escopo (V14).
6. **Números da origem não são evidência**; 7.900/15.000 são truncamentos de entrada confirmados (V18), não budgets.
7. **Tooling de lint tem lacuna real** (V23): enquanto `docs:lint` varrer 12 caminhos, lint dos documentos novos depende do comando sob demanda. Não há tarefa de mudar o tooling nesta entrega.
