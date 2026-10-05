# Meu TED — SPEC: refinamento do agente inteligente V1

**Status:** proposta técnica revisada; implementação e rollout não autorizados por este documento.\
**Data:** 2026-10-03.\
**Baseline local:** `ec088ab9caf158db22f7e487b7c82143cf693842` + working tree descrito abaixo.\
**Plano:** [PLAN V1](MEU-TED-PLANO-AGENTE-INTELIGENTE-V1.md).\
**Análise crítica e evidências:** [AUTOREVIEW](reports/2026-10-03-ted-agente-inteligente-autoreview.md).

## 1. Origem, autoridade e limites da análise

Entrada analisada integralmente: `C:\Users\walis\Downloads\MEU-TED-PLANEJAMENTO-AGENTE-INTELIGENTE-V1.md`, 1.888 linhas, SHA-256 `f873b8f8f7982eab94102b0e90a908e07e57a5e782a45027f1e681a4c581036d`. O arquivo original não foi alterado. Seus exemplos são requisitos de produto, não evidência de implementação nem autorização operacional. Esta SPEC é autossuficiente; a referência à origem serve para rastreabilidade, não depende de um link local para execução.

A origem chama a base de `kust-projetos/meu-ted`; a base efetivamente inspecionada é este checkout de `pi-financeiro` (`package.json`: `meu-ted`). Não se presume equivalência com outro checkout ou com `../pi-finance-web`, depreciado.

Alterações preexistentes preservadas: `AGENTS.md`, `.github/workflows/release-b-reminder.yml` e `docs/reports/2026-10-03-vps-migration-contabo.md`. Nenhuma delas pertence à implementação desta proposta.

Precedência: instruções canônicas do projeto e ADRs aceitos > esta proposta > exemplos da origem. Permanecem vigentes [ADR-014](adr/ADR-014-mutation-draft-multi-turno.md), [ADR-021](adr/ADR-021-pending-v2-transactions-scope-undo-separate.md), [ADR-026](adr/ADR-026-risk-based-mutation-authorization.md) e [SPEC V5](MEU-TED-SPEC-V5-AUTONOMIA-POR-RISCO.md).

Topologia de referência: PWA e Agent na Cloudflare; API e PostgreSQL na Contabo, conforme [relatório de migração](reports/2026-10-03-vps-migration-contabo.md). `ARCHITECTURE-CURRENT.md` ainda contém Hostinger/PG16 e SHAs históricos; isso não torna aquela origem ativa. Nenhuma sondagem de produção foi feita nesta análise. Release B, cutover residual e canary V5 são gates separados, não tarefas deste refinamento.

## 2. Parecer sobre a proposta original

**Manter:** backend autoritativo, memória contextual, Jev advisory-only, evidência antes de sucesso, recuperação limitada, reutilização de componentes e entregas incrementais.

**Corrigir antes de implementar:**

1. Multi-turn, receipts, grounding, retry e memória já existem. Evoluir seus contratos; não criar uma segunda infraestrutura equivalente.
2. Uma UI ou preview de anexo não demonstra ingestão. Liberar cada tipo apenas com transporte, extração e tratamento de falhas reais.
3. O exemplo “entende → executa” omite autorização. Em `off`/`shadow`, inclusive baixo risco continua pelo caminho manual vigente. `on` exige gate humano e policy da API.
4. PendingOperation V2 cobre apenas criação de receita/despesa. Pagamentos, transferências e undo não podem entrar nela por generalização do novo agente.
5. Um detector textual de “registrei” não prova ausência de falso sucesso. Resultados mutantes precisam de resposta tipada e renderização vinculada à evidência.
6. “Memória persistente” não implica escopo actor/workspace correto para novos aliases ou habilidades. Isso precisa de testes e desenho explícito.
7. “Modelo Jev free no Zen” e “replicar MCP do OpenCode” são intenções da origem, não disponibilidade/preço/privacidade comprovados no Worker.
8. Agregar últimos N lançamentos não produz um total confiável. Reutilizar agregações autoritativas quando suportarem integralmente período, filtro e hierarquia; adicionar rota somente para a lacuna real.
9. `confidence` de modelo não é probabilidade calibrada, consentimento ou critério de autorização.
10. “Aprender automaticamente” não autoriza executar código gerado, promover core skills ou usar dados de um usuário como contexto de outro.

### 2.1 Baseline confirmada por inspeção estática

| Área | Existente / lacuna observada | Âncora de código |
| --- | --- | --- |
| Categoria | Fallback mistura descrição com consulta de categoria | `apps/agent/src/mutations/entity-resolver.ts:156` |
| Claims | Guard financeiro já existe; deve ser evoluído, não duplicado | `apps/agent/src/orchestration/financial-claim-guard.ts` |
| Evidência | `ok|empty|error`, sem reason tipado; prompt serializa apenas `ok` | `apps/agent/src/evidence/evidence-envelope.ts:1–9,57–60` |
| Draft | CAS/handoff, TTL de 15 min, conversa opcional já participa do binding | `apps/agent/src/mutations/mutation-draft.ts:59–119` |
| Anexos | Gate conjunto default-off; contrato e DLP não entregam bytes à inferência | `apps/pwa/src/lib/capabilities.ts:59–66`; `apps/agent/src/privacy/dlp.ts`, `scrubAttachments` |
| Web | Guards de URL/redirect existem; tool não fornece o `lookup` opcional para checar IP resolvido | `apps/agent/src/agent-config/tools.ts:269`; `apps/agent/src/security/ssrf-guard.ts:205,223` |
| Memória | `source`, `confidence`, salience, expiração, decay e binding workspace/actor já existem; recall inclui compartilhadas `actor=''` por default | `apps/agent/src/agent-config/memory/store.ts:23–43,55–79,286–326` |
| Skills/Jev | Skills estáticas e seleção por keywords; user/candidate skills e integração Jev não implementadas | `apps/agent/src/agent-config/skills/`, `select-skill.ts`; inventário no AUTOREVIEW |
| Analytics | Rotas de agregação já existem; períodos atuais não são `yearMonth` | `apps/api/src/routes/analytics.ts`; `apps/api/src/analytics/types.ts` |

