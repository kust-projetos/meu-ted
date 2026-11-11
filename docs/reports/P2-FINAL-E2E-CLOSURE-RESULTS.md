# MEU TED — P2 Final E2E Closure Results

**Data inicial:** 2026-11-02 · **Última atualização:** 2026-11-04 (adendo PR #290 de CI/audit; sem nova campanha live)

**Veredito geral:** **PROMPT_ERROR_NO_OUTPUT** (um prompt admitido em 2026-11-03, PWA retornou 502 `prompt.no_output`; sem resposta financeira)  
**READ_SLICE_PASS:** **NOT ACHIEVED**  
**Worktree:** `D:/projetos/pi-ted-opencode-product`  
**Branch:** `feat/ted-opencode-product`  
**HEAD observado:** `0a37e9e0f7481e034b123336eff1267dddfde9ab`

## Decisão e escopo

Na preparação registrada em 2026-11-02, não havia autorização para uma **nova** campanha com provider, modelo e teto monetário. A autorização de 2026-11-01 (`opencode-go/deepseek-v4.1-flash`, até US$ 5) pertencia à campanha anterior e não foi reutilizada. A autorização separada recebida em 2026-11-03 é documentada na seção desta tentativa.

Ao final da preparação de 2026-11-02, o estado era `READY_FOR_LIVE`; isso não equivalia a `READ_SLICE_PASS`. A tentativa anterior autorizada em 2026-11-03 (OpenRouter / `openai/gpt-6-luna`) ficou `BLOCKED_PROVIDER` antes de iniciar serviços ou inferência. Essa tentativa histórica foi supersedida pela campanha r8v7 mais recente, com resultado `PROMPT_ERROR_NO_OUTPUT` (um prompt admitido, sem resposta financeira; `READ_SLICE_PASS` NOT ACHIEVED).

## Preservação do estado

- Na execução original de 2026-11-02, o checkout já estava dirty, com alterações P1/P2 e relatórios F1 preexistentes; foram preservados e a única alteração daquela execução foi este relatório. Na tentativa de 2026-11-03 foram atualizados somente este relatório e `docs/plans/2026-10-31-ted-opencode-first/IMPLEMENTATION-STATUS.md`; nenhum arquivo de aplicação, configuração ou estado foi alterado.
- Os traces originais permanecem fora do repositório em um diretório temporário local redigido (`<LOCAL_TEMP>/opencode/ted-p2-live-<redacted-run-id>/state/`). Não foram copiados nem modificados para esta publicação; o trace de catálogo foi lido, os demais foram apenas inventariados.
- O SQLite da campanha live anterior foi removido ao encerrá-la, conforme o relatório P2-LIVE. Portanto não há como reabrir aquela sessão nativa; uma nova prova precisa gerar uma conversa nova, somente após autorização.
- Na execução original de 2026-11-02, nenhum arquivo F1, trace, configuração de produto, banco ou credencial foi editado. Os diretórios temporários criados pelos testes foram preservados, sem cleanup.

## Preparação verificada

### SDK, storage e limites do harness

- `apps/ted-runtime/package.json` declara `@opencode/sdk` e `@opencode/plugin` exatamente na versão `2.2.4`.
- O harness `tests/p2-real-history.test.mjs` usa `approvedTmpRoot()` para criar um diretório único em `%LOCALAPPDATA%/Temp/opencode` e abre esse mesmo storage em processos de seed e recuperação separados. O SQLite real do SDK e o registry são mantidos entre os processos; o helper não apaga o diretório.
- **Limite importante:** esse teste cria o transcript sintético com `oc.experimental.session.import`. Isso é permitido e útil apenas para testar persistência/recuperação sem inferência; não é a transcrição da prova live, nem resposta de LLM. Na campanha futura, o histórico deverá ser produzido naturalmente pelo único turno real.

### Feature flag

- `isTedOpencodeRuntimeEnabled()` exige valor exatamente `"1"` e força `false` quando `NODE_ENV === "production"` (`apps/pwa/src/proxy-utils.ts`). O alias `NEXT_PUBLIC_` não existe.
- A variável estava `unset` no ambiente local inspecionado. A busca nas configurações rastreadas de deploy (`apps/pwa/wrangler.jsonc`, `apps/pwa/wrangler.toml`, `.github`) não encontrou definição.
- A flag de produto não foi alterada. Assim, a evidência é: produto OFF por padrão/produção fail-closed; habilitação futura restrita ao processo local nomeado.

### Catálogo efetivo

- O trace anterior `p2-effective-catalog.json` informa `capturedInsideRealPluginSetup=true`, `exactFinanceCatalog=true` e `unblockedNonFinanceTools=[]`.
- O catálogo nativo observado também listava built-ins como `shell`, `write`, `edit`, `subagent`, ferramentas MCP e operações de sessão/worktree; eles estavam negados pelas políticas efetivas. As únicas ferramentas financeiras runnable eram `list_accounts` e `get_month_summary`.
- O código do produto registra exatamente essas duas ferramentas (`apps/ted-runtime/src/plugin.mjs`); ambas fazem `GET` (`apps/ted-runtime/src/tool-defs.mjs`). Não há ferramenta de escrita financeira ou administração registrada para o modelo nesta fatia.

### Observabilidade preparada

Há artefatos anteriores separados para prompt, catálogo, tools, API financeira, requests e uso do modelo (`p2-session-prompt-trace.json`, `p2-effective-catalog.json`, `p2-tool-calls.json`, `p2-finance-api-trace.json`, `p2-provider-requests.json`, `p2-model-usage.json`). Para a campanha autorizada, registrar separadamente e correlacionar por conversa/turno/mensagem:

1. `session.prompt`: contador e texto aprovado, exatamente uma chamada.
2. Execução das tools: nome, argumentos permitidos, resultado e IDs de correlação.
3. Persistência: caminho do SQLite isolado, IDs/ordem/conteúdo retornados por `message.list` e vínculo no registry.
4. Refresh/reload: requests/respostas do gateway e PWA, incluindo o `503 history.unavailable` e a recuperação com os mesmos IDs.
5. Navegador real: network, console, estado visível e screenshot antes/depois do reload.

Os itens 3–5 ainda não têm traces de uma resposta live persistida/recarregada; o quadro acima é o protocolo de captura para a próxima execução, não uma alegação de observabilidade live já produzida.

## Verificações focadas sem LLM

Executadas sobre o worktree dirty acima; nenhuma instalou dependências ou acessou provider, rede externa, Postgres ou produção.

| Área | Comando / escopo | Resultado |
|---|---|---|
| Runtime / SDK / histórico | `node --test tests/p2-real-history.test.mjs tests/p2-history-refresh.test.mjs tests/prompt.test.mjs` em `apps/ted-runtime` | **34/34 PASS**, 3 suítes. O harness SDK/SQLite recuperou 120 mensagens sintéticas entre processos, com mesmos IDs/conteúdo/ordem, zero `session.prompt` e zero transporte financeiro. `experimental.session.import` foi usado somente no seed sintético. |
| API / gateway | `pnpm --filter meu-ted-api exec vitest run tests/integration/ted-runtime-gateway-auth.test.ts tests/integration/ted-runtime-read-slice.test.ts` | **8/8 PASS**. Identidades e API de teste sintéticas; não demonstra paridade de Better-Auth em produção. |
| PWA | `pnpm vitest run` nos sete arquivos listados abaixo, serial (`--pool=forks --maxWorkers=1`) | **78/78 PASS**. Inclui rota/client e testes de componente; não é navegador real nem E2E da conversa live. |
| Registry e visibilidade | `node --test tests/conversations.test.mjs` em `apps/ted-runtime` | **13/13 PASS**. Coletiva: segundo membro do mesmo workspace pode ler; outro workspace é recusado. Privada: segundo membro do mesmo workspace recebe `not_found`; owner mantém acesso. Identidades sintéticas. |

Arquivos PWA: `src/features/ted/__tests__/TedChat.reload.test.tsx`, `src/features/ted/__tests__/TedOpencodeP2.contract.test.ts`, `src/lib/api/__tests__/agent-client.p2.test.ts`, `src/features/ted/__tests__/TedChat.p2-cancel.test.tsx`, `src/lib/api/ted-runtime-view.test.ts`, `src/app/api/agent/[...path]/route.p2-runtime.test.ts` e `src/app/api/agent/[...path]/route.p2-real-history.test.ts` (relativos a `apps/pwa`).

Cobertura de isolamento combinada: credencial/sessão inválida falha fechado (401), workspace cruzado é recusado (403), conversa desconhecida não é revelada, binding revogado/quarentenado não autoriza leitura, política privada/coletiva é respeitada e refresh não chama `session.prompt`, transporte financeiro ou tool. São testes de contrato com identidades sintéticas; não afirmam equivalência com identidade/auth de produção. Os testes focados de refresh não criam nova intenção financeira.

Não foram executados `pnpm test` agregado, `pnpm lint` agregado nem browser E2E. O teste agregado pode regenerar os JSONs F1; não era necessário para esta preparação.

## Biome — diagnóstico separado

- A evidência anterior registra timeouts sem diagnóstico: Biome da API nos testes focados excedeu 600 s; o lint agregado parou no primeiro estágio `@pi-finance/llm-contracts` após 900 s; a verificação isolada de `src/index.ts` excedeu 30 s. O package de `llm-contracts` declara Biome `2.2.4` e só três arquivos. O relatório P2-HISTORY registra início do Biome, mas não uma causa conclusiva.
- Inspeção atual: nenhum processo `biome.exe` residual visível.
- O lint não foi repetido nesta sessão. Resultado permanece **TIMED_OUT / NOT_VERIFIED**, não PASS nem falha de código; causa raiz indeterminada.

## Classificação dos critérios

| Critério | Classificação | Evidência e limite |
|---|---|---|
| `LIVE_PROMPT_PASS` | **PASS — histórico** | P2-LIVE registra um turno autorizado em 2026-11-01, uma chamada `session.prompt` e resposta exibida. Não houve nova inferência nesta execução. |
| `FINANCIAL_READ_PASS` | **PASS — histórico** | A campanha anterior consultou as duas contas sintéticas e `get_month_summary(yearMonth=2026-06)`, com despesas de 11.750 centavos / R$ 117,50. Nenhuma escrita foi feita. |
| `PERSISTENCE_PASS` | **PARTIAL** | SQLite/registry persistem transcript sintético em teste. Persistência nativa da resposta live do modelo não foi comprovada após restart. |
| `RESTART_RECOVERY_PASS` | **PARTIAL** | Passa para fixture sintética entre processos; a resposta real da campanha anterior não foi recuperada, e seu SQLite foi removido. |
| `PWA_RELOAD_PASS` | **NOT_PROVEN** | Há cobertura PWA focal/rota/client e teste de componente, mas não reload em navegador real da mesma conversa live. |
| `HISTORY_ERROR_RECOVERY_PASS` | **PARTIAL** | Testes comprovam `503 history.unavailable` e recuperação dos mesmos IDs sintéticos; o GET live anterior falhou como `502 prompt.failed`, e não houve reexecução live no navegador. |
| `ISOLATION_PASS` | **PASS — contratos sintéticos** | Testes cobrem ator/workspace, conversa privada/coletiva, sessão/binding inválidos e refresh sem nova execução financeira. Não é prova de paridade de autenticação de produção. |

## Autorização necessária à data de 2026-11-02 (registro histórico)

Na data desta preparação, antes de iniciar a fase live, seria necessário confirmar explicitamente uma campanha nova com:

- provider: `opencode-go`;
- modelo: `deepseek-v4.1-flash`;
- teto monetário máximo para esta campanha.

Essa autorização histórica foi supersedida pelo pedido explícito de 2026-11-03, que especificou OpenRouter / `openai/gpt-6-luna` / teto de US$ 1. A tentativa atual e seu bloqueio estão registrados abaixo.

## Tentativa TED-P2-LIVE-EXECUTION — 2026-11-03 (`BLOCKED_PROVIDER`, sem prompt)

**Autorização:** provider `openrouter`; modelo `openai/gpt-6-luna`; uma mensagem pela PWA; orçamento máximo US$ 1; ambiente local sintético; leitura financeira; sem retry de prompt, fallback, produção, deploy ou publicação. **Resultado:** `BLOCKED_PROVIDER`, antes de iniciar serviços ou consumir a mensagem autorizada.

- **Base e preservação:** HEAD `0a37e9e0f7481e034b123336eff1267dddfde9ab`; worktree dirty preservado (12 modificados + 18 não rastreados), origem `https://github.com/kust-projetos/meu-ted.git`; sem operação Git mutável. Foram atualizados somente os dois relatórios solicitados.
- **Home e isolamento:** `<TED_RUNTIME_HOME>/.ted-home-local`, marker `identity=local`; `db/ted.db` (299008 bytes) e `state/` permaneceram intactos; home global do OpenCode não foi acessada. A configuração original `config/opencode.json` foi preservada, sem overlay temporário.
- **Sem produção:** variáveis/configuração observadas não apontavam para produção; o código do TED restringe API/transporte a loopback. Portas 3001/3101/3000 estavam sem listener. Nenhum serviço foi iniciado.
- **Bloqueio primário:** `OPENROUTER_API_KEY` estava presente somente como placeholder inutilizável; valor não lido nem impresso. Sem credencial utilizável, a execução não podia passar pelos gates sem inferência. A parada ocorreu antes de abrir a PWA ou enviar a mensagem.
- **Sem execução observada:** `POST /rpc/chat=0`; `session.prompt=0`; requests ao provider `=0`; tools `=0`; chamadas financeiras `=0`. Não se afirma custo faturado zero: billing não foi consultado.

| Gate | Resultado nesta tentativa | Evidência/limite |
|---|---|---|
| `LIVE_PROMPT_PASS` | `BLOCKED_PROVIDER` | Nenhum `session.prompt`; credencial inutilizável. |
| `FINANCIAL_READ_PASS` | `NOT_EXECUTED` | Nenhuma tool nem chamada à API financeira. |
| `PWA_RENDER_PASS` | `NOT_EXECUTED` | PWA não iniciada; nenhuma resposta renderizada. |
| `PERSISTENCE_PASS` | `NOT_EXECUTED` | Nenhuma conversa/mensagem nova criada. |
| `RESTART_RECOVERY_PASS` | `NOT_EXECUTED` | Runtime não iniciado/reiniciado; banco existente preservado. |
| `PWA_RELOAD_PASS` | `NOT_EXECUTED` | Nenhuma conversa aberta ou página recarregada. |
| `NO_DUPLICATION_PASS` | `NOT_EXECUTED` | Não houve envio; nenhum POST observado. |
| `COST_RECORDED` | `NOT_VERIFIED` | Sem inferência, uso observado ou consulta de billing. |
| `READ_SLICE_PASS` | `NOT ACHIEVED` | Critérios adicionais de isolamento/erros não revalidados nesta tentativa. |

**Orçamento — estimativa, não custo efetivo nem limite aplicado:** OpenRouter catalog consultado em 2026-11-03 lista preço padrão de US$ 0,10/M tokens de entrada e US$ 0,50/M de saída, com rotas prioritárias até US$ 0,20/M e US$ 1,00/M; preço de contexto longo também varia. Fontes: [OpenRouter model page](https://openrouter.ai/openai/gpt-6-luna), [routing](https://openrouter.ai/docs/guides/routing/provider-selection), [OpenCode providers](https://opencode.ai/v2/docs/providers), [OpenCode agents](https://opencode.ai/v2/docs/agents) e [OpenCode models](https://opencode.ai/v2/docs/models). O cenário proposto — 2 passos, entrada até 32k, saída até 512, até 3 retries de timeout documentados pelo OpenCode por passo e filtro máximo de preço padrão — estimaria **US$ 0,027648** assumindo que cada tentativa fosse faturada no teto. Esses controles **não foram aplicados nem validados no runtime instalado**, e detalhes de retries internos do provider permanecem limitados pela documentação; portanto, esse valor não é teto comprovado de uma execução real. O timeout de provider/OpenCode também pode repetir tentativas; nenhum retry de `session.prompt` foi feito.

**Próxima ação à época:** configurar a credencial OpenRouter e validar limites antes de tentar novamente. Esta recomendação foi supersedida pela retificação abaixo: o operador esclareceu que pretende usar OpenCode Console/Go, não OpenRouter. A mensagem anterior, específica a OpenRouter/GPT-6-Luna, não foi enviada.

## Retificação — providers ausentes na TUI — 2026-11-03

- **Credenciais salvas:** a inspeção de metadados do SQLite isolado encontrou contas ativas `opencode` e `opencode-go`; não há conta `openai`. Nenhum valor de credencial foi lido ou exibido.
- **Causa confirmada:** `tedConfig('live')` continha `provider.use * deny` e somente `provider.use openrouter allow`. OpenCode remove providers negados do catálogo e da seleção de modelos mesmo com credenciais válidas (documentação V2 de Policies). Não era falha de login.
- **Correção autorizada:** o gerador agora appende `provider.use * allow` após `provider.use * deny`; qualquer provider disponibilizado pelo catálogo/integração/configuração do OpenCode pode ser selecionado. O perfil `test` continua deny-all e o modelo padrão não mudou. Chaves ambientais OpenAI/OpenCode/Go continuam scrubbed; as contas conectadas são lidas do SQLite isolado. Nenhuma conta OpenAI foi encontrada.
- **TUI/config isolado:** a `config/opencode.json` do home TED foi regenerada para corresponder ao gerador wildcard e permitir hot-reload. A cópia anterior à política wildcard permanece sob `<TED_RUNTIME_HOME>/.ted-home-local/config/` (nome original omitido). A TUI CLI v2.2.5 usa o SQLite isolado do runtime SDK 2.2.4; a cópia de segurança prévia do banco foi preservada. A renderização atualizada da lista ainda não foi confirmada visualmente.
- **Tools nativas no agente TED — não ampliadas:** os denies de `shell`, `edit`, `write`, `subagent`, leitura/busca, MCP e demais tools permanecem. A revisão de segurança concluiu que removê-los sem sandbox do SO permitiria ao modelo acessar o host, o ambiente e o SQLite de credenciais por caminhos alternativos; uma guarda simples não fornece isolamento. Os comandos da TUI `/connect` e `/models` continuam disponíveis. Liberar tools ao modelo exige primeiro sandbox sem acesso ao home/segredos.
- **Validação sem inferência:** `node --test tests/bootstrap-negative.test.mjs tests/native-model-selection.test.mjs` (**9/9**); `node --test tests/` (**159/159**); `pnpm --filter pi-finance-ted-runtime typecheck` e `lint` **PASS**; Reviewer e Security Reviewer **APPROVED** para a política wildcard de providers. A revisão de tools nativas não aprovou remover os denies sem sandbox. Nenhum `session.prompt`/inferência nem chamada financeira foi executada nesta retificação; requisições de descoberta de catálogo, se ocorreram durante o hot-reload da TUI, não foram medidas.
- **Estado P2:** `READ_SLICE_PASS` permanece **NOT ACHIEVED**; `COST_RECORDED` permanece **NOT_VERIFIED**. Status histórico à época, superseded pela campanha r8v7 abaixo: o operador ainda precisava selecionar e confirmar o identificador exato de modelo e o envelope de custo para qualquer nova inferência via OpenCode Console/Go. A autorização anterior para OpenRouter/GPT-6-Luna não é reutilizada para outro modelo/provider.

## Campanha r8v7 — execução única com prompt admitido — 2026-11-03 (`PROMPT_ERROR_NO_OUTPUT`)

**Autorização:** uma mensagem pela PWA, teto ≤ US$ 1, somente sintético/local, sem retries/fallback/produção/deploy. **Resultado:** prompt admitido uma vez, PWA retornou HTTP 502 `prompt.no_output`; nenhuma resposta financeira foi entregue. Runner one-shot encerrado com saída 1 antes da fase de restart/recovery/reload.

- **Execução e configuração:** run id `r8v7`; harness em `<LOCAL_TEMP>/opencode/ted-p2-live-20261103-campaign-r8v7/`; PWA pronta em 8558 ms, browser iniciado em 8566 ms, término em 80911 ms. SDK/plugin 2.2.4; modelo default `opencode-go/deepseek-v4.1-flash`; políticas com `provider deny-all` seguido de allow exato `opencode-go`; 20 denies de tools; perfil `test` permanece deny-all. Credenciais ativas por ID: `opencode`, `opencode-go` (somente IDs, sem valores). Limites Go imediatamente pré-run: rolling 10%, semanal 16%, mensal 32%, todos `limited:false`; budgets vazios. A variável `OPENCODE_GO` existia em um `.env` local; valor nunca lido/impresso e caminho exato omitido.
- **Pré-voo sem inferência:** `node --check` 9/9 PASS; guard selftest 51/51; smoke estático browser-only de locators PASS (login/shell/pending). Tester independente PASS; Reviewer APPROVED. Guarda de origem exata, um único POST de chat, um único `session.prompt`, tools deny-all, restore de config e hash do `AGENTS.md` da PWA inalterado.
- **Oráculo sintético da API (seed, não resposta):** 2 contas; total de despesas de junho/2026 de 11.750 centavos / R$ 117,50. É verificação de seed, NÃO resposta financeira/lida pelo assistente.
- **O prompt único:** texto exato `TED, quais contas eu tenho?`; `prompt.count=1`; `session.prompt` resolvido em 1330 ms com ID admitido presente; `chatPosts=1`; PWA retornou HTTP 502, código `prompt.no_output`, header `x-ted-runtime=opencode`. Hook de request do runtime disparou e casou provider/modelo, URL/caminho do proxy loopback, presença de nonce e tetos de corpo. **Contador do proxy = 0 e `attempts=[]`** (o contador incrementa imediatamente antes do fetch upstream, após validação). Como o hook disparou e a falha é de transporte, isso NÃO prova ausência de faturamento no provider.
- **Transcrito do erro (inspeção SDK read-only do SQLite temporário, com `models.fetch:false`, somente `session.list`/`message.list`):** os IDs de sessão e mensagem foram omitidos desta cópia pública. A mensagem assistant terminou com `finish=error`, `error.type=provider.transport`, `content=[]`, custo/tokens nulos. Não houve resposta financeira; nomes de contas não foram retornados pelo TED.
- **Limite de persistência/recuperação:** o runner saiu antes da fase interna de restart/recovery/reload porque o status foi 502. Seu cleanup restaurou a config (`configRestore=restored`) e verificou o `AGENTS.md` da PWA inalterado. A leitura SDK pós-run prova que o transcrito de erro existe no SQLite após o cleanup do runtime, mas NÃO prova recuperação plena após restart nem reload da PWA. Nenhum retry ou segundo prompt ocorreu.
- **Custo:** `evidence.json` contém `costBoundUsdEstimate=0.033178`, explicitamente apenas estimativa — não custo efetivo, não orçamento aplicado/forçado pelo provider e não limite garantido de gasto. A autorização de teto ≤ US$ 1 do operador não foi aplicada (enforced) pelo billing Go para este request; o faturamento real permanece NOT_VERIFIED / não verificado. Nenhum uso/custo por request foi retornado (custo/tokens do assistente nulos). Não afirmar gasto US$ 0 com base em proxy count 0.
- **Contexto de tentativas pré-prompt:** r8v3 timeout de auth (0 prompt, 0 proxy); r8v4 timeout de boot da API em 180 s (0/0); r8v5 timeout de imports em 180 s (0/0); r8v6 timeout de marcador de auth da PWA, screenshot em login, 0/0. r8v7 corrigiu o detector de auth e alcançou o prompt único. Nenhuma nova tentativa de campanha autorizada/necessária.

| Gate | Resultado nesta campanha | Evidência/limite |
|---|---|---|
| `LIVE_PROMPT_PASS` | `FAILED` (admitido uma vez, sem saída) | `session.prompt` admitido com ID; PWA 502 `prompt.no_output`. |
| `FINANCIAL_READ_PASS` | `NOT_EXECUTED` / `NOT_PROVEN` | Oráculo de seed verificado (2 contas, R$ 117,50 em 2026-06), mas nenhuma tool/leitura entregue como resposta do assistente. |
| `PWA_RENDER_PASS` | `PARTIAL` | Chat POST único e erro 502 renderizado; sem resposta financeira renderizada. |
| `PERSISTENCE_PASS` | `PARTIAL` | Linha de erro persistida no SQLite (`finish=error`, `content=[]`); sem resposta útil persistida. |
| `RESTART_RECOVERY_PASS` | `NOT_PROVEN` | Runner saiu antes da fase de restart; leitura pós-cleanup não equivale a recuperação plena. |
| `PWA_RELOAD_PASS` | `NOT_PROVEN` | Sem reload/recuperação da conversa após restart. |
| `NO_DUPLICATION_PASS` | `PASS` | Exatamente um POST de chat e um `session.prompt`; zero retries. |
| `COST_RECORDED` | `NOT_VERIFIED` | Somente estimativa `0.033178`; `proxy.count=0` + `httpRequest.fired=true` deixa upstream/faturamento real desconhecido; não implica custo zero. |
| `READ_SLICE_PASS` | `NOT ACHIEVED` | Prompt falhou sem saída; leitura financeira não provada. |

**Sem produção/deploy:** nenhum serviço de produção ou deploy foi usado; nenhuma alteração de código, commit, staging ou push foi feita; este é o único relatório atualizado.

## Retificação — investigação offline r8v7 + integração native-first (2026-11-03)

### 1. Causa do `provider.transport`: limite da evidência

**Veredito: causa física exata NOT_VERIFIED; primeiro intervalo de divergência delimitado.** A campanha r8v7 foi preservada e não repetida. A prova offline posterior alcançou o hook real do SDK, mas a única request gerada foi rejeitada pelo próprio hook antes do listener; não reproduziu o erro live.

| Possível ponto | Evidência observada | Conclusão |
|---|---|---|
| OpenCode não enviou request | `session.prompt` resolveu com ID admitido; o hook `http.request` foi executado e validou model/provider, loopback, path, nonce e corpo. O callback recebe `Request`, valida e retorna `void`; ele não encaminha. | Request HTTP não comprovado só pelo hook. O SDK precisa continuar o fetch depois do callback, mas a chegada não foi capturada. |
| Interceptado sem encaminhamento | `runtime-child.mjs` instala uma guarda em `globalThis.fetch` antes do import do SDK; ela rejeita host não-loopback e delega loopback ao `rawFetch`. | Não há evidência de bloqueio de loopback nem de incompatibilidade com o SDK. A guarda não registra a chamada local. |
| Falha ao conectar ao proxy | `runner.mjs` aguarda `startReverseProxy()`/`server.listen()` antes de iniciar API/runtime/PWA; o proxy só é fechado no teardown. A porta/origem gerada alimenta a config de campanha. | O listener estava iniciado e configurado antes do prompt; a conexão efetiva no instante do request não foi registrada. Nenhum código de socket foi persistido. |
| Chegou ao handler, mas foi rejeitado antes do contador | `proxy.mjs` incrementa somente após validações de método/path/body/model/caps/nonce/Authorization e `inFlight`; a rejeição `no-auth`, por exemplo, ocorre antes de contar. `attempts[]` só registra retorno de fetch upstream. | `proxy.count=0` e `attempts=[]` não provam que o handler não foi alcançado. Não havia contador/log sanitizado de requests rejeitados. |
| Erro efetivo do provider | O SQLite registra somente `finish=error`, `error.type=provider.transport`, conteúdo vazio e custo/tokens nulos; nenhum status/resposta upstream ou causa interna está disponível. | Não há evidência de resposta do provider. Não atribuir defeito ao provider nem declarar billing/custo zero. |

**Primeiro ponto comprovável no r8v7:** depois de o hook validar o request e antes de `countBeforeFetch`/fetch upstream no proxy. O hook não registrou método, porta exata, presença de Authorization, chegada ao listener, motivo/status de rejeição ou código de socket. A prova offline r8v7 abaixo demonstra alguns desses caminhos possíveis, mas não distingue qual ocorreu no r8v7. Não se observou timeout/abort específico que explique a falha.

### 2. Correção e preservação do erro específico

- `apps/ted-runtime/src/prompt.mjs::pollTurnOutput` antes acumulava somente partes `content[].text`. Assim, uma mensagem terminal `finish=error` com `error.type=provider.transport` persistida pelo SDK era ignorada e, após polling, convertida em `prompt.no_output`.
- Foi adicionado teste RED em `apps/ted-runtime/tests/prompt.test.mjs`: com a forma observada do transcript nativo, o resultado anterior falhou como `prompt.no_output` em vez de `provider.transport`.
- A menor correção detecta apenas o tipo terminal comprovado, no turno admitido e antes do próximo user, e lança `PromptError('provider.transport', mensagem fixa)`. A mensagem nativa, body/request e segredos não são repassados; nenhum output é fabricado e nenhum segundo `session.prompt` é chamado. Mensagem sem saída e sem `finish:error` segue como `prompt.no_output`.
- O gateway já transforma `provider.*` em HTTP 502 e preserva o código tipado. A rota PWA B repassa status/body; `agent-client` mantém `code/status`; `TedChat` mantém a bolha em `failed` com a mensagem genérica existente e não adiciona uma resposta financeira. Não foi alterada a PWA.

Esta correção resolve a **perda de especificidade no consumidor**, não a falha de envio/connect anterior ao proxy. Outros tipos de `finish:error` não foram remapeados nesta alteração.

### 3. Provas offline e escopo do resultado

As sondas usaram diretórios temporários novos; o diretório, SQLite, runner e traces originais do r8v7 não foram alterados. Nenhuma sonda alcançou um provider externo.

- A prova offline anterior (identificador de execução omitido) exercitou o listener/proxy com stub: POST válido contou/encaminhou uma vez e devolveu status/body/`x-opencode-session` intactos; sem Authorization houve rejeição local; nenhum SDK/hook foi chamado. Ela continua sendo prova de componente, não da aresta SDK→proxy.
- A prova adicional ficou em diretório temporário local redigido (`<LOCAL_TEMP>/opencode/ted-p2-r8v7-offline-probe-20261103/`; arquivos de observação não incluídos). SDK 2.2.4 real, provider/model de fixture, chave dummy egress restrito a loopback e upstream substituído por stub local. Um único `session.prompt` local resolveu apenas a admissão; o poll limitado encontrou 3 mensagens, sem resposta do assistente.
- O evento do SDK foi `model.request` `kind=compaction`; o callback `http.request` de teste, espelhando as validações de `runtime-child.mjs`, observou provider/model, host/path loopback, nonce e Authorization presentes, mas rejeitou `guard:bad-body` (`bodyWithinCaps=false`). Portanto **essa request do SDK não chegou ao listener**: `forwardAttempted=0`, `stubHit=0`, contador do SDK permaneceu 0, `http.response=0`. Não houve comparação de resposta nesse percurso.
- No mesmo run3, um POST sem Authorization enviado diretamente por HTTP ao listener real foi recebido e respondeu **400 `guard:no-auth`**; o contador permaneceu **0→0**. Isso prova que o listener pode rejeitar antes do contador, não que tenha feito isso no r8v7.
- No run2 da sonda, um `fetchFn` controlado lançou erro com código `ECONNRESET`: `handleProxyRequest` incrementou o contador e converteu o erro em `guard:upstream-fetch`; o código nativo não atravessou essa fronteira. Foi erro injetado, não falha de socket nem observação do SDK.
- Código do hook usa `input.request.clone().arrayBuffer()`, não lê o body original diretamente. O run3 não chegou ao fetch após o hook, então não prova o body original no transporte HTTP subsequente.
- Limites adicionais: callback registrado no probe reproduz as validações do callback de campanha, mas não importa o closure lexical do `runtime-child.mjs`; não houve gateway/PWA/API, turno financeiro, resposta do SDK nem request completa bem-sucedida.
- **Zero tentativa não-loopback observada/permitida, zero fetch ao stub pelo caminho SDK, zero API financeira/escrita.** A evidência não informa faturamento da campanha r8v7.

**Classificação: `OFFLINE_TRANSPORT_PASS = PARTIAL`.** Proxy/listener e rejeição pré-contador são demonstrados em HTTP local; o SDK real invocou um hook equivalente, porém a request foi recusada antes do listener. Não houve round-trip de sucesso SDK→hook→listener→stub→SDK, nem `READ_SLICE_PASS`.

### 4. Auditoria native-first e matriz de componentes

| Arquivo/função | Responsabilidade atual | Recurso OpenCode nativo equivalente | Consumidores | Decisão | Evidência | Impacto |
|---|---|---|---|---|---|---|
| `apps/ted-runtime/src/bootstrap.mjs::tedConfig` | Serializa model/provider policy e isolamento por perfil | `model`, `provider.use`, catálogo e seleção nativos | `writeTedConfig`, SDK/TUI isolada, `startTedRuntime` | **MANTER** (adaptador de config, sem manager) | Cópia sanitizada local: `opencode-go/deepseek-v4.1-flash`, deny `*` + allow exato `opencode-go`, providers custom = 0; testes nativos 2.2.4 | Zero catálogo/alias/seleção próprios |
| `apps/ted-runtime/src/bootstrap.mjs::setupIsolation` + `src/main.mjs` | Isola home/state e escolhe perfis `test`/`live` | Config/home nativos do SDK; credenciais são lidas pelo OpenCode | Runtime TED isolado | **MANTER** | Config r8v7 pós-teardown: sem `model`, deny-all; teste `bootstrap-negative` de scrub/ambiente | Separa teste deny-all de live; nenhum segredo lido/impresso |
| `apps/ted-runtime/src/tests/native-model-selection.test.mjs` | Prova config/default/switch de modelo | `model.default`, `session.switchModel`, `session.get` | Test suite | **MANTER (teste)** | Runtime completo: teste passou; alterna fixture local na mesma sessão, `session.prompt=0` | Não instala manager próprio |
| `apps/ted-runtime/src/prompt.mjs::createPromptHost/pollTurnOutput` | Adapta admissão `session.prompt` à resposta lida em histórico nativo; faz correlação por ID | `session.prompt` + `message.list`/SQLite nativo | Gateway `/rpc/chat`, PWA | **MANTER** | `session.prompt` 2.2.4 retorna admissão, não texto; teste RED→GREEN do erro terminal; suite de prompt 25/25 | Sem transcript/context store paralelo; terminal `provider.transport` preservado |
| `apps/ted-runtime/src/conversations.mjs` | Binding de conversation/workspace/owner/device/visibility/session/intent IDs | Sessão e transcript nativos OpenCode | Gateway/PWA, replay de intenção, acesso coletivo/privado | **MANTER** | Comentário/shape do store: metadata/IDs only, sem texto/token; testes de persistência e visibilidade | Não duplicar sessão, transcript ou memória |
| `apps/ted-runtime/src/session-bindings.mjs` + `bootstrap.mjs::withAuthenticatedSession` | Associar identidade financeira server-side à sessão durante operação, rebind/idle/quarantine | OpenCode fornece ID/estado/active, não autorização financeira/workspace TED | Plugin e gateway após revalidação de identidade | **MANTER** | Suite verifica fila, idle, revoke/quarantine e host-bound tools | Segurança de produto; não substituída pelo SDK |
| `apps/ted-runtime/src/plugin.mjs::productToolDefs`, `tool-defs.mjs`, `transport.mjs` | Duas tools P2 e chamadas GET host-bound à API | `ctx.tool.transform`/schema/execução do plugin nativo | Prompt loop TED | **MANTER** `list_accounts` + `get_month_summary`; `list_categories` continua **ADIADO para P3**, opt-in local e production-off | Runtime completo confirma catálogo default exato de 2; teste P3 comprova que extra não aparece por padrão | Nenhum router/catalog de intenção; API permanece fonte financeira. Não adiciona tool nova |
| `tool-defs.mjs::ToolError` e `transport.mjs::ToolError` | Duas classes idênticas para erro tipado | Sem equivalente necessário no OpenCode | Transporte/executores/tests | **REMOVER duplicação**; transporte importa e reexporta a classe compartilhada | Teste de identidade era RED e ficou GREEN | Removida uma cópia de 10 linhas; sem módulo novo |
| `apps/agent/src/orchestration/intent-router.ts`, `turn-plan.ts` (A0) | Interpretação/planejamento do runtime legado | Entendimento nativo + tools estruturadas no novo runtime | Agent A0 e seus testes/fluxos atuais | **ADIAR ATÉ CUTOVER**; não remover nem copiar | Busca de imports mostra consumidores reais em `apps/agent`; nenhum import em `apps/ted-runtime` | Zero alteração no A0 |
| `apps/pwa/src/app/api/agent/[...path]/route.ts`, `TedChat.tsx` | Proxy same-origin, auth/browser boundary e UI de envio/falha | Não substituído por sessão/modelo nativos | Navegador/PWA | **MANTER** | Testes de proxy envelope e `TedChat` failed/502 | Sem refatoração PWA; erro não vira resposta financeira |

#### Retries, parser, contexto e complexidade

- Não há intent-router/turn-plan, parser conversacional de regex, model manager, skill router ou catálogo manual no `apps/ted-runtime`. O modelo entrega argumentos estruturados; as duas tools passam pela API autoritativa, mantêm identidade host-bound e validam shape financeira.
- O polling de `message.list` não é retry do LLM; é leitura do resultado porque `session.prompt` só admite a mensagem. `conversations.mjs` replaya IDs/histórico, nunca reenvia prompt. `TedChat` oferece retry manual do mesmo `messageId`; não foi adicionado retry automático, failover ou fallback.
- Ferramentas host (`shell`, `edit`, `write`, `subagent`, MCP e leitura) continuam negadas: o OpenCode embarcado compartilha host sem sandbox de SO. A autoridade financeira, idempotência/intention ID e API/Pending V2 permanecem fora do modelo.
- **Delta desta retificação:** produção alterada em 2 arquivos; ~27 linhas adicionadas para detectar e propagar erro terminal e 10 linhas duplicadas de `ToolError` removidas (2 linhas import/re-export); saldo aproximado **+19 linhas de produção**, 0 módulos eliminados, 1 duplicação de classe consolidada. Nenhum provider/model/session manager removido porque não havia manager paralelo comprovado. Nenhuma alteração API/PWA/A0/config persistente.

### 5. Verificações e status real

| Check | Resultado | Escopo/limite |
|---|---|---|
| RED focal anterior | **FAIL esperado** | Esperava `provider.transport`; recebeu `prompt.no_output` após 300 ms antes da correção. |
| Prompt + transporte focal | **34/34 PASS** | `node --test tests/prompt.test.mjs tests/transport.test.mjs`; sem provider/inferência. |
| Runtime completo | **161/161 PASS** | SDK 2.2.4; seleção/histórico/restart sintéticos sem prompt/provider externo. |
| Gateway/API P2 | **10/10 PASS** | Vitest de `ted-runtime-gateway-auth` e `ted-runtime-read-slice`, Fastify/in-memory. |
| PWA focado | **19/19 PASS** | `TedChat.sent-awaiting-history`, `TedChat.quota-error`, `agent-client.proxy-error-envelope`; sem browser E2E. |
| Proxy offline anterior | **PASS component-level** | Stub local, 1 forward contado, resposta intacta, pré-forward `guard:no-auth`; não chama o SDK. |
| SDK 2.2.4 + hook offline (run3) | **PARTIAL / bloqueado pelo hook** | Uma admissão local; `http.request` viu compaction, Authorization presente, mas recusou `guard:bad-body`; 0 chegada do SDK ao listener/forward/stub/resposta. |
| Listener HTTP sem Authorization (run3) | **PASS de rejeição pré-contador** | 1 request recebida; 400 `guard:no-auth`; contador 0→0. Não atribui a rejeição ao r8v7. |
| Erro `ECONNRESET` controlado (run2) | **Perda de código nativo comprovada no proxy** | `fetchFn` injetado lança `ECONNRESET`; proxy retorna `guard:upstream-fetch` após contar. Não é falha de socket observada nem causa do r8v7 (contador live 0). |
| Runtime lint | **PASS** | `pnpm --filter pi-finance-ted-runtime lint` (`node --check`). |
| `pnpm typecheck` | **PASS** | Contracts, API, PWA, Agent, broker e TED runtime; aviso Node DEP0190 não bloqueante. |
| `pnpm docs:lint` | **PASS** | 17 documentos, zero issues; repetido após esta atualização factual. |
| `pnpm governance:check` | **PASS** | Nenhuma mudança D01–D19 detectada. |
| Biome / `pnpm lint` agregado | **NOT_VERIFIED** | Timeout prévio separado; não ocultado nem convertido em PASS. |
| `pnpm test` agregado | **NÃO EXECUTADO** | Preservar `ted-f1-baseline.json` e `ted-f1-journeys.json` modificados previamente. |
| Inferência/provider/billing, PWA browser live, produção, escrita financeira | **NÃO EXECUTADOS** | Campanha original não repetida; custo efetivo permanece NOT_VERIFIED. |

**Estado P2: `PARTIAL`; `READ_SLICE_PASS` não atingido.** A correção em `prompt.mjs` preservada melhora o erro tipado/seguro; não corrige o transporte físico. Nenhuma alteração de transporte foi aplicada: `TRANSPORT_FIX_PASS = NOT_ACHIEVED`.

| Critério desta retificação | Resultado |
|---|---|
| `TRANSPORT_ROOT_CAUSE_CONFIRMED` | **NO** — nenhuma causa reproduzida para o r8v7. |
| `TRANSPORT_FIX_PASS` | **NOT_ACHIEVED** — sem correção de transporte; a correção de `prompt.mjs` é de classificação. |
| `TRANSPORT_STILL_UNKNOWN` | **YES** — r8v7 não distingue request não enviado/falha de conexão local de rejeição pré-contador (Authorization, método, body/path ou `inFlight`). |
| `SIMPLIFICATION_DONE` | **NO CODE REMOVED** — o produto já usa provider/config nativos; o proxy existe só no runner de campanha para limites de egress, nonce, rota e orçamento. Nenhuma camada redundante de produto foi comprovada. |

**Próxima prova live mínima:** somente após nova autorização explícita de provider/modelo/limite, uma única conversa PWA read-only em home local isolada; instrumentar uma cópia temporária do runner para emitir `HOOK_RECEIVED`, `PROXY_RECEIVED`, `PROXY_REJECTED` (status/reason), `FORWARD_ATTEMPTED` e `TRANSPORT_FAILED` (name/code/cause.code), sem body, Authorization ou segredos. O registro deve incluir método, host/porta/path, presença de Authorization, byte length/caps e contador antes/depois. Preservar r8v7; sem retry/fallback. Até esse gate, não executar outro turno live nem afirmar `READ_SLICE_PASS`.

## Adendo de evidências ao PR #290 — 2026-11-04

**Escopo:** somente dados sintéticos, SDK OpenCode 2.2.4 e provider roteirizado
em loopback. Sem inferência externa/paga, produção, deploy, merge ou escrita
financeira. O PR permanece Draft. `READ_SLICE_PASS` continua **NOT ACHIEVED**.

| Etapa | Evidência local | Resultado / limite |
|---|---|---|
| A — auditoria PWA | Run `41824366393`, job `Scoped audit`: `rimraf` moderate, via `[glob]`, effects `[chrome-launcher]`, range `2.3.0 - 3.0.2 || 4.2.0 - 6.1.3`; matcher compara somente campos canônicos exatos. Auditorias posteriores revelaram grafos npm alternativos das famílias dev/build já aceitas; cada formato foi adicionado como entrada temporária isolada. | PWA CI `41909897170`, SHA `11a9169`, **SUCCESS** (`quality` + `e2e`); `Scoped audit` passou com 15 entradas exatas 2026-11-04, todas com expiração `2026-12-31`. Policy local **16/16**, 48 mutações de `severity/via/effects/range` bloqueadas. Nenhum matcher/padrão foi relaxado e nenhum downgrade major foi aplicado. Remediação candidata `chrome-launcher@0.15.2` não aplicada nem compatibilidade provada (detalhes em `docs/security/pwa-audit-risk-acceptance.md`). |
| B — CI TED runtime | Job dedicado usa Node `24.22.2`, pnpm 10, lock congelado e os três comandos fail-closed. Gate agregador/branch protection não foi ampliado. | No CI `41872640850`, `lint` e `typecheck` passaram, mas `test` falhou em Node 24/Linux porque `node --test tests/` tentou resolver `apps/ted-runtime/tests` como módulo (`MODULE_NOT_FOUND`). Corrigido para `node --test`, descoberta nativa sem filtros. CI `41909896849`, SHA `11a9169`, **SUCCESS**, incluindo `TED Runtime` e `Gate — all checks`; sem mudança antecipada na proteção da branch. |
| C — `provider.transport` | Instrumentação correlacionada com UUID opaco, schema de eventos allowlisted, sink em stderr, timeout local explícito, falha do SDK 2.2.4 classificada como opaca quando a causa física não está visível. `session.retry` do plugin TED veta retry antes do agendamento. Provider roteirizado HTTP 500: antes do hook foram observados 5 POSTs dentro de 1 prompt; com o hook, exatamente 1 POST. | Runtime: lint/typecheck PASS; suite **224/224**, 0 skipped; re-review de código APPROVED. `TRANSPORT_ROOT_CAUSE` do r8v7 externo continua **NOT PROVEN**. DNS/TLS/SSE/status real do provider não são observáveis pela evidência disponível do SDK 2.2.4. |
| D — leitura integrada roteirizada | Proxy PWA POST/GET/client → gateway real → SDK 2.2.4 → stub local → `get_month_summary` read-only → Fastify em memória → DTO/output PWA. DTO de junho validado contra oracle sintético; isolamento entre atores/workspaces, erro+replay de mesma intenção, contagem exata de provider, remount e journal financeiro GET-only. | PWA focused Vitest **2/2** (P2D + histórico anterior), typecheck/ESLint PASS. Provider configurado somente no stub loopback com chave dummy; destinos `fetch` não-loopback são bloqueados antes de I/O e o remote do stub é assertado como loopback. **Não** há sandbox de egress em nível de processo: sockets crus `node:http`/`net`/`tls` não são interceptados por este harness. O texto final é derivado do DTO observado, não de modelo. Remount/refresh de rota **não** é navegação real do browser; page reload permanece **NOT PROVEN**. |
| E — integração | Checks locais de policy (16/16), YAML (9 workflows), docs:lint, governance, action-pins, public-safety e boundary passaram. | No SHA `11a9169`, CI `41909896849` **SUCCESS** (incluindo TED Runtime e `Gate — all checks`) e PWA CI `41909897170` **SUCCESS** (`quality (22,10)` + `e2e (22,10)`). O quality passou pelo build Cloudflare, PWA typecheck/lint/tests, Node 24 probe, headers, budget, Lighthouse, policy tests e `Scoped audit`; o E2E comprehensive também passou. Sem merge, deploy ou alteração de branch protection. |
| F — sequência do `Scoped audit` | PWA CI `41900996857` (`0c9cbce`) bloqueou dez novos formatos; `41906016268` (`8a2e6e9`) bloqueou duas variantes finais de `effects`. As duas ondas foram acrescentadas como entradas exatas e temporárias; os registros continuam classificados nos escopos já aceitos (dev-only/build-time), sem alteração do matcher. | Rerun final `41909897170` (`11a9169`) **SUCCESS**; o audit aceitou os 12 formatos adicionais e a quality completa concluiu. Security Reviewer APPROVED o conjunto exato. Os advisories permanecem aceitos, não remediados; expiração 2026-12-31 exige revisão. `READ_SLICE_PASS` continua **NOT ACHIEVED**. |

**Critério mantido:** a prova roteirizada valida integração e falhas locais, mas
não substitui um modelo externo. A execução autorizada anterior r8v7 permanece
preservada; não houve nova chamada de provider, billing não foi consultado e
nenhum custo efetivo é afirmado.

## Execução focada adicional — 2026-11-04

**Base do PR:** `0bf8eaf6252bd5bf8839ed4136d203f22f89a55e`. Execução no worktree
`D:/projetos/pi-ted-opencode-product`, sem alterar o checkout principal. Nenhum
reset, clean, checkout, eval F1 ou regeneração dos relatórios F1 foi executado.

| Verificação | Resultado | Escopo e limite |
|---|---|---|
| P2D roteirizado | `pnpm exec vitest run e2e/support/route.p2d-synthetic-read.test.tsx --pool=forks --maxWorkers=1` — **1/1 PASS**, 50,57 s | SDK OpenCode `2.2.4`, Node `26.11.1` (sem `TED_PROBE_NODE`), provider roteirizado local e API Fastify sintética. Confirma uma leitura `get_month_summary`, resposta pelo fluxo PWA em teste de componente, replay da mesma intenção sem novo prompt/transporte, identidade sintética cruzada negada e journal financeiro somente GET. Não consulta `list_accounts` na mesma mensagem. Vitest/Testing Library não é navegação em browser real. |
| Histórico/runtime | `node --test tests/p2-real-history.test.mjs tests/p2-history-refresh.test.mjs tests/prompt.test.mjs` — **35/35 PASS**, 13,89 s | Recuperação entre processos do SDK de transcript sintético importado, sem prompt; sem transporte financeiro. Não é a conversa P2D bem-sucedida após restart. |
| CI | CI run `41911960282` e PWA CI run `41911960309` — **SUCCESS** | Ambos no mesmo SHA completo `0bf8eaf6252bd5bf8839ed4136d203f22f89a55e`; não foi necessário disparar novo CI, pois não houve mudança de código. |

**Critérios ainda não atingidos:** não houve chamada conjunta a `list_accounts` +
`get_month_summary`; resposta não foi validada em browser real; não houve reload
real da página nem restart do runtime seguido da recuperação dessa mesma conversa
bem-sucedida. O teste de restart disponível usa transcript estático importado.
Nenhum defeito novo foi reproduzido; a falha live anterior `provider.transport` /
`prompt.no_output` continua sem causa física comprovada. **`READ_SLICE_PASS = NOT
ACHIEVED`**. Sem inferência externa/paga, produção, deploy ou escrita financeira.

### Preservação dos relatórios F1

Hashes SHA-256 atuais, iguais antes/depois da execução (igualdade de conteúdo
confirmada também pelos hashes Git registrados antes e depois dos testes):

- Checkout principal, com alterações F1 já existentes: `ted-f1-baseline.json` =
  `03bc5d55a8cd569b3bc8ff4ea0e856e38926d0c8f3c8fc5fd4733d412b684d9a`;
  `ted-f1-journeys.json` =
  `929405e3fc44937cfeb7836c9b4ae92952f36559bf11356945609d413ea88fe9`.
- Worktree do PR: `ted-f1-baseline.json` =
  `e11aad87991f85670b88f14b94c926a10a894b89480077de06a6e503554f1205`;
  `ted-f1-journeys.json` =
  `cb2919dc16ee3ea844e7a6d1f8c80fd182b54f993efd9c9efe1fbb6e281c8367`.

O estado F1 dirty do checkout principal e o item não rastreado preexistente
`--no-save/` no worktree do PR foram preservados. Os hashes Git de cada arquivo
permaneceram idênticos antes/depois; nenhum gerador F1 foi invocado.

**Preparação para um único teste com modelo externo (não executado):** exigir
autorização nova para provider/modelo exatos e teto monetário efetivamente
imposto/verificável pelo provider; credencial somente em home isolada; uma
mensagem, sem retries/fallback; manter API sintética read-only e comprovar que
somente as duas tools existentes são usadas. A falta de prova de browser/reload
e restart integrado permanece bloqueadora para fechar este critério; não se deve
contornar isso com transporte ou orquestração paralelos.

## Evidência sintética E2E em browser real (Playwright) — 2026-11-05

**Classificação: `E2E_SYNTHETIC_PASS`.** Prova obtida em teste real de
navegador Playwright (`@playwright/test`), sem nova execução nesta atualização
de docs: somente registro da evidência já existente. O histórico anterior
permanece intacto; esta seção supersede **exclusivamente** as afirmações
anteriores `NOT_PROVEN` sobre browser/reload/restart para o critério
sintético E2E (reload em browser real e restart com recuperação da mesma
conversa). Nada aqui afirma prova com modelo externo.

- **Spec:** `apps/pwa/e2e/p2d/p2d-synthetic-conversation.spec.ts` — interações
  reais de browser (`page.goto`, login pela UI, chat pela UI via TedChat
  real, `page.reload`), asserts de contagens/rotas, fechamento ordenado do
  subprocesso e início de um processo OS distinto, reabertura do histórico e
  checagem de mesma conversa/sessão/mensagens/conteúdo; o anexo de evidência
  só é gravado após todos os asserts.
- **Recibo:** `apps/pwa/test-results/p2d-synthetic-conversation/evidence.json`
  (mesma conversa, 1 prompt admitido).
- **Run:** `apps/pwa/test-results/.last-run.json` (`status=passed`,
  `failedTests=[]`).
- **Anexo Playwright (ignorado local, não commitado):**
  `apps/pwa/test-results/p2d-p2d-synthetic-conversa-940e9-en-keeps-IDs-with-no-replay-p2d-synthetic/attachments/p2d-evidence-04603784c8fa14e649ff765b1e38af322c8c4a29.json`
  — SHA-256 `66ba487a957184a333e0c0522b95b474ce5c4d64b1d59bc38c6732d5e9e9ff22`;
  mtime `2026-11-05T00:23:05.568Z`.
- **Métricas observadas (mesma conversa):** prompts agregados `1`;
  `list_accounts=1`; `get_month_summary=1`; escritas financeiras `0`;
  conteúdo estável após `page.reload` e após restart (`true`/`true`); zero
  novos prompts/transportes após reload e após restart; fechamento ordenado
  (`closeForced=false`); PIDs pré/pós distintos (valores omitidos); provider
  `local-scripted-only`.
- **Escopo da execução:** provider local roteirizado em loopback; nenhuma
  inferência externa/paga foi executada ou inferida. O cenário fez somente
  leituras contra a API sintética: zero escrita financeira; sem deploy ou
  cleanup.
- **Limite explícito: `READ_SLICE_PASS = NOT ACHIEVED`** até prova autorizada
  com modelo real. O anexo local ignorado não é commitado; revisores do PR
  podem verificar as afirmações acima contra o recibo, o `.last-run.json`, o
  anexo pelo SHA e o spec.
