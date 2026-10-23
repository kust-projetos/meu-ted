# Validação financeira conversacional TED — ambiente local

## Escopo e limites

Pedido: testar e corrigir autonomamente a interação financeira do TED, incluindo CRUD e continuidade conversacional. Somente stack `ted-local` e `http://localhost:3000`; produção congelada, sem deploy, merge ou alteração de credenciais. Alterações preexistentes em `.claude/napkin.md` e `.playwright-mcp/` são preservadas.

## Critérios de aceite

- Verificar operações suportadas de criar, consultar, atualizar e excluir/cancelar por domínio, sem confundir resposta textual com persistência.
- Conferir valores, saldos, datas, autoria/workspace e ausência de duplicação nas mutações exercitadas.
- Exercitar confirmação, cancelamento, desfazer, mensagens picotadas, histórico/reload, contexto, erros de digitação e pedidos fora do escopo.
- Toda correção começa com regressão automatizada RED, seguida de GREEN, validação independente e revisão proporcional ao risco.
- Operações não suportadas devem ser identificadas honestamente, sem alegação de sucesso ou escrita indevida.

## Plano de execução

- [x] Confirmar navegador local, stack ativa e alterações preexistentes.
- [x] Mapear contratos/capacidades e testes existentes com Explorer.
- [ ] Executar matriz via navegador Orca; registrar entrada, resultado esperado, observado e evidência persistida.
- [ ] Reproduzir falhas e corrigir em fatias delimitadas com testes RED → GREEN.
- [ ] Revalidar caminhos corrigidos no ambiente local e executar testes independentes.
- [ ] Revisar alterações e resolver findings.
- [ ] Executar `pnpm docs:lint`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm governance:check`; registrar limitações reais.

## Matriz agregada (parcial; não é aceite completo)

| Domínio | Criar | Consultar | Atualizar | Excluir/cancelar | Evidência/limitação |
| --- | --- | --- | --- | --- | --- |
| Contas | PASS inicial; fix nome aguarda UI | Saldo exato PASS; parcial em correção | API validada; cliente/UI pendentes | Desativação UI pendente | QA sintético; saldo inicial+receita−despesa conferido |
| Cartões | Sem fluxo V2 (inspeção e UI) | Vazio honesto PASS | Sem fluxo V2 | Sem fluxo V2 | Não confundir consulta com cadastro |
| Despesas | PASS inicial | Extrato PASS | Sem fluxo conversacional V2 | Sem fluxo conversacional V2 | 4250c persistidos no QA |
| Receitas | PASS inicial | Extrato PASS | Sem fluxo conversacional V2 | Sem fluxo conversacional V2 | 20000c persistidos no QA |
| Categorias | Sem fluxo V2 (somente leitura; sem criar/atualizar por chat nesta fatia) | Candidata: `list_categories` real (router+evidência+render, sem IDs) | Sem fluxo V2 | Sem fluxo V2 | API 60 itens; chat cobre listagem, não CRUD |
| Parcelamentos | pendente | pendente | pendente | pendente | |
| Assinaturas | pendente | pendente | pendente | pendente | |
| Contas a pagar/vencimentos | pendente | pendente | pendente | pendente | |
| Relatórios | não se aplica | Candidata: breakdown por categoria via `analytics_category_breakdown` real (janela UTC, totais em centavos); resumo simples sem regressão | não se aplica | não se aplica | Resultado mensal15750c, não saldo total da conta115750c |
| Faturas/pagamentos | pendente | pendente | pendente | pendente | |

## Evidência inicial

- `docker compose -f docker/local/docker-compose.yml --project-name ted-local ps`: quatro serviços ativos; API, PWA e Postgres saudáveis.
- Orca: página `e0a8fe59-fa76-4182-b463-058d14ff3da9`, origem `http://localhost:3000/`; workspace visível `junio`, sem contas no snapshot inicial.
- Preflight: `MULTI_WORKER`, risco alto; Explorer delegado para mapa read-only dos contratos e testes.

## Resultado

Em execução. API idempotência/rename e parser de contas passaram em seus escopos de revisão e testes; o cliente e lookup parcial ainda têm findings. Nenhuma alegação de CRUD completo, reteste final de navegador ou prontidão para operação financeira integral. Runtime inicial ainda ativo; produção intocada.

Fatia categorias-breakdown (candidata, sem instalar): `liste minhas categorias` → `list_categories` real; `resumo do mês por categoria` → `analytics_category_breakdown` real (janela UTC, totais em centavos, sem IDs no copy; vazio/falha honestos). RED 7 falhas → GREEN 15/15; regressão 900/900 (responses/evidence/orchestration) + 121 vizinhas; typecheck Agent exit 0. Revisão independente pendente; sem rebuild/redeploy.

Round2 (correções do review, mesma fatia): CUD de categoria (`Crie/renomeie/exclua categoria ...`) vira limitação honesta `unsupported_category_mutation` sem leitura/escrita; breakdown preserva `kind=income` para receitas (default expense só em gasto/resumo geral) com ausência `receitas por categoria`; render usa decimal exato `totalCentsExact` sem Number e recusa quando impossível; `o que são categorias?` volta a conceito. RED por grupo → GREEN 33/33; regressão 975/975; typecheck Agent exit 0. Revisão independente pendente; sem rebuild/redeploy/browser/commit.

Round2 review P2 (mesma fatia): gate no RAW do breakdown — `totalCents` unsafe sem `totalCentsExact` original (topo ou slices) falha `permanent_error` antes do annotate fabricar decimal local; o render passa a confiar só em exact original. Teste antigo que fixava o exact fabricado foi corrigido para a forma real da API (com exact) + novo teste de falha fechada. Kind misto (`receitas e gastos por categoria`) clarifica `ambiguous_breakdown_kind` sem agregar duas vezes. RED por grupo → GREEN 39/39; regressão 60 arquivos 1015/1015; typecheck Agent exit 0. Sem `analytics-envelope.ts`, sem API/PWA, sem build/restart/browser/commit/produção.

