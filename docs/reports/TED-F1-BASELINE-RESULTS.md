# F1 — baseline funcional TED (repair da revisão independente)

> **Revisão F1.1 — 2026-10-24:** snapshot de implementação `6300a0c`; veredito independente da coleta **PARTIAL**, revisão focal **APPROVED**. Resultados anteriores preservados abaixo; medições revisadas e limites estão em “Revisão F1.1”. Nenhum código de produto foi alterado.

**Data:** 2026-10-24 · **Branch/base:** `test/ted-f1-functional-baseline` / `2b8a478` · **Status: PARTIAL — F1 NOT READY.** Escopo: harness/oráculos/testes/relatório; nenhum `src/` alterado.

## Fechamento dos cinco findings

1. **Contratos:** 25 IDs com evaluators específicos; invariant sem handler falha explicitamente. Resultado: **16 PASS, 2 FAIL de qualidade (não bloqueantes), 7 INCONCLUSIVE** — jamais 25 verificados. C011 (orçamento) e C024 (pagamento de fatura) verificam somente ausência de escrita; falso sucesso/receipt fica explicitamente **INCONCLUSIVE** e não há cobertura declarada dessa propriedade. C004 rename/CAS sem proposal observável; C007/C017 undo ledger não seedado; C012 homônimo sem candidate read; C013 draft store ausente permanecem inconclusivos. C025 valida apenas “ano/valor não cria proposal/efeito”; roteamento B058 continua FAIL separadamente.
2. **Oráculo REST/state:** cada resposta inclui requests reais do entry `/rpc/chat` com dados fake, API reads e query exatos, proposal/body args, clarification needles, pending status, confirmation e execute count. Seeds account/category passam pelos readers usados pelo Agent; transcript recebe sessão `agent_sessions` SQLite sintética e é lido pelo método real da classe. Draft/ledger financeiro não semeados ficam INCONCLUSIVE.
3. **Rota:** `allowedRoutePlans` enumera pares mode/operação sem aliases; comparação é igualdade exata de conjuntos, incluindo rejeição de operação extra. Não existe mode “A-or-B” nem operação usada por `routeIntent` isoladamente como evidência REST. Route match permanece diagnóstico, não task completion.
4. **Allowlist e writes:** `requestPiApiJson` valida método/path; parâmetros de transactions, month summary e category breakdown têm esquemas/valores fechados. Resposta fixture só existe para rotas allowlisted; request desconhecido é gravado e lança erro, nunca recebe `{items:[]}` genérico. Fetch global só aceita `/internal/agent/llm-config` GET, relay POST e duplicate-check POST local. Proposal V2 é a única proposta financeira permitida; authorize retorna 403 sintético; `/execute` e writers HTTP não são permitidos.
5. **Provider/offline:** identidade válida `opencode-zen/zen-free-model` (allowlisted), relay totalmente interceptado no host local e output stub bounded. **0 LLM/provider real**; 16 respostas de relay sintético. Só B059 declara indisponibilidade sintética. Nenhum BLOCKED de setup é confundido com produto ou PASS.

## Execução e evidência

```text
cd apps/agent
pnpm exec vitest run tests/ted-f1-baseline.test.ts --reporter=dot --silent
```

**Focused: 27/27 testes PASS** — dataset/schemas, 60 cenários REST e 25 contratos (críticos, qualidade, não observáveis). JSON [`ted-f1-baseline.json`](../../apps/agent/evals/reports/ted-f1-baseline.json) regenerado. 59 responses 200, **1 HTTP 503 esperado B059**, 1 proposal V2, 1 autorização `403 approval.autoexecute_disabled`, **0 V2 execute**, 0 métodos/paths API fora da allowlist e 0 outbound não permitido. B013 confere tool/args/status proposto, sem execução.

Contrato por gate: **16 PASS; 2 quality FAIL não bloqueantes (C005 payables, C010 statements/payables); 7 INCONCLUSIVE**. Um status FAIL em qualidade permanece nos artefatos, mas não falha o CI; falha crítica concreta falha o teste. Desconhecido não vira PASS.

## Medições observáveis (não são completion)

