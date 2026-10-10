# MEU-TED-V1-FINAL-STATE (estado vigente — snapshot somente-leitura)

**Atualizado:** 10/10/2026. Este documento é snapshot, não plano. A definição de
encerramento vive em `docs/MEU-TED-SPEC-V1-FINAL-CLOSURE.md`.

## 1. Produção viva

| Camada | SHA vigente | Evidência |
|---|---|---|
| API (Contabo) | `bd1ed9b` | `/health` + `/ready` verdes; `TED_RISK_BASED_AUTOEXECUTE=shadow`, `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical` |
| Agent (Cloudflare) | `687a7e8d` | Deploy run `38081117169`: deploy + `/health`, `/health/agent`, SHA smoke e `ATTESTED`; GET pós-deploy confirmou `ready` e SHA |
| PWA (Cloudflare) | `687a7e8d` | Deploy run `38081117377`: artifact testado + smoke read-only + `ATTESTED`; GET `/api/build-info` confirmou SHA |
| `main` (remota) | `687a7e8d` (PR #132) | Merge squash em 10/10; CI e PWA CI pós-merge verdes |
| Credencial demo (E2E/prova) | `demo@clinicademo.com` | criada em 08/10 via fluxo de convite; membership owner no household E2E `550e8400…` (dados sintéticos); senha só no env do operador |

## 2. Matriz de capabilities (config-de-deploy; live runtime = UNKNOWN sem credencial)

| Capability | Código | Config-de-deploy | Live | Gate para avançar |
|---|---|---|---|---|
| Chat texto, memória/A17, skills/A18, forget two-step transacional | ACTIVE | ACTIVE | ACTIVE | — (baseline V1) |
| Attachments (upload/R2) | ACTIVE | **ACTIVE** (`TED_ATTACHMENTS_ENABLED=1`, coorte `*`, R2 binding) | upload/R2 provados em 08/10; nova flag não alterada | manter gates/cleanup |
| PDF textual | parser preservado, `pdfTextProcessorOverride()` retorna `undefined` incondicionalmente | deploy SHA `687a7e8d`, manifesto `TED_PDF_TEXT_ENABLED=0`; override não reativa mesmo com valor externo `1` | Agent e PWA SHA atestados; testes provam `unsupported`, zero parser e upload/R2 preservados. Não foi feito pedido autenticado de PDF em produção (sem sessão de workspace de teste neste runtime) | **DISABLED / FAIL-CLOSED**. Reativação bloqueada até isolamento/limites efetivos de CPU/memória e aprovação de privacidade/egress/retention |
| STT (Groq whisper-large-v3-turbo) | disponível | manifesto com flag `1`, coorte workspace de teste; secret presente segundo relatório 08/10 | probe sintético aprovado; voz real pendente | **WAITING_OPERATOR** para aceite de precisão/privacidade |
| Vision (Gemini `gemini-2.5-flash`, canary; Groq alternativo) | ACTIVE (código) | manifesto com flag `1`, provider/modelo allowlisted, coorte workspace de teste | extração sintética off-box; turno real ainda pendente (cota anterior esgotada) | **BLOCKED_EXTERNAL**: turno canary/cota e verificação de privacidade |
| web_search | disponível | UNKNOWN (key fora do repo) | UNKNOWN (inventário pendente) | F2.4 |
| web_fetch | disponível | DISABLED (allowlist ausente) | pendente | F2.4 |
| Decision provider (Jev/Clef/Strands) | disponível | DISABLED (default-off) | DISABLED | POST-V1 / OPTIONAL |
| Autoexecute low-risk |policy ativa | `SHADOW` | `SHADOW` | F3 (sink + canary) |

Regra: `infra provisionada != capability habilitada`; `repo config != live runtime`.

## 3. Flags (todas default-off, trava exata `=== '1'`)

`TED_AUDIO_STT_ENABLED`, `TED_VISION_ENABLED`, `TED_PDF_TEXT_ENABLED` (produção no SHA `687a7e8d`, manifesto `0`; hard-disable no código),
`TED_DECISION_PROVIDER` (ausente/vazio/`none` = off), `TED_WEB_FETCH_ALLOWED_HOSTS`
(ausente/vazio = fetch OFF). `TED_ATTACHMENTS_ENABLED`: nome conceitual da #107,
**não implementado** (F1 PR A). PWA: `NEXT_PUBLIC_TED_ATTACHMENT_*` (anúncio, não
gate), `NEXT_PUBLIC_TED_MICROPHONE=true` (browser, distinto do STT).

## 4. Gates abertos e owners

| Gate | Data/condição | Owner |
|---|---|---|
| #107 Phase A (gate+cohort+sink) | código/gates entregues em #108 e sucessores; issue segue OPEN; inventário de capability/evidência ainda pendente de fechamento | **WAITING_OPERATOR** para gate privacy do PDF e fechamento explícito da issue |
| #105 Golden Workflows | issue OPEN; #110 cobre só cancel/confirm; suite completa exigida pela SPEC não existe | **WAITING_OPERATOR** para executar/aceitar os workflows restantes após este pacote |
| Release B (flip bearer legado) | ≥ `2026-10-16T21:36:06Z`, sink = 0 | operador (gate temporal) |
| Cutover F3–F5 | gate humano (ADR-024/ADR-025) | operador |
| Privacidade A19 (PDF → relay/provider) | classificação “sem egress” retificada; conteúdo pode sair pelo relay; sem prova de ZDR/retention neste endpoint | **WAITING_OPERATOR** |
| Web live inventory (Tavily/Brave) | pré-F2.4 | operador (credencial CF) |
| Autoexecute `on` | sink + telemetria undo-after-autoexecute | operador (gate humano) |
| #87 SDK épico (+#93/#94), #95 keepalive | POST-V1 | backlog |
| Future-dated 2026-12-01 / 2026-12-31 | MAINTENANCE POST-V1 | workflows/lembretes |

## 5. Backups / DR

Bootstrap Contabo + dumps em `backups-local/` (nunca deletar; ignorado no git);
backup diário na Contabo (`~/infra/backup`, cron 03:30 UTC); rollback tags
`pi-finance-api:rollback-pre-*` preservadas. Restore proof fresco: pendente (F6/F7).

## 6. Limitações conhecidas (residuais aceitos, fail-closed)

STT sem teto de duração p/ não-WAV (só 10 MB); PDF desabilitado porque o teto
de saída não limita materialização de uma página; timeout é só de evento; cleanup
nunca executado contra bucket real; retenção/provider de conteúdo LLM pendente;
SDK `AIChatAgent` persiste pós-retorno (evidência = resposta
completa não-fail-closed); tombstone de conteúdo não cobre camada shared.

## 7. Backlog POST-V1

#87 (+Dependabot #93/#94), #95, Decision provider, G01/G02, future-dated,
performance tuning, novos providers/agents/features, refactors cosméticos.

## 8. Trilha recente

#90→#92→#97→#100→#103/#104→#106→#108→#110–#132. Baseline pré-merge de 09/10:
Agent/PWA `035d0a1d`, PDF manifesto `1`, STT e Vision configurados em coorte de
teste. Em 10/10, PR #132 foi implantado e atestado em `687a7e8d`; PDF agora
fail-closed com flag `0`, sem alterar upload/R2. A19 continua **NOT READY** por
gates de bounded processing, privacidade para eventual reativação, prova/canary
e observabilidade.

## 9. Ativação de attachments (08/10/2026) — evidência e achados

- **Config live** (Cloudflare API, `settings`): `TED_ATTACHMENTS_ENABLED=1`,
  `TED_ATTACHMENTS_COHORT=*`, `TED_ATTACHMENTS_BUCKET` (R2), `BUILD_SHA=23d1485`.
- **Prova autenticada** (usuário demo): `POST /rpc/attachments` → `200` + `ref`;
  objeto relido do R2 (`wrangler r2 object get .../ted/attachments/v1/<ref>`)
  ⇒ upload grava de verdade. `GET /rpc/attachments/observability` → `200`
  (`baseline.total` cresce) ⇒ sink G07 ativo.
- **Fail-closed preservado**: matriz OFF/non-cohort → `503` + zero-write segue
  provada em `tests/attachments/upload-gate.test.ts`; zero-mutação global com
  gate negado (deletes de cleanup/ref-expirada) provada em
  `upload-gate-zero-mutation.test.ts`.
- **Achado operacional (corrida de deploy `workflow_run`)**: o merge de #115
  teve o job `deploy` **pulado** (duas execuções da corrida gate↔CI) e só foi
  publicado após `gh run rerun`; adicionalmente o E2E da PWA falhou por flake
  Playwright conhecido (`PWA-03`), resolvido por `rerun --failed`. Estes dois
  passos (rerun do deploy + rerun do flake) são hoje manuais; candidatos a
  follow-up (gatilho de deploy mais robusto). `object_count` do
  `wrangler r2 bucket info` é métrica periódica — não usar como prova imediata;
  a prova é reler o objeto.
- **Credencial demo**: `demo@clinicademo.com` (senha somente no env do
  operador) — criada via fluxo real de convite (`account_invites` → sign-up →
  `users` canônico → membership owner no household E2E `550e8400…`, dados
  sintéticos). E-mail/validade registrados aqui; **senha nunca vai ao git**.

## 10. Situação da closure V1 (baseline pré-deploy de 09/10/2026; atualizada em 10/10)

Os estados abaixo são deliberadamente separados de “código implementado” e
“produção comprovada”. A tabela de gates humanos abaixo continua vigente;
detalhes do pacote #132 já implantado e dos limites dos smokes live estão nas
seções seguintes e na atualização de 10/10.

| Frente | Estado | Bloqueador |
|---|---|---|
| A19 | **NOT READY** | PDF fail-closed está implantado; faltam limites efetivos de CPU/memória antes de eventual reativação, aprovação de privacidade/egress/retention e gates restantes de canary/observabilidade. |
| Golden #105 | **WAITING_OPERATOR** | Workflows completos e invariantes da issue ainda não executados/aceitos; não transformar `pending-capability` em PASS. |
| Autoexecute low-risk | **WAITING_OPERATOR** | Continua SHADOW; `on` exige sink e telemetria de undo-after-autoexecute. |
| Release B | **WAITING_DATE** | Gate temporal `2026-10-16T21:36:06Z` + zero eventos na janela e procedimento autorizado. |
| F3–F5 | **WAITING_OPERATOR** | Canonical cutover/aposentadoria do legado requer gate humano. |
| Backup/restore | **WAITING_OPERATOR** | Backup diário/configurado; restore proof fresco ainda pendente. |
| Production E2E | **WAITING_OPERATOR** | Aceite final integrado (API/PWA/Agent, anexos, PDF/STT/Vision, mutation receipts/undo) ainda não executado. |
| Release v1 | **BLOCKED_EXTERNAL** | Bloqueado por A19, #105, Release B, F3–F5, restore proof e E2E final; este pacote sozinho não conclui v1. |

### Findings e implantação do pacote (#132, 10/10/2026)

| Finding | Estado no branch | Evidência |
|---|---|---|
| PDF page work limit | Mitigado em produção por **desativação fail-closed**, não por limite efetivo. Reabilitar bloqueado até isolamento/CPU/memória bounded. | PR #132; Agent/PWA atestados em `687a7e8d`; `pdf-text.ts` retorna `undefined` incondicionalmente, `wrangler.jsonc=0`, testes de gate provam `unsupported`/zero parser e upload/R2 preservados. Sem solicitação autenticada de PDF em produção. |
| Grounding: unidade/moeda/count/sinal | Corrigido em validação local: contagem e campo sem unidade não suportam dinheiro; moeda e sinal comparados; moeda/unidade desconhecida fail-closed. | `grounding-quantity-provenance.test.ts`. |
| Vision Gemini/Groq | Parser comum preserva amount e normaliza símbolos conhecidos; unknown/ambiguous permanecem honestos; sem provider, timeout, quota ou retry extra. | `groq-vision.test.ts`, `gemini-vision.test.ts`. |
| Anexo vs. registro financeiro | Texto documental pode fundamentar leitura citada; não pode provar saldo/lançamento registrado, que requer suporte API. Anexo continua dado sem autoridade. | Testes de publicação no mesmo arquivo evidence. |
| Egress/privacidade | Documentação retificada; gate do operador pendente, sem alegação ZDR/retention. | Relatório A19 §11 + relatório hardening. |
| Instruction version/telemetria | Versão atualizada e eventos de grounding sanitizados implementados. | `cognitive-instructions.test.ts`, `grounding-events-observability.test.ts`. |

**Produção atual:** Agent/PWA `687a7e8d` (deploys atestados em 10/10; GETs
pós-deploy confirmaram SHA e readiness); API Contabo `bd1ed9b` (`/health` e
`/ready` OK, sem redeploy). PR #132 foi mergeado por squash em
`687a7e8d09cc874aa3babdad133f737b7f848336`. CI `38080566857` e PWA CI
`38080566817` verdes; Agent Deploy `38081117169` e PWA Deploy `38081117377`
com deploy executado, smoke read-only e `ATTESTED`. Os primeiros workflows
pós-merge terminaram verdes com `deploy=skipped`; não foram tratados como
release. As execuções posteriores acima executaram o deploy e atestaram o SHA.

`TED_PDF_TEXT_ENABLED=0` no manifesto implantado; adicionalmente,
`pdfTextProcessorOverride()` desabilita o parser incondicionalmente, inclusive
se o runtime externo declarar `1`. Não se consultou um endpoint de flags (não
há tal endpoint) nem se enviou conteúdo PDF ao LLM. A API permaneceu em
`bd1ed9b`; nenhuma flag de STT/Vision/Web/autoexecute, secret ou modelo foi
alterada. Upload/R2 e outras capacidades mantêm o comportamento coberto pelos
testes; não houve novo canary de STT/Vision.

**Limite da prova live:** os smokes autorizados do workflow são GET/read-only
(`/health`, `/health/agent`, `/api/build-info`, raiz PWA e health API). Este
runtime não tinha sessão autenticada para workspace de teste, portanto não foi
enviada solicitação PDF nem turno generativo em produção. A garantia de zero
execução do parser é sustentada pelo código fail-closed implantado e pelos
testes, não por uma resposta live. Sem alegação de teste live de egress, provider
ou telemetria de grounding.

**Pacote corretivo concluído; A19/V1 não concluídos.** A privacidade/egress do
texto extraído permanece pendente para qualquer eventual reativação; não se
afirma ZDR nem retenção zero. O hard-disable não aprova nem inicia reativação.
