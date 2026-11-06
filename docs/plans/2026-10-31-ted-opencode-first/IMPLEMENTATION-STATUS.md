# Estado de implementação — TED OpenCode-first

**Atualizado:** 2026-11-04  
**Estado geral:** `PARTIAL`  
**Worktree:** `D:/projetos/pi-ted-opencode-product`  
**Branch:** `feat/ted-opencode-product`  
**HEAD-base:** `0a37e9e0f7481e034b123336eff1267dddfde9ab`

Este relatório descreve o checkout dirty efetivamente testado, não apenas o HEAD. **Histórico da campanha anterior (`k2b4`):** houve exatamente um POST PWA e um `session.prompt`, mas nenhum request HTTP ao proxy/provider e nenhuma tool financeira chamada; o gateway respondeu 504 antes da inferência. Não houve escrita financeira, migration, acesso à produção, commit, push, PR, merge ou deploy. Uma tentativa delegada anterior continua sem estado recuperável após corrupção do SQLite do worker; seu uso/custo permanece `NOT_VERIFIED` (detalhes abaixo), portanto não se afirma custo agregado zero.

## Baseline e preservação

- O checkout já continha mudanças rastreadas em relatórios F1, PWA, `package.json`, lockfile/workspace e scripts, além de runtime, testes, documentação parcial e relatórios P2 não rastreados. Foram preservados; nenhum `reset`, `clean` ou restore foi executado.
- Os arquivos F1 `apps/agent/evals/reports/ted-f1-baseline.json` e `ted-f1-journeys.json` continuaram intactos durante esta execução. Por isso, o teste agregado que os regenera não foi executado.
- O branch local aparece rastreando `origin/docs/ted-opencode-first-migration`. Não foi consultado o GitHub nesta execução; esse upstream não é tratado como prova de estado remoto.
- Fontes consultadas: `AGENTS.md`, ADR-031, SPEC, PLAN, `IMPLEMENTACAO-PARCIAL.md`, P0 inventory, os quatro relatórios P2 e relatórios SPIKE 01–05D na worktree experimental `D:/projetos/pi-ted-runtime-spike`.
- O relatório original `SPIKE_05D_RESULTS.md` declara `SPIKE_05_PASS`: uma conversa live propôs uma operação que foi persistida no Postgres **sintético**, recuperada após restart e confirmada por harness determinístico, com um lançamento e recibo canônico. Isso não é integração da PWA nem autorização para repetir inferência/mutação.

## Estado por fase

| Fase | Estado | Evidência e limite atual |
|---|---|---|
| Recuperação/P0/P1 — runtime local | `PARTIAL` | Runtime OpenCode 2.2.4, gateway loopback, isolamento, bindings, catálogo default read-only e testes locais. A validação registrada mais recente executou `node --test apps/ted-runtime/tests/` com 161/161. Catálogo do prompt-loop com a leitura P3 opt-in ainda não foi provado com modelo; o prompt real permanece bloqueado para nova tentativa sem autorização. Em 2026-11-04, o catálogo efetivo (`list_accounts` oferecido) e a negação nativa por `ctx.permission.assert` foram provados no SDK 2.2.4 real com provider scriptado (ver retificação final). |
| 1 — P2 leitura pela PWA | `PARTIAL` (`READ_SLICE_PASS` NOT ACHIEVED; causa física de `provider.transport` NOT VERIFIED) | A campanha anterior de 2026-11-01 provou uma resposta sintética e as duas tools de leitura, mas o refresh de histórico falhou. Em `r8v7` (2026-11-03), uma única mensagem foi admitida e terminou em `provider.transport`, sem resposta financeira; o ajuste em `prompt.mjs` preserva o erro tipado, mas não corrige a causa física entre SDK e proxy. Custo/faturamento também não foi verificado. Sem retry, segundo prompt ou nova inferência. |
| 2 — P3 primeira escrita pela PWA | `PARTIAL` | Preparada somente a leitura opcional `list_categories`, necessária para resolver categoria. O catálogo P2 segue com duas ferramentas por padrão; a terceira é opt-in local e forçada OFF em produção. `propose_expense`, POST Pending V2, confirmação e execução continuam ausentes. A proposta via OpenCode está **BLOCKED** pela fronteira de emissão de token A4 descrita abaixo; `WRITE_SLICE_PASS` não foi atingido. |
| 3 — expansão do catálogo financeiro | `NOT_STARTED` | Nenhuma capacidade além da leitura opcional de categorias foi iniciada. |
| 4 — qualidade conversacional | `NOT_STARTED` | Nenhuma regra ou roteador de intenções foi criado. |
| 5 — recursos/paridade do produto | `NOT_STARTED` | Sem mudanças de visibilidade, conversas, anexos, áudio ou offline. |
| 6 — estabilização/migração | `NOT_STARTED` | Sem staging, canary, deploy, rollback rehearsal ou descomissionamento de A0. |
| 7 — pendências transversais | `NOT_VERIFIED` | PRs/issues e os itens Better-Auth, contexto temporal, conversas privadas, bearer, OpenNext, Biome e capabilities multimodais não foram consultados no GitHub nesta execução. Não houve trabalho duplicado nessas frentes. |

## P2 — preparação e evidência

- Os testes sem provider foram reexecutados no checkout atual: runtime 34/34 nos focos de histórico/prompt; API 8/8 na integração gateway/read-slice; PWA 78/78 nos sete arquivos P2, serialmente.
- O teste do SDK com transcript criado por `experimental.session.import` permanece **somente sintético**. Ele valida a API oficial de transferência e restart entre processos, mas não substitui uma conversa gerada pela LLM.
- Um primeiro disparo concorrente de testes teve `SIGKILL` no subprocesso do SDK após 180 s e três falhas de inicialização de workers Vitest. Reexecutados em série, os focos passaram. A causa não foi conclusivamente isolada; nenhuma falha de produto foi reproduzida.
- `P2-FINAL-E2E-CLOSURE-RESULTS.md` classifica a preparação como `READY_FOR_LIVE`, não `READ_SLICE_PASS`. Em 2026-11-02 o operador autorizou provider `opencode-go`, modelo `opencode-go/deepseek-v4.1-flash` e teto novo de US$ 5; a autorização anterior não foi reutilizada.

### Tentativas e preparação live em 2026-11-02

- A primeira execução delegada foi interrompida no restart do servidor. A pasta temporária daquela tentativa ficou vazia; a consulta ao worker falhou porque o SQLite da sessão do subagent estava `malformed`. **Não é possível verificar** se aquele worker chegou a enviar um prompt/request; seu uso e custo continuam `NOT_VERIFIED`.
- A autorização então confirmada para `opencode-go/deepseek-v4.1-flash`, teto novo de US$ 5, foi seguida por runners de validação. `b5d8` auto-recusou por ordem errada do run-lock; `c7f2` parou no caminho presumido do Next; `c8e1` parou no launcher `--import` do Node; `c9d3` parou no gate inicial de inventário de rotas; `f0e2` passou pela API sintética e abortou no runtime 1; `g31f` expirou no boot da API; `h7a2` passou pela API/runtime mas não chegou a `PWA ready`; `i5f0` abriu a PWA e abortou no launcher do browser antes do prompt; `k2b4` autenticou, renderizou `/ted` e enviou um único POST, que recebeu 504. Em `k2b4`, `session.prompt=1`, provider proxy request count=0. Nenhum processo/listener permaneceu.
- Probes separados, apenas de API in-memory e sem inferência, confirmaram Better-Auth sintético, workspace/device e o oráculo de duas contas + R$117,50 em junho. Um smoke PWA local com API memory + stub loopback confirmou login sintético e render do chat/composer em `/ted`; sem prompt/modelo. Em `k2b4`, a mesma UI autenticada enviou uma mensagem; o gateway respondeu 504 antes do provider, sem tool GET ou resposta LLM.
- O abort `f0e2` veio de derivar config antes do `writeTedConfig()` do bootstrap; o runner `g31f` moveu a derivação para dentro de `OpenCode.create()` depois do write padrão, com replace atômico, checagens symlink/hash e restore hash-required. O revisor de segurança aprovou essa proteção. Em `k2b4`, runtime 1 iniciou e capturou o catálogo P2, mas o POST de chat recebeu 504 antes de qualquer provider proxy request; o config isolado foi restaurado para deny-all por hash.
- O limite conservador por campanha, considerando no máximo 3 requests com 32.768 input e 1.024 output cada a preço Peak publicado, é **US$ 0,033178 (estimativa, não faturamento)**. Esse bound não permite concluir o custo da tentativa delegada cujo estado foi perdido.
- O limite de uma mensagem foi consumido em `k2b4`: `session.prompt=1`, POST PWA 504 e provider proxy count=0. Não houve retry nem segundo prompt. A tentativa delegada inicial ainda tem uso/custo `NOT_VERIFIED`; não afirmar custo agregado zero nem billing consultado.

