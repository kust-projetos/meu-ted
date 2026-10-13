# MEU-TED-V1-FINAL-STATE (estado vigente — snapshot somente-leitura)

**Atualizado:** 13/10/2026. Este documento é snapshot, não plano. A definição de
encerramento vive em `docs/MEU-TED-SPEC-V1-FINAL-CLOSURE.md`.

## 1. Produção viva

Em 13/10/2026, após o estado `e57bcec` abaixo, a API Contabo passou por um
outage (~15:44Z–recuperação no mesmo dia) durante o release de `3c3a3f9`
(V1 routes retirement) e foi recuperada por forward-fix no PR #154
(`414aefa`) — detalhe no apêndice de incidente ao fim deste documento. O
vigente: API `414aefa` (release manual pos-recovery) e Agent/PWA `e91a3cd` (ATTESTED pos-#155).

| Camada | SHA vigente | Evidência |
|---|---|---|
| API (Contabo) | `414aefa` (`414aefad8e04cba1927338b8d6af0aa53b7fc9d7`, build CI `38437241159`) | swap manual + smokes verdes pós-recovery em 13/10 (`/health`+`/ready` 200, gitSha/buildId casados, 0 restarts); `TED_RISK_BASED_AUTOEXECUTE=shadow`, `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical` preservados; manifesto manual `release-manifest-414aefa-manual.json` na VPS; rollback tag preservada |
| Agent (Cloudflare) | `e91a3cd` (`e91a3cdd051fabc7fb2fe6469aae70c80ac4e148`, build `38452770765`) | Deploys 38453779343/38453779281 ATTESTED deploy-smoke-pass 13/10; transcript fix validado live (T1/T2 sem read-fail, com evidencia (T1/T2 no live 3e90c30; codigo agent identico em e91a3cd, diff vazio) |
| PWA (Cloudflare) | `e91a3cd` (mesmo SHA/build `38452770765`) | Deploys 38453779343/38453779281 ATTESTED deploy-smoke-pass 13/10 |
| origin/main | `e91a3cd` | PR #155 (docs outage+recovery); CI + PWA CI verdes |
| Agent/PWA - tentativa `414aefa` (nunca servida) | `414aefad8e04cba1927338b8d6af0aa53b7fc9d7` | wave1 deploy-skipped + wave2 smoke-fail no outage da API 13/10; live foi direto `e91a3cd` |
| API — imagem anterior (histórico) | `bd1ed9b` (`bd1ed9bdbcaf99c407ac40f1d4a668099a405585`, build `37238430467`) | `/health` + `/ready` 200 em 12/10/2026, sem redeploy desde 04/10 até o incidente de 13/10; **não reutilizável após V060** (manifesto V059 × ledger V060 — ver apêndice) |
| Agent/PWA — deploy atestado anterior (histórico) | `bc2ba9e` (`bc2ba9e11c3272d29d89b8e8c64aa7d01c85cb1d`, build `38313912315`, builtAt `2026-10-12T21:58:24Z`) | Deploy runs `38314671723`/`38314671758` success/`ATTESTED` (deploy-smoke-pass, 12/10; attest jobs `115028677706`/`115028936543`) |
| Agent/PWA — deploy atestado **antes** de `bc2ba9e` (histórico) | `36ccaac` (merge #138) | Deploy runs `38266117716`/`38266117889` success/`ATTESTED` (deploy-smoke-pass, 12/10) |
| Agent/PWA — último deploy atestado **antes** de #133 (histórico) | `687a7e8d` (PR #132) | Deploy runs `38081117169`/`38081117377`; CI `38080566857` / PWA CI `38080566817` |
| Credencial demo (E2E/prova) | `demo@clinicademo.com` | criada em 08/10 via fluxo de convite; membership owner no workspace E2E sintético `550e8400…` (Test Family); senha só no env do operador |

## 2. Matriz de capabilities (config-de-deploy; coluna Live = estado verificado)

| Capability | Código | Config-de-deploy | Live | Gate para avançar |
|---|---|---|---|---|
| Chat texto, memória/A17, skills/A18, forget two-step transacional | ACTIVE | ACTIVE | ACTIVE — chat/leitura comprovados no smoke autenticado de 10/10 (§11) | — (baseline V1) |
| Attachments (upload/R2) | ACTIVE | **ACTIVE** (`TED_ATTACHMENTS_ENABLED=1`, coorte `*`, binding R2 `pi-finance-ted-attachments`) | upload/R2 provados em 08/10 e coerentes com o smoke autenticado de 10/10; regra de lifecycle R2 de 1 dia **configurada** (§12), deleção física **não validada** | manter gates/cleanup; validar expiração antes de confiar na retenção |
| PDF textual | parser preservado, `pdfTextProcessorOverride()` retorna `undefined` incondicionalmente | Agent: manifesto `TED_PDF_TEXT_ENABLED=0`; PWA: `NEXT_PUBLIC_TED_ATTACHMENT_PDF` e flag master não estão no config versionado, default-off | Smoke autenticado de 10/10 **não** chegou a pedir PDF: a PWA deployada (`65304dca`) não renderizou input de arquivo PDF, e o smoke foi bloqueado antes do upload — zero request/upload/parser em produção. Teste local `pdf-gate-worklimit.test.ts` 10/10 PASS | **DISABLED / FAIL-CLOSED**. Reativação do parser bloqueada até isolamento/limites efetivos de CPU/memória e aprovação de privacidade/egress/retention; expor o botão de upload também requer build/deploy autorizado da PWA |
| STT (Groq whisper-large-v3-turbo) | disponível | manifesto com flag `1`, coorte restrita ao workspace `junio` `d36cb649-4462-486d-940a-47128ad329f2` (ver nota 13/10 sobre natureza dos dados no apêndice canary ao fim deste documento); secret presente segundo relatório 08/10 | **canary API-direto 13/10 PARCIAL** — upload 200 + transcrição Groq OK, mas turnos com transcrição caem em fluxos de leitura/mutação que falham (finding aberto, apêndice canary ao fim deste documento); **canary UI 13/10**: verbatim comprovado no histórico, turnos com transcrição falham ao responder (finding aberto, extensão UI do apêndice); **sem** mudança de coorte em 10/10 | **WAITING_OPERATOR** para aceite de precisão/privacidade |
| Vision (Gemini `gemini-2.5-flash`, canary; Groq alternativo) | ACTIVE (código) | manifesto com flag `1`, provider/modelo allowlisted, coorte restrita ao workspace `junio` `d36cb649-4462-486d-940a-47128ad329f2` (ver nota 13/10 sobre natureza dos dados no apêndice canary ao fim deste documento) | extração sintética exata provada live em 08/10; **canary API-direto 13/10 FULL PASS** (upload 200 + turno completed, extração exata, zero mutação — apêndice canary ao fim deste documento); **canary UI 13/10 FULL PASS x3** via PWA `df23c3d` (extensão UI do apêndice); quota regular e verificação de privacidade pendentes; **sem** mudança de coorte em 10/10 | **BLOCKED_EXTERNAL**: quota regular e verificação de privacidade |
| web_search | disponível | UNKNOWN (key fora do repo; Tavily/Brave pago recusados) | UNKNOWN (inventário pendente) | F2.4 |
| web_fetch | disponível | DISABLED (allowlist ausente) | pendente | F2.4 |
| Decision provider (Jev/Clef/Strands) | disponível | DISABLED (default-off) | DISABLED | POST-V1 / OPTIONAL |
| Autoexecute low-risk | policy ativa | `SHADOW` | `SHADOW` (último conhecido; **não** re-verificado live em 10/10) | F3 (sink + canary) |

Regra: `infra provisionada != capability habilitada`; `repo config != live runtime`.

## 3. Flags — estados atuais (nem todas default-off; trava exata `=== '1'`)

| Flag | Estado atual | Restrição |
|---|---|---|
| `TED_ATTACHMENTS_ENABLED` (anexos) | `1` | coorte `*`; binding R2 `pi-finance-ted-attachments` |
| `TED_AUDIO_STT_ENABLED` (áudio/STT) | `1` | coorte restrita ao workspace **real** `junio` `d36cb649-4462-486d-940a-47128ad329f2` (household com dados financeiros reais segundo notas antigas — ver nota de retificação 13/10 no apêndice canary; **não** o sintético Test Family); flag sozinha não autoriza egress |
| `TED_VISION_ENABLED` (Vision) | `1` | provider `gemini`, modelo `gemini-2.5-flash`, coorte restrita ao workspace **real** `junio` `d36cb649-4462-486d-940a-47128ad329f2` (household com dados financeiros reais segundo notas antigas — ver nota de retificação 13/10 no apêndice canary; **não** o sintético Test Family) |
| `TED_PDF_TEXT_ENABLED` (PDF) | `0` | hard-disabled no código (`pdfTextProcessorOverride()` → `undefined` incondicional) |
| `TED_WEB_FETCH_ALLOWED_HOSTS` (web_fetch) | off | allowlist ausente/vazia = fetch OFF |
| `TED_DECISION_PROVIDER` (decision) | default-off | ausente/vazio/`none` = off |

Autoexecute low-risk (`TED_RISK_BASED_AUTOEXECUTE`): `shadow` — último
conhecido, **não** re-verificado live em 10/10. Esta seção descreve a
**config-de-deploy**, não o runtime live: `repo config != live runtime`.

PWA: `NEXT_PUBLIC_TED_ATTACHMENT_*` (anúncio, não gate),
`NEXT_PUBLIC_TED_MICROPHONE=true` (browser, distinto do STT).

## 4. Gates abertos e owners

| Gate | Data/condição | Owner |
|---|---|---|
| #107 Phase A (gate+cohort+sink) | **CLOSED em 12/10/2026** (issue fechada com comentário de evidência): gate server-side, coorte attachment-specific, testes binding+OFF, sink durável G07 e inventário de 5 estados — todos implementados + testados (`tests/attachments` 26 arquivos/405 testes verdes); CI do `main` verde | Phase A encerrada; **A19 geral segue NOT READY** (rollout, expiração física R2, bounded PDF, privacidade/egress, canaries STT/Vision têm gates próprios) |
| #105 Golden Workflows | Suite rápida 35/29 executáveis PASS (GW-033–038: categoria inexistente, conta não identificada, extrato com dados, fragmento de conta, forget redelivery, forget após esquecido), 6 `pending-capability` sem promoção; PG autoritativa: Bloco A (GW-023/024/025 + redelivery/recuperação) + Bloco B (GW-030 undo, GW-031 receita, GW-032 concorrência, GW-040 leitura), tudo SQL-verified | **CLOSED em 12/10/2026** (checklist de aceite + §5.4 mapeados em comentário). Residuais fora da issue: homologação E2E, Release B, cutover, rollout de capacidades |
| Release B (flip bearer legado) | **Flip ABORTADO em 13/10** — 136 eventos pós-2026-10-02T21:36:06Z (último 2026-10-10T22:09:01.594968Z); nova janela zero-14-dias fecha ~2026-10-24T22:09Z | operador (gate temporal) |
| Cutover F3–F5 | gate humano (ADR-024/ADR-025) | operador |
| Privacidade A19 (PDF → relay/provider) | classificação “sem egress” retificada; conteúdo pode sair pelo relay; sem prova de ZDR/retention neste endpoint | **WAITING_OPERATOR** |
| Web live inventory (Tavily/Brave) | pré-F2.4 | operador (credencial CF) |
| Autoexecute `on` | sink + telemetria undo-after-autoexecute | operador (gate humano) |
| #87 SDK épico (+#93/#94), #95 keepalive | POST-V1 | backlog |
| Future-dated 2026-12-01 / 2026-12-31 | MAINTENANCE POST-V1 | workflows/lembretes |

## 5. Backups / DR

Bootstrap Contabo + dumps em `backups-local/` (nunca deletar; ignorado no git);
backup diário na Contabo (`~/infra/backup`, cron 03:30 UTC); rollback tags
`pi-finance-api:rollback-pre-*` preservadas. Restore proof 12/10/2026:
âncora `pi-financeiro-contabo-anchor-pre-hostinger-removal-20261003.dump`
com sha256 conferido (`285d2065…`) e restore em PG 15 descartável local
(43 tabelas, ledger canônico V059, 38 contas/39 transações — só contagens;
container destruído após a prova). Restore de backup diário da VPS e
smoke funcional no restaurado seguem pendentes de acesso à VPS (F6/F7).

## 6. Limitações conhecidas (residuais aceitos, fail-closed)

STT sem teto de duração p/ não-WAV (só 10 MB); PDF desabilitado porque o teto
de saída não limita materialização de uma página; timeout é só de evento;
retenção dos anexos: a regra de lifecycle R2 de 1 dia está **configurada**, mas
a deleção física **não foi validada** (assíncrona; sem bucket de teste isolado e
sem run sintético de expiração), e o sweep do app continua piggyback no upload,
bounded e retomável (TTL 24h, 10 páginas/50 objetos por varredura), não
autônomo; retenção/provider de conteúdo LLM pendente; SDK `AIChatAgent` persiste
pós-retorno (evidência = resposta completa não-fail-closed); tombstone de
conteúdo não cobre camada shared.

## 7. Backlog POST-V1

#87 (+Dependabot #93/#94), #95, Decision provider, G01/G02, future-dated,
performance tuning, novos providers/agents/features, refactors cosméticos.

## 8. Trilha recente

#90→#92→#97→#100→#103/#104→#106→#108→#110–#132→#133. Baseline pré-merge de 09/10:
Agent/PWA `035d0a1d`, PDF manifesto `1`, STT e Vision configurados em coorte
restrita ao workspace **real** `junio`. Em 10/10, PR #132 foi implantado e atestado em `687a7e8d`; PDF agora
fail-closed com flag `0`, sem alterar upload/R2. Ainda em 10/10, o PR documental
#133 foi mergeado e deployado (`65304dca`; CI `38085540279`/`38085540233` e
deploys `38086070929`/`38086070927` verdes e atestados); com sessão autenticada
de workspace sintético, um smoke generativo de chat passou em produção (§11), o
smoke de PDF ficou bloqueado antes do upload (§11) e a regra de lifecycle R2 de
1 dia foi configurada por autorização expressa do operador (§12). Nenhuma flag,
secret, coorte, modelo ou canary foi alterado, e nenhum dado financeiro foi
mutado. A19 continua **NOT READY** por gates de bounded processing, privacidade
para eventual reativação, prova/canary e observabilidade.

Em 12/10, três PRs Golden foram mergeados com CI 100% verde e deploys
atestados: #137 (Bloco A fase 2, squash `b3861cf`), #138 (Bloco B, squash
`36ccaac` — merge executado pelo operador) e #139 (Bloco C/D determinístico,
squash `e7e15a3`). Agent/PWA em produção avançaram para `bc2ba9e` (doc
`7fc9fe8`; deploys `38314671723`/`38314671758` ATTESTED deploy-smoke-pass —
antes `36ccaac` via `38266117716`/`38266117889`; detalhe incremental ao fim
deste documento); API Contabo segue
`bd1ed9b` sem redeploy (`/health`+`/ready` 200 re-verificados em 12/10). #107
(Phase A) foi **fechada** com comentário de evidência; #105 segue OPEN.