Os relatos de mensagens desaparecendo são hipótese a reproduzir ponta a ponta, não diagnóstico fechado nesta tabela. Inspeção não é teste verde. O PLAN discrimina também budgets e testes existentes.

## 3. Objetivo, escopo e prioridades

O TED deve interpretar linguagem imperfeita, preservar intenções incompletas, consultar dados reais e responder com precisão, mesmo com serviços opcionais indisponíveis. Segurança financeira existente é uma restrição do produto, não algo a trocar por fluidez.

| Faixa | Entrega | Condição de saída |
| --- | --- | --- |
| P0 | Prova de execução, identidade de mensagens, descrição/categoria, apresentação segura, vazio versus erro | Regressões reproduzidas ou lacunas demonstradas; matriz crítica sem falso sucesso/duplicação/vazamento |
| P1 | Interpretação semântica, continuação/correção, resolução de entidades, agregações e recuperação limitada | Mesma autoridade e idempotência; qualidade superior ao baseline em evals congeladas |
| P2 | Áudio Groq, imagens/PDF, pesquisa web e Jev opcional | Ingestão real por tipo, privacidade aprovada, fallback e budgets testados |
| P3 | Memória contextual V2, correções, user skills declarativas e candidates | Escopo, exclusão, proveniência e promoção humana verificáveis |

Não objetivos: novas permissões bancárias; movimentar dinheiro em banco externo; ampliar V2; religar tools V1/undo ao modelo; autoexecutar por confiança; expor browser automation; trocar provedor principal; modificar produção; remover legado/arquivo; reescrever históricos; instalar serviços ou copiar credenciais locais; executar o plano nesta sessão.

## 4. Invariantes obrigatórios

| ID | Invariante |
| --- | --- |
| INV-01 | Dado financeiro atual vem da API, não de memória, documento, web, modelo ou Jev. |
| INV-02 | Workspace/ator/dispositivo vêm do contexto autenticado; IDs sugeridos são revalidados contra catálogo e permissões atuais. |
| INV-03 | Criação TED de receita/despesa conserva PendingOperation V2, executor exclusivo, attestation privada, fingerprint e receipt canônico. |
| INV-04 | Draft/goal não executa, não autoriza e não emite attestation. Preservar CAS, TTL, `proposing` e handoff 0-ou-1 do ADR-014. |
| INV-05 | Mesmo redelivery/retry conserva mensagem, intenção, proposta e chave de escrita. Payload diferente com a mesma chave é conflito, não atualização. |
| INV-06 | Escrita possivelmente ocorrida sem resultado comprovado permanece incerta: reconciliar operação existente; nunca criar outra escrita como recuperação. |
| INV-07 | Escolha explícita atual vence alias/inferência. Ambiguidade crítica pede esclarecimento. Modelo/Jev nunca concedem autorização. |
| INV-08 | Resultado mutante visível depende de evidência da operação correta, vinculada ao turno e à identidade; `succeeded` sem receipt fiel é inválido. |
| INV-09 | Texto externo, memória, transcrição e skill personalizada são dados não confiáveis; nenhum deles altera políticas ou capabilities. |
| INV-10 | Recuperação não amplia workspace, período solicitado, privilégios ou ferramenta de escrita. Falha de serviço auxiliar não derruba texto/leituras básicas. |
| INV-11 | `bank`/`cash` aceitam saldos negativos; `credit_card` conserva as regras atuais. Não introduzir clamps ou reinterpretar saldos. |
| INV-12 | Flags novas não ativam `TED_RISK_BASED_AUTOEXECUTE=on`, não mudam bearer/Release B e não autorizam migrations/deploy. |

## 5. Requisitos P0 — confiabilidade e apresentação

### R01 — prova de resultado e resposta tipada

Reutilizar `MutationReceipt`, evidências e respostas determinísticas. O contrato proposto de resposta distingue `read`, `clarification`, `proposed`, `succeeded`, `uncertain` e `failed`; não substituir os status existentes da API por esses rótulos de apresentação.

- Resposta `succeeded` exige receipt validado, `operationId` correto e entidade/operação correspondente. Para undo, usar a prova do serviço separado, sem fabricar receipt V2.
- A parte que anuncia ou resume uma mutação deve ser renderizada pelo código a partir do resultado autoritativo. Campos apresentados devem corresponder ao snapshot validado/resultado real; não aceitar valores inventados pelo modelo ao lado de receipt verdadeiro.
- Se a evidência faltar, divergir ou for inconclusiva: retirar a alegação de conclusão e explicar a incerteza. Não afirmar “nada foi gravado” sem prova de ausência de efeito.
- Claim guard textual/semântico é defesa adicional. Regex ou Jev não são o mecanismo de garantia. Nenhuma saída livre do modelo pode autorizar um bloco de sucesso.
- Leitura também não pode inventar efeito: alegações de ação detectadas sem evento/prova associado falham para resposta neutra. Evals adversariais cobrem perífrases, sinônimos, múltiplas ações e sucesso antigo citado como atual.
- Read-after-write é verificação read-only direcionada, quando o contrato/risco exigir, nunca reexecução. Se a leitura falhar após receipt válido, preservar a conclusão já comprovada e indicar apenas a indisponibilidade da verificação adicional.

### R02 — identidade e reconciliação de mensagens

`clientMessageId` permanece estável de envio a retry/histórico. A forma exata de integrá-lo ao `TurnInput` existente é detalhada no PLAN, sem criar IDs paralelos desnecessários.