## P3 — implementação local segura

### Entregue nesta execução

- `apps/ted-runtime/src/tool-defs.mjs`: schema, validação e executor host-bound de `list_categories`.
- `apps/ted-runtime/src/transport.mjs`: GET `/categories` pela origem loopback existente; mantém `POST`, proposta, confirmação e execução fora da allowlist.
- `apps/ted-runtime/src/plugin.mjs`: catálogo P2 de duas ferramentas por padrão. `TED_OPENCODE_P3_READS_ENABLED=1` expõe `list_categories` apenas quando `NODE_ENV !== 'production'`.
- Testes unitários de argumentos, schema, catálogo, opt-in, produção-off, shape, erros, headers e recusa de escrita em `apps/ted-runtime/tests/p3-category-read.test.mjs`.
- `apps/api/tests/integration/ted-runtime-read-slice.test.ts`: leitura de categorias A/B e negação cross-workspace contra handlers reais Fastify com fixtures sintéticas.
- `apps/ted-runtime/README.md`: descrição ajustada ao catálogo default e ao opt-in local.
- A PWA não foi alterada nesta fatia. `TedChat.loadHistory` já atualiza a lista ativa autoritativa após um turno bem-sucedido, e `TedApprovalCard` continua pertencendo ao fluxo autenticado existente. Isso ainda não prova que uma proposta OpenCode chegue ao card.

### Bloqueio de autorização

- `/auth/agent-token` autentica sessão/workspace e emite um token de conexão `iss=pi-finance-api`, `aud=pi-finance-agent`, de 120 s e somente leitura por padrão. Não é token de aprovação Pending V2.
- `POST /pending-operations/v2/propose` exige `financial.approval.propose`, `Idempotency-Key`, device binding e validação autoritativa da API.
- A API aceita tokens delegados `iss=pi-agent`, `aud=pi-finance-api`; A4 mantém sua emissão no Agent. O Agent cria esse token por turno com `AGENT_DELEGATION_SECRET` e device ID verificado. O gateway OpenCode atual não possui esse segredo nem uma interface existente que lhe entregue uma capability de proposta.
- A revisão de segurança não encontrou vulnerabilidade no slice read-only, mas confirmou que o writer não pode ser ligado legitimamente com os contratos atuais. Não foi tentado POST, nem relaxado o gate A4.
- Próximo passo de P3 exige decisão/autorização explícita sobre como o OpenCode recebe uma autorização de proposta emitida pelo componente autorizado, sem mover a emissão para o gateway nem mudar a policy da API. Até então, `propose_expense`, confirmação e execução permanecem não implementadas.

## Arquivos alterados nesta execução

Em arquivos que já estavam dirty/untracked antes desta execução:

- `apps/ted-runtime/src/tool-defs.mjs`
- `apps/ted-runtime/src/transport.mjs`
- `apps/ted-runtime/src/plugin.mjs`
- `apps/ted-runtime/tests/p3-category-read.test.mjs` (novo)
- `apps/ted-runtime/tests/tool-defs.test.mjs`
- `apps/ted-runtime/tests/transport.test.mjs`
- `apps/api/tests/integration/ted-runtime-read-slice.test.ts`
- `apps/ted-runtime/README.md`

Nenhum arquivo PWA, API de produção, auth, migration, configuração de deploy, dado financeiro ou credencial foi alterado. Este arquivo de status é novo.

## Validação desta execução

| Verificação | Resultado | Escopo/limite |
|---|---|---|
| `node --test apps/ted-runtime/tests/` | **155/155 PASS** | Runtime completo, SDK 2.2.4; sem inferência. |
| `pnpm --filter meu-ted-api exec vitest run tests/integration/ted-runtime-gateway-auth.test.ts tests/integration/ted-runtime-read-slice.test.ts tests/routes/pending-operations-v2.test.ts --reporter=dot` | **26/26 PASS** | Handlers e stores sintéticos/in-memory; sem Postgres ou produção. |
| Sete testes PWA P2 focados, executados um por um com `--pool=forks --maxWorkers=1` | **78/78 PASS** | Client, proxy, cancelamento, reload e histórico sintético; não é browser E2E da conversa live. |
| `pnpm --filter pi-finance-ted-runtime lint` / `typecheck` | **PASS** | Ambos executam `node --check` nos módulos runtime. |
| `pnpm --filter meu-ted-api typecheck` | **PASS** | TypeScript da API. |
| `pnpm docs:lint` | **PASS** | 17 documentos, zero issues. |
| `pnpm governance:check` | **PASS** | Nenhuma mudança D01–D19 detectada. |
| `pnpm architecture:check` | **PASS** | 541 arquivos de produção analisados. |
| `pnpm boundary:check` | **PASS** | Limite de comandos de escrita da PWA válido. |
| `pnpm public-safety --strict` | **PASS** | Nenhum finding. |
| `pnpm test:skip-gate` | **PASS** | 126 arquivos críticos; 8 skips antigos allowlisted; zero skips incondicionais novos. |
| Biome focado no teste API alterado | **TIMED_OUT / NOT_VERIFIED** | `pnpm --filter meu-ted-api exec biome check tests/integration/ted-runtime-read-slice.test.ts` excedeu 120 s sem diagnóstico. Não convertido em PASS. |
| Reviewer independente | **APPROVED** | Apenas a leitura opcional de categorias; não aprova gates P2/P3. |
| Tester independente | **PASS** | Gating, rota, shape e recusa de escrita; não executou produção/provider. |
| Security Reviewer | **NO VULNERABILITY FOUND** | Confirmou o bloqueio A4 para o writer; revisão estática limitada ao fluxo de emissão. |
| `pnpm test` agregado | **NÃO EXECUTADO** | Regenera os JSONs F1 rastreados preexistentes; preservação teve prioridade. |
| `pnpm lint` agregado | **NÃO EXECUTADO** | O Biome focal do teste da API excedeu 120 s; o gate agregado não foi alegado como aprovado. |
| Live P2 / PWA browser E2E / provider | **NOT_VERIFIED / BLOCKED** | `q7r2` fez um POST PWA e `session.prompt=1`, mas o hook `http.request` rejeitou com `guard:bad-model` (`providerMatch=true`, `modelMatch=false`) antes do proxy; PWA recebeu 502 `prompt.no_output`, sem inferência/tool GET. O timeout de gateway foi alinhado em 90 s, acima dos 60 s do adapter e abaixo dos 120 s da BFF. O model ID recebido pelo hook não foi persistido, então a divergência exata permanece sem causa fechada. `READ_SLICE_PASS` não foi atingido; restart/reload/fault não foram executados. Config restaurada ao deny-all.
| Produção / PostgreSQL real / migração / deploy | **NÃO EXECUTADO** | Fora do escopo e sem autorização. |

## Situação externa separada

