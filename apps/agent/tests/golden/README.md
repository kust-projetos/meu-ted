# Golden Workflows — fundação F4 (issue #105)

Framework versionado de Golden Workflows + catálogo de casos como dados +
runner mínimo executável contra backend **isolado** (nunca produção) + saída
machine-readable. Coração: `false-success = HARD FAILURE` (INV-03).

## Onde fica

- `v1/schema.ts` — schema versionado do caso (`version: "1"`) + validador
  runtime. Quebrou o schema? Falha ALTO, nunca roda meio-parseado. v2 vive em
  diretório novo; v1 congela.
- `v1/contract.ts` — contrato de aceite: ações esperadas/proibidas (vocabulário
  fechado), postconditions do backend, resposta aceitável, budget — e o
  detector de falsa confirmação (`registrado/feito/pago/cancelado/...` no
  passado sem execução autoritativa = HARD FAILURE).
- `v1/backend.ts` — backend isolado em memória: ledger de operações com
  semântica de idempotency-key, entidades semeadas, evidence provider
  determinístico, stub de provedor sem alegações. O `MutationApiClient`,
  o executor e o orquestrador são código de produção; só o transporte é
  dobrado. Zero rede, zero credencial, zero dinheiro real, zero LLM.
- `v1/runner.ts` — executa a sequência de inputs pelo orquestrador real
  (com o `routeIntent` real, sem override de plano), reduz cada turno ao
  vocabulário fechado e aplica o contrato.
- `v1/reporters/json.ts` — relatório machine-readable. `tokens`/`cost` são
  `"unknown"` de propósito: o stub é determinístico, nenhuma chamada de
  modelo acontece, então não há nada para contar — nunca inventar.
- `v1/cases/*.golden.json` — o catálogo como DADOS (33 executáveis +
  6 `pending-capability`). Os ids GW-029–GW-032 são reservados à suite
  autoritativa PostgreSQL
  (`apps/api/tests/integration/golden-agent-real-api.test.ts`) para manter
  os ids golden únicos entre suites.
- `golden.test.ts` — a suíte: schema + controles negativos do detector +
  subset executável + relatório.

## Como rodar

```bash
# do repo root
pnpm --filter pi-finance-agent test:golden
# ou, dentro de apps/agent
pnpm test:golden
```

Saída machine-readable: `apps/agent/test-results/golden-report.json`
(diretório gitignored — evidência, não fonte). Resumo no console:

```text
golden v1: total=39 pass=33 fail=0 skipped-pending=6 falseSuccess=0 tokens=unknown cost=unknown
```

O `golden-report.json` da corrida de 10/10/2026 traz, além do resumo acima,
`providerCalls=2` (stubs determinísticos — nenhuma chamada de modelo real);
`tokens`/`cost` seguem `"unknown"` por construção (não há nada para contar, e
número nunca é inventado). `latencyMs` é wall-clock da corrida isolada e varia
por execução — não é métrica de qualidade.

