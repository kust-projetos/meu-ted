# Plano de fechamento — piloto privado Meu Ted (2026-10-19)

**Baseline:** `main@dc249bb` (código `45de23bd`). **Produção:** API Contabo + Agent/PWA Cloudflare em `45de23bd` (ATTESTED 18/10).
**Fontes:** `docs/reports/2026-10-17-full-project-review.md`, plano `docs/superpowers/plans/2026-10-17-full-project-review-remediation.md`, ondas 1–5 (`docs/reports/2026-10-18-review-remediation-wave-*.md`), `docs/MEU-TED-V1-FINAL-STATE.md`.
**Objetivo:** piloto privado ≤5 usuários, online-first. Sem features novas, sem refactor amplo.

## 1. Inventário de produção (config-de-deploy; Live = último verificado 18/10)

| Capacidade | Código | Config | Live 18/10 |
|---|---|---|---|
| Chat texto, memória A17, skills A18, forget two-step | ACTIVE | ACTIVE | ACTIVE (smoke 10/10 + E2E live-mobile-full 13–14/10) |
| Attachments upload/R2 | ACTIVE | ACTIVE (`*`) | ACTIVE 08/10; lifecycle 1 dia configurado, deleção física não validada |
| PDF textual | fail-closed (`undefined` incondicional) | `0` | DISABLED — não bloqueia |
| STT | disponível | `1`, coorte workspace real | finding UX aberto (verbatim OK, turnos com valor falham) — coorte restrita, fora do piloto sintético |
| Vision | ACTIVE | `1`, coorte workspace real | canary FULL PASS, BLOCKED_EXTERNAL (quota/privacidade) — fora do piloto |
| web_search/fetch | disponível | sem key/allowlist = unavailable | DISABLED — não bloqueia |
| Decision provider | disponível | default-off | DISABLED — não bloqueia |
| Autoexecute low-risk | policy ativa | `shadow` | SHADOW — `on` segue gate humano, fora do piloto |
| Offline snapshot V3 | ACTIVE (default ON) | — | ATIVA — ver §3 |

## 2. Estado verificado nesta sessão (19/10, read-only, 4 explorers)

- Remediação review 17/10: **23/25 CORRIGIDOS** (API-01..08, AGT-01/02, BRK-01/02, PWA-01..04, GOV-01..07). Exceções: AGT-03 DEFERRED por decisão (monólitos), PWA-05 PARCIAL (instrumentação de flakes, sem cura alegada — CI-only, não bloqueia piloto).
- Issues TED/frontend: **#169–#173, #175, #176 CORRIGIDAS** no código (FIX-170 `categoryQueryFrom`, `sent-awaiting-history`, approval rank terminal-first, undo display-safe, scroll parked, undo-reconcile, pending-send por ator.workspace). #170: falta só prova live com modelo real.
- Fluxo TED estático: Mensagem→Compreensão→Draft→Ferramentas→Memória OK; Backend/Resultado e persistência exigem runtime live.
- PWA: retry idempotente (mesmo messageId), receipt canônico obrigatório, cards só-autoritativos, scroll parked, V3 TTL 72h read-only, opcionais (image/pdf/audio/mic) default-off.

## 3. Bugs comprovados por causa-raiz (o que falta)

