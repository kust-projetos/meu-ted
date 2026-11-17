# ADR-031 — OpenCode como núcleo conversacional do Meu TED

**Status:** aceita como decisão de direção pelo operador em 2026-10-31; **migração de produção não autorizada**.  
**Emenda:** 2026-11-16 — autonomia local e restrita de autoexecução de criação de categoria via política da API, com token delegado emitido pela API; **sem autorização de produção**.
**Data:** 2026-10-31  
**Decisão:** SELECT_B / OpenCode-first

## Contexto

O TED em produção usa `apps/agent` (Cloudflare Workers + Durable Objects), com roteamento, orquestração e estado conversacional personalizados. A API em `apps/api` e o PostgreSQL são a autoridade financeira; a PWA usa proxies privados same-origin. A investigação inicial discutiu A0 (atual), A1 (Cloudflare com tool-loop simplificado) e B (runtime OpenCode dedicado). A análise comparativa concluiu `DECISION_PENDING` porque não houve benchmark equivalente entre os três braços.

O operador escolheu **B — OpenCode** por diretriz de produto e manutenção: reutilizar capacidades nativas de um harness completo e evitar reconstruir sessões, tools, plugins, contexto e orquestração. É uma **decisão estratégica informada pelos spikes**, não uma afirmação de superioridade estatística ou de prontidão para produção.

Segundo resultados fornecidos pelo operador para a worktree local `D:/projetos/pi-ted-runtime-spike`, os SPIKEs 01–05D demonstraram bootstrap isolado, sessões, duas identidades, tools financeiras, prompt-loop real, propostas e uma cadeia Pending V2/PostgreSQL durável com confirmação sintética e recibo. Esses artefatos e traces **não estão publicados na main deste repositório**; requerem inspeção e importação seletiva. Os limites incluem provider `no-route` em restart live, ambiguidade sem contexto, enforcement de APIs diretas e paridade de produção não comprovada.

## Decisão

1. **Selecionar OpenCode como runtime conversacional alvo**, inicialmente integrado apenas em ambiente local, por fatias verticais. Parar a exploração de A1 como caminho principal, sem apagar a pesquisa A0/A1/B.
2. **Native-first:** usar SDK, sessões, ferramentas, contexto e plugins nativos; desenvolver apenas gateway confiável, adaptação financeira e projeção da UI onde necessário. Nenhum novo roteador heurístico, framework genérico de agentes, MCP financeiro ou orquestrador paralelo sem lacuna provada.
3. **API financeira permanece única autoridade:** Better-Auth, membership, autorização, Pending V2, idempotência, recibos, saldo e política de risco continuam server-side. Nenhuma autorização conferida por LLM, prompt ou sessão OpenCode.
4. **PWA permanece same-origin:** preservar `/api/agent`, `/api/backend`, DTOs e UX existente; usar adaptação gradual sob feature flag e ownership persistente por conversa, não substituir contratos silenciosamente.
5. **Enforcement real:** o SDK 2.2.4 demonstrou que `session.shell` pela API direta não é bloqueado pela policy do prompt-loop. A instância completa deve permanecer privada; o gateway utiliza façade de allowlist, isolamento de processo e catálogo efetivo verificado. Antes de upgrade revalidar essas propriedades.
6. **Visibilidade e recuperação:** respeitar ADR-027 (coletivo por padrão, privado opt-in, autoria, acesso em todas as superfícies), re-bind autenticado após restart, e política explícita de propriedade de conversa. Não transportar transcrições antigas automaticamente.
7. **Um dono por turno:** nunca disparar a mesma intenção financeira em A0 e B. Estados incertos são reconciliados pela API, sem repetição com nova chave.
8. **Freeze de produção vigente:** nenhuma mudança de tráfego, deploy, merge com efeito produtivo, escrita real ou desativação de A0 sem nova autorização explícita.

## Fases e critérios

A sequência autorizada de **trabalho local** é: consolidar evidências e código experimental → produto runtime minimamente empacotado → integrar **leitura** na PWA com feature flag OFF por padrão → habilitar escrita via contrato Pending V2 e confirmação autenticada já existente → paridade, operação, staging e somente depois eventual canary autorizado.

**Esta ADR não autoriza produção nem prova paridade.** Aceitação da arquitetura não implica que o primeiro corte implementado possa receber usuários reais.

## Relações e histórico

- Preservar ADR-003, ADR-004, ADR-010 a 015, ADR-021, ADR-026, ADR-027 e ADR-028 e seus invariantes financeiros.
- ADR-023 registra a migração técnica do Agents SDK anterior; esta ADR estabelece o **novo alvo conversacional**, sem apagar decisões históricas de segurança/implantação.
- ADR-030 permanece proposta de experimento, sem superseder ADR aceita. ADR-031 registra a direção aceita posterior, em escopo distinto; manter ambas identificadas (experimento versus decisão de direção) e não inferir autorização de produção.
- Plano autorizado: [migração OpenCode-first](../plans/2026-10-31-ted-opencode-first/README.md).

