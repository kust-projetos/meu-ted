# Meu Ted — F2-B0: DeepSeek V4.1 Flash (não Free)

**Data:** 2026-10-27
**Estado mais recente:** `BLOCKED_BEFORE_INFERENCE_LOCAL_READINESS_503`
**Escopo:** B0, 23 casos sintéticos, branch `test/ted-f2b0-no-retry-controlled`, base `1971fb911fdefbc26c978b4a02e5f5ea36406004`.

## Execução autorizada mais recente — 2026-10-27

### Tentativa após correção da reserva

- **Run:** `2026-10-27T17-01-23-827Z-17092`; associado à tentativa anterior `2026-10-27T15-19-19-424Z-5620` de `F1-B005`.
- **Comando:** `pnpm --filter pi-finance-agent exec tsx tests/poc-structured/f2b0-runtime/real-runner.ts --execute-real --smoke-only --confirm-model=opencode-go/deepseek-v4.1-flash --confirm-go-quota-available --confirm-go-extra-usage-disabled --retry-authorized-case=F1-B005 --retry-authorized-run=2026-10-27T15-19-19-424Z-5620`.
- **Resultado:** BLOCKED antes da inferência: readiness do servidor OpenCode **local** falhou com HTTP 503 (`local-http`). Não é um status observado do provider Go. O processo terminou com exit 1; não foi repetido.
- **Evidência:** manifesto criado; hooks com 0 bytes; sem `catalog-preflight.json`, resultado de caso ou reserva autorizada nova. Reserva histórica preservada, lock liberado. Zero prompts e zero requisições físicas de inferência nesta tentativa; sem resposta do modelo, parser, oráculo, tokens ou faturamento observados.
- **Próximo passo:** diagnosticar o readiness local 503 sem executar nova inferência; a autenticação Go e o caminho `/models` continuam não comprovados pelo GET anterior (404).

**ID:** `2026-10-27T16-31-59-128Z-1936`
**Resultado:** **BLOCKED — provider/autenticação; nenhuma inferência iniciada.**

**Código:** HEAD `51085d8609c5ab47360cefb7aff4b106214f8862`; estado sujo, com alterações preexistentes em `apps/agent/tests/poc-structured/f2b0-runtime/real-runner.ts` e `real-runner.stdin.test.mjs`. As alterações foram preservadas.

**Execução anterior associada:** `2026-10-27T15-19-19-424Z-5620` (F1-B005, HTTP 401; evidência anterior preservada).

**Tentativa autorizada após a confirmação do operador:** o runner recebeu o comando real com `--execute-real --smoke-only` e as três confirmações requeridas, mas parou antes de iniciar servidor/sessão. O novo `manifest.json` recebeu o ID acima; a checagem do plano encontrou `F1-B005.reserved`, pertencente à execução 401 anterior (`2026-10-27T15-19-19-424Z-5620`), e recusou replay. O arquivo de hooks ficou vazio (0 bytes), não há `catalog-preflight.json`, `smoke-evaluation.json` nem resultado de caso neste novo run. Nenhuma reserva antiga foi desbloqueada e nenhuma nova reserva foi criada.