| ID | Causa-raiz | Classe piloto | Ação |
|---|---|---|---|
| #214 | `subscriptions-adapter` persiste sem identidade pré-fetch (fetch-A→switch-B→write-B) | **P1** — **CORRIGIDO nesta sessão** (captura pré-fetch + descarte + `expectedSubject`; tester PASS 40/40–52/52; reviewer APPROVED) | PR #226, commit `a9f305a` |
| #215 | header por aba × subject compartilhado; estabilidade ≠ coerência; V3 também afetada | **P1** — **CORRIGIDO nesta sessão** (decisão architect: coherence check fail-closed em bootstrap/paginação/fallback/preload/publicação/commit V3; tester PASS 158 + 7/7; reviewer APPROVED após 2 rodadas) | PR #226, commit `28bd7dc` |
| #216 | `migrateV1toV2` fora do `withWriteLock`, valida só fingerprint sem workspace | **P1** — **CORRIGIDO nesta sessão** (serializado + validação partição/conteúdo + cleanup condicional com liveness; tester PASS; reviewer APPROVED) | PR #226, commit `a9f305a` |
| #170-live | sem prova live do caso `gastei 90 com carne → mercado` com modelo real | **P1** (prova, não código) | E2E live com usuário sintético + modelo real (requer credenciais do operador) |
| PWA-05 | causa exata dos flakes não provada | **P2** (CI-only) | pós-piloto |
| AGT-03 | monólitos 4.6k/4.0k linhas | **P2** (dívida, DEFERRED) | pós-piloto |
| Release B flip | janela zero-14-dias ~24/10 (gate temporal, PWA-01 já desacoplado) | gate do operador | fora do código; reconsultar sink antes de propor |
| STT finding, Vision quota, PDF, web, autoexecute-on, cutover F3–F5 | gates externos/produto | pós-piloto / operador | não bloqueiam (desabilitados ou restritos) |

Nenhum P0 aberto no escopo do piloto: sem perda/duplicação financeira, sem bypass auth, sem falso-sucesso (receipt obrigatório), backend autoritativo intacto.

## 4. Execução (em curso)

1. [x] Inventário + verificação read-only (4 explorers).
2. [x] Fix #214 (coder → tester → reviewer, branch `fix/pilot-offline-identity-214-216`, PR #226).
3. [x] Fix #216 (mesma branch/PR — tester + reviewer APPROVED).
4. [x] #215 (architect → coder → tester → reviewer APPROVED; commit `28bd7dc` no PR #226).
5. [ ] Gates focados: `docs:lint`, `typecheck`, testes focados PWA/Agent/API, `governance:check`, `capabilities:check`, `write-policy:check`, `boundary:check`, `public-safety --strict`.
6. [x] PR #226 + CI verde (CI `39238326768` + PWA CI `39238326769` success em `604d68d`; required checks `Gate — all checks` + `quality (22, 10)` SUCCESS; mergeable CLEAN).
7. [ ] Merge + deploy só com go do operador (API via wrapper na Contabo; Agent/PWA via Cloudflare com attestation).
8. [ ] Smokes live read-only (`/health`, `/ready`, build-info) no candidato pós-deploy.
8. [ ] E2E live com modelo real + usuário sintético (requer credenciais/sessão do operador) — matriz §5.
9. [ ] Relatório final com veredito.

## 5. Matriz E2E piloto (usuários sintéticos, sem tocar dados reais)

Login/sessão · criar/selecionar workspaces · contas/categorias/lançamentos · extrato/saldos · TED leitura real · TED proposta+aprovação · correção `mercado` no draft · cancelamento/desfazer · reload/retomada · retry/duplicadas (mesmo messageId) · 2 usuários/2 workspaces isolados · falha/recuperação (inconclusivo→reconcile, sem duplo efeito).

## 6. Checklist de liberação

- [x] #214 + #216 corrigidos, testados, revisados, CI verde (PR #226).
- [x] #215 decidido e corrigido (architect opção a; tester + reviewer APPROVED).
- [x] #170 provado live com modelo real (live-ted-conversation PASS em `0405fba`).
- [x] Smokes live verdes no SHA candidato; backup/rollback disponíveis.
- [x] Release executado 19/10: API Contabo RELEASE OK `0405fba` + Agent/PWA ATTESTED; E2E live-mobile-full + live-ted-conversation PASS; limpeza 0 restante.
- [x] Issues #169–#173, #175, #176, #214–#216 CLOSED com evidência.
- [x] Limitações residuais documentadas (relatório de fecho §4).