| Área | Situação observada |
|---|---|
| Código local | `PARTIAL`, worktree dirty; alterações acima sem commit. |
| GitHub | `NOT_VERIFIED`: nenhum fetch/API/GitHub foi consultado; sem push, PR ou merge. O upstream local aparece como `origin/docs/ted-opencode-first-migration`. |
| Produção | `NOT_VERIFIED` ao vivo e inalterada por esta execução. `AGENTS.md` declara como último estado conhecido Agent/PWA `6c76a66` e API `0405fba` (registro de 2026-10-20); isso não é smoke atual. |

## Custos, limitações e próximas ações

- Os runners até `n8p4` não enviaram requests ao provider; `q7r2` enviou uma mensagem PWA (`session.prompt=1`) mas o hook local rejeitou antes do proxy (`proxy.count=0`). O provider não recebeu request observável; billing não foi consultado. A tentativa delegada original continua `NOT_VERIFIED`; não afirmar custo agregado zero.
- **Ação 1 — P2:** a autorização de uma mensagem foi consumida em `q7r2`. Não repetir. Fato observado: o hook `http.request` registrou `providerMatch=true`, `modelMatch=false` e bloqueou antes do proxy (`guard:bad-model`). A evidência não guarda o `modelID` recebido nem a implementação exata do matcher; portanto não prova se o ID recebido diferia do esperado ou se o mapping/allowlist local comparava outro formato. Nenhum request ao provider saiu. Não afrouxar allowlist nem usar fallback; qualquer nova mensagem exige autorização explícita.
- **Ação 2 — P3:** resolver explicitamente a emissão da capability `financial.approval.propose` dentro do limite A4. Sem isso, não adicionar `propose_expense`, POST Pending V2 ou qualquer caminho de escrita.
- Após essas decisões, continuar com o card autenticado existente e os critérios de idempotência/recibo; nenhum sucesso de execução pode ser afirmado sem recibo canônico.
- Só depois dos gates P2/P3, iniciar as fases seguintes, verificar os estados atuais das issues/PRs transversais e preparar staging. A0 permanece em produção; canary/migração continua exigindo autorização específica.

## Retificação pós-campanha `k2b4` — 2026-11-03

- Esta retificação supersede as contagens anteriores desta seção: a última execução autorizada fez exatamente **um** `POST /rpc/chat` pela PWA e `session.prompt=1`. O gateway respondeu **504**; o browser foi encerrado com erro antes de receber resposta. **Nenhum request HTTP chegou ao proxy do provider** (`proxy-count.json` ausente), nenhuma tool financeira foi chamada e não houve resposta do modelo. Não houve retry nem segundo prompt. `prompt-count.json` foi gravado às 02:43:02Z e `frag-browser.json` às 02:43:32Z; a diferença de 30 s coincide com `TED_REQUEST_TIMEOUT_MS` default do gateway. O runner não passa override e o proxy da PWA tem teto de 120 s: portanto `gateway.timeout` local é a explicação de alta confiança, não confirmação (o body/header identificador não foi persistido).
- PWA autenticada sinteticamente em `/ted`; `frag-browser.json` registra `chatPosts=1`, região `Chat com TED`, composer e erro `chat POST status 504`. `frag-runtime-1.json` registra o catálogo P2 esperado (`get_month_summary`, `list_accounts`) e 20 denies de tool; API trace registra apenas workspace/device sintéticos, oráculo de 2 contas e R$117,50 em junho.
- O runner terminou por rejeição de `browserDone` não tratada no parent; por isso não gravou `evidence.json` nem executou seu teardown `finally`. Inspeção posterior confirmou que os processos/ports da campanha já estavam encerrados. O config do runtime foi restaurado separadamente por hash verificado ao `tedConfig()` deny-all; `apps/pwa/AGENTS.md` permaneceu no hash original.
- Veredito: `READ_SLICE_PASS` continua **NOT ACHIEVED**. O uso desta tentativa no proxy é zero observável; billing não foi consultado. A tentativa delegada mais antiga ainda tem custo/requests `NOT_VERIFIED`; não afirmar custo agregado zero. A causa do timeout dentro do SDK/gateway não foi identificada: `claimPrompt` incrementa antes de `oc.session.prompt`, e o trace não registra retorno da admissão, polling de `message.list` ou estágios do wrapper. Esta mensagem já consumiu o limite de um prompt; não repetir sem nova autorização explícita.

## Retificação após correção de timeout e campanha `q7r2` — 2026-11-03

- **Correção aplicada, local e sem deploy:** `apps/ted-runtime/src/main.mjs` default `TED_REQUEST_TIMEOUT_MS` passou de 30 s para 90 s, acima do prazo de 60 s do `createPromptHost` e abaixo do teto de 120 s do proxy PWA; override explícito permanece. Teste `main.test.mjs` verifica o valor passado ao gateway e precedência do override. Validação: 54 testes focados (main/server/prompt) PASS; revisor APPROVED.
- Campanhas `m3c7` e `n8p4` falharam antes do envio: `chatPosts=0`, prompt/proxy counters ausentes/0. O primeiro browser child podia atravessar timeout de readiness e tratar login tardio como falha; o segundo revelou marcadores DOM sem caixa visível. O harness agora usa markers visíveis por bounding box, login tem precedência e o erro é fail-closed. Nenhum prompt foi consumido nessas duas campanhas.
- `q7r2` autenticou a PWA, inspecionou `/ted` e enviou **um** `POST /rpc/chat`; `session.prompt` resolveu em 856 ms com ID de admissão. O plugin `http.request` estava registrado e foi invocado, mas registrou `providerMatch=true`, `modelMatch=false`; o guard lançou `guard:bad-model` antes de validar/dialar o proxy. A API de prompt continuou sem resposta do assistant (229 polls, duas linhas, nenhuma assistant) e a PWA recebeu **502 `prompt.no_output`**. Contador do proxy = 0; nenhuma chamada externa ao provider, nenhuma tool financeira e nenhuma escrita financeira.
- O `modelID` recebido não foi armazenado (somente `modelMatch=false`), portanto ainda falta o valor exato para corrigir o mapping/configuração. Não enfraquecer o guard para contornar isso. Esta autorização foi consumida: qualquer nova mensagem exige nova autorização explícita.
- Cleanup: runtime config isolada restaurada por hash a `tedConfig()` deny-all; `apps/pwa/AGENTS.md` permaneceu no hash original; processos/listeners encerrados. `READ_SLICE_PASS` segue **NOT ACHIEVED**. Billing não foi consultado; a tentativa delegada inicial continua `NOT_VERIFIED`.

## Simplificação native-first — 2026-11-03

Este adendo atualiza o estado após a leitura da documentação publicada em `origin/docs/ted-opencode-first-migration` (`bbccac9`) e a inspeção do checkout dirty. Ele não substitui os registros das campanhas anteriores nem autoriza inferência, escrita financeira, merge, push ou deploy.

### Estado dos critérios

- **`NATIVE_CONFIG_PASS`: PASS — contrato determinístico do SDK 2.2.4.** Novo teste `apps/ted-runtime/tests/native-model-selection.test.mjs`: o SDK resolve `model: "testloop/test-alpha"` pelo catálogo local de teste; `session.switchModel({sessionID, model:{providerID,id}})` muda `test-alpha → test-beta → test-alpha` na mesma sessão. `session.get` conserva o mesmo ID, agente `ted` e os denies de `shell/edit/subagent`. Não há `session.prompt`, chamada à API financeira nem request bem-sucedido; o `fetch` é interceptado antes do import/boot do SDK. A fixture e o allow de provider existem somente no teste; `tedConfig()` permanece inalterado e deny-all.
- **`CHAT_PASS`: PARTIAL (determinístico por componentes, não um E2E integrado).** Permanecem válidas as provas focadas anteriores: gateway `chat()`/refresh com resposta determinística; PWA `TedChat.reload` (8/8) mostra a resposta concluída sem reenviar quando o histórico falha; e `route.p2-real-history.test.ts` recupera o transcript sintético do SQLite do SDK em outro processo e o apresenta pelo proxy/client PWA. São seams/testes distintos; não provam uma única conversa gerada e recuperada ponta a ponta no browser. Nenhuma inferência real foi feita nesta missão.
- **`READ_SLICE_PASS`: NOT ACHIEVED.** A campanha `q7r2` continua sendo um bloqueio antes do proxy; esta execução não repetiu a mensagem nem usou orçamento anterior. O próximo fechamento live exige autorização nova e explícita para provider, modelo e teto.
- **P2:** `READY_FOR_LIVE` para a próxima validação live de uma única conversa; o histórico de campanha e as lacunas de integração acima permanecem explícitos. Não declarar `READ_SLICE_PASS`.