- **Gate de credencial:** nova verificação usando `node:util.parseEnv`, o mesmo parser do runner, confirmou `OPENCODE_GO` presente no `.env` do repositório; valores não foram impressos. O carregador do runner disponibilizou a credencial ao ambiente filho por `OPENCODE_GO_API_KEY` durante o preflight.
- **Modelo/endpoint e configuração esperados:** código local fixa `opencode-go/deepseek-v4.1-flash` e `https://opencode.ai/inference/go/openai/v1/chat/completions`; a configuração isolada usa `{env:OPENCODE_GO_API_KEY}`. O preflight nativo exercitou essa configuração, sem criar sessão ou enviar prompt.
- **Preflight nativo:** `pnpm --filter pi-finance-agent exec tsx tests/poc-structured/f2b0-runtime/real-runner.ts --preflight-only --confirm-go-quota-available --confirm-go-extra-usage-disabled` confirmou no catálogo local o provider/modelo Go e preço permitido; `inferenceRequests=0`. `usage.limits` retornou indisponível e o runner registrou a attestation do operador; quota não foi comprovada independentemente.
- **Autenticação HTTP:** como não havia evidência disponível de `GET /models` 200 para Go, foi feita uma única checagem GET-only em `https://opencode.ai/inference/go/openai/v1/models`; resultado **HTTP 404**. Nenhum corpo de prompt foi enviado, nenhum retry ocorreu e o corpo da resposta não foi persistido. O 404 não comprova autenticação válida nem inválida; o gate exigido de HTTP 200 não foi atendido. Não foram tentadas outras rotas.
- **Cobrança:** não houve inferência; tokens, `usage.cost`, billing source, list cost, allowance e consumo de saldo Console não se aplicam/não foram observados. Não se declara custo zero de inferência.
- **Comando real:** invocado: `pnpm --filter pi-finance-agent exec tsx tests/poc-structured/f2b0-runtime/real-runner.ts --execute-real --smoke-only --confirm-model=opencode-go/deepseek-v4.1-flash --confirm-go-quota-available --confirm-go-extra-usage-disabled`. O runner bloqueou antes de qualquer sessão por reserva pendente de F1-B005. Nenhuma inferência alternativa foi feita.
- **Contagem desta missão:** 1 requisição GET de checagem, 0 requisições físicas de inferência; 0 prompts; 0 retries; 0 fallbacks; 0 reservas novas ou resultados de caso. A reserva antiga permanece intacta. Os casos restantes continuam não autorizados.
- **Interpretação F2-A.1 / oráculo F1:** não avaliados; não houve resposta do modelo.
- **Validação local anterior à decisão:** harness mock `node apps/agent/tests/poc-structured/f2b0-runtime/run.mjs` PASS (9 cenários; run `2026-10-27T16-20-23-036Z-7948`); testes focados `pnpm --filter pi-finance-agent exec vitest run tests/poc-structured/f2b0-runtime --reporter=dot` PASS (38/38); typecheck `pnpm --filter pi-finance-agent typecheck` PASS. Reviewer independente não encontrou blocker de segurança no diff, sem atestar credencial ou quota.
- **Impedimento concreto/próximo passo:** a reserva pendente para F1-B005 exige resolução explícita, não automática, conforme o controle existente. A tentativa não pode ser repetida nem retomada com o ID antigo como se o caso tivesse sido concluído. Preservar o checkpoint e decidir separadamente como autorizar uma nova reserva/execução; não avançar os outros 22 casos.

## Veredito

O operador selecionou OpenCode Go e confirmou que há quota incluída disponível e **Extra Usage** desativado. O painel não pôde ser aberto: o login Google reportou que o navegador não era seguro. A leitura local `client.usage.limits` também retornou `data: null`, então o estado de quota não foi confirmado independentemente; a execução registra a attestation explícita do operador e não aceita custo diferente de US$ 0.

O runner foi configurado para usar o provider/modelo Go pelo OpenCode nativo, sem copiar ou exibir credenciais; configuração/DB/cache/estado permanecem por execução. No único smoke, porém, o request Go saiu **sem header Authorization** e recebeu HTTP **401**. Isso demonstra que o processo experimental ainda não conseguiu usar a credencial armazenada. O retry proposto foi vetado e não houve segunda requisição física. Nenhuma credencial, provider ou configuração global foi alterada.

**Resultado B0 nesta execução:** 1/23 casos tentados (`F1-B005`), 1 requisição física Go, resposta HTTP 401, 0 respostas do modelo, 0 tokens/custo observados; 22 casos não executados. B1 não iniciado. O stop category persistido pelo runner foi `stdin-prompt-not-confirmed`; a evidência de transporte mais específica é o HTTP 401, e o readback de mensagem user não foi confirmado.

## Provider, modelo e endpoint

### Evidência local do OpenCode

- `opencode --version`: `v2.2.0`.
- `opencode auth list` no CLI 2.2.0 direto: mostra entradas armazenadas para **OpenCode Go** e **OpenCode Console**, entre outros providers. O operador escolheu Go. O comando lista credenciais armazenadas; não informa plano, quota, saldo, uso do período ou seleção ativa.
- `opencode models`: catálogo efetivo inclui `opencode-go/deepseek-v4.1-flash` e `opencode/deepseek-v4.1-flash`, além de `opencode/deepseek-v4.1-flash-free`. A disponibilidade no catálogo não prova quota utilizável.
- Nenhum valor de credencial ou conteúdo do auth store foi lido ou persistido. No request real, o hook registrou somente `authorizationPresent=false`; nenhum valor de header foi persistido.

