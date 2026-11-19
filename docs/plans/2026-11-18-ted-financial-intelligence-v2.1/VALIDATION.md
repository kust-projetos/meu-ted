# MEU TED Financial Intelligence V2.1 — Inteligência financeira autônoma

## Decisão e baseline

Desenvolvimento executado sem mudança arquitetural nem A0/broker. Em 2026-11-18, o operador escolheu explicitamente **“Publicar e ativar capacidades novas”** e autorizou o deploy de produção da V2.1. O deploy foi executado com sucesso; baseline atual de produção: `9dc5d1c65883bfbce4dabaf43b2759919843f8e1` (anterior: `79d8b09`).

## Marco 1 — Interpretação semântica

**APROVADO pelo orientador.** Três execuções com modelo real (`opencode-go/deepseek-v4.1-flash`) em `e1291ed`/`a87eba3`/`5c4e63` demonstraram classificação correta de “Recebi 3200 de décimo” como receita de 13º (R$ 3.200,00, data 18/11/2026, catálogo real consultado, ambiguidade material de conta identificada).

**Restrição registrada pelo orientador:** campos estruturados da proposta, idempotência e ausência de escritas NÃO foram comprovados pelo spec P4.

## Marco 2 — Categorização e aprendizado

**IMPLEMENTADO E INTEGRADO.**

- PR #420: gateway usa cliente tool-scoped para `categories.create`, com `mintPath='/auth/agent/category-autoexec-token'` e header `x-agent-category-autoexec-service-token`.
- PR #421: prompt decide reutilizar categoria existente para 13º/Salário sem perguntar; `recall_category_preference` por termo da descrição alinha learn/recall; aprendizado continua host-only em `server.mjs`.
- PR #422: API adiciona capability `financial.approval.autoexecute.category`, emissor dedicado `POST /auth/agent/category-autoexec-token`, capability registrada em `/authorize` sem exigir `TED_RISK_BASED_AUTOEXECUTE=on`, e linha em `docs/architecture/write-mutator-policy.md`.

Validação na main: runtime 417 testes/0 falhas; API focada 41 testes/3 arquivos; `pnpm test:scripts` 21/21; `pnpm docs:lint` 17 documentos/0 issues. CI verde nos três PRs.

## Marco 3 — Correções conversacionais

**IMPLEMENTADO E INTEGRADO.** PR #423: host injeta bloco factual `[PENDING PROPOSAL CONTEXT]` da proposta ativa (somente mesmo autor, campos filtrados, sem token/hash/operationId, falha suave) no turno; prompt distingue negação ambígua de cancelamento explícito. `supersede`/`cancel`, identidade, `expectedProposalHash` e chave de idempotência preservados. Runtime 418 testes/0 falhas na branch; CI verde.

## Marco 4 — Jornada E2E completa

**INCONCLUSIVE.** Spec `p5-category-correction-real.spec.ts` mesclado em #424 (`3c3bff`) e ajustado em #425 (`b7e5ed1`, mensagem inicial passou a especificar "no Nubank" para evitar esclarecimento de conta). Duas execuções com modelo real, uma por versão, `--retries=0`, sem deploy:

- `3c3bff`: modelo interpretou corretamente (categoria Mercado, R$50, data ontem) mas pediu esclarecimento de conta (Itaú/Nubank); nenhuma proposta; falha no botão “Confirmar R$ 50,00” após 300s.
- `b7e5ed1`: UI reportou “TED indisponível”, “Falha no envio”, “Não foi possível preparar a proposta de despesa. Tente novamente.”; nenhuma proposta; mesma falha de botão.

Consequência: correção para R$55, decisão `succeeded`, receipt, transação de 5500 cents, POST de execute, replay idempotente e reutilização de categoria NÃO foram alcançados/verificados neste spec. A prova anterior de proposta/confirmação/idempotência com modelo real permanece a da missão anterior (`p3-expense-real.spec.ts`).

## Pendências verificáveis (sem causa atribuída)

### Homologação instrumentada — tentativa única (2026-11-18)

