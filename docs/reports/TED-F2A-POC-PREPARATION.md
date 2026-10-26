# TED F2-A POC — relatório de preparação (sem avaliação com modelo real)

## F2A1 atualização (2026-10-26; somente POC)

### O que mudou (comparador, parser e runner)

- `ab-compare.ts`: `missingFields` e `ambiguities` comparados por **igualdade de conjuntos** (sem ordem, sem duplicata); entidades como tuplas `(kind,value,provenance)` também sem ordem; `contextProvenance` compara `origin`/`corpusId`/`turnIndex`; `requestedAction` e `capabilityAvailability` são dimensões próprias. Cada dimensão só entra no veredicto quando o oráculo a declara — declarar menos não gera `not-comparable` gratuito.
- `structured-interpretation.ts`: aceita `intent: 'clarify'` (com `operation: 'none'` obrigatório), campos `missingFields`/`requestedAction`, proveniência `displayed-option` e `corpusId` no formato `F2A1-*`; `missingFields` tem vocabulário fechado. Ambiguidade **sem** pergunta deixou de ser erro de schema e passou a ser divergência de comparação (o oráculo ainda exige `clarificationRequired` quando aplicável).
- `evaluation-runner.ts` (novo): executor independente dos oráculos F2A1; injeta o contexto fornecido por caso/turno, reporta `inputContext`/`contextBinding`/`contextReasons` em cada linha e classifica `clarificationKind` (`question` vs `limitation`). Slots herdados de texto (`accountName`, `expectedName`, `description`, `yearMonth`) exigem **evidência declarada** no contexto — `suppliedValues`, texto atual, histórico permitido ou `referenceDate`; sem ela, `context-unevidenced-arg:<key>` e `FAIL`. É um conjunto fechado, não um motor de regras.
- `f2a1-inputs.ts` (novo): contexto **obrigatório** por caso e por turno — mensagem atual exata, histórico permitido, catálogos sintéticos, opções exibidas em ordem, transações prévias, valores já fornecidos, campos resolvíveis e `referenceDate` **congelado em `2026-10-24`**. É dado estático, sem I/O e sem sessão.

### Veredicto: FAIL/INCONCLUSIVE por classe de entrada

| Situação | Veredicto |
|---|---|
| Candidato ausente (`undefined`) | `INCONCLUSIVE` (`no-candidate`) |
| Candidato fornecido e **inválido** no schema | `FAIL` (`schema-invalid:agent.invalid_structured_interpretation`) |
| Candidato válido com ID/entidade fora do contexto fornecido | `FAIL` (razão `context-unknown-*`) |
| Candidato que pergunta campo já respondido pelo contexto | `FAIL` (`missing-despite-context:*`) |
| Slot herdado sem evidência declarada (nome, descrição, período) | `FAIL` (`context-unevidenced-arg:*`) |
| Contexto ausente para o caso | `INCONCLUSIVE` (`input-context-missing`) |

### 13 cenários semânticos (6 críticos + 7 extensões)

| ID | Expectativa independente |
|---|---|
| `F1-B005` | `read`/`list_payables`, sem pergunta, `missingFields []`, `ambiguities []` |
| `F1-B010` | `read`/`list_statements`, sem pergunta |
| `F1-B012` | `unsupported`, `operation none`, `requestedAction budgets.create`, `missingFields []`, `ambiguities []`, mensagem de **limitação** (não pergunta), capability nunca executável. Capability indisponível conhecida **não** é ambiguidade: `['capability']` é `FAIL` |
| `F1-B017` | `clarify`; ano **conhecido**, falta apenas `period`; `ambiguities []` |
| `F1-B036` | `read`/`get_month_summary` com `yearMonth 2026-10` |
| `F1-B058` | `clarify`; entidades `amount 2000` **e** `date 2020`; falta só `date`; nunca perguntar "2020 é valor?" |
| `F2A1-B013-catalog` | despesa 2500 / `mercado` / conta `…0003` / categoria `…0003` / `2026-10-24` |
| `F2A1-B015-colloquial` | "cinquenta reais" → 5000 centavos, sem inventar centavos |
| `F2A1-B027-approx` | `clarify` "valor exato"; ausência **e** ambiguidade de `amount` declaradas separadamente |
| `F2A1-B006-reference` | `clarify` "lançamento"; `missingFields ['entity']`; nenhum alvo inventado |
| `F2A1-B016-homonyms` | `clarify` "Aurora"; `ambiguities ['account']`, `missingFields []` |
| `F2A1-B021-correction` | `clarify` valor; nenhuma mutação retroativa inferida |
| `F2A1-B008-concept` | `conversation`/`none`; caso **não financeiro** |

`missingFields` (slot que o contexto não responde) e `ambiguities` (duas ou mais alternativas válidas no contexto) são campos distintos e comparados separadamente em todos os cenários e turnos.

### 5 jornadas avaliadas (10 turnos)

| Jornada | Turno 1 | Turno 2 |
|---|---|---|
| `J01` | `clarify` de valor; `ambiguities []` | proposta `transactions.expense.create` (250000, carne, conta/categoria/dia) |
| `J02` | **proposta direta** com categoria do catálogo; sem pergunta redundante | proposta consolidada com `mercado` |
| `J03` | `clarify` de `initialBalance` + `accountKind`; `ambiguities []` | `accounts.create` (`Reserva`, `bank`, 10000); `accountName` herdado exige evidência declarada |
| `J05` | `clarify`; `ambiguities ['account']`, `missingFields []` | `accounts.update` ligado à **primeira opção exibida** (`…0001`), args `accountId`/`expectedName`/`accountName` |
| `J09` | `get_month_summary` `2026-10` | `get_month_summary` `2026-09` |

- `J05` T2 não pergunta de novo: resolve "a primeira conta Aurora" contra as opções ordenadas do texto de clarificação congelado (`• Aurora` ×2). Escolher a segunda opção (`…0002`) é `FAIL` com `context-selection-mismatch:…0002`.
- `J02` é **extensão semântica explícita**: o estágio congelado da F1 é `clarify → propose`, mas com o catálogo sintético a categoria é única e perguntar de novo violaria `missing-despite-context`. A restrição de estágio da F1 fica registrada como limitação separada, não como ganho semântico.
- Veredicto global agrega **apenas** os 13 cenários + as 5 jornadas avaliadas. As outras 5 jornadas congeladas (`J04`, `J06`, `J07`, `J08`, `J10`) permanecem `INCONCLUSIVE`, com razão `journey-retained-not-evaluated`, e **não** puxam o agregado.
- `financialCompletion` é `'unobservable'` em 100% das linhas: o POC não tem ledger, writer nem execução.
- Evidência de contexto testada negativamente: removendo `history` **e** `suppliedValues`, `J03:T2` (`accountName "Reserva"`) vira `context-unevidenced-arg:accountName`; `J01:T2` (`description "carne"`) vira `…:description`; `J09:T2` (`yearMonth "2026-09"`) vira `…:yearMonth`. Basta **uma** fonte declarada (histórico **ou** valores) para o turno voltar a `match`; `J09:T1` continua `match` só com `referenceDate` (`2026-10`).

