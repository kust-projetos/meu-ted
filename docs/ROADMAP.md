# Meu Ted — Roadmap

**Last verified:** 2026-10-01
**Reference:** [`runtime-facts.json`](architecture/runtime-facts.json)

| Marco | Status | Evidência/limite |
| --- | --- | --- |
| P0–P5 e paridade financeira | Histórico consolidado | Base anterior documentada em [`ESTADO-E-PROXIMOS-PASSOS.md`](ESTADO-E-PROXIMOS-PASSOS.md); não altera o estado de produção. |
| Remoção do Bridge/Pi legado | Concluído | WhatsApp Bridge e extensão Pi removidos dos workspaces, CI e runtime em 2026-08-25 (`f640e84`); `WorkspaceAgent` descomissionado na V4 ([ADR-016](adr/ADR-016-workspace-agent-decommissioning.md)). |
| Consolidação TED Agent V2 | Concluído | Pipeline único, pending operation V2, executor restrito e invariantes arquiteturais; operacional em produção (verificado em 2026-10-01). |
| Hardening TED V3 | Concluído | ADR-012/013/014 + SPEC V3; inclui o contrato de receipt/approval à prova de falso-estado (PR #35, `fd4edec`) e session-first cookie-only. |
| Autorização TED baseada em risco (V5) | Implementado; **SHADOW em produção desde 2026-10-02** (`37b9f47`) | PRs #58/#62/#63/#64: policy determinística na API, endpoint/capability com `TED_RISK_BASED_AUTOEXECUTE`, fluxo Agent e UI/E2E para turnos autoexecutados e manuais. PendingOperation V2 e receipt permanecem. Fase 22 executada: API deployada via wrapper (lane source-build, backup `pi-canonical-prerelease-20261002T142919Z`, rollback tag preservada, V059 aplicada ao canônico antes do swap) e flag `shadow` ativa; PWA/Agent deployados via Cloudflare (smokes `37b9f47`). Próximo: canary (`on`) **só após** sink/telemetria suficiente (undo-after-autoexecute) — ver [observabilidade](ops/ted-autoexecute-observability.md) e [ADR-026](adr/ADR-026-risk-based-mutation-authorization.md). |
| Hardening V4 / V4.1 closure | Concluído | PR #11 (merge 2026-09-22, `4e4e83c`); rollout completo de API, PWA e Agent na mesma release `2d7bdf8` com rollback tagado. |
| CI, containers e deploys gateados | Concluído | Billing do GitHub Actions resolvido (repo público, 2026-09-25); branch protection em `main` (sem push direto); deploys verificam `head_repository` e `workflow_run.event == push`; falso-verde do comprehensive E2E provado corrigido (2026-10-01). |
| Dados canônicos (conversor + cutover) | Em andamento — gate humano | A API de produção serve o esquema canônico `pi_financeiro_canonical` (rota fresh concluída); repair commitado com residual zero (32 contas vivas) e reconciliação `--provenance=fresh` drifted=0; conversor pronto ([ADR-025](adr/ADR-025-canonical-converter.md)) com F2 smoke PASS e real-dump NO-GO documentado (irrelevante para produção). A aposentadoria do legacy/archive (F3–F5) é gate humano por design ([ADR-024](adr/ADR-024-legacy-canonical-conversion-policy.md)). |
| Release B (descomissionamento do bearer legado) | Em andamento — gate humano | Sink durável `auth.request.legacy_bearer_used` em produção (PRs #51/#52); janela de observação de 14 dias: 2026-10-01T20:14Z → 2026-10-15T20:14Z; flip somente com contagem zero. |
| Itens future-dated | Planejado | Compat localStorage/bearer em 2026-12-01 (ADR-011/015) e allowlists (`pwa-audit` + `.trivyignore`) em 2026-12-31; workflows-lembrete ativos e idempotentes. |

## Próximos passos (gates humanos)

Nenhum trabalho de engenharia está pendente ou bloqueando o time. Os passos
restantes são gates humanos com data:

1. **2026-10-15 — gate Release B:** com zero eventos
   `auth.request.legacy_bearer_used` na janela, flipar
   `SESSION_BEARER_FALLBACK_ENABLED=off` na VPS e rebuild do PWA com
   `NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off`.
2. **Quando o operador decidir — cutover residual:** aposentar o legacy/archive
   (a API já serve o canônico). A transação ambígua `49c01613…` do legacy só
   exige decisão humana se o caminho legacy→canonical for reanimado
   (recomendação: não reanimar).
3. **2026-12-01 e 2026-12-31 — revisões future-dated** (workflows-lembrete já
   criados; nenhum rito manual necessário antes das datas).

Evidência corrente: [`reports/2026-10-01-acceptance-closure.md`](reports/2026-10-01-acceptance-closure.md) e
[`reports/2026-10-01-open-gates-execution.md`](reports/2026-10-01-open-gates-execution.md).

## Hardening TED V3 — decisões registradas (2026-09-14)

SPEC: [`MEU-TED-SPEC-HARDENING-PONTA-A-PONTA-V3.md`](MEU-TED-SPEC-HARDENING-PONTA-A-PONTA-V3.md) ·
Plano: [`superpowers/plans/2026-09-14-meu-ted-v3-hardening.md`](superpowers/plans/2026-09-14-meu-ted-v3-hardening.md)

| ADR | Decisão |
| --- | --- |
| [`ADR-012`](adr/ADR-012-approval-contract-propose-validation-and-effects-registry.md) | Approval Tool Contract como fonte única + validação canônica no propose; Effects Registry separado; semântica de identidade do MutationReceipt (`mutationId` universal, `operationId` só no TED). |
| [`ADR-013`](adr/ADR-013-execution-recovery-lease.md) | Protocolo TX1 (claim) → executor fora da transação → TX2; lease com expiração e reconciliador idempotente; recovery de `confirmed` só por reemissão; migration V052 aditiva. |
| [`ADR-014`](adr/ADR-014-mutation-draft-multi-turno.md) | Invariantes do MutationDraft (sem autoridade financeira), ciclo com estado `proposing`, consumo atômico e handoff recuperável draft → PendingOperation (0 ou 1, INV-09/INV-10). |
