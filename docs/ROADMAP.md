# Meu Ted — Roadmap

**Last verified:** 2026-10-13
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
| Release B (descomissionamento do bearer legado) | Em andamento — gate humano (**flip ABORTADO em 13/10**) | Sink durável `auth.request.legacy_bearer_used` em produção (PRs #51/#52); leitura cuidadosa de 13/10 com filtro exclusivo `> 2026-10-02T21:36:06Z`: **COUNT=136** (MIN `2026-10-02T21:36:06.027881Z`, MAX `2026-10-10T22:09:01.594968Z`; por dia: 10-02=2 pós-âncora, 10-03=28, 10-04=57, 10-08=26, 10-10=23, demais dias 0; 2 workspaces distintos, actor sempre device, burst final de 12 eventos em ~1s — retry-storm provável). A sonda anterior (COUNT=0) foi **superada** por esta leitura. Nova janela zero-14-dias fecha **~2026-10-24T22:09Z** se nada mais ocorrer; re-verificação com a mesma query (evidência: [`reports/2026-10-03-vps-migration-contabo.md`](reports/2026-10-03-vps-migration-contabo.md)). |
| Itens future-dated | Planejado | Compat localStorage/bearer em 2026-12-01 (ADR-011/015) e allowlists (`pwa-audit` + `.trivyignore`) em 2026-12-31; workflows-lembrete ativos e idempotentes. |
| TED Agent A19 (anexos/decision/STT/vision/PDF) | **NOT READY — PR #154 (forward-fix do outage da API) vigente como `414aefa` em API+Agent+PWA; E2E live-mobile-full PASS em 13/10; PDF segue fail-closed** | API+Agent+PWA `414aefa` (PR #154, forward-fix do outage da API em 13/10 — crash `FST_ERR_DUPLICATED_ROUTE` + rollback inválido para imagem com manifesto V059 × ledger V060; suite 2493 pass, review APPROVED, swap manual + smokes verdes, 0 restarts; detalhe em `MEU-TED-V1-FINAL-STATE.md`); deploys anteriores atestados em `e57bcec` (`38326659522`, `38326659650`) e `bc2ba9e` (`38314671723`, `38314671758`); rotação do `POSTGRES_PASSWORD` exposto em transcript PENDENTE e toques manuais no banco congelados até o closure. `TED_PDF_TEXT_ENABLED=0` e `pdfTextProcessorOverride()` retorna `undefined` incondicionalmente. Upload/R2 preservados; testes provam caminho `unsupported` e zero parser, e `pdf-gate-worklimit.test.ts` passa 10/10 local. E2E live-mobile-full **PASS** em 13/10 (~2.6 min: login, conta, transação, extrato, TED leitura com valores, TED mutação com aprovação; `workspaceWriteViolations` vazio; só Test Family). Regra de lifecycle R2 de 1 dia configurada por autorização expressa do operador; deleção física **não validada** (assíncrona, sem bucket de teste isolado). STT/Vision com canary API-direto em 13/10 (Vision FULL PASS, STT PARCIAL com finding aberto) + canary UI via PWA `df23c3d` (Vision FULL PASS x3; STT verbatim OK no histórico, turnos falham — finding aberto; M8 falso-positivo registrado) e sem mudança de coorte; autoexecute segue `SHADOW` (último conhecido, não re-verificado live). Privacidade/egress/retention continua gate para eventual reativação. A19 e V1 permanecem **NOT READY**. Em 13/10: operador declarou 3x que `junio` contém só dados de teste (reconciliação em `MEU-TED-V1-FINAL-STATE.md`); canary API-direto Vision **FULL PASS** (upload 200 + turno completed, extração exata, zero mutação) e STT **PARCIAL** (transcrição Groq OK, turnos caem em fluxos que falham — finding aberto); aposentadoria formal planejada (DB nasceu canônico, F3/F4 vácuos, resta F6 + remoção de código, PR-0/1/2/3). Ver [`MEU-TED-V1-FINAL-STATE.md`](MEU-TED-V1-FINAL-STATE.md) e [`reports/2026-10-09-v1-attachment-grounding-hardening.md`](reports/2026-10-09-v1-attachment-grounding-hardening.md). |

## Próximos passos (gates humanos)

Nenhum trabalho de engenharia está bloqueando os gates com data abaixo; dependências de sink/telemetria (canary) e rollout A19 seguem como pré-condições explicitadas nos marcos. Os passos
restantes são gates humanos com data:

1. **~2026-10-24T22:09Z - gate Release B (flip ABORTADO em 13/10):** leitura
   cuidadosa de 13/10 encontrou **136 eventos**
   `auth.request.legacy_bearer_used` após 2026-10-02T21:36:06Z (último em
   2026-10-10T22:09:01Z; burst final de 12 eventos em ~1s — retry-storm
   provável); a sonda anterior (COUNT=0) foi superada por esta leitura. Nova
   janela zero-14-dias fecha ~2026-10-24T22:09Z se nada mais ocorrer;
   re-verificar NO MOMENTO DO FLIP, somente depois de 2026-10-24T22:09:01Z, com a mesma query (filtro exclusivo `>`), confirmando zero eventos desde 2026-10-10T22:09:01Z (qualquer evento posterior reancora a janela); e só
   então flipar `SESSION_BEARER_FALLBACK_ENABLED=off` na VPS Contabo e rebuild
   do PWA com `NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off`.
2. **Quando o operador decidir — cutover residual:** aposentar o legacy/archive
   (a API já serve o canônico). A transação ambígua `49c01613…` do legacy só
   exige decisão humana se o caminho legacy→canonical for reanimado
   (recomendação: não reanimar).
3. **2026-12-01 e 2026-12-31 — revisões future-dated** (workflows-lembrete já
   criados; nenhum rito manual necessário antes das datas).

Evidência corrente: [`reports/2026-10-03-vps-migration-contabo.md`](reports/2026-10-03-vps-migration-contabo.md),
[`reports/2026-10-04-pendencias-closure.md`](reports/2026-10-04-pendencias-closure.md),
[`reports/2026-10-06-ted-agent-a19-definitive-closure.md`](reports/2026-10-06-ted-agent-a19-definitive-closure.md) e
[`reports/2026-10-07-ted-agent-a19-controlled-rollout.md`](reports/2026-10-07-ted-agent-a19-controlled-rollout.md).

## Hardening TED V3 — decisões registradas (2026-09-14)

SPEC: [`MEU-TED-SPEC-HARDENING-PONTA-A-PONTA-V3.md`](MEU-TED-SPEC-HARDENING-PONTA-A-PONTA-V3.md) ·
Plano: [`superpowers/plans/2026-09-14-meu-ted-v3-hardening.md`](superpowers/plans/2026-09-14-meu-ted-v3-hardening.md)

| ADR | Decisão |
| --- | --- |
| [`ADR-012`](adr/ADR-012-approval-contract-propose-validation-and-effects-registry.md) | Approval Tool Contract como fonte única + validação canônica no propose; Effects Registry separado; semântica de identidade do MutationReceipt (`mutationId` universal, `operationId` só no TED). |
| [`ADR-013`](adr/ADR-013-execution-recovery-lease.md) | Protocolo TX1 (claim) → executor fora da transação → TX2; lease com expiração e reconciliador idempotente; recovery de `confirmed` só por reemissão; migration V052 aditiva. |
| [`ADR-014`](adr/ADR-014-mutation-draft-multi-turno.md) | Invariantes do MutationDraft (sem autoridade financeira), ciclo com estado `proposing`, consumo atômico e handoff recuperável draft → PendingOperation (0 ou 1, INV-09/INV-10). |