### 8 pares declarados de extensão (7 de cenário + J02)

Cada um dos 7 pares de cenário tem **corrupção negativa própria** provando `FAIL`:

| Extensão | Expectativa F1 congelada | Critério comparável F2A1 | Corrupção que falha |
|---|---|---|---|
| `B013-catalog` | fixture F1 sem catálogo sintético | `accountId`+`categoryId` exatos | `categoryId` desconhecido |
| `B015-colloquial` | F1 clarifica "cinquenta reais" | `amountCents 5000` | `amountCents 500` |
| `B027-approx` | `approximateAmountCents` fora do vocabulário POC | `clarify` + ausência exata | proposta de 5000 sem pergunta |
| `B006-reference` | alvo de despesa anterior | `clarify` + nenhum ID de alvo | mutação com `transactionId` inexistente |
| `B016-homonyms` | cardinalidade 2 no artefato F1 | `clarify` + sem `accountId` | escolher `…0001` sem opções exibidas |
| `B021-correction` | `prior/correctedAmountCents` | `clarify` + nenhuma mutação | `transactions.update` com alvo inexistente |
| `B008-concept` | resposta conceitual | `conversation`/`none` | proposta `transactions.expense.create` |
| `J02-category` | estágio `clarify → propose` | proposta direta com categoria do catálogo | pergunta redundante (`missing-despite-context:category`) |

### Validação real (comandos e resultados)

**RED→GREEN F2-A.1:** o teste inicial de `clarify` foi rejeitado pelo parser; após o contrato, passou. A rodada intermediária reproduziu 31 PASS/2 FAIL (ordem de `missingFields` de J03 e expectativa legada B027); o diagnóstico independente separou igualdade de conjuntos de campo realmente não representável. A extensão B013 reproduziu falha por `corpusId` não aceito; corrigido o formato experimental. Negativos isolados comprovam FAIL para entidade/proveniência inventadas, pergunta redundante, ano convertido em valor, schema inválido e perda de contexto. Os dois achados finais (nome herdado sem fonte e capability tratada como ambiguidade) têm controles positivos e negativos próprios. Nenhum teste/corpus original foi reescrito para favorecer B.

**Integração:** no início, `gh pr view 278` confirmou head `fd7c080c44c082c45c2e6058e8ead8c54d1e0754`, base F1, draft, `MERGEABLE`, sem checks e árvore limpa. CI/PWA CI só disparam em PRs contra `main`, sem `workflow_dispatch` de CI equivalente. Proteção exige `Gate — all checks` e `quality (22, 10)`. Um PR temporário de validação contra `main` é permitido pelo operador: inclui F1 + F2-A, pode validar merge ref, não prova execução isolada do head e não altera a base do #278. Workflows de deploy exigem origem `push`/SHA de main; nenhum merge ou deploy é autorizado. Resultado remoto será registrado sem presumir sucesso.

Após os testes finais, os dois relatórios F1 originais foram restaurados **somente depois** de verificar igualdade JSON excluindo `generatedAt`/`harnessElapsedMs`; os bytes foram recuperados do commit congelado. `frozen/` e corpus original permanecem sem diff. As notas históricas abaixo sobre relatórios temporariamente modificados descrevem apenas as rodadas anteriores.

**Suíte focal — antes das correções finais (43) e depois (46), execuções reais:**

```
pnpm --filter pi-finance-agent exec vitest run tests/poc-structured
→ antes das correções finais: Test Files 3 passed (3) · Tests 43 passed (43)
→ depois das correções finais: Test Files 3 passed (3) · Tests 46 passed (46)
  (f2a1-evaluation-runner 19 · f2a-structured-interpretation 18 · f2a-ab-runner 9)
```

**Suíte completa — estado final após as correções revisadas:**

```
pnpm test   (log: %TEMP%\opencode\f2a1-final-test.log)
→ exit 0
  @pi-finance/llm-contracts    25 passed (25)
  meu-ted-api                2861 passed | 172 skipped (3033)
  pi-finance-agent           3466 passed |   1 skipped (3467)
  pi-finance-codex-broker      34 passed (34)
  pwa                        2832 passed (2832)
  total de testes aprovados: 9218; 173 skipped; 0 failed
```

Essa execução cobre B012, evidência de contexto e remoção de `candidateFor`. Logs finais: `%TEMP%\opencode\f2a1-final-test.log`, `f2a1-final-focal.log`, `f2a1-final-typecheck.log` e `f2a1-final-biome.log`. A execução anterior (9215 aprovados) permanece preservada como histórico, não como prova do estado final.

**Gates e verificação estática executados após as correções finais:**

```
pnpm typecheck        → EXIT=0 (5 workspaces; nenhum `error TS`)
pnpm docs:lint        → 17 documentos, 0 issues, PASSED
pnpm governance:check → EXIT=0
pnpm capabilities:check → EXIT=0
pnpm write-policy:check → EXIT=0
pnpm test:skip-gate   → EXIT=0
```

**Lint — correção de alegação histórica (NÃO é gate válido):** a rodada anterior afirmou "lint por stdin 7/7 exit 0" como prova. O tester reproduziu que esse caminho **não** é gate de repositório: o config é ignorado/interpretado de forma diferente no stdin, e a checagem externa com config **byte-idêntico** encontrou um erro real de variável não usada (`candidateFor`), agora removido. `pnpm lint` travou por **90 s no primeiro workspace (0/5)** (log `f2a1-lint.log`); a causa provável é o escopo de `files.includes` na raiz, **não comprovada em definitivo**. Portanto lint de repositório fica **pendente de CI**.

**Suplemento Biome (não substitui o gate):** config externo copiado de `biome.json` com SHA-256 **idêntico** (`5bcadfaeb0d02b23c4d5b28565972fd08ce499d9e68b734e5ee64625a353370d`); `biome.exe check --colors=off --config-path=<cópia> <10 arquivos TS>` em **modo arquivo**, sem escrita → exit 0, `Checked 10 files in 11ms. No fixes applied.` Nenhum diagnóstico. O escopo relativo da configuração externa difere: é validação auxiliar das regras, não substituição do gate agregado.