### Modelo, provider e guard

- O perfil TED de produto (`apps/ted-runtime/src/bootstrap.mjs::tedConfig`) não define root `model` nem catálogo `providers` e mantém `provider.use: deny` para todos. A sessão é criada explicitamente com o agente `ted`; não existe seleção de modelo por campo de `session.prompt`.
- O SDK/plugin instalados são `2.2.4`. Os tipos reais definem `SessionHttpRequest.model` como `Model.Ref` (`providerID` + `id`); `SessionPromptInput` não tem modelo. A troca nativa é `session.switchModel({sessionID, model:{id,providerID,variant?}}`; `SessionInfo.model` reflete a seleção.
- A consulta read-only ao catálogo da sessão OpenCode atual retornou 24 modelos `opencode-go`, incluindo `iceman-contributor-free` e `beam-free` a custo listado zero e `deepseek-v4.1-flash` ativo. Esse é o catálogo do OpenCode desta sessão, **não** prova disponibilidade/credencial no perfil TED isolado.
- `q7r2` observou `http.request`, `providerMatch=true`, `modelMatch=false`, rejeição antes do proxy e nenhum request ao provider. O `modelID` recebido e a implementação exata do hook não foram preservados. Busca no checkout não encontrou o emissor `guard:bad-model` no runtime TED; o texto ocorre nos relatórios de estado. `apps/agent/tests/poc-structured/f2b0-runtime/real-guard.mjs::validateNativeRequest` é outro guard, de um harness F2B0 separado, que compara o modelo/endpoint da campanha; foi preservado e não atribuído ao incidente `q7r2`. Não foi criado alias, catálogo paralelo nem guard substituto.

### Simplificação e fronteiras preservadas

- **Removidos:** zero módulos/linhas de produção. O guard exato do incidente não está no código atual do produto; não havia remoção segura a fazer. A prova nova adiciona um módulo de teste (261 linhas); não muda bootstrap, gateway, SDK facade, PWA ou API.
- **Mantidos:** proxy same-origin/flag e pin PWA; gateway privado e autenticação/ownership; store de conversas e host bindings; `PromptHost` (o `session.prompt` nativo retorna admissão, não texto do assistant); façade privada; plugin com `list_accounts`/`get_month_summary`; transporte GET host-bound. São adaptações de contratos TED e não duplicações de seleção nativa. A API financeira, Pending V2, recibos e A0 não foram alterados.
- A configuração de produto continua sem provider/modelo ativo. A fixture local do teste não foi copiada para runtime nem para um perfil persistente.

### Biome — diagnóstico separado

- Biome `2.2.4` inicia (`--version`, `--help` e `rage` respondem; nenhuma configuração de projeto é alterada). `rage` confirma config carregada da raiz, `VCS enabled: false`, Node `v26.11.1`, pnpm `10.34.1`.
- `pnpm --filter @pi-finance/llm-contracts exec biome check src/index.ts --reporter=summary` excedeu **120 s**, sem saída. Uma repetição focada com `--verbose --log-level=debug` excedeu **30 s** após `Configuration file loaded` e `Insert workspace folder D:\projetos\pi-ted-opencode-product`. O config global inclui `**` e exclui `node_modules`, `dist`, `build`, `coverage`, `.wrangler`, `.open-next` e `generated`; a execução auto-descobriu a raiz do monorepo mesmo recebendo um arquivo do pacote.
- Entrada via stdin retorna imediatamente, mas produz diagnóstico de formatação; não conta como lint nem PASS. **Hipótese atual:** a demora está na indexação/varredura do workspace ou filesystem Windows, não no início do binário. Causa exata ainda **NOT_VERIFIED**; nenhum arquivo foi alterado para contornar o timeout.

### Verificações desta atualização

| Verificação | Resultado | Limite |
|---|---|---|
| `node --check apps/ted-runtime/tests/native-model-selection.test.mjs` | **PASS** | Teste novo, somente SDK/config nativos. |
| `node --test apps/ted-runtime/tests/native-model-selection.test.mjs` | **PASS — 1/1** | Reexecutado no checkout integrado; zero `session.prompt`, API financeira ou rede bem-sucedida. |
| Review independente do teste | **APPROVED** | Limitada ao teste novo; o revisor não tinha os tipos 2.2.4 disponíveis, conferidos separadamente neste checkout. |
| Tester independente | **PASS — 1/1** | Sem inferência/provider/API. |
| `pnpm --filter pi-finance-ted-runtime test` | **PASS — 157/157** | Suite completa do runtime; inclui SDK 2.2.4 e o teste novo; sem inferência/provider pago. |
| `pnpm --filter @pi-finance/llm-contracts exec biome check src/index.ts --reporter=summary` | **TIMED_OUT / NOT_VERIFIED** | 120 s; nenhuma aprovação inferida. |
| `pnpm docs:lint` | **PASS** | 17 documentos canônicos; os dois arquivos desta atualização também passaram pela função `lintMarkdownDocument` do mesmo script. |
| `pnpm typecheck` | **PASS** | Contracts, API, PWA, Agent, broker e TED runtime. |
| `pnpm governance:check` | **PASS** | Nenhuma mudança D01–D19 detectada. |
| `pnpm lint` agregado | **NOT_VERIFIED** | Não executado nesta atualização; Biome focal continua sem concluir. |
| `pnpm test` agregado | **NÃO EXECUTADO** | Os testes F1 regeneram JSONs já modificados antes desta missão; preservá-los teve prioridade. |
| Provider pago / dados reais / API financeira de produção / deploy / publicação | **NÃO EXECUTADOS** | Nenhuma nova autorização ou orçamento utilizado. |

## Tentativa TED-P2-LIVE-EXECUTION — 2026-11-03 (`BLOCKED_PROVIDER`, sem prompt)

- **Autorização:** OpenRouter / `openai/gpt-6-luna`, uma mensagem PWA, até US$ 1, local/sintético, somente leitura; sem retry de prompt, fallback ou produção.
- **Base/preservação:** HEAD `0a37e9e0f7481e034b123336eff1267dddfde9ab`; worktree dirty preservado (12 modificados + 18 não rastreados), origem `https://github.com/kust-projetos/meu-ted.git`, sem mutação Git. Foram atualizados somente este status e `docs/reports/P2-FINAL-E2E-CLOSURE-RESULTS.md`.
- **Gate de isolamento:** home TED isolada (`<TED_RUNTIME_HOME>/.ted-home-local`; marker `identity=local`, `db/ted.db` e `state/` intactos); home global intocada. Config original preservada. Sem destino de produção; serviços loopback DOWN e não iniciados.
- **Bloqueio:** `OPENROUTER_API_KEY` estava presente somente como placeholder inutilizável (valor não impresso/lido). A execução parou antes de abrir PWA ou enviar mensagem: `POST /rpc/chat=0`, `session.prompt=0`, requests ao provider `=0`, `tool calls=0`, chamadas financeiras `=0`. Nenhum custo efetivo é declarado; billing não consultado.
- **Gates da tentativa:** `LIVE_PROMPT_PASS=BLOCKED_PROVIDER`; `FINANCIAL_READ_PASS`, `PWA_RENDER_PASS`, `PERSISTENCE_PASS`, `RESTART_RECOVERY_PASS`, `PWA_RELOAD_PASS` e `NO_DUPLICATION_PASS` = `NOT_EXECUTED`; `COST_RECORDED=NOT_VERIFIED`; `READ_SLICE_PASS=NOT ACHIEVED`.
- **Custo:** estimativa teórica de US$ 0,027648 sob limites propostos (32k entrada, 512 saída, 2 passos e até 3 retries de timeout por passo, preço máximo padrão). Os limites/roteamento não foram aplicados nem validados no SDK 2.2.4; não é um teto efetivo comprovado. Nenhuma inferência foi realizada.
- **Próxima ação à época:** disponibilizar credencial OpenRouter e validar limites antes de tentar novamente. A recomendação foi supersedida pela retificação abaixo: o operador esclareceu que pretende usar OpenCode Console/Go, não OpenRouter. A mensagem anterior, específica a OpenRouter/GPT-6-Luna, não foi enviada.

