# Resultado — simplificação native-first do Meu TED

**Data:** 2026-11-03  
**Worktree:** `D:/projetos/pi-ted-opencode-product`  
**Branch:** `feat/ted-opencode-product`  
**Estado P2:** `PARTIAL / TRANSPORT_ROOT_CAUSE_NOT_VERIFIED`
**`NATIVE_CONFIG_PASS`: PASS**  
**`LIVE_CONFIG_PASS` (addendum 2026-11-03): PASS — SDK resolveu provider, modelo default e sessão sem `session.prompt`**  
**`CHAT_PASS`: PARTIAL — provas determinísticas por componente, sem E2E integrado da mesma conversa**  
**`READ_SLICE_PASS`: NOT ACHIEVED**

## Resumo executivo

A inspeção confirmou que o perfil embarcado do TED ainda é deny-all: não tem default `model`, provider ativo ou credenciais, e nega `provider.use`. O bloqueio `guard:bad-model` relatado em `q7r2` não tem emissor rastreável no código atual do runtime; o trace só guardou `providerMatch=true` e `modelMatch=false`, sem o `modelID` recebido. Portanto, a hipótese de divergência de identificador não foi elevada a causa-raiz exata.

Foi adicionado um teste isolado do SDK 2.2.4 que resolve um default nativo de catálogo local e troca o modelo da mesma sessão via `session.switchModel`, sem `session.prompt`, provider remoto, transporte financeiro ou custo. O código de produto e os contratos financeiros não precisaram de alteração. As evidências anteriores de gateway, PWA, histórico e restart permanecem úteis por componente; não constituem um único E2E conversacional da mesma sessão. O live P2 aguarda nova autorização específica e não reutiliza campanha/orçamento anterior.

## Configuração observada

### Runtime TED

`apps/ted-runtime/src/bootstrap.mjs::tedConfig()` é a configuração efetiva que o produto escreve no perfil isolado:

- `default_agent: "ted"`; o runtime também cria sessões explicitamente com `agent: "ted"`.
- Sem root `model` e sem catálogo `providers`.
- `provider.use: deny` para todos os providers.
- `tool.use` nega built-ins administrativos (`shell`, `edit`, `write`, `subagent`, entre outros); o plugin TED oferece somente `list_accounts` e `get_month_summary` por padrão.
- `apps/ted-runtime/package.json` fixa `@opencode/sdk` e `@opencode/plugin` em `2.2.4`.

Esse perfil não é o catálogo do OpenCode primário usado pelo agente nesta sessão. A ferramenta de catálogo do OpenCode, consultada sem geração, listou **24** modelos de `opencode-go`; `iceman-contributor-free` e `beam-free` tinham custo publicado zero e `deepseek-v4.1-flash` estava ativo, com preço listado de US$ 0,15/M input e US$ 0,60/M output. Isso não habilita nem comprova disponibilidade no perfil TED isolado. Nenhum desses modelos foi chamado.

### Semântica nativa confirmada

As referências usadas foram a documentação oficial OpenCode V2 (`/v2/docs/models`, `/v2/docs/config`, `/v2/docs/build/sdk`, `/v2/docs/api`) e os tipos instalados de `@opencode/client@2.2.4` / `@opencode/plugin@2.2.4`:

- Default de configuração: `model: "provider/model"`.
- No tipo do hook `SessionHttpRequest`, `event.model` é `Model.Ref` com `providerID` e `id`; o `modelID` configurado no provider é o identificador enviado ao endpoint e não é o nome do campo do hook.
- `SessionPromptInput` não aceita modelo por prompt.
- Seleção posterior nativa: `session.switchModel({sessionID, model:{id, providerID, variant?}})`. `session.get()` retorna `SessionInfo.model` para a seleção da sessão.
- Um modelo configurado que não esteja disponível pode cair no modelo disponível mais novo conforme a documentação atual. O perfil TED, portanto, continua sem default/provider habilitado até autorização/configuração efetiva; não se acrescentou fallback próprio.

## Bloqueio `guard:bad-model`

O registro de `q7r2` mostra que um hook `http.request` foi invocado, viu `providerMatch=true` e `modelMatch=false`, bloqueou antes do proxy e não enviou request ao provider. O identificador efetivamente recebido não foi persistido. Logo:

