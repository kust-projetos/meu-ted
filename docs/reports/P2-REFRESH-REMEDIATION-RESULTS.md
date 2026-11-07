# MEU TED — P2 Refresh Remediation Results (P2-R-FIX3)

**Data:** 2026-11-01
**Veredito:** **P2_REFRESH_PARTIAL**
**Worktree:** `D:/projetos/pi-ted-opencode-product`
**Branch:** `feat/ted-opencode-product` (checkout dirty preservado; nada fora do escopo foi tocado)
**Tarefa:** P2-R-FIX3 — corrigir duas questões finais de precisão/cobertura do candidato P2-R sem alterar o comportamento de `src/` já revisado (nenhum defeito novo exposto; nenhuma edição de `src/` feita nesta rodada).

## Causa confirmada (fronteira de classificação, não o SDK exato)

No live P2 (`docs/reports/P2-LIVE-CLOSURE-RESULTS.md`), um `POST /rpc/chat` retornou **200** com a resposta financeira correta e o `GET /rpc/history` seguinte retornou **502 `prompt.failed`**, com a PWA exibindo “Não foi possível carregar o histórico”.

A causa isolada está na classificação, em `apps/ted-runtime/src/prompt.mjs` + `apps/ted-runtime/src/server.mjs` — a P2-R-FIX2 fechou as 5 frestas apontadas pelo Reviewer/Security sobre o fix anterior (detalhe abaixo); a P2-R-FIX3 corrige precisão dos testes e do relatório, sem mudar `src/`:

1. **Vazamento de detalhe nativo:** `classifyHistoryFailure` embutia `e.message` bruto e `errorPayload` o devolvia ao browser. Agora: mensagem fixa `HISTORY_UNAVAILABLE_MESSAGE` nas duas camadas (adapter + gateway, defense in depth) — o texto nativo do SDK **não é retornado ao cliente**. (Correção de relatório: nenhum log novo foi adicionado; não se afirma que o detalhe vá para log server-side.)
2. **Superfície ausente mal classificada:** `readHistory`/`readRawMessages` lançavam `provider.unavailable` quando `message.list` não existe — um erro de superfície de histórico, não de provider. Agora: `history.unavailable`.
3. **Repassagem cega de `PromptError`:** o classificador repassava todo `PromptError` inalterado, de modo que um `prompt.failed`/`provider.*` lançado durante o GET permanecia wrong-origin. Agora: só `history.unavailable`, `prompt.invalid_args` e o `prompt.history_overflow` existente passam; o resto vira `history.unavailable` sanitizado. O caminho de turno (admit/poll) continua com `classifyPromptFailure`, preservando `prompt.failed`/502 genuíno.
4. **Outer catch do `handleHistory`:** falha não tipada do safe-wrapper/`session.get` (ex. sessão nativa ausente após o lookup no registry) caía em `gateway.upstream_error`/502 genérico. Agora: `normalizeHistoryError` sanitiza para `history.unavailable`/503, preservando auth 401/403, conversa ausente 404, timeout 504, cancel 499, quarantine/conflict 409, `invalid_args` 400 e `history_overflow`. O caminho de chat é intocado (falha de estabelecimento antes de qualquer admissão continua 502 genérico — fora do escopo do achado).
5. **Cobertura de integração (FIX3 reescrito com precisão):** sessão nativa ausente após o lookup, resposta do assistente ainda não persistida (agora em **um único `chat()`**: admissão uma vez, linha do assistente pousa durante o mesmo polling, `admissions === 1` — sem segundo `prompt`, sem função `releaseAssistant` inexistente), wrong-origin tipado, superfície ausente; identidade sintética própria (`test-actor-p2-refresh` / `test-device-p2-refresh-01`), sem copiar ids do trace sintético live. **Quarentena de binding** (`host_binding_quarantined` no wrapper) tem caso próprio: 409 tipado, sem alcançar `readHistory`, sem `session.prompt` — **distinto** da revogação de device-token (nível identidade, 401 antes de qualquer uso nativo).

