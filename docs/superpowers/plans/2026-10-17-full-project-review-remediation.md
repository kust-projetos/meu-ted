# Review crítico e plano de remediação — auditoria de 17/10/2026

**Data:** 17/10/2026. **Status:** PLANEJADO — revisão técnica e de segurança APPROVED; validação documental encerrada com limites; gates globais incompletos; implementação não iniciada.
**Goal:** transformar os dois relatórios em trabalho verificável, corrigindo diagnósticos imprecisos antes de alterar código ou operação.

## 1. Escopo, baseline e fontes

- Checkout inspecionado: `main@e74045780dbbd585c66cbbf121e53cb7472d47db`; referência local `origin/main` no mesmo SHA. Não houve fetch nem consulta live nesta revisão.
- Estado inicial: somente `docs/reports/2026-10-17-full-project-review.md` não rastreado. Esse arquivo preexistente foi preservado.
- Fonte principal: [relatório canônico](../../reports/2026-10-17-full-project-review.md), SHA-256 `aa73ddc6cf254d3dc7da0ccc7545b56b286adc3e23bb46240963a22685192676`.
- Segunda fonte lida: `project_review_2026_10_17.md`, artefato local da sessão Antigravity `775c05f3-3f3a-4ffd-9ab1-d9837542fd09`, SHA-256 `66ac060a83735ed3b0cc961f23b82bac557dbbc220d8abffe32a8ce861c822fb`. É um resumo da mesma auditoria, não uma confirmação independente.
- Contratos: [AGENTS.md](../../../AGENTS.md), [estado V1](../../MEU-TED-V1-FINAL-STATE.md), [ADR-027](../../adr/ADR-027-workspace-plurality-lifecycle-views.md), ADR-011/015 e ADR-018 nos respectivos arquivos existentes de `docs/adr/`.
- Método: inspeção de código/testes e confronto por três explorers (API, Agent/Broker e PWA), validação focada por tester e revisão independente deste plano. Evidências de execução estão na seção 8.

**Limites:** este pedido autoriza review e planejamento. Não autoriza implementar correções, commit/push/PR, deploy, flip de flags, migrações, purgas, rotação de credenciais nem comunicação externa. Nenhum resultado local prova estado atual de produção.

### Checklist desta entrega

- [x] Localizar e ler as duas fontes; fixar baseline e preservar arquivos preexistentes.
- [x] Confrontar os 25 IDs com código e testes; separar fato, hipótese e decisão de produto.
- [x] Escrever sequência, dependências, critérios de aceite e limites de rollout.
- [x] Validar o documento e registrar resultados/limites dos comandos locais (lint global inconclusivo; suíte completa não executada).
- [x] Incorporar revisão independente técnica e de segurança.

## 2. Veredito do review

**A auditoria é útil como inventário, mas seu plano não deve ser executado literalmente.** Há defeitos reais de idempotência, armazenamento do device token, integração Offline V3 e eficácia dos gates. Entretanto, alguns diagnósticos são incorretos ou extrapolam a evidência disponível.

Correções materiais ao relatório:

1. **STT:** `STT_TRANSCRIPT_NOTICE` não existe neste HEAD. O símbolo real é `AUDIO_TRANSCRIPT_NOTICE`, em `apps/agent/src/multimodal/groq-stt.ts:67-68`, sem “registrar”. Portanto, o mecanismo 1 descrito como causa universal é incorreto. O finding de UX continua aberto; isso não prova as demais causas alegadas.
2. **Grounding:** trocar `makesUnverifiedFinancialClaim(input.text)` por uma checagem apenas de `decisionText` não é uma correção segura isolada. Ela deixaria valores extraídos sem a proteção atual. A consulta delimitada de conteúdo de anexo já existe; deve ser reproduzida antes de redesenhar o fluxo.
3. **Offline V3:** `snapshot-db.ts:613-635` define cache single-slot com chave física `"v3"`; `ownerKey` representa principal/workspace. Não criar uma nova partição IndexedDB `v3:<principal>:<workspace>` como se já fosse o contrato físico.
4. **API:** `undoPayablePaymentInTx` não existe no HEAD; sua criação deve entrar no esforço de API-02. O `WriteStore` público também precisa expor corretamente os métodos transacionais reutilizados.
5. **Undo:** o fallback cross-actor é explícito no comentário FIX-188 em `approvals/undo.ts:184-193`. Removê-lo muda a política de eleição de alvo; não é uma limpeza mecânica autorizada por este plano.
6. **CI:** o timeout de 20 s com saída zero pertence ao Gitleaks. O Trivy não tem esse timer; nele o fallback inseguro observado é Docker indisponível → saída zero. Corrigir e testar os dois mecanismos separadamente.
7. **Causalidade:** ausência de mock/uso de `networkidle` e duplo trigger de deploy são fatos. Não há reprodução nova que prove a causa exata dos flakes ou do “duplo skip”.
8. **Garantias:** “não encontramos P0” não equivale a provar ausência de vulnerabilidade. Os gates verdes citados nas fontes são evidência da sessão original, não resultados automaticamente revalidados aqui.
9. **Rastreabilidade:** o canônico contém 25 IDs, dos quais 12 estão rotulados P1; o resumo os agrupa em 10 tópicos. Não usar a contagem de tópicos como contagem de defeitos independentes.
10. **Links:** a verificação direta de `lintMarkdownDocument` encontrou 85 links relativos quebrados no relatório original. `pnpm docs:lint` não o cobre na lista atual; seu PASS não valida esses links.