- Mesmo ID/mesmo conteúdo: replay/dedup. Mesmo ID/conteúdo diferente: conflito. Duas mensagens iguais com IDs diferentes continuam duas mensagens.
- Balão otimista não desaparece porque uma resposta chegou, o histórico foi truncado/paginado ou a API falhou. Substituí-lo somente por confirmação da mesma identidade; falha mantém estado reenviável com o mesmo ID.
- Associações incluem turno/conversa e escopo autenticado; não reconciliar por texto, posição ou apenas timestamp.
- Logout/troca de workspace/geração impede resultados tardios de entrar no chat novo. Não transferir mensagens ou drafts automaticamente entre atores/workspaces.
- Garantia de não desaparecimento cobre sessão corrente, retry, reload com recuperação suportada e reconciliação; exclusão intencional/expiração de retenção deve ter comportamento explícito, não promessa de retenção eterna.

### R03 — descrição não é categoria

“Carne” permanece descrição de “gastei 50 de carne”. Categoria é campo separado, explicitamente escolhido ou candidato entre categorias reais. Remover fallback equivalente a `categoryQuery ?? description` somente no ponto demonstrado pelos testes; preservar explicitação válida de categoria/subcategoria. A categoria “Alimentação > Mercado” é exemplo, não taxonomia imposta a todos os workspaces.

### R04 — vazio, ausência e falha

Separar os eixos: sucesso técnico da consulta; estado de setup/dados; resolução de entidade; ciclo da mutação. Não usar uma enumeração única com `SUCCESS`, `AMBIGUOUS` e `WORKSPACE_EMPTY` para tudo.

Motivos de leitura: `workspace_empty`, `setup_incomplete`, `period_empty`, `category_empty`, `filter_empty`, `entity_not_found`; resolução: `found` ou `ambiguous`; falhas: `retryable_error`, `permanent_error`, `forbidden`, `unavailable`. `totalCents=0` com lançamentos existentes não significa “sem lançamentos”. Erro de uma consulta necessária impede diagnóstico conclusivo de vazio.

Não “resolver” filtro vazio mostrando totais de outro período/categoria como se fossem os solicitados. Oferecer alternativa identificada; não executá-la silenciosamente. Setup incompleto conserva draft e pede apenas os campos/ações necessários.

### R05 — Markdown seguro

Mensagens do usuário permanecem texto literal. Mensagens TED suportam Markdown restrito, sem HTML bruto, scripts, `dangerouslySetInnerHTML` ou imagens remotas/tracking automáticos. Sanitizar protocolos de links: permitir apenas `http`/`https` para fontes externas; bloquear `javascript`, `data`, `file` e esquemas desconhecidos. Links novos usam proteção contra opener.

Tabelas com scroll no contêiner, quebra de URLs/palavras, headings com hierarquia consistente, foco visível e leitores de tela. Emojis são decorativos ou acompanhados por texto; cor/emoji nunca são a única indicação de status. Estado parcial/streaming não revela um claim mutante antes da verificação. `react-markdown` + `remark-gfm` é opção da origem, sujeita a compatibilidade/audit; não uma dependência já instalada por esta SPEC.

## 6. Requisitos P1 — interpretação, goal e resolução

### R06 — interpretação semântica delimitada

Conservar entrada original; gerar interpretação validada por schema com intenção, valor em centavos, pistas de data/conta/categoria e proveniência por campo. Reutilizar parser/roteador e fast-paths existentes; fallback semântico apenas quando trouxer valor demonstrável.

- `gstei 50 d carne hj no nubnk`: candidato a despesa de 5.000 centavos, descrição carne e pistas hoje/Nubank; precisa resolver entidades e autorização.
- Valores aproximados (“uns 80”), moeda não suportada, separadores ambíguos, datas contraditórias ou contas homônimas exigem esclarecimento, não certeza fabricada.
- Datas relativas são calculadas a partir do instante da mensagem e timezone autorizado do usuário/workspace; cruzar meia-noite não altera silenciosamente o draft. Não inventar um timezone que o sistema não fornece: apresentar data explícita ou esclarecer.
- Confiança é sinal advisory, sem limiar universal de autoexecução. Schema inválido/candidato fora do catálogo cai para determinístico/esclarecimento, sem IDs inventados.

### R07 — evoluir MutationDraft, não substituir sua autoridade

Introduzir metadados de goal somente onde necessários: `goalId` reutilizando identidade do draft quando aplicável; revisão, referências de mensagens e origem/proveniência por campo. Não criar uma segunda FSM persistente de escrita. Objetivos read-only podem ter contexto conversacional, não PendingOperation.

Relações de mensagem: nova intenção, continuação, correção, confirmação, negação, cancelamento, referência ao goal e referência histórica. Relação incerta não executa nem altera entidade histórica: pede esclarecimento.

- `active`: completa/corrige campos via CAS e revisão; conservar o TTL atual de 15 minutos, sem renovação infinita.
- Nova intenção substitui contexto conforme contrato atual, sem herdar campos por conveniência. Cancelamento/expiração não realiza efeitos.
- `proposing`: payload congelado; retry recupera a mesma proposta/chave. Correção concorrente não modifica o snapshot em voo.
- `consumed`: não aceitar fragmento como patch retroativo da transação. Correção pós-proposta deve seguir os comandos e cancelamentos existentes; resultado incerto é reconciliado antes de qualquer novo efeito.
- Confirmar nunca equivale a completar campo por inferência. Propostas antigas não são confirmadas por referência vaga ao “último”.
- O contrato já inclui `conversationId` opcional no binding; verificar seu preenchimento no transporte antes de acrescentar identidade. Isolamento entre conversas/abas do mesmo ator/dispositivo precisa de decisão antes de compartilhar novo estado.

