# Plano incremental de recuperação do núcleo conversacional TED

**Registro histórico da auditoria original:** 2026-10-24, checkout `313f999` em `fix/opennext-preview-props`; seu status, gates, reviews e evidências abaixo são históricos, não validação desta branch. **Status atual deste refinamento:** alteração documental em `docs/ted-core-recovery-refinement`, checkout `9de7f20` transportado sobre `origin/main` `b21faff`; alterações não commitadas, reviewer final reportou CHANGES REQUIRED antes destas correções. Implementação, POC e integração não executadas.

**Refinamento:** documentação nesta branch `docs/ted-core-recovery-refinement`, HEAD `9de7f20`, transportada apenas com docs sobre `origin/main` `b21faff` (proveniência de origem reportada `ede7b10`). Os relatos/checks anteriores permanecem evidência histórica e não são reexecução deste refinamento.

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

- Estado de edição observado: branch `docs/ted-core-recovery-refinement`; base `origin/main` `b21faff`; HEAD de entrada `9de7f20`. Apenas os quatro documentos autorizados foram alterados; nenhum commit foi feito. Não houve produto/E2E/POC, chamada LLM, API/PG, produção, merge ou deploy.
- Revisão independente final única, com fechamento dos achados na mesma sessão: **APPROVED**. Foram corrigidos o denominador por operação, o alinhamento semântico das colunas e a separação de evidências históricas/atuais. A aprovação cobre somente documentação, não homologa o produto nem autoriza execução da POC ou release.
- [x] Cada linha: frase NL ou UI-only/Sem NL explícito; célula PWA→API separada; status separado da classe; operações independentes desagrupadas.
- [x] Contagem e formato da tabela verificados: 127 operações, 9 colunas e classe válida em cada linha.
- [x] Anchor SPEC atualizado e itens de paridade/POC removidos do checklist histórico `313f999` para o bloco atual.
- [x] Targets UX quantitativos registrados como propostas não medidas.
- `lintMarkdownDocument` nos quatro arquivos — 0 issues cada; script Node inline semântica/células/classes — 127 linhas, 0 falhas; `git diff --check` — PASS. Nenhum teste de produto/POC/E2E/API/PG/produção, merge, deploy ou commit.
