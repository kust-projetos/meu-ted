# @pi-finance/ted-runtime — runtime dedicado OpenCode (fatia P1, núcleo parcial)

Fatia P1 da migração OpenCode-first (ADR-031, `docs/plans/2026-10-31-ted-opencode-first/`).

## O que esta fatia entrega — e o que NÃO entrega

**Entrega (verificado por execução):** runtime local executável
(`node apps/ted-runtime/src/main.mjs` — SDK 2.2.4 REAL, gateway loopback,
identidade/transport/runtime-ops reais; rotas respondem tipado sem API, boot
+ close limpos) + núcleo parcial: doubles + stub HTTP em processo
(ver `node --test` abaixo), defs/executores das 2 reads P2 por padrão e
`list_categories` GET-only sob opt-in local P3, com validação de
shape 2xx (SPEC §5), bindings host-bound, plugin nativo de finanças como
único caminho de tools do produto (sem superfície façade em produção; o
helper com filtro owner-only vive só em `tests/helpers/facade.mjs` para
testes legados de contrato), transporte fetch
com allowlist + `x-device-token`/`x-workspace-id` do host +
`redirect: manual` + origin-loopback, registro nativo via `wirePlugin`,
bootstrap com close-garantido + hardening (traversal/marker/symlink),
plugin com catálogo exato + seam `onEffectiveTools`, adapter de prompt no
contrato nativo exato 2.2.4 (history `type/text+content/time.created`,
output correlacionado ao admitted user id, retry via intentions persistidas
sem segundo prompt, cancelamento via AbortController→`session.interrupt`),
gateway com rebind autenticado privado (`oc.session.get` + bind) em todo B,
cookie B mesmo em erro tipado, `session/new` validando o pin anterior,
timeout→504 com socket utilizável, denies `tool.use` pinados para todo o
catálogo nativo observado (lista obtida uma vez via admissão instrumentada
fora desta prova; a prova automatizada NÃO repete isso). Prova com SDK
2.2.4 REAL é código + execução (`tests/real-sdk.test.mjs` + sonda em
subprocessos): boot→restart com isolamento A/B, message-list shape,
agent `ted` — GREEN nesta worktree; catálogo efetivo ao vivo é BLOCKED
por desenho (setup do plugin 2.2.4 só roda no prompt — 20s idle pós-wire
+ `session.create` observados sem setup — e dispará-lo exigiria
`session.prompt`, uma tentativa de inferência não autorizada; zero prompts
emitidos, nada fabricado). Cobertura do gating segue em teste de unidade
(seam `onEffectiveTools`) + denies pinados.
Sem inferência no boot em nenhuma fase (perfil `test` sem modelo e isolado,
`provider.use` deny-all, zero chamadas `session.prompt` fora do prompt loop
por request do usuário; fallback de provider e chamadas pagas seguem
desabilitados por política). O perfil `live` (opt-in explícito) seleciona o
modelo via `model` nativo do OpenCode a partir do template
`src/live-model.json` (default atual `opencode-go/deepseek-v4.1-flash`); um
override legítimo só-`model` num `opencode.json` isolado é preservado
(nunca reescrito).

**NÃO entrega (declarado honestamente):** prompt-loop com modelo real (sem
inferência autorizada em P1/P2), catálogo efetivo ao vivo do prompt-loop ou o
gate `READ_SLICE_PASS` PWA→modelo→tools→API→UI. Os testes
`apps/api/tests/integration/ted-runtime-read-slice.test.ts` (8/8) e
`ted-runtime-gateway-auth.test.ts` (2/2) exercitam handlers reais em Fastify
loopback com Better-Auth/token/ledger sintéticos e o transporte/tool executor;
não chamam `session.prompt`, não renderizam uma resposta de modelo na PWA e não
acessam produção/Postgres. Também não há qualquer caminho de escrita; a proposta
P3 permanece bloqueada pela emissão A4 de token delegado, sem relaxar o contrato
da API. Nada aqui equivale a funcionamento em produção.

## Aproveitamento do spike (revisão, nunca cópia cega)

