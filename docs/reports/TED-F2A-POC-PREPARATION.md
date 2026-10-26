# TED F2-A POC — relatório de preparação (sem avaliação com modelo real)

> **Status:** POC implementada, local-only, em branch `feat/ted-f2a-structured-interpretation` (arquivos ainda não commitados). **F2-B (avaliação com modelo real) é PROIBIDA nesta tarefa** e continua gateada (ver "Orçamento e gate F2-B"). Sem provider/rede, sem DB, sem SDK, sem execução financeira, sem alteração de permissões, sem mudança de produção/F1/deps/config, sem commit/push.
>
> Baseline: `HEAD = ef12a8ee7e4ef6c215bffce755e1d7c68c89820e`.
>
> **Correção de integração (2026-10-26):** o runner lia os artefatos F1 do **working tree**, que é mutável (`generatedAt`/`harnessElapsedMs` são reescritos a cada execução dos próprios testes F1), causando falha determinística no `pnpm test`. A seção "Correção de integração F2-A" abaixo registra os quatro defeitos corrigidos e a evidência RED→GREEN. Uma segunda rodada (portabilidade CI) empacotou os artefatos congelados e removeu o `git show` do runtime — ver "Portabilidade CI — artefatos congelados empacotados".

## Escopo e ownership

Alterações limitadas aos caminhos novos abaixo; nenhum arquivo rastreado foi editado por esta correção:

- `apps/agent/src/poc-structured/`
- `apps/agent/tests/poc-structured/`
- `docs/reports/TED-F2A-POC-PREPARATION.md`

`git status` mostra esses três como untracked e, além deles, apenas os dois relatórios F1 já modificados pelo tester (`ted-f1-baseline.json`, `ted-f1-journeys.json`), que **não** foram tocados/restaurados aqui.

Nada de produção, F1, dependências, configs ou workflows foi tocado. Os dois relatórios F1 rastreados (`ted-f1-baseline.json`, `ted-f1-journeys.json`) foram regenerados pelos próprios testes F1 e **não foram restaurados nem editados aqui** (preservados para o Planner restaurar); a correção F2-A lê as cópias empacotadas do commit congelado e não depende do estado deles.

## Correção de integração F2-A (defeitos encontrados pelo tester) — 4/4

| # | Defeito | Correção aplicada |
|---|---|---|
| 1 | O runner pinava SHA-256 mas lia os arquivos do **working tree**; os geradores F1 reescrevem `generatedAt` e `harnessElapsedMs`, então `pnpm test` falhava de forma determinística (`01d7aff4…`/`594d342d…` no worktree vs. `5bdc2be4…`/`ca89250a…` pinados) | Novo `tests/poc-structured/frozen-artifacts.ts`: valida o commit com `git rev-parse --verify ef12a8ee…^{commit}`, lê cada artefato com `git show ef12a8ee…:<path>` e confere o SHA-256 dos bytes **do commit** antes de parsear (posteriormente trocado por cópias empacotadas — ver "Portabilidade CI"). O working tree nunca é consultado para o lado A. Dois testes fixam `generatedAt` do commit (`2026-10-24T17:16:20.203Z` / `…25.399Z`), provando que o corpo vem do commit e não de um relatório regenerado. |
| 2 | Nenhuma asserção garantia que **toda** operação de `TED_APPROVAL_TOOLS` tivesse schema de args; lookups de `ARG_SPECS`/`OPERATION_ARG_KEYS` usavam a cadeia de protótipos (`key in ARG_SPECS`, `ARG_SPECS[key]`), aceitando `toString`/`constructor`/`__proto__` como vocabulário | `registry.ts` exporta `getArgSpec` e `hasOperationArgSchema` com `Object.prototype.hasOwnProperty.call`; parser e comparador usam esses acessos. Teste `RED-05` percorre `TED_APPROVAL_TOOLS` (todo op tem schema não vazio), exige spec própria para cada chave aceita em cada operação e rejeita `toString`/`constructor`/`hasOwnProperty`/`__proto__` com `args-unknown-key`. |
| 3 | `F1-B055` era reportado **PASS global** embora seu oráculo carregue `confirmationMustBeSeparateTurn: true`, comportamento que este POC não observa (sem fronteira de turno, sem protocolo de confirmação, sem ledger) | `ab-compare.ts` declara `F1_UNOBSERVABLE_EXPECTATION_KEYS`; uma linha com expectativa comportamental não observável vira **INCONCLUSIVE** com razão `f1-expectation-unobservable:confirmationMustBeSeparateTurn` e dimensões parciais explícitas (`intent/operation/args/clarification/needles = match`). Nunca PASS global. |
| 4 | A alegação de lint era "não executado (hang)" | Lint verificado por **stdin**, sem varrer diretórios e sem alterar config: `biome lint --write --stdin-file-path=<path>` e `biome check --write --stdin-file-path=<path>` com input via `node:child_process` (sem encoding do PowerShell). 7/7 arquivos novos: exit 0, stdout idêntico ao arquivo, disco intocado. O formatter está **desabilitado** no config do repo (por isso `biome format`/`check` sem `--write` sinalizam "contents aren't fixed"); isso é lint limpo, não um gate de formatação. |

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
- `apps/agent/tests/poc-structured/fixtures.ts` — 10 fixtures candidate-only (9 cenários + J01).
- `apps/agent/tests/poc-structured/frozen-artifacts.ts` — loader read-only dos artefatos F1 empacotados em `frozen/` (verificação de SHA-256 a cada load; sem Git em runtime).
- `apps/agent/tests/poc-structured/frozen/{scenarios,journeys,baseline}.json` — cópias byte-exact dos blobs do commit `ef12a8ee…` (snapshot autorizado; SHA-256 pinado no loader).
- `apps/agent/tests/poc-structured/f2a-structured-interpretation.test.ts` — 16 testes (adapter, registry/own-property, pureza, namespace).
- `apps/agent/tests/poc-structured/f2a-ab-runner.test.ts` — 8 testes (hashes pinados, corpo empacotado, ausência de dependência de Git, veredictos exatos, corrupções, expectativa não observável, taxonomias, jornadas, pureza do runner).
- Total focado: **24/24**. A suíte completa do Agent também passa a cobri-los (3443 passed / 1 skipped).

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

