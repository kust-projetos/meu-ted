# MEU TED — P2 Live Closure Results

**Data:** 2026-11-01  
**Veredito:** **PARTIAL**  
**Worktree:** `D:/projetos/pi-ted-opencode-product`  
**Branch:** `feat/ted-opencode-product`  
**HEAD observado:** `0a37e9e0f7481e034b123336eff1267dddfde9ab`

> **Autorização do operador:** somente `opencode-go/deepseek-v4.1-flash`, teto **US$ 5**. Uma única mensagem foi enviada pela PWA, sem retry semântico ou fallback.

## Resumo

A fatia determinística P1/P2 passou nos testes direcionados com identidades e fixtures sintéticas. Após autorização para OpenCode Go, o turno real passou por `PWA → gateway → session.prompt` com o agente `ted`, chamou as duas ferramentas somente-leitura, consultou a API Fastify em memória e renderizou a resposta correta na PWA. O catálogo runnable foi capturado dentro do setup real do plugin: as únicas ferramentas financeiras eram `list_accounts` e `get_month_summary`; todos os demais nomes observados tinham deny de ferramenta, sem ferramentas financeiras de confirmação/escrita.

O veredito permanece **PARTIAL**, não `READ_SLICE_PASS`: logo após renderizar a resposta correta, a PWA fez um GET de histórico que retornou `502 prompt.failed` e mostrou “Não foi possível carregar o histórico”. Além disso, as consultas auxiliares A0 de aprovações/desfazer retornaram 404 porque o teste isolado não tinha um Agent A0 ativo. Não houve `provider.no-route`; portanto não é `BLOCKED_PROVIDER`. Não foi feito novo envio para tentar sanar o erro.

## Estado preservado e escopo

- A inspeção inicial encontrou 11 arquivos rastreados modificados, incluindo `apps/agent/evals/reports/ted-f1-baseline.json` e `ted-f1-journeys.json`, além de testes/runtime/planos P1/P2 não rastreados. O checkout estava dirty; os resultados abaixo pertencem ao conteúdo local observado, não ao HEAD isolado.
- Os dois relatórios F1 já estavam modificados antes desta validação. Seus metadados lidos antes dos testes indicavam `local-synthetic`, `llmCalls: 0`, `externalNetwork: false`, `realFinancialData: false` e `realWriter: false`.
- `pnpm test` agregado **não foi executado**: os testes F1 regeneram esses JSONs rastreados. Nenhum código de aplicação ou relatório preexistente foi alterado. O Next dev regenerou `apps/pwa/AGENTS.md`; após parar o servidor, restaurei o conteúdo anterior e confirmei o arquivo limpo.
- Produção, deploy, merge, PR, commit, banco/Postgres, dados financeiros reais e ferramentas de escrita não foram tocados.
- A campanha autorizada usou somente um Better-Auth em memória, um workspace sintético, duas contas sintéticas e duas despesas de junho. O PostgreSQL persistente do `ted-local` não foi acessado. A exceção `provider.use` e o modelo foram aplicados só ao `opencode.json` do home temporário; o arquivo foi restaurado ao deny-all antes do encerramento.
- Os arquivos SQLite temporários que continham a credencial e a sessão de teste foram removidos após parar os processos. Os JSONs de evidência e a captura PWA sanitizada permaneceram fora do worktree, em diretório temporário local cujo identificador foi omitido; os scripts temporários adicionados em `apps/api/tests/` e `apps/ted-runtime/tests/` foram removidos.

## Evidência executada

| Área | Comando/observação | Resultado e limite |
|---|---|---|
| Runtime TED / SDK real | `pnpm --filter pi-finance-ted-runtime test` | **134/134 PASS**, 18 suítes, zero skips. Inclui boot/restart/entrypoint com SDK 2.2.4, isolamento A/B, erros tipados, ausência de auth, superfície read-only e testes sem provider. O caso de catálogo aceita `catalog-blocked`; não prova o catálogo runnable. Nenhum `session.prompt` foi chamado. |
| PWA P2 | 5 arquivos P2, Vitest | **69/69 PASS** somando as execuções. A primeira execução paralela teve 46 testes aprovados e dois workers que não iniciaram por timeout; repetidos isoladamente com `--pool=forks --maxWorkers=1`, os dois arquivos passaram **23/23**. `stderr` incluiu `agent-proxy.opencode_runtime_unavailable` esperado nos casos fail-closed. |
| API + gateway sintéticos | `pnpm --filter meu-ted-api exec vitest run tests/integration/ted-runtime-gateway-auth.test.ts tests/integration/ted-runtime-read-slice.test.ts --reporter=dot` | **8/8 PASS**. Better-Auth em memória, loopback e fixtures sintéticas. A/B, autenticação/dispositivo, erros tipados e leituras GET somente foram exercitados. |
| P2 live, uma mensagem | PWA local `127.0.0.1:32743` → gateway `127.0.0.1:32742` → SDK 2.2.4 → API sintética `127.0.0.1:32741` | `POST /rpc/chat` **200**, `x-ted-runtime=opencode`; `session.prompt` **1×** com o texto aprovado, `agent=ted`, modelo exato. Tools `list_accounts` e `get_month_summary(yearMonth=2026-06)` ambas **succeeded**. API retornou duas contas e despesas de **11.750 centavos / R$117,50 / 2 transações**; a resposta exibida na PWA correspondeu aos dados. Depois, o GET de histórico da PWA retornou **502 `prompt.failed`**; A0 auxiliar pending/undo deu 404 no harness. Por isso o resultado global é PARTIAL. |
| Skip gate | `pnpm test:skip-gate` | **PASS**: 126 arquivos financeiros críticos examinados, 8 skips incondicionais antigos allowlisted com motivo, zero skips incondicionais novos. O gate não examina todos os skips condicionais nem substitui a execução das suítes P1/P2 direcionadas acima. |
| Typecheck | `pnpm --filter pwa typecheck`; `pnpm --filter meu-ted-api typecheck` | Ambos **PASS**. |
| Runtime syntax/lint | `pnpm --filter pi-finance-ted-runtime lint` | **PASS** (`node --check` nos 11 módulos do runtime). |
| Lint PWA focal | ESLint nos arquivos PWA modificados/adicionados | **0 erros, 1 warning** em `TedChat.tsx:1626` (`<img>`). A linha é anterior e não aparece no diff P2; classificado como warning preexistente, não regressão desta fatia. |
| Biome API focal | `pnpm --filter meu-ted-api exec biome check` nos dois testes de integração novos | **Não verificado**: o comando excedeu 600 s sem diagnóstico. Não converter timeout em aprovação ou finding de código. |