**Limite da alegação (R01 contido):** o erro nativo exato do SDK que quebrou o `GET` live **não foi recuperado** — o SQLite original do OpenCode e o trace de request/erro estão ausentes, e `opencode.log` não contém entrada correspondente. A correção prova a fronteira de classificação (histórico ≠ prompt), não o defeito SDK subjacente.

## Correção (mínima, sem arquitetura — `src/` da FIX2, intocado na FIX3)

- `apps/ted-runtime/src/prompt.mjs`
  - Novo `HISTORY_UNAVAILABLE_MESSAGE` (fixa, sem detalhe nativo; exportada para teste e gateway).
  - `classifyHistoryFailure(e)`: passthrough só para `history.unavailable`, `prompt.invalid_args`, `prompt.history_overflow`; qualquer outro `PromptError` (`prompt.failed`, `provider.*`, …) e qualquer erro não tipado viram `history.unavailable` com a mensagem fixa.
  - `readHistory()` e `readRawMessages()`: superfície ausente (`rows === null`) agora lança `history.unavailable` (antes `provider.unavailable`); página ilegível após conteúdo parcial usa a mensagem fixa.
- `apps/ted-runtime/src/server.mjs`
  - `errorPayload()`: código `history.unavailable` sempre retorna a mensagem fixa, mesmo que o erro tipado carregue texto nativo.
  - Novo `normalizeHistoryError()`: usado **só** no outer catch do `handleHistory`; preserva auth/conversa/400s/409s/499/504/`history_overflow`, normaliza o resto (incl. `prompt.failed`, `provider.*`, `gateway.upstream_error`, não tipados) para `history.unavailable`/503 sanitizado.
  - `toStatus()`: `history.unavailable` → **503** (inalterado desde P2-R-FIX).

## Origem live e fixture sanitizada

- Fonte: traces e captura temporários da campanha anterior, mantidos fora do repositório; caminhos locais e identificadores opacos foram omitidos desta cópia pública. Os arquivos originais **não foram incluídos nem modificados**.
- `POST /rpc/chat` **200** (`x-ted-runtime=opencode`), `session.prompt` **1×** (agente `ted`, texto aprovado), provider com **2 requests** chat-completions; tools `list_accounts` + `get_month_summary(yearMonth=2026-06)` succeeded; API retornou 2 contas e `expenseCents=11750`.
- Registro persistido (`conversations.json`): IDs de conversa, sessão, intenção e mensagens omitidos nesta cópia pública; estado **completed**, `messageCount=1`.
- Resposta visível (screenshot, transcrita como aproximação — o texto nativo exato é irrecuperável): contas ativas (Conta sintética principal, banco, R$ 2.500,00; Reserva sintética, R$ 500,00), junho/2026 com gastos **R$ 117,50** (2 transações), receitas R$ 0,00, resultado −R$ 117,50, e follow-up oferecendo detalhar.
- Fixture: `apps/ted-runtime/tests/fixtures/p2-captured-turn.json` (valores sintéticos e limitações explícitas). A rodada FIX3 a preservou intocada; nesta preparação para publicação, caminhos locais e identificadores opacos foram substituídos por placeholders sintéticos, sem mudar os asserts de recuperação.
- **A0:** nenhum fluxo A0 foi exercido live nesta tarefa (relatório live: upstream A0 temporário apontava para B, que não implementa as rotas A0 — `A0_NOT_CONFIGURED_IN_HARNESS`) e **nenhum E2E real de A0 foi executado**. O que existe são **contract doubles com flag A0-OFF**: os testes de contrato P2 do PWA (`TedOpencodeP2.contract.test.ts`, `route.p2-runtime.test.ts`) e os testes de gateway B executam apenas doubles com a flag A0 desligada — provam o contrato B, nunca o caminho A0 real.

## Evidência executada (sem inferência de provider)