**Fronteira de conclusão:** debounce, silêncio ou probabilidade de continuação não são consentimento. Na primeira entrega, fragmentos montam draft/proposta e a confirmação vigente encerra a intenção. Um comando completo e explicitamente imperativo pode continuar usando a elegibilidade V5 já aprovada; ampliar autoexecução para goals completados por fragmentos depende de política/proveniência testadas e gate humano separado. A V5 exclui relatos como “Gastei 80 no mercado” da elegibilidade inicial; “Gastei 50” não deve executar cedo e depois criar outra transação ao receber “não, 500”.

### R08 — resolver entidades reais

Ordem: escolha explícita atual > preferência/alias confirmado dentro do escopo > match determinístico > ranking semântico entre candidatos atuais > esclarecimento. Categoria sugerida sem referência segura permanece candidato, não seleção irrevogável.

Validar existência, atividade, workspace, tipo e uso permitido de conta/categoria imediatamente antes de propor/executar conforme contrato atual. Se alias aponta para ID removido/inativo/fora do escopo, invalidar sua utilização e re-resolver. Categoria semântica nunca cria categoria nova automaticamente. Homônimos e conflito com escolha explícita ficam visíveis ao usuário.

### R09 — workspace e agregações autoritativas

Reutilizar read models existentes. Se faltar suporte integral, rota proposta: `GET /analytics/spending-summary`, protegida por leitura autenticada/capability estreita; nunca por um `workspaceId` confiado do corpo/query. Query proposta: `yearMonth`, `categoryId?`, `includeDescendants=false`, `accountId?`; limites/validação consistentes com a API.

Resposta: período efetivo (início inclusivo/fim exclusivo), timezone/basis e versão semântica, filtro efetivo, `totalCents` inteiro, `transactionCount`, breakdown com IDs/rótulos reais, `asOf` e motivo de vazio quando conclusivo. Adaptar ao modelo atual `period=custom` com intervalo normalizado quando suficiente, em vez de introduzir `yearMonth` incompatível no schema existente. O envelope não pode converter timeout/403 em zero.

**Semântica a fechar no spike A09:** usar as mesmas regras financeiras canônicas das agregações atuais; documentar data de competência versus pagamento, status considerados, soft-delete, estorno/undo, transferências, compras versus pagamento de fatura e ancestrais. Não somar compra de cartão e pagamento da mesma fatura como duas despesas. Somatórios obedecem às regras de sinal existentes e safe integers; dataset maior que uma página não pode perder linhas. `includeDescendants` inclui a categoria e descendentes reais sem duplicá-los, com travessia limitada/ciclo tratado. Sem essa definição e fixtures, a nova rota fica bloqueada.

Contexto de workspace deve usar snapshot consistente quando a resposta afirmar causa global de vazio; consultas parciais não demonstram workspace vazio. Não expor contagens de entidades que o chamador não pode ler.

### R10 — recuperação limitada dentro do orquestrador existente

Não adicionar um segundo loop de tools ou retry paralelo ao grounding/provider failover. Inventariar primeiro os budgets atuais e aplicar um teto compartilhado de turno.

Baseline: 5 steps de modelo; até 2 chamadas fast-path; `correctionCount` 0–1; 1 retry de grounding; até 2 pernas de relay. Estes limites medem eixos diferentes. A proposta de 2 recuperações não aumenta nenhum deles automaticamente; qualquer alteração precisa de teste/custo e contrato de accounting explícito.

- Máximo proposto: 2 recuperações de resolução read-only, contabilizando o retry de grounding existente. Chamada idêntica sem evidência nova é bloqueada por fingerprint de tipo/args/escopo/revisão da fonte.
- Condições de parada: sucesso verificável, esclarecimento necessário, erro permanente/403, resultado incerto de escrita, cancelamento, orçamento/tempo excedido ou falta de estratégia nova.
- 401 pode usar somente a recuperação autenticada já suportada; não substitui dispositivo/ator silenciosamente. 429 de uso não gera failover nem loop; preservar codes e reservas conservadoras atuais.
- Mesmo intento tem no máximo um efeito financeiro, não necessariamente um POST: replay idempotente do protocolo e reconciliação são permitidos sem novas chaves.
- Todos os serviços auxiliares consomem o deadline restante; teto sugerido de Jev por chamada: 2 s, no máximo 1 por turno inicial. Os 30 s da origem não viram default automático. Tempos finais dependem de medição A10/A16 do PLAN, sem mudar o deadline atual inadvertidamente.

## 7. Requisitos P2 — conteúdo e serviços externos

### R11 — ingestão com identidade e lifecycle

Contrato proposto de anexo: referência opaca server-side, owner workspace/actor, tipo detectado, tamanho/hash, estado `uploaded|processing|ready|failed|expired` e expiração. Nunca serializar `File` como JSON, blob URL local ou caminho do computador como se fosse conteúdo no Worker.

- Autenticar upload e leitura; quotas por ator/workspace; validar MIME, assinatura real, bytes, duração/páginas e tipo permitido. Definir também tetos de pixels/dimensões, tamanho descompactado, CPU/tempo do parser no spike: limite do arquivo bruto não impede decompression bomb. Rejeitar arquivo malformado, executável, criptografado não suportado e conteúdo expansivo; parsers não executam scripts nem acessam referências externas embutidas.
- Storage privado; autorização a cada leitura, URLs efêmeras quando necessárias; ausência de acesso público/listagem. Token/credencial não acompanha referência para o modelo.
- Proposta inicial para a primeira fatia: áudio até 10 MiB/120 s; imagem até 10 MiB; PDF até 10 MiB/50 páginas; bruto temporário por até 24 h. São limites propostos conservadores, não capacidades comprovadas: aprovar retenção/custo e validar runtime antes de ativar.
- Cancelamento, expiração, logout e falha têm política de cleanup/retry idempotente. Raw file não aparece em logs, telemetry ou memória permanente. Retenção de transcrição/extrato no histórico segue política explícita; preservar hash/proveniência não exige guardar bruto indefinidamente.
- Reprocessar mesmo anexo/turno não cria segunda intenção/escrita. Poll/response tardio de outro escopo é descartado.
- Tipo indisponível não é anunciado pela PWA. Flags do front não substituem enforcement no servidor.
- `NEXT_PUBLIC_TED_ATTACHMENT_INGESTION=1` atualmente libera os três tipos juntos. Evoluir o gate existente para disponibilidade real por tipo antes da primeira fatia áudio; não ativar imagem/PDF sem pipeline. Mic capturado/transcrito no navegador e upload de arquivo de áudio são caminhos diferentes.

