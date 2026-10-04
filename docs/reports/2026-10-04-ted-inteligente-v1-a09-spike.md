# A09 — Analytics: spike de read model e fixtures de semântica financeira (2026-10-04)

**Status:** SPIKE CONCLUÍDO — Evidence-only. **Não autoriza** rota nova, patch de SPEC nem mudança de semântica.
**Data:** 2026-10-04
**Branch:** `feat/ted-agent-inteligente-v1-a11-web-security`
**Âncoras:** `docs/MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md` A09 (linhas 166-172); `docs/MEU-TED-SPEC-AGENTE-INTELIGENTE-V1.md` R09 (linhas 157-166)
**Fixture produzida:** `apps/api/tests/fixtures/analytics-semantics.fixture.json` (não importada por nenhum teste)
**Mudança em código de produção:** nenhuma.

## 1. Método e escopo

Leitura integral de `apps/api/src/analytics/types.ts`, `compute.ts`, `source.ts`, `apps/api/src/routes/analytics.ts`, do schema canônico em `apps/api/src/read-models/sql/` (V001, V004, V005, V009, V033, V045, V056) e dos caminhos de escrita em `apps/api/src/cards/postgres.ts`, `apps/api/src/writes/postgres.ts`, `apps/api/src/approvals/undo.ts`. Fixtures sintéticas com `expected` calculado à mão, sem wiring em teste.

## 2. Correção de fato antes da matriz

Duas âncoras do plano estão desatualizadas:

- **V13 diz "4 rotas"; existem 6.** `routes/analytics.ts:56,127,150,172` são só as 4 primeiras. As reais: `kpis`, `cashflow-series`, `category-breakdown`, `budget-consumption`, `daily-heatmap` (`:200`), `net-worth-history` (`:219`). Confirmado em `apps/api/src/routes/route-inventory.ts:64-69` e `routes/route-handlers.ts:52-57`.
- **Page size do repo é 200**, não a janela de filtro. `types/transactions.ts:23` (`limit` max 200, default 50); `analytics/source.ts:101-111` pagina por 200.

## 3. Semântica financeira vigente (extraída do código, não da SPEC)

| Eixo | Regra vigente | Âncora |
|---|---|---|
| **Competência vs pagamento** | Base única = `transactions.date`. Não existe `paid_at`, `due_date` nem `competence_date` em transação. Compra de cartão grava `date` = data da compra; pagamento de fatura grava `date` = data do pagamento. | `types/domain.ts:75-89`, `V001__init.sql:42-65`, `cards/postgres.ts:650` |
| **Status** | Transação **não tem status**. Toda linha em `transactions` é "lançada/confirmada" por construção. `pending` vive em `accounts_payable.status` e em `pending_operations`, e **nenhum read model de analytics os lê**. | `V005__payables.sql:15`, `apps/api/src/analytics/source.ts:195-212` |
| **Soft-delete** | `deleted_at IS NULL` em todos os agregados SQL; `deletedIds` no store in-memory. | `source.ts:200,220,236,251` |
| **Undo/estorno** | Reversão de transação = `softDeleteTransaction`. Não há entrada compensatória. "Estornado" e "nunca existiu" são indistinguíveis nas agregações. | `writes/postgres.ts:1027` |
| **Transferência** | `kind='transfer'` ignorado em `sumByKind`, `dailySums` e `categorySums`. Nunca vira despesa+receita. | `source.ts:198-210,216-222,237` |
| **Cartão vs fatura** | Compra = `expense` em `credit_card` com `statement_id`. Pagamento = `expense` em conta bancária com `statement_payment_id`. Analytics **não distingue os dois**. | `cards/postgres.ts:429-431,649-653`, `V056:24` |
| **Hierarquia** | Rollup de exatamente 1 nível (`cat.parentId ?? cat.id`), sem parâmetro. `transactions` tem `category_id` **e** `subcategory_id`; analytics lê **só** `category_id`. | `compute.ts:184`, `V045:36` |
| **Safe integers** | `SUM(...)::text` seguido de `Number()`. Acima de 2^53 o centavo se perde em silêncio. `amount_cents` é `BIGINT CHECK (> 0)`, sem teto. | `source.ts:208-210,242`, `read-models/postgres-store.ts:51`, `V001:47` |
| **Isolamento** | `household_id = $1` em todo agregado; `householdId` derivado do token no servidor. `analyticsBaseSchema` não aceita `workspaceId`/`householdId`. | `source.ts:200`, `routes/analytics.ts:42-46`, `types.ts:14-21` |