| Área | Comando | Resultado |
|---|---|---|
| RED (FIX2, antes do fix de `src/`) | `node --test tests/p2-history-refresh.test.mjs` (em `apps/ted-runtime`) | **3 FAIL / 4 PASS** — superfície ausente `provider.unavailable` em vez de `history.unavailable`; sessão nativa ausente `502` em vez de 503; wrong-origin `prompt.failed` `502` em vez de 503 |
| GREEN (FIX2, após o fix) | mesmo comando | **7/7 PASS** |
| FIX3 (precisão, sem edição de `src/`) | mesmo comando | **9/9 PASS direto, sem RED** — os novos invariantes (single-`chat()` com `admissions === 1`; quarentena 409 sem alcançar o read) já eram atendidos pelo código revisado; nenhum defeito novo exposto, nenhuma edição de `src/` feita (conforme a regra da tarefa: sem bug provado, sem tocar `src/`) |
| Runtime completa | `node --test tests/` (em `apps/ted-runtime`) | **143/143 PASS**, 19 suítes, 0 skips |
| Runtime lint/typecheck | `pnpm --filter pi-finance-ted-runtime lint` + `typecheck` | **PASS** (`node --check` nos 11 módulos) |
| PWA reload (arquivo modificado pela tarefa, +1 teste P2) | `pnpm vitest run src/features/ted/__tests__/TedChat.reload.test.tsx --pool=forks --maxWorkers=1` (em `apps/pwa`) | **8/8 PASS** (7 existentes + 1 P2-R-FIX de caracterização: POST sucesso + refresh falho mantém resposta visível, sem retry de envio) |
| PWA P2 focal (5 arquivos) | `pnpm vitest run src/features/ted/__tests__/TedOpencodeP2.contract.test.ts src/lib/api/__tests__/agent-client.p2.test.ts src/features/ted/__tests__/TedChat.p2-cancel.test.tsx src/lib/api/ted-runtime-view.test.ts src/app/api/agent/[...path]/route.p2-runtime.test.ts --pool=forks --maxWorkers=1` (em `apps/pwa`) | **69/69 PASS**; tests de contrato + rota P2 isolados: **48/48 PASS** |
| API gateway/read-slice | `pnpm --filter meu-ted-api exec vitest run tests/integration/ted-runtime-gateway-auth.test.ts tests/integration/ted-runtime-read-slice.test.ts --reporter=dot` | **8/8 PASS** |
| PWA typecheck | `pnpm --filter pwa typecheck` | **PASS** |
| Root docs:lint | `pnpm docs:lint` | **PASS**, 17 docs verificados, 0 issues |
| Root governance:check | `pnpm governance:check` | **PASS**, nenhuma mudança D01–D19 detectada |
| Root typecheck (isolado, timeout 900000 ms) | `pnpm typecheck` | **PASS** em llm-contracts, API, PWA, Agent, broker, TED runtime (Node emitiu warning pré-existente DEP0190; nenhuma falha de tipo/teste) |
| Root lint (isolado, timeout 900000 ms) | `pnpm lint` | **TIMED OUT — nem pass nem failure**: ainda no primeiro estágio (`@pi-finance/llm-contracts lint` / `biome check src`) ao fim dos 900 s; estágios restantes não alcançados. (Histórico P2 registra timeout >600 s do Biome da API; esta execução encerrou aos 900 s.) |
| `pnpm test` agregado (root) | **NÃO executado** — os JSONs F1 rastreados atuais são regenerados por ele; preservá-los tem prioridade | — |

Controle de inferência: nenhum `session.prompt` real, nenhum provider, nenhum browser-model, nenhuma rede além de loopback. O double de prompt conta **1 admissão** no chat; o histórico jamais o incrementa (assert em teste). Nenhum comando capaz de disparar inferência foi executado.

## Cobertura por critério