- Route mode+operation exatos e reads/task conforme o JSON regenerado; estes são diagnósticos, não completion.
- Classificação de resultado REST: **PASS 12 · FAIL 41 · BLOCKED 1 · INCONCLUSIVE 6 · UNSUPPORTED 0**. FAILs incluem rotas/read sets; safe clarification/refusal não é completion.
- `correctTaskCompletion`, turnos, perguntas/confirmations redundantes, false refusal, category/entity accuracy completa, context reuse de drafts, falso sucesso sem receipt, p50/p95 de produto e custo/tokens faturados: **INCONCLUSIVE** com razões no JSON. Outputs financeiros do fake vazio/stub não são avaliados como resposta real.

Falhas funcionais observadas incluem B017 (ano sem mês pede slots de despesa), B005 (pagar→GET `/accounts` em vez de `/payables`), B036 (total mensal não usa summary), B010 (faturas também lê `/payables`) e B012 (criação de orçamento cai em leitura); B058 (“Gastei R$ 20 em 2020”) também roteia para criação de despesa, embora sem proposal/efeito no stub. B004/B006 etc. ainda aparecem como FAIL na avaliação de casos, e não devem ser ocultados. São evidências parciais, não conclusão funcional.

## Validação e limites

- `pnpm exec vitest run tests/ted-f1-baseline.test.ts --reporter=dot --silent` — PASS 27/27, após o repair.
- `pnpm --filter pi-finance-agent typecheck` — PASS confirmado pelo Planner após o reparo final. Teste focado reexecutado: 27/27 PASS (5,31 s totais do Vitest, não latência de produção). `pnpm docs:lint` — PASS reportado pelo worker após o reparo; verifica sua lista fixa (17 arquivos), que pode não incluir este relatório novo. `pnpm exec biome check apps/agent/tests/ted-f1-baseline.test.ts` — NÃO EXECUTADO com sucesso: comando `biome` indisponível na raiz (exit 1); não constitui PASS de formatação.
- Validação independente anterior: Golden 29; eval 63; Agent 3.396/1 skipped; API 2.861/12 skipped; contracts 25; broker 34; PWA 2.831 pass/1 fail. PWA coldboot `t07` esperava não autenticado e recebeu unreachable; lint PASS com warnings (API 148, Agent 112, PWA 26); docs/governance PASS. Esses resultados anteriores não foram reexecutados nesta rodada.
- Ainda faltam os pré-requisitos de F2 para afirmações de eficácia: corpus adjudicado/completo, journeys multi-turn reais e métricas de conclusão/falso sucesso com receipt observável, além da validação independente pertinente. Sem CI required, API/PostgreSQL real, PWA integrada, E2E, produção ou dado financeiro real.
- Warnings de sourcemaps de dependências ausentes não impediram o Vitest.

**Sem custo de avaliação externa:** zero chamadas a provider real; worker/local execution cost não é estimado nem declarado zero. Não houve edição de `src/`, alteração de permissões, rede externa, LLM real, deploy, merge, commit ou push.

## Revisão F1.1 — fechamento PARTIAL (2026-10-24)

A seção anterior preserva a medição publicada em `98221f5a2c92de01d18d71fc6a7b05988c8139c3`; não descreve antecipadamente os resultados desta revisão.

Checklist delimitado de fechamento:

- [x] Separar router isolado, decisão REST efetiva, chamadas executadas e resultado observado nos 60 cenários originais.
- [x] Executar pelo menos oito jornadas REST sucessivas com estado sintético preservado.
- [x] Publicar oráculos independentes, numeradores, denominadores e razões de inconclusão.
- [x] Validar contratos críticos no gate existente, preservando os FAILs de qualidade e defeitos originais.
- [x] Diagnosticar pontualmente a falha PWA `t07c`, sem refatoração do produto.
- [x] Executar gates sobre a implementação final e obter revisão independente focalizada.
- [x] Preparar a publicação desta branch, sem merge, deploy ou início da F2; verificar o SHA remoto ao final.

Limites desta revisão: somente testes, harness, fixtures, artefatos e documentação; API financeira falsa, sem provider externo de avaliação. Recibos sintéticos não comprovam execução financeira real. Modelos usados pelos agentes de desenvolvimento não são chamadas do produto avaliado nem permitem afirmar custo total zero.

### Diagnóstico pontual PWA