A execução autorizada com `P2D_LIVE_REAL=1 P2D_CATEGORY_CORRECTION_REAL=1` falhou ANTES de iniciar o teste com `Error: Timed out waiting 600000ms from config.webServer`. A spec não chegou a rodar: SEM anexo `p5-network-report`, SEM jornada financeira executada, SEM status/code de rede capturados. Custo/tokens NOT_OBSERVED. `.env.local` restaurado com hash idêntico; portas liberadas. Classificação: falha de infraestrutura do harness (prontidão do webServer), não falha funcional demonstrada; causa do timeout não determinada. Nenhuma nova execução paga foi realizada, conforme o limite do orientador.

Instrumentação de rede integrada e validada gratuitamente (teste 3/3, PR #430, commit em `b69cd73`); permanece pronta para futura homologação, mediante nova autorização de chamada paga.

- `/pending-operations/active` respondeu 200 em todas as 9 requisições do harness sintético, sem `code` de erro. O banner "Não foi possível carregar as aprovações agora." não se reproduziu no sintético.
- `/pending-operations/propose` respondeu 200 nas 2 requisições do trace sintético, sem `code`. A spec sintética `p3-expense.spec.ts` passou (proposta → confirmação → 1 transação).
- Diagnóstico de código identificou, com alta confiança, que na 2ª execução do P5 em live-real o chat devolveu uma proposta e a falha ocorreu no POST `.../rpc/pending-operations/propose` (`TedChat.tsx:882-890`, `agent-client.ts:1483-1513`), não no provider/modelo. O `code` do gateway (`pending.upstream_<status>_mint` ou `_propose`, `pending-client.mjs:39-50`) não foi gravado em nenhum artefato da execução live-real.
- **Bloqueio verificável:** sem captura do status/`code` da resposta de `/propose` e `/active` em live-real, a causa raiz das falhas do P5 em live-real permanece indeterminada. Essa captura exigiria execução com LLM real, não autorizada nesta missão. Não repetir tentativas sem mudança concreta.

## Estabilização operacional — evidências (sem LLM paga)

- Trace nativo do Playwright no harness sintético: GET `/pending-operations/active` ×9, status 200, sem `code` de erro. O banner "Não foi possível carregar as aprovações agora." não se reproduziu no sintético.
- O mesmo trace: POST `/pending-operations/propose` ×2, status 200, sem `code`. A spec sintética `p3-expense.spec.ts` passou (proposta → confirmação → 1 transação).
- O diagnóstico de código da 2ª execução do P5 em live-real indica, com alta confiança, que o chat devolveu uma proposta e a falha ocorreu em `POST .../rpc/pending-operations/propose` (`TedChat.tsx:882-890`, `agent-client.ts:1483-1513`), não no provider/modelo. O `code` do gateway (`pending.upstream_<status>_mint` ou `_propose`, `pending-client.mjs:39-50`) não foi gravado em nenhum artefato dessa execução.
- Sem a captura do status/`code` de `/propose` e `/active` em live-real — que exigiria execução com LLM real, não autorizada nesta missão — a causa raiz das falhas do P5 em live-real permanece indeterminada. Este é um bloqueio verificável; não atribuir causa e não repetir tentativas sem mudança concreta.

- **Marco 6 — investigação do timeout do webServer:** a correção de observabilidade (PR #432, commit 1229964) expôs `lastLines`/`stderrTail` do probe (redigidos) no erro de boot e em `/p2d/probe-log`. Na reprodução Gratuita em live-real com essa correção (portas ctl=3200, api=4110, gateway=3221, next=3201; flags P2D_LIVE_REAL=1 e P2D_CATEGORY_CORRECTION_REAL=1), o coordenador iniciou API e gateway e o ctl ficou pronto em 37,1 s, com `/health` = `{"ok":true,"probeRunning":true}`. Nenhuma linha de erro apareceu no log. Portanto o timeout anterior de 600 s **NÃO se reproduziu**: a causa permanece indeterminada e **NÃO é declarada resolvida**. Classificação: erro anterior não reproduzido (intermitente), sem mudança concreta de comportamento de boot — a alteração aplicada foi apenas de observabilidade; nenhum timeout ou retry foi alterado. Nenhuma execução com LLM real foi feita nesta etapa; o P5 permanece **INCONCLUSIVE**.

### Testes determinísticos (execução serial, paralelismo zero)

As suítes foram executadas uma por vez para eliminar flake de concorrência:

- `pnpm --dir apps/ted-runtime test`: 417 passaram / 1 falhou. Falha isolada em `native-model-selection.test.mjs:71`: `ServiceUnavailableError: Location plugins did not finish activating`, intermitente e fora das capacidades desta missão.
- `pnpm --dir apps/api exec vitest run tests/approvals/pending-v2-authorize-route.test.ts`: 17/17.
- `pnpm --dir apps/api exec vitest run tests/approvals/pending-v2-supersede.test.ts tests/approvals/pending-v2-idempotency.test.ts tests/approvals/pending-v2-claim.test.ts tests/approvals/pending-v2-uncertainty.test.ts tests/approvals/pending-v2-transaction-description.test.ts`: 40/40 — confirma supersede/merge, idempotência, claim/ownership, incerteza e descrição/transação.
- `pnpm --dir apps/pwa exec vitest run src/lib/api/agent-client.test.ts`: INCONCLUSIVO por infraestrutura do pool Vitest (`Timeout waiting for worker to respond`); nenhum teste executado.
- Com concorrência, as mesmas suítes haviam falhado por timeouts/SIGKILL; com paralelismo zero voltaram a passar. Registrar como instabilidade do runner, não como regressão funcional demonstrada.

### Telemetria, homologação e estado

- O probe descarta dados de uso por design (`p2d-synthetic-read-probe.mjs:987`); nenhum dado de custo/tokens foi fornecido pelo provider: `NOT_OBSERVED`. Não criar infraestrutura nova de telemetria.
- Plano de homologação em `docs/plans/2026-11-18-ted-financial-intelligence-v2.1/HOMOLOGATION.md` (PR #428), com cenário único, resultados esperados e condições de parada. Nenhuma execução com LLM real foi feita nesta missão de estabilização.
- Registro da missão de estabilização anterior ao deploy: naquele momento, baseline `79d8b09` inalterado; nenhuma flag ativada, nenhum deploy e nenhuma chamada paga. Estado posterior observado consta na seção de deploy abaixo.

Nenhuma chamada paga à LLM foi executada após a decisão de encerramento do orientador.

**Financial Intelligence V2.1 — desenvolvimento concluído; homologação integral INCONCLUSIVE.**

A próxima prioridade é homologação operacional em ambiente controlado, com habilitação condicionada a evidência integrada com LLM real e autorização específica do operador.

## Limitações e resíduos

- Custo/tokens do modelo NOT_OBSERVED.
- Cinco execuções com modelo real foram gastas nesta missão (3 no P4 + 2 no P5). O orientador fixou limite de "sem ciclos indefinidos de estabilização" - novas execuções exigem nova orientação.

## Flags desativadas e habilitação controlada futura

No estado observado em produção em 2026-11-18, API/PWA executam código no SHA `9dc5d1c` (main `6a0d9b4`, um commit somente de documentação à frente; paridade de código). `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`; o token dedicado de categoria está provisionado (`TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN`), mas o gateway não cria cliente de autoexecução enquanto a flag estiver 0. `TED_RISK_BASED_AUTOEXECUTE=on` é valor preexistente da API. `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1` e `TED_OPENCODE_CATEGORY_MEMORY_ENABLED=1` estão efetivos em produção.

Habilitação futura deve: provisionar o token dedicado fora do repo, exigir dono da conversa (pin B), manter a política server-side da API e NUNCA ativar autoexecução de movimentações financeiras.

## Encerramento da missão de homologação (2026-11-18)

**Fase 0 (prontidão gratuita): falhou.** O coordenador P2D em modo sintético (`P2D_BROWSER=1`) parou no log `[p2d-stack] root=...`; nenhuma das quatro portas abriu em 240 s: API 4110, coordenador 3200, gateway 3221 e Next 3201 — todas sem resposta. O log do coordenador tinha 87 bytes (apenas `root=...`); o log do Next estava vazio (0 bytes). Portas liberadas ao final (`PORTS_RELEASED=True`).

**F0.1 (diagnóstico direcionado):** o trecho `root=` → `api=` em `apps/pwa/e2e/support/p2d-browser-stack.mts:166-384` é idêntico nos modos `P2D_BROWSER` e `P2D_LIVE_REAL`; a credencial real não é carregada nesse trecho. `createBetterAuth` (`apps/api/src/auth/better-auth.ts:39-86`) e `buildTestApp` (`apps/api/tests/test-app.ts:137-337`) são síncronos, sem banco/rede/arquivo. Hipóteses não verificadas: `EADDRINUSE` por órfão na 4110, plugin Fastify assíncrono em `await app.listen()` (`:383`, sem timeout), ou log truncado. Host limpo ao final (sem listeners/órfãos), mas isso não prova o estado na execução que falhou. **CAUSA INDETERMINADA**; observação que falta: stderr completo do `webServer` da execução falha.

**Decisão do orientador:** encerrar a missão de homologação com bloqueio de infraestrutura documentado. Sem novas tentativas, sem chamadas pagas, sem declarar infraestrutura corrigida nem P5 aprovado. Instrumentação de `/propose` e `/active` preservada (PR #430, validada 3/3) para futura investigação.

**Estado da homologação:** V2.1 implementada e integrada, mas **NÃO homologada integralmente**; P5 **INCONCLUSIVE**. O timeout/inicialização P2D e a jornada P5 não foram declarados resolvidos. A configuração efetiva pós-deploy é documentada abaixo; não se declara ativação de autoexecução de categoria.

## Deploy de produção V2.1 (2026-11-18)

O operador autorizou explicitamente **“Publicar e ativar capacidades novas”**. PR #435 (`fix(gateway): inject category autoexec mint token into compose`) foi mesclado antes do deploy para injetar `TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN` no compose do gateway.

- **Baseline de produção:** `9dc5d1c65883bfbce4dabaf43b2759919843f8e1` (anterior `79d8b09`).
- **API:** wrapper `scripts/ops/api-release-20260930.sh`, lane source-build, CI run `44330661848`; backup `pre-90ec37f-20261118` (sha256 `f3dc4886165fd8b03f4a929c08286f5ad59a6adbfb7453449b77bb7ddef5d48a`); rollback tag `pi-finance-api:rollback-pre-9dc5d1c`. Health ao vivo `{"status":"ok","gitSha":"9dc5d1c...","buildId":"44330661848"}` e `/ready`=200.
- **Gateway ted-runtime:** rollback tag `ted-runtime:rollback-pre-9dc5d1c`; `opencode.json` foi regenerada pelo bootstrap, backup `opencode.json.bak-pre-9dc5d1c`; token dedicado de categoria provisionado (valor fora do repositório); flag efetiva `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0`; container healthy; rota `/api/agent/agents/finance-chat-agent/{workspace}/rpc/pending-operations/active` retorna 401 `auth.session_required` sem sessão (rota existe).
- **PWA:** workflow `PWA Deploy`, run `44336496351` no SHA `9dc5d1c`; gate, deploy, smoke e attestation todos success; `/api/build-info` informa `gitSha` `9dc5d1c...`.
- **Capacidades:** autoexecução de `categories.create` **não está ativa**: flag do gateway efetiva `0`, embora API tenha `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED=1` e `TED_RISK_BASED_AUTOEXECUTE=on` preexistente. A API permite autoautorização apenas para `transactions.expense.create`/`income.create` abaixo de 50000 cents; a partir de 50000 cents exige confirmação. `categories.create` depende do autocreate habilitado e política `auto_execute`, mas o TED não a aciona sem cliente no gateway. Transferências, cartões, contas a pagar, metas, orçamentos e atualizações não são autoexecutáveis.

**Ressalva:** o deploy de código ocorreu sem homologação integral prévia com LLM real. A configuração efetiva pós-deploy observada não ativou autoexecução de categoria. P5 continua INCONCLUSIVE; os smokes acima não equivalem à homologação da jornada financeira ponta a ponta.

## Validação pós-deploy (2026-11-18)

| Configuração | Esperado/documentado | Efetivo observado | Risco | Correção necessária |
| --- | --- | --- | --- | --- |
| `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED` | `1` (documentação de deploy) | `0` no gateway | Autoexecução de `categories.create` não está ativa; não há cliente de autoexecução | Corrigir documentação; qualquer alteração da flag exige autorização explícita |
| `TED_RUNTIME_CATEGORY_AUTOEXEC_MINT_TOKEN` | Provisionado para a capacidade | Set (valor omitido); `TED_RUNTIME_AUTOEXEC_MINT_TOKEN` unset | Token presente não ativa capacidade com flag 0 | Sem correção operacional nesta missão |
| `TED_RISK_BASED_AUTOEXECUTE` | Política API existente | `on` na API, valor preexistente | Política da API não implica cliente TED ativo | Não alterar aqui |
| `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED` / supersede | `1` | `1` na API | Capacidade API existe, mas categoria autoexec segue inativa pelo gateway | Nenhuma nesta missão |
| Prompt/memória/P3 no gateway | Habilitados conforme configuração | Prompt=1, memória=1, P3 reads=1, P3 writes=1 | — | Nenhuma nesta missão |

**Saúde e revisão de código:** API healthy; `/health` e `/ready` 200, `gitSha=9dc5d1c65883bfbce4dabaf43b2759919843f8e1`, buildId `44330661848`. PWA respondeu 200; `/api/build-info` reportou o mesmo SHA e buildId `44330661883`. Gateway healthy. `main` está em `6a0d9b4` (commit #436 somente docs); produção está um commit docs-only atrás, com paridade de código.

**Falhas de boot do gateway:** RestartCount=14, com 14 erros idênticos: `writeTedConfig: opencode.json already exists with different content — refusing to overwrite user work`. O 15º boot iniciou após substituição do config stale (mtime `15:29:42Z`, início do container `15:29:54Z`). A causa foi reproduzida localmente: config gerada com `productPrompt=false`/`categoryMemory=false` era recusada quando o código solicitava `true`/`true`. A correção nesta branch reconhece as oito combinações geradas de `p3Writes`, `productPrompt` e `categoryMemory`; preserva override legítimo de `model` e continua recusando edições arbitrárias e symlinks. Validada com 10/10 testes de `bootstrap-hardening` e 14/14 testes runtime relacionados. Portanto, o risco de recorrência por transição de flags está endereçado pela correção de código; não houve restart nem deploy de produção para validar esta correção.

**Validação funcional:** smoke autenticado BLOCKED: não havia credenciais de teste autorizadas no ambiente; estados `e2e/.auth` não foram usados. P5 com LLM real permanece **INCONCLUSIVE**; nenhuma chamada paga foi feita nesta missão. Issues #87 e #235 foram encerradas como obsoletas (A0 removido); #245 permanece aberta. Nenhum dado foi deletado.

### Smoke de produção (somente leitura)

Comando executado duas vezes:

```sh
E2E_PRODUCTION_SMOKE=1 E2E_PRODUCTION_URL=<PWA_PROD_URL> EXPECTED_SHA=9dc5d1c... pnpm --dir apps/pwa exec playwright test --config=e2e/playwright.config.ts --project=production-smoke --workers=1 --retries=0
```

O host de produção é validado por `scripts/validate-deploy-origins.mjs` e injetado pelo workflow de deploy.

- Run 1: 1 PASS (SMOKE-05 build-info SHA); 4 FAIL (SMOKE-01..04) por `net::ERR_SOCKET_NOT_CONNECTED` / navegação com timeout de 45s — instabilidade de conectividade.
- Run 2: 3 PASS (SMOKE-03, SMOKE-04, SMOKE-05); 2 FAIL (SMOKE-01 `/` e SMOKE-02 `/registros`), pois `getByRole('button',{name:/Registrar|Entrar/i})` não ficou visível em 15s.
- `curl` direto, somente leitura, na mesma máquina: `/`=200, `/registros`=200, `/contas`=307, `/cartoes`=307.
- Inspeção DOM independente com Chromium headless (12s de espera, sem autenticação) em `/`, `/registros` e `/hub/patrimonio?aba=contas`: as três renderizaram o shell de login, com texto visível “Meu Ted tudo em dia. E-MAIL SENHA Entrar”, 1 botão e `btnVisible=true`. Único erro no console: HTTP 401 esperado da sondagem de sessão sem autenticação.
- Diagnósticos independentes headless mediram o CTA visível em 1–2s; repetidos com o header extra usado pelo smoke, também renderizou em 1–2s. Re-run final gratuito, sem carga pesada concorrente: **5/5 (SMOKE-01..05), exit 0, 15.7s**.

Conclusão: em condições estáveis, SMOKE-01..05: **PASS**. Os erros dos runs anteriores (4 falhas de rede e depois timeouts de SMOKE-01/02 no CTA) foram flakiness transitória de conectividade/carga, não uma regressão de UI em produção; o CTA também foi observado visível em 1–2s nas verificações independentes. Nenhum smoke autenticado foi executado: não havia credenciais autorizadas no ambiente e os estados `e2e/.auth` não foram usados. Homologação com LLM real permanece **INCONCLUSIVE**.

### Testes determinísticos (sem LLM pago)

| Suíte/comando | Resultado | Classificação |
| --- | --- | --- |
| TED runtime `node --test` serial: `p0-recovery`, `correction-actions`, `category-memory-store` + `category-memory-tool`, `p3-propose-income` + `p3-propose-expense` | 39 passaram / 0 falharam (4/4, 10/10, 3/3, 22/22) | PASS |
| API Vitest `authorization-config` + `mutation-authorization-policy`; `keyed-mutations` | 24/24 e 6/6 | PASS |
| API Vitest `pending-v2-authorize-route.test.ts` (arquivo completo) | 15 passaram / 2 falharam; ambos `Test timed out in 15000ms` em “fails closed when flag is unset/off”. Reexecução isolada dos mesmos dois testes: 2 passaram, 15 skipped, 6.29s | PASS na reexecução isolada |
| API testes de supersede/idempotency/category-autocreate | 24 passaram / 2 falharam; ambos com timeout de 15s em `pending-v2-supersede.test.ts`. Reexecuções isoladas: `-t "feature flag off returns explicit refusal"` → 1 passou, 0 falhou, 14 skipped; `-t "audits the cancelled original and the replacement proposal"` → 1 passou, 0 falhou, 14 skipped; ambas exit 0 | PASS nas reexecuções isoladas |

Os quatro timeouts dos arquivos completos foram causados por lentidão de runner/infra sob carga; todos os quatro testes passaram em reexecuções focadas, sem defeito funcional observado nas suítes 1–8. Os comandos focados de supersede foram `pending-v2-supersede.test.ts -t "feature flag off returns explicit refusal"` e `pending-v2-supersede.test.ts -t "audits the cancelled original and the replacement proposal"`. Os runs de arquivo completo seguem lentos neste ambiente; reexecuções isoladas foram confiáveis. Não houve alteração de código de produto para obter esses resultados. Sem chamada paga à LLM e sem E2E live-real; estes resultados não declaram homologação integral.

### E2E sintético (sem LLM pago)

Execuções no projeto Playwright existente `p2d-synthetic`, com provider somente scripted local, sem credenciais reais, sem flags live-real e sem LLM paga:

- **Jornada B — despesa, recuperação e transação única:** `P2D_EXPENSE=1`, spec `apps/pwa/e2e/p2d/p3-expense.spec.ts` — **PASS 1/1**, exit 0. Evidência em `apps/pwa/test-results/p3-expense/evidence.json`: `proposeRequests=2`, `confirmRequests=1`, `executeRequests=1`, `cancelRequests=1`, `recoveredAfterReload=true`, `reloadNewPrompts=0`, `syntheticExpenseRows=1`, `duplicateLaunch=false`, `rejectedWrites=0`, `ledgerTotal=5`.
- **Jornada A — receita:** `P2D_INCOME=1`, spec `apps/pwa/e2e/p2d/p3-income.spec.ts` — primeira execução **INCONCLUSIVE**: o probe do `webServer` não ficou pronto em 180 s e nenhum teste foi executado. Na reexecução focada, **PASS 1/1**, exit 0. Evidência em `apps/pwa/test-results/p3-income/evidence.json`: `recoveredAfterReload=true`, `reloadNewPrompts=0`, `syntheticIncomeRows=1`, `duplicateLaunch=false`, `rejectedWrites=0`, `balanceDeltaCents=250000` e um ID de transação presente. Classificação final: **PASS**, com a ressalva do timeout transitório do probe na primeira execução.
- As suítes determinísticas acima cobrem memória/recall de categoria e correção/supersede. Uma única jornada de navegador que combine criação/reuso/deduplicação de categoria e aprendizado em uma sessão NOVA com LLM real **não está coberta** e permanece **INCONCLUSIVE**. Recuperação sem duplicação (D) está coberta sinteticamente pelas asserções `recoveredAfterReload`, `reloadNewPrompts=0` e `duplicateLaunch=false` descritas acima.
- Não há alegação de homologação com LLM real; P5 permanece **INCONCLUSIVE**.

Nenhuma flag de produção foi alterada e nenhum deploy foi realizado nesta missão de validação. Estes checks não constituem homologação integral.

## Homologação funcional — tentativas e diagnóstico direto (2026-11-18)

- O operador autorizou uma rodada P5 paga e uma conta de teste dedicada. Nenhuma credencial `PWA_LIVE_*` foi injetada; a conta genérica do arquivo de ambiente local não foi usada. #439 permanece **BLOCKED**.
- **Primeira tentativa P5 paga:** `Error: No tests found`, 0 testes e 0 chamadas de modelo. O `grep` do launcher por `p2d-live-real` excluía o título P5 `live-real: correct expense amount...` quando `CATEGORY_CORRECTION_REAL=1`. Corrigido no PR #443 (merged); depois, `--list` gratuito selecionou 1 teste e `p2d-live-modes` passou **35/35**.
- **Segunda tentativa P5 paga** (único teste executado): **FAIL** após cerca de 6,7 minutos. A UI exibiu “Falha no envio” e “Não foi possível preparar a proposta de despesa. Tente novamente.” Não houve botão Confirmar nem evidência de decisão, recibo, transação, `executionPosts` ou replay; também não foi gerado artefato de relatório de rede. O arquivo de ambiente foi restaurado com hash idêntico; nenhuma nova tentativa foi feita.
- **Observabilidade:** PR #444 (merged) registra metadados de rede sincronamente, limita a leitura do corpo JSON a 1500 ms e garante que isso não bloqueie `report()`; testes do helper passaram **6/6**. A investigação SQLite read-only confirmou que o harness P2D não inicia `workerd` e usa uma raiz temporária nova. Concorrência e causalidade com a falha P5 permanecem **NOT_VERIFIED**; sem reprodução, nenhuma correção foi feita.
- **Diagnóstico direto** (sem Playwright, LLM paga ou retries; uma rodada): **55/55 testes passaram** — ciclo de integração API **7/7** (Fastify + gateway loopback: 200/201/400/403/409, incluindo `validation.error` e `agent.workspace_not_empty`); supersede/idempotência de aprovações **23/23** (replay 201/200, `pending.supersede_disabled` 404 e códigos `approval.*`/`idempotency.conflict`); correção/proposta/recuperação do runtime **25/25** (correções 200 sem fallback; recuperação 502/409/200 com um prompt). **Nenhum defeito funcional foi comprovado.**

**Conclusão:** contratos financeiros estão intactos na camada sintética. P5 com LLM real permanece **FAIL**, de causa indeterminada e sem atribuição a componente. Homologação com LLM real, smoke autenticado da UI e aprendizado de categoria continuam pendentes. Produção permaneceu inalterada: sem deploy ou alteração de flags. Os commits de merge #437, #438, #442, #443 e #444 estão em `main`.

## Atualização factual (2026-11-19)

As classificações **INCONCLUSIVE** acima preservam o histórico das rodadas
anteriores. Rodadas posteriores de P5 em 19/11 terminaram em **FAIL**, com
evidência de falha da UI registrada na issue #440; não reclassificar essas
execuções como INCONCLUSIVE. A causa não é atribuída aqui. **V2.1 não está
homologada**, e nenhuma homologação com LLM real foi realizada nesta missão.

O fix de boot #442 (`writeTedConfig`, merge `f58143b`) está integrado em
`main`, mas **não publicado**. A flag
`TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0` permanece inalterada. Publicar #442
exige autorização explícita separada; a correção de boot não depende da
homologação P5.

### Plano de publicação de #442 (não executado)

Após autorização do operador:

1. Verificar a versão atual da imagem antes de qualquer ação.
2. Preservar backups de `opencode.json` e das flags atuais.
3. Manter `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED=0` e todas as demais flags
   inalteradas.
4. Após publicar, validar health, boot sem as 14 falhas de `writeTedConfig` e
   acesso autenticado.
5. Preservar o rollback `ted-runtime:rollback-pre-9dc5d1c` e os backups
   `opencode.json.bak-pre-9dc5d1c` e `opencode.json.bak-pre-79d8b09`.

Este plano não autoriza publicação, acesso à VPS nem mudança de configuração.