1. **Test-first:** RED observado na FIX2 (3 falhas, uma por achado 2/3/4) antes de qualquer edição de `src/`; GREEN após o fix. Na FIX3 não houve RED — os invariantes novos já passavam no código revisado (comportamento correto preservado, não regressão mascarada: o teste single-`chat()` assert `reads >= LAND_AFTER_READS` + `admissions === 1`, provando que o atraso foi exercido no mesmo polling; o teste impaciente leva ~300 ms até o deadline). Nenhuma falha de fixture/setup foi alegada como RED.
2. **Fidelidade:** gateway HTTP loopback real + `createConversationStore` persistente real + `createPromptHost` real; únicos seams são `message.list` (e o wrapper injetável nos testes de sessão ausente/quarentena). Fixture com ids + resposta do screenshot (fonte/limitações declaradas). **Não testado:** transcript SQLite completo do OpenCode / persistência nativa do SDK — **só a persistência do conversation registry é real; o transcript nativo é seam de fixture.**
3. **POST/GET/reload:** POST 200 com resposta; GET com falha → `history.unavailable`/503 com mensagem fixa, `session.prompt` continua 1; GET seguinte recupera `[userMessageId, turnId]` sem duplicação; store+servidor recriados no **mesmo persistDir** retornam os mesmos ids com **0 prompts**.
4. **Ausência de superfície/sessão:** superfície ausente (unit + bootstrap sem pin) e sessão nativa ausente após lookup (wrapper não tipado com detalhe nativo) → 503 + mensagem fixa, sem vazamento (`ses_secret-9f3`, IP, `connection reset` ausentes do corpo).
5. **Wrong-origin:** `PromptError('prompt.failed')` / `provider.unavailable` lançado no path de GET → 503 `history.unavailable` com mensagem fixa.
6. **Visibilidade atrasada (FIX3, single-`chat()`):** uma única chamada `chat()` admite uma vez (`session.prompt` 1×); `message.list` expõe só a linha do usuário nas primeiras leituras e a linha do assistente a partir da 3ª leitura, ainda dentro do mesmo polling → turno completa com o texto atrasado e `admissions === 1` (prova que o atraso de persistência resolve sem segundo prompt). Caso impaciente irmão: assistente nunca pousa → `prompt.no_output` com exatamente 1 prompt, nunca sucesso fabricado. O critério "falha entre resposta e persistência" está coberto como visibilidade atrasada do histórico nativo: o transcript nativo é o único store, de modo que um assistente ainda não visível **é** a forma observável dessa falha — sem injeção de falha de persistência (não separável com segurança).
7. **Quarentena × device revogado (distintos):** quarentena de binding (`host_binding_quarantined` no safe-wrapper, pós-checks de identidade/visibilidade) → **409** tipado, `readHistory` nunca alcançado (`reads === 0`), `session.prompt` nunca admitido (`prompts === 0`). Revogação de device-token (nível identidade, `revoked-device`) → **401** antes de qualquer uso nativo. Coberturas diferentes, asserts diferentes, sem confusão.
8. **Negativos/distinções:** falha genuína de `session.prompt` segue `prompt.failed`/502; dois turnos → 2 prompts + 4 itens ordenados; conversa ausente 404; cross-workspace 403; `history_overflow` preservado (suítes existentes); nada virou 200. **Negação private segundo usuário:** coberta pela suíte adjacente existente `server.test.mjs` + suíte runtime completa (não pelo teste de integração P2-específico).
9. **PWA:** `TedChat.reload.test.tsx` **modificado pela tarefa** (+1 teste de caracterização P2-R-FIX, 7→8) — 8/8 verde no comando acima.
10. **Sem inferência:** doubles + loopback; nenhuma chamada de modelo/browser/rede externa.
11. **Evidência/limites:** ids, registro, screenshot e A0 declarados acima; exceção SDK bruta e transcript live irrecuperáveis; persistência nativa do SDK não testada (só registry real + transcript seamado).
12. **Foco:** só os arquivos do escopo (teste de integração runtime reescrito, este relatório; `src/` runtime e fixture intocados nesta rodada; teste PWA +1); root `pnpm test` não rodado (preservar F1); root `pnpm lint` com timeout sem veredito (não é pass); relatórios F1 e demais arquivos preexistentes intocados.

