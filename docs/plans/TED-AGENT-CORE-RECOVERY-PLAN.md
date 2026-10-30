# Plano incremental de recuperação do núcleo conversacional TED

**Registro histórico da auditoria original:** 2026-10-24, checkout `313f999` em `fix/opennext-preview-props`; seu status, gates, reviews e evidências abaixo são históricos, não validação desta branch. **Estado na revisão documental original:** documentação em `docs/ted-core-recovery-refinement`, transportada pelo commit `9de7f20` sobre `origin/main` `b21faff`; refinamento `0d644c5` publicado em `origin`, revisão independente encerrada como APPROVED. Naquela revisão não foram executadas implementação, POC ou jornada integrada; resultados separados em §12.3. Para trabalho posterior, veja a reconciliação abaixo.

**Refinamento:** documentação nesta branch `docs/ted-core-recovery-refinement`, HEAD `9de7f20`, transportada apenas com docs sobre `origin/main` `b21faff` (proveniência de origem reportada `ede7b10`). Os relatos/checks anteriores permanecem evidência histórica e não são reexecução deste refinamento.

## Reconciliação documental — 29/10/2026

Checkout inspecionado: `7ce96d03a6492a724cd8c6cb90bc1931a6a6a1ca`, branch `test/ted-f2b0-no-retry-controlled`. Esta seção resume evidências posteriores à auditoria, sem reexecutar testes, CI, modelos ou jornadas, e não altera os critérios nem a ordem de dependências da §7.

| Fase | Estado e evidência | Pendência ou limite |
| --- | --- | --- |
| F0 — inventário | [Matriz funcional](../audits/TED-FUNCTIONAL-PARITY-MATRIX.md) e revisão documental histórica existem. | Aceite e status por operação precisam de reconciliação; a matriz não prova paridade integrada. |
| F1 — baseline | [Resultado F1](../reports/TED-F1-BASELINE-RESULTS.md) encerra a baseline como **PARTIAL**, com evidências no snapshot `6300a0c`. | Resultados históricos e divergências não comprovam comportamento do checkout atual, modelo real ou ledger. Há correções locais posteriores registradas no [tracking](../reports/2026-10-21-sessao-testes-correcoes-ted.md), sem reclassificação automática da baseline. |
| F2-A.1 — instrumento | [Preparação F2-A](../reports/TED-F2A-POC-PREPARATION.md) registra instrumento pronto no seu escopo e CI do merge sintético `301da30f`; scan de containers teve finding HIGH e gate agregado foi pulado naquele run. | Situação atual do finding e gates no checkout atual não verificada; READY do instrumento não aprova o produto ou B1. |
| F2-B0 — POC real | [Diagnóstico de 29/10](../reports/2026-10-29-f2b0-diagnostico-problemas.md): 23 casos, 2 PASS / 21 FAIL, 17 schemas válidos; **gate semântico FAIL, B1 NO-GO**. | POC sintética não observa conclusão financeira; descritor corrigido após a campanha não foi validado em nova inferência. Quota/Extra Usage foram atestados, não medidos automaticamente; custo API zero não prova faturamento zero. |
| F3–F5 — leitura, escrita e recuperação | Permanecem sujeitos aos gates e evidências integradas da §7; há provas locais delimitadas anteriores, inclusive canário description-only. | Não declarar fases concluídas por testes isolados; demonstrar caminhos, receipt, replay e efeitos no ambiente sintético autorizado. |
| F6 — paridade | [Matriz funcional](../audits/TED-FUNCTIONAL-PARITY-MATRIX.md) fornece o backlog por operação. | Priorizar e aceitar cada operação; paridade TED × PWA e CRUD geral não foram demonstrados. |

**Pendências imediatas:** decidir a semântica de proveniência de valores derivados e avaliar as divergências `period`/`yearMonth`, caixa e clarificações B017/B058 sem reescrever a evidência histórica; registrar decisão sobre a alternativa de interpretação e os gates da §7. Uma eventual nova campanha requer autorização explícita, controles de quota/egress e preservação das evidências/reservas. A [POC V1 de 20/10](../agent-recovery/04-poc-comparison.md) é outra avaliação e não fecha a F2 desta SPEC. Freeze de produção vigente conforme `AGENTS.md`; nenhuma autorização de merge com efeito em produção ou deploy é inferida.

### Reconciliação offline F2 — 29/10

No checkout `7ce96d03` com as alterações documentais desta reconciliação, as duas suítes de caracterização `f2b0-b0-divergences-characterization.test.ts` e `f2a1-supplied-yearmonth-characterization.test.ts` passaram **9/9**. São reproduções sintéticas offline, não reavaliação da campanha nem prova de comportamento financeiro.

| Caso | Conclusão delimitada | Próxima decisão ou evidência |
| --- | --- | --- |
| B017 | O candidato não pediu esclarecimento e difere do oráculo que exige período; não prova que a API não suporte consulta anual. | Conferir se um reader autoritativo suporta o ano completo antes de fixar a experiência desejada. |
| B058 | O candidato pediu data, mas usa `mutation-proposal` e diverge dos campos e entidades esperados; não faltou pergunta. | Preservar fail-closed para data incompleta e avaliar separadamente o contrato do intérprete e os demais campos. |
| J09:T2 | O candidato fornece `period`; o contrato de resumo mensal exige `yearMonth`. O teste não executa HTTP. | Um eventual adaptador precisa provar mapeamento com testes de contrato; não presumir conversão automática. |
| B013 | `Mercado` versus `mercado` falha na comparação exata, enquanto o binder encontra evidência. | A equivalência de caixa da descrição não foi demonstrada; não alterar o oráculo nem afirmar equivalência na API por inferência. |
| B036 / J09 — proveniência | O mês normalizado vem de valores fornecidos/data de referência, mas o oráculo exige `utterance`; o binder não valida a entidade `period`. | Definir se o rótulo descreve a origem da intenção ou o valor normalizado e testar explicitamente o vínculo. Não transformar essa lacuna em PASS automático. |