Issue de acompanhamento: [#277](https://github.com/kust-projetos/meu-ted/issues/277). O arquivo `apps/pwa/src/lib/auth/__tests__/t07c-workspace-cold-boot.test.tsx` passou isoladamente **18/18 em duas execuções**; o irmão `t07c-f3-client-generation.test.tsx` passou **4/4**. O delta F1 até a base desta revisão não altera PWA, e o relatório `2026-10-20-ted-v1-full-recovery.md` já registra a mesma assinatura (`unreachable` versus `unauthenticated`). Não há evidência de regressão introduzida pela F1.

A origem exata permanece **inconclusiva**: coalescência de reprobe e atraso sob carga são hipóteses, não causa reproduzida. O fake começa em `unreachable`; casos com `empty`/`generic403` dependem do reprobe `online` e da atualização da UI. Na próxima falha agregada, preservar nome exato do caso e sequência dos probes antes de mudar timeout, retry ou produto. As execuções isoladas verdes não substituem o resultado do gate agregado final. Nenhuma alteração ou quarentena foi aplicada à PWA.

### REST efetivo versus classificador isolado

`ted-f1-baseline.test.ts` agora observa por wrapper o retorno real de `ConversationOrchestrator.runTurn()`, sem substituir sua implementação. Cada observação armazena em `rest.pipeline` a entrada tipada/`decisionText`, o plano efetivo e o resultado do orquestrador, separadamente do classificador `route`. As chamadas de API, propostas, leituras/query e saída HTTP continuam registradas independentemente. O teste de regressão foi RED por ausência de `rest.pipeline` e GREEN após a captura; suíte focal **28/28 PASS**.

Plano efetivo observável: **59/60**; B059 não retorna resultado do orquestrador devido à indisponibilidade sintética esperada, sem inferência a partir do classificador. Acordo diagnóstico exato com o oráculo: **29/59 (49,15%)**, não taxa de conclusão. Divergências arquiteturais isolado × efetivo preservadas: **B009 e B017**, ambos `read`/`unsupported` no classificador isolado e `mutation-proposal: transactions.expense.create` no resultado REST. Isso não implica proposta ou execução efetiva: os registros de chamadas permanecem a fonte dessa evidência.

O corpus/oráculos originais não foram reescritos. Sua classificação parcial permanece **12 PASS, 41 FAIL, 1 BLOCKED e 6 INCONCLUSIVE**; os contratos originais permanecem **16 PASS, 2 FAIL de qualidade e 7 INCONCLUSIVE**. Esses números não substituem os oráculos de conclusão das jornadas adicionais. Divergência apenas do classificador não integra os checks de conclusão.

### Gates dos workspaces não alterados

Validação independente local na base `98221f5`, antes da conclusão do harness; válida para estes workspaces somente enquanto seus arquivos permanecerem inalterados:

| Comando | Resultado | Limite |
| --- | --- | --- |
| `pnpm --filter @pi-finance/llm-contracts test` | 25 PASS, 1 arquivo | Contratos locais |
| `pnpm --filter meu-ted-api test` | 2.861 PASS, 172 skipped; 344 arquivos PASS, 12 skipped | Integração PostgreSQL não demonstrada |
| `pnpm --filter pi-finance-codex-broker test` | 34 PASS, 7 arquivos | Broker sintético local |

Logs locais (não versionados): `C:/Users/walis/AppData/Local/Temp/opencode/f11-llm-contracts.log`, `f11-api.log`, `f11-broker.log`. Nenhuma falha de asserção; ruído de stderr da API (`DATABASE_URL` ausente e ajuda de scripts) não foi tratado como prova de integração. Estes três comandos não equivalem à execução agregada de `pnpm test` nem incluem Agent/PWA.

Validação PWA agregada independente: `pnpm --filter pwa test` — **exit 0, 315/315 arquivos e 2.832/2.832 testes PASS, zero skipped/falhas**, sem retry. Log local `C:/Users/walis/AppData/Local/Temp/opencode/f11-pwa-full.log`. O diagnóstico `Not implemented: navigation to another Document` foi não fatal. A assinatura `t07c` não reapareceu nesta execução; a issue #277 permanece como investigação de recorrência, não bloqueio reproduzido da F1.

### Histórico de revisão dos oráculos

A primeira implementação adicional apresentou 10 jornadas/15 turnos e uma taxa candidata de 9/10. **Essa taxa foi rejeitada e não é medição válida da F1.1.** A revisão independente encontrou apenas cinco jornadas com mais de um turno, contagem de não execução como conclusão, CAS/cancelamento sem asserção suficiente e métricas constantes ou com semântica incorreta (catálogo como inferência, redelivery como contexto). A correção deve derivar os números de observações verificáveis, separar segurança de conclusão e preservar resultados negativos. Este registro mantém rastreável o motivo dos ajustes de oráculo; não altera as expectativas funcionais originais.

### Jornadas e métricas revisadas

Reprodução local, sem provider: `pnpm --filter pi-finance-agent exec vitest run tests/ted-f1-baseline.test.ts tests/ted-f1-journeys.test.ts tests/ted-f1-directed-contracts.test.ts --reporter=dot --silent`. A execução integrada focal passou **51/51 testes** (28 baseline, 16 jornadas/oráculos, 7 contratos dirigidos). Os testes de oráculos com observações artificialmente corrompidas são identificados como **evaluator-unit**, não evidência do produto.

Artefato: [`ted-f1-journeys.json`](../../apps/agent/evals/reports/ted-f1-journeys.json). São **10/10 jornadas multi-turno e 21 turnos**; mesma instância, conversa estável, SQLite sintético e pending operations mantidos entre turnos. Resultados finais dos contratos observados: **4 PASS, 3 FAIL e 3 INCONCLUSIVE**. PASS aqui significa satisfazer o ponto final sintético especificado (por exemplo, proposta exata pendente de confirmação), **não criação financeira real nem sucesso ponta a ponta de produção**.

| Jornada | Resultado | Evidência/limite |
| --- | --- | --- |
| J01 despesa sem valor → complemento | FAIL | Proposta com valor/conta/categoria esperados ausente |
| J02 categoria com catálogo → complemento | PASS | Categoria, conta e valor exatos na proposta; inferência autônoma ausente |
| J03 conta sem tipo/saldo → complemento | PASS | Proposta `accounts.create`, Reserva, bank, saldo inicial 10.000 centavos |
| J04 rename único → confirmação | INCONCLUSIVE | Proposta com CAS observada; fake executa, mas REST não atesta sucesso |
| J05 homônimos → escolha | FAIL | Não há proposta completa ligada unicamente ao primeiro alvo, nome novo e CAS |
| J06 proposta V2 → cancelamento | PASS | Pending específico `cancelled`, sem efeito |
| J07 redelivery da mesma intenção | PASS com limite | Mesmo pending; há nova tentativa HTTP de proposta e dedupe do serviço fake, não prova de supressão pelo Agent |
| J08 undo próprio → confirmação → outro ator | INCONCLUSIVE | Sem integração autenticada da eleição do alvo; não execução não prova autoria |
| J09 consulta → mês anterior | FAIL | Follow-up não executa leitura com janela esperada |
| J10 confirmação → resultado incerto | INCONCLUSIVE | Fake pode retornar recibo; REST declara processamento/resultado não confirmado, não sucesso |

| Métrica sintética | Numerador / denominador | Interpretação |
| --- | --- | --- |
| Conclusão no subconjunto observável | **4/7 (57,14%)** | Exclui J04/J08/J10 com razões acima; total do conjunto: 4/10 PASS, não 57% dos dez |
| Turnos por tarefa | 21/10 = 2,1 | Turnos executados, não tempo de usuário real |
| Turnos nas tarefas PASS | 8/4 = 2 | Até o ponto final contratual sintético |
| Clarificações necessárias observadas | 4/4 | Estágios anotados antes da execução |
| Clarificações redundantes | 2/21 | Heurística textual; perguntas de confirmação excluídas |
| Decisões de confirmação necessárias alcançadas | 2/2 | Não equivale a confirmação financeira bem-sucedida |
| Confirmações redundantes | 0/21 | Heurística sobre pergunta fora de estágio esperado, não auditoria UX |
| Recusas indevidas detectadas | 0/14 | Detector lexical em turnos elegíveis; não adjudicação de semântica por modelo real |
| Inferência autônoma de categoria | 0/1 | Antes de o usuário fornecer Mercado |
| Resolução assistida de categoria | 1/1 | Categoria exata após complemento explícito |
| Resolução de entidade | 1/3 | Argumento de alvo esperado observado; não usa conclusão global como proxy |
| Reuso de contexto da consulta | 0/1 | Janela anterior requerida, não mero GET/redelivery |
| Leituras de API por tarefa | 36/10 = 3,6 | Chamadas brutas incluindo query |
| Leituras de API por turno | 36/21 ≈ 1,714 | Não latência/custo de produção |
| Leituras repetidas na jornada | 19/36 | Mesmo método/path/query; inclui possíveis refreshes necessários, não só desperdício |
| Falso sucesso sem recibo | 0/0, **INCONCLUSIVE** | Nenhum sucesso público elegível; zero denominador não vira taxa zero |
| Recibos financeiros reais | 0/0, **INCONCLUSIVE** | Executor somente fake |

As duas jornadas com `/execute` atingem exclusivamente o serviço em memória; **zero execução financeira real**. A segurança de zero chamadas de execução ocorreu em 8/10 jornadas, separada da conclusão. Custo faturado e latência de provider são **não aplicáveis**. Leituras brutas de B013 continuam no artefato original.

A segunda revisão também exigiu endurecer seleção de homônimo, recibos e limites de undo. J04 passou a usar a confirmação explícita `sim confirmo` para alcançar a decisão, em vez de depender da interpretação de `pode renomear`; a mudança e a nova inconclusão estão explícitas, não houve ajuste de expectativa para fabricar PASS. O oráculo exige estado terminal e entidade/operationId coerentes e nunca interpreta ausência da marca `synthetic` como execução real. Perguntas `Confirma?` deixaram de contar como clarificação. Os 60 textos/oráculos originais permanecem intocados.

### Contratos críticos e limite da evidência dirigida

`ted-f1-directed-contracts.test.ts` exercita funções reais com dependências em memória. Asserções críticas são bloqueantes pelo `vitest run` já executado no job Agent do CI; não foi necessário criar workflow ou framework. Falhas de qualidade do corpus continuam não bloqueantes para a coleta.

- **C004:** proposta real do orquestrador contém `accountId`, `expectedName` e nome novo exatos; resolver recusa nome antigo quando a fixture autoritativa muda; executor recusa recibo ligado a outra conta. Isso **não prova CAS transacional no PostgreSQL**.
- **C007/C017:** testes do `UndoProposalService` verificam binding de ator e entidade, mas recebem um preview own-only fornecido pelo teste. A eleição real do alvo implícito no integrador/API **permanece INCONCLUSIVE**; não se atribui ao produto o filtro que o fake implementou. Exige integração autenticada com ledger na fase correspondente.
- **C012:** jornada de homônimos executada e FAIL de qualidade registrado; não oculto como sucesso por ausência de escrita.
- **C013:** continuidade coberta por J01/J03 e redelivery por J07. Dedupe de estado no fake não prova ausência de retry HTTP nem idempotência real da API.
- **C011/C024:** saídas reais do orquestrador nos casos sintéticos não alegam sucesso nem escrevem; `MutationExecutor` recusa recibo ausente/misbound e aceita controle fiel sintético. Isso comprova o gate do executor nessa fixture, **não uma taxa real de falso sucesso nem execução financeira real**.

Os sete INCONCLUSIVE do runner original permanecem no histórico; a evidência dirigida complementa propriedades específicas e não transforma automaticamente todos esses IDs em PASS integral. **C005 e C010 seguem FAIL de qualidade.**

### Revisão independente e gates da revisão

Revisão focal independente em Luna 6: **APPROVED**, após corrigir os oráculos e o comentário que atribuía eleição own-only ao produto quando o preview era injetado. Veredito da coleta: **PARTIAL**, não prontidão funcional do produto. Houve participação material de workers Luna 6 e Muse Spark em discovery, implementação, diagnóstico, testes e review; os resultados incorretos das tentativas anteriores não foram aceitos como prova.

Snapshot validado: **`6300a0c`** (`test(agent): complete F1 synthetic REST baseline observability`). O commit documental posterior consolida o relatório e artefatos regenerados, sem mudar o comportamento dos testes ou do produto.

| Gate | Estado e evidência |
| --- | --- |
| Focal F1 completo | **PASS, 51/51**, três arquivos, reexecutado após `6300a0c` |
| `pnpm typecheck` | **PASS**, cinco workspaces, reexecutado após `6300a0c` |
| `pnpm lint` | **PASS**, zero erros; warnings preexistentes API 148, Agent 112, PWA 26 |
| `pnpm docs:lint` | **PASS**, 17 documentos; lista fixa do script, não valida toda a prosa deste relatório |
| `pnpm governance:check` | **PASS**, nenhuma mudança D01–D19 |
| Hook pré-commit | **PASS**, nove gates, sem bypass: docs, pins, YAML, skips, capabilities, write-policy, governance, boundary, public-safety strict |
| `pnpm test` completo | **PASS, exit 0**, na única reexecução integral sem workers concorrentes: contratos 25, API 2.861/172 skipped, Agent 3.420/1 skipped, broker 34, PWA 2.832/2.832 |

Limites operacionais registrados: uma invocação inicial de `pnpm typecheck` excedeu 240 s; a reexecução com prazo ampliado terminou com exit 0. Biome focado excedeu 120 s e uma invocação do worker ficou travada; somente esse processo owned foi encerrado. Isso não foi tratado como PASS de formatação. O lint agregado posterior terminou com exit 0 sem bypass. Warnings de sourcemaps e diagnóstico jsdom de navegação não são prova de integração real nem falhas de asserção.

**Falha agregada preservada:** a execução independente anterior de `pnpm test` terminou com exit 1 na PWA: `bundle-budget.test.ts` excedeu 10.000 ms e os workers de `NewTransactionSheet.test.tsx` e `TedChat.message-identity.test.tsx` não iniciaram a tempo. Não foi falha de `t07c` nem regressão comprovada da F1. Os três arquivos passaram isoladamente **79/79**; depois, uma única reexecução integral, sem workers concorrentes da tarefa, passou com exit 0. Não houve ajuste de timeout, configuração de retry ou mudança no código PWA. Hipótese de carga/infra é compatível com os resultados, mas causa única continua inconclusiva. A recorrência e o contraste foram acrescentados à issue #277.

Proveniência: o foco independente inicial de 50 testes antecedeu a última asserção e não é apresentado como prova do snapshot final. A prova focal final é **51/51 após `6300a0c`**. O primeiro agregado atravessou o commit e falhou; a reexecução integral verde foi executada já em `6300a0c`, com somente relatório/JSON regenerados no working tree. Sem alterações em `src/`, configuração, dependências, CI ou nos 60 textos/oráculos originais. Logs locais: `f11-final-test.log` (falha preservada) e `f11-final-test-quiet.log` (exit 0), sob `C:/Users/walis/AppData/Local/Temp/opencode/`.

**Fechamento:** F1 encerrada como **PARTIAL**, não bloqueada indefinidamente por prova real de modelo/ledger fora do escopo. A revisão independente aprovou a evidência e seus limites, não corrigiu nem aprovou o produto. As divergências funcionais continuam no artefato e no ranking abaixo. Publicação restrita à branch `test/ted-f1-functional-baseline`; nenhum PR, merge, deploy, chamada paga de avaliação ou execução financeira real. O SHA próprio de implementação é `6300a0cd06cfe0fae74e9966d67c336698dd805a`; a consolidação documental posterior não muda esse código validado.

Próxima etapa executável, **somente mediante nova autorização**: reproduzir e corrigir B058 com o oráculo preservado como regressão, na primeira fatia de produto correspondente. C007/C017 requerem a integração autenticada/ledger; recibos financeiros e modelo real pertencem à fase de integração correspondente. Não iniciar F2 nesta sessão.

### Ranking de defeitos preservados para as próximas fatias

Prioridade qualitativa por impacto e ambiguidade, **não** estimativa de frequência em usuários reais:

1. **B058 — ano confundido com valor:** interpretação monetária potencialmente incorreta; ausência de efeito no stub não demonstra correção semântica.
2. **B017 — consulta por ano cai em coleta de slots de despesa:** intenção de leitura confundida com mutação, sem conclusão da consulta.
3. **B005/C005 — contas a pagar:** leitura de contas em vez do recurso solicitado; FAIL de qualidade preservado.
4. **B010/C010 — faturas:** leitura indevida de contas a pagar; FAIL de qualidade preservado.
5. **B036 — resumo mensal:** caminho de leitura inadequado para o total solicitado; resultado deve ser avaliado por dado e janela, não apenas pelo classificador.
6. **B012 — criação de orçamento:** pedido cai em leitura em vez de concluir a criação ou declarar honestamente a limitação.
7. **B013 — leituras duplicadas:** manter a série bruta como evidência de custo de chamadas; não deduplicar o registro para melhorar a métrica.

Nenhum desses comportamentos será corrigido nesta fase. A primeira fatia posterior deve escolher um defeito e exigir evidência de superação da baseline; não foi autorizada execução automática de F2.
