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
- `v1/cases/*.golden.json` — o catálogo como DADOS (16 executáveis +
  6 `pending-capability`).
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
golden v1: total=22 pass=16 fail=0 skipped-pending=6 falseSuccess=0 tokens=unknown cost=unknown
```

Casos `pending-capability` (anexo, PDF, áudio, imagem, web, autoexecute
low-risk) são **pulados explicitamente** e reportados como
`skipped-pending` com o motivo (flag OFF, sem chave, sem binding) —
nunca como `pass`. Executá-los exige a capability provisionada (ver
`pendingReason.requires` em cada caso).

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
4. Rode `pnpm test:golden` e ajuste as contagens pinadas na suíte
   (22/16/6) se o catálogo cresceu de verdade.

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