### 3.1 Duas armadilhas de contrato (não documentadas em lugar nenhum)

1. **`from`/`to` são silenciosamente ignorados se `period` for omitido.** `resolveRange` (`compute.ts:40-41`) cai em `last30days` e descarta `from`/`to`. Um Agent que envie só `from`/`to` responde a janela errada **sem erro**. O normalizador precisa sempre emitir `period=custom` junto.
2. **`daily-heatmap` ignora `period` e `from`.** Usa `parsed.data.to ?? today()` e janela fixa de 35 dias (`routes/analytics.ts:210-212`).

### 3.2 Nenhuma rota de analytics é tool do agente

`apps/api/openapi/agent-tools.openapi.json` não contém nenhuma entrada `/analytics/*`. Consequência para G03: **reuso não é trabalho zero** — ainda exige entrada `x-pi-tool`, regeneração por `scripts/generate-agent-tools.mjs` e capability. Precedente de read aggregation já existente: `/budgets/{budgetId}/trends`.

## 4. Entregável 1 — Matriz pergunta × read model

| # | Pergunta-alvo | Rota existente | Parâmetro | Veredito | Lacuna exata |
|---|---|---|---|---|---|
| Q1 | Total do mês por categoria, com descendentes | `GET /analytics/category-breakdown` | `period=custom&from=YYYY-MM-01&to=YYYY-MM-<último dia>&kind=expense` | **PARCIAL** | Total do mês responde. Faltam: filtro `categoryId`, `includeDescendants`, bucket de sem categoria, `transactionCount`, `asOf`/`basis`. Rollup cego em 1 nível; cap de 5 slices + "Outras"; categoria inativa vira rótulo "Outras" com ID real (`compute.ts:196`); `totalCents` diverge de `kpis.expenseCents` quando há `category_id IS NULL` (`source.ts:238`) |
| Q2 | Total por conta | `GET /analytics/kpis` + `cashflow-series` + `category-breakdown` + `net-worth-history` | `accountId=` | **SIM** | Nenhuma funcional. Ressalva: no dialeto canonical o escopo casa só `account_id` de origem, então o destino de uma transferência retorna 0 — e o legacy diverge (`source.ts:188`). Prod = canonical |
| Q3 | Comparação entre meses | `GET /analytics/kpis` | 2× `period=custom` | **SIM (com esforço)** | `previousPeriod` cobre só a janela imediatamente anterior de mesmo tamanho, não um mês escolhido. Não há série month-over-month de despesa nem de categoria |
| Q4 | Compra de cartão vs pagamento da mesma fatura | — | — | **NÃO** | Compra e pagamento são ambos `kind='expense'`; nenhum read model distingue competência de liquidação. Em janela larga a mesma fatura soma 2× (45.000 no fixture). **Lacuna G-A** |
| Q5 | Undo/estorno | `GET /analytics/kpis` | — | **PARCIAL** | O valor some corretamente, mas não há sinal de undo: `undoneCents` observável = 0. Estorno e delete produzem o mesmo agregado. **`transactionCount` ausente** impede separar "zero" de "sem lançamentos" (AXIS `period_empty` do A04) |
| Q6 | Soft-delete | todas | — | **SIM** | Nenhuma. `deleted_at IS NULL` em todos os agregados |
| Q7 | Dataset > 1 página | `createStoreAnalyticsSource` / `createSqlAnalyticsSource` | — | **SIM** | Nenhuma. Loop de 200 correto (`source.ts:101-111`); source SQL agrega no banco |

### 4.1 Campos exigidos por R09 linha 161 × o que existe

| Campo | Existe? | Nota |
|---|---|---|
| Período efetivo | parcial | `period` existe; `to` é **inclusivo** e o fim exclusivo não é declarado |
| `timezone`/`basis` | **não** | Base é `transactions.date`, implícita |
| `semanticsVersion` | **não** | — |
| `effectiveFilter` | **não** | — |
| `totalCents` inteiro | parcial | `number`; perde precisão acima de 2^53 |
| `transactionCount` | **não** | — |
| `asOf` | **não** | — |
| Motivo de vazio | **não** | — |
| Breakdown com IDs/rótulos reais | parcial | ID real; rótulo pode ser "Outras" para categoria inativa |

