# Meu Ted — F2-B0: DeepSeek V4.1 Flash Free

## Resultado atual — 2026-10-27

**B0 interrompido com segurança após uma chamada real; qualidade do modelo não avaliada.** O gate local está pronto para execução controlada: OpenCode `2.1.4`, plugin nativo de guarda, veto de retry e limite de uma requisição HTTP por sessão. Isso prova o controle do cliente observado, não a política interna do provider.

Foi enviado somente **F1-B010** ao endpoint nativo `https://opencode.ai/inference/openai/v1/chat/completions`, provider `opencode`, modelo `deepseek-v4.1-flash-free`. O provider respondeu HTTP 429, `provider.free-limit`; duração observada: **702 ms**. O plugin vetou retry, e nenhuma resposta foi gerada. A execução parou sem reenviar o caso ou iniciar os seguintes.

| Contagem do lote (23 casos) | Resultado |
| --- | ---: |
| Requisições físicas reais | **1** |
| Respostas geradas | **0** |
| Falha do provider | **1** — F1-B010, 429 `provider.free-limit` |
| Inconclusivo de infraestrutura | **1** — F1-B005, zero tentativas |
| Não executados | **21** |
| Tokens, uso e cobrança efetiva | **Desconhecidos/não observados** |

O catálogo reportou preços de entrada, saída e cache iguais a zero para a rota Free. Isso **não** comprova valor faturado: não houve leitura de usage/billing e não havia autorização para gasto pago. Portanto, não se afirma “custo faturado zero”. Nenhum fallback, endpoint pago, retry voluntário ou nova chamada foi autorizado.

### Estado dos 23 casos

| Caso | Resultado | Caso | Resultado |
| --- | --- | --- | --- |
| F1-B005 | Inconclusivo: falha de infraestrutura antes de tentativa | F1-B010 | Provider 429; sem resposta |
| F1-B012 | Não executado | F1-B017 | Não executado |
| F1-B036 | Não executado | F1-B058 | Não executado |
| F2A1-B013-catalog | Não executado | F2A1-B015-colloquial | Não executado |
| F2A1-B027-approx | Não executado | F2A1-B006-reference | Não executado |
| F2A1-B016-homonyms | Não executado | F2A1-B021-correction | Não executado |
| F2A1-B008-concept | Não executado | J01:T1 | Não executado |
| J01:T2 | Não executado | J02:T1 | Não executado |
| J02:T2 | Não executado | J03:T1 | Não executado |
| J03:T2 | Não executado | J05:T1 | Não executado |
| J05:T2 | Não executado | J09:T1 | Não executado |
| J09:T2 | Não executado |  |  |

F1-B005 não foi reenviado: a reserva durável e o artefato de parada impedem replay automático. Seu erro foi `F2B0_REAL_EVIDENCE` ausente no ambiente filho (`appendFile` recebeu `undefined`), sem tentativa de provider. É **inconclusivo**, não falha semântica. A interrupção em F1-B010 encerra o lote; os demais 21 são **não executados**, não falhas.

### Evidência do gate e limites

- Artefato sanitizado de parada: [`published-b0-stop.json`](../../apps/agent/tests/poc-structured/f2b0-runtime/evidence/real/published-b0-stop.json), schema `f2b0-safe-stop-v1`, execução `2026-10-27T01-04-23-758Z-13588`. Sem headers de autenticação, IDs de sessão ou stdout bruto.
- Prova do harness com interceptação local: [`2026-10-26T23-56-15-510Z-7596-summary.json`](../../apps/agent/tests/poc-structured/f2b0-runtime/evidence/2026-10-26T23-56-15-510Z-7596-summary.json). Nove cenários simulados (429, 500, 503, timeout, reset de socket, conexão recusada, proxy recusado, stream parcial e resposta válida). Nos erros com request recebido, houve uma requisição física observada e o retry foi vetado; conexões recusadas/proxy recusado não chegaram ao servidor mock. **É mock local, não tráfego/provider real.**
- Self-test nativo publicado registra plugin pronto, custo de catálogo zero e zero MCPs, skills, plugins extras, prompts ou requests de inferência. Na execução real, o request capturado pelo hook local continha zero tools; a configuração negava permissões, bloqueava geração auxiliar (generate/title/compaction) e não oferecia ferramentas financeiras.
- O prompt enviado foi intenção sintética mínima com contrato fechado. Não se usaram dados de workspace nem executor financeiro.
- O hook local comprova uma requisição emitida pelo cliente e ausência de retry observado; **não** torna observável eventual execução interna do provider, nem autoriza afirmar quantas operações internas ocorreram.
- Não houve texto de resposta. JSON/schema válidos, taxa de qualidade, precisão, comparação com F1, avaliação por oráculo e sucesso financeiro são **N/A / não avaliados** — não são 0% nem sucesso.