Em 13/10, o PR #145 (fix grounding: closed-grammar presentation split before
nominal grounding) foi mergeado como `e57bcec`; CI `38325143697` + PWA CI
`38325143776` success (PWA CI após `rerun --failed` de 1 flake PUSH-02 — botão
Entrar desabilitado, mesma família PWA-03/04; resto 152+39+matrix verde);
Agent/PWA avançaram para `e57bcec` (build `38325143776`) com deploys
`38326659522`/`38326659650` ATTESTED deploy-smoke-pass na 2ª wave (1ª wave
deploy-skipped:gate-not-ready); API Contabo segue `bd1ed9b` sem redeploy. E2E
live-mobile-full PASS em 13/10 (~2.6 min: login→conta→transação→extrato→TED
leitura com valores→TED mutação com aprovação, `workspaceWriteViolations`
vazio, só Test Family) — detalhe no apêndice incremental ao fim deste
documento. A19 segue **NOT READY**; Release B com flip ABORTADO em 13/10 (136 eventos; nova janela ~2026-10-24T22:09Z), cutover
F3–F5 pendente, PDF fail-closed, coortes STT/Vision restritas ao workspace
real `junio`.

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
| Golden #105 | **WAITING_OPERATOR** | Run local 10/10: 23/23 executáveis PASS e 6 `pending-capability` mantidos como skipped (§13); workflows completos e invariantes da issue ainda não executados/aceitos pelo operador; não transformar `pending-capability` em PASS. |
| Autoexecute low-risk | **WAITING_OPERATOR** | Continua SHADOW; `on` exige sink e telemetria de undo-after-autoexecute. |
| Release B | **WAITING_DATE (flip ABORTADO em 13/10)** | 136 eventos pós-2026-10-02T21:36:06Z (último 2026-10-10T22:09:01.594968Z); nova janela zero-14-dias fecha ~2026-10-24T22:09Z + procedimento autorizado. |
| F3–F5 | **WAITING_OPERATOR** | Canonical cutover/aposentadoria do legado requer gate humano. |
| Backup/restore | **WAITING_OPERATOR** | Backup diário/configurado; restore proof fresco ainda pendente. |
| Production E2E | **WAITING_OPERATOR** | Smoke autenticado parcial em 10/10 (chat/leitura PASS, zero mutação — §11); aceite final integrado (API/PWA/Agent, anexos, PDF/STT/Vision, mutation receipts/undo) ainda não executado. |
| Release v1 | **BLOCKED_EXTERNAL** | Bloqueado por A19, #105, Release B, F3–F5, restore proof e E2E final; este pacote sozinho não conclui v1. |

### Findings e implantação do pacote (#132, 10/10/2026)