### R12 — áudio via Groq

Groq é escolha da origem para STT; modelo configurável. Endpoint oficial consultado: `POST /openai/v1/audio/transcriptions`; requer arquivo real/modelo e retorna texto, sem garantia de um score universal de confiança. `verbose_json`/metadados podem apoiar triagem; não inventar `confidence` se o provider não o fornece.

Transcrição → interpretação validada → draft → autorização vigente. Na primeira fatia, valores/contas/datas de origem áudio devem ser apresentados para confirmação; o modelo não pode classificar áudio como instrução textual explícita apta à autoexecução. Negação e incerteza de números/nome são casos críticos de eval.

`GROQ_API_KEY`, modelo e timeout ficam somente server-side. Política de retenção/treinamento e consentimento do provedor precisam de aprovação antes do tráfego real. STT indisponível preserva o anexo/estado de falha conforme retenção e oferece entrada textual; não inventa transcrição. Não usar upload por URL pública para contornar limites.

### R13 — imagens e PDF

Imagem/vision e PDF textual têm contratos separados; PDF escaneado depende de OCR/vision explicitamente validado. Extração estruturada inclui valor, moeda, estabelecimento, data e proveniência por campo/página, com possibilidade de `unknown`/`ambiguous`.

Comprovante não prova registro interno nem transferência realizada pelo TED. Anexo não é ordem de lançamento: extração monta candidato/draft; confirmação explícita antes de escrever na primeira entrega. Múltiplos itens/páginas não viram importação bulk automática. PDF muito grande solicita redução/fluxo futuro, não chunking ilimitado. CSV/XLSX/OFX/TXT e indexação persistente ficam fora da primeira fatia e demandam spec própria.

### R14 — web research com evidência e minimização

Evoluir tools/provedores/SSRF existentes, sem novo crawler. Usar web apenas para informação externa atual ou URL explicitamente solicitada. Query externa não recebe saldo, IDs, conta, documento bruto ou histórico pessoal; consentimento/minimização para qualquer dado adicional, sem depender apenas da boa vontade do prompt.

Envelope proposto: query sanitizada, URL final validada, título, origem, `retrievedAt`, data da publicação quando disponível, trechos utilizados e associação claim→fonte. Montantes pessoais vêm da API; comparação externa identifica período, metodologia e limitações. Duas fontes são recomendadas quando necessárias, não duplicação obrigatória de uma fonte primária adequada.

Preservar guards de URL/redirect/timeout e estabelecer limite efetivo de bytes/resultados durante leitura; nenhum `web_fetch` acessa IP privado/metadata ou envia cookies/headers pessoais. **Pré-requisito:** fechar a lacuna de wiring do resolver/egress no caminho real do Worker, com teste de produção simulado; a existência de teste com `lookup` injetado não comprova proteção contra DNS rebinding no caminho atual. Pré-resolução sem garantir o destino efetivo do fetch também não basta: decidir controle de egress/transport/allowlist apropriado. Hoje `response.text()` precede o truncamento em caracteres; testar interrupção de corpo oversized em vez de assumir um teto real de memória/rede. Limitar fetches seletivos pelo orçamento compartilhado. Sem web, não afirmar atualização inexistente: responder com limitação, dados conhecidos datados ou pedir fonte. Não usar conteúdo externo como instrução nem promover recomendações financeiras a garantias.

### R15 — Jev opcional e governado

`JudgmentProvider` é fronteira pequena com timeout/resultado validado; iniciar somente com operações realmente consumidas, sem copiar quatro métodos abstratos por antecipação. Allowlist inicial da origem: `jev_check`, `jev_score`, `jev_decide`, `jev_gate`, condicionada ao catálogo remoto real e ao propósito advisory.

- MCP remoto autenticado compatível com Worker é a opção recomendada; stdio/processo local do OpenCode não é um deploy no Worker. Não hospedar novo gateway sem decisão/necessidade demonstrada.
- Descobrir transport, endpoint, credencial e modelo de forma sanitizada; não copiar configuração integral, auth store ou chave local. Integração usa secret próprio aprovado, nunca segredo no browser/Git/DO logs.
- Modelo grátis/Zen é preferência a validar, não requisito que permita violar a política `training_prohibited` ou depender de oferta descontinuada. Proibido fallback para modelo que use dados financeiros para treinamento.
- Saída válida ainda é advisory: candidatos devem existir no catálogo, escolha explícita vence, permissão/prova são determinísticas. Saída malformada, fora da lista, timeout, 401 ou indisponibilidade → determinístico/esclarecimento, sem bloquear texto.
- Falha do judge produz abstinência/unavailable, não um score sintético apresentado como confiança Jev. Se a implementação usar o relay governado, registrar modelo/protocolo conforme suas regras; se usar MCP externo, criar gate equivalente de egress/privacidade, sem alegar que o registry existente já o protege automaticamente.
- Circuit breaker proposto: abre após 2 falhas consecutivas por provider/configuração; cooldown 300 s, half-open limitado; 4xx de conteúdo não devem contaminar tenants por chave global mal definida. Não persistir estado financeiro no judge.
- Aprovar modelo/preço/privacidade/transporte antes de ativar. Nenhuma integração Jev foi executada nesta sessão.

## 8. Requisitos P3 — memória e aprendizagem controladas