### Os 182 skips da suíte agregada

`docs/plans/2026-10-31-ted-opencode-first/IMPLEMENTACAO-PARCIAL.md` registra a execução agregada anterior: API **172 skipped** porque o script padrão exclui `tests/integration/**`, Agent **1**, PWA **9** — total 182. Esse relatório também registra execução separada dos oito testes TED de integração da API e dos cinco arquivos P2 da PWA. Nesta closure, os oito testes de API e os cinco arquivos P2 foram novamente executados diretamente e passaram. A suíte agregada não foi repetida para não regenerar os relatórios F1; portanto os totais agregados são evidência histórica registrada, não uma nova contagem desta sessão.

O skip gate cobre skips/todos incondicionais em caminhos críticos da API e `llm-contracts`; por si só, não demonstra que todos os 182 skips seriam irrelevantes. A cobertura dos caminhos P1/P2 essenciais foi verificada pela execução direta acima.

## Catálogo, identidade e isolamento

- `ctx.tool.list()` foi capturado dentro do setup do plugin real. O catálogo observado continha `list_accounts` e `get_month_summary`, além de built-ins nativos. **Todas** as ferramentas não financeiras observadas (`shell`, `edit`, `write`, `subagent`, MCP, web, etc.) tinham deny efetivo; `unblockedNonFinanceTools=[]`. A lista de ferramentas financeiras runnable foi exatamente as duas leituras; não há ferramenta de confirmação financeira no plugin.
- A PWA fez login com identidade e workspace sintéticos (ID omitido nesta cópia pública), obteve device token pelo fluxo session-bound e usou o `x-workspace-id` vindo do host autenticado. No transporte financeiro, o trace registrou `x-device-token` presente e `Authorization` ausente. Os argumentos do modelo não carregaram identidade/workspace.
- `list_accounts` retornou `Conta sintética principal` e `Reserva sintética`. `get_month_summary` recebeu `yearMonth=2026-06` e a API retornou `incomeCents=0`, `expenseCents=11750`, `balanceCents=-11750`, `transactionCount=2`. A resposta renderizada exibiu as mesmas contas, período e gasto de R$ 117,50.
- Tool/API traces mostram somente as duas ferramentas e dois GETs financeiros; nenhum método financeiro de escrita, cartão de aprovação ou proposta de desfazer foi invocado/renderizado. Os testes determinísticos continuam sendo a evidência A/B e de preservação do A0; a flag B foi ligada apenas no servidor local temporário.
- A revisão independente anterior não confirmou vulnerabilidade explorável. A nova captura do catálogo foi feita pelo harness temporário; não é uma revisão de segurança independente adicional.

## Warnings, falhas de harness e regressões