### Rotas oficiais consultadas

- **Go** — modelo OpenCode `opencode-go/deepseek-v4.1-flash`; endpoint OpenAI-compatible documentado atualmente: `https://opencode.ai/inference/go/openai/v1/chat/completions`.
- **Console** — modelo `opencode/deepseek-v4.1-flash`; endpoint: `https://opencode.ai/inference/openai/v1/chat/completions`.
- A URL Zen informada como rota a conferir (`https://opencode.ai/zen/go/v1/chat/completions`) não é a rota Go publicada na documentação atual consultada. Nenhuma URL alternativa foi configurada.
- A documentação atual da API direta DeepSeek usa `deepseek-flash` para V4.1 Flash. O benchmark não foi redirecionado para a API direta da DeepSeek: isso misturaria credenciais, endpoints e quotas, contrariando o escopo.

Fontes oficiais: [OpenCode Go](https://opencode.ai/v2/docs/console/go/), [OpenCode Console Models](https://opencode.ai/v2/docs/console/models/), [OpenCode CLI](https://opencode.ai/docs/cli/), [DeepSeek First API Call](https://api-docs.deepseek.com/quick_start/pricing).

## Elegibilidade e custo

- A documentação Go descreve o serviço como destinado ao OpenCode e a outros coding agents com tráfego semelhante, recomenda tráfego típico de coding agent e informa monitoramento contra abuso. Os prompts deste B0 são sintéticos e enviados pelo CLI oficial; não houve falsificação de identidade. A documentação consultada não trata uma campanha externa de benchmark separadamente.
- Para DeepSeek V4.1 Flash no Go, a página consultada informa limites de uso por modelo e preços de referência de **US$ 0,15 input / US$ 0,60 output por milhão de tokens fora do pico** e **US$ 0,30 / US$ 1,20 no pico**; o limite mensal publicado é US$ 80 no Go e US$ 160 no Go Plus. Esses valores são documentação do plano, não evidência do saldo/quota desta conta.
- A mesma página documenta que, se houver saldo Console e **Extra Usage** estiver habilitado, o Go pode continuar em pay-as-you-go depois do limite incluído. O operador confirmou no chat que Extra Usage está desligado; o painel não pôde ser acessado, e a API local de usage retornou `null`. Nenhuma compra, recarga ou mudança de billing foi feita.
- Console é pay-as-you-go; o preço publicado para este modelo é **US$ 0,30 input / US$ 1,20 output por milhão de tokens**, com cached read publicado a US$ 0,006. Console não foi selecionado. Não há estimativa monetária honesta para 23 casos sem selecionar essa rota e sem contagens de tokens de entrada/saída por caso; nenhum teto anterior de US$ 5 foi tratado como autorização.
- A documentação Go lista DeepSeek com retenção zero, sob acordo ZDR renovado mensalmente; a validade publicada consultada vai até 2026-10-31. Isso não substitui a verificação independente de quota, que não ficou disponível neste ambiente.

## Controles locais verificados

### Matriz mock

`node apps/agent/tests/poc-structured/f2b0-runtime/run.mjs` terminou com sucesso em 2026-10-27, run `2026-10-27T15-01-06-299Z-19020`, CLI local 2.2.0. Os nove cenários mock foram: 429, 500, 503, timeout, reset, refused, proxy-refused, stream parcial e resposta válida.

- Para cenários com transporte, o mock recebeu no máximo uma requisição física; casos de conexão recusada receberam zero.
- Nos erros, o hook de retry foi observado e vetou a tentativa proposta antes de um segundo request físico.
- O caso válido devolveu `OK`; payloads tinham zero ferramentas; o plugin bloqueou geração auxiliar; a probe confirmou a rota/modelo Go sem transporte externo.
- Este resultado valida a matriz local Go, não autenticação ou cobrança do provider real.
- Evidência: `apps/agent/tests/poc-structured/f2b0-runtime/evidence/2026-10-27T15-01-06-299Z-19020-summary.json`.

### Entrada por stdin e evidência do plugin

- `F2B0_REAL_EVIDENCE` é criado em `minimalEnvironment()` e o mesmo objeto `env` é passado ao servidor local e ao processo CLI filho. O teste local confirmou que o processo filho recebe o caminho esperado, sem criar arquivo ou usar credencial.
- Prompt de teste com aspas, acentos, emoji e quebra de linha foi enviado por stdin e retornou byte/string-idêntico, sem o prompt em argv.
- Um filho fechando stdin para prompt de um byte foi reproduzido com `stdinErrorCode=null`; portanto `EPIPE` sozinho não era prova suficiente. A guarda final exige readback de exatamente uma mensagem `user` na sessão local, com o texto reconstruído idêntico ao prompt. Ausência/divergência falha fechado como `stdin-prompt-not-confirmed`; a evidência persistida é apenas o booleano `stdinPromptObserved`.
- Não houve reenvio automático após EOF, erro ou ausência de confirmação.
- No smoke real `F1-B005`, o hook observou uma requisição primary Go e resposta HTTP 401; `authorizationPresent=false`, `toolCount=0`, retry proposto vetado, 0 tokens/custo observados. O readback da mensagem user não foi confirmado, então parser/oráculo não foram executados.

## Casos, parser e comparação

| Medida | Resultado do modelo não Free |
|---|---:|
| Cenários tentados | 1/23 (`F1-B005`) |
| Respostas do modelo / JSON parser F2-A.1 | 0 / não avaliado |
| Julgamentos do oráculo independente | 0 |
| Precisão de intenção/operação/argumentos | Não avaliada |
| Acertos de contexto/esclarecimento | Não avaliados |
| Tokens/custo/consumo | Não observados; HTTP 401 |
| Casos restantes | 22 não executados |

Comparação semântica com F1: **não aplicável**, pois não houve resposta do modelo novo. O relatório histórico [`TED-F2B0-DEEPSEEK-FLASH-FREE.md`](TED-F2B0-DEEPSEEK-FLASH-FREE.md) permanece inalterado: ele registra a execução anterior com o modelo Free, inclusive o 429 e a parada; não foi reclassificado nem usado como prova de comportamento do modelo pago. As evidências e achados de segurança do contêiner também ficam separados desta avaliação de elegibilidade/modelo.

## Validação de código

- `node apps/agent/tests/poc-structured/f2b0-runtime/run.mjs`: PASS, nove cenários mock locais.
- `pnpm --filter pi-finance-agent exec vitest run tests/poc-structured/f2b0-runtime --reporter=dot`: PASS, 35 testes após os gates smoke/quota.
- `pnpm --filter pi-finance-agent typecheck`: PASS após os gates smoke/quota.
- `pnpm docs:lint`: PASS após adicionar este relatório, 17 documentos, 0 problemas.
- `pnpm governance:check`: PASS e `git diff --check`: PASS no estado final verificado.
- Suíte completa Agent: 3504 PASS / 1 skip em uma execução anterior aos últimos gates smoke/quota; não repetida após eles. Os dois artefatos de baseline F1 regenerados incidentalmente por essa suíte foram restaurados ao conteúdo original.
- Lint amplo (`pnpm --filter pi-finance-agent lint`) expirou após 240 s. Biome focado nos dois arquivos expirou também após 240 s; lint permanece **inconclusivo**, não PASS.
- Revisão independente focal do smoke/resume: **APPROVED** após a parada em ausência de readback pós-caso. Security review: **APPROVED**; riscos residuais são a attestation do operador porque `usage.limits` retorna null e o diretório nativo de auth compartilhado com o binário Go oficial.

## Bloqueio e próximo passo

O primeiro smoke foi tentado conforme a escolha do operador por Go e parou após uma requisição HTTP 401. A evidência é suficiente para o bloqueio externo: no request autorizado para `opencode-go/deepseek-v4.1-flash`, o hook observou `authorizationPresent=false`; o provider respondeu 401; a tentativa de retry foi vetada; não houve segunda requisição nem saída do modelo. A chave não foi copiada, exibida ou alterada para investigar.

**Não repetir o smoke nem tentar o Console.** Os 22 casos restantes permanecem não executados. Para retomar será necessário corrigir a resolução nativa da auth Go na instância experimental sem copiar a chave ou alterar auth/config global, e obter readback de quota válido após o smoke; o runner bloqueia `--resume` sem `SMOKE_PASS` e readback atual. O usuário relatou quota incluída disponível e Extra Usage desligado, mas a API local de quota retornou `null` e o login web não foi possível; por isso a attestation não basta para continuar o lote inteiro.

Recomendação para B1: **NO-GO**. O relatório histórico Free permanece intacto; os achados de segurança do contêiner seguem separados da falha de autenticação Go.
