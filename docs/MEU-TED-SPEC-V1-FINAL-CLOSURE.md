# MEU-TED-SPEC-V1-FINAL-CLOSURE (revisada)

**Status:** Scope Freeze / Final Closure — revisada em 07/10/2026.
**Objetivo:** concluir definitivamente a v1 em produção, congelando o escopo e
separando bloqueadores reais de backlog pós-v1.
**Texto original:** fornecido pelo operador em 07/10/2026 (25 seções SPEC + PLAN
F0–F9). Esta revisão não muda a intenção — fixa baseline verificável, referencia
as issues reais (#105, #107) e torna o DoD mensurável.

## 1. Baseline normativa (revisão — corrigida pós-rebase: `main` remota = `71df281`)

| Item | Valor vigente em 07/10/2026 |
|---|---|
| `main` (remota) | `71df281` (PR #106 mergeado durante esta sessão; a SPEC original estava CORRETA) |
| API produção (Contabo) | `bd1ed9b` (independente, inalterada) |
| Cloudflare vigente (Agent+PWA) | `e1cf1bb` (build `37631044197`) — deploy anterior ao merge do #106 |
| Branch de trabalho | `docs/a19-rollout-inventory-fase-a` rebased sobre `71df281` (PR #108) |
| Nota de correção | revisão anterior desta SPEC chamou `71df281` de "stale" a partir de `main` local desatualizada (`e1cf1bb`) — ERRADO; vale o SHA vivo da remota |
| PRs Dependabot abertos | #93 (agents 0.2.35→0.3.10), #94 (group 2 dirs) — ambos cobertos pela #87, deferir |
| Issues abertas | #87 (épico SDK, POST-V1), #95 (keepalive spike, POST-V1), #105 (golden, GATE), #107 (A19 Phase A, blocker) |

Regra: toda attestation de deploy/smoke referencia o SHA **vivo**
(`buildSha`/`gitSha`), nunca o SHA citado nesta SPEC.

## 2. Definição de encerramento

```text
Meu Ted V1 = CLOSED / PRODUCTION READY
```

quando todos os requisitos obrigatórios desta SPEC forem atendidos. Tudo que não
estiver explicitamente listado como requisito passa para `POST-V1`, salvo P0,
P1, vulnerabilidade crítica, perda/corrupção de dados ou violação das
invariantes (§4).

## 3. Scope Freeze

Após aprovação desta SPEC, nenhuma nova feature entra automaticamente na v1.
Novas ideias, tools, modelos, integrações, otimizações, SDK upgrades ou refactors
são classificados como `v1 blocker` ou `post-v1`. Não se cria nova fase de
fechamento por P2 não bloqueante, melhoria de código, upgrade disponível, novo
framework/integração/UX ou otimização.

## 4. Invariantes permanentes (não relaxáveis)

- **INV-01 — API autoritativa:** PWA/TED → API → PostgreSQL. Nada além da API é
  fonte da verdade financeira.
- **INV-02 — LLM não concede autoridade:** modelo interpreta/classifica/sugere;
  nunca concede capability, confirma operação, cria attestation, autoriza delete
  ou mutação financeira.
- **INV-03 — nenhuma falsa confirmação:** "registrado/feito/pago/cancelado/
  esquecido" só após evidência autoritativa.
- **INV-04 — idempotência:** retry/replay/redelivery/concorrência sem duplicar efeito.
- **INV-05 — workspace/actor isolation:** nenhum estado atravessa
  workspace/actor indevidamente.
- **INV-06 — memória não é verdade financeira:** preferência/contexto, nunca backend.
- **INV-07 — destructive fail-closed:** delete/cancel/undo sensível/pagamentos
  seguem protegidos.
- **INV-08 — attachment é conteúdo não confiável:** arquivo/nome/OCR/áudio/
  imagem/PDF nunca confirmam operação, concedem autoridade ou elevam capability.
- **INV-09 — infraestrutura não ativa capability:** binding/secret/provider
  presente não ativa comportamento sem gate explícito.
- **INV-10 — rollback antes de rollout:** nenhuma capability avança sem caminho
  de rollback conhecido.

## 5. Baseline já concluída (não reabrir sem P0/P1 novo comprovado)

Agent V2, Hardening V3, V4/V4.1, A17, A18, memory learning, skills, forget
two-step (#99), forget transacional (#102), atomicidade
transaction/cascade/receipt, deploy attestation (`agent-release-smoke.mjs`),
backend autoritativo, PendingOperation V2, MutationExecutor, topologia vigente,
migração Hostinger→Contabo. Sem nova revisão estrutural "para ter certeza".

## 6. Bloqueadores reais da v1

### B1 — A19 rollout (issue #107, OPEN)

Entregar, **nesta ordem** (gate→sink→binding→prova→canary):

- gate server-side de attachments (`TED_ATTACHMENTS_ENABLED === '1'` + storage
  configurado; caso contrário `503` + zero write);
- cohort gate attachment-specific por workspace/actor no RPC de upload
  (`selectRolloutCohort` atual cobre só turnos LLM — não reutilizar sem estender);
- durable observability sink (G07) com eventos
  `attachment.upload.requested/blocked/succeeded/failed` e
  `attachment.cleanup.succeeded/failed`, sem bytes/conteúdo/secret;
- capability states (`UNCONFIGURED/CONFIGURED_DISABLED/CANARY/ACTIVE/BLOCKED`);
- R2 binding seguro **só no PR C**, com flag ainda OFF + prova `binding + OFF = zero write`;
- operator canary + promoção controlada.

Fora da #107: `GROQ_API_KEY`/ZDR (operador), Tavily/Brave (inventário live
pendente), percentuais de canary.

### B2 — Attachments + PDF

Upload seguro, R2 privado, TTL, cleanup, limites, prompt-injection protection,
PDF textual local. PDF escaneado/OCR é subfatia própria. Sem PDF real, v1 não fecha.

### B3 — Áudio/STT

Provider aprovado + `GROQ_API_KEY` + retenção/ZDR validada (G05) + timeout +
tamanho/duração bounded + falha tipada + transcrição como input não confiável +
observabilidade. **Sem ZDR evidenciado = BLOCKED** (operador provisiona; agente
não inventa).

### B4 — Vision/imagem

Provider/modelo definido (default atual `llama-4-scout-17b-16e-instruct` **a
confirmar no rollout** — troca de modelo é decisão humana) + privacidade aprovada
+ timeout + limite de payload + prompt injection multimodal + sem authority
bypass + observabilidade.

### B5 — Web

Separar `web_search` / `web_fetch`. Obrigatório: live inventory, server-side
gates, allowlist (`TED_WEB_FETCH_ALLOWED_HOSTS`), timeout, source provenance,
conteúdo tratado como não confiável, nenhum egress implícito porque secret existe.
Estado correto hoje: `web_search = UNKNOWN` (key fora do repo não é provada OFF),
`web_fetch = DISABLED` em config-de-deploy / live pendente. Não afirmar estado
live por grep — `repo config != live runtime`.

## 7. Capability model

Toda capability tem estado explícito
(`UNCONFIGURED/CONFIGURED_DISABLED/CANARY/ACTIVE/BLOCKED`). "Tem código" não é
indicador de produção.

## 8. Observabilidade — G07 (requisito para promoção)

Sink durável respondendo: requests, sucessos, falhas, latency, retries, provider
errors, storage errors, fallback, cohort, capability, custo quando relevante.
Sem segredo/token/bytes/conteúdo completo/documento bruto. Investigar reuso
(`audit_logs` da API, `emitSanitizedEvent`) antes de criar segundo sistema.

## 9. G08 — rollout/persistência

Toda capability ativada precisa: versão conhecida, migration compatível,
rollout controlado, cohort, rollback, evidência pós-deploy.

## 10. Autoexecute low-risk (V5)

Estado atual `SHADOW` (produção desde 2026-10-02, preservado no corte e no
`bd1ed9b`); kill switch = `off`/remover env. Exigido antes da closure:
`LOW-RISK ACTIVE` após canary, com elegibilidade estrita (só
`transactions.expense/income.create` explícitos, abaixo do limite, entidade
inequívoca, sem duplicate suspicion, reversível, policy permitindo). Seguem
MANUAL: high-value, destructive, pagamento, cancelamento, undo sensível,
ambiguidade, dados faltantes, duplicate suspicion. `on` sem sink + telemetria
undo-after-autoexecute = BLOCKER (INV-12/G08).

## 11. Golden Workflows (issue #105, OPEN, gate obrigatório da v1)

Unitários não bastam. Suíte versionada com backend isolado; casos mínimos:
`gastei 50 de carne`, typo, fragmentada, faltantes, mês/categoria sem dados,
memória, skills, tool failure, backend failure, retry, replay, idempotência,
forget, attachment, PDF, audio, imagem, web, autoexecute low-risk, high-risk
manual, duplicidade. Cada workflow define initial state, inputs, expected/
forbidden actions, backend postconditions, receipts/evidence, acceptable
response, retry budget. **`false-success = HARD FAILURE`.** Detalhe em §11 do
corpo da #105.

## 12. Métricas de aceite

`false-success = 0`, `unauthorized mutation = 0`, `cross-workspace leak = 0`,
`cross-actor leak = 0`, `duplicate mutation on replay = 0`, golden críticos
PASS, CI obrigatório verde, production E2E verde, rollback comprovado.

## 13. Release B (gate temporal, ABERTO)

Janela termina em `2026-10-16T21:36:06Z`. Se zero eventos
`auth.request.legacy_bearer_used` com filtro **exclusivo** no evento âncora
(`>` — `>=` conta o âncora para sempre), desligar
`SESSION_BEARER_FALLBACK_ENABLED` + `NEXT_PUBLIC_LEGACY_BEARER_COMPAT`, depois
CI/deploy/smoke/E2E autenticado/validação do sink. Release B concluída é
requisito operacional da closure.

## 14. Cutover F3–F5 (gate humano, ABERTO)

Canônico já é fonte ativa. Não reanimar legacy→canonical por histórico.
Sequência: backup → restore proof → canonical-only verification → F3 → F4 → F5
(conforme ADR-024/ADR-025). Legacy/archive termina formalmente aposentado.
Tx ambígua legacy `49c01613…` só exige decisão se reanimarem o caminho legacy
(não recomendado).

## 15. Backups, restore e rollback

Antes do fechamento: backup PostgreSQL fresco + checksum + restore em ambiente
descartável + smoke do restore + rollback Cloudflare documentado + API rollback
tag + runbook atualizado. "Tem backup" sem prova de restore não conta.

## 16. Production acceptance (única, final)

API (`/health`, `/ready`, versão, DB, auth, reads autoritativas, write+receipt);
PWA (login, workspace, dashboard, módulos, TED, approval, attachment, mobile
critical flow); Agent (`/health`, buildSha, texto, memory, forget, attachment,
PDF, audio, image, web, low-risk, high-risk).

## 17. Gates de engenharia

`pnpm typecheck`, `test`, `lint`, `docs:lint`, `governance:check`,
`architecture:check`, `capabilities:check`, `write-policy:check`, security
gates, public safety, Postgres integration, PWA CI, Agent CI — e `P0 = 0`,
`P1 = 0`. P2 pode permanecer se documentado, sem safety/data-integrity e
classificado post-v1.

## 18. Issues que NÃO bloqueiam v1

- **#87 (épico SDK AI v6/agents):** POST-V1. Não atualizar AI/Agents SDK durante
  a closure. Dependabot #93/#94 (grupo agents) deferidos em favor da #87.
- **#95 (DO keepalive spike):** POST-V1, pesquisa/arquitetura futura.

## 19. G01/G02

Não bloqueiam v1. Congelar comportamento atual; evolução = POST-V1.

## 20. Jev / Decision Provider

Não é requisito de fechamento. Pode permanecer `DISABLED` (default-off) desde
que o core não dependa dele, a ausência seja documentada e nenhuma feature
obrigatória fique incompleta. Classificação: POST-V1 / OPTIONAL.

## 21. Gates future-dated

`2026-12-01` (compat localStorage ADR-011/015) e `2026-12-31` (allowlists
security) não bloqueiam a v1. Manter workflows/lembretes como MAINTENANCE POST-V1.

## 22. Repository cleanup (antes da tag final)

Fechar issues concluídas, marcar post-v1, fechar/deferir Dependabot
incompatível, remover branches stale/mergeadas, atualizar README/ROADMAP/
ARCHITECTURE-CURRENT/CHANGELOG/AGENTS, corrigir "PR aberto" stale, remover
placeholders de SHA canônicos, manter relatórios antigos como histórico.

## 23. Documento de estado final

`docs/MEU-TED-V1-FINAL-STATE.md` (criado nesta sessão, §23) — somente estado
vigente: arquitetura, produção, versões, capabilities, flags, providers,
infra, gates, backups, limitações, backlog post-v1. Fonte principal para novas
sessões.

## 24. Release final

merge final → CI main verde → deploy → smoke → Golden → production E2E →
backup/restore → documentação → tag/release v1 → `V1 PRODUCTION READY`.

## 25. Definition of Done final

- [ ] A19 rollout (#107) concluído;
- [ ] attachments ACTIVE; PDF ACTIVE; STT ACTIVE; vision ACTIVE;
  web_search/web_fetch em estado explicitamente aprovado;
- [ ] G07 + G08 concluídos;
- [ ] autoexecute low-risk fora de shadow com canary aprovado;
- [ ] Golden (#105) PASS; Release B concluída; cutover F3–F5 concluído;
- [ ] backup + restore comprovados; production E2E PASS;
- [ ] P0 = 0, P1 = 0; CI/deploy/smoke verdes;
- [ ] documentação canônica sincronizada; backlog restante POST-V1;
- [ ] tag/release v1 criada.

Depois disso, NÃO abrir nova closure da v1 — trabalho novo entra em v1.1 ou v2.

---

# PLAN (revisado — F0–F9, com exit gates mensuráveis)

## F0 — Freeze e baseline ✅ iniciado nesta sessão

Confirmar main/CI/deploys/SHAs/issues-PRs (tabela §1). Classificação:
blockers = #107, #105, Release B, F3–F5; post-v1 = #87 (+#93/#94), #95,
Jev optional, future-dated. **Exit:** baseline known, scope frozen, backlog classified.

## F1 — A19 infrastructure closure (gate→sink→binding, sem ativar)

- **PR A (gate + cohort + testes):** `TED_ATTACHMENTS_ENABLED === '1'` AND
  storage configurado AND actor/workspace em cohort attachment-specific, caso
  contrário `503` + zero write. Matriz de testes: binding ausente/presente ×
  OFF/ON/non-cohort.
- **PR B (sink):** eventos mínimos (§8), baseline G07.
- **PR C (binding):** só depois de A+B, com flag OFF + prova disabled.
  **Exit:** gate server-side, cohort, sink, R2, zero-write OFF proof, CI verde, P0/P1 zero.

## F2 — Functional rollout A19 (uma capability por vez)

F2.1 PDF (textual; inválido/oversized/corrupto/injection/timeout/cleanup/
rollback) → F2.2 STT (pré-req key+ZDR; casos §B3) → F2.3 Vision (pré-req
provider/modelo/privacidade; casos §B4) → F2.4 Web (inventário live primeiro;
search/fetch separados). Canary sempre: operator-only → internal → small canary
→ active, com coorte explícita e critérios pausa/promoção. **Exit:** matriz
Attachments/PDF/STT/Vision/Web/R2/Observability ACTIVE (ou estado aprovado).

## F3 — Autoexecute low-risk

`shadow baseline → operator-only → small low-risk canary → low-risk active`,
monitorando autoexecute rate, failure, false positive, undo-after-autoexecute,
execution uncertain, custo, latência. **Exit:** LOW-RISK ACTIVE,
HIGH/DESTRUCTIVE MANUAL, kill switch provado.

## F4 — Golden Workflows (#105)

Dataset versionado + runner contra backend isolado + resultado machine-readable;
hard failures: false success, unauthorized write, wrong workspace, duplicate
write, backend mismatch. **Exit:** workflows críticos PASS.

## F5 — Release B (≥ 2026-10-16T21:36:06Z)

Verificar sink; se zero no período, flip + CI/deploy/smoke/auth-E2E/mobile/
Agent-test. **Exit:** legacy bearer OFF, compat OFF, sem regressão.

## F6 — Cutover residual F3–F5

Backup fresco + checksum + restore proof + reconciliação canônica → F3–F5
(ADR-024/ADR-025). **Exit:** canonical = only active source, legacy = retired.

## F7 — Final Production Acceptance (única closure)

Infra + CI + security (cross-workspace/actor, replay, prompt/attachment
injection, secrets, deps) + Golden + production E2E autenticado + DR +
review independente adversarial. Critério: P0 = 0, P1 = 0.

## F8 — Repository closure

Docs canônicas → `MEU-TED-V1-FINAL-STATE.md` → fechar #105/#107 → marcar
#87/#95 post-v1 → Dependabot → branches → CHANGELOG/ROADMAP/release notes.

## F9 — Release v1

Tag (convenção do repo) registrando API/PWA/Agent SHAs, DB schema, R2 state,
providers, flags, backup, CI runs, Golden run, production E2E.
`MEU TED V1 — PRODUCTION READY`.

## Política de findings / anti-loop

P0/P1 param a execução e corrigem antes de continuar (com TDD RED→GREEN +
review independente se tocarem invariante). P2 = fix-in-current-phase ou
post-v1. P3/melhoria = post-v1. Não criar "closure da closure" — findings são
absorvidos pela fase atual; nova fase só se prevista aqui ou P0/P1 estrutural
inevitável.

## Trilha Jev desta sessão

- `jev_gate` (docs + F0 read-only + F1 default-OFF): **allow** (conf 0.88, risk 0.29).
- `jev_decide`: scope `freeze_core` (0.56, conf baixa — mantida a SPEC do
  operador com A19 blocker faseado); golden `gate_separado` (0.96);
  F1 `gate_sink_first` (0.99).
- `jev_check` (seguro prosseguir sem ativação): **likely true** (0.82).