# lint por stdin nos 2 arquivos TS alterados
biome lint  --write --stdin-file-path=<arquivo>  × 2 → exit 0, stdout idêntico
biome check --write --stdin-file-path=<arquivo>  × 2 → exit 0, stdout idêntico
(disco intocado: hash antes = depois)
```

### Suíte completa (duas execuções sequenciais)

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
→ exit 0 (54.9s), 4 workspaces (llm-contracts, api, agent, pwa, broker) sem erro

# lint por stdin (sem varrer diretórios, sem alterar config, input via node:child_process)
biome lint  --write --stdin-file-path=<arquivo>   × 7 arquivos novos → 7/7 exit 0
biome check --write --stdin-file-path=<arquivo>   × 7 arquivos novos → 7/7 exit 0
→ stdout idêntico ao arquivo em todos; disco intocado (hash antes = depois)
```

- `biome format`/`check` sem `--write` em stdin reportam "contents aren't fixed" porque o **formatter está desabilitado** no config do repo; com `--write` (que em stdin apenas ecoa) o resultado é idêntico e exit 0 — ou seja, lint limpo, sem gate de formatação.
- Agregado original do baseline (commit congelado) conferido por leitura: `PASS 12 / FAIL 41 / BLOCKED 1 / INCONCLUSIVE 6` (60 cenários). O worktree, regenerado pelos testes F1, mantém as mesmas 60 classificações; só `generatedAt`/`harnessElapsedMs` mudam.
- Os dois relatórios F1 rastreados **não foram restaurados nem editados** nesta correção: foram preservados no estado em que o tester os deixou (e o próprio `pnpm test` os reescreve via `tests/ted-f1-baseline.test.ts`/`tests/ted-f1-journeys.test.ts`). O lado A da F2-A não depende deles.

## Cobertura A/B e postura honesta

- **60/60 cenários cobertos.** 8 produzem `PASS`: `F1-B001`, `F1-B002`, `F1-B008`, `F1-B012`, `F1-B013`, `F1-B014`, `F1-B030`, `F1-B059`. Os outros **52 são `INCONCLUSIVE`**: 51 sem candidato independente (`no-candidate`) e **`F1-B055` com expectativa comportamental não observável** (`confirmationMustBeSeparateTurn`), reportado com dimensões parciais `match` (intent/operation/args/clarification/needles) mas **nunca PASS global**.
- **10/10 jornadas cobertas**, todas `INCONCLUSIVE`, com `originalCompletion` da F1 preservado; J01 pontua apenas presença de clarificação (`match`), nunca PASS global.
- `financialCompletion` é `'unobservable'` em 100% das linhas: não há ledger, writer nem execução neste POC.
- Classificações originais da F1 atravessam inalteradas em cada linha (teste compara com o baseline da **cópia empacotada** do commit `ef12a8ee…`, não com o working tree).
- Nenhum ganho inventado: o A/B valida o **harness e o parser**, não a qualidade de um modelo.