**Diagnóstico corrigido:** a falha focal anterior **não** era `F1-B012`. Era `F2A1-B013-catalog` retornando `INCONCLUSIVE` (`expected 'INCONCLUSIVE' to be 'PASS'`), porque o regex de `corpusId` em `checkProvenance` aceitava apenas `F1-B\d{3}`, `J\d{2}` e `LOCAL-*`. O regex passou a aceitar `F2A1-[A-Za-z0-9-]+`; `F1-B012` já passava com `requestedAction`/`capabilityAvailability` corretos.

Estas fixtures são **autoria manual**: provam harness, parser e semântica declarada, **não** qualidade de modelo. Nenhum provider da POC, DB, corpus congelado, config, dependência ou código de produto foi alterado. Revisão independente final: **APPROVED**, após confirmar os dois achados corrigidos. Consultas GitHub e publicação de PR são operações de integração, não chamadas de avaliação.

### Manifesto futuro B0/B1 (proposta, não autorização)

| Estágio | Casos | Chamadas lógicas | Observação |
|---|---|---|---|
| **B0** (smoke exato) | **23** = 13 cenários single + 10 turnos | 23 | um candidato por caso; cacheável |
| **B1** (integrado) | **77** = 60 cenários congelados + 7 extensões semânticas + 10 turnos | 77 (23 reusados do cache + 54 novos) | um candidato por caso |
| Teto de orçamento | — | **≤ 81** | margem de 4, sem retries automáticos |
| Dois modelos no mesmo run | — | até 154 | **exige autorização adicional** (ultrapassa 81) |

- **Nenhum provider/modelo está selecionado** e **nenhum orçamento está autorizado**; a tabela é proposta.
- IDs B0: seis `F1-B005/B010/B012/B017/B036/B058`, sete chaves `F2A1-*` enumeradas em `f2a1-oracles.ts` e `J01/J02/J03/J05/J09:T1/T2`. B1 acrescenta os outros 54 IDs do corpus original; extensões nunca substituem silenciosamente originais. Os 60 IDs são enumerados do snapshot SHA-256 pinado.
- Cache só reutiliza output quando mensagem, contexto permitido, schema, prompt e modelo/configuração forem idênticos (chave por hash desses inputs). Sem essa igualdade, nova chamada consome orçamento; reaprovar se ultrapassar 81. Nenhum retry, inclusive por wrapper externo; concorrência 1; uma tentativa por caso e candidato.
- Preparação de cada tentativa: carregar input sem oráculo/expected/candidato local nem saída de A; enviar apenas mensagem, contexto permitido e contrato. Salvar output bruto localmente, validar schema e executar `runF2A1` com os oráculos separados. Os casos B1 ainda sem oráculo semântico estendido não ganham PASS por ausência: usar comparador F1 nas dimensões observáveis e declarar as demais inconclusivas. Não exigir uma etapa generativa de execução.
- Metadados por tentativa: ID, domínio/dificuldade pré-rotulados, hash de input/schema/prompt, versão do candidato, início/fim monotônicos, status/schema reason sanitizado, usage de entrada/saída fornecido pelo provider e custo com preço efetivo datado. Uso ausente = desconhecido, nunca zero; custo desconhecido impede comprovar o teto e interrompe o run antes da próxima chamada.
- **Métricas:** intent/op/args/valor/data/contexto = matches / comparações observáveis válidas, com cobertura e inválidos apresentados separadamente; esclarecimentos redundantes = perguntas indevidas / turnos com informação suficiente; schema compatível = válidos / outputs recebidos (ausentes separados). p50/p95 somente de latências observadas (informar n e método nearest-rank); tokens somente usage medido; custo por interpretação válida = custo total medido / outputs válidos, inconclusivo se denominador zero ou custo desconhecido. Quebrar por domínio/dificuldade sem misturar execução com semântica.
- Proposta de passagem B0→B1: schema válido 23/23, nenhum campo de autoridade/tentativa de recurso não autorizado, todos os seis casos críticos corretos nas dimensões exigidas (inclusive valor/data), nenhuma pergunta redundante nos casos de contexto suficiente e nenhuma regressão contextual nos dez turnos. Qualquer falha exige análise/aceite explícito antes de ampliar; B1 não começa automaticamente. Não há limiar de superioridade do produto definido nesta fase.
- Separar sempre: interpretação (dimensões observadas), disponibilidade funcional (`unsupported` para `budgets.create`; demais `unknown`, sem comprovação de handler/API/permissões) e conclusão financeira (`unobservable`). Os limites abaixo e este protocolo são propostas para aceite futuro.
- **Prontidão local:** instrumento aprovado pela revisão independente; lint agregado/CI remoto têm pendência explícita. READY nesta fase não significa superioridade de B nem autorização para executar B0/B1.

> **Status:** POC local-only na branch `feat/ted-f2a-structured-interpretation`, atualização preparada para o PR #278. **F2-B (avaliação com modelo real) é PROIBIDA nesta tarefa** e continua gateada. Sem provider de avaliação, DB, SDK, execução financeira, alteração de permissões ou mudança de produção/F1/deps/config.
>
> **Prontidão:** revisão independente **APPROVED**; validação funcional local verde. Lint agregado e CI serão registrados com seus SHAs e escopos, sem status verde presumido.
>
> Baseline: `HEAD = fd7c080c44c082c45c2e6058e8ead8c54d1e0754` (POC), com o corpus F1 congelado em `ef12a8ee7e4ef6c215bffce755e1d7c68c89820e` (ancestral do HEAD).
>
> **Correção de integração (2026-10-26):** o runner lia os artefatos F1 do **working tree**, que é mutável (`generatedAt`/`harnessElapsedMs` são reescritos a cada execução dos próprios testes F1), causando falha determinística no `pnpm test`. A seção "Correção de integração F2-A" abaixo registra os quatro defeitos corrigidos e a evidência RED→GREEN. Uma segunda rodada (portabilidade CI) empacotou os artefatos congelados e removeu o `git show` do runtime — ver "Portabilidade CI — artefatos congelados empacotados".

## Escopo e ownership

A rodada F2A1 atua somente em:

- `apps/agent/src/poc-structured/` (`structured-interpretation.ts`, `ab-compare.ts` — rastreados, modificados)
- `apps/agent/tests/poc-structured/` (5 arquivos novos F2A1: `evaluation-runner.ts`, `f2a1-inputs.ts`, `f2a1-oracles.ts`, `f2a1-candidates.ts`, `f2a1-evaluation-runner.test.ts`; mais os testes rastreados ajustados)
- `scripts/check-agent-v2-invariants.mjs`, `scripts/check-agent-v2-invariants.test.mjs` e `scripts/__fixtures__/agent-v2-invariants/a5-denylist/` (falso positivo A5 do CI remoto — ver "CI remoto F2A1")
- `docs/reports/TED-F2A-POC-PREPARATION.md`