## 3. Matriz de triagem dos 25 IDs

Legenda: **C** = confirmado por código; **P** = parcialmente confirmado/impacto condicionado; **H** = hipótese ainda sem reprodução. Prioridades abaixo são propostas de execução, não alteração retroativa da fonte.

| ID | Review e evidência principal no HEAD | Tratamento / tarefa |
|---|---|---|
| API-01 | **C / P1.** `routes/accounts.ts:55-64`, `routes/categories.ts:44-53` descartam `claimTx`; `writes/postgres.ts` abre transações independentes. Pool padrão 4, não configuração live comprovada. | T05: uma conexão/TX para claim, efeito, auditoria e recibo; replay explícito. |
| API-02 | **P / P1.** Sete handlers sem store idempotente; `payables.ts:413` ignora erro de `safeParse`. Variante InTx de undo citada pela fonte não existe. | T06, após infraestrutura T05. |
| API-03 | **P / P2 condicionado.** Bootstraps divergem; uso produtivo de `registerPostgresProductionRoutes` não demonstrado. `server/index.ts:137-142` tem fallback genérico de invite. | T12a: provar reachability e corrigir fallback ativo separadamente; não remover legado por inferência. |
| API-04 | **C / P2.** `approvals/pending-v2.ts:460` acumula array de eventos sem limite. | T12b: limitar memória sem eliminar auditoria durável. |
| API-05 | **C / P2.** `approvals/tool-registry.ts:116-125,153-162` envolve qualquer exceção em resultado incerto. | T12c: erro pré-commit comprovado versus falha realmente incerta. |
| API-06 | **C / P2.** `routes/budgets.ts:138-154`: total fixo e parse sem tratamento; `budgets/postgres.ts:129-160`: consultas em laço. | T12d: correção funcional primeiro; otimização medida depois. |
| API-07 | **P / sensível.** `approvals/undo.ts:184-193` e `writes/postgres.ts:1517`: eleição cross-actor deliberada e atribuição genérica quando contexto não carrega ator. | T09: rastrear ator agora; política de undo exige decisão explícita. |
| API-08 | **P / P2.** `auth/better-auth-http.ts:52-63` reflete Origin no OPTIONS, mas mutações reais têm veto em `:105-110`; `server/cors.ts:15-18` lê só `CORS_ORIGIN`. | T10: hardening, sem alegar bypass de auth demonstrado. |
| AGT-01 | **P / P1 de UX.** Notice alegado é incorreto; router composto é intencional; guarda financeira bloqueia unsupported com valor; consulta só de voz não é aceita pelo contrato atual. | T08: reprodução e correção delimitada, sem relaxar INV-06/F1. |
| AGT-02 | **P / P3.** Flags diferem no trim, mas valor exato é política explícita em upload/web. Fonte também usa nome de flag STT diferente do real `TED_AUDIO_STT_ENABLED`. | T12f: documentar, não ampliar ativação por normalização global. |
| AGT-03 | **P / P3.** Concentração de responsabilidades é dívida real; contagem de linhas não demonstra defeito. | T12g: extrações pequenas somente depois de testes e estabilização. |
| BRK-01 | **P / P2 latente.** `runtime-adapter.ts:68-92` retorna mock; ligação ativa Agent→Broker não comprovada. | T12e: stub fail-closed; integração de provider real fora do escopo. |
| BRK-02 | **P / P2-P3.** `browser-login.ts:50-104`: pending sem sweep; replay usa relógio real no purge, mas `now` já participa da checagem de skew. | T12e: limites/TTL e relógio coerente, sem alegar replay bypass. |
| PWA-01 | **C / P1.** `token-store.ts:59-76` bloqueia device token com compat off; single-flight coalesce concorrentes, não chamadas sequenciais (`agent-auth.ts:101-136`). | T04: bloqueador específico da Release B. |
| PWA-02 | **P / P1.** Shell e helpers legados V2; purga de revogação em `client.ts:223-232` não cobre V3. `syncTransactionsPage` requer inventário adicional de chamadores. | T07a/b: revogação primeiro, shell depois; preservar owner/TTL. |
| PWA-03 | **C / P1.** Boot frio sem rede deixa `WorkspaceProvider` sem contexto, embora AuthGate aceite V3 válido. Erro de rede não necessariamente apaga contexto já carregado. | T07c: identidade offline validada, read-only, sem inventar autorização online. |
| PWA-04 | **P / P2.** Backend materializa corpo antes de limitar; Origin ausente é aceito. Exploit CSRF não reproduzido. | T10: streaming limitado e política de headers com compatibilidade explícita. |
| PWA-05 | **P/H / P2.** Falta de mock e `networkidle` confirmados; causa dos flakes não provada. | T11b: instrumentar e medir sem retries para mascarar falhas. |
| GOV-01 | **C / P1 no CI atual.** `ci.yml:474-479` não fornece base; script cai em diff de checkout limpo e cobre apenas decisões históricas. | T01: base válida por evento e contrato explícito de documentos/decisões protegidos. |
| GOV-02 | **C / P1.** Gitleaks: timer/ausência de ferramenta saem zero; Trivy: ausência de Docker sai zero. Não há timer de 20 s no Trivy. | T02: fail-closed em CI, skip local observável. |
| GOV-03 | **C / P1.** `check-tool-capability-inventory.mjs:116-129` pula direção registered→inventory com 54 nomes e referencia `id` fora de escopo. A direção inversa ainda existe. | T03: validar ambas as direções, cardinalidade e erros estruturados. |
| GOV-04 | **P / P1-P2.** Manifesto só valida presença de hash/versão; dois triggers sem dedupe. Incidente exato não reproduzido nesta sessão. | T11a: igualdade primeiro; dedupe/retry em etapa separada e testada. |
| GOV-05 | **P / P2.** Smoke não provisiona explicitamente browser/Node/pnpm nem valida origem com helper existente. Falha em runner fresco não reproduzida. | T11c: tornar ambiente reproduzível e comprovar em Linux limpo. |
| GOV-06 | **C / P2.** Facts e arquitetura defasados; gerador hardcoda 72/51 e PG16+; Agent/Broker já têm lint no CI. | T13: gerar fatos de código; fatos live exigem evidência live separada. |
| GOV-07 | **C / P2.** Detector de metadados focado na origem antiga; boundary fora do CI/hook; lista fixa de docs omite canônicos atuais. | T13: ampliar cobertura com fixtures sintéticas, sem divulgar identificadores reais. |

