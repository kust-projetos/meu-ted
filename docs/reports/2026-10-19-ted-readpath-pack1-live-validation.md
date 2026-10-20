# TED read-path pack F1–F4 — validação live (2026-10-19)

## Objetivo

Fechar o pack TED read-path F1–F4 com validação em produção (Agent/PWA em
`04b36c3`), sem escrita financeira: confirmar que turnos de leitura
determinística persistem no histórico, que ausência de dado responde com
cópia honesta e que compra sem valor não fabrica mutação.

## Decisões do pack (F1–F4)

- **F1 — persistência do usuário em leitura determinística:** turnos de
  leitura (read-only) passam a ser persistidos no histórico da conversa,
  preservando contexto entre turnos e reload.
- **F2 — ausência usa "faturas" para cartões:** quando não há dados de
  cartão, a resposta usa o vocabulário "faturas" ("Ainda não encontrei
  faturas aqui…"), em vez de narrar vazio genérico.
- **F3 — léxico "comprei" + guarda de parcelamento:** o verbo "comprei" é
  reconhecido como intenção de compra, com guarda explícita de
  parcelamento antes de qualquer mutação.
- **F4 — gate determinístico de valor ausente:** compra sem valor
  identificável retorna a cópia exata "Não identifiquei o valor a
  registrar. Informe o valor e a descrição.", sem propor mutação.
- **Exceção `channel==='sdk'` removida:** o broker Codex tool-less também
  exige valor — o gate de valor ausente vale para todos os canais.

## PR #258 + CI

- Branch `fix/ted-readpath-pack1` (commit `89bae71`) → squash `04b36c3`
  em 2026-10-19.
- CI do PR: **18/18 SUCCESS** (e2e flake PWA-05 conhecido, verde após
  `rerun --failed`).

## Deploys + attestation + smokes

- 1º par `workflow_run` com deploy-skipped (corrida conhecida:
  `39240889489`/`392408894xx`); par real executou deploy + smoke +
  attestation.
- **Agent Deploy run `39341083692` ATTESTED `sha=04b36c3`**; **PWA Deploy
  run `39341083213` ATTESTED `sha=04b36c3`** (buildId `39340176734`).
- CI main `39340176744` verde; PWA CI `39340176734` verde.
- Smokes live pós-deploy: Agent `/health` ready com
  `buildSha=04b36c3`; PWA `/api/build-info` com `gitSha=04b36c3`; API
  `/health` com `gitSha=0405fba` (sem redeploy — inalterada) + `/ready`
  ready.

## Validação live (Test Family `550e8400-…`, sem escrita financeira)

Harness Playwright temporário (removido após a execução), tester
independente **PASS — 1 passed, 25,5 s** em `04b36c3`:

| Caso | Entrada | Resultado esperado | Observado |
|------|---------|--------------------|-----------|
| F4 | compra sem valor | copy exata "Não identifiquei o valor a registrar. Informe o valor e a descrição." | PASS (copy exata) |
| F2 | "liste meus cartões" | "Ainda não encontrei faturas aqui…" | PASS |
| F1 | leitura + reload | turno de leitura persiste no histórico | PASS |
| Integridade | todos os turnos | zero card, zero pageerror, zero console error, zero 5xx | PASS |

Screenshots em `apps/pwa/test-results/live-pack1/` (01/02/03,
gitignored — não versionados).

### Lição de método: marcador com dígitos vira "valor"

O 1º harness usou marcador `pack1<RUN_ID>` contendo dígitos e o parser
interpretou os dígitos como valor monetário (probe local:
"…pack1mvfwb308…" → `candidate`/`amountCents=100`; marcador alfabético
"qzabc" → `unparsed`/`missing_amount`). A evidência foi invalidada e
refeita com `RUN_LETTERS` (dígitos convertidos para letras a–j).
Regra: marcadores de teste live devem ser puramente alfabéticos.

## Teste unitário/integração (resumo)

Cobertura do pack em `ted-readpath-pack1.test.ts` (matriz F1–F4 RED→GREEN)
+ `cognitive-wiring.test.ts` (fiação do orquestrador). Suites do Agent
verdes no PR #258; CI 18/18 SUCCESS.

## Pendências (não bloqueiam este closure)

- **#255** — compra sem valor: follow-up com valor não retoma a mutação
  (reteste manual pendente).
- **#256** — total mensal responde extrato (aberta).
- **#257** — "liste cartões" lê statements (aberta).
- **#254** — Release B: bearer legado (gate ~24/10, operador).
- Reteste manual dos casos F1–F4 com modelo real fora do harness.

## Arquivos tocados pelo pack

- `apps/agent/src/conversation-orchestrator.ts`
- `apps/agent/src/financial-parser.ts`
- `apps/agent/src/finance-chat-agent.ts`
- `apps/agent/src/ted-readpath-pack1.test.ts`
- `apps/agent/src/cognitive-wiring.test.ts`