`git status` desta sessão: `M` em `ab-compare.ts`, `structured-interpretation.ts`, `f2a-ab-runner.test.ts`, `f2a-structured-interpretation.test.ts`, `fixtures.ts` e este relatório; `??` nos 5 arquivos novos. Os dois relatórios F1 rastreados (`ted-f1-baseline.json`, `ted-f1-journeys.json`) aparecem como modificados pela execução dos próprios testes F1 e **não** foram tocados/restaurados aqui. Na correção do falso positivo A5 (seção "CI remoto F2A1"), o working tree contém apenas este relatório, `scripts/check-agent-v2-invariants.{mjs,test.mjs}` e as fixtures `a5-denylist/`.

Nada de produção, corpus congelado, dependências, configs, workflows ou provider foi tocado. A correção F2-A lê as cópias empacotadas do commit congelado e não depende do estado mutável daqueles dois relatórios.

## Correção de integração F2-A (defeitos encontrados pelo tester) — 4/4

| # | Defeito | Correção aplicada |
|---|---|---|
| 1 | O runner pinava SHA-256 mas lia os arquivos do **working tree**; os geradores F1 reescrevem `generatedAt` e `harnessElapsedMs`, então `pnpm test` falhava de forma determinística (`01d7aff4…`/`594d342d…` no worktree vs. `5bdc2be4…`/`ca89250a…` pinados) | Novo `tests/poc-structured/frozen-artifacts.ts`: valida o commit com `git rev-parse --verify ef12a8ee…^{commit}`, lê cada artefato com `git show ef12a8ee…:<path>` e confere o SHA-256 dos bytes **do commit** antes de parsear (posteriormente trocado por cópias empacotadas — ver "Portabilidade CI"). O working tree nunca é consultado para o lado A. Dois testes fixam `generatedAt` do commit (`2026-10-24T17:16:20.203Z` / `…25.399Z`), provando que o corpo vem do commit e não de um relatório regenerado. |
| 2 | Nenhuma asserção garantia que **toda** operação de `TED_APPROVAL_TOOLS` tivesse schema de args; lookups de `ARG_SPECS`/`OPERATION_ARG_KEYS` usavam a cadeia de protótipos (`key in ARG_SPECS`, `ARG_SPECS[key]`), aceitando `toString`/`constructor`/`__proto__` como vocabulário | `registry.ts` exporta `getArgSpec` e `hasOperationArgSchema` com `Object.prototype.hasOwnProperty.call`; parser e comparador usam esses acessos. Teste `RED-05` percorre `TED_APPROVAL_TOOLS` (todo op tem schema não vazio), exige spec própria para cada chave aceita em cada operação e rejeita `toString`/`constructor`/`hasOwnProperty`/`__proto__` com `args-unknown-key`. |
| 3 | `F1-B055` era reportado **PASS global** embora seu oráculo carregue `confirmationMustBeSeparateTurn: true`, comportamento que este POC não observa (sem fronteira de turno, sem protocolo de confirmação, sem ledger) | `ab-compare.ts` declara `F1_UNOBSERVABLE_EXPECTATION_KEYS`; uma linha com expectativa comportamental não observável vira **INCONCLUSIVE** com razão `f1-expectation-unobservable:confirmationMustBeSeparateTurn` e dimensões parciais explícitas (`intent/operation/args/clarification/needles = match`). Nunca PASS global. |
| 4 | A alegação de lint era "não executado (hang)" | **Alegação original (posteriormente corrigida, ver abaixo):** lint "verificado" por stdin, 7/7 exit 0. **Correção do tester:** o stdin **não é gate de repositório** — o config é ignorado nesse caminho; a checagem com config externo byte-idêntico encontrou um erro real (`candidateFor` não usado, removido nesta rodada); `pnpm lint` travou 90 s no primeiro workspace (0/5). Lint de repositório segue **pendente de CI**; o suplemento Biome é evidência auxiliar, não gate. |

**Causa raiz confirmada (não corrigida aqui, fora do escopo):** `apps/agent/tests/ted-f1-baseline.test.ts:678/755` e `apps/agent/tests/ted-f1-journeys.test.ts:539` escrevem os dois relatórios rastreados durante `pnpm test`. Por isso qualquer leitura do working tree como oráculo é não determinística; a correção F2-A isola o lado A no commit `ef12a8ee…`. Uma correção estrutural dos geradores (não reescrever arquivos rastreados ou separar artefato de execução de artefato congelado) é decisão do Planner/F1.

## Portabilidade CI — artefatos congelados empacotados (2026-10-26)

**Defeito:** o loader resolvia o oráculo com `git show ef12a8ee…:<path>` em tempo de teste. O CI faz checkout **shallow**, então o commit pinado não existe no clone e o teste falhava por ausência de história — não por conteúdo.

**Correção:** três cópias **byte-exact** dos blobs do commit foram empacotadas (snapshot autorizado; o corpus F1 original permanece intocado) em:

- `apps/agent/tests/poc-structured/frozen/scenarios.json`
- `apps/agent/tests/poc-structured/frozen/journeys.json`
- `apps/agent/tests/poc-structured/frozen/baseline.json`

O runtime lê essas cópias e confere o **SHA-256 fixado** em `frozen-artifacts.ts` a cada load; não há chamada a Git. `FROZEN_ARTIFACT_COMMIT` permanece como constante de **proveniência** (SHA completo, 40 hex) e o teste assere apenas o formato — **não há alegação de que o runtime verifica ancestralidade, existência ou alcançabilidade do commit**. Um teste de guarda falha se o loader voltar a importar `child_process`/`execFileSync`/`rev-parse`. Os caminhos de origem (`FROZEN_ARTIFACT_SOURCE_PATHS`) ficam declarados apenas para proveniência/mensagens de erro.

**Por que não alterar o workflow:** um `fetch-depth: 0` (ou checkout do commit pinado) acoplaria cada run de CI à profundidade e à alcançabilidade de um SHA antigo, além de custar mais. Empacotar os bytes elimina o requisito de história/histórico no runtime; a integridade continua ancorada no digest pinado, e o commit segue como proveniência documentada. O original imutável é preservado pelo pin de SHA-256.

**Prova de byte-exactness** (cópia via `git show <commit>:<path>`, comparação binária byte-a-byte e `sha256` do arquivo empacotado):

```
scenarios  7f36d008c6316666396d0747df2b6abc488a71a85afda4abf60e11b63f774726   81 360 bytes
journeys   5bdc2be4eeb2ce099452544dd58ca7bb45015e3ca4288fe59fde97374a3c9f12   51 358 bytes
baseline   ca89250a7b7c0ca6d4c6ce376064677bd97cc0a8041e1ed3c2cedd087b046926  414 118 bytes
```