### R16 — memória com proveniência e correção

Evoluir store/learning existentes; memória do produto TED é distinta do ai-memory de engenharia deste repositório. Não introduzir ai-memory MCP como banco de usuários.

Tipos lógicos: preferência, alias, correção, hábito e resumo contextual; mapear aos tipos existentes `fact|preference|learning|summary` antes de migration. `source`, `confidence`, salience, expiração e decay de recall já existem. Campos adicionais propostos: origem detalhada, escopo de compartilhamento, referências mínimas, versão, confirmação e supersessão. Respeitar 1.200 caracteres/top-5 de recall sem inflar contexto automaticamente. `1.0` para declaração explícita descreve a origem, não verdade financeira perpétua.

- Preferência explicitamente solicitada para persistência pode ser gravada de forma idempotente no escopo autenticado, respeitando opt-out. Corrigir uma transação isolada não autoriza regra permanente. Inferência comportamental permanece candidata desativada até critério/consentimento aprovado; regra explícita atual vence histórico.
- Actor+workspace é o escopo default para conta/categoria/merchant. Compartilhar no household/workspace precisa de permissão/consentimento específico; preferências visuais não devem vazar preferências financeiras entre workspaces.
- IDs de conta/categoria não são autoridade; revalidar sempre. Saldos/faturas/estado atual não são memórias duráveis usadas como fato.
- Correção substitui/invalida versão antiga com proveniência, sem duplicar alias em redelivery. Excluir memória revoga alias/user skill derivados ou marca dependências inválidas; não ressurge no próximo job.
- Uso deve ser explicável (“usei a preferência…”), com opção de corrigir/esquecer. Retenção de eventos/texto mínimo precisa ser aprovada; não salvar tokens/documentos brutos/PAN/CVV.

### R17 — user skills e candidate skills

Core skills continuam versionadas/revisadas no repositório. User skills iniciais são regras declarativas restritas, por exemplo alias merchant→categoria existente; sem código, SQL, fetch, tools adicionais ou prompt que aumente autoridade. Reusar representação de aliases quando suficiente; não criar framework de plugins antes de um caso real.

Geração automática pode propor candidata a partir de correção confirmada. Ativação de regra pessoal respeita consentimento/proveniência da memória; conflitos pedem esclarecimento. Não executar scripts nem obedecer instruções arbitrárias contidas na regra.

Candidate global: versão/hash, motivo, métricas e proveniência minimizada → replay **offline/somente leitura com fixtures**, evals congeladas, safety, review e aprovação humana → promoção versionada. Sem replay de escritas históricas, sem exemplos identificáveis cross-tenant. Rotina periódica nunca promove automaticamente core skills. Rollback restaura versão anterior e preserva histórico; remoção da fonte invalida regras derivadas.

## 9. Segurança, observabilidade e métricas

Eventos propostos evoluem a instrumentação existente: intenção/goal/revisão, resolução, recovery, outcome/prova, chamada/fallback de provider, extração e aprendizado. Correlação com IDs opacos e duração/contadores; conteúdo bruto só em storage autorizado, não telemetry. Não presumir que logs/eventos atuais são sink durável suficiente: persistência, acesso, retenção e cardinalidade precisam de decisão antes da instrumentação extensa. Não confundir esse sink com a telemetria exigida para canary V5.

Medir separadamente chamadas LLM, Jev, web, STT/vision, retries e reservas de tokens. Não reduzir reservas em falha despachada para aparentar economia; preservar denials e failover conforme [correção de quota](reports/2026-10-03-ted-agent-device-quota-fix.md). Limites diários atuais não são SLA nem budget por turno para novas capacidades.

| Métrica | Gate proposto |
| --- | --- |
| Falso sucesso, duplicação por retry, vazamento entre escopos | Zero ocorrências na matriz crítica e testes de concorrência; não promessa de prova universal em produção |
| NLU/multi-turn/entity resolution | Pelo menos 95% no dataset versionado de casos suportados; 100% de casos críticos de negação/escopo/valor incerto sem escrita indevida |
| Clarification/task completion | Comparar baseline por classe, sem reduzir perguntas à custa de inferências perigosas |
| Latência P50/P95 e custo por turno | Medir baseline em A00; definir limites numéricos por modalidade/provider antes de habilitar P2/P3 |
| Grounding web, STT, memória e skills | Cobertura por cenário; fonte/proveniência verificável; nenhuma regressão crítica versus core atual |

Meta de 95% e limites de ingestão são propostas para aceite, não resultados medidos. Qualquer teste crítico com falha bloqueia promoção independentemente da média. Evals de qualidade usam amostras pt-BR sintéticas/consentidas e seed/configuração registrados; avaliador probabilístico não substitui oráculos determinísticos de dinheiro/identidade/receipt.

## 10. Matriz mínima de aceitação

Todos os casos seguintes são **futuros testes de aceite**, não resultados desta sessão. O PLAN aponta os pontos de extensão e comandos.