- **Observado:** o hook falhou no teste de modelo antes do proxy.
- **Não observado:** o valor exato de `modelID`, a comparação literal que falhou e o arquivo que registrou o hook daquela execução.
- **Checkout atual:** busca por `guard:bad-model` encontrou o texto somente nos relatórios; não existe esse emissor em `apps/ted-runtime/src/` nem no gateway PWA.
- **Falso positivo descartado:** `apps/agent/tests/poc-structured/f2b0-runtime/real-guard.mjs::validateNativeRequest` compara modelo e endpoint para um harness F2B0 separado e emite outra razão (`model-mismatch`). É uma guarda de destino de campanha, não prova do hook `q7r2`; foi preservada.

Não foi possível remover o emissor transitório porque seu código não está no checkout. O runtime de produto permanece provider-deny-all; não adicionamos alias, catálogo paralelo, hook de modelo ou fallback.

## Prova determinística de seleção nativa

Novo arquivo: `apps/ted-runtime/tests/native-model-selection.test.mjs`.

- Usa o SDK real 2.2.4 e diretório temporário isolado, sem limpar o artefato.
- O `opencode.json` **somente de teste** configura `model: "testloop/test-alpha"` e um provider OpenAI-compatible com baseURL loopback sem servidor, chave dummy e dois modelos fixture. Uma policy do teste permite apenas `testloop`; o `tedConfig()` do produto não muda.
- Intercepta `fetch` antes de importar/criar o SDK; todo fetch falha antes de sair do processo. `session.prompt` é substituído por um guard que lança.
- `config.get()` mostra o seletor nativo decodificado; `provider.list()` contém só `testloop`; `model.list()` contém exatamente `test-alpha` e `test-beta`; `model.default()` resolve `test-alpha`.
- Uma única sessão `ted` troca `test-alpha → test-beta → test-alpha` via `session.switchModel`; `session.get()` mantém o mesmo ID e as permissões de `shell/edit/subagent` continuam negadas.
- Resultado: `node --test apps/ted-runtime/tests/native-model-selection.test.mjs` **PASS — 1/1**; `node --check` **PASS**. Tester independente: **PASS — 1/1**. Reviewer independente: **APPROVED**. Nenhum prompt, request ao provider fixture, API financeira ou dado real.

Limite: isso prova a configuração/catálogo/teste de seleção no SDK, não que o modelo gere uma resposta; a sessão recém-criada começa com `model` unset, o default fica resolvido no catálogo e não foi enviado prompt para observar sua aplicação a um turno. O SDK pode emitir GETs de housekeeping/catalog local, interceptados e rejeitados; nenhum fetch teve sucesso.

## Conversa e histórico na PWA

Não foi repetida nenhuma campanha. Os seguintes resultados existentes em `IMPLEMENTATION-STATUS.md` e nos relatórios P2 foram preservados como evidência histórica, sem serem apresentados como uma única conversa integrada:

- `p2-history-refresh.test.mjs`: POST/chat determinístico através do gateway e tratamento/recovery de histórico no SDK por doubles.
- `route.p2-real-history.test.ts`: PWA route/client → gateway loopback → SQLite do SDK; transcript **sintético importado**, reaberto em outro processo, reload/recovery sem `session.prompt`.
- `TedChat.reload.test.tsx`: **8/8 PASS**; resposta determinística de envio concluído permanece visível apesar de falha no refresh, sem retry do POST.
- Sete arquivos PWA focados: **78/78 PASS** em execução anterior serial; gateway/read-slice API sintéticos: **8/8 PASS**. Não foram reexecutados porque nenhum desses arquivos foi alterado nesta missão.
- A campanha live histórica de 2026-11-01 gerou resposta e chamou as duas tools read-only, mas falhou no GET de histórico; `q7r2` posterior foi bloqueado antes do provider. Nenhuma dessas tentativas recupera uma resposta live após restart.

**`CHAT_PASS` permanece PARTIAL**: há contrato determinístico de envio/render e prova de histórico/restart em testes distintos, mas falta uma única prova da mesma conversa PWA → gateway → prompt OpenCode → resposta → reload/restart. Não se declara inferência real com base em fixtures/imports. **P2 permanece `READY_FOR_LIVE`** para um turno live autorizado; `READ_SLICE_PASS` não foi alcançado.

Nesta missão não foi executado Playwright/browser E2E nem `session.prompt`. As provas PWA citadas são anteriores e usam doubles ou transcript sintético importado; foram preservadas e não reapresentadas como uma conversa integrada.

## Simplificação e fronteiras preservadas