Cada cópia foi relida do disco e comparada com os bytes do commit (`Buffer.compare === 0`): `roundtrip=true` nos três. O `.gitattributes` raiz (`* text=auto eol=lf`) mantém os arquivos em LF no índice e no worktree, então o digest não depende da plataforma.

## CI remoto F2A1 (run 40405766828) — falso positivo A5 corrigido (2026-10-26)

**Contexto remoto:** run `40405766828`, head `7b8841b`, checkout do merge ref `1105fa4135d424a6f1edfc2989b6e9cf84fd3ea6` (parents: `main` `b21faff9` + head `7b8841b`). O CI do Agent (lint/typecheck/test) e a avaliação passaram; a **única** falha foi `architecture:check`.

**Defeito (falso positivo):** o scanner A5 (`/\\b(?:mutationApproved|approvedTool)\\b/`) acusava `apps/agent/src/poc-structured/structured-interpretation.ts:142` — o membro **literal da denylist** `FORBIDDEN_NORMALIZED_KEYS`, cuja função é justamente rejeitar `mutationApproved` vindo do modelo. É definição, não emissão.

**Correção (narrow, auditável; somente o checker e seus testes):**

- `scripts/check-agent-v2-invariants.mjs`: reconhece **apenas** o arquivo exato `apps/agent/src/poc-structured/structured-interpretation.ts` e **apenas** um membro que a gramática estrita aceite como **string direta** do array da declaração exata `const FORBIDDEN_NORMALIZED_KEYS ... = new Set([ ... ])`. A gramática do array é mínima: literais string cotados separados por vírgula, com whitespace/comentários (já mascarados). **Qualquer** membro não-string (objeto, array aninhado, spread, chamada computada, identificador) faz a constante inteira **falhar fechada** — nenhum membro dela é isento, como na denylist real (todos strings). Uma declaração falsa dentro de string literal não é reconhecida; comentários já são mascarados. O literal **não** foi removido nem ofuscado; não existe exclusão de arquivo/diretório nem de chave cotada em geral. Sem nova dependência.
- Tudo o mais continua A5: emissor **antes** ou **depois** da declaração no mesmo arquivo, `{ 'mutationApproved': true }` (inclusive **depois de vírgula** num objeto aninhado ao array), array aninhado após vírgula, constante **renomeada**, e string cotada em **qualquer outro arquivo**. O arquivo nunca é isento por inteiro.
- Fixtures novas: `scripts/__fixtures__/agent-v2-invariants/a5-denylist/{allowed,rejected}/` (parser + binding manifest, com decoy em comentário no caso aceito) e 3 testes em `scripts/check-agent-v2-invariants.test.mjs` (denylist exata aceita; membro da denylist **preservado**, não apagado; 8 violações A5 preservadas — posições 1/4/6/7/10/11 no parser, mais constante renomeada e arquivo não relacionado — incluindo o fail-closed da constante com membros não-string).

**RED→GREEN (execuções reais):**

```
# RED antes da correção
node scripts/check-agent-v2-invariants.mjs
→ A5_MUTATION_ISSUER_OUTSIDE_EXECUTOR …structured-interpretation.ts:142
  Agent V2 invariants RED: 1 diagnostics (540 production files scanned)   EXIT=1
node --test scripts/check-agent-v2-invariants.test.mjs
→ 3 failed (allowed acusa A5; rejected acusa A5 no membro da denylist além dos emissores)   EXIT=1

# RED da 2ª rodada (reviewer): objeto após vírgula e array aninhado eram isentos
node --test scripts/check-agent-v2-invariants.test.mjs
→ 1 failed: parser com 3 A5 (esperado 6 — o membro da denylist e os dois
  membros não-string voltavam isentos)                                    EXIT=1

# GREEN depois
node --test scripts/check-agent-v2-invariants.test.mjs
→ 6 passed (6)                                                            EXIT=0
node scripts/check-agent-v2-invariants.mjs
→ Agent V2 invariants GREEN: 540 production files scanned                 EXIT=0
pnpm --filter pi-finance-agent exec vitest run tests/poc-structured
→ Test Files 3 passed (3) · Tests 46 passed (46)
pnpm docs:lint
→ 17 documentos, 0 issues, PASSED
```

Escopo: nenhuma mudança de comportamento de produção, permissões, SDK, dependências ou workflows; sem rede, provider ou commit. A denylist de runtime e seus testes (`f2a-structured-interpretation.test.ts`, NEG-06) permanecem intactos — o membro segue no array e o parser continua rejeitando o campo.

**Falha de segurança do mesmo run (não resolvida aqui):** o job de container acusa `CVE-2023-54404` em Zod `3.25.76`/`4.4.3`, com correção em `4.6.6`. O achado é **herdado dos insumos** da imagem e **não foi provado** que venha da base de scan desta mudança. Por decisão de escopo, **não** foram alterados allowlist, dependências ou imagem; a falha permanece para decisão do Planner/segurança.

## Defeitos de review → correção (12/12)