## 4. Sequência e dependências

### Trilha prioritária

1. **Onda A — confiança e preparação:** T01/T02/T03 e T04. CI e device token podem avançar em paralelo, com um integrador para `.github/workflows/ci.yml`.
2. **Onda B — integridade e privacidade:** T05 → T06; T07a (revogação V3) pode avançar em paralelo com API. T09 começa pelo inventário/contrato de ator, sem mudar política de undo.
3. **Onda C — comportamento:** T07b → T07c; T08 em trilha separada, sem bloquear a Release B por uma capacidade pós-V1. T10 após testes de auth/CSRF.
4. **Onda D — confiabilidade operacional:** T11a/b/c, T12 em fatias independentes e T13. Correções documentais factuais podem começar antes; atualizações de produção dependem de evidência autorizada.

**Antes de propor o flip da Release B:** T04 validado, T01–T03 restaurando confiança nos gates, CI do candidato verde e reconsulta do sink durável da Contabo. T05/T06 são prioridade de integridade, mas devem ter PRs e provas próprias, sem uma mega-release acoplada ao flip. Pendências relevantes precisam estar resolvidas ou aceitas explicitamente pelo operador, nunca ignoradas pelo cronograma.

**Data não é autorização:** `2026-10-24T22:09:01.594968Z` é a primeira data candidata da janela histórica, conforme `.github/workflows/release-b-reminder.yml:32-33`. Novo evento reancora a janela. Nenhum flip automático; A19, PDF, autoexecute-on e cutover continuam gateados.

### Ownership e paralelismo futuro

- API: `coder` com apoio backend/database quando necessário; T05/T06/T09 compartilham stores/rotas e devem ser serializados ou integrados por um owner.
- PWA: T04 e T07 tocam autenticação/sessão; não escrever concorrentemente em `client.ts`, `session.ts` ou fixtures compartilhadas.
- Gates: um owner de `ci.yml`; scripts T01/T02/T03 têm ownership separável.
- Agent: owner exclusivo do orquestrador durante T08; não misturar extração de monólitos T12g com bugfix STT.
- Mudanças futuras de lógica seguem RED→GREEN, coder → tester → reviewer; segurança independente para auth, revogação, idempotência, undo e trust boundaries.

## 5. Tarefas executáveis

Todos os testes abaixo são **aceites a implementar/executar**, não resultados desta sessão. Caminhos novos são explicitamente propostos; reutilizar suites existentes quando cobrem o mesmo contrato.

### T01 — Governança com diff real

- **Escopo:** `.github/workflows/ci.yml`, `scripts/check-decision-governance.mjs` e seu `.test.mjs`.
- **RED:** fixture Git descartável reproduz PR com decisão alterada sem ADR; testar push com múltiplos commits, base ausente/zero/inválida e checkout de merge de PR. Garantir que o diff corresponde à semântica escolhida, não presumir que `before...HEAD` serve a todo evento.
- **GREEN:** resolver e validar base/head por evento; CI sem base verificável falha, nunca compara silenciosamente checkout limpo. Preservar modo local da working tree.
- **Contrato:** listar decisões/documentos vivos protegidos e regra de atualização correspondente. Incluir ADR-027 D1/D2/D3 deliberadamente; edição ortográfica de docs não exige ADR novo. Não converter todo Markdown em mudança arquitetural.
- **Aceite:** alteração decisória sem pacote exigido reprova; pacote correto aprova; mudança comum não dispara falso positivo; teste atravessa coleta Git/CLI, não só função com diff fornecido.

### T02 — Scanners fail-closed no CI

- **Escopo:** `scripts/security-secrets.mjs`, `scripts/security-containers.mjs`, `scripts/security-gates.test.mjs`.
- **RED:** processos fake para timeout, binário ausente, Docker ausente, signal, código de detecção e erro de spawn; matriz local/CI.
- **GREEN:** em CI, execução indisponível/incompleta sempre retorna não-zero. Prazo CI configurado e limitado; timeout local pode ser skip explícito, nunca prova de scan. Timer Gitleaks é independente da indisponibilidade Trivy.
- **Aceite:** sucesso somente com scanner executado e código zero; `CI=true` nunca produz verde por fallback. Nenhum teste depende de scanner real ou expõe conteúdo não redigido.