| Componente | Decisão | Motivo |
|---|---|---|
| Guard de modelo de `q7r2` | Não editado | Emissor não encontrado no checkout; origem/model ID não persistidos. |
| Guard do harness F2B0 | Mantido | Pertence a uma campanha separada; protege provider/model/endpoint e não é o código de `q7r2`. |
| PWA proxy same-origin, pin A0/B e feature flag | Mantidos | Fronteira de produto e roteamento exclusivo; não duplicam a seleção de modelo OpenCode. |
| Gateway, sessão/ownership, bindings e store de conversas | Mantidos | Auth/visibilidade, associação de conversa e recuperação, fora do que o SDK resolve. |
| `PromptHost` | Mantido | Adapta a admissão `session.prompt` e leitura nativa de mensagens ao DTO PWA; `session.prompt` não devolve o texto final. |
| Façade/plugin/transporte financeiro | Mantidos | Só schemas/tools permitidas e chamadas GET host-bound; raw SDK/admin não chega à PWA. |

**Linhas/módulos removidos:** 0 linhas e 0 módulos de produção. Nenhuma duplicação comprovada no runtime TED podia ser removida com segurança. **Delta da missão:** um teste novo de 261 linhas; nenhuma edição de aplicação, API, PWA, A0, Pending V2 ou recibos.

## Biome e gates

O timeout foi investigado separadamente: `biome --version`, `check --help` e `rage` respondem e mostram Biome 2.2.4/config da raiz carregada (`VCS enabled: false`, Node 26.11.1, pnpm 10.34.1). O check de `src/index.ts` excedeu 120 s; com log detalhado, o processo auto-descobriu a raiz do monorepo e parou após `Insert workspace folder`. Entrada via stdin respondeu, mas emitiu diagnóstico de formatação e **não** é PASS. Após o timeout, não havia processo Biome residual. Hipótese estreitada para indexação/varredura do workspace ou filesystem Windows; causa exata **NOT_VERIFIED**.

| Gate | Resultado |
|---|---|
| Teste novo de seleção nativa | **PASS — 1/1** |
| `pnpm --filter pi-finance-ted-runtime test` | **PASS — 157/157** |
| Tester independente | **PASS — 1/1** |
| Reviewer independente | **APPROVED** |
| `pnpm docs:lint` | **PASS — 17 documentos canônicos** |
| `lintMarkdownDocument` nos dois arquivos novos | **PASS — 0 issues** |
| `pnpm typecheck` | **PASS — contracts, API, PWA, Agent, broker e TED runtime** |
| `pnpm governance:check` | **PASS — 0 mudanças D01–D19** |
| Biome `check src/index.ts` | **TIMED_OUT / NOT_VERIFIED — 120 s** |
| `pnpm test` agregado | **NÃO EXECUTADO** — evitar regenerar `ted-f1-baseline.json` e `ted-f1-journeys.json` já modificados antes desta missão |
| `pnpm lint` agregado | **NOT_VERIFIED** — não executado; o primeiro estágio Biome continua pendente |

Não houve inference/provider, consulta à API financeira, escrita financeira, acesso a dados reais, deploy, publicação, merge ou gasto de campanha nesta execução.

## Pendências para P3

- Antes de afirmar o fechamento da conversa completa, obter uma nova autorização para uma única tentativa PWA live com provider/modelo e teto explícitos, incluindo reload e restart da mesma sessão; não repetir `q7r2` nem consumir orçamento anterior.
- `list_accounts` e `get_month_summary` continuam sendo as únicas tools financeiras padrão. P3 de escrita segue bloqueado pela fronteira A4: nenhum token/capability `financial.approval.propose` foi movido ao gateway, e contratos de Pending V2/recibos não foram alterados.
- Não expor SDK administrativo ao browser, não adicionar shell/edição ao TED, não desligar A0.

## Addendum — ativação do perfil live nativo (2026-11-03)

### Configuração efetiva e perfis

`apps/ted-runtime/src/bootstrap.mjs::tedConfig()` agora mantém dois perfis explícitos; somente `src/main.mjs` lê `TED_RUNTIME_PROFILE` e encaminha o valor. Helpers e testes sem perfil explícito continuam em `test`, independentemente do ambiente pai.

| Perfil | Configuração OpenCode | Credenciais | Segurança/inferência |
|---|---|---|---|
| `test` (default) | Sem `model` ou catálogo `providers`; `provider.use * deny`; tool denies originais | As variáveis enumeradas em `SCRUB_VARS`, incluindo `OPENROUTER_API_KEY` e `ZAI_API_KEY`, são scrubbed | A fixture existente usa `testloop`, `127.0.0.1:9`, chave dummy, fetch bloqueado e `session.prompt` que lança; zero inferência |
| `live` (opt-in: `TED_RUNTIME_PROFILE=live`) | Seletor nativo `openrouter/openai/gpt-6-luna`; mantém `provider.use * deny` e acrescenta `provider.use openrouter allow` depois; sem aliases ou catálogo customizado; todos os tool denies mantidos | Preserva somente `OPENROUTER_API_KEY` entre as variáveis enumeradas em `SCRUB_VARS`; valor não é lido, copiado ou logado | Sem hook/roteador/gerenciador de modelos próprio; OpenCode nativo trata credencial ausente |