## Retificação — providers ausentes na TUI — 2026-11-03

- **Credenciais:** metadados do SQLite isolado mostram contas ativas `opencode` e `opencode-go`; nenhuma conta `openai`. Nenhum valor de segredo foi lido ou impresso.
- **Causa:** a política live tinha `provider.use * deny` seguido apenas de `provider.use openrouter allow`. A documentação OpenCode V2 confirma que providers negados desaparecem do catálogo/model picker mesmo com conta válida.
- **Correção autorizada:** `tedConfig('live')` agora appende `provider.use * allow` após `provider.use * deny`, permitindo qualquer provider disponibilizado pelo catálogo/integração/configuração nativa do OpenCode. O perfil test continua deny-all; modelo default e tool denies não mudaram. Chaves ambientais OpenAI/OpenCode/Go continuam scrubbed; contas conectadas são lidas do SQLite isolado.
- **Configuração ativa:** o `opencode.json` do home isolado foi regenerado a partir de `tedConfig('live')` para refletir o wildcard e permitir reload da TUI. Backup preservado sob `<TED_RUNTIME_HOME>/.ted-home-local/config/` (nome original omitido). A TUI v2.2.5 usa o mesmo SQLite isolado do runtime SDK 2.2.4; o backup prévio do banco permanece preservado. A lista visual pós-reload ainda não foi confirmada.
- **Tools nativas do agente TED — não ampliadas:** shell/edit/write/subagent/leitura/MCP continuam negadas. A revisão de segurança concluiu que o modelo poderia ler o SQLite de credenciais ou o ambiente do processo por outra tool, sem sandbox do SO. `/connect` e `/models` na TUI continuam disponíveis; liberar tools ao agente exige isolamento real do host/segredos.
- **Validação:** `node --test tests/bootstrap-negative.test.mjs tests/native-model-selection.test.mjs` 9/9; runtime completo `node --test tests/` 159/159; runtime `typecheck`/`lint` PASS; `pnpm docs:lint` 17 documentos, zero issues; `pnpm governance:check` PASS; Reviewer e Security Reviewer aprovaram wildcard de provider. `READ_SLICE_PASS` permanece **NOT ACHIEVED** e custo efetivo não foi verificado.
- **Próxima ação:** no TUI, atualizar/abrir `/models` e selecionar o modelo exato. Antes de nova inferência, confirmar modelo e custo máximo aplicável ao provider selecionado; a autorização OpenRouter/GPT-6-Luna não cobre outro provider/modelo.

## Retificação — investigação offline do r8v7 e simplificação native-first (2026-11-03)

### Transporte: causa delimitada, não fechada

- A evidência r8v7 confirma que `session.prompt` admitiu uma mensagem uma vez (1330 ms) e que o plugin `http.request` foi invocado; provider/modelo, host loopback, caminho, nonce e limite de corpo passaram. O SQLite guarda uma linha assistant `finish=error`, `error.type=provider.transport`, `content=[]`; o gateway acabou retornando 502 `prompt.no_output` após polling. Não há mensagem de socket, `cause.code`, resposta HTTP local nem detalhe do provider persistido.
- O runner chama `await startReverseProxy(...)` antes de iniciar API/runtime/PWA; o listener fica no processo pai e só é fechado no teardown. A configuração de campanha é escrita/verificada com o mesmo `PROXY_ORIGIN`, e o request observado pelo hook usou `127.0.0.1` e o caminho esperado. A guarda temporária de `fetch` é instalada antes do import do SDK, permite loopback e delega ao `rawFetch`; não há evidência que ela tenha bloqueado a chamada local.
- `http.request` é um hook observacional/mutável do SDK 2.2.4, não um forwarder: o callback temporário valida e retorna `void`; o transporte HTTP é feito pelo SDK. No proxy, `countBeforeFetch()` só ocorre **depois** das validações de método/path/body/model/caps/nonce/autorização e da checagem `inFlight`; `attempts[]` só é anexado quando o fetch upstream retorna. Portanto `count=0`/`attempts=[]` não distinguem request não enviado, conexão local falha, ou rejeição pré-contador (por exemplo, ausência de Authorization). Não há log de rejeição/entrada no handler. Não foi demonstrado defeito do provider nem incompatibilidade da interceptação temporária.
- **Primeiro intervalo comprovável:** após as validações do hook e antes de `countBeforeFetch`/fetch upstream no proxy. A causa exata permanece **NOT_VERIFIED**; cobrança também **NOT_VERIFIED**. Não repetir r8v7 nem atribuir custo zero ao contador.

### Correção implementada e limite do offline

- `apps/ted-runtime/src/prompt.mjs` agora reconhece o marcador nativo terminal `assistant.finish === 'error'` + `error.type === 'provider.transport'` no turno admitido e lança `PromptError('provider.transport', mensagem fixa)`. Não expõe mensagem nativa, body, request ou segredo; não inventa saída e não chama `session.prompt` novamente. Mensagem assistant sem texto e sem erro terminal continua `prompt.no_output`.
- Isso corrige o **mascaramento** de `provider.transport` por `prompt.no_output`; não afirma corrigir a causa física entre SDK e proxy.
- Sonda isolada em `<LOCAL_TEMP>/opencode/ted-p2-offline-transport-<redacted-run-id>/` usou o `proxy.mjs`/`guards.mjs` da campanha, contador/nonce novos e `fetchFn` local stub: listener iniciou, POST local chegou ao handler, contou/encaminhou exatamente uma vez ao stub e status/body/header retornaram; request sem Authorization recebeu 400 `guard:no-auth` sem incrementar nem chamar o stub; listener fechado chegou ao consumidor com `ECONNRESET`. `externalFetches=0`.
- **`OFFLINE_TRANSPORT_PASS`: PARTIAL (proxy component-level).** A sonda não invocou o SDK/provider nem o callback `http.request`, portanto não prova a aresta SDK→proxy nem o turno PWA→OpenCode. Não é `READ_SLICE_PASS`.
- A rota do gateway mapeia `provider.*` para 502; `agent-client` preserva `code/status`, e `TedChat` mantém o envio em estado failed, sem adicionar resposta financeira. Cobertura PWA focal: 19/19.

### Configuração e duplicações verificadas

- O `tedConfig()` atual e a cópia isolada local lida de forma sanitizada apontam `model: opencode-go/deepseek-v4.1-flash`, `provider.use * deny` seguido de `provider.use opencode-go allow`, sem catálogo/provider customizado. O perfil `test`/config r8v7 restaurado permanece sem model e deny-all. A afirmação anterior neste documento de `provider.use * allow` está **supersedida** pelo código/configuração atuais. Não alterei configuração nem fiz inferência; o `native-model-selection.test.mjs` cobre o seletor nativo com fixture local e zero prompts.
- O runtime já usa OpenCode para modelo, seleção/switch nativos, sessão e transcript. `conversations.mjs` persiste somente metadata/IDs/visibilidade/intenção para binding PWA↔sessão/identidade; não duplica transcript, contexto ou memória. `intent-router.ts`/`turn-plan.ts` não aparecem em `apps/ted-runtime`; continuam consumidos pelo A0 em `apps/agent` e ficam para o cutover.
- Removida uma duplicação comprovada: `transport.mjs` agora importa/reexporta o `ToolError` único de `tool-defs.mjs`; nenhuma nova abstração/módulo. O catálogo padrão continua exatamente `list_accounts` + `get_month_summary`. `list_categories` permanece apenas como opt-in P3 explicitamente desativado por padrão/produção; não participou do r8v7.
- Matriz detalhada, arquivos/consumidores e impacto: `docs/reports/P2-FINAL-E2E-CLOSURE-RESULTS.md` — adendo “Investigação r8v7 e matriz native-first”.