## Limitações conhecidas (honestas)

1. 51/60 cenários não têm candidato ⇒ nenhum sinal sobre eles; não são "PASS por omissão".
2. As fixtures são **autoria manual**, não saída de modelo — a avaliação real de qualidade é F2-B (bloqueada).
3. `clarify` e undo-proposal não são representáveis neste schema; ficam `INCONCLUSIVE` por construção.
4. O registry de leitura é **espelho** de `OPERATION_TO_READ` (não exportado). A paridade é garantida por teste que lê o source de produção; uma reformatação do bloco em `channel-evidence.ts` pode quebrar o teste (falha alta e explícita, por desenho).
5. `targetReference`, `target`, `priorAmountCents`, `correctedAmountCents` existem só no vocabulário conceitual da F1 e são marcados `supportedInProduction: false` — sem paridade de produção alegada.
6. Jornadas não têm oráculo independente global; só o primeiro estágio (`clarify`) é verificável.
7. Lint coberto por stdin (`lint --write`/`check --write`): 7/7 limpos. O job agregado `pnpm lint` continua sendo gate do Planner/CI; o formatter está desabilitado no config e não é um requisito deste POC.
8. O POC não mede latência, custo nem taxa de erro de modelo algum.
9. `confirmationMustBeSeparateTurn` (F1-B055) não é observável aqui: sem fronteira de turno/confirmação, a linha é **INCONCLUSIVE** com dimensões parciais; não é evidência de que a confirmação separada funciona.
10. O working tree dos dois relatórios F1 é **mutável por design dos testes F1** (`generatedAt`/`harnessElapsedMs`); o POC lê a cópia empacotada do commit `ef12a8ee…` em `frozen/`, com SHA-256 pinado (sem consultar Git em runtime). Corrigir os geradores (não reescrever arquivos rastreados ou separar artefato de execução) é trabalho F1/Planner, fora deste escopo.

## Orçamento e gate F2-B (proposta explícita — NÃO autorizada)

**Provider e modelo: NÃO SELECIONADOS.** Qualquer execução real exige decisão humana registrada. O orçamento abaixo é a proposta a ser aprovada, não uma autorização:

| Limite | Valor proposto |
|---|---|
| Tokens de entrada | ≤ 12 000 por chamada; ≤ 1 000 000 no total |
| Tokens de saída | ≤ 1 000 por chamada; ≤ 81 000 no total |
| Chamadas | ≤ 81 (60 cenários + 21 turnos de jornada) |
| Concorrência | 1 |
| Retries | 0 |
| Latência por tentativa | 60 s |
| Latência total (wall) | 30 min |
| Custo | ≤ US$ 5,00 |
| Stop conditions | esgotar qualquer teto; qualquer tentativa de escrita financeira não-`none`; qualquer egress fora da allowlist; erro de autenticação; primeira exceção inesperada |
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
- [x] `clarify`/undo sempre `INCONCLUSIVE`
- [x] `confirmationMustBeSeparateTurn` não observável ⇒ `F1-B055` INCONCLUSIVE com dimensões parciais (nunca PASS global)
- [x] Jornadas sem PASS global; F1 completion preservado
- [x] Corrupções com FAIL exato; sem asserção `PASS or FAIL`
- [x] Namespace real sem superfície de execução; pureza de imports
- [x] 24/24 testes focados + `pnpm typecheck` (workspace, exit 0) PASS
- [x] `pnpm test` completo 2× sequencial, exit 0 e contagens idênticas (logs em `%TEMP%\opencode`)
- [x] Lint por stdin (`lint --write`/`check --write`): 7/7 limpos, sem alterar config nem arquivos
- [ ] Gates agregados `pnpm lint`/`docs:lint`/`governance:check`/E2E — Planner na integração
- [ ] F2-B — proibida agora; orçamento acima é proposta, não autorização