Origem somente-leitura: `D:/projetos/pi-ted-runtime-spike/experiments/ted-runtime/`.

| Artefato do spike | Destino no produto |
|---|---|
| `bootstrap/ted-finance-tools.mjs` (defs + executores, intenção, guards) | ADAPTADO → `src/tool-defs.mjs`, 2 reads P2 por padrão + `list_categories` P3 opcional |
| `bootstrap/session-bindings.mjs` (Map host-bound) | ADAPTADO → `src/session-bindings.mjs`, comportamento preservado |
| `bootstrap/ted-gateway.mjs` (façade do spike) | NÃO adaptado como superfície de produto — sem `src/facade.mjs`; helper com filtro owner-only mantido só em `tests/helpers/facade.mjs` para testes legados de contrato (fail-closed, sem `listCatalogs`) |
| `bootstrap/ted-config.cjs` + `env.cjs` (isolamento) | ADAPTADO → `src/bootstrap.mjs`, SEM `process.chdir`, COM guarda um-host-por-processo |
| `bootstrap/plugins/ted-finance/index.mjs` (registro nativo) | ADAPTADO → `src/plugin.mjs`, registra 2 reads P2 por padrão; 3 tools somente com opt-in local P3 |
| `bootstrap/finance-transport.mjs` (filho tsx p/ test-app) | NÃO importado — substituído por `src/transport.mjs` (fetch contra baseUrl do chamador) |
| `finance-bridge*.ts`, `finance-transport-pg.mjs`, seeds, traces, runners, `propose_expense` (+ confirmation runners) | Bridges/harnesses sintéticos/PG e runners NÃO importados; proposta/confirm/execute ainda não existem no produto. `list_categories` ADAPTADO → `src/tool-defs.mjs` como leitura GET-only opcional P3 (opt-in local, nunca escrita) |

## Contrato de autenticação do transporte (verificado, não inventado)

- `apps/api/src/routes/accounts.ts:42-46` e `dashboard.ts:17-21`: identidade via
  `req.authenticatedContext` OU header `x-device-token`
  (`apps/api/src/auth/device-token.ts:50`). Device tokens são segredos duráveis
  vinculados ao dispositivo, resolvidos server-side para `{deviceId, householdId}`.
- O preHandler de bearer delegado (`routes/index.ts:452-555`, `iss "pi-agent"`,
  `financial.read` para GET) é RECONHECIDO mas NÃO usado: tokens delegados expiram
  em 300s (`auth/delegated-token.ts:25-32`), logo bearer não é identidade durável —
  e a emissão é proibida fora do MutationExecutor (Agent) pelo gate A4. Este runtime
  nunca minta, guarda ou envia credenciais delegadas. Um `Authorization: Bearer`
  genérico com o segredo device também estaria errado (o preHandler ignora bearers
  não-`pi-agent`). Por isso: SOMENTE `x-device-token`, nunca `Authorization`.
- Seleção de workspace é explícita E server-side: o header `x-workspace-id`
  leva SOMENTE o household do host congelado (nunca args do LLM — chaves de
  identidade lá são rejeitadas). Sem o header, o fallback da rota poderia
  resolver o household de origem do token em vez do workspace selecionado
  (`device-access.ts:26-31`: mismatch = 403).
- Redirects nunca são seguidos (`redirect: "manual"`): 3xx vira erro tipado, sem
  reenviar o segredo. Sem acesso a produção: `baseUrl` é do chamador (stub/local
  na P1); nada aponta para origem produtiva.

## Sessão compartilhada: rebinding serializado com prova de idle + quarentena

- Todo uso nativo de um `runtimeSessionId` (chat/tool loop, history, replay/raw-history)
  roda SOMENTE dentro de `serverOps.withAuthenticatedSession(sessionID, host, fn)`
  (fatia atual): fila por sessão nativa + `oc.session.get` + rotação controlada do host
  + execução do callback + `poll oc.session.active({signal})` com o mapa exato 2.2.4
  (`isSessionActiveMap`: registro direto `{}` = idle, `{id:{type:'running'}}` = busy;
  arrays/`{data:...}`/Set/valores não-`running` nunca são prova de idle) até o id
  sumir (cada sonda limitada pelo prazo restante via AbortSignal + Promise race —
  uma `active()` travada nunca prende a fila) + revoke na saída. Nunca
  revoke/replace enquanto um prompt/tool anterior ainda pode executar; o segundo
  membro de uma conversa `workspace` aguarda a fila + quiescence antes de ver seu
  próprio host no callback da tool (o primeiro ainda vê o seu).