**Atualização posterior — binder experimental:** o teste RED reproduziu aceitação de `1999-01` sem evidência; o binder agora exige evidência declarada para cada entidade `period`, independentemente do rótulo, sem alterar o parser ou os resultados históricos. Suíte `tests/poc-structured`: **183/183 PASS**. Esta verificação limitada não resolve a semântica de `utterance` nem comprova o produto. Para B017, `apps/api/src/analytics/types.ts` e `compute.ts` aceitam `custom` com `from`/`to`, enquanto `thisYear` vai até hoje: isso mostra uma possibilidade de intervalo anual, não prova integração TED ou equivalência de base financeira.

**Caracterização HTTP posterior — B017/J09:** em fixture isolada da API, `GET /analytics/kpis` com intervalo customizado `2020-01-01` a `2020-12-31` somou as duas despesas nos limites e excluiu as datas adjacentes, retornando filtro efetivo e base `liquidez`; o teste não prova o fluxo TED nem escolhe a base de produto. `GET /dashboard/month-summary?period=2026-09` retornou **400**: `period` sozinho não substitui `yearMonth`. Testes em `apps/api/tests/routes/analytics.test.ts` e `month-summary.test.ts`. Nenhuma conversão automática foi implementada; o FAIL histórico da POC permanece.

**Fechamento da investigação local dos itens — 29/10:**

- **B017:** existe leitura API de ano inteiro com intervalo customizado, testada em memória com limites inclusivos e `basis=liquidez`. O TED não foi conectado a esse reader nesta tarefa; a equivalência da base e a UX de ano completo seguem decisão e integração de produto, não um PASS automático de B017.
- **B058:** manter a expectativa conservadora de clarificação sem proposta quando a data está incompleta. O candidato histórico efetivamente perguntou a data, mas retornou `mutation-proposal`, contrariando o contrato esperado; manter FAIL. Sete arquivos de testes existentes de data/continuação passaram **140/140** em execução local com mocks e stores de teste, não prova live nem cobertura de todas as expressões.
- **J09:** manter FAIL para `period` como substituto de `yearMonth`; a API retorna 400. Conversão futura só com contrato e prova de integração próprios.
- **B013:** a API local preservou as descrições `mercado` e `Mercado` como textos distintos em criação e listagem. Manter a comparação exata nesta POC; não inferir equivalência de domínio apenas da normalização do binder. O teste é in-memory, não PostgreSQL nem teste de usuário.
- **Proveniência:** para esta POC, o rótulo `utterance` no oráculo histórico registra a origem da intenção expressa no turno, **não comprova que o valor normalizado apareça literalmente**. Valor derivado continua exigindo evidência declarada no contexto; o binder experimental agora também rejeita entidade `period` normalizada `YYYY-MM` divergente do argumento `yearMonth`, mesmo se ambos os valores constarem do contexto. O teste reproduziu RED antes da correção; suíte estruturada **184/184 PASS**. Isso não valida a semântica de cada origem nem prova causalidade temporal: a regra de proveniência para um intérprete de produção permanece dependente de contrato próprio e testes adversariais.

Essas conclusões encerram apenas a caracterização local dos cinco itens; não alteram os oráculos ou o resultado B0 histórico, não aprovam B1/F2, não comprovam F3–F6 e não autorizam inferência ou produção.

**Decisão A/B:** ainda não tomada. O B0 histórico permanece FAIL; a correção posterior do descritor não prova resultado de modelo e o comparador possui a lacuna acima. A POC não observa o ledger. Não há base para promover B1 ou declarar F2 aprovada; uma decisão futura pode rejeitar B, mas deve aplicar os critérios da SPEC sem confundir a POC V1 com esta. F3–F6 seguem condicionadas aos gates existentes. Nenhuma inferência externa foi executada nesta verificação.

### Matriz de fechamento F2 — confronto com SPEC §7

| Critério | Evidência disponível | Veredito |
| --- | --- | --- |
| A — 20–30 smoke/contratos, sem write ou falso sucesso | [F1 parcial](../reports/TED-F1-BASELINE-RESULTS.md) contém contratos e cenários sintéticos; parte dos critérios é inconclusiva. | **Parcial:** não afirmar zero violações no universo completo nem substituir o gate pelos testes do avaliador. |
| B — 50–80 casos pareados, A versus candidato estruturado | [B0](../reports/2026-10-29-f2b0-diagnostico-problemas.md) avaliou 23 casos, 2 PASS/21 FAIL; 6 schemas inválidos sob descritor anterior ao ajuste. | **Não cumprido:** B0 é sinal negativo do candidato/configuração testados, não comparação pareada completa nem prova sobre o prompt corrigido. |
| Segurança e schema / métricas por domínio | B0 fornece dimensões observáveis limitadas; conclusão financeira inobservável, sem ledger, e parte dos critérios de segurança não foi exercitada. | **Não comprovado:** não converter ausência de observação em zero violações. |
| C — holdout 150–300 casos e ≥95% intenção+argumentos | Não executado; C só é condicional a B promissor. | **Não executado / NO-GO**, não uma falha medida de holdout. |
| Ganho e UX contra A; p50/p95, custo faturado e tetos | F1 foi parcial; B0 não observou conclusão financeira e faturamento não foi confirmado independentemente. | **Não mensurável com a evidência disponível:** não alegar ganho, equivalência ou custo zero. |
| D — read e escrita V2 integrados, confirmação, replay, recovery e receipt | POC B0 não executou nem observou ledger; canário anterior é limitado a descrição. | **Não executado neste gate:** exige ambiente sintético e autorização de custo/egress conforme SPEC. |
| Qualidade e segurança no checkout entregue | Typecheck, docs e governança passaram em execução local; lint expirou; testes globais não executados e scan histórico de containers teve finding HIGH. | **Inconclusivo:** validar no estado final; finding histórico não prova vulnerabilidade atual. |

