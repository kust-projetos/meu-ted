# MEU-TED-V1-FINAL-STATE (estado vigente — snapshot somente-leitura)

**Atualizado:** 10/10/2026. Este documento é snapshot, não plano. A definição de
encerramento vive em `docs/MEU-TED-SPEC-V1-FINAL-CLOSURE.md`.

## 1. Produção viva

O merge do PR documental #133 (`65304dca`, squash em 10/10/2026) disparou
CI/PWA CI e os workflows oficiais de deploy sem path filters; o deploy foi
**executado e atestado**, e Agent/PWA passaram a reportar esse SHA. O código de
aplicação não mudou em relação a #132 — o SHA vigente é o do merge documental,
com evidência própria de CI/deploy/smoke.

| Camada | SHA vigente | Evidência |
|---|---|---|
| API (Contabo) | `bd1ed9b` (`bd1ed9bdbcaf99c407ac40f1d4a668099a405585`, build `37238430467`) | `/health` + `/ready` 200 em 10/10/2026, sem redeploy desde 04/10; `TED_RISK_BASED_AUTOEXECUTE=shadow`, `MIGRATIONS_MODE=disabled`, `DB_SCHEMA=canonical` preservados |
| Agent (Cloudflare) | `65304dca` (merge #133) | Deploy run `38086070929` success/`ATTESTED`; `agent-release-smoke` PASS ao vivo para o SHA; GET pós-deploy confirmou `ready` e SHA |
| PWA (Cloudflare) | `65304dca` (merge #133) | Deploy run `38086070927` success/`ATTESTED`; GET `/api/build-info` 200 reportando o mesmo SHA |
| origin/main | `65304dca` (PR #133) | CI `38085540279` e PWA CI `38085540233` success |
| Agent/PWA — último deploy atestado **antes** de #133 (histórico) | `687a7e8d` (PR #132) | Deploy runs `38081117169`/`38081117377`; CI `38080566857` / PWA CI `38080566817` |
| Credencial demo (E2E/prova) | `demo@clinicademo.com` | criada em 08/10 via fluxo de convite; membership owner no workspace E2E sintético `550e8400…` (Test Family); senha só no env do operador |

## 2. Matriz de capabilities (config-de-deploy; coluna Live = estado verificado)

| Capability | Código | Config-de-deploy | Live | Gate para avançar |
|---|---|---|---|---|
| Chat texto, memória/A17, skills/A18, forget two-step transacional | ACTIVE | ACTIVE | ACTIVE — chat/leitura comprovados no smoke autenticado de 10/10 (§11) | — (baseline V1) |
| Attachments (upload/R2) | ACTIVE | **ACTIVE** (`TED_ATTACHMENTS_ENABLED=1`, coorte `*`, binding R2 `pi-finance-ted-attachments`) | upload/R2 provados em 08/10 e coerentes com o smoke autenticado de 10/10; regra de lifecycle R2 de 1 dia **configurada** (§12), deleção física **não validada** | manter gates/cleanup; validar expiração antes de confiar na retenção |
| PDF textual | parser preservado, `pdfTextProcessorOverride()` retorna `undefined` incondicionalmente | Agent: manifesto `TED_PDF_TEXT_ENABLED=0`; PWA: `NEXT_PUBLIC_TED_ATTACHMENT_PDF` e flag master não estão no config versionado, default-off | Smoke autenticado de 10/10 **não** chegou a pedir PDF: a PWA deployada (`65304dca`) não renderizou input de arquivo PDF, e o smoke foi bloqueado antes do upload — zero request/upload/parser em produção. Teste local `pdf-gate-worklimit.test.ts` 10/10 PASS | **DISABLED / FAIL-CLOSED**. Reativação do parser bloqueada até isolamento/limites efetivos de CPU/memória e aprovação de privacidade/egress/retention; expor o botão de upload também requer build/deploy autorizado da PWA |
| STT (Groq whisper-large-v3-turbo) | disponível | manifesto com flag `1`, coorte restrita ao workspace real `junio` `d36cb649-4462-486d-940a-47128ad329f2` (household com dados financeiros reais, **não** o sintético Test Family `550e8400…`); secret presente segundo relatório 08/10 | probe sintético aprovado; voz real pendente; **sem** novo canary ou mudança de coorte em 10/10 | **WAITING_OPERATOR** para aceite de precisão/privacidade |
| Vision (Gemini `gemini-2.5-flash`, canary; Groq alternativo) | ACTIVE (código) | manifesto com flag `1`, provider/modelo allowlisted, coorte restrita ao workspace real `junio` `d36cb649-4462-486d-940a-47128ad329f2` (household com dados financeiros reais, **não** o sintético Test Family `550e8400…`) | extração sintética exata provada live em 08/10; turno completo Agent→relay/grounding e quota regular pendentes; **sem** novo canary ou mudança de coorte em 10/10 | **BLOCKED_EXTERNAL**: turno canary/cota e verificação de privacidade |
| web_search | disponível | UNKNOWN (key fora do repo; Tavily/Brave pago recusados) | UNKNOWN (inventário pendente) | F2.4 |
| web_fetch | disponível | DISABLED (allowlist ausente) | pendente | F2.4 |
| Decision provider (Jev/Clef/Strands) | disponível | DISABLED (default-off) | DISABLED | POST-V1 / OPTIONAL |
| Autoexecute low-risk | policy ativa | `SHADOW` | `SHADOW` (último conhecido; **não** re-verificado live em 10/10) | F3 (sink + canary) |

Regra: `infra provisionada != capability habilitada`; `repo config != live runtime`.

## 3. Flags — estados atuais (nem todas default-off; trava exata `=== '1'`)

| Flag | Estado atual | Restrição |
|---|---|---|
| `TED_ATTACHMENTS_ENABLED` (anexos) | `1` | coorte `*`; binding R2 `pi-finance-ted-attachments` |
| `TED_AUDIO_STT_ENABLED` (áudio/STT) | `1` | coorte restrita ao workspace **real** `junio` `d36cb649-4462-486d-940a-47128ad329f2` (household com dados financeiros reais, **não** o sintético Test Family); flag sozinha não autoriza egress |
| `TED_VISION_ENABLED` (Vision) | `1` | provider `gemini`, modelo `gemini-2.5-flash`, coorte restrita ao workspace **real** `junio` `d36cb649-4462-486d-940a-47128ad329f2` (household com dados financeiros reais, **não** o sintético Test Family) |
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
| #107 Phase A (gate+cohort+sink) | Gate de upload, coorte attachment-specific, sink G07 de upload e binding+OFF: **DONE + TESTED**; upload/R2 e baseline do sink: **PROD VERIFIED** em 08/10. Novo modelo puro e tipado para os cinco estados foi implementado/testado localmente; ainda **não coleta evidências live nem está wiringado no runtime**. Cleanup bounded/cursor: **TESTED**, deleção física live não validada; lifecycle R2 de 1 dia configurada e relida em 11/10, mas eventual. Attachment config live usa coorte `*` (geral), não canary restrito | **BLOCKED** para declarar A19 completa: modelo de estados ainda não é inventário operacional; falta prova de expiração física, bounded PDF + gate de privacidade/egress/retention e aceite dos canaries/modalidades exigidas. Não reimplementar gate/binding/sink existentes |
| #105 Golden Workflows | Suite rápida permanece 23/23 executáveis PASS, 6 `pending-capability`; nova integração API/PostgreSQL validou via SQL GW-023 propose→confirm→execute, GW-024 cancel e GW-025 confirmação sem proposta (Postgres 16 descartável) | **PARTIAL — ENGINEERING IN PROGRESS**: undo, retry/redelivery, idempotência conversacional, isolamento ator/workspace, forget persistido, falha de transporte/inconclusiva e linguagem natural com dados faltantes ainda não foram provados pela nova camada; issue permanece OPEN |
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
| Release B | **WAITING_DATE** | Gate temporal `2026-10-16T21:36:06Z` + zero eventos na janela e procedimento autorizado. |
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
O SHA **vigente** em Agent/PWA agora é `65304dca` (merge documental #133, sem
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