- Boot recusa sem sonda válida: `createTedEnvironment` exige `oc.session.active`
  chamável e uma sonda de boot com `{signal}` retornando o mapa exato; ausente/
  inválida = SDK fechado + boot rejeitado (sem bind de host, sem tool). Sonda de
  operação que trava/rejeita/retorna forma inválida = cannot-prove-idle: revoke +
  quarentena da sessão + falha tipada na fila (nunca rebind após incerteza).
- Se o idle não é provado no limite (timeout curto injetável nos testes), o binding é
  revogado E a sessão é quarentenada no processo (`host_binding_quarantined`): todo
  prompt/read/rebind posterior falha fechado; uma tool tardia fica sem host e falha
  fechado; nenhum outro ator rebinds sobre a sessão ainda ativa. Nova conversa = nova
  sessão nativa. Ordem de locks sempre conversa-externa → sessão-interna (history
  também usa `withTurnLock`, sem deadlock); `oc` bruto e binding nunca cruzam HTTP.
- `session-bindings.mjs` segue process-local (nada durável entre restarts, sem prova de
  reautenticação/visibilidade coletiva ADR-027 além dos checks por request); após restart
  toda sessão exige re-bind via wrapper + reautenticação server-side. Token delegado
  (300s) nunca é identidade durável.
- `src/main.mjs` injeta `tedEnv.serverOps.withAuthenticatedSession` no gateway
  (único caminho de produção; o legado `bindAuthenticatedSession` foi removido
  do entrypoint): o gateway recusa construção legada sem o wrapper em request
  B nativo (502 fail-closed, zero chamadas nativas). `tests/main.test.mjs`
  prova a fiação por execução sobre loopback com operações SDK falsas
  (sem provider, sem inferência, sem API): captura as opções reais passadas a
  `createGatewayServer` e delega `sessionID`/`host`/`opts` ao
  `tedEnv.serverOps.withAuthenticatedSession`; bootstrap sem pin devolve o
  cookie B sem uso nativo e sem wrapper; history com pin e `POST /rpc/chat`
  com stub invocam o wrapper exatamente uma vez cada. API-auth ao vivo,
  catálogo efetivo ao vivo e READ_SLICE contra a API real seguem NOT_PROVEN
  (sem inferência paga, sem Docker, sem credenciais nesta fatia).

## Limitação documentada (binding volátil — parcialmente endereçada nesta fatia)

O `session-bindings.mjs` é um Map process-local que compara o token: prova nada
de durável entre restarts, não prova reautenticação nem visibilidade coletiva
ADR-027. Após restart, toda sessão exige re-bind explícito + reautenticação
server-side antes de qualquer metadado (get/remove falham fechado sem binding
vivo — provado em teste com simulação pós-restart). Token delegado (300s) nunca
serve de identidade durável; renovação de binding é sempre server-side autenticada.
Paridade: linhas de ownership durável/reauth/ADR-027 seguem NOT_PROVEN.

## Estrutura

- `src/tool-defs.mjs` — 2 P2 tools (schemas in+out) + `list_categories` opcional P3
  (defs/args/rota GET `/categories` exata/shape `{items, total}`/executor GET-only;
  exposição só via opt-in local em `plugin.mjs`), `deriveIntentionId`, guards, executores GET-only.
- `src/session-bindings.mjs` — registro host process-local (só memória; token nunca em disco/log/erro)
  + rotação controlada `rotateSessionBinding` (só sob a fila do wrapper, após idle) +
  quarentena `quarantineSession`/`isQuarantined` (fail-closed `host_binding_quarantined`).