### T03 — Inventário bidirecional

- **Escopo:** `scripts/check-tool-capability-inventory.mjs` e seu `.test.mjs`.
- **RED:** fixture com exatamente 54 tools contendo nome sem linha, linha api sem método/path e tabela corrompida; provar que retorna erros e não `ReferenceError`.
- **GREEN:** remover bypass da comparação nominal sem confundir 74 capacidades com 54 adapters. Derivar proveniência do registro explicitamente se necessária; cardinalidade não prova origem.
- **Aceite:** registered→inventory sempre verificado; inverse check respeita linhas planned; número canônico não mascara drift nominal; original 74/54 continua válido.

### T04 — Device token independente do bearer legado

- **Escopo:** `apps/pwa/src/lib/auth/token-store.ts`, `src/lib/api/agent-auth.ts` e `src/lib/api/__tests__/agent-auth-device-bound-mint.test.ts` (todos sob `apps/pwa/`).
- **RED:** compat `0` e `off`, três `fetchAgentConnectionToken(wsId, true)` sequenciais → um registro, três mints device-bound; cenário concorrente; logout/troca de principal/invalidation durante mint; dispositivo revogado e storage indisponível.
- **GREEN:** separar device token de session bearer; reutilizar single-flight e guards de geração existentes. Cache adicional só se necessário para storage indisponível, sempre vinculado à sessão/principal e invalidado nos mesmos eventos; não criar um segundo cache sem justificar.
- **Aceite:** cookie-session continua obrigatório; compat off não envia bearer de sessão legado; H-12 mantém binding; revogação não revive token por promessa antiga; nenhuma tempestade sequencial. Não remover device binding para “resolver” o problema.
- **Dependência operacional:** a flag pública é build-time; um rebuild testado é necessário antes de qualquer proposta de flip.

### T05 — Single-TX para contas e categorias

- **Escopo:** `apps/api/src/routes/accounts.ts`, `apps/api/src/routes/categories.ts`, `apps/api/src/writes/{store,types,postgres,keyed-mutations}.ts`. `WriteStore` está em `writes/store.ts:70`; `types.ts` contém os inputs. Testes existentes: `apps/api/tests/writes/keyed-mutations*.test.ts` e `apps/api/tests/routes/domain-keyed-mutations.test.ts`.
- **RED:** PostgreSQL 15 descartável, pool explicitamente `max:4`, quatro requisições sincronizadas no claim. Falha injetada entre efeito e registro do recibo não pode deixar efeito comitado. Cobrir explicitamente `PATCH /accounts/:id` com rollback, replay, concorrência e colisão de payload, além de create/deactivate e categorias.
- **GREEN:** repassar `claimTx` e reutilizar InTx já existentes; criar e expor `updateAccountInTx`, `createCategoryInTx` e `updateCategoryInTx`, com dispatch transacional explícito por operação e contrato em `writes/store.ts`. Nenhuma aquisição de segunda conexão dentro do producer PostgreSQL, inclusive no PATCH de conta.
- **Aceite:** claim+efeito+auditoria+recibo comitam/revertem juntos; N concorrentes com mesma key produzem um efeito; chaves distintas válidas não ficam presas no pool; replay retorna ID/body/status iguais e `Idempotent-Replayed`.
- **Segurança:** workspace/ator vêm da autenticação autoritativa. Isolar key por workspace e preservar compatibilidade dos records/hash já persistidos.

### T06 — Fechar sete mutações sem store idempotente

- **Depende de:** padrão transacional validado em T05; não copiar o wrapper defeituoso.
- **Escopo:** `apps/api/src/routes/{categories,payables,goals,subscriptions}.ts`, stores e keyed-mutations desses domínios.
- **Lista fechada:** `POST /categories/apply-defaults`, `POST /categories/:id/delete`, `POST /payables/:id/unpay`, `POST /payables/:id/cancel`, `POST /goals/:id/cancel`, `POST /subscriptions/:id/cancel`, `PATCH /subscriptions/:id`.
- **RED:** por rota: key ausente, mesma key/mesmo payload concorrente e sequencial, mesma key/payload divergente, key igual em outro workspace, falha após efeito antes do recibo. `payables/:id/cancel` com body inválido deve retornar 400 sem write.
- **GREEN:** lookup/record + efeito na claim TX; adicionar `undoPayablePaymentInTx` e demais variantes faltantes, não presumir sua existência.
- **Aceite:** exatamente um efeito por intenção/key; resposta original reproduzida mesmo quando estado já é terminal; nenhuma duplicação de reversão de pagamento. Chaves diferentes NÃO são dedupe semântico de pedidos distintos.

### T07 — Offline V3 completo em três fatias

**T07a — revogação (prioridade de privacidade):** `apps/pwa/src/lib/api/client.ts`, `lib/session.ts`, `lib/auth/offline-identity.ts`, `lib/state/snapshot-db.ts`; ampliar `offline-purge-triggers.test.ts`, `offline-cleanup-v3.test.ts` e suites de revogação do workspace. Reutilizar purga canônica, não duplicar rotinas.

- **Aceite:** revogação autoritativa limpa identidade e snapshots V2/V3; leitura imediatamente bloqueada mesmo se IndexedDB falhar/atrasar; resposta assíncrona antiga não regrava dados. `403` de role/escopo comum não apaga sessão nem outros workspaces. Logout/troca de principal/workspace também cobertos.