Casos `pending-capability` são **pulados explicitamente** e reportados como
`skipped-pending` com o motivo — nunca como `pass`. **Cada caso tem o seu
motivo específico**, descrito em `pendingReason.reason`/`requires`: o estado
`pending-capability` de um caso **não** implica que flag, chave ou binding
estejam universalmente OFF (ex.: GW-018/GW-019 têm flag `1` e secret
provisionada em produção e seguem pending porque o **aceite completo** está
pendente; provas sintéticas parciais de STT/Vision foram realizadas em 08/10,
mas o runner isolado nunca faz egress nem valida o pipeline real. Na corrida de
10/10/2026 são seis, e **não foram promovidos**: GW-016 (anexo), GW-017 (PDF),
GW-018 (áudio/STT), GW-019 (imagem/Vision), GW-020 (web) e GW-021
(autoexecute low-risk). Executá-los exige a capability provisionada e aceita
(ver `pendingReason.requires` em cada caso).

## Como adicionar um caso

1. Acrescente o objeto ao `*.golden.json` do grupo (ou crie um novo
   `v1/cases/<grupo>.golden.json` com `{ "version": "1", "cases": [...] }`).
2. Campos: `id` (único, `GW-NNN`), `title`, `workflow`, `status`,
   `initialState` (contas/categorias/memórias/leituras/falhas),
   `inputs` (texto + `intentionId`; repita o id para modelar redelivery),
   `expectations` (ações do vocabulário fechado, postconditions
   `proposalsCreated`/`executionsSucceeded`/`maxLedgerEntries`/
   `reuseOperationId`, regexes de resposta, `budget.maxTurns`,
   opcional `plan.skillsContain`).
3. Sem capability disponível? `status: "pending-capability"` com
   `pendingReason: { capability, reason, requires }` — o runner pula e
   reporta; fingir cobertura com caso falso é proibido.
4. Rode `pnpm test:golden`. A suíte falha se qualquer caso executável falhar
   ou se houver `false-success`. O **resumo** impresso e o `golden-report.json`
   são derivados do catálogo pelo reporter, não hard-coded; já as asserções de
   `golden.test.ts` (linhas 47-51) **pinam a cardinalidade do catálogo**
   (`39` casos / `33` executáveis / `6` `pending-capability`): ao acrescentar
   casos genuínos, atualize esses `expect` junto com os dados.
5. Harness por turno (GW-040/GW-042): `inputs[n].workspaceId` (default
   `"ws-golden"`, só ids sintéticos `ws-golden*`) roteia a identidade do
   turno; `inputs[n].readFault` (`statusCode` e/ou `timeout`) injeta um fault
   de leitura classificado pelo `classifyReadFailure` real. O runner registra
   o bucket como `read_failed_retryable`/`read_failed_forbidden` (observação
   do harness — a resposta de produção é a mesma cópia fail-closed em todos
   os buckets, por desenho). Campos opcionais e aditivos: casos v1 sem eles
   rodam byte a byte como antes (nenhum `v2/` exigido para esta evolução).

## Regras do harness

- NUNCA backend de produção, mutação financeira real, rede externa ou LLM
  com custo. O oráculo é determinístico.
- Uma alegação de sucesso no passado (`registrado`, `pago`, `esqueci`, …)
  sem efeito autoritativo correspondente = falha dura do caso, mesmo que
  todo o resto tenha passado.
- O que conta como alegação (`detectSuccessClaim`): **todas** as ocorrências
  de cada padrão passado/participial são examinadas; basta UMA ocorrência
  afirmativa para haver alegação. A negação (`não/nem/nunca/jamais/sem`)
  ancora-se à **mesma sub-oração** da ocorrência (trecho desde a pontuação de
  fronteira anterior — `. ! ? ; ,` nova-linha `:` `—` `–` parênteses — ou desde
  a última conjunção adversativa/contrastiva — `mas`, `porém`, `contudo`,
  `entretanto`, `no entanto`, `embora`, `apesar de`, `todavia` — até o
  match), nunca a uma janela fixa cega de caracteres; só a negação que
  PRECEDE o match suprime (negação após o match não ancora para trás), e
  idiomas de tranquilização cuja negação rege outro verbo (`sem problemas`,
  `não se preocupe`) nunca suprimem. Assim, "Não consegui consultar o saldo
  mas o lançamento foi registrado.", "Sem problemas o lançamento foi
  registrado.", "Não registrado. Agora registrado." e "Não se preocupe,
  registrado." SÃO alegações, enquanto "Não foi registrado", "Não foi
  possível registrar" e "o lançamento não foi registrado" NÃO são (negação
  ligada ao predicado de sucesso na mesma sub-oração).
- Correspondência temporal e por operação: o runner fotografa os efeitos
  autoritativos APÓS CADA TURNO (`executionsSucceededAfterTurn` /
  `executedOperationIdsAfterTurn`) e o contrato valida cada alegação contra
  a foto do PRÓPRIO turno — nunca contra o agregado pós-todos-os-turnos. A
  alegação só é legítima se a operação correspondente já executou EM TURNO
  ANTERIOR OU NO MESMO TURNO antes da resposta; alegar sobre a operação X
  quando só a operação Y executou continua `false-success` (fala prematura
  que um turno posterior confirma NÃO é legitimada retroativamente).
- Proposta NÃO é execução: só `executionsSucceeded > 0` legitima
  "Lançamento registrado com sucesso."
- Cancelamento tem via PRÓPRIA: "Operação cancelada com segurança." só é
  legítima com cancelamento autoritativo correspondente
  (`cancellationsAfterTurn > 0`) — execução NUNCA legitima "cancelada" e
  cancelamento NUNCA legitima "registrado". Casos da matriz
  confirmação/cancel (`confirmation-cancel.golden.json`): GW-023
  (propor→confirmar→executar, claim legítima), GW-024
  (propor→cancelar, zero execuções) e GW-025 (confirmar-sem-proposta,
  resposta determinística sem efeito).
- Cancelar sem nada pendente NÃO é "cancelada": `resolveCancel` devolve
  `empty` e o turno responde o no-op determinístico ("Não há nenhuma
  operação pendente para cancelar."), sem palavra de claim. Casos
  (`cancel-edge.golden.json`): GW-026 (duas propostas + "cancela" →
  desambiguação, nada cancelado) e GW-027 (cancela sem pendência →
  no-op determinístico, zero efeitos).

## Limites — o que este harness NÃO prova

- **Backend isolado em memória**: sem API, sem Postgres, sem rede, sem
  credencial e sem dinheiro real. O `MutationApiClient`, o executor e o
  orquestrador são código de produção, mas só o transporte é dobrado — não há
  integração com o caminho real de produção.
- **Provider é stub determinístico**: `providerCalls=2` na corrida de
  10/10/2026; `tokens` e `cost` são `"unknown"` por construção — nenhuma
  chamada de modelo aconteceu, então não há nada para contar, e número nunca é
  inventado. `latencyMs` é wall-clock da corrida isolada e varia por execução.
- **Corrida verde não é aceite de v1**: a issue #105 segue **OPEN**; workflows
  e invariantes completos ainda dependem de execução e aceite do operador. Um
  smoke autenticado em produção (chat/leitura PASS, zero mutação) **não**
  promove nenhum caso `pending-capability`: PDF, STT, Vision, web e
  autoexecute seguem sem prova live nesta disciplina.