| Caso | Requisitos | Resultado verificável |
| --- | --- | --- |
| AC01 Tool falha e modelo diz “registrei”/“está lançado” | R01 | Nenhum bloco/claim de conclusão; resposta honesta e sem receipt fabricado |
| AC02 Receipt de outra operação/entidade/workspace | R01 | Rejeição fail-closed; nenhuma reconciliação financeira |
| AC03 Receipt válido com descrição/valor inventados no texto | R01 | Resumo deriva do resultado/snapshot verificado, não do texto inventado |
| AC04 Resposta da escrita perdida após efeito | R01/R10 | Mesma chave/operação; reconciliação; uma linha no ledger |
| AC05 Envio lento, retry e reload de histórico | R02 | Um balão por ID e dedup server-side; nenhum desaparecimento silencioso |
| AC06 Dois textos iguais com IDs distintos | R02 | Duas mensagens preservadas, sem dedup por texto |
| AC07 Troca de workspace/logout durante request | R02/R07 | Resultado antigo não entra no novo escopo |
| AC08 “gastei 50 de carne” | R03/R08 | 5.000 centavos, descrição carne; categoria existente ou esclarecimento |
| AC09 Workspace/período/categoria/filtro vazios | R04/R09 | Motivo correto, sem chamar consulta vazia de falha nem ampliar filtro |
| AC10 Erro/403 no analytics | R04 | Nunca informar zero como se fosse evidência |
| AC11 HTML, `javascript:`, imagem remota, tabela longa | R05 | Sem execução/tracking; scroll acessível e usuário literal |
| AC12 “gstei 50 d carne hj no nubnk” | R06 | Interpretação correta e validação de conta/data; sem autorização inferida |
| AC13 “uns 80”, número ambíguo, negação | R06 | Esclarecimento; nenhum arredondamento ou registro silencioso |
| AC14 “gastei 50” → “de carne” → “ontem” → conta | R07 | Mesmo draft/goal; no máximo uma proposta/efeito autorizado |
| AC15 Correção “não, 500”, nova intenção, cancelamento | R07 | Correção/descartes explícitos; zero herança indevida ou escrita precoce |
| AC16 Duas abas/correção concorrente com proposing | R07 | CAS/revisão/fingerprint; payload em voo imutável |
| AC17 Alias antigo/inativo/fora do workspace e escolha explícita | R08/R16 | Revalidação, explícito vence; sem uso de ID inválido |
| AC18 Mais linhas que uma página + hierarquia de categorias | R09 | Soma exata do conjunto inteiro, sem duplicar descendentes |
| AC19 Compra/cartão/fatura/undo/soft-delete/mudança de mês | R09 | Sem dupla contagem; período/status/basis conforme contrato fechado |
| AC20 Repetição de tool e budget esgotado | R10 | Até 2 recuperações totais, deadline compartilhado e parada segura |
| AC21 Upload cruzado, MIME falso, oversized e expirado | R11 | Rejeição, sem bytes/URLs públicos nem leitura cross-tenant |
| AC22 Áudio real, STT timeout, número/negação mal transcritos | R12 | Conteúdo real ou falha explícita; confirmação de campos críticos |
| AC23 Imagem/PDF textual/scan, injection e múltiplos itens | R13 | Extração rastreável sem instrução externa nem bulk write |
| AC24 Web atual, indisponível, redirect privado, query sensível | R14 | Fonte datada; bloqueio SSRF/minimização; sem dado pessoal em pesquisa |
| AC25 Jev timeout/401/malformado/escolha inexistente | R15 | Fallback determinístico/esclarecimento, sem permissão/sucesso concedidos |
| AC26 Correção repetida, esquecimento e job de aprendizado | R16 | Um evento/regra efetiva; exclusão não ressuscita memória derivada |
| AC27 User skill pede tool/SQL/alteração de política | R17 | Schema rejeita; core e capabilities intactos |
| AC28 Candidate melhora média mas falha safety | R17 | Promoção bloqueada; rollback e aprovação humana mantidos |
| AC29 Flags novas com V5 `off`/`shadow`/`on` | INV-12 | Sem ativação implícita; política vigente e undo separado preservados |
| AC30 Serviços externos indisponíveis e quota de uso | R10/R12/R14/R15 | Texto/leituras suportadas seguem; denial não vira loop de failover |

## 11. Decisões propostas e gates ainda abertos

| ID | Questão | Recomendação / bloqueio |
| --- | --- | --- |
| G01 | Composição com V5 e fragments | Não ampliar elegibilidade; multi-turn primeiro com confirmação vigente. Mudança futura requer policy/proveniência e autorização humana. |
| G02 | Isolamento de goals/conversas | Preservar binding e `conversationId` opcional atuais; verificar wiring e decidir política entre abas antes de compartilhar novo estado. |
| G03 | Analytics | Reusar serviços atuais; contrato de basis/período/cartão fechado por fixtures antes de nova rota. |
| G04 | Jev/Zen/MCP | Validar oferta/modelo, training/retention, transporte remoto e custo. Se incompatível, Jev permanece desligado; não substituir provedor por conta própria. |
| G05 | Groq/vision/OCR/storage | Groq STT é intenção da origem; selecionar modelo, storage e providers restantes após spike e aprovação de dados/retention. |
| G06 | Consentimento e aprendizagem | Preferências explícitas primeiro; inferência e compartilhamento/global dependem de consentimento, exclusão e política aprovados. |
| G07 | SLO/custo/flags | Medir baseline e aprovar limites por modalidade. Flags novas default-off; seus nomes finais são definidos nas fatias, não variáveis existentes presumidas. |
| G08 | Persistência/migrations | Definir versões/compatibilidade DO e migration aditiva API somente se necessária; reservar versão a partir do HEAD da execução, sem presumir V060 livre. |

Pendências não impedem P0 local depois de sua autorização; bloqueiam apenas as fatias dependentes. Esta SPEC não inventa consenso nem exige ativar todos os opcionais para liberar correções independentes.

### 11.1 Adendo (2026-10-04) — semântica de `basis` e envelope de prova (G03)

Patch de SPEC exigido pelo PLAN A09 ("patch da SPEC antes de nova API"). Autorizado pelo operador ("pode continuar com o restante") após o [spike](reports/2026-10-04-ted-inteligente-v1-a09-spike.md) provar as três lacunas. Define a implementação como **aditiva na camada de leitura**, sem rota nova e **sem alterar o comportamento default** de nenhuma resposta existente:

1. **G-A — `basis` opt-in.** Nova query param `basis` nas agregações de despesa (`kpis`, `cashflow-series`, `category-breakdown`, `daily-heatmap`): `liquidez` (default, comportamento atual byte a byte — compras e pagamentos de fatura contam como estão hoje) e `competencia` (exclui linhas com `statement_payment_id IS NOT NULL` do agregado de despesa; a compra permanece na data da compra). Omissão = `liquidez`. Nenhuma resposta muda sem o parâmetro explícito.
2. **G-B — inteiro exato.** Quando `totalCents` (ou total de slice) exceder `Number.MAX_SAFE_INTEGER`, a resposta passa a incluir `totalCentsExact: string` (valor decimal exato do banco) e `approximate: true` no campo afetado; `totalCents: number` permanece para compatibilidade, documentado como aproximado nesse caso.
3. **G-C — envelope de prova.** Toda resposta de analytics ganha campos aditivos: `transactionCount` (inteiro, linhas consideradas), `asOf` (instante da leitura, ISO-8601), `basis` (efetivo, string), `semanticsVersion` (`"1"`), `effectiveFilter` (objeto com os filtros realmente aplicados) e `emptyReason` (motivo de vazio conclusivo, `null` quando há dados). Timeout/403 continuam **nunca** convertidos em zero (R04/R09).
4. **Fixture obrigatória:** `apps/api/tests/fixtures/analytics-semantics.fixture.json` passa a ser importada por teste real de agregação (PG), com os casos F (dupla contagem), H (safe integers) e L (envelope) como RED pós-implementação dos itens 1–3; os casos de comportamento default (A–E, I–K) travam que o default não mudou.
5. **Fora do escopo deste adendo:** filtro `categoryId`/`includeDescendants` (lacuna de filtro, read model futuro), rota `/analytics/spending-summary` (só se G03 decidir por ela), e qualquer mudança em `daily-heatmap` além do envelope.

### 11.2 Adendo (2026-10-04b) — resolução formal de G04, G05 e G06

Resolução com condições, autorizada pelo operador nesta data; decisão completa e evidências em [reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md](reports/2026-10-04-ted-inteligente-gates-g04-g05-g06-resolution.md). Síntese:

- **G04 → default-off com wiring completo.** Jev permanece DESLIGADO em produção (oferta/modelo/training/retention/custo não validados — desfecho previsto no próprio gate). A16 libera o wiring no hot path com o determinístico autoritativo, tetos e breaker já existentes; habilitação futura exige validação documentada do provider + G07.
- **G05 → seleção registrada, flags default-off.** STT: Groq `whisper-large-v3-turbo`, `language=pt`, tetos server-side próprios, ZDR ativado antes de produção (docs Groq: sem treino com dados do cliente; retenção de inferência ≤30 dias; ZDR elegível). Storage: R2 privado via binding opcional, referência opaca, sem URL pública, TTL idempotente; sem binding = pipeline de bytes fail-closed. Imagem/PDF: adapters default-off condicionados a spike bounded; PDF escaneado sem provider validado = `unsupported` explícito (subfatia própria). Capability por tipo (P3).
- **G06 → regra durável só com consentimento explícito.** Inferência permanece candidata/advisory; esquecimento é cascata (derivados não ressuscitam); escopo explícito incluindo a camada compartilhada; user skills = regras declarativas restritas com promoção por replay offline + safety + aprovação humana.

Efeito: **A13–A18 desbloqueadas para implementação com flags default-off.** Nenhum deploy/credencial/ativação em produção é autorizado por este adendo; habilitação é rollout por fatia (A19). G01, G02, G07 e G08 permanecem abertos.

## 12. Rastreabilidade da origem

| Seções da origem | Destino / disposição |
| --- | --- |
| 1–4: objetivo, princípios, estado, arquitetura | §§1–4; reaproveitar componentes, corrigir baseline e autoridade |
| 5–7: NLU, fragmentos, entidade | R03/R06–R08; fechar fronteira de conclusão e concorrência |
| 8–10: workspace, loop, analytics | R04/R09/R10; separar enums e reusar agregações |
| 11: multimodal | R11–R13; fatias áudio/imagem/PDF, importadores avançados adiados |
| 12–14: web, evidence, Jev | R14/R15; fontes, minimização, transporte/modelo sujeitos a validação |
| 15–17: memória, learning, skills | R16/R17; regras declarativas, consentimento e promoção humana |
| 18–21: proof, UI, mensagens, prompt | R01/R02/R05; prompt declarativo acompanha enforcement em código |
| 22–23: observabilidade/segredos | §9 e R11–R17; sem cópia de secrets |
| 24–25: fases e prioridade | §3 + PLAN; etapas reorganizadas por dependências, não 12 rewrites |
| 26–28: aceite/evals/métricas | §§9–10 + PLAN; critérios propostos, sem resultados fictícios |
| 29: mapa de arquivos | PLAN; paths reais distinguidos de módulos propostos |
| 30–35: não objetivos, estratégia, pronto, decisões, próximo artefato | §§3/11 + PLAN + AUTOREVIEW; condicionado à baseline e aos gates vigentes |

## 13. Referências técnicas externas consultadas

Consulta via Context7 em 2026-10-03; versões do SDK e capacidades reais devem ser revalidadas no spike antes de codificar.

- [Cloudflare Agents — MCP tools](https://developers.cloudflare.com/agents/tools/mcp): conexão a servidores remotos e headers server-side. Catálogo completo não deve ser exposto automaticamente ao modelo.
- [Cloudflare — transportes MCP](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/): Streamable HTTP recomendado para remoto; SSE para compatibilidade; RPC para bindings internos. Não valida o serviço Jev disponível neste ambiente.
- [Groq — STT](https://console.groq.com/docs/speech-to-text): upload real, formatos e limites por tier (25 MB free/100 MB dev na documentação consultada); os limites locais propostos são mais restritos.
- [Groq — API reference](https://console.groq.com/docs/api-reference): transcription endpoint e `json|text|verbose_json`; catálogo/modelo/conta exigem confirmação no momento da execução. Privacidade de produção não foi comprovada pela consulta da API.