**T07b — shell e helpers:** `apps/pwa/public/offline-shell.js`, `src/sw.ts`, `lib/state/{snapshot-db,sync-engine}.ts`. Conferir chamadores de `syncTransactionsPage` antes de mudar assinatura. Usar o envelope V3 single-slot existente, `ownerKey`, TTL e último auth online; não reatribuir V2 offline.

- **Aceite:** shell apresenta somente dados do principal/workspace vinculados online, cobre `/compromissos` e `/hub/*`, bloqueia owner divergente/idade inválida/corrompido, não renova idade offline; hash/revisão em `sw.ts` corresponde aos bytes publicados. Não usar device token como chave/dono.

**T07c — contexto de workspace:** `apps/pwa/src/lib/auth/workspace-context.tsx` e `features/auth/AuthGate.tsx`; suites existentes de workspace e boot sem workspace.

- **Aceite:** cold boot `unreachable` com V3 válido habilita apenas leitura do workspace vinculado; nenhum snapshot/expirado/revogado dá estado bloqueado explícito. Não sintetizar membership/owner a partir de ID local. Reconexão revalida membership/lifecycle antes de reabrir mutações. Arquivado continua read-only; deleted não renasce por cache.

### T08 — STT com reprodução, não relaxamento de segurança

- **Escopo:** `apps/agent/src/orchestration/{intent-router,attachment-content-query,conversation-orchestrator}.ts`, `src/multimodal/groq-stt.ts`, testes `tests/attachments/{groq-stt,audio-stt-turn,attachment-autoexecute-veto}.test.ts` e `tests/orchestration/attachment-content-query*.test.ts`.
- **Primeiro:** reproduzir com adapter STT fake e a mesma shape server-side nos canais REST e SDK: texto digitado perguntando sobre áudio; áudio sozinho; áudio com “conta/saldo”; valor sem verbo; instrução “sim confirmo/desfaz/esqueça” dentro do transcrito; pergunta enquanto há rascunho recuperável.
- **Invariantes:** decisão só do texto digitado; transcrito é DADO; nenhum anexo autoriza confirmação/cancel/undo/forget/autoexecute; documento pode completar proposta conforme contrato atual, mas nunca escrever sem confirmação válida. Resposta financeira exige evidência e atribuição de origem.
- **Correção recomendada:** primeiro consertar o caminho já suportado de pergunta digitada + extração admitida, aproveitando `resolveAttachmentContentQuery`. Separar falha de leitura de contas de unsupported com valor; uma não prova causa da outra.
- **Decisão pendente:** experiência de áudio sem texto. Default seguro preservado: não promover transcrição a `decisionText`; orientar usuário ou propor preview documental explicitamente delimitado. Aceitar voz como comando de autorização é expansão de contrato, fora desta correção.
- **Aceite:** resposta sobre conteúdo admitido usa somente dados do anexo, não afirma registro/saldo real; sem extração não finge leitura; duas entradas de canal equivalentes; prompt injection e números não verificados continuam fail-closed. Não alterar coortes/providers/modelos/PDF para testar.

### T09 — Autoria de auditoria e política de undo

- **Escopo:** `apps/api/src/writes/postgres.ts`, callsites `lookupOrRecord`, `src/approvals/undo.ts`; testes de undo/isolamento e integração PG.
- **Fatia factual:** inventariar contextos e transportar ator autenticado até novos records. Não aceitar actorId do body nem reescrever autoria histórica `device` por inferência. Preservar replay/hash de records anteriores.
- **Fatia decisória (bloqueada):** operador define se undo implícito é só próprio ou pode eleger head do workspace. Não remover fallback nem habilitar cross-actor explícito adicional antes dessa definição.
- **Aceite após decisão:** matriz dois atores/dois workspaces, operação head já consumida, alvo explícito não autorizado, redelivery e concorrência; zero reversão de predecessor silencioso e confirmação vinculada ao alvo exibido.

### T10 — Borda, corpo e CORS

- **Escopo:** `apps/pwa/src/app/api/backend/[...path]/route.ts`, proxy Agent como referência, `src/proxy-utils.ts`; `apps/api/src/auth/better-auth-http.ts`, `server/cors.ts` e testes existentes de proxy/auth.
- **RED:** corpo chunked acima do teto sem Content-Length e com header falso; abort; Origin não permitido no OPTIONS e na mutação; ausência de Origin com `Sec-Fetch-Site: cross-site`; chamadas legítimas same-origin e não-browser.
- **GREEN:** reutilizar leitura bounded e env validado sem ampliar upstreams; política explícita de ausência de Origin/Fetch Metadata que preserve clientes legítimos e recuse cross-site mutante. Fallback CORS para trusted origins somente após parsing/validação equivalentes.
- **Aceite:** corta stream antes de materializar excesso; nenhum request proibido atinge upstream; preflight não reflete Origin arbitrário; cookies, CSRF e H-12 permanecem independentes. Não alegar exploração demonstrada onde há só hardening.

### T11 — Deploy, smoke e flakes (três PRs separáveis)

**T11a:** `.github/workflows/agent-deploy.yml`, `pwa-deploy.yml`, produtor do manifesto em `ci.yml` e `scripts/validate-deploy-workflows.test.mjs`.