| Finding | Estado no branch | Evidência |
|---|---|---|
| PDF page work limit | Mitigado em produção por **desativação fail-closed**, não por limite efetivo. Reabilitar bloqueado até isolamento/CPU/memória bounded. | PR #132; Agent/PWA atestados em `687a7e8d`; `pdf-text.ts` retorna `undefined` incondicionalmente, `wrangler.jsonc=0`, testes de gate provam `unsupported`/zero parser e upload/R2 preservados. Nenhum request/upload/parser PDF em produção: o smoke autenticado de 10/10 foi bloqueado antes do upload (§11). Teste local `pdf-gate-worklimit.test.ts` 10/10 PASS. |
| Grounding: unidade/moeda/count/sinal | Corrigido em validação local: contagem e campo sem unidade não suportam dinheiro; moeda e sinal comparados; moeda/unidade desconhecida fail-closed. | `grounding-quantity-provenance.test.ts`. |
| Vision Gemini/Groq | Parser comum preserva amount e normaliza símbolos conhecidos; unknown/ambiguous permanecem honestos; sem provider, timeout, quota ou retry extra. | `groq-vision.test.ts`, `gemini-vision.test.ts`. |
| Anexo vs. registro financeiro | Texto documental pode fundamentar leitura citada; não pode provar saldo/lançamento registrado, que requer suporte API. Anexo continua dado sem autoridade. | Testes de publicação no mesmo arquivo evidence. |
| Egress/privacidade | Documentação retificada; gate do operador pendente, sem alegação ZDR/retention. | Relatório A19 §11 + relatório hardening. |
| Instruction version/telemetria | Versão atualizada e eventos de grounding sanitizados implementados. | `cognitive-instructions.test.ts`, `grounding-events-observability.test.ts`. |

**Produção do pacote #132 (histórico do pacote):** Agent/PWA `687a7e8d` (deploys
atestados em 10/10; GETs pós-deploy confirmaram SHA e readiness); API Contabo
`bd1ed9b` (`/health` e `/ready` OK, sem redeploy). PR #132 foi mergeado por
squash em `687a7e8d09cc874aa3babdad133f737b7f848336`. CI `38080566857` e PWA CI
`38080566817` verdes; Agent Deploy `38081117169` e PWA Deploy `38081117377`
com deploy executado, smoke read-only e `ATTESTED`. Os primeiros workflows
pós-merge terminaram verdes com `deploy=skipped`; não foram tratados como
release. As execuções posteriores acima executaram o deploy e atestaram o SHA.
O SHA em Agent/PWA em 10/10 era `65304dca` (merge documental #133, sem
alteração de código de aplicação — ver §1).

`TED_PDF_TEXT_ENABLED=0` no manifesto implantado; adicionalmente,
`pdfTextProcessorOverride()` desabilita o parser incondicionalmente, inclusive
se o runtime externo declarar `1`. Não se consultou um endpoint de flags (não
há tal endpoint) nem se enviou conteúdo PDF ao LLM. A API permaneceu em
`bd1ed9b`; nenhuma flag de STT/Vision/Web/autoexecute, secret ou modelo foi
alterada. Upload/R2 e outras capacidades mantêm o comportamento coberto pelos
testes; não houve novo canary de STT/Vision.

**Limite da prova live no pacote #132 (histórico):** os smokes autorizados do
workflow são GET/read-only (`/health`, `/health/agent`, `/api/build-info`, raiz
PWA e health API). Naquela rodada o runtime não tinha sessão autenticada para
workspace de teste, portanto não foi enviada solicitação PDF nem turno
generativo em produção. A garantia de zero execução do parser foi sustentada
pelo código fail-closed implantado e pelos testes, não por uma resposta live.

**Atualizado em 10/10/2026, após o merge documental #133:** um smoke generativo
**autenticado** foi executado em produção (§11) — chat/leitura PASS, zero
mutação. O PDF permanece **sem prova live**: o smoke foi bloqueado antes do
upload porque a PWA deployada não renderizou input de arquivo PDF. A garantia de
zero execução do parser continua sendo código fail-closed + testes, não
resposta live. Sem alegação de teste live de egress, provider ou telemetria de
grounding.

**Pacote corretivo concluído; A19/V1 não concluídos.** A privacidade/egress do
texto extraído permanece pendente para qualquer eventual reativação; não se
afirma ZDR nem retenção zero. O hard-disable não aprova nem inicia reativação.

## 11. Smoke generativo autenticado em produção (10/10/2026)

Executado com **login normal** ao workspace sintético **Test Family**
(`550e8400-e29b-41d4-a716-446655440000`), sem bypass de RPC e sem caminho
privilegiado. Separação explícita: *implementado/testado* × *prod verificado* ×
*bloqueado*.

| Verificação | Resultado |
|---|---|
| PWA/Agent REST chat | `200`, resposta **não vazia** |
| Workspace vazio | reportado honestamente como "sem contas" — grounded status **PASS** |
| `/api/agent/.../rpc/chat` via proxy da PWA | `200`, code path `pwa-rest` (relay interno da API) |
| Pending operation / undo | nenhum |
| Hash autoritativo de contas + transações (pré/pós) | idêntico (`0`/`0`) — **zero mutação financeira** |
| PDF | **BLOCKED antes do upload**: a PWA deployada (`65304dca`) não renderizou input de arquivo PDF; nenhum request, upload ou parser foi exercitado |

**Prod verificado nesta sessão:** chat/leitura autenticado e o estado de
produção (health/ready/build-info) das três camadas.
**Testado localmente, sem prova live:** parser PDF (`pdf-gate-worklimit.test.ts`
10/10 PASS — permanece fail-closed em código e config).
**Bloqueado / sem prova live:** PDF, STT, Vision, web_search/web_fetch e
autoexecute. Não há alegação de teste live de PDF, de egress, de provider ou de
telemetria de grounding, e nenhum dado financeiro foi mutado.

**Atualização 13/10:** E2E live-mobile-full PASS executado em produção
(login→conta→transação→extrato→TED leitura com valores→TED mutação com
aprovação, `workspaceWriteViolations` vazio, só Test Family) — detalhe no
apêndice incremental de 13/10 ao fim deste documento. Este §11 preserva o
smoke de 10/10 como histórico.

## 12. Retenção dos anexos no R2 — lifecycle configurado, deleção não validada

- Bucket `pi-finance-ted-attachments`. Estado anterior: apenas o abort de
  multipart default de 7 dias.
- Autorização **expressa do operador** em 10/10/2026: regra de lifecycle
  `pi-finance-attachments-expire-after-one-day` aplicada — habilitada, prefixo
  `ted/attachments/v1/`, expiração após 1 dia.
- Readback confirma **ambas** as regras (multipart existente + nova). Sem lock
  no bucket.
- **Deleção física NÃO validada:** a regra é assíncrona, não há bucket de teste
  isolado e não houve run sintético de expiração. A retenção eficaz é
  **eventual e não provada** — não tratar como garantia de apagamento.
- O sweep do app continua **piggyback no upload**, bounded e retomável
  (TTL 24h, 10 páginas/50 objetos por varredura) e **não** é autônomo.

### Reconciliação dos critérios #107 (estado em 10/10/2026)

| Critério | Estado | Evidência/limite |
|---|---|---|
| Gate server-side (flag + storage) | **DONE / TESTED / PROD VERIFIED** | `upload-gate.ts`; matriz em `upload-gate.test.ts`; upload 200 + objeto R2 em 08/10 |
| Cohort attachment-specific | **DONE / TESTED / PROD VERIFIED** | Workspace/actor verificados no RPC; configuração live de attachments `*` — rollout geral, não coorte canary |
| Sink durável G07 de upload | **DONE / TESTED / PROD VERIFIED** | requested/blocked/succeeded/failed; leitura agregada autenticada 200 em 08/10. Deleção cleanup física não provada |
| R2 binding com gate OFF = zero write | **DONE / TESTED** | `r2-binding-off-proof.test.ts`; gate OFF retorna 503 e não grava objeto |
| Capability states enumerados | **MODEL IMPLEMENTED / LIVE INVENTORY PENDING** | Modelo puro tipado `apps/agent/src/attachments/capability-state.ts` deriva os cinco estados e mantém sete dimensões distintas; 45 testes unitários. Não coleta nem publica estado operacional/runtime e não promove A19 |
| Cleanup TTL do app | **DONE / TESTED**, live delete **BLOCKED/UNVERIFIED** | 24h; 10 páginas/50 objetos; cursor persistido, fail-safe; sweep dispara em upload (além de delete pontual ao resolver ref expirada). Lifecycle nativo cobre inatividade de modo eventual, sem prova física |
| G07/G08 para todas as modalidades | **PARTIAL / BLOCKED** | Sink atual cobre attachments; STT/Vision/web/autoexecute ainda não têm aceite/observabilidade suficiente para promoção conforme SPEC |
| Canaries e promoção | Attachments **ACTIVE** com coorte `*`; STT/Vision restritos ao workspace real `junio` (não sintético), sem novo teste nesta execução; PDF permanece disabled | Não ampliar coorte; não usar `junio` como ambiente de teste |

## 13. Golden Workflows — execução corrente e limites