**Decisão delimitada:** não promover a configuração B0 testada e manter B1/C/D NO-GO. A opção A permanece baseline existente, não uma vencedora demonstrada por comparação completa. A SPEC permite rejeitar B quando não demonstra benefício, mas as amostras e métricas exigidas para o gate B e a escolha A/B não estão demonstradas; portanto **F2 permanece BLOCKED, não fechada nem aprovada para F3**. Resolver com comparação autorizada e protocolo corrigido ou com alteração explícita e revisada dos critérios da SPEC; este registro não altera critérios por conveniência. Uma campanha com modelo requer autorização específica de custo/egress e confirmação atual dos controles; zero inferências novas nesta reconciliação.

### Decisão técnica — encerramento da investigação B0, sem promoção

Por decisão técnica nesta sessão, **não promover o candidato/configuração B0** e manter o caminho determinístico existente enquanto não houver evidência suficiente para uma alternativa. A amostra disponível é desfavorável, porém parcial e obtida com descritor anterior; não comprova inferioridade de todo modelo estruturado nem valida o prompt corrigido. Não executar nova campanha ou incorrer em custo/egress por inferência de autonomia técnica. Uma reavaliação futura exige protocolo, orçamento e autorização específicos.

Esta decisão encerra a investigação do B0 na configuração observada, **não satisfaz os gates A/B/C/D nem altera a SPEC**. F2 como fase de promoção continua bloqueada e F3 não está liberada pelo plano atual. Faltam comparação e métricas prescritas ou revisão explícita dos critérios, além de lint, teste completo com preservação dos relatórios F1 e verificação do scan no estado entregue. Sem integração, merge ou deploy.

## 1. Registro histórico — contrato e baseline da auditoria 313f999