## 5. Replay mental das fixtures contra o read model atual

Este é o núcleo da evidência para G03.

| Caso | Resultado hoje | Por quê (âncora) |
|---|---|---|
| A — competência vs pagamento | **TOTAL CORRETO** (jan 71.000 em 6 linhas; macro `cat-food` 44.000) | `t.date` é a data da compra; o pagamento de 05/fev fica fora de janeiro. Falta só o envelope |
| B — status | **OK por exclusão implícita** | `accounts_payable` e `pending_operations` não são lidos. "Quanto está pendente" é **impossível** |
| C — soft-delete | **PASSA** | `deleted_at IS NULL` exclui 999.000 + 12.000 |
| D — undo | **TOTAIS OK, OPACO** | Reversão é soft-delete; nenhum sinal de undo |
| E — transferência | **PASSA** | `kind='transfer'` ignorado nos três agregados; nunca vira despesa+receita |
| F — cartão vs fatura | **FALHA** | Jan-Mar: `kpis.expenseCents` = 140.500 contra 95.500 por competência. Inflação de 45.000 (2 faturas). O breakdown escapa por acaso: os pagamentos têm `category_id IS NULL`, então ficam de fora do breakdown e contaminam só o `kpis`/`cashflow-series`/`daily-heatmap` |
| G — ancestrais | **PARCIAL** | 44.000 em 4 linhas, sem duplicação, correto até profundidade 2. Falta `categoryId`, falta `includeDescendants`, profundidade 3+ não atribui ao ancestral, cap 5, e a categoria inativa produz slice com `categoryId` real + nome "Outras" |
| G2 — ciclo | **SEM RISCO HOJE** | Não há travessia (lookup de 1 nível). Profundidade ≤ 2 e aciclicidade são garantidas **por código** (`writes/postgres.ts:913`, `parent_id` imutável em `:954-962`), **não por constraint no banco**. Travessia nova precisa de `visited` + teto |
| H — safe integers | **FALHA** | Junho: exato 10.000.000.000.000.001 (ímpar, entre 2^53 e 2^54) — *corrigido em G03: a soma é 4000000000000000+4000000000000000+2000000000000001 = 10000000000000001; o valor original deste relatório estava errado e o RED da implementação provou* → não representável; os dois doubles vizinhos erram 1 centavo. O PostgreSQL é exato; a perda é no `Number()`. `types.ts:95` declara `totalCents: number` |
| I — > 1 página | **PASSA** | 250 linhas → páginas [200, 50] → 281.375 exato. Borda de 200 linhas também passa |
| J — dois workspaces | **PASSA** | `household_id = $1`; hh-b (7.777/8.888) nunca aparece para hh-a |
| K — comparação de meses | **PASSA** | 71.000 vs 54.500 → −16.500 (−23,2%) via 2 chamadas |
| L — envelope | **FALHA** | 7 dos 9 campos de R09 ausentes; divergência breakdown vs kpis em fev (15.000 vs 54.500) |

## 6. Entregável 3 — Conclusão do spike

### 6.1 Reuso é suficiente para 5 das 7 perguntas

Q1 (parcial), Q2, Q3, Q6 e Q7 são respondidas por rotas existentes com `period=custom`, **sem API nova**. O ano-mês vira intervalo: `from=YYYY-MM-01`, `to=<último dia do mês>`. `yearMonth` não precisa existir como parâmetro.

### 6.2 Três lacunas NOMEADAS que o spike provou

- **G-A — competência vs liquidação de fatura.** Compra e pagamento da mesma fatura são o mesmo `kind='expense'`. Predicado candidato, **evidência apenas**: excluir `statement_payment_id IS NOT NULL` do agregado de despesa por competência remove os 45.000 de inflação sem esconder o pagamento da visão de caixa/fatura. Requer patch da SPEC antes de qualquer código.
- **G-B — integridade de `totalCents`.** `totalCents: number` acima de 2^53 perde centavos em silêncio. Ou o envelope carrega o inteiro exato, ou a API satura com motivo explícito. O domínio é `BIGINT` sem teto, então isso não é teórico.
- **G-C — envelope de prova.** `transactionCount`, `asOf`, `basis`, `semanticsVersion`, `effectiveFilter` e motivo de vazio não existem. Sem `transactionCount`, A04 não consegue distinguir `totalCents=0` com lançamentos de workspace sem evidência — e a SPEC exige que o envelope nunca converta timeout/403 em zero.

