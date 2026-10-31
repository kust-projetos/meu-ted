# ADR-031 — OpenCode como núcleo conversacional do Meu TED

**Status:** aceita como decisão de direção pelo operador em 2026-10-31; **migração de produção não autorizada**.  
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
- A investigação propôs uma ADR-030 na branch experimental `test/ted-f2b0-no-retry-controlled`; reconciliar sua numeração/status antes de eventual merge de documentação antiga. Não publicar duas decisões contraditórias.
- Plano autorizado: [migração OpenCode-first](../plans/2026-10-31-ted-opencode-first/README.md).

## Rollback

Até a autorização de canary, A0 permanece o único caminho produtivo. Qualquer alternância futura exige ownership persistido por conversa, drenagem da execução em voo e reconciliação de propostas/recibos na API. Rollback altera **roteamento de runtime**, nunca desfaz lançamentos ou restaura um ledger antigo.