- Comparar hash do lockfile e versão normalizada da mesma instalação de Wrangler usada pelo build/deploy; preservar fonte/run/SHA e checagens fork/event/freshness. Fixtures: campo ausente, whitespace, hash divergente, versão divergente, run indevido → bloqueia.
- Só depois tratar dedupe. Simular eventos dos dois CIs, um ainda rodando, falha posterior, rerun e mudança de main. “ATTESTED anterior para SHA” não basta sem mesmo ambiente/identidade e política de redeploy/rollback; verde sem deploy não é attestation. Não desligar gatilhos nem skipar segundo evento sem provar liveness e retry.

**T11b:** `apps/pwa/e2e/support/harness.ts`, `apps/pwa/e2e/run-ci.sh` e specs `pwa-runtime.spec.ts`/`push-runtime.spec.ts`.

- Capturar trace/rede/SW de falha antes de afirmar causa. Alinhar mock de pending e substituir espera de rede por estado observável da aplicação. O SW pode contornar `page.route`; confirmar que a fixture intercepta o tráfego de fato.
- Aceite: PWA/PUSH passam 10 repetições locais sem retries e sem egress live; relatar amostra, não prometer eliminação definitiva. Não aumentar timeout/retry para obter verde.
- Para executar essa amostra com segurança, estender o runner existente com a opção **proposta, ainda inexistente** `E2E_RUNTIME_REPEAT_EACH` (default 1), aplicada aos projetos runtime no mesmo processo que fixa o ambiente antes do build. Testar valor inválido, isolamento herdado e repetições reais; não exportar env em um subprocesso e presumir que persistirá no PowerShell chamador.

**T11c:** `.github/workflows/production-smoke.yml`, `scripts/production-smoke-contract.test.mjs`, `validate-deploy-origins.mjs` e testes existentes.

- Setup explícito de Node/pnpm e Chromium; validar URL antes de rede. Primeiro provar em runner Linux limpo/target sintético; live só mediante autorização própria para o ambiente. Preservar smoke read-only GET/HEAD/OPTIONS e ausência de fixture server em modo produção.

### T12 — Residual funcional, runtime e dívida (não agrupar em uma remoção de legado)

- **T12a / API-03:** rastrear entrypoints com grep, scripts start, Dockerfile e testes de composição. Corrigir erro tipado 503 no invite ativo com teste; unificação/remoção de bootstrap ou twins depende de reachability e plano de compatibilidade. Remover legado é decisão separada de cutover, não dependência para corrigir um invite.
- **T12b / API-04:** buffer de eventos limitado ou coletor opt-in; soak valida limite e ordem. Confirmar que não descarta o sink de auditoria de negócio; teste de audit não justifica array infinito em produção.
- **T12c / API-05:** distinguir erro determinístico antes do commit de incerteza após write. Só relançar `DomainError` quando sua origem provar rollback; preservar `executing`/reconciliação para commit possível. Testes de categoria inexistente, rollback e falha de recibo pós-commit.
- **T12d / API-06:** total correto e query inválida 400 com testes de rota; depois benchmark/contagem de queries e agregação SQL preservando workspace, períodos, moeda e centavos. Não trocar N+1 por explosão de concorrência no pool.
- **T12e / BRK-01/02:** stub retorna erro tipado `codex_runtime_not_configured`, jamais completion inventada; manter contrato do endpoint. Limite/TTL de pending logins, consumo único e relógio injetável testados. Não ativar broker nem conectar provider/credencial real.
- **T12f / AGT-02:** documentar matriz de flags e testar valores inválidos. Não aplicar trim universal: valor exato fail-closed é intencional para capacidades de egress.
- **T12g / AGT-03:** extrair apenas módulos com contrato e cobertura demonstrados, uma responsabilidade por fatia, após estabilização. Não criar refactor amplo baseado só em tamanho de arquivo.

### T13 — Documentação e cobertura real dos gates

- **Escopo:** `scripts/generate-documentation-facts.mjs`, `docs/architecture/runtime-facts.json`, `docs/{ARCHITECTURE-CURRENT,PRODUCT,ROADMAP,MEU-TED-V1-FINAL-STATE}.md`, `README.md`, `AGENTS.md`, `.husky/pre-commit`, `ci.yml`, `scripts/{lint-docs,check-public-safety,run-final-validation}.mjs` e respectivos contratos.
- Derivar contagens/última migration do código, distinguir versão de schema do facts de versão do produto e fatos live. Não trocar automaticamente SHAs documentados por HEAD nem chamar V061 “aplicada em produção” por existir no checkout.
- Corrigir notas stale de lint Agent/Broker; acrescentar lint de llm-contracts no CI e sua cobertura ausente em validate:final. Incluir boundary no CI/hook segundo contrato do projeto e docs vivos na lista do lint.
- Cobertura de metadados Contabo: fontes autorizadas e fixtures sintéticas; não copiar IPs/chaves/usuários reais para o plano, tests ou logs públicos.
- Corrigir em alteração própria os 85 links relativos do relatório original e incluí-lo na validação explícita; preservar conteúdo histórico e registrar erratas técnicas, não reescrever como se o diagnóstico original já estivesse certo.
- Aceite: gerador não reintroduz drift, docs/links cobertos, fixtures negativas dos gates reprovam, edição inofensiva não vira exigência de ADR, nenhuma alteração em produção.

## 6. Validação planejada para a implementação

**Shell:** PowerShell, diretório raiz do repositório, um comando por execução. Node e pnpm conforme manifests; não usar sintaxe Unix de env inline no Windows.