| # | Defeito apontado | Correção aplicada |
|---|---|---|
| 1 | Runner não chamava o parser; fixture carregava `expected` redundante (auto-comparação) | `fixtures.ts` agora é **candidate-only** (`corpusId`, `fixtureId`, `text`, `llmJson`). O runner faz `toCandidate(parseStructuredLLMOutput(llmJson))` e compara com o oráculo F1 congelado. Teste de pureza rejeita os tokens `fixture.expected`, `actualPlan` e `isolatedRoute` no source e exige exatamente as 4 chaves na fixture. |
| 2 | Vocabulário de operações/args duplicado e incompleto | `registry.ts` importa `TED_APPROVAL_TOOLS` (fonte canônica) e liga `DRAFT_ARG_KEYS` a `MutationDraftResolvedArgs` via `satisfies readonly (keyof MutationDraftResolvedArgs)[]` (drift quebra `tsc`). Inclui `transactions.update`, `accounts.create/update/deactivate`, `categories.create/update/deactivate`. `OPERATION_TO_READ` **não é exportado** pela produção: o registry de leitura é um espelho declarado (`READ_REGISTRY_PROVENANCE`) e um teste de paridade faz parsing de `channel-evidence.ts` e falha se os conjuntos divergirem — sem editar produção. |
| 3 | Journeys podiam gerar PASS global e/ou usar `actualPlan` | `compareF2AJourney` tem tipo de retorno `verdict: 'INCONCLUSIVE'` (literal, não calculado). Preserva `originalCompletion`. Só aceita `expectedStage` (primeiro de `expectedStages`); nunca recebe `actualPlan`/`isolatedRoute`. |
| 4 | `clarify` e undo-proposal viravam FAIL estrutural | Modo F1 sem representação (`clarify`) ⇒ `INCONCLUSIVE` com `f1-mode-not-representable:clarify`, e intent/operation/args marcados `not-comparable`. Undo-proposal (marcador `latest-own-actor-operation-only`) ⇒ `INCONCLUSIVE` com `f1-taxonomy-unsupported:undo-proposal`. Nenhum dos dois pode produzir FAIL pela forma da taxonomia. |
| 5 | Chaves de args inexatas; `null` tratado como ausente; args espúrios em `none` | `compareArgs` usa `hasOwn` para presença real, exige `got === null` quando o oráculo declara `null` (ausente ≠ `null`), marca chave candidata fora do esperado como mismatch, e `operation: 'none'` proíbe qualquer arg (`operation-args-inappropriate`). |
| 6 | Conteúdo de clarificação não comparado de forma independente | `compareClarification` separa presença (`match`/`mismatch`) de needles (NFD + lowercase), reportando `clarificationNeedlesMatched` / `Missing`. Teste corrompe a pergunta e verifica `FAIL` só em `clarificationNeedles` com `['categoria']` faltante. |
| 7 | `safetyHold` era tratado como métrica | Removido do comparador (segurança é invariante estrutural: módulo sem superfície de execução). O runner assere que a propriedade **não existe** em nenhuma linha de comparação. |
| 8 | Asserções `PASS or FAIL` | Lista exata de 8 cenários `PASS`; 52 `INCONCLUSIVE`; corrupções geram `FAIL` exato com dimensão e chaves específicas. |
| 9 | Injeção/case e ausência de prova real de "sem executor" | Keys authority/receipt/credential normalizadas (lowercase, não-alfanuméricos removidos) e rejeitadas em qualquer profundidade: `write_authorized`, `Write-Authorized`, `WRITEAUTHORIZED`, `Idempotency-Key`, `auto_execute`, `approval`, `token`, inclusive dentro de `args`, `entities` e `contextProvenance`. O teste importa o namespace real (`import * as structuredModule`) e compara a allowlist exata de 5 exports, além de exigir `undefined` para `execute/commit/authorize/approve/dispatch/receipt/write/propose/provision/migrate`. |
| 10 | Centavos/enums/datas/args por operação frouxos | `cents` exige inteiro ≥ 0; `signed-cents` exige inteiro (saldo inicial negativo permitido, ADR-018); enums reais `bank|cash` e `expense|income`; datas validadas em calendário real (`2026-02-30`, `2026-13-01`, `20261001` rejeitadas; `2024-02-29` aceita); `yearMonth` com mês `01..12`; cada operação tem conjunto fechado de args. |
| 11 | Wrapper permissivo, sem bounds, erro não tipado | Só `{ "interpretation": {...} }` (objeto ou string JSON); chave irmã, casing errado e wrapper aninhado falham. Limites: 8 192 bytes serializados, profundidade 8, 12 args, 8 entidades, 8 ambiguidades, 200 chars por string, 500 chars de clarificação. Erro único `StructuredInterpretationError` com `code: 'agent.invalid_structured_interpretation'` e `reason` de enum fechado (18 códigos). |
| 12 | Sem âncora de integridade do corpus; F2-B sem orçamento | SHA-256 por arquivo + commit completo (`ef12a8ee…`) fixados como proveniência; o loader (empacotado, ver "Portabilidade CI") confere o digest a cada load. Orçamento F2-B declarado abaixo (provider/modelo **não** escolhidos). |

## Arquivos

- `apps/agent/src/poc-structured/registry.ts` — vocabulário canônico de operações/args, proveniência e flags `supportedInProduction`.
- `apps/agent/src/poc-structured/structured-interpretation.ts` — parser estrito, erro tipado, bounds, `toCandidate`.
- `apps/agent/src/poc-structured/ab-compare.ts` — comparador por dimensão e comparador de jornadas.
- `apps/agent/tests/poc-structured/fixtures.ts` — 10 fixtures candidate-only F1 (9 cenários + J01).
- `apps/agent/tests/poc-structured/frozen-artifacts.ts` — loader read-only dos artefatos F1 empacotados em `frozen/` (verificação de SHA-256 a cada load; sem Git em runtime).
- `apps/agent/tests/poc-structured/frozen/{scenarios,journeys,baseline}.json` — cópias byte-exact dos blobs do commit `ef12a8ee…` (snapshot autorizado; SHA-256 pinado no loader).
- `apps/agent/tests/poc-structured/f2a-structured-interpretation.test.ts` — 18 testes (adapter, registry/own-property, pureza, namespace, campos F2A1).
- `apps/agent/tests/poc-structured/f2a-ab-runner.test.ts` — 9 testes (hashes pinados, corpo empacotado, ausência de dependência de Git, veredictos exatos, corrupções, expectativa não observável, taxonomias, jornadas, pureza do runner).
- `apps/agent/tests/poc-structured/f2a1-oracles.ts` — oráculos independentes: 13 cenários + 5 jornadas (10 turnos) + lista das 5 jornadas retidas.
- `apps/agent/tests/poc-structured/f2a1-inputs.ts` — contexto fornecido por caso/turno (`referenceDate` `2026-10-24`; catálogos e opções sintéticas).
- `apps/agent/tests/poc-structured/f2a1-candidates.ts` — candidatos manuais F2A1 (não são saída de modelo).
- `apps/agent/tests/poc-structured/evaluation-runner.ts` — executor que injeta contexto, distingue `FAIL` de schema/corrupção de `INCONCLUSIVE` por ausência e agrega só o conjunto avaliado.
- `apps/agent/tests/poc-structured/f2a1-evaluation-runner.test.ts` — 19 testes (13 cenários, 5 jornadas, contexto obrigatório, evidência de slots herdados, semântica B012/B017/B058, J02/J05, 8 extensões com corrupções negativas).
- Total focado: **46/46** (19 + 18 + 9) após as correções finais; **43/43** antes delas. A suíte completa do Agent cobria os 24 testes das rodadas anteriores; a reexecução completa pós-correções é gate do Planner.

## Evidência (comandos e resultados reais)

### RED (antes da correção)

```
pnpm --filter pi-finance-agent exec vitest run tests/poc-structured
→ Test Files  1 failed | 1 passed (2)
  Tests       1 failed | 20 passed (21)
  FAIL  F2-A frozen artifacts … > pins the artifact commit and file hashes
  AssertionError: expected '01d7aff49d4961ec7f3be644d53ae1bbe4787…'
                  to be '5bdc2be4eeb2ce099452544dd58ca7bb45015…'
  (journeys do working tree vs. hash do commit pinado; baseline falharia em seguida)

# após acrescentar os testes de paridade/own-property e a expectativa de B055:
→ Test Files  2 failed (2)
  Tests       3 failed | 20 passed (23)
  (hasOperationArgSchema/getArgSpec ausentes; F1-B055 ainda PASS)
```