`pnpm --filter pi-finance-agent test:golden` em 10/10/2026: Vitest **21 testes
passed**; relatório machine-readable com `total=29 pass=23 fail=0
skippedPending=6 falseSuccessCases=0` e `providerCalls=2` (stubs determinísticos,
nenhuma chamada de modelo real). `tokens`/`cost` = **`unknown`** por construção;
`latencyMs` é wall-clock da corrida isolada e **varia por execução** (não é
métrica de qualidade). Detalhes e limites em
`apps/agent/tests/golden/README.md`.

Seis casos `pending-capability` **não foram promovidos**: GW-016 (anexo),
GW-017 (PDF), GW-018 (STT), GW-019 (Vision), GW-020 (web) e GW-021
(autoexecute low-risk).

**Limites:** backend isolado em memória, **sem** integração com API/Postgres e
**sem** rede; provider é stub determinístico. Não é aceite full v1 e não
substitui a execução/aceite dos workflows completos da issue #105 pelo
operador. Custo e consumo de tokens são **desconhecidos** — nunca inventados.

## 14. Execução dos bloqueadores remanescentes (11/10/2026)

Baseline desta execução: `origin/main@65304dca`; branch `feat/v1-remaining-blockers`.
Seis arquivos modificados previamente em `docs/v1-hardening-postdeploy` foram
preservados em patch fora do checkout, comparados ao baseline e reaplicados
seletivamente nesta branch. Não houve checkout destrutivo nem reaplicação de
conteúdo já incluído em #133. O patch preservado está em
`%TEMP%/opencode/v1-hardening-postdeploy-preserved.patch`; o checkout original
continua intacto.

### Matriz de fechamento

| Frente | Código | Testes / evidência | Produção | Próximo gate |
|---|---|---|---|---|
| PDF smoke desabilitado | Nenhuma alteração de flag; parser segue incondicionalmente disabled | Fluxo oficial mapeado: proxy PWA exige origem válida para POST/CSRF; encaminha cookie, authorization e `X-Workspace-Id`; helper usa token de conexão de uso único; Worker resolve membership e grava identidade server-side; upload retorna `ref` opaca; envio de turno é RPC separado. Controle de UI não é requisito para RPC | **Não executado**: esta sessão não dispõe de sessão/cookie autenticado legítimo de Test Family. Não se usou `junio`, não se mintou identidade/tokens, nenhum PDF foi enviado. Código fail-closed + testes locais existentes provam `unsupported`/zero parser, não smoke live | Executar `uploadAttachment` e turno pela sessão real Test Family, sem mudar flags; verificar ref/workspace, objeto R2, `unsupported`, zero mutação e independência de imagem/áudio |
| Golden integrado #105 | Adapter test-only em `apps/api/tests/integration/golden-agent-real-api.test.ts`; Fastify real via `inject`, rotas V2, stores/escritas PostgreSQL reais; banco exige `DATABASE_URL_TEST` + `DB_TEST_MARKER` e guard; nomes produtivos bloqueados; seed/cleanup escopados e transacionais | 18 testes passam com PG 16 descartável; 3 verticais financeiras verificam estado e receipt por SQL, saldo exato e zero escrita em cancel/no-proposal. Suite rápida: 21/21; catálogo continua 29 total / 23 executáveis / 6 pending. API Postgres CI run `38120029936` PASS | Sem chamadas externas; DB descartável removido após validação | Implementar/validar undo, retry/redelivery/idempotência pelo orquestrador, isolamento cross-actor/workspace, falhas transport/inconclusivas, forget em SQLite DO e natural-language missing-data; issue permanece OPEN |
| Inventário A19 #107 | Novo modelo puro `capability-state.ts`: cinco estados e sete dimensões boolean/unknown; whitelist em runtime, sem segredos/texto livre; bloqueio operacional `unknown` não pode derivar `ACTIVE`; não conectado a runtime/endpoints | 45 testes unitários PASS; typecheck Agent PASS. Estados são derivados de evidência fornecida, não amostrados do runtime | **Não é inventário live**; estado produtivo não foi derivado pelo novo módulo | Definir e implementar composição interna dos sinais existentes; testes de contrato/integration e revisão de privacidade antes de qualquer superfície operacional. Atualizar #107 somente pelo critério comprovado |
| PDF seguro | Nenhuma implementação de parser novo; `pdfTextProcessorOverride()` segue sempre `undefined` | Pesquisa oficial: Worker/DO limita CPU por invocação, não por operação; memória é por isolate; `Promise.race`/fila não dão hard cancel/isolamento de PDF.js síncrono. Alternativas de kill/resource-bound: Cloudflare Container em microVM (mudança de arquitetura e plano pago) ou serviço isolado no Contabo (nova superfície operacional/egress); nenhuma escolhida ou criada | PDF permanece desabilitado; zero alteração de configuração ou deploy | Decisão de arquitetura/custo e política de privacidade/egress antes de iniciar serviço isolado; desenvolver/medir adversarialmente em ambiente isolado. Não considerar truncamento ou timeout de evento garantia |
| R2 lifecycle | Nenhuma mudança | Wrangler 4.135 `r2 bucket lifecycle list` releu 11/10: regra `pi-finance-attachments-expire-after-one-day` Enabled, prefixo exato `ted/attachments/v1/`, expiração 1 dia; regra default separada só aborta multipart após 7 dias, sem filtro de prefixo. Readback 10/10 após gravação também consta acima. Cloudflare documenta remoção tipicamente até 24h após `x-amz-expiration`, podendo atrasar mais para objetos existentes | **Regra confirmada; nenhum objeto elegível/expirado foi enumerado, nem deleção física confirmada.** A listagem de lifecycle não prova existência/exclusão; não há ref sintética exata nesta sessão. Outros prefixos não recebem a regra de expiração; nenhum objeto manualmente removido | **AWAITING_EXPIRY_EVIDENCE**: listar/HEAD apenas objetos sintéticos autorizados, capturar `x-amz-expiration`/metadata e reler após janela eventual; provar prefixo não alvo sem baixar conteúdo |
| STT | Sem mudança | Suites sintéticas/mocks existentes; Wrangler secret listing mostrou apenas presença do nome `GROQ_API_KEY`, sem ler valor. Manifesto tem STT on e coorte `d36cb...` | Coorte permanece household real `junio`; deliberadamente não usada. Sem quota/provider/precisão consultados nesta execução | Criar workspace sintético na coorte só com autorização específica; testar áudio sintético, silêncio, provider failure, timeout, duração, quota, telemetria e rollback; precisão pt-BR requer amostra voluntária/dataset autorizado |
| Vision | Sem mudança | Suites mock existentes; nome `GOOGLE_AI_STUDIO_KEY` presente, sem ler valor; manifesto mantém `gemini-2.5-flash` e coorte `d36cb...` | Sem turno Agent→provider→grounding, quota ou nova avaliação live; `junio` não foi usado | Workspace sintético autorizado/coorte já elegível; conferir valores/moeda, proveniência, injection e zero mutation, sem ampliar coorte nem mudar secret |
| Web | Sem mudança | Código oferece somente Tavily (`TAVILY_API_KEY`) ou Brave (`BRAVE_API_KEY`); sem ambas responde unavailable. Nenhuma dessas chaves aparece no Wrangler secret listing; não há provider gratuito alternativo configurado. Tavily anuncia 1.000 créditos/mês sem cartão; Brave Search anuncia US$5/1.000 chamadas e US$5 de crédito mensal; ambos ainda exigem conta/API key e revisão de privacidade | Sem provider/key confirmados no Worker; nenhum custo iniciado | Decisão do operador: (1) manter requisito obrigatório e adiar; (2) aprovar Tavily free tier/Brave ou outra solução com limite/custo explícitos; ou (3) alterar formalmente escopo V1 para V1.1. Opção 3 exige aprovação explícita |
| Autoexecute | Sem mudança; nenhum `on` aplicado | Contratos locais existentes não equivalem a métrica live | Último estado documentado é `SHADOW`; **não re-verificado** nesta sessão | Read-only conferir métricas, policy e kill switch; preparar canary isolado/checklist. Promoção para `on` requer autorização |
| Release B | Sem mudança | Gate temporal documentado para `2026-10-16T21:36:06Z`; esta execução em 11/10 não fez consulta ao sink de produção | Flip não executado | Antes/depois do horário: conferir sink/integridade e rollback; não antecipar flip |
| F3–F5 | Sem mudança | ADR-024/025 e runbooks existentes; nenhum backup/recon novo produzido nesta execução | Legado não aposentado | Preparar backup/reconciliação/runbook e obter aprovação antes de cutover |
| Restore | Sem mudança | Ensaio anonimizado prévio continua sendo evidência anterior; nenhum dump sensível copiado/restaurado aqui | Nenhuma restauração em produção | Acesso/controlos necessários para restore isolado de backup real; aguardar dependência sem transportar dump a destino não autorizado |
| Production E2E | Sem mudança | Smoke autenticado parcial documentado em §11: chat/leitura PASS, hashes financeiros iguais; PDF ficou antes do upload | Não repetido; nenhuma mutação | Sessão Test Family legítima para completar anexos e mutation receipts/undo; nunca usar household pessoal |

### Web search — decisão técnica