- `src/transport.mjs` — `HttpFinanceTransport` (GETs allowlist, device token por chamada, timeout/abort, `redirect: manual`, erros sem segredo).
- `src/live-model.json` — default nativo do seletor `model` do perfil `live`
  (`opencode-go/deepseek-v4.1-flash`; dado versionado, nunca literal JS;
  perfil `test` nunca lê este arquivo e segue sem modelo/isolado).
- `tests/helpers/facade.mjs` — helper SOMENTE-teste (6 chaves + filtro
  owner-only fail-closed, sem `listCatalogs`); sem superfície façade em
  produção — o caminho de tools do produto é o plugin nativo.
- `src/bootstrap.mjs` — isolamento + config deny-by-default (agente `ted` nega
  `*` primeiro e permite SÓ `ted.finance.read` com recursos exatos das reads do
  produto; denies `tool.use` pinados para todo nativo observado como backstop
  host/admin) + `wirePlugin` + `createTedEnvironment`
  (import dinâmico de `@opencode/sdk`; declarado em `dependencies` como `2.2.4`
  exato) com `serverOps` só-servidor (`bindAuthenticatedSession` get+bind legado,
  `withAuthenticatedSession` serializado com idle+quarentena — caminho exigido pelo
  gateway, `createNativeSession`, `createPromptHost`) — oc bruto nunca exposto.
  Quiescence estrita: `isSessionActiveMap` (mapa direto 2.2.4, contrato pinado em
  `client.d.ts:7-12,232+` + `types.d.ts:98-100,4122-4126`) + gate de boot fail-closed
  + toda sonda `session.active` com AbortSignal e limite pelo prazo restante.
- `src/plugin.mjs` — registro nativo 2.2.4 exatamente das 2 reads P2 por padrão
  (opt-in local `TED_OPENCODE_P3_READS_ENABLED=1` com `NODE_ENV !== 'production'`
  expõe `list_categories`; produção força off) + gate nativo de permissão em
  todo execute (`ctx.permission.assert` com `ted.finance.read`/`[toolName]` e o
  contexto real da invocação ANTES de host/executor/HTTP; sem a API/contexto
  falha fechado — mecanismo nativo, não um novo sistema de auth) +
  `getEffectiveToolNames`
  (catálogo efetivo SÓ via `ctx.tool.list()` dentro do plugin; a superfície HTTP não tem tool group;
  o seam `onEffectiveTools` captura o catálogo FINAL pós-transform — built-ins + 2 reads).
- `src/gateway.mjs` — identidade server-side: mint `POST /auth/agent-token`
  (cookie + `x-workspace-id` + `x-device-token`) + `GET /auth/devices/me`;
  workspace canônico da autoridade, acordo device×workspace, erros sem segredo.
- `src/conversations.mjs` — metadados (opaque `conversationId`, workspace canônico,
  owner, device, visibilidade, `runtimeSessionId`) + registry de intentions
  (`claim/get/settleIntention` — só id/status/autor, nunca texto/output/token) para
  replay cross-restart sem segundo prompt, mais índice first-writer-wins
  `(workspace, owner, intentionId) -> conversationId` (só ids) para retry com
  cookie perdido resolver a mesma conversa sem segunda sessão/prompt;
  cada intention guarda `userMessageId` (id nativo admitido) + `actorId` do
  autor verificado — o history B projeta de volta o `intentionId` PWA
  (âncora otimista do PWA) e o autor correto por mensagem (visibilidade
  coletiva não reescreve o segundo membro como owner); `isOwn` é relativo
  ao viewer (`identity.actorId` revalidado, nunca claim do cliente) para o
  rótulo "Você" do PWA, com fallback legado sem viewer;
  `workspace` padrão / `private` opt-in; cookie `ted-runtime-conversation` (`agent` = A0, `opencode.<uuid>` = B),
  Path por workspace, HttpOnly, SameSite=Lax, Max-Age 30d, `Secure` só em HTTPS;
  `withTurnLock` serializa turnos da mesma conversa (tail explícita, sem leak —
  libera em sucesso E falha; `lockCount()` é seam só-teste); o índice retry valida
  que `record.workspace`/`record.ownerActor` batem com a chave
  `[workspace, ownerActor, intentionId]` no load E no `recordIntentionOwner`
  (divergência = store_corrupt/invalid_args, fail-closed, sem roteamento errado).