### GREEN (focado)

```
pnpm --filter pi-finance-agent exec vitest run tests/poc-structured
→ Test Files  2 passed (2)
  Tests       23 passed (23)
  Duration    742ms (transform 127ms, import 190ms, tests 494ms)
```

### Artefatos congelados — evidência histórica da primeira rodada (`git show`, hoje empacotado)

> Histórico: esta evidência registra a rodada em que o oráculo era lido do commit. O loader atual **não** usa Git (ver "Portabilidade CI"); os digests abaixo são exatamente os pins das cópias empacotadas.

```
git rev-parse --verify 'ef12a8ee7e4ef6c215bffce755e1d7c68c89820e^{commit}'
→ ef12a8ee7e4ef6c215bffce755e1d7c68c89820e   (exit 0)

git show ef12a8ee…:<path> | sha256
→ 7f36d008c6316666396d0747df2b6abc488a71a85afda4abf60e11b63f774726  ted-f1-scenarios.json
→ 5bdc2be4eeb2ce099452544dd58ca7bb45015e3ca4288fe59fde97374a3c9f12  ted-f1-journeys.json
→ ca89250a7b7c0ca6d4c6ce376064677bd97cc0a8041e1ed3c2cedd087b046926  ted-f1-baseline.json

working tree no momento da correção (mutável)
→ 01d7aff49d4961ec7f3be644d53ae1bbe4787cad114af308b5774f8cbfcc930c  journeys
→ 594d342d2a1b9e17f2cbb57a97eeb9601572166533bf4d9cafb5859557776b1f  baseline
```

### Portabilidade CI — validação (2026-10-26, loader empacotado)

```
# focado (empacotado, sem Git)
pnpm --filter pi-finance-agent exec vitest run tests/poc-structured
→ Test Files  2 passed (2)
  Tests       24 passed (24)

# integridade do pin: uma cópia adulterada (1 byte) falha alto e é restaurada
+ ' ' em frozen/journeys.json
→ Tests  3 failed | 5 passed (8)   exit 1
  Error: frozen artifact hash mismatch for apps/agent/evals/reports/ted-f1-journeys.json
         @ ef12a8ee7e4ef6c215bffce755e1d7c68c89820e:
         expected=5bdc2be4… actual=039bbe17…   (exit 1)
restauração → sha256 = 5bdc2be4… (byte-a-byte idêntico ao original)

# typecheck do workspace
pnpm typecheck → EXIT=0 (5 workspaces, nenhum `error TS`)

# lint por stdin nos 2 arquivos TS alterados (NÃO é gate de repositório — ver correção do tester)
biome lint  --write --stdin-file-path=<arquivo>  × 2 → exit 0, stdout idêntico
biome check --write --stdin-file-path=<arquivo>  × 2 → exit 0, stdout idêntico
(disco intocado: hash antes = depois; resultado inválido como gate: config ignorado no stdin)
```

### Histórico F2-A original (não representa o estado F2-A.1 acima)

```
pnpm test   # run 1
→ exit 0, 560.7s
  @pi-finance/llm-contracts  25 passed (25)
  meu-ted-api                2861 passed | 172 skipped (3033)   [344 files + 12 skipped]
  pi-finance-agent           3443 passed | 1 skipped (3444)     [270 files + 1 skipped]
  pi-finance-codex-broker      34 passed (34)
  pwa                        2832 passed (2832)                 [315 files]
log: C:\Users\walis\AppData\Local\Temp\opencode\f2a-full-test-run1.log

pnpm test   # run 2 (sequencial, mesmo estado)
→ exit 0, 593.0s, contagens idênticas
log: C:\Users\walis\AppData\Local\Temp\opencode\f2a-full-test-run2.log
```

### Typecheck e lint

```
pnpm typecheck
→ exit 0 (54.9s), workspaces (llm-contracts, api, agent, pwa, broker) sem erro

# lint por stdin (NÃO é gate de repositório — ver correção abaixo)
biome lint  --write --stdin-file-path=<arquivo>   × 7 arquivos novos → exit 0
biome check --write --stdin-file-path=<arquivo>   × 7 arquivos novos → exit 0
→ stdout idêntico ao arquivo em todos; disco intocado (hash antes = depois)
```

- **Correção do tester:** o caminho stdin **não** aplica o config do repositório como gate; os "exit 0" acima são eco do conteúdo, não prova de lint. A checagem com config externo **byte-idêntico** revelou um erro real de variável não usada (`candidateFor`), removido nesta rodada. `pnpm lint` travou 90 s no primeiro workspace (0/5); causa provável é o escopo de `files.includes` na raiz, não comprovada em definitivo. Lint de repositório fica **pendente de CI**.
- Agregado original do baseline (commit congelado) conferido por leitura: `PASS 12 / FAIL 41 / BLOCKED 1 / INCONCLUSIVE 6` (60 cenários). O worktree, regenerado pelos testes F1, mantém as mesmas 60 classificações; só `generatedAt`/`harnessElapsedMs` mudam.
- Os dois relatórios F1 rastreados **não foram restaurados nem editados** nesta correção: foram preservados no estado em que o tester os deixou (e o próprio `pnpm test` os reescreve via `tests/ted-f1-baseline.test.ts`/`tests/ted-f1-journeys.test.ts`). O lado A da F2-A não depende deles.

## Cobertura A/B original F2-A (histórico; F2-A.1 descrita no início)

- **60/60 cenários cobertos.** 8 produzem `PASS`: `F1-B001`, `F1-B002`, `F1-B008`, `F1-B012`, `F1-B013`, `F1-B014`, `F1-B030`, `F1-B059`. Os outros **52 são `INCONCLUSIVE`**: 51 sem candidato independente (`no-candidate`) e **`F1-B055` com expectativa comportamental não observável** (`confirmationMustBeSeparateTurn`), reportado com dimensões parciais `match` (intent/operation/args/clarification/needles) mas **nunca PASS global**.
- **10/10 jornadas cobertas**, todas `INCONCLUSIVE`, com `originalCompletion` da F1 preservado; J01 pontua apenas presença de clarificação (`match`), nunca PASS global.
- `financialCompletion` é `'unobservable'` em 100% das linhas: não há ledger, writer nem execução neste POC.
- Classificações originais da F1 atravessam inalteradas em cada linha (teste compara com o baseline da **cópia empacotada** do commit `ef12a8ee…`, não com o working tree).
- Nenhum ganho inventado: o A/B valida o **harness e o parser**, não a qualidade de um modelo.

## Limitações da F2-A original (histórico; evolução F2-A.1 acima)