## Revisão independente final (pós-FIX3)

- **Reviewer: APPROVED** para o delta P2-R. Um achado anterior sobre retries de mesma intenção após um throw ambíguo de dentro do `session.prompt` nativo foi **retirado**: comportamento pré-existente, intencionalmente fail-closed (status de admissão incerto), fora de escopo desta tarefa. Falhas de `requireSessionShape()` antes do `session.prompt` permanecem retryable; R07 (`prompt.failed`/502) segue testado. Residual registrado de forma concisa; **nenhuma mudança de `src/` por conta disso**.
- **Security Reviewer: APPROVED** — sem bypass de auth/ownership, sem vazamento de erro nativo bruto.
- **Tester: PASS** no estado final P2 runtime/PWA; confirma ausência de inferência, mas live SDK/SQLite/browser-A0 permanece **NOT_PROVEN**.
- **Sem E2E local de browser executado** (nenhuma alegação nesse sentido). **Sem persistência real de SQLite nativo do OpenCode testada** (registry de conversas real; transcript nativo seamado). **Exceção SDK live original não capturada; nenhum re-run live / chamada de provider.**

## Veredito: P2_REFRESH_PARTIAL (não P2_REFRESH_PASS)

A fronteira de classificação está provada e o refresh agora falha como `history.unavailable`/503 sanitizado com recuperação estável — erros de histórico jamais viram `prompt.failed`/`provider.*`, mensagens nativas jamais chegam ao browser, e um turno concluído nunca é relabelado como falha de prompt. Porém o essencial live permanece não provado: **o defeito nativo exato que quebrou o `GET /rpc/history` após o turno aprovado é desconhecido** (sem exceção bruta, sem transcript SQLite — recuperação do OpenCode DB real **não provada**), **nenhum re-run live com SDK real** foi feito (proibido sem nova autorização — nenhum turno adicional foi enviado), e a **persistência nativa do SDK não foi testada** (só o registry de conversas é real; o transcript nativo é seam de fixture). Até um live revalidar o refresh contra o SDK real, o estado fica em **P2_REFRESH_PARTIAL**.

## Arquivos alterados pela tarefa (exato)

- `apps/ted-runtime/src/prompt.mjs` — (rodada FIX2) `HISTORY_UNAVAILABLE_MESSAGE` + `classifyHistoryFailure` com passthrough restrito + superfície ausente como `history.unavailable`. **Intocado na rodada FIX3.**
- `apps/ted-runtime/src/server.mjs` — (rodada FIX2) `errorPayload` sanitizado para `history.unavailable` + `normalizeHistoryError` no outer catch do `handleHistory`. **Intocado na rodada FIX3.**
- `apps/ted-runtime/tests/p2-history-refresh.test.mjs` — (FIX3 reescrito) 9 testes: POST/GET/recovery, `prompt.failed` genuíno, superfície ausente, sessão nativa ausente, **quarentena de binding 409 sem alcançar o read**, wrong-origin tipado, **persistência atrasada em single-`chat()` com `admissions === 1`**, impaciente `prompt.no_output` com 1 prompt, dois turnos + 404/403/401; identidade sintética de teste + asserts de mensagem fixa.
- `apps/ted-runtime/tests/fixtures/p2-captured-turn.json` — permaneceu intocado durante a revisão FIX3; foi sanitizado nesta preparação para publicação (IDs/caminhos substituídos, estrutura de teste preservada).
- `apps/pwa/src/features/ted/__tests__/TedChat.reload.test.tsx` — **modificado pela tarefa** (+1 teste de caracterização P2-R-FIX: POST sucesso + refresh falho; 7→8 testes, 8/8 verde).
- `docs/reports/P2-REFRESH-REMEDIATION-RESULTS.md` (este relatório) — data 2026-11-01, sem alegação de log server-side, lista exata de arquivos, quarentena × device distintos, negação private atribuída à suíte adjacente, persistência nativa declarada não testada, veredito parcial preservado.