- `src/prompt.mjs` — adapter 2.2.4: `session.prompt({sessionID,id?,text})` admite
  (inbox `SessionInboxUser`, não output); o `id` nativo é enviado SÓ quando a
  intention PWA já satisfaz o shape `msg_*` (a admissão real rejeita outros —
  sem ele, correlação via recibo admitido); output = texto assistant do turno
  admitido (janela recente `order desc`, ≤3 páginas/round — nunca o transcript
  inteiro; para na próxima mensagem `user`, a fronteira do turno, então replay
  de intenção antiga nunca inclui turnos posteriores); a projeção do history
  recebe `userMeta` (`userMessageId` nativo → `{intentionId PWA, actorId}`)
  para âncoras do PWA e autoria por-membro; `message.list` paginado
  por cursor até 10 páginas/500 linhas (`prompt.history_overflow` fail-closed,
  nunca truncamento silencioso) COM detecção de cursor repetido, página sem progresso
  e IDs duplicados entre páginas (loop/duplicação falham fechado, sem histórico
  parcial); resposta antiga nunca retornada; `event.subscribe` (AsyncIterable) nunca
  aguardado como unsubscribe; duplicata de `intentionId` falha fechada;
  abort → `session.interrupt` (exatamente uma vez por abort) e retorno com
  `userMessageId` (admitted id) para o gateway persistir; provider ausente/negado = erro tipado, sem inferência alternativa.
- `src/server.mjs` — listener SÓ loopback com as 3 rotas PWA
  (`/rpc/chat`, `/rpc/history`, `/rpc/session/new`); corpo 64KB; AbortController
  por request (disconnect + timeout; timeout→504 com socket utilizável, sem
  escrita stale); identidade→metadados→`withAuthenticatedSession`→turno
  (wrapper serializado com prova de idle/quarentena antes de qualquer uso nativo,
  inclusive history — history também sob `withTurnLock`, mesma ordem de locks);
  history B sem pin faz bootstrap (primeiro load do PWA monta antes de
  qualquer chat): cria 1 conversa workspace-visible + sessão nativa, SEM bind
  (sem uso nativo ainda — o wrapper binda por uso e revoga na saída),
  devolve `{items:[]}` + cookie B, sem prompt; A0 segue
  fail-closed (proxy roteia A0, nunca este listener);
  replay via intentions persistidas (completed→200 sem novo prompt;
  admitted-sem-resposta→409 `prompt.in_progress`; demais replays→409
  `prompt.duplicate`); `session/new` valida o pin anterior (estranho = null);
  cookie B setado mesmo em erro tipado do chat; A0 falha fechada sem fallback;
  B inválido limpa só o escopo.
- `src/main.mjs` — entrypoint executável e import-safe:
  `node apps/ted-runtime/src/main.mjs` (sem efeitos no import — o boot roda
  só quando o módulo É o script CLI; `startTedRuntime({env, deps})`
  exportado para testes com seams, sem SDK/rede). Env
  `TED_RUNTIME_HOME` (default `~/.ted-runtime`),
  `TED_RUNTIME_IDENTITY` (default `local`), `TED_API_BASE_URL` (loopback,
  default `http://127.0.0.1:3001` — ted-local api), `TED_GATEWAY_PORT`
  (default 3101; host SEMPRE `127.0.0.1`, nunca via env),
  `TED_REQUEST_TIMEOUT_MS` (default 30000); origem não-loopback é recusada
  antes de qualquer boot do SDK. Sem prompt no boot, sem provider, sem
  chamadas à API até o primeiro request; SIGINT/SIGTERM fecham gateway + SDK
  (close idempotente; falha pós-boot em store/gateway/listen fecha gateway
  (se construído) + env exatamente uma vez antes de rejeitar — nunca vaza).
  Cobertura: `tests/main.test.mjs` (import sem traps,
  start/close com seams, recusa de origem remota, cleanup em falha de listen e de store,
  fiação do `withAuthenticatedSession` — delegação + loopback com gateway real).