O OpenAI account salvo no banco global do OpenCode não é copiado nem compartilhado. O live usa a variável de ambiente OpenRouter já presente no launcher. A base TED permanece isolada em `<TED_RUNTIME_HOME>/.ted-home-local/db/ted.db`; configuração em `<TED_RUNTIME_HOME>/.ted-home-local/config/opencode.json`. A configuração efetiva foi escrita no home persistente TED local, sem alterar o banco global do OpenCode. Nenhuma sessão de usuário preexistente foi encontrada.

### Evidência `LIVE_CONFIG_PASS`

- OpenCode CLI local: **2.2.5**; runtime TED usa `@opencode/sdk` **2.2.4**.
- A API real do SDK carregou o `opencode.json` TED e decodificou `model` como `{ providerID: "openrouter", model: "openai/gpt-6-luna" }`.
- `provider.list()` incluiu `openrouter`; `model.list()` continha o ID `openrouter/openai/gpt-6-luna`; `model.default()` resolveu `{ providerID: "openrouter", id: "openai/gpt-6-luna", modelID: "openai/gpt-6-luna" }`.
- Uma sessão foi criada com `agent: "ted"`, recuperada pelo mesmo ID e removida após a verificação. O campo de modelo da sessão ficou unset, usando o default nativo configurado.
- `session.prompt` foi substituído por um contador/erro; resultado: **0 chamadas**. O fetch de catálogo foi instrumentado: só GETs foram observados e todos foram bloqueados (zero fetch bem-sucedido); não houve POST, chamada ao provider, chamada à API financeira ou dado real. A resolução ocorreu com o catálogo local disponível ao SDK.
- A configuração `test` foi preservada e o teste `native-model-selection.test.mjs` passou **2/2** após a mudança final. O Tester independente também validou os testes de perfil/bootstrap/main e `pnpm typecheck`; Reviewer e Security Reviewer aprovaram.
- Verificação final do pacote: `pnpm --filter pi-finance-ted-runtime test` **158/158 PASS**, `pnpm --filter pi-finance-ted-runtime typecheck` **PASS**, `pnpm docs:lint` **PASS — 17 documentos, 0 issues**. A suíte inteira é composta por testes existentes; os casos de prompt usam doubles e não chamam provider real.

**Status:** `LIVE_CONFIG_PASS = PASS`. Isso comprova apenas configuração, catálogo e resolução de sessão sem inferência. **Não comprova autenticação em uma chamada ao provider nem uma resposta gerada.**

### Conversa PWA → OpenCode → API → PWA e recuperação

A conversa integrada ainda não foi executada. O provider/modelo escolhido para uma futura tentativa é OpenRouter / `openrouter/openai/gpt-6-luna`, com teto autorizado de **US$ 1 por turno**; esse teto é um limite operacional informado, não uma trava de gasto implementada pelo runtime/OpenCode. Não houve `session.prompt` nem consumo de inferência nesta sessão.

Preparação para a única tentativa futura (local, read-only): iniciar o Ted runtime com `$env:TED_RUNTIME_PROFILE='live'; pnpm dev:ted-runtime` e a mesma identidade/home; usar a PWA e API locais (`127.0.0.1`, nunca produção); enviar uma única pergunta read-only, `TED, quais contas eu tenho?`; verificar a resposta e o histórico na PWA; reiniciar somente o processo TED; reautenticar/revincular conforme o fluxo da PWA e carregar o histórico da mesma conversa sem repetir o POST de chat. Registrar IDs da conversa/turno/sessão e evidência do uso/custo do provider. A variável OpenRouter também precisa estar herdada pelo processo de lançamento; nenhum valor foi persistido em arquivo. A recuperação real da resposta da mesma conversa após restart permanece **NOT RUN / NOT PROVEN** até essa tentativa autorizada.

Nesta tarefa não foram alterados produção, código da PWA/API, dados financeiros, serviço compartilhado do OpenCode ou banco global; não houve push, PR, merge ou deploy.

## Retificação — diagnóstico offline de transporte r8v7 (2026-11-03)

> A seção OpenRouter/GPT-6-Luna acima descreve a preparação anterior; foi supersedida pela campanha r8v7, que usou `opencode-go/deepseek-v4.1-flash`. A sonda abaixo fez um prompt local para stub, não uma inferência externa.

