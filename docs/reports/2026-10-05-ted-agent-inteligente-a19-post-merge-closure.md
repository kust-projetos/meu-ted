# Closure pós-merge do PR #90 (A19) — forget com resolução segura de alvo, learning após persistência definitiva, proxy PWA bounded

**Data:** 2026-10-05 · **Issue:** [#91](https://github.com/kust-projetos/meu-ted/issues/91) · **Branch:** `fix/ted-agent-a19-post-merge-closure` (base `main@5534ad91`)
**Status:** implementado (TDD RED→GREEN por finding), revisado adversarialmente em 3 rodadas; **nada deployado** — todos os flags de capacidade permanecem default-off e nenhum gate foi alterado.

## 0. Rastreabilidade da sequência (transparência)

O **PR #90** (mergeado como `5534ad91`) foi documentado — no seu relatório e no
review daquela época — como **"sem finding aberto P0/P1"**. Essa nota refletia o
alcance do review concluído naquele momento. Reviews **posteriores** ao merge
(2 comentários inline do Codex no PR + o review adversarial desta closure)
identificaram três findings reais que exigiram esta closure corretiva. Esta
sequência fica registrada sem maquiagem: a nota do PR #90 era verdadeira para o
escopo revisado então e **não** é mais o estado atual. Nenhum finding foi
reclassificado como "aceito" sem correção.

## 1. HEAD inicial e final

- **HEAD inicial:** `5534ad91` (`main`, merge do PR #90). Working tree limpa, `git pull` sem novidades.
- **HEAD final:** último commit da branch `fix/ted-agent-a19-post-merge-closure` (ver §7 para a lista de commits).

## 2. Findings, root causes e correções (RED → fix → GREEN)

| # | Severidade original | Finding | Root cause |
| --- | --- | --- | --- |
| F1 | P1 (Codex, PR #90) | `forget_memory` seleciona candidatos irrelevantes: memória única sem relação podia ser APAGADA por ser top-1; memórias não relacionadas causavam falsa ambiguidade | A decisão usava o ranking bruto do `recallMemories(query, limit: 5)`: 0→não achou, 1→esquece, >1→ambíguo. Recall é ranking de CONTEXTO (`salience × recência + overlap × 0.5`, sem exigência de overlap > 0) e pode devolver o melhor DISPONÍVEL, não o relacionado |
| F2 | P2→P1 (Codex, PR #90 + review interno) | Learning acontecia ANTES da persistência definitiva: `persistMessages` falho devolvia 502 com memória e contador já gravados ("turno que falhou para o usuário ensinou estado durável" — violação A17) | `recordPostTurnLearning` era chamado em `finance-chat-agent.ts` antes de `persistMessages([assistantMessage])` dentro do mesmo try; o catch devolvia 502 sem desfazer o estado ensinado |
| F3 | P1 (residual §7/§10 do relatório do PR #90) | Proxy same-origin da PWA bufferizava o corpo completo ANTES do teto: `await request.arrayBuffer()` e checagem depois | A validação antecipada de `Content-Length` não cobre corpo sem header, com valor mentiroso ou declarado menor que o real — nesses casos o corpo inteiro era bufferizado antes do 413 |
| F4 (round 1 do review desta closure) | P1 | Ambiguidade real podia DESAPARECER antes do filtro: o `limit: 5` do recall trunca o conjunto ANTES do filtro de relevância | Filtro aplicado sobre conjunto truncado por score: uma 2ª memória relevante com salience baixa ficava fora do top-5 quando irrelevantes de salience alta ocupavam o corte — unicidade falsa → exclusão sem desambiguação |
| F5 (round 1) | P1 | Ramo mutation aprendia SEM evidência durável: recusa (alvo ausente), desambiguação e erro capturado do coordinator devolvem resposta sem `turnResult.mutation` e mesmo assim ensinavam + avançavam contador | Gate do ramo era só `!failClosed`; o teste positivo original não provava proposta real (sem device → recusa exercida como se fosse evidência) |
| F6 (round 2) | P1 | Bypass de RETRY: "tenta de novo" roteia como plano `unsupported` (`fallbackPlan`), cai no ramo de LEITURA e ensinava recusas/falhas sem evidência | Enumeração de modos (`mutation-proposal|confirmation|cancel`) não cobre retry; `runRetryTurn` só materializa `mutation` no sucesso (:2258-2265), não nos caminhos de falha |

### Correções

1. **F1 — resolução segura de alvo.** `store.ts`: `FORGET_QUERY_STOP_TOKENS`
   (imperativos/deíticos que nunca são assunto), `FORGET_RELEVANCE_MIN_COVERAGE = 0.5` e
   `selectRelevantForgetCandidates(candidates, query)` — função PURA, sem LLM: assunto =
   tokens da query normalizados (reuso de `normalizeTokens`, accent/case folding) menos
   stopwords; candidato relevante sse ≥ 1 token do assunto casa e a cobertura
   `matched/subjectTokens ≥ 0.5`. `tools.ts`: 0 relevantes → "Não encontrei uma memória
   claramente correspondente." (conservador); 1 relevante → caminho existente
   (invalidate + cascade + tombstone); 2+ → ambiguidade com o número de relevantes.
   Escopos, shared visibility, ausência de existence oracle, ausência de ids internos:
   intocados.
2. **F4 — resolução sem truncamento.** `store.ts`: `listForgetCandidates(sql, {workspaceId,
   actor, scope?})` espelha EXATAMENTE a visibilidade do recall (opt-out, `workspace_id`,
   expiração, `invalidated_at IS NULL`, ator/shared com `includeShared` derivado de `scope`,
   `isCurrentFinancialState`) SEM score/sort/limit/budget e SEM o update lateral de
   `last_seen_at` (bookkeeping de recall não pertence à resolução destrutiva). Unicidade é
   provada sobre TODAS as memórias visíveis. `tools.ts` troca a fonte de candidatos.
3. **F2+F5+F6 — learning exige evidência definitiva do canal.** REST: payload capturado
   antes; `persistMessages` roda primeiro; learning só depois de confirmado; e o gate ficou
   UNIFORME por intenção: `!failClosed && (!needsMutation || turnResult.mutation)` no ramo
   de leitura (`needsMutation` = plano de mutação ∨ rascunho recuperável ∨
   confirmação/cancel ∨ retry — computado antes do runTurn) e
   `!failClosed && turnResult.mutation` no ramo de mutação. Retry de sucesso aprende
   (produz mutation); recusa/alvo ausente/desambiguação/erro não ensinam; cancel nunca
   materializa mutation e nunca ensina (conservador por desenho); continuação de rascunho
   sem operação materializada não ensina (decisão do Planner: conservador). Persistência do
   retry (history) INTOCADA. SDK: sem persistência intermediária visível (o framework
   `AIChatAgent` persiste pós-retorno) — evidência do canal = resposta completa
   não-fail-closed de `runTurn`, residual documentado no call site. Budgets intocados
   (heurística todo turno, LLM 1/5, timeout 10 s, DLP scrubbed nos dois ramos + SDK).
4. **F3 — proxy bounded.** `apps/pwa/src/app/api/agent/[...path]/route.ts`: `readBoundedBody(request, limit)`
   (port do conceito de `apps/agent/src/worker.ts:151-192`): 413 antecipado por
   Content-Length (guard `Number.isFinite`), fallback `arrayBuffer()` só quando
   `request.body` é null, leitura incremental em chunks com soma de bytes e
   `reader.cancel()` + 413 NO INSTANTE em que o teto é cruzado, merge dos chunks dentro do
   teto. Tetos INALTERADOS (chat/RPC 2 MB; attachment = máximo A13 15 MB); CSRF, headers,
   timeout e streaming de resposta intocados. Corpo vazio segue sem payload de body
   (paridade com o Worker).

## 3. Evidência RED → GREEN

- **F1 (RED):** com "Prefere usar Nubank" + "Prefere categoria Alimentação" e query
  "esqueça Nubank" → falsa ambiguidade (`expected false to be true`); com SÓ a memória de
  Alimentação → o código **apagava** a memória irrelevante (`expected true to be false`).
  6 unit tests: `TypeError: selectRelevantForgetcandidates is not a function`. GREEN: 37/37
  nos arquivos focados.
- **F2 (RED):** `persistMessages` rejeitando → turno devolvia 502 e o hook tinha sido
  chamado 1× (`expected "recordPostTurnLearning" to not be called at all`). Prova de guarda
  real: revert só do `finance-chat-agent.ts` via stash reproduz a falha. GREEN: 10/10.
- **F3 (RED):** 6 falhas — status já era 413, mas `cancel` NUNCA era chamado (corpo inteiro
  bufferizado primeiro; `expected +0 to be 1`). GREEN: 36/36 na rota; suíte estável PWA
  2430/2430.
- **F4 (RED):** contraexato do reviewer (2 relevantes salience 1.0/0.1 + 4 irrelevantes
  0.9, todas recentes) → o código esquecia sem ambiguidade (`expected true to be false`);
  scores reproduzidos em execução (1.25 / 0.9×4 / 0.35, corte determinístico do top-5).
  GREEN com `candidates: 6` (sem truncar) e ambiguidade.
- **F5 (RED):** 3 caminhos de recusa mutation aprendiam (`to not be called… but actually
  been called 1 times`). GREEN com negativos provando o ramo (assistant não persistida +
  `/pending-operations/v2/active` requisitada) e positivo REAL (proposal com
  `AGENT_DELEGATION_SECRET` + device + API mockada → `pendingOperation` proposto + contador
  avançado).
- **F6 (RED):** 3 negativos de retry (sem operação/ambíguo/erro) chamavam o hook com o
  texto da recusa. Todos real-path (listagem autoritativa consultada). Positivo de retry
  real-path: retry → execute com receipt ligado (operationId = pending id, entity.id = tx
  id), atravessando `MutationExecutor.receiptFromExecution` e o fail-closed de
  `approval.incomplete_result`. Nenhum seam foi necessário.
- Fix latente de TESTE (load-bearing, validado): o mock `memory-sql.ts` não consumia
  binding no ramo `expires_at IS NULL` — expiradas vazavam nos fixtures; agora fiel ao
  SQLite. Com o mock revertido, o teste de expiração falha (prova de que não é guarda
  vacuous). Nenhum teste de produção foi relaxado.

## 4. Review independente (3 rodadas)

| Rodada | Veredito | Findings |
| --- | --- | --- |
| 1 | CHANGES REQUIRED | F4 (P1, truncamento antes do filtro) + F5 (P1, evidência durável no ramo mutation) + P2 residual (redelivery do contador) |
| 2 | CHANGES REQUIRED | F6 (P1, bypass de retry) + notas: comentário do cancel impreciso ("cancel com status" — o contrato atual NUNCA materializa mutation no cancel); cobertura de asserções |
| 3 | **APPROVED** | 1 LOW (fortalecimento opcional de asserções: retry ambíguo sem assert de URL; retry-erro sem assert de texto determinístico — follow-up) |

Os três P1 (F4, F5+F6) foram corrigidos e re-verificados por leitura de código no round
seguinte. Tentativas de quebra SEM sucesso (rounds 1-3): memória irrelevante única,
falsa ambiguidade, cross-actor (sem oráculo), cross-workspace, shared, query vaga/só
stopwords, query parcial multi-token, acentos/case, termos comuns, tokens de 3 chars,
last_seen lateral, DLP, attachment-derived text, partial persistence, falha do
extractor, proxy sem Content-Length, Content-Length mentiroso/não-numérico, chunks que
cruzam o teto, cancel do stream, anexo válido no teto (exact-fit `>` vs `>=`), CSRF/timeout.

## 5. Suítes e validação local

| Gate | Resultado |
| --- | --- |
| Agent (completa) | **1765 passed / 1 skipped** (161 arquivos; baseline pré-closure 1736 → +29 testes) |
| PWA (completa, `test:stable`) | **2430 passed** |
| PWA build | ok (compiled successfully) |
| `wrangler deploy --dry-run` (agent) | ok — bindings DO + API_ORIGIN intactos, sem binding R2 (rollout) |
| `typecheck` agent/pwa | exit 0 |
| `lint` agent/pwa | 0 erros (warnings pré-existentes em arquivos não tocados) |
| `pnpm test` (raiz) + typecheck/lint/docs/governance raiz | ver §7 |

## 6. Flags e capacidade — estado real

- **Continuam default-off (produção):** `NEXT_PUBLIC_TED_ATTACHMENT_*`,
  `TED_AUDIO_STT_ENABLED`, `TED_VISION_ENABLED`, `TED_PDF_TEXT_ENABLED`,
  `TED_DECISION_PROVIDER`, `GROQ_API_KEY` não provisionada, binding
  `TED_ATTACHMENTS_BUCKET` ausente (503 fail-closed até o rollout).
- **Intocados:** `TED_RISK_BASED_AUTOEXECUTE=shadow`, Release B
  (gate 2026-10-16T21:36:06Z), cutover canônico F3–F5, G01/G02/G07/G08, A18 user skills,
  veto estrutural de autoexecute por anexo, tetos por rota.

## 7. Commits e CI remoto

- Commits na branch (um por unidade, revert seletivo possível):
  1. `4b917ea` — fix(agent): forget_memory com resolução segura de alvo (F1+F4).
  2. `7d62e14` — fix(agent): learning com evidência definitiva do canal (F2+F5+F6) + fix latente do mock SQL.
  3. `9d323b5` — fix(pwa): leitura bounded no proxy (F3).
  4. `b2b0fb5` — docs: relatório, SPEC §11.4, PLAN, CHANGELOG, AGENTS.md.
  5. `7f2df87` — fix(deps): override do transitive `proxy-addr` para a patched `>=2.0.8` (ver §7.1).
- CI do PR #92: ver §12 abaixo (preenchido após o run remoto).

### 7.1 Drift de advisory pós-merge (GHSA-jqcg-44mw-7w3h, crítico)

O primeiro run de CI do PR falhou no job **Security** (`pnpm audit
--audit-level=critical`): o advisory **GHSA-jqcg-44mw-7w3h** (crítico — IP
spoofing via IPv4-mapped IPv6 trust subnet em `proxy-addr` `>=1.1.0 <2.0.8`,
patched `>=2.0.8`) foi publicado **depois** do CI verde do PR #90 (2026-10-05) —
mesma classe do episódio `eslint-config-next` de 2026-10-03 (drift de advisory,
não regressão do PR). Cadeia: `apps/agent > agents > @modelcontextprotocol/sdk >
express > proxy-addr`. O bump do SDK `agents` é bloqueado pela issue #87 e o
gate não possui mecanismo de allowlist, então a correção foi um **override pnpm
do transitive** para a versão patched (`express` declara `~2.0.7`, portanto
`2.0.8` é resolução compatível) — fix real, não permissão. Validado: audit sem
critical, lockfile diff mínimo (6+/5−), suíte agent inalterada (1765/1skip).
Os 17 advisories restantes (13 high, 4 moderate) NÃO falham o gate
(`--audit-level=critical`) e permanecem inventariados para follow-up.

### 7.2 Segundo drift da mesma rodada (Scoped audit da PWA)

A primeira rodada de CI também falhou no job **PWA CI → Scoped audit**
(`scripts/pwa-audit.mjs`, gate com allowlist própria
`scripts/pwa-audit-allowlist.json`): o npm estendeu os ranges vulneráveis da
MESMA cadeia lighthouse (`@lhci/cli` agora `<=0.1.1-alpha.5 || >=0.3.6` com
`via` incluindo `proxy-agent`; `@lhci/utils` agora `>=0.3.6` com `via`
incluindo `js-yaml`) e publicou **GHSA-hp3w-g68c-fv3c** (moderate, DoS em
`sprintf-js`) cascateando `js-yaml` → `argparse`. Os cinco pacotes são
exclusivamente tooling build-time do Lighthouse CI (sem uso em runtime). A
correção seguiu o mecanismo projetado da allowlist: **entradas aditivas**
com a forma build-time estabelecida (owner, justificativa e expiração
2026-12-31 — a revisão já agendada no workflow `future-gate-allowlists-20261231`);
as entradas antigas permanecem e passam a reportar como `RESOLVED`. O bump
`@lhci/cli@0.13.0` (semver-major) é a resolução de fundo e fica para a
revisão da allowlist. Validado localmente contra o audit VIVO: gate
`ACCEPTED — 20 accepted, 5 resolved`, zero BLOCKED; policy tests 37/37
(`7f2df87` → deps; `70d4f99` → allowlist).

## 12. CI remoto

(preenchido após o run remoto)


## 8. Limitações residuais reais (classificadas)

1. **Redelivery do mesmo `intentionId` avança o contador de learning** sem dedup por
   intenção (preexistente; P2 do review round 1). Follow-up próprio: registro de
   processamento por (workspace, actor, intentionId) com proteção concorrente.
2. **Cancel nunca ensina** (conservador por desenho): `runCancelTurn` não materializa
   `mutation` no contrato atual; mudar isso é alteração de contrato do orquestrador, fora
   de escopo.
3. **SDK path:** a persistência do framework `AIChatAgent` ocorre pós-retorno de
   `onChatMessage`; a evidência de canal disponível é a resposta de `runTurn`. Residual
   documentado no call site (mesma regra, sem divergência de semântica).
4. **Continuação de rascunho sem operação materializada não ensina** (decisão deliberada —
   conservador; texto de continuação é de baixo conteúdo memorável).
5. **LOW do review round 3:** fortalecer asserções dos testes de retry ambíguo/erro (follow-up de teste).
6. `extractor` recebe também `assistantText` (por desenho — a resposta publicada é
   durável); o teste de anexo cobre o `userText`; cobertura do caminho indireto via LLM
   continua follow-up.
7. Residuais herdados do PR #90 intocados (cleanup piggyback sem alarm, duração de áudio
   só para WAV, teto PWA duplicado do contrato com drift guard sugerido, E2E Playwright do
   upload).

## 9. Rollback

- Fechar/reverter o PR reverte tudo (nenhum deploy; nenhuma env; nenhum binding).
- Commits atômicos por unidade (agent-memória, agent-learning, pwa-proxy, fixes de review,
  docs) — revert seletivo sem conflito estrutural.
- Produção NÃO roda nenhum caminho destes habilitado (flags off + binding R2 ausente):
  mesmo um merge imediato não ativa upload/STT/vision/PDF/provider/forget em tráfego real.

## 10. Estado final pedido

- **A17:** EFETIVA e agora honesta quanto à ordem — learning só após evidência definitiva
  do canal (persistência confirmada no REST; resposta de `runTurn` no SDK), intenção
  mutacional só com `turnResult.mutation`; budgets, DLP, tombstone duplo e dedup
  intocados.
- **`forget_memory`:** nunca apaga por top-1; memória irrelevante não gera falsa
  ambiguidade; só candidatos comprovadamente relevantes (cobertura ≥ 0.5, sem LLM) são
  esquecíveis; unicidade provada sobre o conjunto completo de visíveis (sem truncamento).
- **Limites de upload (PWA):** leitura bounded incremental com cancel mid-stream; tetos
  inalterados (2 MB chat/RPC; 15 MB attachment); Content-Length ausente/mentiroso não
  contorna.
- **A19:** permanece "código pronto, rollout gateado" — nada desta closure habilita
  capacidade em produção.
- **Gates ainda abertos:** Release B (2026-10-16T21:36:06Z), cutover F3–F5, canary
  autoexecute (G08), provider de decisão (G07), G01/G02 (produto), rollout A19 (binding R2,
  credenciais+ZDR, flags), future-dated 2026-12-01/2026-12-31.

## 11. Conclusão

**READY WITH CONTROLLED ROLLOUT.** Os três findings do briefing foram corrigidos com
RED→GREEN e o review adversarial elevou o total para seis (três P1 adicionais encontrados
e fechados nas rodadas 1-2). Nenhum invariante do PR #90 foi enfraquecido; nenhuma
capacidade foi habilitada; nenhum gate mudou. O rollout continua gateado exatamente como
na closure anterior (binding R2, credenciais+ZDR Groq, flags por ambiente, G07/G08,
Release B, cutover).
