# Meu Ted — Roadmap

**Last verified:** 2026-11-11
**Reference:** [`runtime-facts.json`](architecture/runtime-facts.json)

Backlog priorizado e pendências do plano: [`reference/PENDENCIAS.md`](reference/PENDENCIAS.md).

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
| Release B (descomissionamento do bearer legado) | **Concluído em 11/11/2026** | Janela D11-R2 conferida na Contabo (somente SELECT): **0 eventos** `auth.request.legacy_bearer_used` após `2026-10-19T13:23:55.399917Z` (total histórico 406). Flip aplicado: `SESSION_BEARER_FALLBACK_ENABLED=off` na API (env do container, health/ready verdes, bearer-only 401) e build da PWA com `NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off` (PR #320, deploy ATTESTED `5e69dec`). Sink e evidência histórica em [`reports/2026-10-03-vps-migration-contabo.md`](reports/2026-10-03-vps-migration-contabo.md). |
| Itens future-dated | Planejado | Compat localStorage/bearer em 2026-12-01 (ADR-011/015) e allowlists (`pwa-audit` + `.trivyignore`) em 2026-12-31; workflows-lembrete ativos e idempotentes. |
| TED Agent A19 (anexos/decision/STT/vision/PDF) | **V1-textual CLOSED 14/10 (API `fd3481f`, Agent/PWA `715b2cf` código `fd3481f`); A19 multimodal pós-V1 NOT READY no escopo multimodal** — histórico 13/10 (preservado): **NOT READY — PR #154 (forward-fix do outage da API) vigente: API `414aefa` (release manual) + Agent/PWA `e91a3cd` (ATTESTED); E2E live-mobile-full PASS em 13/10; PDF segue fail-closed** | **HISTÓRICO 13/10 — superado pelo veredito V1-textual CLOSED de 14/10 (ver MEU-TED-V1-FINAL-STATE.md); não é produção vigente:** API+Agent+PWA `414aefa` (PR #154, forward-fix do outage da API em 13/10 — crash `FST_ERR_DUPLICATED_ROUTE` + rollback inválido para imagem com manifesto V059 × ledger V060; suite 2493 pass, review APPROVED, swap manual + smokes verdes, 0 restarts; detalhe em `MEU-TED-V1-FINAL-STATE.md`); deploys anteriores atestados em `e57bcec` (`38326659522`, `38326659650`) e `bc2ba9e` (`38314671723`, `38314671758`); rotação do `POSTGRES_PASSWORD` exposto em transcript ENCERRADA em 13/10 (senha nova ativa, app healthy, smokes 200, backup pré-rotação verificado; mecanismo: `.env` dono da senha, compose interpola a `DATABASE_URL`) e toques manuais no banco seguem congelados; follow-ups: autoria dos probes 15:48Z, endurecimento do `pg_hba` e remoção futura dos `.bak-pre-rotate-*`. `TED_PDF_TEXT_ENABLED=0` e `pdfTextProcessorOverride()` retorna `undefined` incondicionalmente. Upload/R2 preservados; testes provam caminho `unsupported` e zero parser, e `pdf-gate-worklimit.test.ts` passa 10/10 local. E2E live-mobile-full **PASS** em 13/10 (~2.6 min: login, conta, transação, extrato, TED leitura com valores, TED mutação com aprovação; `workspaceWriteViolations` vazio; só Test Family). Regra de lifecycle R2 de 1 dia configurada por autorização expressa do operador; deleção física **não validada** (assíncrona, sem bucket de teste isolado). STT/Vision com canary API-direto em 13/10 (Vision FULL PASS, STT PARCIAL com finding aberto) + canary UI via PWA `df23c3d` (Vision FULL PASS x3; STT verbatim OK no histórico, turnos falham — finding aberto; M8 falso-positivo registrado) e sem mudança de coorte; autoexecute segue `SHADOW` (último conhecido, não re-verificado live). Privacidade/egress/retention continua gate para eventual reativação. A19 multimodal pós-V1 permanece **NOT READY** apenas no escopo multimodal (V1-textual CLOSED em 14/10). Em 13/10: operador declarou 3x que `junio` contém só dados de teste (reconciliação em `MEU-TED-V1-FINAL-STATE.md`); canary API-direto Vision **FULL PASS** (upload 200 + turno completed, extração exata, zero mutação) e STT **PARCIAL** (transcrição Groq OK, turnos caem em fluxos que falham — finding aberto); aposentadoria formal planejada (DB nasceu canônico, F3/F4 vácuos, resta F6 + remoção de código, PR-0/1/2/3). Em 14/10: homologação live-mobile-full PASS e veredito V1-textual CLOSED (docs-only; API `fd3481f`, Agent/PWA `715b2cf` código idêntico a `fd3481f`) — ver [`MEU-TED-V1-FINAL-STATE.md`](MEU-TED-V1-FINAL-STATE.md) e [`reports/2026-10-09-v1-attachment-grounding-hardening.md`](reports/2026-10-09-v1-attachment-grounding-hardening.md). |

## Próximos passos (gates humanos)

Nenhum trabalho de engenharia está bloqueando os gates com data abaixo; dependências de sink/telemetria (canary) e rollout A19 seguem como pré-condições explicitadas nos marcos. Os passos
restantes são gates humanos com data:

1. **Release B — CONCLUÍDA em 2026-11-11:** janela D11-R2 conferida na Contabo
   (somente SELECT) com **0 eventos** `auth.request.legacy_bearer_used` após
   `2026-10-19T13:23:55.399917Z` (total histórico 406). Flip executado:
   `SESSION_BEARER_FALLBACK_ENABLED=off` na API (VPS Contabo, verificado no
   container) e build da PWA com `NEXT_PUBLIC_LEGACY_BEARER_COMPAT=off`
   (PR #320). Bearer-only retorna 401; device/delegated tokens não mudam.
2. **Quando o operador decidir — cutover residual:** aposentar o legacy/archive
   (a API já serve o canônico). A transação ambígua `49c01613…` do legacy só
   exige decisão humana se o caminho legacy→canonical for reanimado
   (recomendação: não reanimar).
3. **2026-12-01 e 2026-12-31 — revisões future-dated** (workflows-lembrete já
   criados; nenhum rito manual necessário antes das datas).

Evidência corrente: [`reports/2026-10-03-vps-migration-contabo.md`](reports/2026-10-03-vps-migration-contabo.md),
[`reports/2026-10-04-pendencias-closure.md`](reports/2026-10-04-pendencias-closure.md),
[`reports/2026-10-06-ted-agent-a19-definitive-closure.md`](reports/2026-10-06-ted-agent-a19-definitive-closure.md) e
[`reports/2026-10-07-ted-agent-a19-controlled-rollout.md`](reports/2026-10-07-ted-agent-a19-controlled-rollout.md),
além de [`MEU-TED-V1-FINAL-STATE.md`](MEU-TED-V1-FINAL-STATE.md) (homologação live + veredito V1-textual CLOSED em 14/10).

## Hardening TED V3 — decisões registradas (2026-09-14)

SPEC: [`MEU-TED-SPEC-HARDENING-PONTA-A-PONTA-V3.md`](MEU-TED-SPEC-HARDENING-PONTA-A-PONTA-V3.md) ·
Plano: [`superpowers/plans/2026-09-14-meu-ted-v3-hardening.md`](superpowers/plans/2026-09-14-meu-ted-v3-hardening.md)

| ADR | Decisão |
| --- | --- |
| [`ADR-012`](adr/ADR-012-approval-contract-propose-validation-and-effects-registry.md) | Approval Tool Contract como fonte única + validação canônica no propose; Effects Registry separado; semântica de identidade do MutationReceipt (`mutationId` universal, `operationId` só no TED). |
| [`ADR-013`](adr/ADR-013-execution-recovery-lease.md) | Protocolo TX1 (claim) → executor fora da transação → TX2; lease com expiração e reconciliador idempotente; recovery de `confirmed` só por reemissão; migration V052 aditiva. |
| [`ADR-014`](adr/ADR-014-mutation-draft-multi-turno.md) | Invariantes do MutationDraft (sem autoridade financeira), ciclo com estado `proposing`, consumo atômico e handoff recuperável draft → PendingOperation (0 ou 1, INV-09/INV-10). |