**Pré-requisito de execução futura:** o lint local desta sessão não terminou no Biome (ver seção 8), e `pnpm test` completo não foi executado. Antes de integrar correções, obter resultados reais desses dois gates em ambiente funcional, preferencialmente runner Linux/CI, ou diagnosticar o travamento local. Aprovação do plano não dispensa os gates obrigatórios do projeto.

### Gates obrigatórios por fatia integrada

```powershell
pnpm docs:lint
pnpm typecheck
pnpm test
pnpm lint
pnpm governance:check
pnpm capabilities:check
pnpm write-policy:check
pnpm architecture:check
pnpm boundary:check
pnpm test:skip-gate
pnpm action-pins:check
pnpm plans:check
pnpm public-safety --strict
```

Testes focados existentes, a ampliar com os casos RED acima:

```powershell
node --test scripts/check-decision-governance.test.mjs scripts/security-gates.test.mjs scripts/check-tool-capability-inventory.test.mjs scripts/validate-deploy-workflows.test.mjs
node --test scripts/production-smoke-contract.test.mjs scripts/documentation-facts-contract.test.mjs scripts/canonical-docs-contract.test.mjs
pnpm --filter pwa exec vitest run src/lib/api/__tests__/agent-auth-device-bound-mint.test.ts src/lib/state/__tests__/snapshot-v3.test.ts src/lib/state/__tests__/offline-purge-triggers.test.ts
pnpm --filter pi-finance-agent exec vitest run tests/attachments/groq-stt.test.ts tests/orchestration/attachment-content-query.test.ts tests/orchestration/attachment-content-query-toolfree.test.ts
pnpm --filter pi-finance-agent eval:ted-v2
```

### PostgreSQL e concorrência — requisito, não skip aceitável

Ambiente descartável PG15, schema canonical, `DATABASE_URL_TEST` e `DB_TEST_MARKER` resolvidos por fixture autorizada; `requireTestDatabase` deve confirmar marcador antes de DDL/DML. Nunca herdar `DATABASE_URL` de produção nem usar dump real. Os testes atuais de keyed mutations usam pool 8; acrescentar prova específica com pool 4.

```powershell
pnpm --filter meu-ted-api exec vitest run tests/writes/keyed-mutations-postgres.test.ts tests/writes/domain-keyed-mutations-postgres.test.ts
pnpm --filter meu-ted-api test:integration:all
pnpm --filter meu-ted-api test:concurrency
pnpm --filter meu-ted-api test:xlt
```

Gate financeiro só passa com testes relevantes realmente executados (sem skip), uma unidade de efeito por key, rollback verificado por SELECT e isolamento workspace/ator. Suites globais sem PG não substituem essa prova.

### Browser local — Offline e estabilidade

Preparar contratos compartilhados quando necessário e usar `apps/pwa/e2e/run-ci.sh`, que fixa proxies/fixtures locais e limpa opt-ins live **antes do build e no mesmo processo dos testes**. O comando atual seguro, com Git Bash instalado no caminho padrão desta máquina, é:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' apps/pwa/e2e/run-ci.sh
```

Hoje ele roda uma vez cada projeto. **Somente após implementar e testar a extensão proposta em T11b**, a amostra de 10 repetições poderá usar a opção abaixo. Ela ainda não é um comando de validação disponível no baseline:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -c 'E2E_RUNTIME_REPEAT_EACH=10 bash apps/pwa/e2e/run-ci.sh'
```

Não lançar Playwright avulso após o runner assumindo que herdará os exports: um processo-filho não modifica o ambiente do chamador. O runner deve transmitir `--repeat-each` às duas suites runtime com `--retries=0`, mantendo as origens isoladas durante toda a amostra.

Offline exige teste de cold navigation com SW real, cache V3-only, owner divergente, TTL, revogação, troca de workspace e reconexão. Não simular todo offline apenas com mocks de hooks.

## 7. Rollout futuro, recuperação e decisões humanas

- **Preparação, não execução:** cada PR tem testes do próprio contrato e review independente. Required checks existentes permanecem; planos não dispensam gates.
- **API:** release somente pelo wrapper autorizado na Contabo, após backup verificável e prova de boot da imagem candidata com o ledger atual. Mudanças propostas não exigem migration por padrão. Se surgir necessidade, replanejar e autorizar explicitamente; não editar V001..V061.
- **Rollback da API:** não presumir que imagem antiga sobe com ledger atual; o incidente de V060 já demonstrou o contrário. Validar compatibilidade da imagem de rollback antes do swap; sem prova, adiar ou preparar forward-fix. Backups não são licença para apagar/restaurar dados reais.
- **Cloudflare/PWA:** artefato do SHA aprovado, smoke read-only e attestation correspondente. Compatibilidade SW/envelope deve ser testada; rollback do app não pode ressuscitar dados revogados nem reabilitar bearer legado silenciosamente.
- **Release B:** consulta durável read-only com precisão integral e filtro exclusivo após âncora, janela zero de 14 dias, autorização humana e rebuild PWA testado. Alteração de `SESSION_BEARER_FALLBACK_ENABLED`/flag pública somente em tarefa operacional autorizada, com plano de recuperação próprio.
- **Gates separados:** política de undo cross-actor; UX de áudio sem texto; ativação de provider/capability/coorte; cutover F3–F5; purge/retention; qualquer migration ou credencial. Nenhum desses gates é resolvido pela prioridade de um finding.

## 8. Evidências desta sessão e limites

### Executado durante este review