### Evidência e classificação

- O r8v7 original permanece intacto. Seu hook passou provider/model, host/path loopback, nonce e limites de body, mas não registrou método, porta efetiva, presença de Authorization, entrada no listener, rejeição/status ou código de socket. `proxy.count=0` continua sem distinguir request não enviada/conexão local falha de rejeição antes do contador.
- A prova local nova ficou em diretório temporário redigido (`<LOCAL_TEMP>/opencode/ted-p2-r8v7-offline-probe-20261103/`; o arquivo de observações não foi incluído), usou SDK 2.2.4, config da campanha, credencial dummy e egress restrito a loopback. Uma única admissão `session.prompt` gerou `model.request kind=compaction`; o hook HTTP recebeu provider/model, URL/path, nonce e Authorization, mas recusou `guard:bad-body`. Essa request não chegou ao listener, não foi encaminhada e não recebeu resposta do stub. A callback do probe espelha as validações de `runtime-child.mjs`; não é o closure original da campanha.
- Um POST sem Authorization, separado e enviado diretamente ao listener real, foi recebido e rejeitado com HTTP 400 `guard:no-auth`; contador 0→0. Isso confirma a possibilidade de rejeição pré-contador, não que tenha ocorrido no r8v7.
- Um erro `ECONNRESET` injetado no `fetchFn` do proxy foi convertido em `guard:upstream-fetch` após incrementar o contador. O código nativo não atravessa essa fronteira; o teste não foi uma falha de socket real nem reproduziu o resultado do SDK.
- `TRANSPORT_ROOT_CAUSE_CONFIRMED = NO`; `TRANSPORT_FIX_PASS = NOT_ACHIEVED`; `TRANSPORT_STILL_UNKNOWN = YES`. A correção preservada em `prompt.mjs` tipa o erro terminal observado; não é correção do transporte.

### Comparação native-first e responsabilidade do proxy

| Camada | Responsabilidade comprovada | Decisão |
|---|---|---|
| Provider do runtime TED (`apps/ted-runtime/src/bootstrap.mjs`, `main.mjs`) | Usa catálogo/configuração e seleção nativos do OpenCode; o produto não implementa proxy de provider nem gerenciador/roteador próprio. Home isolada, scrub de ambiente por perfil, tool denies e API financeira host-bound continuam separados. | **Manter o fluxo nativo.** O produto local já não depende do proxy da campanha; não há camada de provider redundante a remover. |
| Proxy do runner r8v7 (`.../ted-p2-live-20261103-campaign-r8v7/proxy.mjs`, com `runtime-child.mjs`) | Limita egress à rota aprovada, exige nonce e Authorization, valida caps, conta requests e impede o child de discar upstream diretamente. Isso protege a campanha controlada, não implementa uma responsabilidade de produto. | **Preservar no harness.** Não o copiar para a operação normal nem removê-lo da campanha como atalho para a prova. OpenCode nativo não fornece esses limites específicos de campanha. |
| Proxy same-origin PWA (`apps/pwa/src/app/api/agent/[...path]/route.ts`) | Mantém auth/sessão e fronteira browser→gateway do produto; não é o proxy de provider r8v7. | **Manter.** Não é redundante com o transporte nativo de provider. |

**Simplificação:** nenhuma linha/módulo foi removido nesta retificação. `SIMPLIFICATION_DONE = NOT_APPLICABLE / NO PRODUCT REDUNDANCY FOUND`: usar OpenCode diretamente já é o caminho do produto; o único proxy inspecionado é uma guarda específica do runner de campanha. A duplicação `ToolError` anteriormente consolidada permanece como alteração histórica, não como remoção desta tarefa.

### Próxima evidência necessária

Sem novo prompt live nesta tarefa. Para fechar a causa, falta uma única tentativa PWA local read-only, autorizada separadamente, com logs estruturados temporários em cópia nova do runner: `HOOK_RECEIVED` com método/porta/path/auth-present/body length; `PROXY_RECEIVED` antes da leitura do body; `PROXY_REJECTED` com status/código antes do contador; `FORWARD_ATTEMPTED` antes do fetch; `TRANSPORT_FAILED` com `name`, `code` e `cause.code`. Não gravar body, Authorization ou segredos; sem retry/fallback; preservar o diretório r8v7.

**Limitação de escopo:** o probe offline não percorreu uma resposta bem-sucedida SDK→hook→listener→stub→SDK, não executou gateway/PWA/API financeira e não prova o turno completo `session.prompt`. Os artefatos e a matriz detalhada ficam em `docs/reports/P2-FINAL-E2E-CLOSURE-RESULTS.md`.