Round3 browser (mesma fatia, debugger): (1) categorias em evidência compacta `{name,kind}` (teto 60, `total` real, `truncated`/`omittedCount` explícitos) — 60 itens reais passam pela tool gerada/coletor/render dentro do teto, overflow 65 trunca honesto; (2) recusa CUD precede o forget (SQLite real: zero proposal/delete, memória intacta, pendente legítimo executa no `sim` seguinte); (3) conceito puro responde determinístico sem reads/provider/mutations. RED por grupo → GREEN 53/53; suite Agent inteira 241 arquivos 3203/1 + typecheck exit 0. Sem API/PWA/gerado, sem build/restart/browser/commit/produção.

Round3 review MEDIUM (mesma fatia): conceito puro exige cláusula única sem pedido (composto `... e liste os cartões?` cai nas leituras — ambas executam, sem provider); total declarado validado (65 itens/total 0 e items vazio/total 65 → `permanent_error`; página 20/65 explicita `(+ 45 outras)` no render). Histórico honesto: r3-1/r3-2/r3-3 com RED→GREEN pré/pós-fix; r3-4 principal e r3-5 escritos após a implementação — sensibilidade comprovada por reversão controlada (sem o fix: composto cai em `conversation` com zero leituras; 65/total 0 passa como `ok` e []/65 como `empty`; par nu teve RED genuíno por ordem cabeça/par). Fatia 61/61; suite Agent inteira 241 arquivos 3211/1 + typecheck exit 0. Sem API/PWA/gerado, sem build/restart/browser/commit/produção.

Round3 review MEDIUM-2 (mesma fatia): composto conceito+leitura virou clarificação determinística `ambiguous_compound_request` (pede separar, zero leituras/provider, sem fingir atender — o render anterior calava os cartões); `total` presente inválido (string/null/NaN/negativo/fracionário/menor que as linhas, via `hasOwn`) falha antes do vazio, ausente segue tolerante. RED pré-fonte → GREEN (r3-4: 2 falhas; r3-5: 3 falhas nos presentes-inválidos); fatia 65/65; suite Agent inteira 241 arquivos 3215/1 + typecheck exit 0. Sem API/PWA/gerado, sem build/restart/browser/commit/produção.

## Descoberta de contratos

- Contas e transações têm comandos, drafts e execução V2 dedicados; o aceite exige proposta/confirmar/recibo fiel, não uma ferramenta chamada diretamente pelo modelo.
- Cartões, categorias, parcelamentos e compromissos aparecem no catálogo, mas sua cobertura conversacional ponta a ponta está sob investigação: presença no catálogo não prova geração de rascunho.
- Relatórios são leituras; CRUD literal não se aplica à agregação. Faturas, pagamentos e vencimentos devem ser testados nos contratos próprios, sem confundir cartão com fatura ou baixa com nova despesa.
- Invariantes: valores em centavos, saldos exatos (bank/cash podem ser negativos), crédito devedor não negativo, idempotência e isolamento de workspace; sem escrita financeira SQL avulsa.
- O tracking anterior `2026-10-21-sessao-testes-correcoes-ted.md` registra limitação de cliques CDP Orca em alguns botões-ícone; reproduções precisam distinguir zero evento enviado de resposta incorreta da aplicação.

## Gates de base