- Leitura integral dos dois arquivos; HEAD e working tree registrados; SHA-256 das fontes calculados por `node:crypto` após indisponibilidade de `Get-FileHash` no shell.
- `lintMarkdownDocument('docs/reports/2026-10-17-full-project-review.md')`: **85 links quebrados**; diagnóstico da fonte, não mudança feita nela.
- Preflight: `MULTI_WORKER`, participação observada de três explorers. Bridge shadow retornou `disabled / NOT_COMPARABLE`; nenhuma flag foi alterada.
- Tester independente e repetição integrada pelo Planner: **29/29 testes contratuais PASS** nos cinco arquivos `check-decision-governance.test.mjs`, `security-gates.test.mjs`, `check-tool-capability-inventory.test.mjs`, `validate-deploy-workflows.test.mjs` e `production-smoke-contract.test.mjs`. Os dois testes de arquivo de lint/plans também passaram (Node reporta 4 testes incluindo agrupamentos).
- Probes descartáveis do tester reproduziram `ReferenceError: id is not defined` em linha api sem method/path e ausência da checagem registered→inventory com exatamente 54 nomes. A direção inversa ainda acusa o adapter api removido; isso não demonstra que qualquer renomeação passe silenciosamente.
- `pnpm governance:check` e `pnpm capabilities:check`: PASS local; o primeiro sem diff decisório, o segundo 54 tools/74 linhas. Esses passes não anulam os defeitos reproduzidos/de cobertura.
- Planner: `pnpm public-safety --strict`, `pnpm boundary:check`, `pnpm architecture:check` e `pnpm write-policy:check`: **PASS** (519 arquivos de produção; 183 escritas/183 linhas). Public-safety cobre arquivos rastreados, não certifica este plano ainda não rastreado.
- Reviewer técnico: **APPROVED** após corrigir omissão de `updateAccountInTx` e apontar `WriteStore` em `writes/store.ts`. Delta de execução isolada dos testes browser também revisado e aprovado.
- Security reviewer: **APPROVED**, inclusive re-review do delta T05/T11b; aprovação do planejamento, não do código futuro ou de produção.
- `Test-OrchestrationDoneCompliance`: **COMPLIANT**, com seis workers materialmente participantes (três explorers, tester, reviewer e security-reviewer). Isso atesta participação, não substitui testes ou revisão técnica.
- Hashes das duas fontes rechecados: **UNCHANGED**. Nenhum arquivo de código/configuração foi editado pelo Planner.
- Rechecagem integrada do plano após os ajustes: lint específico **zero links inválidos** e matriz com **25 IDs únicos**. Sondas do inventário também reproduzidas pelo Planner com fixture ASCII vazia, após uma primeira fixture com travessão não acionar a condição esperada no transporte PowerShell→Node.
- `pnpm action-pins:check` e `pnpm test:skip-gate`: **PASS**, 90 uses fixados e 100 arquivos críticos sem novos skips incondicionais (8 allowlisted históricos).
- Tester: `pnpm plans:check` **PASS** (22 planos), `pnpm docs:lint` **PASS** (12 docs), `pnpm governance:check` **PASS** e `pnpm typecheck` **PASS** (5/5 pacotes). Warning DEP0190 presente no log de typecheck, sem erro de compilação; não foi investigado como causa de outro problema.
- Contratos documentais adicionais: tester reportou **24/24 PASS** em `scripts/canonical-docs-contract.test.mjs` e `scripts/documentation-facts-contract.test.mjs`.
- `pnpm lint`: **INCONCLUSIVO / TIMEOUT**, 600 s parado no primeiro filtro (`@pi-finance/llm-contracts`, `biome check src`); diagnóstico isolado desse filtro também expirou em 180 s. Nenhum novo retry feito. A causa do travamento não foi demonstrada; ausência de diagnóstico não é PASS nem prova de erro no código.
- `pnpm test` raiz: **NÃO EXECUTADO** nesta sessão (orçamento após timeouts; alteração somente documental). Os testes contratuais acima não substituem a suíte completa. Portanto, **não há aceite global de código nem declaração de todos os gates obrigatórios verdes**.
- Logs locais do tester: arquivos `g-plans.log`, `g-docs.log`, `g-gov.log`, `g-typecheck.log`, `g-lint.log` e `g-lint-contracts.log` no diretório temporário aprovado do OpenCode. O Planner inspecionou os logs de typecheck e ambos os lint; são UTF-16 e exigiram leitura com encoding explícito.

### Não provado por esta entrega

- Não foram reproduzidos starvation PG, flake de browser, incidente de deploy ou STT live; inspeção estática não prova frequência/alcance produtivo.
- Não houve scan real Gitleaks/Trivy nem teste de exploração. PASS de teste contratual não certifica segurança ou cobertura completa.
- Não se afirma estado atual de flags, ledger, coortes ou SHAs de produção; fontes históricas devem ser revalidadas antes de operação.
- Critério de término da **implementação futura**: aceites T01–T13 atendidos ou explicitamente diferidos, testes executados sem skips indevidos, reviews encerrados e gates humanos preservados. Este documento não marca correções como feitas.

## 9. Primeiro passo recomendado

Iniciar T04 (device token, sem flip) e T01–T03 (confiabilidade dos gates), em PRs pequenos e com ownership de CI serializado. Em seguida T05/T06 com PG descartável e T07a de revogação. Não iniciar por refactor dos monólitos, remoção de legado ou relaxamento do grounding STT.
