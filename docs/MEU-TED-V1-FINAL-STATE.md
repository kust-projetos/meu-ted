# MEU-TED-V1-FINAL-STATE (estado vigente — snapshot somente-leitura)

**Atualizado:** 07/10/2026. Este documento é snapshot, não plano. A definição de
encerramento vive em `docs/MEU-TED-SPEC-V1-FINAL-CLOSURE.md`.

## 1. Produção viva

| Camada | SHA vigente | Evidência |
|---|---|---|
| API (Contabo) | `bd1ed9b` | `/health` + `/ready` verdes; `TED_RISK_BASED_AUTOEXECUTE=shadow`, `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical` |
| Agent (Cloudflare) | `e1cf1bb` (build `37631044197`) | `/health` ready + `buildSha` |
| PWA (Cloudflare) | `e1cf1bb` (build `37631044197`) | `/api/build-info` + `/api/backend/health` |
| Branch de trabalho | `docs/a19-rollout-inventory-fase-a` @ `3215ad6` (5 à frente de `main@e1cf1bb`) | PR #106 follow-ups (docs-only, sem ativação) |

## 2. Matriz de capabilities (config-de-deploy; live runtime = UNKNOWN sem credencial)

| Capability | Código | Config-de-deploy | Live | Gate para avançar |
|---|---|---|---|---|
| Chat texto, memória/A17, skills/A18, forget two-step transacional | ACTIVE | ACTIVE | ACTIVE | — (baseline V1) |
| Attachments (upload/R2) | disponível | DISABLED (sem binding em `wrangler.jsonc`) | UNKNOWN | #107 PR A→B→C |
| PDF textual | disponível | DISABLED (`TED_PDF_TEXT_ENABLED` ausente) | UNKNOWN | F2.1 + flag + canary |
| STT (Groq whisper-large-v3-turbo) | disponível | DISABLED | BLOCKED sem `GROQ_API_KEY` + ZDR (operador) | F2.2 |
| Vision (default `llama-4-scout-17b-16e-instruct` a confirmar) | disponível | DISABLED | BLOCKED sem key + ZDR + confirmação de modelo | F2.3 |
| web_search | disponível | UNKNOWN (key fora do repo) | UNKNOWN (inventário pendente) | F2.4 |
| web_fetch | disponível | DISABLED (allowlist ausente) | pendente | F2.4 |
| Decision provider (Jev/Clef/Strands) | disponível | DISABLED (default-off) | DISABLED | POST-V1 / OPTIONAL |
| Autoexecute low-risk |policy ativa | `SHADOW` | `SHADOW` | F3 (sink + canary) |

Regra: `infra provisionada != capability habilitada`; `repo config != live runtime`.

## 3. Flags (todas default-off, trava exata `=== '1'`)

`TED_AUDIO_STT_ENABLED`, `TED_VISION_ENABLED`, `TED_PDF_TEXT_ENABLED`,
`TED_DECISION_PROVIDER` (ausente/vazio/`none` = off), `TED_WEB_FETCH_ALLOWED_HOSTS`
(ausente/vazio = fetch OFF). `TED_ATTACHMENTS_ENABLED`: nome conceitual da #107,
**não implementado** (F1 PR A). PWA: `NEXT_PUBLIC_TED_ATTACHMENT_*` (anúncio, não
gate), `NEXT_PUBLIC_TED_MICROPHONE=true` (browser, distinto do STT).

## 4. Gates abertos e owners

| Gate | Data/condição | Owner |
|---|---|---|
| #107 Phase A (gate+cohort+sink, sem binding) | blocker V1, fases F1 | sessão atual (PR A em curso) |
| #105 Golden Workflows | gate V1, F4 | SPEC própria na issue; harness a construir |
| Release B (flip bearer legado) | ≥ `2026-10-16T21:36:06Z`, sink = 0 | operador (gate temporal) |
| Cutover F3–F5 | gate humano (ADR-024/ADR-025) | operador |
| STT/Vision keys + ZDR + modelo vision | pré-canary F2.2/F2.3 | operador (G05) |
| Web live inventory (Tavily/Brave) | pré-F2.4 | operador (credencial CF) |
| Autoexecute `on` | sink + telemetria undo-after-autoexecute | operador (gate humano) |
| #87 SDK épico (+#93/#94), #95 keepalive | POST-V1 | backlog |
| Future-dated 2026-12-01 / 2026-12-31 | MAINTENANCE POST-V1 | workflows/lembretes |

## 5. Backups / DR

Bootstrap Contabo + dumps em `backups-local/` (nunca deletar; ignorado no git);
backup diário na Contabo (`~/infra/backup`, cron 03:30 UTC); rollback tags
`pi-finance-api:rollback-pre-*` preservadas. Restore proof fresco: pendente (F6/F7).

## 6. Limitações conhecidas (residuais aceitos, fail-closed)

STT sem teto de duração p/ não-WAV (só 10 MB); PDF deadline de evento (mitigado
por tetos de trabalho); vision default a confirmar; cleanup nunca executado contra
bucket real; SDK `AIChatAgent` persiste pós-retorno (evidência = resposta
completa não-fail-closed); tombstone de conteúdo não cobre camada shared.

## 7. Backlog POST-V1

#87 (+Dependabot #93/#94), #95, Decision provider, G01/G02, future-dated,
performance tuning, novos providers/agents/features, refactors cosméticos.

## 8. Trilha recente

#90→#92→#97→#100→#103/#104→#106→(esta SPEC, #105/#107). A19 = NOT READY por
desenho; core em prod READY e estável.