1. 51/60 cenários não têm candidato ⇒ nenhum sinal sobre eles; não são "PASS por omissão".
2. As fixtures são **autoria manual**, não saída de modelo — a avaliação real de qualidade é F2-B (bloqueada).
3. `undo-proposal` não é representável neste schema (fica `INCONCLUSIVE` por taxonomia); `clarify` **é** representável (com `operation: none`).
4. O registry de leitura é **espelho** de `OPERATION_TO_READ` (não exportado). A paridade é garantida por teste que lê o source de produção; uma reformatação do bloco em `channel-evidence.ts` pode quebrar o teste (falha alta e explícita, por desenho).
5. `targetReference`, `target`, `priorAmountCents`, `correctedAmountCents` existem só no vocabulário conceitual da F1 e são marcados `supportedInProduction: false` — sem paridade de produção alegada.
6. Jornadas não têm oráculo independente global; só o primeiro estágio (`clarify`) é verificável.
7. **Lint:** o stdin **não** é gate de repositório (config ignorado nesse caminho). `pnpm lint` travou 90 s no primeiro workspace (0/5) e fica **pendente de CI**; causa provável é o escopo de `files.includes` na raiz, não comprovada em definitivo. O suplemento com config externo byte-idêntico (10/10 sem diagnóstico, `--write` com stdout byte-idêntico) é evidência auxiliar, **não** substituição do gate.
8. O POC não mede latência, custo nem taxa de erro de modelo algum.
9. `confirmationMustBeSeparateTurn` (F1-B055) não é observável aqui: sem fronteira de turno/confirmação, a linha é **INCONCLUSIVE** com dimensões parciais; não é evidência de que a confirmação separada funciona.
10. O working tree dos dois relatórios F1 é **mutável por design dos testes F1** (`generatedAt`/`harnessElapsedMs`); o POC lê a cópia empacotada do commit `ef12a8ee…` em `frozen/`, com SHA-256 pinado (sem consultar Git em runtime). Corrigir os geradores (não reescrever arquivos rastreados ou separar artefato de execução) é trabalho F1/Planner, fora deste escopo.

## Orçamento e gate F2-B (proposta explícita — NÃO autorizada)

**Provider e modelo: NÃO SELECIONADOS.** Qualquer execução real exige decisão humana registrada. O orçamento abaixo é a proposta a ser aprovada, não uma autorização:

| Limite | Valor proposto |
|---|---|
| Tokens de entrada | ≤ 12 000 por chamada; ≤ 1 000 000 no total |
| Tokens de saída | ≤ 1 000 por chamada; ≤ 81 000 no total |
| Chamadas | ≤ 81 (plano B1 = 77: 60 originais + 7 extensões + 10 turnos; 23 outputs B0 reutilizáveis somente com input idêntico) |
| Concorrência | 1 |
| Retries | 0 |
| Latência por tentativa | 60 s |
| Latência total (wall) | 30 min |
| Custo | ≤ US$ 5,00 |
| Stop conditions | esgotar qualquer teto; tentativa de invocar writer/tool/recurso não autorizado; egress fora da futura allowlist; erro de autenticação; custo/usage não verificável; primeira exceção inesperada. Classificar uma intenção como proposta NÃO é uma tentativa de executar escrita. |
| Pré-requisito | ensaio local sintético completo antes da primeira chamada real |

O run real deve ser read-only e sandboxed (workspace sintético, sem writer financeiro, sem segredos no repo) e reportado com as mesmas regras de honestidade (inconclusivo onde não observável, sem ganho inventado).

## Checklist

- [x] TDD RED registrado antes do GREEN (falha de módulo ausente na primeira execução)
- [x] Runner usa o parser real sobre `llmJson` e converte explicitamente para candidato
- [x] Oráculo F1 congelado em cópias **byte-exact empacotadas** (`tests/poc-structured/frozen/`), proveniência `ef12a8ee…` documentada, SHA-256 pinado e conferido sem Git; working tree mutável nunca é usado para A
- [x] Operações de mutação importadas de `TED_APPROVAL_TOOLS`; args ligados em compile-time
- [x] Paridade: todo op de `TED_APPROVAL_TOOLS` tem schema de args; lookups são own-property
- [x] Espelho de leitura com teste de paridade contra o source de produção
- [x] Wrapper estrito, bounds, keys normalizadas, erro tipado
- [x] Semântica de args exata (`null ≠ ausente`, sem args espúrios, args por operação)
- [x] Centavos inteiros, enums reais, calendário real
- [x] `clarify` representável no schema F2A1 (com `operation none`); undo continua INCONCLUSIVE por taxonomia
- [x] `confirmationMustBeSeparateTurn` não observável ⇒ `F1-B055` INCONCLUSIVE com dimensões parciais (nunca PASS global)
- [x] Jornadas têm PASS de interpretação somente com todos os turnos obrigatórios corretos; conclusão financeira nunca inferida; 5 jornadas retidas separadas
- [x] Corrupções com FAIL exato; sem asserção `PASS or FAIL`
- [x] Namespace real sem superfície de execução; pureza de imports
- [x] `missingFields` e `ambiguities` separados; contexto fornecido obrigatório e reportado por linha
- [x] Slots herdados (`accountName`/`expectedName`/`description`/`yearMonth`) exigem evidência declarada; sem ela ⇒ FAIL (`context-unevidenced-arg:*`)
- [x] Candidato inválido no schema ⇒ FAIL; candidato ausente ⇒ INCONCLUSIVE
- [x] B012: capability indisponível conhecida não é ambiguidade (`['capability']` ⇒ FAIL), `requestedAction budgets.create` preservado e nunca executável
- [x] J05 T2 ligado à primeira opção exibida; J02 sem pergunta redundante
- [x] 46/46 testes focados após as correções finais (19 + 18 + 9) + `pnpm typecheck` exit 0
- [x] `pnpm test` completo **depois** das correções finais: **9218 aprovados** (25 / 2861+172skip / 3466+1skip / 34 / 2832); log `%TEMP%\opencode\f2a1-final-test.log`
- [ ] Lint de repositório (`pnpm lint`): **pendente de CI** — travou 90 s no primeiro workspace (0/5); suplemento Biome com config externo byte-idêntico é auxiliar, não gate
- [x] Gates rápidos após as correções finais: `docs:lint` (17/0), `governance:check`, `capabilities:check`, `write-policy:check`, `test:skip-gate` — todos exit 0
- [ ] Gates agregados restantes/E2E — Planner na integração
- [ ] F2-B — proibida agora; orçamento acima é proposta, não autorização
- [x] Revisão independente final: **APPROVED**, dois findings corrigidos; situação de lint/CI registrada separadamente