### Validação e estado de publicação

Validação final independente:

| Comando | Resultado |
| --- | --- |
| `pnpm --filter pi-finance-agent exec vitest run tests/poc-structured --reporter=dot` | PASS: 72 testes, 5 arquivos, incluindo os testes `.mjs` do runtime |
| `pnpm typecheck` | PASS |
| `pnpm docs:lint` | PASS |
| `pnpm governance:check` | PASS |
| `pnpm build` | PASS, com warnings Next.js/Edge |
| `pnpm lint` | FAIL: dois erros em arquivos preexistentes do Agent; lint focado dos dois TS novos PASS |
| `pnpm test` | FAIL: timeout em `beforeEach` de `admin-agent-llm-config.test.ts`; 343 arquivos passaram, 12 ignorados |
| `git diff --check` | PASS |

`node --test real-guard.test.mjs` também foi tentado: falhou na resolução do import TypeScript. Esse arquivo usa Vitest e foi executado com sucesso pelo comando Vitest acima. Não se declara aprovação integral dos gates. Revisões independentes de código e segurança: **APPROVED** para publicação delimitada, não para nova inferência. Não reproduzir nem retomar a chamada real para “validar”.

O controle central usa `ctx.session.hook("retry", event => { event.decision = { retry: false }; })`, conforme [Plugins V2](https://opencode.ai/v2/docs/build/plugins/). O plugin experimental em `f2b0-runtime/real-plugin/index.js` acrescenta cap de um HTTP por sessão, endpoint/modelo exatos e bloqueio de fluxos auxiliares. A matriz reproduzível está em `f2b0-runtime/run.mjs`; o runner real está em `real-runner.ts`. O uso exige dependências locais declaradas em `f2b0-runtime/package.json`; não instala nem modifica plugins globais. Os testes não devem executar o runner real.

O material é evidência versionável e sanitizada; arquivos privados de execução não são incluídos. Branch de publicação: `test/ted-f2b0-no-retry-controlled`, baseada em `139033cb718f9d29e79aad0f7a97237ba263c7bc`. A branch anterior e o PR #278 permanecem preservados, sem merge nem deploy. A publicação foi solicitada pelo operador; este relatório não autoriza nova execução, fallback ou gasto.

**Recomendação:** manter B0 como interrompido e a qualidade como pendente. Não avançar à B1 com zero respostas. Qualquer nova tentativa requer autorização separada, revisão da reserva/inconclusivo F1-B005 e decisão explícita sobre rate limit e limites de custo; não presumir que a oferta Free estará disponível ou que “free” garante ausência de cobrança.

## Histórico anterior — preflight bloqueado, supersedido

O relato anterior, feito antes de preparar o runner nativo, concluiu **BLOCKED antes da inferência** porque a documentação não comprovava um controle de retry zero. Também registrou a preparação do adapter/manifesto e os testes locais então executados. Essa conclusão descreve o estado anterior à implementação e validação do plugin/hook; foi supersedida pela execução controlada acima. Permanecem válidos os limites: documentação/catalogação não prova disponibilidade, uso ou cobrança; o mock não é benchmark; e nenhum resultado de qualidade pode ser inferido sem resposta avaliada.