### Verificações desta retificação

| Verificação | Resultado | Limite |
|---|---|---|
| `pnpm --filter pi-finance-ted-runtime exec node --test tests/prompt.test.mjs tests/transport.test.mjs` | **34/34 PASS** | Inclui RED→GREEN para `provider.transport` e identidade do `ToolError`; sem inferência. |
| `pnpm --filter pi-finance-ted-runtime test` | **161/161 PASS** | SDK real 2.2.4 e testes de restart com transcript sintético; zero inferência/provider externo. |
| Integrações API gateway/read-slice P2 | **10/10 PASS** | Fastify/in-memory sintéticos; sem Postgres, produção ou escrita financeira. |
| PWA: `TedChat.sent-awaiting-history`, `TedChat.quota-error`, `agent-client.proxy-error-envelope` | **19/19 PASS** | Envelopes de erro e bubble failed; não é browser E2E do turno PWA→modelo. |
| Sonda local do proxy | **PASS component-level** | upstream substituído por stub; conexão SDK→proxy não exercitada; zero fetch externo. |
| Runtime `lint` por `node --check` | **PASS** | `pnpm --filter pi-finance-ted-runtime lint`; também coberto pelo typecheck do monorepo. |
| `pnpm docs:lint` | **PASS** | 17 documentos, zero issues; reexecutado após a última atualização factual desta tabela. |
| `pnpm typecheck` | **PASS** | Contracts, API, PWA, Agent, broker e TED runtime; aviso Node DEP0190 não bloqueante. |
| `pnpm governance:check` | **PASS** | Nenhuma mudança D01–D19 detectada. |
| Biome / `pnpm lint` agregado | **NOT_VERIFIED** | Timeout histórico continua separado; não foi convertido em PASS. |
| `pnpm test` agregado | **NÃO EXECUTADO** | Preservar os relatórios F1 já modificados antes desta sessão. |

**Estado P2: `PARTIAL`; `READ_SLICE_PASS` NOT ACHIEVED.** Sem novo prompt live/inferência externa, escrita financeira, produção, deploy, commit, push, PR ou merge. Campanha r8v7 e banco original preservados.

**Próxima ação única:** depois de nova autorização explícita (provider/modelo/limite), fazer uma única conversa PWA read-only em home local isolada, com instrumentação temporária mínima no runner para distinguir porta/método, entrada/rejeição pré-contador e código de socket — sem retries nem fallback. Até lá, manter P2 bloqueado para alegação funcional integrada.

## Retificação — resultado da sonda offline de transporte (2026-11-03)

- Probe novo preservado fora do worktree: `<LOCAL_TEMP>/opencode/ted-p2-r8v7-offline-probe-20261103/`. Nenhum arquivo, trace ou SQLite da campanha r8v7 foi alterado.
- SDK real 2.2.4 admitiu uma única prompt local; o evento HTTP recebido foi `model.request kind=compaction`. O callback HTTP de teste, espelhando as validações do `runtime-child.mjs`, observou Authorization presente, provider/model/path loopback e nonce corretos, mas recusou `guard:bad-body`; o SDK não chegou ao listener/forward/stub e não recebeu resposta. Não prova sessão PWA nem reproduz o erro live.
- POST sem Authorization ao listener real: `PROXY_RECEIVED`, HTTP 400 `guard:no-auth`, contador permaneceu 0. Um `ECONNRESET` controlado no `fetchFn` é convertido pelo proxy para `guard:upstream-fetch` após contagem; não é falha de socket real nem causa do r8v7.
- `TRANSPORT_ROOT_CAUSE_CONFIRMED=NO`; `TRANSPORT_FIX_PASS=NOT_ACHIEVED`; `TRANSPORT_STILL_UNKNOWN=YES`. O fix de `prompt.mjs` continua preservado e só corrige a classificação do erro terminal.
- Produto local já usa provider/configuração nativos do OpenCode e não possui esse reverse proxy. O proxy `proxy.mjs` é específico do runner de campanha e acrescenta restrições de egress/rota/nonce/caps/contagem; foi mantido para preservar essa fronteira. `SIMPLIFICATION_DONE=NO PRODUCT REDUNDANCY FOUND; zero removals in this task`.
- Evidência detalhada, status de autorização e menor prova live necessária: `docs/reports/P2-FINAL-E2E-CLOSURE-RESULTS.md` e `docs/reports/P2-NATIVE-FIRST-SIMPLIFICATION-RESULTS.md`. Sem novo turno live, rede externa, alteração de produto, dados financeiros, produção ou deploy.

## Retificação — validação final de permissões nativas no prompt-loop (2026-11-04, PR #290)

**Escopo:** base `16a124c`; commits desta rodada `5bae30f` (teste negativo nativo) e `0fe62b1` (tipagem PWA que quebrava o CI). Sem inferência paga, dado financeiro real, merge, deploy ou alteração de produção.

### Negação nativa de tool oferecida ao modelo

| Ponto exigido | Evidência | Estado |
|---|---|---|
| `list_accounts` no catálogo efetivo oferecido ao modelo | `tools[].function.name` da primeira requisição ao stub contém `list_accounts` | PASS |
| Modelo solicita a tool | Script do stub em loopback, sem provider externo | PASS |
| `ctx.permission.assert` chamado com `ted.finance.read` e `['list_accounts']` | Spy delegante registra cada chamada e devolve a decisão nativa real | PASS |
| Negação | Regra nativa de sessão `ted.finance.read` / `list_accounts` / `deny` | PASS |
| Zero chamadas ao transporte financeiro | `transportCalls === 0` | PASS |
| Sem efeito colateral | Negação ocorre antes de `resolveHost`, executor e HTTP | PASS |
| Erro sem vazamento | Envelope de erro com mensagem fixa; sem identidade, token, regra ou `BlockedError` | PASS |

Mecanismo verificado no SDK 2.2.4 instalado:

- A disponibilidade no catálogo (`Tool.snapshot` → `whollyDisabled`) filtra **somente por ação**. Uma regra por recurso não remove a tool do catálogo.
- O `assert` avalia **ação + recurso** (`evaluate3`, `findLast`) sobre `merge(regras do agente, regras da sessão)`. Regras de sessão vêm por último.
- A negação dura (`denied`) ocorre **antes** do hook `permission.evaluate`. Por isso o hook não observa negações, e o teste usa um spy que delega ao `assert` real.
- `session.permissions` é lido por registro de sessão (`store.get(sessionID)`). Em produção, `server.mjs` cria sessões só com `title` e `agent`. A única ocorrência de `permissions` em `apps/ted-runtime/src` é a configuração fixa do agente (`bootstrap.mjs`).

### Mutações (teste restaurado após cada uma; `plugin.mjs` igual ao HEAD ao final)

| Mutação | Resultado do teste |
|---|---|
| 1. Pular `ctx.permission.assert` | FALHA na asserção de chamada `ted.finance.read/list_accounts` (`calls=[]`), no caso positivo e no negativo |
| 2. Remover `options.permission` (regressão do `16a124c`) | FALHA: `list_accounts` ausente do catálogo; o modelo recebe `No tool named "list_accounts" is currently available` |
| 3. Engolir a negação do `assert` | FALHA em `finance transport untouched` (transporte chamado) |