## Rollback

Até a autorização de canary, A0 permanece o único caminho produtivo. Qualquer alternância futura exige ownership persistido por conversa, drenagem da execução em voo e reconciliação de propostas/recibos na API. Rollback altera **roteamento de runtime**, nunca desfaz lançamentos ou restaura um ledger antigo.

## Emenda 2026-11-16 — autonomia de criação de categoria sob política da API

Por autorização do operador nesta sessão, o runtime conversacional OpenCode (B, `apps/ted-runtime`) poderá, em condições restritas, disparar o fluxo `propose->authorize->execute` da API para `categories.create` elegível, replicando o caminho já usado por A0 (`isAutoCreatableCategory` em `apps/api/src/approvals/policy.ts` e a flag `PENDING_V2_CATEGORY_AUTOCREATE_ENABLED`). A API permanece a única autoridade: valida a operação, autoriza-a segundo sua política, aplica idempotência e emite o recibo. Esta emenda não confere autoridade ao LLM.

**Invariante:** nenhuma autorização pode emanar de LLM, prompt, tool ou sessão OpenCode. O modelo nunca recebe credencial, capability, hash de proposta ou `operationId`. A autonomia pertence exclusivamente ao HOST do runtime, sob política server-side da API, nunca ao modelo.

**Condições obrigatórias, todas default-off:**

- A flag própria `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED` deve estar exatamente em `'1'`; a política da API deve estar habilitada e a categoria deve ser elegível.
- Falha fecha: se faltar a flag, credencial, política ou endpoint, a ação vira proposta pendente comum, nunca execução automática.
- O runtime B obtém um token delegado efêmero e device-bound por turno através de endpoint emissor dedicado da API, com escopo mínimo de capabilities financeiras necessárias, incluindo `financial.approval.autoexecute`. No lado da API, o segredo de delegação é `PI_DELEGATED_TOKEN_SECRET` (via `deps.delegationSecret`), usado para assinar e verificar pelo mesmo preHandler. `AGENT_DELEGATION_SECRET` é o nome no emissor do Agent A0; ambos os lados devem compartilhar o mesmo valor provisionado, sem jamais gravá-lo no repositório. O B autentica-se nesse endpoint com credencial de serviço de escopo baixo, injetada por perfil/variável de ambiente no processo-filho; nenhuma credencial, token ou segredo pode ser gravado no código, repositório, logs, instruções, relatórios ou instruções geradas, nem exposto ao modelo.
- Usar chave de idempotência estável. É proibida dupla execução por A0 e B para a mesma intenção, respeitando o item 7 original.
- O runtime B só pode autoexecutar quando for o dono da conversa (roteamento/pin B) e deve usar a mesma derivação de chave de idempotência da intenção lógica usada pelo A0, para não competir com ele pela mesma intenção, respeitando o item 7 original.

**Escopo:** esta emenda permite implementação local e testes. Não autoriza produção, canary, deploy, ativação de flags em ambiente real nem qualquer alteração no roteamento do workspace real junio. O congelamento do item 8 e a afirmação da seção **Fases e critérios** — “Esta ADR não autoriza produção nem prova paridade” — permanecem vigentes.

**Rollback:** desligar `TED_OPENCODE_CATEGORY_AUTOEXEC_ENABLED` retorna o runtime ao comportamento intent-only. A emenda não altera a API nem o ledger.

**Precedência no mesmo turno:** uma intenção de correção referencial (fatia T3) prevalece sobre proposta e autoexecução: quando há correção, a proposta do turno é descartada e nenhuma autoexecução é tentada. Essa precedência é silenciosa no payload além do campo de correção; a redação de saída do modelo não é alterada pelo host.

**Residuais aceitos:** o claim `request=intentionId` e o `jti` ainda não são consumidos pelas rotas V2; o token delegado vale 300s para operações do mesmo ator/device, e a autoridade final continua sendo a política da API. As rotas V2 existentes não são alteradas nesta fatia para não afetar A0. `financial.read` permanece no conjunto mínimo porque o runtime B precisa de leituras autorizadas (categorias/pending). A prova de idempotência contra dupla execução A0 x B foi coberta por teste na fatia T4b. O `forget()`/tombstone do store de categoria ainda não possui chamador de produto: a garantia de não reensinar preferência esquecida existe no store, sem interface exposta ao modelo ou ao gateway.

Referência de migração: [plano OpenCode-first](../plans/2026-10-31-ted-opencode-first/README.md).


## Nota de estado (2026-11-17)

O runtime A0 (`apps/agent`) foi descontinuado e removido do build, workspaces e CI; `apps/ted-runtime` é o único runtime conversacional. Esta nota registra o estado de implementação e não autoriza remoção de recursos ou dados históricos em produção.
