# Meu TED — Migração OpenCode-first

**Decisão:** SELECT_B, conforme [ADR-031](../../adr/ADR-031-ted-opencode-first.md).  
**Estado:** documentação para iniciar implementação **local**; produção congelada.  
**Base remota estudada:** `main` em `3489352f47415d5b74aadb67d59db8a40a5ab132`. Verificar se avançou antes de implementar.

## Leia nesta ordem

1. [SPEC de produto e interfaces](SPEC.md) — boundaries, contratos, requisitos.
2. [Plano de implementação](PLAN.md) — fatias, gates e limites de autonomia.
3. [Handoff e início imediato para o agente](AGENT-START-HERE.md) — comandos e primeira missão.
4. [Paridade, rollout e rollback](PARITY-ROLLOUT.md) — decisões para produção, ainda não autorizadas.
5. [ADR-031](../../adr/ADR-031-ted-opencode-first.md) — decisão arquitetural.

## Fontes e distinção de evidência

**Na `main`:** `apps/api`, `apps/agent`, `apps/pwa`, `packages/llm-contracts`, [arquitetura atual](../../ARCHITECTURE-CURRENT.md), [ADR-010](../../adr/ADR-010-pending-operation-v2.md), [ADR-011](../../adr/ADR-011-same-origin-ted-session.md), [ADR-026](../../adr/ADR-026-risk-based-mutation-authorization.md), [ADR-027](../../adr/ADR-027-workspace-plurality-lifecycle-views.md) e [AGENTS.md](../../../AGENTS.md).

**Fora da `main`:** investigação original na branch `test/ted-f2b0-no-retry-controlled` (`docs/ted-runtime-investigation/`) e artefatos locais na worktree `D:/projetos/pi-ted-runtime-spike` (SPIKEs 01–05D, relatórios e traces). **Não inferir que esses arquivos estão versionados/remotamente disponíveis.** Revisar e importar apenas conteúdo necessário; nada de reset, clean ou cherry-pick indiscriminado.

**Provas relatadas:** um caminho LLM → propose_expense → Pending V2 persistente → confirmação sintética → lançamento e recibo de mesma proposta. **Não provado:** equivalência com A0 em todas as capabilities, UX de confirmação em produção, restart conversacional live completo, operação multiusuário em carga, custos faturados ou prontidão para deploy.

## Critério de sucesso

O projeto estará em condição de **avançar para homologação**, não produção, quando uma fatia PWA → gateway → OpenCode → API → PWA estiver operacional e testada com identidade real **somente em ambiente local/staging autorizado**, sem perda dos contratos de segurança e UX. Nenhuma aprovação de SPike é autorização de deploy.

## Princípio operacional

Native-first; usar código próprio somente onde o OpenCode não é autoridade (autenticação, escopo de conversa, apresentação PWA e API financeira). Não transformar migração em outro harness.