- Repositório confirmado: `https://github.com/kust-projetos/meu-ted.git`; diretório local histórico `D:/projetos/pi-financeiro`.
- Branch: `fix/opennext-preview-props`; HEAD: `313f9991a54740917edfd02f958c431650fb01b7`.
- `git status --porcelain=v1 --untracked-files=all` inicialmente vazio. Correções já commitadas, inclusive o pacote `f5fd29a` (#270), OpenNext `25bb111` e dependências `313f999`, integram a baseline; não serão descartadas.
- Runtime de ferramentas observado: Windows, Node `v26.11.1`, pnpm `10.34.1`. O CI usa matriz Node 22 / pnpm 10; resultados locais não equivalem ao ambiente de CI.
- `docker ps` não mostrou containers `ted-local`. Nenhum serviço foi iniciado ou reiniciado. O navegador acessível continha somente `about:blank`; não houve observação autenticada da PWA atual.
- Sondagem adicional `Get-NetTCPConnection -State Listen` filtrada para 3000/3001/8787 retornou vazia. Não havia listener observado nas portas declaradas da stack; nenhuma porta foi aberta para produzir evidência.
- Stack declarada: `docker/local/docker-compose.yml`, projeto `ted-local`, API/PWA/Agent/PostgreSQL. Declaração de configuração não prova estado do runtime.
- CI do SHA exato: [CI 40046695553](https://github.com/kust-projetos/meu-ted/actions/runs/40046695553) e [PWA CI 40046695573](https://github.com/kust-projetos/meu-ted/actions/runs/40046695573), ambos `completed/success`, consultados nesta auditoria. `Gate — all checks`, integração PostgreSQL, testes Agent e `quality (22, 10)` passaram. Jobs de publicação main-only foram pulados: não inferir deploy a partir desses runs.
- O comprehensive E2E usa `apps/pwa/e2e/playwright.config.ts` com `fixture-api`, standalone Next e SW harness. É evidência de interface integrada com fixture, não de Agent real → API real → PostgreSQL. `apps/pwa/e2e/live-mobile.config.ts` é uma configuração distinta, opt-in; não foi executada nesta auditoria.

### Limites de autoridade do pedido documental original (histórico)

Somente os quatro documentos solicitados podem ser escritos. Não alterar aplicação, credenciais, migrations, flags ou dados; não executar SQL financeiro; não fazer commit, push, merge ou deploy. Nenhuma autorização histórica de release é herdada. Produção permanece fora do escopo, inclusive canary V5 e Release B.

## 2. Checklist assinalado na auditoria original 313f999 (histórico; não é checklist desta revisão)

- [x] Confirmar identidade do repositório, revisão, branch e working tree inicial.
- [x] Confirmar runtime disponível e CI do SHA, separando fixture de jornada real.
- [x] Reconciliar inventário PWA/API/TED com referências e limites por operação.
- [x] Consolidar auditoria do pipeline, decisões e contratos históricos versus código atual.
- [x] Definir arquitetura-alvo e POC anterior à seleção de inferência.
- [x] Definir fatias, dependências, aceite, custos, migração e rollback.
- [x] Validar referências e obter revisão independente no conjunto documental original; não cobre as correções atuais nem significa APPROVED atual.

## 3. Fontes e resultados relacionados

- [Auditoria de capacidades e arquitetura](../audits/TED-CAPABILITY-AND-ARCHITECTURE-AUDIT.md).
- [Matriz de paridade funcional](../audits/TED-FUNCTIONAL-PARITY-MATRIX.md).
- [SPEC do núcleo conversacional](../specs/TED-AGENT-CORE-REFACTOR-SPEC.md).
- [POC histórico](../agent-recovery/04-poc-comparison.md): B usa templates/readers stubados, `modelCalled=false`; C não foi executado. Não usar seus tempos de 0–2 ms como orçamento de modelo real.
- [Fecho local de 23/10](../reports/2026-10-23-ted-local-crud-session-closure.md): canário description-only, não CRUD financeiro geral. Preservar fixtures e operações anteriores; não reexecutar Solar/Lunar para fabricar evidência.

## 4. Critério de promoção

Auditoria concluída não significa produto homologado ou implementação liberada. A próxima fase depende de inventário reconciliado, responsabilidades inequívocas, POC definida e comparação medida antes de selecionar inferência, gates objetivos por fatia e ausência de dependência de reescrita geral. Lacunas de jornada real devem permanecer visíveis e impedir alegações de paridade comprovada.

## 5. Política de evidência, revisão e parada

Cada critério deve ter expectativa independente, comando ou jornada, revisão exata, resultado observado e limitação. Teste existente não é teste executado; teste unitário não substitui jornada; CI com fixture não substitui modelo/API/banco reais.

Uma revisão independente por fatia é suficiente quando os critérios estão comprovados, não há finding material aberto e não houve mudança relevante posterior. Findings válidos exigem correção e repetição somente das verificações afetadas. Não abrir rodadas por estilo, preferência de framework ou hipótese sem contrato violado. Duas tentativas sem progresso exigem nova evidência/diagnóstico, não um terceiro patch especulativo.

## 6. Registro de execução documental da auditoria original (histórico)

Preflight: `MULTI_WORKER`. Workers de inventário e implementação documental usam `openai/gpt-6-luna` em lugar do Muse Spark, conforme pedido. Architect/reviewer mantêm seu pool forte. O primeiro Explorer retornou levantamento parcial e bloqueio de escrita; sua participação não é prova de inventário completo, e a tarefa foi transferida para um Coder com ownership exclusivo da matriz.

## 7. Fases futuras e dependências

Todas as fases abaixo são **planejadas, não executadas nesta auditoria**. A implementação requer nova autorização de escopo. Estimativas são dias de engenharia de uma pessoa familiarizada com a base, não tempo medido nem compromisso de entrega.

| Fase | Dependência / ownership | Escopo verificável | Gate de saída | Estimativa |
| --- | --- | --- | --- | --- |
| F0 — baseline e paridade | Docs/inventários existentes; owner de produto confirma denominador | Cada operação PWA traçada NL→PWA→API/schema→TED status→deps/auth/tests→slice/aceite; sem novo audit amplo; desconhecido fica gap | Revisão das quatro docs; não perder feature por taxonomy; nenhum endpoint presumido | 1–2 dias (documentação já refinada; aceite futuro por operação) |
| F1 — baseline A | F0; tester independente | 20–30 smoke/contrato + corpus pareado 50–80; sete prompts matrix; oráculos independentes e estado fixo | Baseline quantitativa por domínio e UX metric; no writes; holdout separado | 2–3 dias |
| F2 — POC A/B | F1; aprovação prévia explícita de custo/egress | A determinística vs no máximo 2 intérpretes estruturados via provider existente; 50–80 casos | Gates SPEC §7; budgets/call caps e stop; métricas completas; decisão registrada, inclusive rejeitar B | 1–2 dias |
| F3 — leitura vertical | F2 aprovado; tester + reviewer | Uma leitura suportada existente (ex. resumo mensal ou contas), sem nova rota | RED/GREEN futuro; requests e resposta comparados a oracle; vazio/erro/incompleto distintos; pergunta conceitual sem read indevido; prova integrada sintética | 2–3 dias |
| F4 — escrita manual V2 | F3; operação já executável; review de segurança | Uma operação V2 existente, manual; sem ampliar V5 nem adicionar executor | RED/GREEN; confirmação, erro, concorrência, replay/recovery, readback e receipt; exatamente 0 ou 1 efeito | 3–5 dias |
| F5 — recuperação/rollback | F4; Tester e Reviewer independentes | PWA→Agent→API→PG em stack local isolada e dados sintéticos; histórico/pending/receipt existentes; sem migrations | confirm vs executing recovery corretos, receipt vinculado, reload/replay sem duplicação; rollback preserva formatos/dados | 1–2 dias |
| F6 — paridade progressiva | F5; priorização explícita por domínio/operação da matriz | Rodar backlog por slices: reads, V2 já implementadas, depois decisão individual; admin/workspace preservam suas exceções explícitas | Aceite observável por operação; nenhum “CRUD genérico”; registrar em campos separados classe de obrigação (`mandatory/internal/justified exception/outside current product`) e status TED (`implemented/partial/absent/blocked`); revisão encerra lote | estimar por operação; sem total até escopo acordado |

**Total inicial:** 10–17 dias para F0–F5 conforme estimativas históricas, sem release, nova capability, infraestrutura ou migração de superclass; F6 não tem total defensável sem acordo de escopo. Novos domínios exigem estimativa por operação, nunca “CRUD genérico”. F1 pode preparar oráculos enquanto fecha F0; F2 aguarda denominador e baseline. F3/F4 dependem de resultado anterior e não escrevem concorrentemente nos mesmos arquivos.

#### Checklist por operação (acompanha a matriz em F6)

- [ ] frase natural e paráfrases/follow-up/histórico definidos com oracle independente
- [ ] ação e caminho real PWA conferidos; contrato API/schema/serviço autoritativo confirmado (sem endpoint presumido)
- [ ] status TED: implemented / partial / absent / blocked; requisito de clarificação/limitação definido
- [ ] dependências, workspace/actor authorization, risco e confirmação humana separados
- [ ] teste existente localizado e gap de integração anotado; inserir future CI nos harnesses existentes
- [ ] prioridade/fase, efeito observável, receipt e recovery definidos
- [ ] RED→GREEN em mudança comportamental; erro, replay, cancelamento/reload cobertos
- [ ] revisão independente e evidência do ambiente exato; histórico separado de resultado atual

Tentativas: após duas correções sem progresso verificável, parar e reavaliar hipótese/evidência; não fazer terceiro patch especulativo. Não reabrir a decisão de arquitetura sem evidência nova material. `ISOLATE` não remove funcionalidade: preserva operação PWA e marca explicitamente o limite conversacional até uma fatia autorizada.

### 7.1 Continuação até paridade de produto, sem reescrita

Depois de F5, usar **cada linha operacional da matriz** como backlog rastreável, não uma promessa de expor todas as rotas ao LLM. A sequência abaixo é proposta de dependências; ainda não autoriza novas capabilities ou ampliação de contratos V2.

| Lote | Dependência e conteúdo | Gate por operação | Custo adicional indicativo |
| --- | --- | --- | --- |
| L1 — leituras e contexto | F3/F5; contas/saldos/extrato/cartões/faturas/payables/orçamentos/metas/analytics já expostos na API | Reader exato, filtros/paginação/período, erro/vazio/ausência; nenhuma promessa fora da capacidade | 1–3 dias por nova família integrada, reusando a primeira fatia |
| L2 — escritas V2 já implementadas | F4/F5; contas create/deactivate/rename, categorias create/rename/deactivate, descrição de transação, receita/despesa | Schema/precondição/resolver/executor/receipt existentes; cancelar/replay/recovery e jornada sintética por operação; reconciliar ADR/relato posterior antes de anunciar | 2–5 dias por família com contratos existentes; não é soma automática |
| L3 — escritas financeiras sem caminho conversacional V2 completo | L2 estável; transferência, edição de outros campos/exclusão, compras/parcelas, pagamentos de fatura/payable, contribuições e demais writes da matriz | Decisão de produto/contrato por operação; reutilizar writer API; definir efeitos/undo/recovery/receipt e permissão antes de expor; nenhuma execução genérica por OpenAPI | 3–8+ dias por operação conforme invariantes; reestimar antes de aceitar escopo |
| L4 — administração e lifecycle | Independente de L1, mas não usa grants financeiros; workspace/membership/admin LLM/notificações/sessões | Manter UI/admin quando deliberado; conversa só com permissões e contrato próprio aprovados; exclusão workspace não reutiliza Pending financeiro | Sem estimativa global defensável até decisão de produto |
| L5 — sem API ou deliberadamente desligadas | Produto/gates próprios; export financeiro/planos genéricos/multimodal/web conforme linha da matriz | Limitação honesta permanece até existir serviço/contrato/custo/privacidade autorizados; não implementar para “completar catálogo” | Fora do orçamento de recuperação do core |

Linhas explicitamente fora de escopo permanecem resultados válidos do inventário. A paridade completa só pode ser declarada para o conjunto acordado e executado em jornada integrada, com denominadores por operação/permissão; não extrapolar o canário da primeira fatia. Não existe estimativa total confiável de L1–L5 antes de decidir quais novas capacidades pertencem ao produto; as faixas são hipóteses para priorização, não compromisso de implementação.

A recusa atual de “ano inteiro” no router não prova ausência de serviço reutilizável: conferir antes se analytics com período customizado cobre a consulta e a base/escopo esperados. Não criar endpoint anual só porque `UNSUPPORTED_YEAR_TEXT` existe; se houver cobertura autoritativa, tratar como integração de leitura em L1.

### 7.2 Comparativo Agents SDK / AIChatAgent (adição do operador)

Investigação desta auditoria: versões do lockfile, recursos nativos disponíveis, duplicações de transcript/estado, diferenças de REST/SDK e comparação `AIChatAgent` versus `Agent` base com harness próprio. Não altera SDK/framework/dependências.

Um spike futuro de **1–2 dias**, estimado e condicionado à necessidade material após inspeção da versão travada, pode comparar um read path isolado com as duas superclasses: mesma fixture/contexto/cliente, sem financeiro. Medir complexidade de adapters/hooks/stores, compatibilidade de transcript e wire, falha de persistência, reconnect, privacidade por ator e p50/p95/recursos. Não realizar junto com troca de inferência: usar o mesmo intérprete para não confundir os efeitos.

Resultado da inspeção: classe importada de `agents/ai-chat-agent@0.2.35`, não do pacote separado `@cloudflare/ai-chat`. REST usa o persistidor/tabela herdados; `worker.ts:393–395` bloqueia rotas nativas não-RPC. Recursos base SQL/estado/fila/scheduling/observabilidade já são herdados sem trocar superclass. O campo local `messageConcurrency` e o shim não comprovam serialização na versão travada.

Até haver prova de benefício líquido e rollback, manter `AIChatAgent`. `Agent` REST-only tem estimativa separada de **3–7 dias iniciais**, mais validação; preservar também protocolo SDK custaria **5–10+ dias**, sem justificativa no PWA canônico atual. Não confundir essas estimativas com o spike 1–2 dias nem somá-las ao plano inicial automaticamente. Se exigir perder compatibilidade ou alterar estado durável, interromper a alternativa. A auditoria não implementa migração, remove pacote ou atualiza peers. Tabela comparativa e medidas estáticas reais na SPEC §8 e auditoria SDK.

## 8. Contratos e pontos de intervenção

| Ponto existente | Mudança possível, somente após gates | Compatibilidade a preservar |
| --- | --- | --- |
| `apps/agent/src/finance-chat-agent.ts` (`onChatMessage`, preparação `/rpc/chat`, `mutationProposalPlan`) | Adapters entregam entrada/contexto, sem segunda interpretação financeira independente | Auth, visibilidade, message/intention IDs, erro de canal, persistência e learning pós-publicação |
| `apps/agent/src/orchestration/conversation-orchestrator.ts:runTurnInner` | Consumir um candidato validado no seam existente; manter coordenação | Draft/CAS, handoff V2, undo separado, budgets e reentrega |
| `apps/agent/src/orchestration/turn-plan.ts:validateTurnPlan` | Reusar validação de forma/limites e ligar elegibilidade ao registry executável | Não aceitar operação arbitrária ou argumento extra só porque o plano tem forma válida |
| `apps/agent/src/orchestration/channel-evidence.ts` | Reads explícitos da fatia, sem fallback semântico concorrente quando substituído | Mesmas rotas autoritativas, erro/vazio/incompletude, período/paginação |
| `apps/agent/src/agent-config/tools.ts` | Anunciar só capacidades executáveis por canal; manter tools aposentadas fora do modelo | Sem tools de execução/confirm/undo genéricas expostas ao modelo |
| `apps/api/src/approvals/tool-registry.ts`, `pending-v2.ts` | Reutilizar; não criar segundo executor por catálogo | Schema estrito, hash, escopo, idempotência, receipt, recuperação |
| `apps/pwa/src/features/ted/TedChat.tsx` e parsers de receipt | Validar integração observável, preferindo contrato atual sem redesign | Decisão/requestId sem attestation; sucesso só com receipt ligado; reload/retry seguro |

Arquivos novos só serão definidos se nenhum seam existente suportar o experimento. Não adicionar “core genérico”, serviço ou framework sem necessidade demonstrada.

## 9. Plano de testes por falha e jornada

| Cenário | Oráculo independente | Prova necessária |
| --- | --- | --- |
| Conceito versus consulta | Operação/read esperado, nenhum write | Plano e requests da API; resposta geral sem saldo inventado |
| Período/ano, moeda, nome numérico | Slots esperados e tipo de operação | Ano não vira centavos, moeda incerta clarifica; regressões S7/S8 preservadas |
| Alvo homônimo/privado/outro workspace | Dados sintéticos conhecidos por ator/workspace | Zero escolha arbitrária, zero divulgação/efeito fora do escopo em REST/SDK |
| Continuação/correção multi-turno | Draft inicial e transição esperada | Mesma intenção, sem novo pending duplicado; cancel sem efeito |
| Schema inválido/provider timeout | Nenhuma proposta/efeito autorizado | Erro/clarificação tipados, budgets/retry limitados, sem executor alternativo |
| Commit realizado + resposta perdida | Contagem de efeito e snapshot receipt | Replay mesma chave: um efeito, receipt fiel e estado recuperável |
| `confirmed` antes de claim | Estado da pending e attestation | Reemissão, nunca lease/reconciler sobre `confirmed` |
| `executing` com lease válida/expirada | Estado/chave/contagem | Bloqueio em andamento ou reconciliação mesma chave, nunca nova execução cega |
| Reload/reconexão/double-submit | Ledger e mensagens conhecidas | Sem duplicar mensagem, pending ou efeito; UI não narra sucesso sem receipt |
| REST versus SDK implementado | Mesmo contexto/entrada/estado em harness isolado | REST validado; contrato SDK testado se preservado. Manter 404 para non-RPC na borda; não reabrir o canal só para obter paridade |
| Persistência/publicação/learning | Fault injection por janela | Falha não ensina indevidamente; histórico e audiência corretos; sem double-write/broadcast privado |
| V5 risco | Oráculo da policy API existente | Baixo risco elegível somente allowlist atual; elevado/ambíguo/anexo/destrutivo manual/recusa |

Antes de cada alteração testável: preservar código anterior, capturar regressão RED, aplicar menor mudança e observar GREEN. Não remover testes para fabricar histórico. O ledger deve registrar apenas fixtures novas daquele ensaio, com ambiente explicitamente sintético e procedimento de limpeza revisado pela API, nunca SQL financeiro.

### 9.1 Comandos e pré-condições

Na raiz: `pnpm docs:lint`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm governance:check`. A implementação futura deve cumprir os gates canônicos e manter required checks no SHA integrado. O lint documental padrão tem lista fixa em `scripts/lint-docs.mjs:lintAllDocumentation`; validar os quatro documentos novos explicitamente por `lintMarkdownDocument`, além do comando raiz.

Em `apps/agent`: `pnpm exec vitest run tests/poc-minimal.test.ts` verifica somente o POC histórico; `pnpm eval:ted-v2` é regressão determinística. Nenhum desses comandos prova modelo real ou efeito financeiro. `pnpm eval:ted-v3` envolve modelo real/gates de custo: não executar automaticamente.

O comprehensive de `apps/pwa/e2e/playwright.config.ts` é fixture-based. Uma jornada real sintética futura usa configuração live apropriada com destino **local isolado e explicitamente autorizado**, credenciais por ambiente, guard de workspace e readback. Não copiar comandos de configuração de produção, nem iniciar stack/migrations para satisfazer a auditoria atual.

O alias raiz `pnpm test:e2e` chama `pnpm --filter pwa test`; seu nome não o transforma em jornada Playwright/Agent/API/PG. Registrar sempre o comando/config efetivos e seu destino.

## 10. Migração preservadora e rollback

1. Fixar baseline de código/config/artefato e manifest de formatos duráveis, sem copiar segredos. Não alterar schema SQL, namespace DO, nome de classe exportada/binding ou protocolo financeiro nesta recuperação.
2. Capturar snapshot sintético de drafts/pending/receipts nos estados relevantes. Provar que o leitor atual recupera esses formatos; não usar dados reais.
3. Introduzir interpretação candidata isolada, primeiro sem efeitos. O caminho vigente continua único executor. Shadow compara planos; **nunca executar A e B em paralelo**.
4. Promover uma leitura e depois uma proposta manual existente. Preservar IDs/chaves e versão dos formatos; sem conversão destrutiva.
5. Em regressão, suspender a entrada no novo intérprete e voltar ao seam/baseline validada, mantendo leitores/recovery/writers de variantes já persistidas. Não voltar a um binário anterior à introdução dessas variantes.
6. Drenar/reconciliar propostas existentes com os protocolos atuais; não apagar pendings nem gerar novas chaves. Verificar 0 ou 1 efeito e receipt ligado ao alvo.
7. Só remover código obsoleto quando busca de consumidores, corpus, jornada e recovery provarem ausência de dependência. Se precisar de migration, alteração de grant ou mudança de superclass/namespace, parar e abrir decisão própria; não esconder isso numa fatia de parser.

Rollback de deployment é apenas desenho futuro: nenhum merge/deploy está autorizado. Produção permanece congelada até nova autorização do operador para ambiente e release nomeados.

## 11. Custos e riscos de decisão

- Engenharia: 10–17 dias na fatia inicial, mais spike SDK opcional 1–2 dias; migração de superclass é orçamento separado, dependente de compatibilidade comprovada.
- POC futura A–D: teto condicional até 1.160 chamadas e US$20 propostos, conforme caps/stop da SPEC §7; confirmar preço e autorização antes de qualquer egress. Não houve gasto de modelo nesta auditoria.
- Operação: custo atual/alternativo por turno e p50/p95 **não medidos**. Usar tokens faturáveis, chamadas reais, falhas e tarefa concluída, não `chars/4` como fatura. Complexidade estática medida: Agent 5.052 linhas, orquestrador 8.485, cliente 1.759; não converter LOC em desempenho ou economia monetária.
- Riscos: widening silencioso de capability; resposta estruturada com alvo incorreto; concorrência de transcript; perda de privacidade por broadcast; rollback que abandona variante persistida; confundir fixture com prova E2E. Mitigações: registry fechado, resolver autoritativo, teste por janela/canal, compatibilidade persistida e promoção por fatia.
- Rejeitar alternativa LLM ou Agent base é resultado válido se gates não demonstrarem benefício. Não criar trabalho apenas para justificar o experimento.

## 12. Revisões e verificação da auditoria original 313f999 (histórico)

- Revisão de segurança independente dos documentos de auditoria/SPEC/plano da revisão `313f999`: **APPROVED** naquela revisão; não examina os deltas da branch atual nem significa aprovação atual. Confirmou import efetivo do SDK, bloqueio non-RPC, persistência compartilhada e condições de autorização V5; sem testes runtime.
- Revisão independente de qualidade dos três documentos: **APPROVED**, leitura integral e amostragem de fontes. Revisão posterior da matriz/consistência cruzada encontrou dois MEDIUM: consumidores UI/E2E atribuídos incorretamente a recorrência/templates e 12 CAPs planned sem destino individual. Ambos corrigidos; rechecagem restrita terminou **APPROVED**, nenhum achado material remanescente.
- Correções posteriores de caminhos de teste no relatório são documentais; não alteram a recomendação de segurança ou os contratos.
- Verificação/revisão da matriz e nomes de testes registradas na auditoria original: evidência histórica somente; não atesta conteúdo da matriz atual nem cobertura integral por operação.
- Nenhuma evidência de revisão ou gate autoriza refatoração, consumo de modelo pago, merge ou deploy.

### 12.1 Gates de baseline executados pelo tester independente

| Comando | Resultado observado | Limite |
| --- | --- | --- |
| `pnpm test` | Exit 0: contratos 25; API 2.861; Agent 3.369; broker 34; PWA 2.832 testes aprovados | API 172 skips e Agent 1 skip; não é prova PostgreSQL opt-in ou jornada E2E |
| `pnpm typecheck` | PASS nos cinco workspaces | Tipos/shims não provam protocolo SDK runtime |
| `pnpm docs:lint` | PASS, 17 documentos, zero problemas | Lista fixa; novos quatro documentos verificados separadamente |
| `pnpm governance:check` | PASS | Não significa autorização de alteração de contrato ou release |
| `pnpm lint` | **INCONCLUSIVO**: timeout após 10 minutos no primeiro pacote | Nenhum resultado PASS local; Biome não produziu saída útil |
| `pnpm --filter @pi-finance/llm-contracts lint` | **INCONCLUSIVO**: repetição focal excedeu 3 minutos | Não houve terceira tentativa, correção de código ou atualização para contornar o gate |

Tester conferiu apenas presença de envs: conexões de teste e chaves de providers ausentes; não expôs valores nem executou migrations/serviços/integrações/E2E. Warnings não fatais: sourcemaps ausentes, navegação PWA não implementada em ambiente de teste e Node `DEP0190`. A evidência local é parcial; **não declarar todos os gates verdes nem integração pronta**. Lint correspondente passou no CI do SHA base, mas isso não transforma o timeout local em PASS. Revalidar lint em ambiente funcional antes de aceitar uma implementação futura.

### 12.2 Veredito e próximo passo da auditoria original (histórico)

O resultado acima se referia à auditoria original em `313f999`, não à branch/revisão atual.

Arquitetura recomendada: preservar API/executor/V2 e AIChatAgent; consolidar interpretação/adapters incrementalmente. Escolha A/B de inferência **pendente da POC definida**, não de mais rodadas de revisão documental. O pacote permite preparar essa prova sob nova autorização; não autoriza refatoração ampla, autoexecução ampliada ou release. A jornada atual permanece não homologada, sem ocultar a indisponibilidade local nem extrapolar o canário description-only histórico.

Participação material observada: Coder da matriz, especialista do core, Architect, pesquisa SDK, Explorer documental, Tester e Reviewer/Security Reviewer; workers do pool Muse foram chamados com Luna conforme pedido. O Coder Luna atingiu limite no encerramento; conteúdo preservado, integração/correções finais feitas pelo Planner e rechecadas pelo Reviewer. Não houve substituição silenciosa de modelo.

### 12.3 Validação desta revisão documental

- Estado observado: branch `docs/ted-core-recovery-refinement`; base `origin/main` `b21faff`; cherry-pick documental `9de7f20` originado de `ede7b10`; refinamento `0d644c5` publicado em `origin`. A branch original OpenNext foi preservada. Apenas os quatro documentos autorizados diferem da main; não há alterações incidentais de aplicação, dependência, lockfile ou infraestrutura. A publicação documental foi explicitamente autorizada no pedido atual; a proibição histórica de push em §1 não rege este pedido. Sem POC, chamadas de modelo do produto, jornada API/PG real, produção, merge ou deploy.
- Revisão independente final única, com fechamento dos achados na mesma sessão: **APPROVED**. Foram corrigidos o denominador por operação, o alinhamento semântico das colunas e a separação de evidências históricas/atuais. A aprovação cobre somente documentação, não homologa o produto nem autoriza execução da POC ou release.
- [x] Cada linha: frase NL ou UI-only/Sem NL explícito; célula PWA→API separada; status separado da classe; operações independentes desagrupadas.
- [x] Contagem e formato da tabela verificados: 127 operações, 9 colunas e classe válida em cada linha.
- [x] Anchor SPEC atualizado e itens de paridade/POC removidos do checklist histórico `313f999` para o bloco atual.
- [x] Targets UX quantitativos registrados como propostas não medidas.
- `lintMarkdownDocument` nos quatro arquivos e checagem de links/âncoras — 0 issues; script Node inline células/classes — 127 linhas, 0 falhas (88 obrigatórias, 19 exceções, 17 internas, 3 fora do produto atual); `git diff --check` — PASS. As falhas iniciais dos scripts auxiliares foram de quoting/encoding PowerShell, corrigidas por stdin e matching sem acentos; não foram falhas dos documentos.
- Pre-commit executado sem bypass no refinamento: `docs:lint`, `action-pins:check`, `workflows-yaml:check`, `test:skip-gate`, `capabilities:check`, `write-policy:check`, `governance:check`, `boundary:check`, `public-safety --strict`: todos PASS. Gate de orquestração pós-execução: COMPLIANT, com participação material de Coder Luna, Tester Luna e Reviewer independente.

#### Resultado final do tester independente — checkout `63801e61e34f3778cc92d6db081718c921cd43d4`

| Verificação executada | Resultado observado | Limitação |
| --- | --- | --- |
| `pnpm docs:lint` | PASS: 17 documentos, 0 issues | Lista fixa; os quatro arquivos deste pacote também foram verificados explicitamente |
| `pnpm typecheck` | PASS: cinco workspaces | Não comprova comportamento runtime do SDK |
| `pnpm test` | PASS: 9.121 testes aprovados, 173 skipped | API: 172 skips e 12 arquivos skipped; Agent: 1 skip. Sem integração PostgreSQL |
| `pnpm governance:check` | PASS | Não autoriza mudança de contrato ou release |
| `pnpm lint` | INCONCLUSIVO: timeout após 10 minutos no lint de `llm-contracts` | Não há resultado final; não declarar PASS nem contornar o gate |
| Lint explícito, links locais/âncoras e tabelas dos quatro documentos | PASS | Verificação documental, não paridade funcional |
| Matriz canônica | 127 linhas, nove campos preenchidos e classes válidas; metas individualizadas | O dispatch inicial do tester ainda exigia 111 e produziu FAIL nessa comparação obsoleta; o denominador correto deste checkout é 127 |
| `git diff --check` e escopo contra `origin/main` | PASS: árvore limpa e somente os quatro documentos autorizados | Observação no SHA acima, anterior apenas ao acréscimo deste registro de resultados |

O tester retornou **FAIL** agregado por contagem esperada obsoleta e lint inconclusivo. A divergência 111→127 é do contrato inicial de validação, não defeito do produto ou falha da matriz atual; o resultado original permanece registrado, sem convertê-lo em PASS global. Os commits documentais intermediários explicam a diferença entre `0d644c5` informado no steering e `63801e6` efetivamente examinado. Nenhuma regressão foi observada nos testes executados; build, integração PostgreSQL, E2E, POC e produto em produção não foram validados. Não houve chamadas pagas do produto, serviços ou migrations. A revisão documental está encerrada; o aceite de todos os gates permanece pendente de execução conclusiva de `pnpm lint` em ambiente funcional, sem ampliar esta missão para corrigir tooling ou aplicação.