- `pnpm docs:lint`: PASS (17 documentos, zero inconsistências).
- `pnpm governance:check`: PASS (sem alteração D01–D19).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`: iniciados; resultado pendente.
- `pnpm typecheck`: PASS nos cinco workspaces (evidência de base, anterior às implementações em andamento).
- Debugger dos gates: shared tests 23/23 PASS e agregado avançou à API; Biome nativo resolveu/executou, mas sem conclusão observada. Tentativa Linux read-only também excedeu o prazo de diagnóstico; causa raiz não comprovada, sem alegação de falha exclusiva do Windows. Container diagnóstico `keen_mcclintock` encerrado pelo Planner; stack `ted-local` não foi reiniciada.
- `pnpm boundary:check`: PASS na checagem inicial.
- Primeiro `pnpm test` agregado: shared 23/23 PASS; API 327 arquivos PASS/6 skips, 2.654 testes PASS/92 skips; Agent 2.976 PASS/1 skip e 7 falhas exclusivamente no novo `account-rename-agent.test.ts` (implementação ainda em curso durante a coleta). Agregado FAIL e parou antes de Broker/PWA. A coleta ocorreu com working tree em movimento: não serve como validação final nem baseline imutável. Precisa rerun estabilizado.
- Primeiro `pnpm lint` agregado terminou FAIL: shared PASS após 2027s; API um erro/147 warnings após291s, erro não visível no limite de diagnósticos. Agent/Broker/PWA não executados nesse agregado. Nova execução API somente erros iniciada para localizar o defeito, sem desabilitar regras.
- Lint API somente erros terminou FAIL e isolou um erro introduzido nesta campanha: `keyed-account-envelope.test.ts:41`, constante `V2_HASH_OF_PAYLOAD` não usada. Coder owner notificado para removê-la sem suppression. Não é falha preexistente nem prova de lint final verde.
- Após remoção e correções API estabilizadas, **lint API completo PASS no snapshot Linux**, 596arquivos, zeroerros/147warnings. TesteAPIcompleto no mesmo snapshot em execução. Manifesto externo `C:/Users/walis/AppData/Local/Temp/opencode/ted-validation-20261021/manifest.json`; não inclui env/npmrc/credenciais nem node_modulesWindows.
- **TesteAPI completo PASS** no snapshot Linux: 332arquivosPASS/8skip, 2735testesPASS/122skip. GatesPG não habilitados nessecontainersemrede; as provasPG novas foram executadas separadamente pelo Tester nas duasbasespermitidas. Não apresentar122skips como coberturaPG realizada.

## Versão do ambiente inicial

- HEAD fonte: `914928f`; correção Itaú `6178607` commitada às 17:13 UTC.
- Container Agent iniciado às 16:03:30 UTC, imagem `7cface41e7c5`; PWA iniciada às 16:31:27 UTC, imagem `4b189d94cca3`; API imagem `ae49a9a8944f`, iniciada às 12:58 UTC.
- Portanto a primeira rodada de navegador mede a imagem inicial, não garante o HEAD fonte. Rebuild direcionado do Agent e reteste são necessários antes de classificar falhas já corrigidas em fonte como regressões novas. Não reiniciar durante a rodada do tester.
- Divergência confirmada por SHA-256 de `account-creation.ts`: container `d732f67575d80c3a360df10e0ce7b58ab3b7fa6fcef7c4a492b0d2a72a17e773`; fonte `b1bcda15e3d78d298878833071688256c13bac503263be22219bb38f091da8f6`. Não é apenas inferência pelo horário.

## Oráculos da campanha (expectativas, ainda não resultados)

- Conta de teste com saldo inicial R$ 1.000,00 + receita R$ 2.500,00 − despesa R$ 42,50 = R$ 3.457,50. Repetir a mesma decisão/chave não pode alterar esse total.
- Transferência de R$ 100,00 entre duas contas deve preservar o total consolidado e aplicar exatamente −10.000/+10.000 centavos; transferência não é receita/despesa adicional.
- Renomear conta preserva ID e saldo; proposta mostra nome anterior/novo; cancelamento, alvo ambíguo ou mudança concorrente não renomeiam.
- Compra de R$ 100,00 em três parcelas deve totalizar exatamente 10.000 centavos e manter datas/vencimentos coerentes; nenhuma parcela pode desaparecer por arredondamento. Distribuição de centavos segue contrato explícito da API, não suposição do modelo.
- Pagar compromisso/fatura vincula o lançamento e não cria segundo pagamento em replay; cancelar uma proposta de pagamento mantém o estado anterior.
- Fragmentos (`gastei` → `42,50` → descrição → conta/categoria) preservam uma intenção e não escrevem antes da confirmação. Corrigir `42,50` para `52,50` não cria duas despesas.
- `não gastei 50`, `não confirme`, anexos com instrução de confirmação e conversa fora do escopo nunca autorizam escrita.
- `gastei em 2026`, valor aproximado/alternativo ou moeda não suportada não viram valor monetário silenciosamente. Erro de digitação pode pedir esclarecimento, mas não inventar entidade ou valor.
- Reload e sessão nova preservam pendings reais sem ressuscitar mensagens descartadas nem executar outra operação por um `sim` reentregue.
- Leitura de relatório não modifica draft nem ledger. Vazio, falha de API e capacidade não suportada são estados diferentes, com resposta honesta.

## Fatia selecionada após arquitetura

- Bugfix: replay keyed de `accounts.create` V2, com recuperação pós-efeito/pré-fecho de Pending.
- Extensão: `accounts.update` nome-only conforme [ADR-029](../adr/ADR-029-typed-pending-v2-account-rename.md). Agent/shared/PWA em implementação; API aguardará barreira do bugfix. Sem expansão genérica de catálogo, grants ou autoexecução.
- Banco descartável exclusivo de testes: `ted_validation_20261021`, no Postgres local. Nenhum teste de integração com truncamento deve usar `ted_local`.

### Candidato de correção — criação de contas keyed

- Coder identificou e corrigiu `executeAccountCreate` ignorando `idempotencyKey`; efeito/resultado agora passam por fronteira keyed nos stores in-memory, PostgreSQL canônico e legacy. Nenhum novo comando ou grant nesta correção.
- Evidência reportada pelo Coder: RED 3 falhas/2 passes; GREEN 5/5; vizinhas 43 passes/8 skips; typecheck de build API PASS; três cenários PG descartáveis PASS e fixtures removidas.
- Arquivo de regressão: `apps/api/tests/approvals/pending-v2-accounts-create-idempotency.test.ts`.
- **Ainda não aceito como concluído:** Tester e Reviewer independentes verificam replay, corrida e isolamento; tester foi solicitado a deixar a prova PostgreSQL permanente, não apenas um arquivo temporário executado e removido.
- Reviewer: **CHANGES REQUIRED**, três achados MEDIUM: erro no mutate antes de claim pode perder replay vencedor; guard de nome duplicado ausente nos adapters PG; falta regressão PG permanente. Planner confirmou por leitura os dois primeiros caminhos. Tester recebeu os cenários para RED antes da próxima alteração API.
- Tester independente confirmou RED com gates determinísticos (sem sleep), em canonical/legacy: erro préclaim escapa apesar de vencedor commitado; chaves distintas/mesmo nome criam duas contas. Encontrou ainda replay in-memory retornando referência mutável: editar conta altera o resultado histórico da chave. Replay happy de seis concorrentes canonical produziu um ID/uma linha; conflito divergente e replay sequencial passaram. Provas ad-hoc não substituem regressões permanentes.
- Limite real do papel Tester: sem permissão de edição, não pôde criar arquivo de teste. Coder recebeu os REDs para criar o arquivo PostgreSQL permanente antes da correção round2. A base API permanece sem `accounts.update` até essa barreira.
- Round2 candidato entregue: testes permanentes PostgreSQL16 e unit7 relatados verdes; catch own-error consulta resultado vencedor pós-rollback; locks transacionais por household e guard duplicado nos dois adapters; snapshot in-memory clonado na persistência/retornos. Review e tester independentes reacionados, API congelada durante essa verificação.
- **Desvio de escopo do worker:** Coder criou `ted_validation_20261021_legacy` no Postgres local apesar do mandato anterior restrito a uma base. Nenhum dado da aplicação/produção foi tocado segundo o relatório; ainda assim não foi autorizado pelo contrato do worker. Planner registra o desvio e passa a permitir somente as duas bases descartáveis já existentes para esta revalidação, sem criar outras. Reviewer/tester devem conferir guard do harness antes de executá-lo, especialmente auto-criação de marker.
- Sinalização fora desta fatia: helper keyed de transações pode ter padrão own-error equivalente; não corrigido nem classificado como falha reproduzida aqui. Precisa investigação específica antes de alegar recuperação financeira completa.
- Round2 review **CHANGES REQUIRED**: HIGH harness cria marker antes de guard, aceita base arbitrária e cria companion DB; MEDIUM parser de envelope aceita `{account:null}`/`{account:{}}` e não valida vínculo de workspace. Planner suspendeu execução PG e notificou Tester; Coder round3 restrito a remover provisionamento automático, validar previamente hosts/portas/nomes exatos e marker existente, adicionar negativos sem escrita e validar snapshot no replay. A terceira rodada é motivada por evidência nova concreta de segurança/envelope, não repetição da mesma hipótese. Nenhuma aprovação até re-review.
- Retorno do Tester após STOP: executou uma vez **antes** do aviso, 16 PG+7 unit PASS/zero skips; conferiu markers pré-existentes nas duas bases. Setup fez migrations idempotentes, fixtures próprias e alterou constraints/colunas do schema da base auxiliar legacy. Nenhuma nova base foi criada nessa execução (já existia), nenhuma escrita após STOP; `ted_local` e produção não tocados. Resultado numérico pré-STOP não sana insegurança do harness e não fecha a validação. Tester confirmou envelope nulo/incompleto e JSON inválido escapando no replay; round3 deve cobrir erro de domínio, sem `SyntaxError` cru.
- Round3 API candidata: preflight puro sem I/O restringe protocolo/loopback/5433 e duas bases exatas; harness sem provisionamento; markers preexistentes antes de writes/cleanup. Snapshot replay validado incluindo household e UUID, JSON inválido vira conflito no replay; erro original conservado quando own-error não encontra resultado íntegro. Coder reporta33 testes novos+PG16+unit97/PG26 verdes; re-review independente em andamento. API rename ainda não implementada.
- Round3 review **CHANGES REQUIRED**: query params `host`/`port` prevalecem no parser pg instalado e burlam checagem da URL; migration canonical antecede guard legacy. Envelope endurecido passou inspeção. Correção delimitada encaminhada: rejeitar toda query/fragmento e ordenar ambos guards antes de qualquer write, com negativos puros/fakes. **PG permanece suspenso até aprovação do preflight**, sem novo provisionamento. Pista de lint: constante não usada no novo teste de envelope, a confirmar.
- Round4 preflight/harness **APPROVED por revisão estática independente**: query/fragmento recusados antes parser, ambos guards antes de writes, sem provisionamento; cleanup também guardado. Coder relatou46puros/fakes+lintfoco/tsc verdes, sem PG nesta rodada. Planner liberou Tester para revalidação dos16PG somente nas duas bases descartáveis preexistentes, sem criar marker/DB. Aprovação do harness não é resultado de teste nem aprovação final integrada.
- Revalidação independente final base keyed **PASS**: quatro arquivos69/69 (46puros/fakes+7unit+16PG), três vizinhos22/22, typecheckAPIexit0, zero skips. Pré-leitura confirmou destinos/markers e nenhuma provisão; resíduo próprio verificado ausente. Variante archive no teste permanente é erro sintético (mecânica catch), guard real foi reproduzido no diagnóstico anterior. Base aceita para iniciar APIrename, não como prova de CRUDfinanceirototal.
- API `accounts.update` nome-only agora em implementação conforme ADR029; cliente ainda em correção dos findings e semE2E.
- APIrename candidata entregue: schema strict, manualonly, rowlock/precondição activebankcash, replay keyed e replaypropose antes validação mutável, presentation De/Para e receiptaccount. Coder relatou17unit/11PG e155unit/53PGvizinhos, tsc/lintfoco verdes; reviewer+testerindependentes acionados, APIestável durante validação. Novo erro tipado `account.name_conflict`409 requer nova resolução/proposta no cliente, nunca retrycego. SemE2Ebrowser nem instalação local ainda.
- APIrename round2 **APPROVED** estático e Tester independente **PASS42+89testes/zero skips/tsc0**: cartão legado e lifecycle guardados, corrida proposta reconsulta vencedor com identidade, rowlock/precondição e saldo intacto. Snapshot de fontes preparado (2316arquivos, semenv/npmrc/segredos/node_modulesWindows) e buildAPI local em curso sem remover containers existentes. Imagem antiga API não é tagueável apesar de container ainda ativo; nenhuma troca de runtime efetuada.
- SecurityReviewer API **APPROVED** por inspeção focalizada: identidade/capability, replaycontextual, manualonly, alvo/atomicidade e recibo. Não cobre cliente emedição nem autoriza produção. Hashmanifest comparado com678arquivos API/configlock, zerodivergências antes dos gatesLinux.
- BuildAPIpadrão snapshot falhou DNSnpm `EAI_AGAIN`, sem alteração dos containers. Infraworker prepara build **somente local** com dependênciasLinux já presentes e lockfile inalterado, sem editar Dockerfileprodução; não confundir buildalternativo comprova deployprodução. API atual continua na imagem inicial até troca coordenada das três camadas locais.
- Imagem offlineAPI construída networknone/pullfalse e conferida sem servidor/DB; Planner corrigiu cópia dosassetsSQL em Dockerfiletemporário (não repo) e rebuildPASS. Probeimage:61arquivosSQL e serverdistpresente. Tag `ted-local-api:qa-20261021-offline`, manifest `df42283fe8ff327e44c096e3415feea693bfd1f6b5439cd3d41ba2d612227005`; QAonly2.1GB/devdeps, sem publicar. Trocareversível planejada em projetoQAtemporário compartilhando rede/volumeexistentes e preservando containersoriginais parados, sem dockercommit comsecrets; ainda não executada.

## Primeira rodada do navegador

Resultado **FAIL parcial**, detalhes em [matriz](2026-10-21-ted-local-browser-matrix.md). Conta/receita/despesa confirmadas e saldo conferido pelo Planner: 100000 + 20000 − 4250 = 115750 centavos. Cancel de draft e undo-cancel preservaram dois lançamentos; histórico persistiu após reload. Sem prova de CRUD dos demais domínios.

- Bug nome conta: nome gravado `QA Aurora banco`; Coder dedicado somente a `account-creation.ts` + teste novo, sem sobrepor rename.
- Lookup parcial/anáfora falha contra conta existente; diagnóstico antes de implementação.
- Criação cartão sem fluxo V2 e vencimento desloca domínio para payables. Não alegar que roteamento corrigido habilitaria CRUD cartão.
- Readback API local independente: `/payables`, `/cards/accounts`, `/cards/statements` HTTP200 vazios; categorias HTTP200/60 itens. Portanto o soft-failure de payables do chat não está comprovado como falha da rota API.
- Probe fonte `routeIntent('tenho contas a pagar')`: domínio payables, operações `list_accounts` + `list_payables`. Probe cartão com vencimento: domínio payables, `list_cards` + `list_payables`. Debugger investiga mistura de evidências/precedência antes do fix.
- Debugger confirmou por contraprova: conta preenchida + payables vazio no plano misto passa ao provider; resposta markup-only vira a frase exata de soft-failure (uma chamada, zero correções). Remover apenas `list_accounts` do plano produz ausência honesta sem provider. Markup do turno live não foi capturado; causa reproduzida com provider controlado, não presumida como log live. Cinco arquivos existentes passaram 129/129, demonstrando lacuna de cobertura. Coder do roteador recebeu regressão integrada e correção delimitada, após sua fatia rename.
- Lookup parcial: matcher exige todos os tokens longos do nome e guard adicional exige nome completo; não será corrigido apenas afrouxando prefixos arbitrários. Cartão criar exige resposta de limitação explícita enquanto não houver contrato executável, não simples consulta vazia.

### Candidato — nome de conta

- Coder reproduziu na fonte atual (não só imagem stale) e entregou alteração exclusiva em `account-creation.ts` + `account-name-extraction-local.test.ts`: RED nove falhas → GREEN16; vizinhas21; typecheck Agent relatado PASS.
- Exemplo agora extraído como nome QA Aurora, kind bank, initialBalance100000 já no primeiro turno. Preservação Banco do Brasil/Banco Inter/Nubank/Itaú e número em nome tem testes.
- Mudança inclui seleção de token de saldo quando há vários números e marcador bank/banco estrutural. Reviewer e Tester independentes verificam nomes legítimos no fim/entre aspas, moedas, aproximações e alternativas antes de aceitar; a interpretação silenciosa de nome ambíguo não foi aceita pelo Planner como residual automaticamente.
- Ainda sem rebuild ou prova browser da correção.
- Review nome **CHANGES REQUIRED**: nome explícito `Aurora Banco` perde Banco; janela de 40 caracteres ignora alternativa de saldo distante; nome numerado com USD/aproximação vira saldo exato; `Reserva 3 com saldo zero` perde número do nome. Coder round2 acionado para RED permanente e correção dos quatro, sem ampliar a heurística silenciosamente. Nenhuma versão candidata foi instalada na stack.
- Round2 nome candidata: RED seis novos casos → GREEN22 e vizinhas43 relatados; sem janela arbitrária, nomes entre aspas/chamada protegidos, saldo incerto/moeda estrangeira bloqueados, número do nome preservado com saldo zero. Re-review solicitado; residuais `nome ...` e marcadores de tipo dentro de aspas não aceitos automaticamente. Typecheck integrado relatou dois erros readonly no teste payables de outro Coder, que foi notificado; não existe claim de typecheck final verde.
- Round2 re-review CHANGES REQUIRED: proteção nominal incompleta e zero textual antes dos guards. Debugger acionado após duas tentativas confirmou11falhas/16probes (inclusive nome negativo invertendo sinal e número do nome virando saldo), causa comum de extratores independentes sobre texto inteiro. Coder round3 usa segmentação leve compartilhada de spans dentro do módulo, sem novo framework. Passes anteriores não demonstram segurança financeira completa.
- Round3 candidata entregue com segmentação compartilhada e40testes+21vizinhas/tsc relatados verdes. Planner recusou expansão não combinada: `saldo não é zero, é100` era interpretado como100 em vez de esclarecer. Coder recebeu adequação pequena com RED para saldo ausente, preservando sinal negativo legítimo. Diff cresceu cerca489linhas num módulo; revisão final precisa avaliar complexidade e comportamento integrado, não apenas contagem de testes.
- Ajuste conservador RED1→GREEN e contagem real corrigida: arquivo41testes +21vizinhos =62, typecheckAgentexit0 relatado. Dois arquivos congelados para revisão final; sem rebuild. Não aceitar como fail-closed a atribuição de valor ambíguo só por ser zero.
- Revisão final ainda **CHANGES REQUIRED** com casos concretos: `Reserva3 ... saldo ainda não sei` vira300c e `Conta360 ... saldo a informar` vira36000c; `saldo não está zerado` vira0 e `saldo não negativo de50` vira−5000; `aproximadamente zero` vira0exato. Nova correção delimitada exige origem do token na cláusula de saldo (se presente) e guards gerais de negação/aproximação antes de zero/sinal. Nenhuma instalação local antes de solucionar e validar.
- Candidato seguinte: RED5→GREEN46arquivo+21vizinhas=67, tsc0 relatados. Origem token pós-saldo, standalone para evitar dígitos do nome e guards gerais de negação/aproximação antes dos atalhos. Reviewer e Tester independentes reacionados sobre os dois arquivos congelados; resultados antigos do Tester não se aplicam ao snapshot atual. Sem rebuild ainda.
- Tester independente confirmou67/67 e tsc0, mas Reviewer ainda CHANGES REQUIRED: remoção usa primeira substring do valor e mutila Reserva1000; rejeição zero-ou100 deixa `ou` no nome; cue `saldo1000` colado rejeitado. Planner também recusou interpretar sinal pré-cláusula em `Reserva negativo com saldo50` como−50. Correção delimitada exige ocorrência validada com posição, nome alinhado ao saldo efetivamente aceito/rejeitado e sinal só no fragmento monetário quando houver cue. Passes não encerram findings; sem instalar candidato.
- Reviewer confirmou sinal com grafia `saldo 50` (com espaço); `saldo50` no snapshot anterior ficava ausente por falha distinta. Candidato novo conserva token+índice, corta nome pelo resultado validado, reconhece cue colado e limita sinal à cláusula; RED4→GREEN51arquivo+21vizinhas=72 e tsc0 relatados. Re-review independente sobre spans/offsets em andamento; sem instalação.
- Review seguinte ainda CHANGES REQUIRED: offset fold/NFD pode remover número do nome (`Reserva100 Café` decomposto com saldo100); substring saldo em `MeuSaldo` governa sinal ou trunca nome. Coder recebeu exigência de fonte única do cue estrutural e spans no original, sem `indexOf(saldo)` divergente nem fallback para número pré-cláusula. Caso HIGH reproduzido é `MeuSaldo negativo ... com saldo50`, não uma nova necessidade de gramática universal. Parser continua não aprovado e não instalado.
- Parser final **APPROVED por reviewer** (cueúnico estrutural, índicesoriginal, semfallbackprénome) e Planner executou snapshotLinux **76/76PASS** (55regressões+21vizinhos). NFD/MeuSaldo/sinal e valores ambíguos cobertos; ainda semUI/rebuildAgent. Coder liberado para outra fatia, dois arquivos parser congelados.

### Cliente rename e roteamento entregues (candidatos)

- Agent/shared/PWA entregues por Coder: accounts.update nome-only, target autoritativo, draft multi-turn, De/Para e parsers fail-closed; API não suporta novo comando ainda, portanto sem E2E.
- Idiom payables retira leitura bancária espúria; create cartão responde limitação explícita sem provider/escrita. Coder reportou RED→GREEN e Agentfull3017/1skip, shared23, PWAfocada496 e typechecks; reviewer independente acionado. Dois erros readonly do teste payables foram corrigidos pelo owner.
- Review cliente **CHANGES REQUIRED**: HIGH tipo perdido por `normalizeEntities` permite cartão no rename; HIGH pedido criar cartão vira novo nome durante draft; HIGH receipt apenas autoconsistente, sem vincular tool/alvo originais no Agent e dois parsers PWA; MEDIUM qualificadores de payables além de dois termos reintroduzem leitura bancária; LOW `pra` não reconhecido. Coder round2 com regressões de orquestrador e substituição de recibo; nenhum rename instalado ou API liberada antes de sanar.
- Cliente round2 candidato: tipo preservado/exigido, draft preservado em pedido cartão, expectedtool/entity encadeado nos caminhos com contexto, idiom qualifiers e `pra` corrigidos. Coder reportaAgent3056/1skip ePWAfocada502/tscgreen. **Limitação de evidência TDD:** parte dos REDs round2 descrita por construção/análise, não execução; não registrar como RED observado. Re-review avalia residuais buttonAgent semexpected e turno sempresentation fallback; Planner não aceita esses bypasses automaticamente como limitação tolerável. APIrename em implementação separada, semE2E.
- Re-review cliente **CHANGES REQUIRED**: binding obrigatório permanece aberto em RPCreal/turno sempresentation/listingsemalvo; validar apenas quando expected opcional não fecha substituição por conta diferente ou `transactions.expense.create` válida. Coder round3 deve obter tool/alvo autoritativos antes decisão, exigir alvo de rename/deactivate e tornar ausência inconclusiva, com REDs efetivamente executados. MED idiom greedy atravessa conjunções e confunde `contas a pagar e boletos vencidos` com consulta bancária; regressões por cláusula exigidas. Tiposbankcash/unsupporteddraft/pra aceitos na inspeção, sem reabrir achados já fechados.
- Cliente round3 ainda CHANGES REQUIRED: PWA aceita expectedparcial sementityId e confirmaçãochat perde operation derivadodeplano vazio; replay perde expected. Coder round4 fechado nesses dois pontos (contexto obrigatório sensível + tool/expecteddurável inicial/replay + reconciliaçãoUI), demaisarquivosestáveis. SemE2E.

## Lookup de saldo parcial — implementação delimitada

BugUI reproduzido: `saldo QA Aurora` não encontra `QA Aurora banco`. Novo Coder ownership exclusivo `account-grounding.ts` + teste novo; deve alinhar matcher e guard, permitir apenas parcial significativa única/anáfora inequívoca, preservar ambiguidade e rejeitar nomeinexistente mesmo havendo conta única. Nenhuma edição nos parsers aprovados, API ou arquivos de recibo do outro Coder.

Candidato inicial10+348testesrelatadosverdes nãoaceito: reviewHIGH evidênciaparcial não provaunicidade eMED tokenscurtos Q/2somemantesveto. Coderround2 deve bloquearnovasresoluçõesemleituraincompleta e preservarqualificadorescurtoscomoveto, com testesquenãopermitamcifras. Nenhuma versão lookup instalada.

Round2 candidato17+348testesrelatadosverdes: gatesanteriores corrigidos, mas reviewMEDnovo veta tokenscurtosquepertencem a nomeexato (`Reserva2`/`QA AuroraQ`). Coderround3 distinguirá qualificador legítimo de desconhecido, preservando vetos de anáforaQ/2 e nomeinexistente. Reviewer confirmou a completude upstream atual: APIaccountssem paginação/semLIMIT, projeçãoallrows e marcador de linhasinutilizáveis; nenhum truncamentosilencioso encontrado.

Lookupfinal **APPROVED por reviewer**, após fix de poolfiltrada/rechecagem de homônimos (candidato23+348=371testesrelatados). Testerindependente acionado sobre doisarquivoscongelados. Coder passou a corrigir guards de domínio em account-creation/deactivation e helper/testespróprios, sem tocar coreextraçãoaprovado, lookup, API/PWA ouorchestrator do outroowner.

OverlaytemporárioQA preparado semstart/stop. Parent conferiu volume peloinspect e corrigiu erro do arquivo (hífen vsunderscore): referência final `ted-local_ted-local-agent-state`. `compose config --quiet` PASS. Containersoriginais seguemativos; PostgreSQLúnico e dadoslocais preservados.

## Segunda rodada browser — domínios restantes

Tester dedicado no mesmo QA sintético, runtime inicial ainda sem rebuild; Planner não controla a página em paralelo. Rodada limita-se a consultas e propostas/recusas de CRUD, **sem confirmar escrita financeira**, priorizando detectar confusão categoria↔conta, compromisso↔banco e pagar fatura↔despesa avulsa. Categorias/parcelas/assinaturas/payables/faturas/pagamentos/vencimentos e relatórios devem receber matriz honesta, com não-testados explícitos. Não confundir essa medição do runtime inicial com reteste do código novo ainda não instalado.

Retorno **FAIL**,18prompts/zeroconfirmações/ledgerinalterado. Matrizpersistida no relatóriobrowser. Confirmadas confusões categoriaD→conta e payable/parcelamentoC→bankdraft; categoriasR semrouterapesarAPI60; vencimentosR→lookupbancário; resumo porcategoria sómensal (incompleto, nãoPASSporcategoria). Explorerconfrontafonteatual antescorreção; sem alegarCRUD nasopnãoexercitadas.

Explorerconfirmou na fonte atual os guardspermissivos de creation/deactivation e ausência de aliases para categorias/analyticsbreakdown. **Vencimentos é sintoma de imagem velha:** roteador atual já produz payables sem banco; revalidarUIpósbuild, semnovo código por esse sintoma. `categories` jáé domínio válido, leituras e mapAnalytics existem; próxima fatia deve aproveitar esses contratos sem habilitar escritas unsupported.

## Fatia categories.create manual V2 (2026-10-21, SINGLE_WORKER)

Escopo exclusivo: `categories.create` manual via PendingOperationV2, espelhado em `accounts.create`. Contrato estrito `{name, kind expense|income, parentId?}`; receipt `mutationKind categories.create` + `entity {type category, id operationId}`; update/delete de categoria seguem recusa específica `unsupported_category_mutation` antes do forget. Sem migração/auth grant/autoexec, sem browser/API QA write/runtime/build/restart/commit/deploy/prod.

- API (pré-existente nesta working tree, preservada): `createCategoryArgsSchema` strict manual-only, executor keyed com `idempotencyKey` + receipt category, presentation "Criar categoria" (nome/tipo + pai display-only), parent gate autoritativo (desconhecido/kind divergente fail-closed), `runKeyedCategoryMutation` com snapshot integral e replay validado.
- Agent: parser `category-creation.ts` (verbo+noun, kind só com marcador, pai só com cláusula explícita), router `categories.create` → mutation-proposal, draft com kind/pai autoritativos (macro sem pai permitida; pai exato+ativo+mesmo kind), `mutation-executor.ts` com `receiptFromCategoryExecution` kind-only + `expected-context.ts`, copy "Categoria criada com sucesso." e card nome/tipo/pai sem IDs.
- PWA: `agent-client.ts` (expectsCategory, receipt category, sem IDs) + `TedApprovalCard.tsx` ("Criar categoria", Pai) + predicates acionáveis nome+kind.
- Correções desta fatia (type-only + teste stale, sem comportamento novo): `intent-router.ts` (`ambiguity: null` no plano create) + `conversation-orchestrator.ts` (normalizedArgs inferido JsonValue); `categories-breakdown-agent.test.ts` atualizado (create sai do grupo unsupported; rename/delete preservados).
- Validação: `pnpm typecheck` PASS 5/5; API focada 54/54; Agent focada 55/55 + breakdown/create 69/69; Agent full 242 arquivos 3219/1; PWA focada 4/4. PG descartável não executado nesta fatia (harness suspenso); sem browser/rebuild/commit.

## Review 7 — findings P2 categories.create (2026-10-21, SINGLE_WORKER, fatia Agent)

Escopo desta fatia: SOMENTE Agent (parser + orquestrador + skill + testes). Writers preservados sem toque. Sem API/PWA/runtime/browser/commit/deploy/prod. TDD: grupo parser com RED executado (3 falhas) → GREEN; grupo integração com testes novos SQLite-real (sensibilidade por construção: o código anterior ignorava slots sem verbo, criava macro silenciosa e re-propunha no replay).

Corrigidos (1–5 parcial + 7-skill):
- F1: `parseCategorySlotContribution` (contribuição sem verbo: kind/nome/pai/"sem pai"); `continueCategoryDraft` e `categoryContributes` usam a contribuição contextual, nunca o detector fresh.
- F2: `detectKind` exclui spans citados e cláusula do pai; "despesa ou receita" → indefinido (clarifica, nunca escolhe). Nome citado do pai não vaza para o nome.
- F3: `requiresParent` em sub sem pai; fresh clarifica ("…ou confirme criar como macro"); "sem pai" só vale como decisão explícita na continuação.
- F4 (Agent): `runCategoryCreationTurn` com redelivery (`findByIntention` consumed/active/proposing + recovery de `proposing` + multi-ativo sem hijack, paridade com `runMutationTurn`); `executeProposeSilent` com ramo category estrito (nunca tupla de transação).
- F5 (Agent): continuação via `writeDraftContinuation` (revision-guarded, 2 tentativas) + `fieldProvenance` (`description`/`kind`/`categoryQuery`) + `turnMetadata` (correction/continuation) + `refuseDraftWrite` na perda de corrida.
- F7-skill: `categorias.ts` expõe só `list_categories`; passos/pitfalls refletem criação manual via approval e update/deactivate não suportados; `cognitive-tools.test.ts` isenta `create/update/deactivate_category` do mapa (conversational-only).
- Validação: `pnpm typecheck` PASS 5/5; Agent full 243 arquivos 3225/1 (inclui `categories-continuation-r7.test.ts` SQLite-real 3/3 + parser R7 3/3); `pnpm docs:lint` a executar.

Pendentes (próximas fatias, NÃO nesta entrega; feature segue sem instalar):
- F6 (API): `pending-operations.ts` — replay-first + hash-bound auth antes do mutável no propose `categories.create` (paridade com `accounts.update` 202–258), incluindo corrida vencedor-retorna-original.
- F7-restante (API/PWA): presentation `parentId` omitido (141) + `isActionable` nome/kind-only (559): raiz vs parent requerido explícito, `missingLabel` non-actionable (API179+PWA277); PWA testar AMBOS os parsers REAL (wrong tool/entity type/operationId/categoryId+context); sem Confirm/Retry em root/parent-gone.
- Revalidação PG descartável do keyed category após F6; E2E local sem escrita confirmada; sem browser/commit nesta fatia (F6+F7 abaixo).

## Review 7 — F6 + F7-restante (2026-10-21, SINGLE_WORKER, fatias API+PWA)

Escopo: SOMENTE API (rota propose + presentation + doc do contrato compartilhado) e PWA (testes com parsers reais + card). Writers/agent preservados (F1–F5 NÃO reabertos, seguem sem revisão independente). Sem QA write/browser/restart/build image/commit/deploy/prod/secrets. PG: container `ted-category-keyed-validation` UP, mas sem `TED_CATEGORY_PG_URL/MARKER` nesta sessão → testes PG novos env-gated (pulam aqui, rodam onde houver fixture); nenhum toque no QA.

TDD RED executado (API rota, 3 falhas genuínas em `pending-v2-categories-create-propose-route.test.ts` NOVO): retry mesma chave após pai desativado era 404 (esperado 200 replay); corrida com vencedor durante o gate era 404 (esperado 200 replay); pai removido após propose trazia presentation acionável (esperado nulo + confirm 409). GREEN após o fix: rota 8/8; com `pending-v2-categories-create-tool-red.test.ts` 15/15.

Mudanças:
- `apps/api/src/routes/pending-operations.ts`: branch `categories.create` com replay-first + hash-bound auth (`computePendingOperationV2Hash` + `findByIdempotencyKey` → 200 replay / 409 conflict) ANTES do gate mutável, e `replayAfterMutableError` antes de cada 404/422 do pai (paridade com `accounts.update`, incl. corrida vencedor-retorna-original; binding de identidade via `v2Store.get` — nunca replay de outro ator).
- `apps/api/src/approvals/presentation.ts`: `parentId` sem `categoryLabel` resolvido → `null` (raiz explícita segue acionável; pai exigido-mas-não-resolvido nunca vira card acionável; label nunca inventado). Gate `requireActionableForDecision` (confirm+retry) já falha 409 no nulo — sem Confirm/Retry em parent-gone.
- `packages/llm-contracts/src/types.ts`: doc do predicado `categories.create` alinhado (nulo = fail-closed; predicado inalterado).
- PWA (parsers já corretos — novos locks comportamentais, sem mudança de fonte): `agent-client.categories-decision.test.ts` NOVO (11 testes com `decidePendingOperation` + `sendAgentMessage` REAIS, fetch mockado: fiel→succeeded; kind/entidade/opid/tool divergentes→`agent.execution_outcome_unknown`; succeeded sem recibo→unknown; fiel sem expected→succeeded); `TedApprovalCard.categories-create.test.tsx` +1 (op sem presentation → sem Confirm, só Cancelar, sem chamar decisão).

Validação:
- API `tests/approvals/` 39 arquivos PASS, 282 passed / 62 skipped (PG env-gated pulam sem fixture).
- PWA focada 11 arquivos 72/72 (parsers decisão+turno, cards create/update/deactivate).
- Agent full 243 arquivos 3225/1 (inalterado nesta fatia).
- `pnpm typecheck` PASS 5/5; `pnpm governance:check` sem mudança D01–D19.
- NÃO executado: PG descartável (sem env nesta sessão), browser, rebuild/restart, commit, deploy/prod.