Não foi encontrado provider de busca sem API key já provisionado/autorizado no
runtime. O código atual só roteia Tavily → Brave e já possui limites de 10
resultados, timeout de 10 s e proveniência por URL/trecho (data apenas quando
fornecida); query é redigida antes do egress pelo caminho de evidência. Não
instalei provider, não criei conta e não consumi créditos. Fonte de preço oficial
consultada em 11/10/2026: [Tavily Pricing](https://tavily.com/pricing)
(1.000 créditos/mês no plano Free, sem cartão; créditos variam por operação e
param quando esgotados) e [Brave Search API](https://brave.com/search/api/)
(US$5/1.000 requests, US$5 em créditos mensais; API oferece proveniência/índice
independente; ZDR declarado só Enterprise). Custo não é o único gate:
privacidade/retention e qualidade pt-BR ainda precisam de validação. Recomendação
operacional: manter Web **unavailable** até o operador aprovar formalmente uma
opção de custo/privacidade; não alterar unilateralmente a SPEC nem mover para
V1.1.

### Evidências e limites desta execução

- HEAD inicial: `65304dca829f01f31c965810c7414dd50fcaddd0`; HEAD final:
  `b207b800e689c6cb1b1a8b356c638414898aea61`. Branch/PR draft:
  `feat/v1-remaining-blockers` / [#135](https://github.com/kust-projetos/meu-ted/pull/135).
  Os seis
  documentos locais preservados foram comparados e incorporados; arquivos:
  `apps/agent/AGENTS.md`, Golden README/case JSON, `docs/MEU-TED-V1-FINAL-STATE.md`,
  `docs/ROADMAP.md`, `docs/reports/2026-10-08-a19-provider-validation.md`.
- Issues #105 e #107 receberam comentários de progresso e permanecem OPEN.
  Required CI passou: workflow run `38120029936` (incl. Postgres/API/Agent/PWA,
  docs, security, governance, capabilities e write-policy) + required checks
  `38120029935` (`e2e (22, 10)` e `quality (22, 10)`) verdes. Jobs de publish
  image/release foram skipped por serem main-only. Nenhum merge/deploy ocorreu.
- Houve commit `b207b80` e publicação do branch/PR draft; nenhum segredo foi
  alterado, coorte ampliada, canary ativado, cobrança iniciada ou dado financeiro
  mutado.
- Código novo também altera `apps/api/src/db/db-guard.ts` e seus testes para
  bloquear sempre `pi_financeiro_canonical`; nenhum banco de produção foi
  consultado pelo harness. O Postgres de teste foi um container novo PG16 em
  filesystem temporário, limitado a 1 CPU/1 GiB e removido ao final.
- Pendentes decisórios: política de Web / escopo V1 vs V1.1; eventual execução
  isolada de PDF (custo/arquitetura/privacidade); autorização de workspace
  sintético para STT/Vision. Pendentes probatórios/operacionais: R2 exclusão
  física, métricas reais de autoexecute, consulta do sink Release B, gate F3–F5,
  restore isolado real e Production E2E completo.

### Atualização incremental — 11/10/2026 (execução PR #135)

Sem nova SPEC/PLAN, sem tocar nos seis arquivos preexistentes do outro
worktree, e sem alterar/deployar configuração produtiva.

| Frente | Evidência incremental | Estado honesto / saída |
|---|---|---|
| Golden #105 | A integração em `golden-agent-real-api.test.ts` foi ampliada com probes de lista/leitura/confirm/cancel/execute/retry/reconcile/expire, identidade com apenas ator, apenas workspace ou apenas device diferente, e comparação JSONB da linha inteira (inclui hash/consumo de attestation, autorização, tentativas, lease e receipt) antes/depois. Owner positivo confirma o sibling e as identidades estranhas tentam reutilizar essa attestation. O worker executou 19 testes contra PostgreSQL 16 descartável marcado; no checkout desta execução, sem `DATABASE_URL_TEST`/`DB_TEST_MARKER`, 15 testes sem DB passaram e 10 DB-backed foram skipped pelo gate. | **Parcial.** A prova de isolamento/replay está implementada e teve uma execução descartável relatada pelo worker; CI do HEAD atual ainda precisa executá-la. Ainda faltam verticais PostgreSQL para retry/redelivery/idempotência pelo orquestrador, transporte incerto/recuperação, undo completo, memória persistida/forget, leitura financeira, campos faltantes/clarificação/fragmentação e demais cenários da issue. Não promover os seis casos pending-capability. Issue #105 permanece OPEN. |
| Inventário A19 #107 — Phase A | O modelo de cinco estados/seven dimensões agora é composto em runtime no GET existente e autenticado `/rpc/attachments/observability`, aditivamente e por workspace/ator; não foi criado endpoint público novo. Flags usam parsers canônicos; configuração, flag, coorte, provider, canary e bloqueio permanecem dimensões separadas. Sink sem proveniência de build não promove provider/canary; `unknown` nunca deriva `ACTIVE`; PDF deriva `BLOCKED` pelo override incondicional `undefined`. Testes focados cobrem sanitização, config divergente/ausente, falha, scope e ausência de escrita. | **Engenharia Phase A candidata a concluída após CI/review do novo HEAD**: critérios textuais da issue #107 se limitam a gate/coorte/sink/inventário; rollouts, R2 expiração física, STT/Vision live, PDF privacy/egress e demais fases são gates posteriores, não razão automática para manter Phase A aberta. Ainda não declarar issue concluída até required CI e review no HEAD final. Sem mudança de flag/binding/coorte. |
| PDF smoke Test Family | Reinvestigação do fluxo confirma que upload e turno podem usar RPC autenticado mesmo sem controle de UI. Não há sessão legítima de Test Family disponível para este runtime. Para executar faltam sessão ativa obtida pelo login normal (cookie da PWA com origem/CSRF válidos) e o token de conexão de uso único emitido pelo fluxo normal; nenhum valor/token foi criado, inspecionado ou contornado. | **Não executado.** Nenhuma mudança de flag; parser continua OFF/fail-closed. Sem autorização/sessão legítima não é possível provar `unsupported` live nem zero mutação financeira em produção. Isso não bloqueia testes Golden descartáveis. |
| PDF — decisão técnica | Comparação documental atualizada (fontes oficiais Cloudflare Containers, pricing/limits/outbound e Contabo, consultadas em 11/10): Containers oferece isolamento microVM mais forte e egress controlável, mas requer Workers Paid (piso de conta US$5/mês, conta atual desconhecida), introduz nova imagem/rollout/operação, localização não determinística e mudanças de produto/compatibilidade antes de 31/12/2026. Contabo reaproveita a VPS e tem custo marginal de infraestrutura zero, mas Docker compartilha kernel com API/PostgreSQL e aumenta blast radius. Nenhuma opção resolve o bloqueio principal: o texto extraído ainda seguiria ao LLM relay/provider. | **Decisão desta entrega: não escolher nem implantar parser/serviço** enquanto egress, retenção e isolamento de dados não forem aprovados. Se esses gates forem resolvidos, prototipar primeiro Contabo só se houver isolamento real medido sem concorrer com API/Postgres; preferir microVM Cloudflare quando isolamento de código não confiável for requisito, após confirmar plano/custo/ciclo de vida. PDF permanece OFF. |
| STT/Vision — delta preparado | `apps/agent/wrangler.jsonc` mantém ambas as coortes apontando para o workspace real `junio`. O delta mínimo, aditivo e exclusivo à Test Family é substituir o valor de `TED_AUDIO_STT_COHORT` e `TED_VISION_COHORT` pelo único workspace sintético `550e8400-e29b-41d4-a716-446655440000`; nenhuma outra coorte ou workspace deve ser incluído. | **Proposta não aplicada.** Requer autorização específica antes de editar/deployar; nenhum canary/provider/quota foi chamado. |
| Web — Tavily Free | Pesquisa oficial em 11/10: pricing anuncia 1.000 créditos/mês sem cartão; basic/fast custa 1 crédito e advanced 2; `auto_parameters` pode elevar custo. A documentação indica que chaves de produção requerem plano pago ou PAYGO, então elegibilidade prática do Free para produção não está confirmada. Política de privacidade permite uso de partes das queries para melhorar respostas e compartilhamento limitado com provedores de índice; FAQ comercial de ZDR não foi reconciliado com compromisso contratual Free. Formato é `results[]` com URL/trecho e data estimada; 429 inclui `Retry-After`, 432/433 indicam limites de plano/conta. | **Desligado e sem conta/key/créditos consumidos.** Não cadastrar nem habilitar até o operador aprovar privacidade/egress e quota. Delta seguro futuro: fixar `search_depth=basic`, `auto_parameters` off, orçamento mensal bounded; retry limitado para 429, sem retry para 432/433; query só com intenção explícita sem dados/IDs financeiros; conteúdo/URLs tratados como não confiáveis e fontes preservadas. Contrato do adapter e filtros anti-injection/malware ainda precisam de validação antes de qualquer canary. |
| R2 lifecycle | Nenhum objeto sintético elegível com evidência física foi enumerado; regra readback confirmada e outros prefixos preservados. | **AWAITING_EXPIRY_EVIDENCE**. Não apagar manualmente nem fabricar PASS; aguardar elegibilidade + janela eventual e verificar somente objeto sintético via HEAD/listagem sanitizada. |
| Gates operacionais | Nenhuma consulta/mudança nesta execução: autoexecute não promovido a ON; Release B não antecipado; F3–F5 e cutover não executados; backup real não restaurado; nenhum recurso legado removido. | **Pendente de operador/evidência**: confirmar live metrics/policy/kill switch; depois de `2026-10-16T21:36:06Z` consultar sink Release B e rollback; aprovar checklist/backup/restore descartável/cutover quando aplicável. |

**Veredito desta execução:** `PARTIAL — TECHNICAL BLOCKERS REMAIN`. A implementação atual não fecha #105; a Phase A de #107 só pode ser considerada concluída após review e CI do HEAD final. Requerem operador: sessão Test Family para PDF smoke, autorização explícita para trocar coortes STT/Vision, decisão sobre egress/privacidade PDF e Tavily, além dos gates operacionais acima. Nenhum merge ou deploy ocorreu.

### Atualização incremental — 11/10/2026 (Golden Bloco A fase 2, branch não mergeada)

Branch `feat/golden-bloco-a-fase2-redelivery-recovery` sobre `origin/main@26a8daec` (PR #135). Escopo estrito ao Bloco A fase 2: sem PDF/STT/Vision/Web/infra, sem segundo harness, sem merge/deploy.

| Frente | Evidência incremental | Estado honesto / saída |
|---|---|---|
| Golden #105 — redelivery/recuperação | 3 testes novos em `apps/api/tests/integration/golden-agent-real-api.test.ts` (mesmo harness, Fastify real via inject, Postgres descartável, tenant sintético único): redelivery de confirmação (1 execução/1 efeito/recibo estável), falha transitória pós-persistência (inconclusivo + reconcile sem duplicar) e execução inconclusiva (sem falso-sucesso/falha definitiva, limites respeitados). Invariantes `DUPLICATE_FINANCIAL_EFFECT=FALSE_SUCCESS=UNAUTHORIZED_MUTATION=CROSS_WORKSPACE_LEAK=0` explícitos. Fix mínimo RED→GREEN em `conversation-orchestrator.ts` (+24/−3, ramo confirmation: reconcile via `listActive` → `renderInconclusive()` quando o alvo sai do set ativo; `failed` preservado caso contrário). Focado com PG: 22/22 PASS; sem env: 15 pass/7 skip; typecheck API+Agent, golden+memory 38/38, orchestration 349/349, biome limpo; tester PASS; reviewer+security REVIEWER APPROVED P0=P1=P2=0. | **Parcial (Bloco A fase 2 pronta para review/CI).** Não fecha #105: restam Blocos B–D (undo completo, forget persistido, read/grounding, missing-field/clarification/fragmented input, full mandatory matrix; 6 capability-gated seguem pending). |
| Issues #105/#107 | #105 estava CLOSED (fechamento 1s após merge do PR #135, prematuro ante o corpo do PR e os comentários que a mantinham OPEN); reaberta em 11/10 com comentário de reconciliação. #107 recebeu comentário de mapeamento + correção de base (mapeamento inicial usara checkout pré-PR135; na main o campo `capabilities` existe via `buildRuntimeCapabilityInventory`, `unknown` nunca deriva ACTIVE, PDF BLOCKED) e gate live registrado sem evidência inventada. | **#105 OPEN, #107 OPEN, A19 geral NOT READY.** Verificação autenticada live do observability segue pendente de sessão válida. |
| Divergência de SHA da API | API segue `bd1ed9b` na Contabo sem redeploy (inalterada desde 04/10); Agent/PWA na main avançaram via PRs documentais. | **Conhecida e intencional nesta entrega** — nenhum contrato V2 foi alterado; Golden prova contra a superfície autoritativa versionada, não contra deploy novo. |

Próximo bloco obrigatório da #105 (Bloco B): undo conversacional completo + redelivery com nova proposta pendente + concorrência de confirmação, com as mesmas garantias SQL/financeiras.

### Atualização incremental — 11/10/2026 (PR #137 Fase 1 sec-fix, branch não mergeada)

Branch `feat/golden-bloco-a-fase2-redelivery-recovery`, HEAD `c8ec2b3` (`fe7367f` sec-fix + `c8ec2b3` correção de lint `noUnusedVariables` no guard B, test-only). Sem merge/deploy. Revisão independente indisponível neste runtime (limite de uso dos workers reviewer/security-reviewer); há Planner-review APPROVED declarado como tal, não como independente.

| Frente | Evidência incremental | Estado honesto / saída |
|---|---|---|
| Fase 1 Caso A (MATERIAL, corrigido) | Replay da confirmação de A (mesmo intentionId) após A terminal + B pendente single-decidable confirmava+executava B (resolução por posição; RED provado `expected 2 to be 1`). Fix: binding idempotente `intentionId→(operationId+receipt)` no draft store (tabela `mutation_confirmations` no SQLite do DO em prod, InMemory em testes; nunca memória de instância — orquestrador é por-turno). Redelivery replaya o sucesso original sem listagem/confirm/execute; cross-actor/device nunca cruza pernas de identidade. Cobertura: suite isolada 4/4 + 3 guards PG SQL-verified (same-actor, cross-actor, B) + 5 unitários diretos do store SQL (round-trip, isolamento, TTL/expira+prune, upsert, DO pré-fix). Mudança deliberada: mesma chave→mesma resposta (replay do sucesso, mesmo receipt) em vez da cópia 'nenhuma pendente'. Autorização inalterada (capabilities/grants/attestation/API intactos). | **Corrigido e provado.** Residuais documentados: TTL 24h e ausência de store degradam ao comportamento anterior; escrita do marker é best-effort (API segue autoridade anti-duplo-efeito da mesma operação). |
| Fase 1 Caso B (SEMÂNTICO, corrigido) | `confirmTargetId` setado + `listActive` de reconciliação ilegível respondia `failed` definitivo com o dinheiro possivelmente movido (RED provado). Fix mínimo: `listingUnreadable` → `renderInconclusive()`; `failed` legítimo (alvo ainda ativo + listagem legível) preservado e pinado pelo ajuste só-teste em `t2-4-mutation-integration`. | **Corrigido e provado** (isolado + guard B PG com dupla falta execute+listagem). |
| Fase 1 Caso C (sem mudança) | `MutationExecutor.execute` já faz fail-closed (`approval.incomplete_result`) sem recibo válido em todos os caminhos de sucesso; guard PG "inconclusive execute" verde. | **Invariante confirmado**, nenhuma alteração. |
| Validação | PG descartável local (`pi-golden-redelivery-pg`): golden 25/25 (0 skip, 3 guards nomeados no verbose); isolada nova 4/4; orchestration 349/349; mutations+golden 207/207; mutation-draft-sql 18/18; typecheck agent+API verdes; tester independente PASS (com a lacuna de cobertura SQL que foi fechada nesta entrega). Biome local trava (intermitência conhecida); CI é autoritativo. CI do HEAD final `38181273002` em curso no push. | **Aguardando CI + review independente.** |
| A19 Phase A (#107) | Probe read-only: inventário é o campo `capabilities` no GET autenticado `/rpc/attachments/observability` (sem endpoint novo). Nenhuma sessão Test Family válida neste runtime (envs `PWA_LIVE_*` ausentes; `.auth/*.json` presentes porém de validade desconhecida; tokens single-use). Nenhuma chamada live executada, nada afirmado sem prova. | **#107 OPEN; A19 geral NOT READY.** Requer: um GET autenticado via proxy PWA com sessão Test Family legítima (nunca `junio`) conferindo 200 + capabilities íntegras + PDF BLOCKED + unknown preservado + zero segredos. |
| Gates operacionais | Sem merge/deploy; sem mudança de flag/binding/coorte/secret/modelo/banco; PDF OFF; API Contabo segue `bd1ed9b` (divergência intencional); backups e worktree preservados. | **Pendentes de operador** (iguais à execução anterior). |

**Veredito desta execução:** `PARTIAL — ADDITIONAL EVIDENCE REQUIRED`. O fix Fase 1 está implementado e provado (RED→GREEN + PG 25/25 + tester PASS + Planner-review APPROVED), mas o exit gate exige `CI=PASS` no HEAD final e `REVIEW=APPROVED` independente — ambos pendentes (CI em curso; reviewers indisponíveis por limite de uso). PR #137 permanece DRAFT até esses gates. V1 segue NOT READY. #105 e #107 seguem OPEN.

### Atualização incremental — 12/10/2026 (fechamento PR #137, Bloco B, Bloco C/D, #107 CLOSED)

Execução autônoma do operador (decisões técnicas delegadas; merges #137/#139 por autorização explícita pontual, #138 mergeado diretamente pelo operador com CI verde).

| Frente | Evidência incremental | Estado honesto / saída |
|---|---|---|
| PR #137 (Bloco A fase 2) | Falha CI `expected 60 to be 54`: causa raiz provada (V060 no manifesto legado quebraria o boot fail-closed da VPS, ledger V054) — V060 voltou a canonical-only (`cdaae39`); GW-023 recovery convergia para inconclusivo para sempre — replay reconcilia com a listagem (`717fbfc`). CI 100% verde → merge squash `b3861cf`. | **MERGED.** Boot VPS preservado; promoção V060 a legacy-safe só junto ao job de migration aprovado. |
| PR #138 (Bloco B) | GW-030 undo conversacional completo, GW-031 receita, GW-032 concorrência (1 efeito exato), todos SQL-verified vs PG real. 2 falhas de teste na 1ª rodada, ambas no teste (invariante com snapshot tardio; ordem de lock assumida) — produto correto; corrigidas (`96dfb03`, `523753e`). CI 100% verde. | **MERGED** (`36ccaac`, pelo operador). |
| PR #139 (Bloco C/D) | GW-033–038 determinísticos (categoria inexistente, conta não identificada, extrato com dados, fragmento de conta, forget redelivery, forget após esquecido) + fix real: resposta de conta roteada como read agora continua o rascunho (exceto consulta de saldo). Catálogo 35/29/6. CI 100% verde. | **MERGED** (`e7e15a3`). |
| #107 Phase A | Verificação dos 5 critérios contra o código no `main` + suite `tests/attachments` 405/405 local + CI verde; comentário de evidência + close. | **CLOSED.** A19 geral segue NOT READY (rollout/fases posteriores). |
| #105 | Comentário de progresso (Blocos A+B+C parcial). | **OPEN** (matriz completa, E2E final, capacidades adiadas). |
| Produção 12/10 | API Contabo `bd1ed9b` (`/health`+`/ready` 200 re-verificados, sem redeploy); Agent/PWA deployados e ATESTADOS em `36ccaac` (runs `38266117716`/`38266117889`, deploy-smoke-pass). Nenhuma flag/secret/coorte/modelo/banco alterado; zero mutação financeira. | Sem redeploy de API (compatível por design); deploys Cloudflare acompanham o `main`. |

**Veredito desta execução:** `PARTIAL_TECHNICAL_CLOSURE`. Núcleo Golden A+B+C/D fechado e em produção Cloudflare; pendem gates de operador/data: Release B (≥2026-10-16T21:36:06Z), cutover F3–F5, backup/restore proof, homologação E2E com sessão Test Family, e a matriz obrigatória final da #105.

### Atualização incremental — 12/10/2026 (avanço `36ccaac`→`bc2ba9e`, deploys atestados)

Em 12/10, Agent/PWA em produção avançaram de `36ccaac` para `bc2ba9e`
(`bc2ba9e11c3272d29d89b8e8c64aa7d01c85cb1d`, build `38313912315`, builtAt
`2026-10-12T21:58:24Z`): Agent Deploy run `38314671723` e PWA Deploy run
`38314671758`, com jobs gate+deploy+smoke+attest todos success e attestation
`ATTESTED` reason `deploy-smoke-pass` (attest jobs `115028677706`/`115028936543`).
CI `38313912283` + PWA CI `38313912315` success para o SHA. API Contabo segue
`bd1ed9b` sem redeploy (`/health`+`/ready` 200). `origin/main` = `bc2ba9e`
(verificado por `git rev-parse`, sem divergência). Nenhuma flag, secret, coorte,
modelo ou banco alterado; zero mutação financeira. A19 segue **NOT READY**.

### Atualização incremental — 13/10/2026 (PR #145 `e57bcec`, deploys atestados + E2E live PASS)

Em 13/10, o PR #145 (`fix(agent): closed-grammar presentation split before
nominal grounding` — split de presentation antes do nominal grounding em
`apps/agent/src/orchestration/account-grounding.ts` + testes em
`apps/agent/tests/orchestration/account-grounding.test.ts`) foi mergeado por
squash como `e57bcec` (`e57bcecb46fca664c412e8b47d71f9d0b5ef5291`).

| Frente | Evidência incremental | Estado honesto / saída |
|---|---|---|
| PR #145 (fix grounding) | Squash `e57bcec` em 13/10; escopo estrito a `account-grounding.ts` (+330/−26) + testes (+336); sem mudança de flags, secrets, coortes, modelos ou banco. | **MERGED.** |
| CI / PWA CI | CI `38325143697` success; PWA CI `38325143776` success após `rerun --failed` de 1 flake PUSH-02 (botão Entrar desabilitado, mesma família PWA-03/04; resto 152+39+matrix verde). | **GREEN.** |
| Produção 13/10 | Agent/PWA vivos em `e57bcec` (build `38325143776`); Agent Deploy run `38326659522` + PWA Deploy run `38326659650` success/`ATTESTED` deploy-smoke-pass na 2ª wave (1ª wave deploy-skipped:gate-not-ready); smoke read-only pós-deploy para o SHA. API Contabo segue `bd1ed9b` sem redeploy. Nenhuma flag, secret, coorte, modelo ou banco alterado. | Deployado e atestado; API inalterada por design. |
| E2E live-mobile-full | PASS em 13/10 (~2.6 min): login→conta→transação→extrato→TED leitura com valores→TED mutação com aprovação; `workspaceWriteViolations` vazio; executado só contra Test Family (workspace sintético). | **PASS** (homologação executada; não promove A19 sozinha). |
| Gates | A19 segue **NOT READY** (rollout, expiração física R2, bounded PDF, privacidade/egress, canaries STT/Vision); Release B com flip ABORTADO em 13/10 (nova janela ~2026-10-24T22:09Z); cutover F3–F5 pendente; PDF fail-closed (`TED_PDF_TEXT_ENABLED=0` + override `undefined`); coortes STT/Vision restritas ao workspace real `junio`. | Pendentes de operador/data. |

**Veredito desta execução:** `ROLLING_SNAPSHOT`. Produção Cloudflare em
`e57bcec` atestada + E2E live-mobile-full PASS registrados; nenhum gate humano
ou de data foi fechado por este snapshot.

### Atualização incremental — 13/10/2026 (Release B: flip ABORTADO, janela reancorada)

Leitura cuidadosa do sink `audit_logs`
(`event_type=auth.request.legacy_bearer_used`, filtro exclusivo `>`
`2026-10-02T21:36:06Z`) em 13/10 **superou a sonda anterior (COUNT=0)**:
**COUNT=136**, MIN `2026-10-02T21:36:06.027881Z`, MAX
`2026-10-10T22:09:01.594968Z`. Por dia: 10-02=2 (pós-âncora), 10-03=28,
10-04=57, 10-08=26, 10-10=23; 10-05/06/07/09/11/12/13=0. Dois workspaces
distintos, actor sempre device; burst final de 12 eventos em ~1s (retry-storm
provável). O flip previsto para 13/10 foi **ABORTADO** por evidência. Nova
janela zero-14-dias fecha **~2026-10-24T22:09Z** se nada mais ocorrer;
re-verificação agendada com a mesma query. A19 segue **NOT READY**; demais
gates intocados.

### Atualização incremental — 13/10/2026 (canary STT/Vision API-direto + aposentadoria formal)

Canary executado em 13/10 **via API direta** (não via PWA — a PWA deployada
não renderiza inputs de anexo/áudio; `caps.default-off` no build). Nenhuma
flag, secret, coorte, modelo ou banco foi alterado; nenhuma mutação
financeira foi criada pelo canary (auditoria pós-canary: só resíduo de 28/09).

#### (a) Declaração do operador: `junio` contém só dados de teste

O operador declarou **3x em 13/10** que o workspace `junio`
(`d36cb649-4462-486d-940a-47128ad329f2`) contém **só dados de teste** — nada
financeiro real; só pedidos de registro e perguntas. Isso **RETIFICA** a classificação anterior:
contradição com notas antigas que o descreviam literalmente como "household com dados financeiros reais": por declaração do operador em 13/10, o workspace contém só dados de teste. Evidência corroborante (não prova sozinha): o
workspace contém contas "E2E cleanup"/"Conta Teste E2E" e 8 transações de
28/09 ("Teste E2E mobile", "Diag click test", R$1,00). As menções antigas a "workspace real `junio`" ficam retificadas por esta nota. A19 segue **NOT READY** — o canary parcial não promove.

#### (b) Vision: FULL PASS

Upload `200` + turno `completed` via API direta, com extração exata
(LOJA TESTE LTDA / 13/10/2026 / R$12,34 / Retail / alta), caveats honestos,
pergunta de confirmação e **zero mutação**. PWA UI sem inputs — o canary foi
API-direto.

#### (c) STT: PARCIAL (finding aberto)

Upload `200` + Groq transcreveu (`attachmentStates` com `state=processed`:
"Áudio transcrito; o texto entrou na mensagem"), **MAS** turnos com
transcrição caem em fluxos de leitura/mutação que falham
(`FINANCIAL_EVIDENCE_UNAVAILABLE` / "consultar accounts" / handoff
inconclusivo INV-10) — verbatim transcrito **não verificado**. Auditoria
pós-canary: **zero mutações criadas** (só resíduo de 28/09). Causa provável:
roteamento do conteúdo transcrito ("valor doze reais...") para fluxos
financeiros — **finding aberto para debugger**.

#### (d) Lição de mídia: normalizar antes do canary

WAV via SAPI saiu com header inválido (sem tag `data`) → ffmpeg rejeita.
Lição: **normalizar a mídia antes do canary** (validar header/container).

#### (e) Resíduo de anexos TESTE

Anexos TESTE permanecem em `junio` sem rota de delete; expiram via **TTL 24h
/ sweep + lifecycle R2 de 1 dia**. Deleção física segue não validada (§12).

#### (f) Plano de aposentadoria formal do legado

O DB **nasceu canônico** (sem `legacy_archive`/marker); F3/F4 são **vácuos**.
Resta **F6** (backup + restore + recon — restore proof 12/10 PASS, rehearsal
F2 SYNTHETIC verde em 13/10) + **remoção de código**: 7 twins
`legacy-postgres`, ramo `DB_SCHEMA` legacy, bloco V1 pending-ops (linhas
381–459), flag legacy analytics. **KEEP** bearer até Release B. Divergência
conhecida S0 em `production-routes.ts:159` (budgets). Plano por PRs do
inventário: **PR-0/1/2/3**.

**Veredito desta execução:** `ROLLING_SNAPSHOT`. Canary Vision FULL PASS +
STT PARCIAL (finding aberto) registrados; A19 segue **NOT READY**; Release B
~24/10; PDF fail-closed.

### Atualização incremental — 13/10/2026 (canary UI via PWA `df23c3d` — estende b/c)

Canary UI executado em 13/10 via PWA `df23c3d` (ATTESTED), que renderiza
"Anexar imagem" + "Gravar áudio" (input de imagem com `accept image/*`) e
**não** renderiza "Anexar PDF" — flags IMAGE/AUDIO/MICROPHONE do PR #149.
Nenhuma flag, secret, coorte, modelo ou banco foi alterado; auditoria:
**zero mutações criadas** pelo canary UI.

#### (g) Vision UI: FULL PASS x3 (estende b)

Três turnos via UI com chip + extração exata + caveats + pergunta de
confirmação e **zero mutação**. Confirma o FULL PASS API-direto do bloco
(b) pelo caminho de UI.

#### (h) STT UI: verbatim OK, turnos falham (estende c)

Transcrição Groq comprovada **verbatim no histórico** ("Teste de
transcrição Recibo de teste, valor R$..." — Groq correta), **MAS** turnos
com transcrição falham ao responder (`FINANCIAL_EVIDENCE_UNAVAILABLE` /
accounts-read-fail / handoff inconclusivo INV-10). Causa provável:
conteúdo transcrito com valores é roteado para fluxos
financeiros/leitura/mutação (classe F1: o transcrito deve permanecer
**DADO** no texto composto, nunca em `decisionText` — o provável defeito
está nos consumidores do texto composto que tratam valores transcritos
como acionáveis). Finding segue
**aberto para debugger**.

#### (i) Correções honestas + resíduos

1. **M8 falso-positivo (1ª correção honesta):** o M8 do canary UI casou a
palavra "Transcreva" da **própria mensagem enviada** — falso-positivo,
**não** conta como evidência de transcrição. Métrica M8 descartada.
2. **Verbatim STT (2ª correção honesta):** o bloco (c) dizia "verbatim
transcrito **não verificado**"; o canary UI verificou o verbatim no
histórico e deslocou a falha para os **turnos**. Leitura corrigida,
finding mantido aberto.
3. Mic headless: a gravação headless exige `--use-fake-ui-for-media-stream`;
sem ela, o `getUserMedia` trava e a gravação nunca inicia.
4. Resíduo: anexos TESTE sem rota de delete expiram via **TTL 24h / sweep +
lifecycle R2 de 1 dia** (deleção física segue não validada, §12); mídias
locais do canary apagadas.

**Veredito desta execução:** `ROLLING_SNAPSHOT`. Canary UI (Vision FULL
PASS x3 + STT verbatim OK/turnos falhando + M8 falso-positivo registrado)
anexado ao canary 13/10; A19 segue **NOT READY**; Release B ~24/10; PDF
fail-closed.

### Atualização incremental — 13/10/2026 (outage API + recovery `414aefa`)

Outage da API Contabo em 13/10 (~15:44Z até a recuperação no mesmo dia),
durante o release de `3c3a3f9` (V1 routes retirement, PR #152). API
retornou 404 (crash-loop) no período; Agent/PWA (Cloudflare) não foram
afetados. Recuperação por forward-fix, PR #154 (squash `414aefa`).

#### (a) Timeline (UTC 13/10)

1. `3c3a3f9` — release 15:13Z fez rollback por V060 ausente no ledger
   (fail-closed correto, sem outage).
2. Migração V060 aplicada 15:35:36Z (0 drift, counts idênticos).
3. Retry do release 15:40:59Z — crash `FST_ERR_DUPLICATED_ROUTE`: o PR-1
   removeu o early-return `v2Only` e `/undo` passou a registrar 2x na
   composição. O CI não pega esta classe — os testes montam o router 1x.
4. Rollback recriou `bd1ed9b`, que não boota sob o startup guard com o ledger atual: V060 fora
   do manifesto V059 da imagem → crash-loop; API 404 desde ~15:44Z.
5. Forward-fix TDD (guard idempotente first-wins + teste de montagem
   dupla), suite 2493 pass, review APPROVED → merge #154 (`414aefa`).
6. Build `414aefa` + prova de boot isolada + swap manual + smokes verdes
   (gitSha/buildId casados), 0 restarts; rollback tag preservada;
   manifesto manual `release-manifest-414aefa-manual.json` na VPS.

#### (b) Produção vigente pós-recovery

API `414aefa` (ver §1) + Agent/PWA `e91a3cd`. Transcript T1/T2 validados no live `3e90c30` (codigo agent identico em `e91a3cd`, diff vazio).
A19 segue
**NOT READY**; Release B ~24/10; PDF fail-closed; cutover F3–F5 pendente.

#### (c) Incidente de segurança — rotação ENCERRADA em 13/10

`POSTGRES_PASSWORD` foi exibido em transcript de sessão de worker (acesso
restrito). Rotação **ENCERRADA em 13/10** na Contabo: senha nova ativa
(dual-test pelo caminho scram — nova autentica com `SELECT 1`, antiga
recebe FATAL, controle garbage discrimina), app healthy, smokes
`/health`+`/ready` 200 na API `414aefa`. Backup pré-rotação
`pi-db-20261013T195335Z` verificado. Backups `.env` `.bak-pre-rotate`
retidos com permissão restrita (contêm a senha antiga — remoção futura é
decisão do operador). Nenhum valor de segredo vai ao git.

Mecanismo apurado (descoberta durável): o compose declara a
`DATABASE_URL` por interpolação a partir de `POSTGRES_PASSWORD`; o `.env`
(normalizado de CRLF para LF, permissão restrita) contém
`POSTGRES_PASSWORD` e **não** contém `DATABASE_URL`. Um segundo `.env`
também foi rotacionado em disco (uso init-only, sem recreate). A hipótese
da fonte "shell do operador" foi descartada.

#### (d) Probes manuais malformados — toques congelados

Probes manuais malformados no PG às 15:48Z, autoria **segue desconhecida**.
**Manter toques manuais no banco congelados.** Follow-ups abertos:
endurecer `pg_hba` (trust em loopback/local → scram; só redes docker, sem
porta publicada — risco contido) e remover os `.bak-pre-rotate-*` após a
janela de retenção (decisão do operador).

#### (e) Lições para o runbook

1. Pré-checar ledger × manifesto da imagem-alvo antes do swap.
2. Rollback para imagem com manifesto < ledger é **inválido sob o startup guard atual** (alternativas: forward-fix compatível, ou
   restore a partir de backup).
3. Teste de boot em composição dupla no CI para a classe
   duplicate-route.
4. V060 fora do manifesto legacy por design (canonical-only).
5. Na rotação de segredo do Postgres: o `.env` é dono da senha
   (`POSTGRES_PASSWORD`, sem `DATABASE_URL` no arquivo), o compose
   interpola a `DATABASE_URL`, normalizar CRLF→LF e checar o segundo
   `.env` init-only; backup pré-rotação verificado antes de tocar no banco.

#### (f) Backups verificados

`pi-db-20261013T151220Z` (pré-V060) + `pi-db-20261013T154038Z` +
`pi-db-20261013T180741Z` + `pi-db-20261013T195335Z` (pré-rotação, verificado; sha256sum -c OK nos três; restore completo provado só para a âncora 12/10). Diretório `backups-local/` nunca
é deletado nem vai ao git.

**Veredito desta execução:** `RECOVERY_ATTESTED`. API 404 fechada por
forward-fix atestado em `414aefa`; rotação do segredo ENCERRADA
(mecanismo apurado + backup pré-rotação verificado); seguem como
follow-ups a autoria dos probes 15:48Z, o endurecimento do `pg_hba` e a
remoção futura dos `.bak-pre-rotate-*` — sem novo gate de produto. A19
segue **NOT READY**; Release B ~24/10; PDF fail-closed.