- `tests/` — suítes `node:test` sem dependências (rodam sem install).

## Como rodar

```powershell
node --test apps/ted-runtime/tests/
node apps/ted-runtime/src/main.mjs   # gateway em 127.0.0.1:3101 (env acima); import não sobe nada
```

Entrada local documentada e executável: `src/main.mjs` bota o SDK 2.2.4 real,
o metadata store sob o state dir isolado do SDK, valida a origem da API como
loopback e sobe o gateway SÓ em loopback com identidade/transporte/runtime-ops
reais (provado: boot real + rotas tipadas + close limpo, sem API até o request).

Roteamento com o proxy same-origin (gateway serve SÓ B; proxy fora deste
pacote): A0 por padrão com flag OFF; pin `agent` preservado com flag ON;
pin `opencode.*` roteado para B mesmo com flag OFF posterior;
`/rpc/session/new` explícito vai para B com flag ON (A0 com flag OFF).
Pin `agent` ou B inválido/estrangeiro no gateway falha fechado, sem
fallback para A0; limpeza de cookie usa o mesmo Path do escopo.

## Cobertura em CI (job dedicado `ted-runtime`)

O workflow `CI` (`.github/workflows/ci.yml`) possui um job dedicado
`ted-runtime` (Ubuntu, Node exatamente `24.22.2`, pnpm 10, install
congelado) que executa, sem `continue-on-error`/skip/fallback:

```yaml
pnpm --filter pi-finance-ted-runtime --fail-if-no-match lint
pnpm --filter pi-finance-ted-runtime --fail-if-no-match typecheck
pnpm --filter pi-finance-ted-runtime --fail-if-no-match test
```

O comando `test` do pacote (`node --test tests/`) descobre e executa os testes
do diretório `tests/` — sem filtro por nome. Na base deste adendo (`929bfe2`),
isso corresponde a **196 testes em 37 suítes**, incluindo a prova de permissão
do prompt-loop nativo (`tests/prompt-loop-permission.test.mjs`, com provider
roteirizado em loopback, sem inferência paga). Os testes novos do adendo entram
no mesmo comando automaticamente.

A configuração do plugin TED registra o hook nativo `session.retry` do SDK
2.2.4 e veta retries propostos para `agent: ted`; se o hook não estiver
disponível, o setup falha fechado antes de registrar ferramentas. Isso impede
tentativas físicas adicionais em falhas retryable do provider para o runtime
TED (teste roteirizado: HTTP 500, exatamente um POST por `session.prompt`). A
política não altera sessões de outros agentes e não prova a causa física de um
`provider.transport` real.

Status de gate: este job é um candidato a futuro check obrigatório
SOMENTE após revisão humana explícita. Nesta etapa o job agregador
`Gate — all checks` permanece inalterado e nenhuma branch protection foi
alterada.

Instalação e validação (2026-10-31, somente o observado): instalações seletivas
congeladas do runtime, PWA, `llm-contracts`, API, Agent e broker concluíram; SDK/plugin/client
estão fixados em 2.2.4. `node --test apps/ted-runtime/tests/`: 134/134 PASS,
incluindo boot→restart, isolamento, entrypoint real em porta efêmera, mapa
`session.active` e atividade sem `session.prompt`. A descoberta do catálogo
efetivo é BLOCKED por desenho (setup do plugin só roda no prompt). Os dois
testes de integração sintética Fastify são 8/8; PWA focado 69/69 e suíte
completa 2.892 PASS / 9 skipped. `pnpm typecheck` agregado passou nos seis
workspaces; o Node emitiu aviso DEP0190 do gate `spawnSync(shell:true)`, sem
falha. `pnpm test` agregado passou em todos os workspaces (API padrão exclui
integrações; 8 testes sintéticos foram executados separadamente). `pnpm lint`
agregado passou sem erros; Biome registrou warnings em API (148) e Agent (231),
ESLint PWA 0 erros/26 warnings; runtime `node --check` passou. Nenhuma
inferência, produção, Postgres ou escrita financeira foi usada.