Secundária, sem número de gate: `categoryId` + `includeDescendants` + bucket de sem categoria + cap de 5 slices. Isso é **lacuna de filtro**, não de semântica — pode ser resolvido no read model novo sem patch de SPEC.

### 6.3 Fronteira inclusiva → exclusiva

O range da API é **inclusivo** (`date >= from AND date <= to`, `source.ts:201`). O intervalo normalizado da SPEC termina de forma **exclusiva**. Adapter proposto, sem trocar a semântica existente:

1. O Agent converte `yearMonth` em `from=YYYY-MM-01`, `to=<último dia>`.
2. O envelope declara `effectivePeriod { from, to, toExclusive: <primeiro dia do mês seguinte> }` mais `boundary: "inclusive"` e `basis: "competencia_transactions_date"`.
3. `toExclusive` é o **mesmo instante** que o fim inclusivo — não inclui o primeiro dia do mês seguinte.
4. Nenhum parâmetro novo na API; nenhum dia muda de lado.

### 6.4 Requisitos se e quando uma rota nova for aberta

Só depois de **G03** (decisão humana) e de patch da SPEC. Checklist derivado do repo:

1. Patch da SPEC antes da API (PLAN A09, linha 169).
2. Entrada em `apps/api/src/routes/route-inventory.ts`.
3. Schema + OpenAPI em `apps/api/openapi/agent-tools.openapi.json` com `x-pi-tool`.
4. Capability de leitura estreita + entrada no inventário `docs/architecture/tool-capability-inventory.md` (gate `capabilities:check`).
5. Regenerar `apps/agent/src/generated/http-tools.ts` via `scripts/generate-agent-tools.mjs` — **nunca** editar à mão.
6. Nenhum `workspaceId`/`householdId` vindo do corpo/query.
7. **Nenhuma migration é necessária** para G-A, G-B, G-C: todos resolvem em camada de leitura.

## 7. Riscos e limitações

- **Reuso não é trabalho zero**: nenhuma rota de analytics é tool do agente hoje. O caminho do reuso ainda toca OpenAPI, capability e regeneração — o gate não encurta.
- **Escopo por conta é assimétrico no dialeto canonical**: destino de transferência não entra. Se algum dia o legado voltar a ser servido, os números mudam.
- **`daily-heatmap` e `cashflow-series` são sensíveis ao prazo**: pagamento de cartão desloca o dia do gasto. Coerente com competência em janela mensal, enganoso em grade diária.
- **Fixture não é teste**: nenhum gate a executa. Ela é insumo de decisão; o RED real vem depois do gate.
- **Evidência é de leitura estática**, sem execução de suítes nesta sessão; `pnpm docs:lint` foi executado pelo Planner ao persistir os artefatos.

## 8. Recomendação para G03 (evidência, não autorização)

1. **Aprovar o caminho do reuso** (`period=custom` + normalizador no Agent + envelope declarando `effectivePeriod`/`boundary`/`basis`/`semanticsVersion`), que responde Q1 parcial, Q2, Q3, Q6, Q7 **sem API nova**.
2. **Reconhecer 3 lacunas que o reuso não fecha** — G-A, G-B, G-C — e decidir se cada uma justifica `/analytics/spending-summary` ou se cada uma vira patch de SPEC mais limitação declarada no envelope.
3. **Não abrir rota nova antes do patch da SPEC.** O relatório produz evidência; a decisão é de G03.
4. **Atualizar V13 do plano** (6 rotas, não 4) e registrar que `daily-heatmap` ignora `period`/`from` — armadilha contratual real para o normalizador.
5. **Tratar `transactionCount` como dependência de A04**, não de A09: sem ele, o diagnóstico `period_empty` continua sem prova.

## 9. Artefatos

- `docs/reports/2026-10-04-ted-inteligente-v1-a09-spike.md` (este relatório)
- `apps/api/tests/fixtures/analytics-semantics.fixture.json` (12 casos: a competência/pagamento, b status, c soft-delete, d undo/estorno, e transferência, f cartão vs fatura, g ancestrais, g2 ciclo/travessia, h safe integers, i > 1 página, j dois workspaces, k comparação de meses, l envelope)