### Shell e write

As negações de `shell` e `write` continuam como estavam e **não** são prova do `assert`. O agente `ted` as remove do catálogo (`{action:'*',resource:'*',effect:'deny'}`), e o erro é `No tool named ... currently available`. É negação de disponibilidade, não de execução.

### Revisão independente

- Revisor (subagent, somente leitura, sem ferramenta de shell): `CHANGES_REQUIRED` com **somente P2 de verificação**. Não rodou o teste nem comparou o diff da PWA. Nenhum P0/P1 de código.
- Fechamento pelo autor: teste reexecutado no HEAD; diff da PWA comparado chamada a chamada (quando a chamada resolve, o `.catch` antigo e o `rejectionOf` novo falham da mesma forma); isolamento de sessão confirmado no código do SDK.
- Superfície: nenhum caminho de cliente altera `permissions` (ver acima).

### CI do PR e correção

- Head `16a124c`: PWA `lint + typecheck + test` e `e2e` falharam por `TS2339` em `TedOpencodeP2.contract.test.ts`, arquivo introduzido pelo próprio PR (commit `d501f5e`). Corrigido em `0fe62b1` com `rejectionOf()`; asserções inalteradas.
- O CI remoto do novo head é a referência final e está registrado na descrição do PR.

### Gates desta rodada (local)

| Gate | Resultado |
|---|---|
| `node --test --test-reporter=tap tests/` (ted-runtime) | PASS: 196/196, 0 falhas, 0 pulados, 37 suítes |
| `tests/prompt-loop-permission.test.mjs` | PASS: 5/5 |
| `pnpm --dir apps/pwa lint` | PASS (exit 0) |
| `pnpm --filter @pi-finance/llm-contracts build` | PASS |
| `pnpm --dir apps/pwa exec vitest run` | PASS: 321 arquivos, 2903/2903 |
| `pnpm --dir apps/pwa typecheck` (`tsconfig.typecheck.json`) | PASS (exit 0) |
| `vitest run` do contrato P2 da PWA | PASS: 27/27 |
| `next build`, etapa TypeScript e páginas estáticas | PASS (`Finished TypeScript`; páginas 6/6) |
| Testes `pwa-audit-policy/output/workspace` | PASS |
| `pnpm lint` na raiz | PASS (exit 0, 122 s); ver Biome abaixo |
| `pnpm --filter pi-finance-ted-runtime typecheck` / `lint` | PASS |
| `docs:lint`, `action-pins:check`, `workflows-yaml:check`, `test:skip-gate`, `capabilities:check`, `write-policy:check`, `governance:check`, `boundary:check`, `public-safety --strict`, `plans:check` | PASS (exit 0) |
| Hooks de pré-commit dos dois commits | PASS (mesmos gates acima) |

### Limitações, NOT RUN e BLOCKED

- **Cloudflare build (OpenNext): NOT RUN local, BLOCKED no Windows.** `next build` concluiu, mas o empacotamento do OpenNext falha ao carregar o binário nativo `sharp-win32-x64` (o próprio OpenNext avisa que não é totalmente compatível com Windows). A referência é o job `PWA — Cloudflare build` no Linux.
- **Auditoria escopada `scripts/pwa-audit.mjs`: NOT RUN local.** Falha em `npm install --package-lock-only` com `EALLOWREMOTE` (npm 12.2.0 local, Node 26; o CI usa Node 22). O `apps/pwa/package.json` não mudou neste PR e os locks não contêm entradas `tarball:`, então não é efeito do PR. A política do npm não foi afrouxada.
- **CORS contra produção: SKIP local por design** (`PWA_PROD_URL` ausente; o script sai com 0). O CI injeta a variável.
- **E2E Playwright (`e2e (22, 10)`): NOT RUN local.** Depende do mesmo build e de navegadores. A falha anterior era o `TS2339` já corrigido.
- **API e Agent: sem alteração neste PR**; os jobs do head `16a124c` passaram no CI. Não foram reexecutados localmente nesta rodada.
- **Biome: issue #291.** A primeira execução da raiz ficou sem saída por mais de 30 min; a segunda concluiu em 122 s com exit 0. Causa não identificada. Os avisos (API 148, agent 231) são `warning`.

### Critérios do P2 (`READ_SLICE_PASS`)

- **`READ_SLICE_PASS`: NOT ACHIEVED.** Exige PWA → proxy → gateway → OpenCode com **modelo real autorizado** → tools → API → DTO → PWA, com erros, cancelamento, visibilidade e recuperação/reload integrados. Esta rodada usou provider scriptado e não autorizou inferência; logo não há prova integrada.
- **Recuperação/reload integrados: NOT VERIFIED nesta rodada.** Os testes focados de reload e histórico passam por componentes (`TedChat.reload`, `route.p2-real-history`). Não há conversa gerada por modelo recuperada ponta a ponta no browser.
- **Catálogo efetivo com modelo real: NOT PROVEN.** Provado o catálogo efetivo no prompt-loop real do SDK com provider scriptado (`list_accounts` oferecido).
- **Negação nativa com modelo real: NOT PROVEN.** Provada com provider scriptado (acima).

**Estado P2 após esta rodada: `PARTIAL`.** Sem inferência paga, dado financeiro real, merge, deploy ou alteração de produção.

**Próxima ação:** para `READ_SLICE_PASS`, autorização explícita de provider, modelo e teto. Sem isso, não repetir inferência.

### Retificação de CI — Node do probe real-history (2026-11-04)

- **CI do head `0b13a3d`** (runs `41817658789` e `41817658928`): PASS em API, Agent, Codex Broker, Postgres, Docker, Documentation, Governance, Security, Public safety, Write policy, Capability inventory, `PWA — Cloudflare build + headers + JS budget` e `e2e (22, 10)`. FAIL em `PWA — lint + typecheck + test` e `quality (22, 10)`, ambos pelo mesmo teste.
- **Causa raiz verificada:** `route.p2-real-history.test.ts:232` (`seedRun.code === 0`) falha porque o probe não consegue importar o SDK 2.2.4 sob Node 22. O erro é `SyntaxError: Unexpected identifier '_'` em `@opencode/util/dist/flock.js:262` (`await using _ = …`, explicit resource management). Reprodução no WSL Linux: Node 22.22.1 sai com código 1 (`sdk-unavailable`); Node 24.22.2 importa o SDK, faz o seed com código 0 e grava 120 mensagens.
- **Versão mínima com evidência:** Node 24 para o SDK 2.2.4 usado pelo runtime. O `engines` de `apps/ted-runtime` (`>=22.12.0`) estava incorreto e passou a `>=24`.
- **Correção (commit `413312a`):** processos filhos do probe executam sob `TED_PROBE_NODE`, com padrão `process.execPath`. O CI baixa Node 24.22.2 fixado, verifica SHA256 contra o `SHASUMS256.txt` oficial e exporta `TED_PROBE_NODE`. O `PATH` continua no Node 22 e os nomes dos checks obrigatórios (`quality (22, 10)`) não mudam. A asserção do seed agora mostra o veredito sanitizado do probe.
- **Verificação local:** o bloco `run` do passo foi simulado em bash Linux (checksum OK, `TED_PROBE_NODE` exportado, `PATH` inalterado). A rota real-history passou 1/1 com o Node padrão e 1/1 com `TED_PROBE_NODE` apontando para Node 24 Windows verificado por SHA256. Passaram: typecheck e lint da PWA, typecheck e lint do `ted-runtime`, `docs:lint`, `workflows-yaml`, `action-pins` e gates de pré-commit.
- **Lacuna registrada:** `apps/ted-runtime` não tem job de CI próprio. Os 196 testes do runtime não rodam em nenhum workflow; o probe só roda indiretamente pela PWA. Recomendado: job dedicado em Node 24, em follow-up.
- **Estado do CI do novo head `07e1be2`** (run `41821599067` do `CI`; run `41821598965` do `PWA CI`): o `CI` principal passou inteiro, incluindo `PWA — lint + typecheck + test`, `PWA — Cloudflare build + headers + JS budget` e `Gate — all checks`. `e2e (22, 10)` passou. `quality (22, 10)` falha **somente em `Scoped audit`**; todas as etapas anteriores passaram, inclusive o teste com o probe em Node 24 e os testes da política de auditoria.
- **Causa do bloqueio de auditoria (não causada pelo PR):** `check-pwa-audit: BLOCKED rimraf — no matching allowlist entry`. `rimraf` (moderate, via `glob`, efeito em `chrome-launcher`) é transitivo de `lighthouse`/`@lhci`. Reproduzido em Linux com Node `22.22.1` e npm `10.9.9`, o mesmo ambiente do CI. O `origin/main` (`003ee57`) produz o **mesmo resultado** (39 aceitos, 35 resolvidos, 1 bloqueado). Insumos da auditoria (`apps/pwa/package.json`, `scripts/pwa-audit-allowlist.json`, scripts de auditoria) são idênticos entre `main` e o PR. O último PWA CI verde da `main` foi em 2026-11-03. É drift do advisório do npm.
- **Decisão pendente do owner (não tomada nesta rodada):** aceitar o advisório exige entrada de allowlist com justificativa e expiração, ou override/upgrade. A política do repositório não permite override sem aprovação. Entrada proposta, não adicionada: `id` `pwa-2026-11-04-rimraf`, `scope` `build-time`, `severity` `moderate`, `name` `rimraf`, `via` `["glob"]`, `effects` `["chrome-launcher"]`, `range` `2.3.0 - 3.0.2 || 4.2.0 - 6.1.3`, `expiresOn` `2026-12-31`. A correção sugerida pelo npm é o downgrade major `@lhci/cli` 0.3.3, quebrante.
- **Não executado no CI deste head:** as etapas da `quality` após `Scoped audit` (CORS passivo e Playwright offline shell E2E), porque o job para na auditoria. Estado: NOT VERIFIED neste head.
- **Lacuna de CI pendente:** `apps/ted-runtime` segue sem job próprio, como registrado acima. Não foi adicionado nesta rodada, para não ampliar a mudança de CI além do necessário.