- Os timeouts dos dois workers Vitest ocorreram durante a execução paralela; os mesmos arquivos passaram na repetição serial. O primeiro runner live também falhou antes do envio por usar `Response.clone()` numa resposta Playwright; os traces confirmaram que naquela tentativa não houve prompt. O runner foi corrigido e o turno aprovado foi enviado uma única vez.
- O warning ESLint focal de `<img>` está numa linha inalterada de `TedChat.tsx`. O relatório de implementação anterior registrava, na lint agregada, 26 warnings PWA, 148 API e 231 Agent, sem erros; esses totais não foram reexecutados nesta validação.
- O timeout do Biome API permanece não verificado; não há evidência para classificá-lo como regressão nova.
- O `next dev` emitiu avisos de Edge Runtime experimental/deprecated e o harness reportou 404 para as leituras auxiliares A0 `pending-operations/active` e `undo/active`, pois o upstream A0 temporário apontava ao gateway B, que não implementa essas rotas. Isso não foi uma mutação nem um fallback B→A0.
- **Limite live remanescente:** após o `POST /rpc/chat` 200 e a resposta financeira correta, a PWA fez um `GET /rpc/history` que retornou **502 `prompt.failed`**; a tela exibiu “Não foi possível carregar o histórico” e o estado “indisponível”. A causa desse refresh não foi isolada e não houve retry do prompt. Por isso a closure global fica **PARTIAL**, embora o caminho de leitura e a resposta tenham sido comprovados.
- Os traces sanitizados não contêm marcador de credencial (`credentialMarkerPresent=false`). O valor da chave não foi exibido nem copiado para logs/relatórios; ficou apenas na base SQLite do perfil temporário de OpenCode Go, que foi removida após o encerramento dos processos.

## Controle de inferência e orçamento

- Autorização recebida para `opencode-go/deepseek-v4.1-flash`, teto **US$ 5**. A credencial `OPENCODE_GO` do `.env` do projeto foi conectada somente no perfil temporário isolado; o valor nunca foi impresso.
- A mensagem aprovada foi enviada uma vez pela PWA. Trace direto: `session.prompt` **1×**, agente `ted`, provider/model exatos. O provider recebeu **2 requests** de chat completion, ambos após o gate do catálogo; não houve fallback, retry semântico nem `provider.no-route`.
- Uso no metadata OpenCode: dois assistant messages, total **8.208 input tokens**, **215 output tokens** e **91 reasoning tokens**. `costUsd` reportado pelo SDK foi `0` em ambos; o allowance/faturamento da Console não foi consultado. Limites configurados: context 32.768, output 1.024, máximo 3 requests. O bound conservador a preço Peak publicado para DeepSeek V4.1 Flash (US$ 0,30/1M input e US$ 1,20/1M output) é **US$ 0,0331776**; a estimativa pelos tokens observados, contando reasoning como output, é cerca de **US$ 0,00283**. Ambos ficam abaixo do teto de US$ 5; são estimativas, não extrato de faturamento. [Fonte oficial](https://opencode.ai/v2/docs/console/go).
- O trace de requests confirma apenas `/inference/go/openai/v1/chat/completions`. Nenhuma chave, token, cookie ou authorization header foi incluído nos traces.

### Configuração efêmera da campanha

- O bootstrap padrão segue deny-all e sem modelo. Só o `opencode.json` do perfil temporário recebeu `model=opencode-go/deepseek-v4.1-flash` e `provider.use opencode-go allow`; os 20 denies `tool.use` permaneceram. O launcher efêmero compartilhou o DB isolado da credencial com a sessão; nenhum banco/config global foi reutilizado. Ao encerrar, o `opencode.json` foi restaurado ao deny-all e os arquivos `opencode.db`, `-wal` e `-shm` do perfil temporário foram removidos.
- O API de campanha foi `buildTestApp` com Better-Auth/device/workspace stores em memória, duas contas e duas despesas sintéticas. A PWA local e o gateway usaram ports loopback dedicados. A stack Docker `ted-local` persistente e o Postgres em 5433 não foram acessados; seus dados não foram presumidos sintéticos.
- A flag `TED_OPENCODE_RUNTIME_ENABLED=1` existiu somente no processo PWA local de teste. A implementação permanece OFF por padrão e a cobertura determinística A0 permaneceu intacta.
- Não ocorreu `provider.no-route`; a resposta do modelo e as duas ferramentas foram obtidas. O estado `PARTIAL` deve-se ao refresh B de histórico 502 e às rotas auxiliares A0 ausentes no harness, não a indisponibilidade do provider.

### Traces sanitizados

Os arquivos de evidência temporária permanecem fora do repositório, em diretório local redigido (`<LOCAL_TEMP>/opencode/ted-p2-live-<redacted-run-id>/`). As capturas e os traces originais não foram incluídos nesta publicação. O relatório registra somente a classificação e os resultados necessários à auditoria; os valores financeiros descritos são sintéticos.

## Pendências para encerramento

1. Investigar o **GET `/rpc/history` 502 `prompt.failed`** após o turno e corrigir/provar o refresh de histórico sem reenviar a mensagem. A causa permanece indeterminada nesta closure.
2. Repetir a validação dos endpoints auxiliares A0 com um A0 local/sintético apropriado, não com o gateway B. A0 foi preservado pelos testes determinísticos; os 404 observados são do harness.
3. Não fazer outra chamada de modelo sem nova autorização explícita: o único turno aprovado já foi consumido. Nenhum retry semântico/fallback foi feito.

Até resolver o refresh de histórico e fechar a lacuna A0, o estado permanece **PARTIAL**. A feature flag de produto continua OFF por padrão; apenas o processo PWA local de teste a recebeu como ON. Nenhuma produção, configuração global ou código de produto foi alterado. Os dois scripts de harness temporários em `apps/api/tests/` e `apps/ted-runtime/tests/` foram removidos; os relatórios F1 e demais alterações preexistentes foram preservados.