## P3 — fatia de despesa por conversa (2026-11-06)

**Autorização do operador:** opção B do relatório de bloqueio A4 — o runtime OpenCode
emite apenas uma INTENÇÃO; a PWA autenticada chama um broker estreito no Agent
existente, o único componente que emite `financial.approval.propose`. Nenhum
segredo de delegação entra no gateway, nenhuma permissão nasce de LLM e a
política da API não foi alterada.

### Fluxo entregue

1. `POST /rpc/chat` (runtime) → prompt loop nativo → `propose_expense` valida
   `{amountCents, description, date, accountId, categoryId}` (identidade sempre
   host-bound) e registra o intent `{tool, intentionId, normalizedArgs, summary}`
   no registry process-local. Zero HTTP financeiro, zero escrita.
2. O gateway anexa `proposal` ao DTO do turno bem-sucedido, exatamente uma vez
   (`take` destrutivo; `clear` no início de cada turno).
3. `TedChat` envia o intent a `POST /rpc/pending-operations/propose` no Agent,
   com a sessão/device autenticados. Falha do broker marca a mensagem como
   retentável e NÃO inventa card.
4. O broker do Agent emite SOMENTE `financial.approval.propose` (device-bound,
   `requestId` = intentionId) e chama `createMutationProposal` com
   `deriveIdempotencyKey(workspace, intentionId, tool)`. Não existe
   confirm/execute/cancel/authorize nesse caminho.
5. A API valida o contrato canônico, persiste Pending V2 e mantém a autoridade.
6. `TedChat.loadHistory` reidrata o card da lista ativa autoritativa; a
   confirmação/rejeição continua no caminho existente
   (`/rpc/pending-operations/:id/decision`), com o token de decisão emitido pelo
   Agent. Recibo canônico e refresh financeiro inalterados.

### Arquivos

- Runtime: `src/proposal-intents.mjs` (novo), `src/tool-defs.mjs`,
  `src/plugin.mjs`, `src/bootstrap.mjs`, `src/server.mjs`, `README.md`.
- Agent: `src/mutations/pending-proposal-broker.ts` (novo),
  `src/finance-chat-agent.ts`, `src/worker.ts`.
- PWA: `src/lib/api/agent-client.ts`, `src/features/ted/TedChat.tsx`.
- Testes: `apps/ted-runtime/tests/p3-propose-expense.test.mjs`,
  `p3-proposal-handoff.test.mjs`, `p3-propose-loop.test.mjs`;
  `apps/agent/tests/pending-propose-rpc.test.ts`,
  `worker-pending-propose.test.ts`;
  `apps/pwa/src/lib/api/__tests__/agent-client.proposal.test.ts`,
  `apps/pwa/src/features/ted/__tests__/TedChat.propose.test.tsx`;
  `apps/api/tests/integration/p3-expense-slice.test.ts`,
  `p3-expense-broker-flow.test.ts`.

### Evidências desta rodada

| Verificação | Resultado | Limite |
|---|---|---|
| `node --test tests/` (ted-runtime) | **242/242 PASS** | Inclui o prompt loop REAL 2.2.4 com provider scriptado local (`p3-propose-loop`). Zero inferência paga/externa. |
| Agent focado (`pending-propose-rpc`, `pending-operations-active-rpc`, `pending-operation-v2-contract`, `finance-chat-agent-rest-contract`) | **30/30 PASS** | Broker: token decodificado com `['financial.approval.propose']`, device, requestId; replay estável; sem confirm/execute. |
| Agent completo | **3959 PASS / 1 skip** | Suíte integral executada nesta rodada. |
| API completa | **2903 PASS / 425 skips** | Skips são provas Postgres sem `DATABASE_URL_TEST`. |
| PWA completa | **2926 PASS** | Inclui cliente do intent, card após reload e falha sem card falso. |
| `p3-expense-slice` + `p3-expense-broker-flow` | **6/6 + 4/4 PASS** | Zero antes da confirmação, exatamente 1 depois, reject zero, replay sem duplicata, reload recupera, workspace estranho 403. |
| `pnpm typecheck` | **PASS** | 6 workspaces. |
| `check-agent-v2-invariants` (A4/A9) | **PASS** | 542 arquivos; nenhuma capability de escrita fora do executor; broker é o único emissor de propose. |
| `pnpm write-policy:check` | **PASS** | 183 writes / 183 policy rows. |
| CI remoto (PR #293, `e6989c2`) | **PASS** | `Gate — all checks` + `TED Runtime — lint + typecheck + test` + API/Agent/PWA/Postgres/Security/Docs; PWA CI `quality (22, 10)` + `e2e (22, 10)` |

### Estado e limites

- **`P3_EXPENSE_SLICE_PASS`** no escopo local/determinístico: mensagem → intent →
  broker → Pending V2 → card → confirmação → 1 lançamento → recibo, com rejeição
  zero e sem duplicidade.
- **Não executado:** browser E2E completo com A0 local, inferência real
  (DeepSeek), Postgres real, deploy, merge. O provider do teste é scriptado
  (`testloop` local); `READ_SLICE_PASS` continua **NOT ACHIEVED**.
- **Resíduo conhecido:** se o turno concluir e a chamada do broker se perder, o
  retry reusa a MESMA intenção (idempotente), mas o turno recuperado não
  reemite o intent — o usuário precisa de uma nova mensagem. Não há duplicação
  financeira nesse caminho.
- **A0 modificado:** a rota aditiva `/rpc/pending-operations/propose` foi
  autorizada pelo operador nesta sessão; escopo limitado a despesa. O A0 continua
  o dono do pipeline conversacional (o broker não interpreta texto nem propõe
  draft).
