# Closure A19 final do Agente Inteligente V1 — caminho real, tetos, texto/metadata, imunidade estrutural, cleanup, A17/A18 no runtime

**Data:** 2026-10-05 · **Issue:** [#89](https://github.com/kust-projetos/meu-ted/issues/89) · **Branch:** `feat/ted-agent-a19-final-closure` (base `main@2d36730`)
**Status:** implementado, testado (TDD RED→GREEN por slice), revisado adversarialmente; **nada deployado** — todos os flags de capacidade permanecem default-off e o deploy é passo de rollout separado.

## 1. HEAD inicial e final

- **HEAD inicial:** `2d36730` (`main`, merge do PR #88 — decision provider layer). Working tree limpa.
- **HEAD final:** ver §17 (último commit da branch `feat/ted-agent-a19-final-closure`).

## 2. Findings reproduzidos (RED) e root causes

| # | Severidade | Finding | Root cause |
| --- | --- | --- | --- |
| F1 | P0 | `POST /agents/finance-chat-agent/{ws}/rpc/attachments` retorna 404 texto no edge; upload só funcionava em testes de DO direto | `isRestRpc` (`worker.ts`) não incluía a rota — o DO tinha handler, mas o gateway nunca despachava |
| F2 | P0 | Todo upload >2 MB seria rejeitado mesmo com a rota liberada | `MAX_RPC_BODY_BYTES` (2 MB) aplicado a TODAS as rotas rpc; o contrato A13 permite imagem/áudio 10 MB e PDF 15 MB. O **proxy same-origin da PWA** (`api/agent/[...path]/route.ts`) tinha o MESMO teto de 2 MB — dois pontos de quebra no caminho real |
| F3 | P0 | Nomes de anexo entravam em `body.text` (`textWithAttachments`), contaminando o campo que o servidor lê para decisão/undo/retry (violação F1 da P5) | `handleSend` (TedChat) concatenava `[type: nome]` no texto do envio; com input vazio o NOME virava o texto do usuário (e duplicava o marcador); retry divergia (reenviava sem marcador) |
| F4 | P1 | Turno com anexo podia chegar ao fast path de autoexecute quando a extração era vazia (capability off = default de produção, provider down, `unsupported`, `skipped_budget`, upload recusado) | `isAutoExecutionEligible` NÃO recebia anexos: a imunidade era 100% lexical (marcador de proveniência no início do texto composto). Sem extração aceita, nada era composto, o texto ficava limpo e o cliente elevado era INJETADO (gate antigo: `attachmentData.length === 0`, i.e. dado extraído, não presença) |
| F5 | P1 | Cleanup TTL com starvation determinístico: expirados além da página 10 nunca eram alcançados | `listByExpiry` mantinha o cursor em variável LOCAL e cada sweep recomeçava no prefixo; o teto de 10 páginas por sweep nunca progredia |
| F6 | P1 | A17 (learning pós-turno) inerte em produção | Duplo bloqueio: (a) `learnFromTurn` guarda `assistantText === ''`; (b) o único call site passava `''` hard-coded E vivia atrás do early return que o wiring de produção SEMPRE toma (o orquestrador sempre devolve `response` via responseProvider). `bumpTurnCount` também estava no bloco morto |
| F7 | P1 | `forgetMemory` existia no store mas nenhum caminho do runtime o expunha ("esqueça isso" não tinha atendimento) | Sem tool/RPC; além disso `rememberFact` não consultava tombstone de conteúdo — o próximo turno heurístico REINSERIRIA o conteúdo esquecido (ressurreição) |
| F8 | P1 | A18 (user skills) inerte no runtime | `assembleCognition({ userSkills })` existia como seam testada, mas nenhum call site passava skills e `agent_user_skills` nem era criada no DO |
| F9 | — (bug novo pego por teste) | `loadUserSkills` retornava `[]` em agentes prototype-built | Field initializers de classe não rodam sem construtor (`Object.create(prototype)`) — flag e cache agora são lazy |

## 3. Correções (por slice, commits na ordem)

1. **`e6af590` — rota + tetos (F1, F2):** `/rpc/attachments` no dispatch autenticado; `readBoundedBody(request, limit)`; `MAX_ATTACHMENT_BODY_BYTES = Math.max(...ATTACHMENT_LIMITS.maxBytes)` (derivado do contrato, nunca literal); CORS aceita `x-ted-attachment-kind/name`; `TED_ATTACHMENTS_BUCKET?: unknown` no Env do Worker (pass-through fail-closed). Proxy da PWA: split por rota (`isAttachmentUploadPath`) + forward dos headers de claim.
2. **`f716726` — texto tipado + veto estrutural (F3, F4):** PWA `handleSend` envia só o digitado; anexo só no array `{type, ref, name}`; retry coerente por construção. Agent: `isAutoExecutionEligible` ganha `attachments` (presença = veto, antes de tudo); ambos os call sites passam `input.attachments`; cliente elevado gateado por `incomingAttachments.length === 0`. Invariante de assinatura + call sites fixados em teste (estilo channel-invariant).
3. **`20d48c1` — cleanup retomável (F5):** `sweepByExpiry(before, limit, startCursor)` reporta onde parou; `cleanupExpiredAttachments` persiste o cursor do fim da janela no DO (`AttachmentCleanupCheckpoint` via KV do DO), **limpa no wrap-around**, **segura a posição quando um delete falha** (retry idempotente; avançar deixaria o objeto órfão até o wrap) e faz fallback ao prefixo em cursor inválido (R2 rejeita token velho) — perder a posição custa um sweep, falhar o upload custa o anexo. Sem checkpoint: byte a byte o comportamento antigo.
4. **`3368a82` — A17 no runtime (F6, F7-parcial):** `recordPostTurnLearning` roda só após resposta publicada, com o texto real, nos DOIS caminhos (REST `/rpc/chat` e SDK); fail-closed não ensina; extractor LLM lazy (budget 1/5 turnos preservado); bloco morto removido. Tombstone de conteúdo `isContentForgotten` consulted by the job (o tool explícito `remember_fact` NÃO consulta: declaração deliberada sobrepõe forget).
5. **`51e9e97` — forget no runtime (F7):** tool `forget_memory` em `MEMORY_TOOL_NAMES`; candidatos resolvidos PELO RECALL do chamador (escopo por resolução: privado de outro ator = inexistente, sem oráculo; cross-workspace inalcançável); ambiguidade recusa sem vazar id; cascade + tombstone; resposta sem ids internos.
6. **`015c0a2` — A18 no runtime (F8, F9):** `loadUserSkills` (schema lazy, `listActiveUserSkills` → `toSelectableSkills`), injetado nos 2 call sites; zero custo sem skills (um SELECT, prompt byte a byte idêntico, sem fetch de catálogo); catálogo cacheado por DO/workspace; best-effort (falha degrada para sem-skills).
7. **`8699461` — E2E caminho real (§5).**

## 4. Testes RED→GREEN (evidência)

- Worker gateway: 17 testes — RED provado (404×7, 413/503/400 errados, CORS sem headers) antes do fix; suite `worker-attachments-gateway.test.ts`.
- Proxy PWA: 4 testes — RED `413 to be 200` (upload 3 MB) antes do split.
- Veto estrutural: RED = gate passava com anexo + imperativo digitado (estado sem extração); GREEN = 8 testes de gate + 2 de orquestrador (cliente elevado presente e ainda assim recusa; controle sem anexo continua canônico) + 7 estados no gateway real.
- Cursor: RED documentado (2 sweeps, zero deletes, toda chamada no prefixo) → GREEN 7 cenários (resume, wrap, crash-safety com delete flaky, cursor inválido, paridade sem checkpoint, wiring no DO com upload piggyback persistindo/limpando).
- A17: RED = ressurreição pós-forget (1 linha re-inserida) → GREEN 6 (wiring com texto real; provider fora não ensina; dedup; AGENT-008; forget→não-ressuscita; correção dedup/supersede/tombstone).
- Forget: RED 8/8 (tool inexistente) → GREEN 8.
- A18: RED 3 (loader `[]` com skills ativas — bug F9) → GREEN 8.
- E2E: 8 cenários pelo caminho real.

## 5. E2E executados

`tests/integration/a19-real-path.test.ts` (Worker real + DO real + relay mockado + auth mockada em camada):
1. conversação simples → resposta canônica do relay ponta a ponta;
2. fragmentado → 200 sem escrita (nunca `succeeded`);
3. mutação sem device → recusa honesta H-12 ("dispositivo autenticado"), nunca escrita;
4. anexo ponta a ponta → upload 200 pelo Worker → ref → turno com `attachmentStates[0] = {state:'unsupported', kind:'image'}` (default de produção) → resposta;
5. `sim confirmo.pdf` → nada confirmado/executado (`pendingOperation` ausente, sem receipt);
6. relay fora → degradação honesta ("não consegui acessar…"), nunca sucesso falso;
7. mesma `intentionId` → nenhuma duplicação de mensagens persistidas;
8. ref de outro workspace → `state: 'unavailable'`, sem dado do outro tenant, sem escrita.

## 6. Resultados das suítes

| Suite | Resultado |
| --- | --- |
| Agent (completa) | **1735 passed / 1 skipped** (161 arquivos) |
| PWA (completa) | **2416 passed** |
| `pnpm typecheck` (raiz, 5 workspaces) | exit 0 |
| `pnpm lint` | verde (agent/pwa/api/broker/contracts) |
| `pnpm docs:lint` | 0 issues |
| `pnpm governance:check` | verde |
| `wrangler deploy --dry-run` (agent) | ok — bindings DO + API_ORIGIN intactos, sem binding R2 (rollout) |
| PWA build | ver (§13) |

## 7. Review independente

Reviewer adversarial independente executado sobre o diff completo (foco: bypass por metadata/attachment, cross-actor, cross-workspace, idempotência, corrida, cache, stale state, oversized, streaming, fallback silencioso, falso sucesso, aprendizado indevido, ressurreição, skill elevando capability). Resultado consolidado no fim da sessão (§16).

## 8. Flags e capacidade — estado real

- **Continuam default-off (produção):** `NEXT_PUBLIC_TED_ATTACHMENT_*` (por tipo), `TED_AUDIO_STT_ENABLED`, `TED_VISION_ENABLED`, `TED_PDF_TEXT_ENABLED`, `TED_DECISION_PROVIDER` (nenhum transport construído), `GROQ_API_KEY` não provisionada, binding `TED_ATTACHMENTS_BUCKET` **não** adicionado ao `wrangler.jsonc` (503 fail-closed até o rollout).
- **Intocados:** `TED_RISK_BASED_AUTOEXECUTE=shadow`, Release B (gate 2026-10-16T21:36:06Z), cutover canônico F3–F5, G01/G02/G07/G08.

## 9. Reavaliação honesta de A19 (AC01–AC30, G01/G02/G07/G08)

- **AC01–AC12 / AC13–AC20 / AC21–AC30:** os critérios das fatias A00–A18 continuam verdes (suíte completa); esta closure não enfraqueceu nenhum guard — adicionou camadas (veto estrutural, tombstone de conteúdo, tetos por rota, cursor retomável).
- **O que A19 AINDA bloqueia (rollout, não código):** criar bucket R2 + binding; provisionar `GROQ_API_KEY` + ZDR Groq; ligar os flags por ambiente na ordem documentada; smoke `wrangler dev` do parse de PDF em `workerd`; habilitação do provider de decisão (exige G07).
- **O que A19 NÃO bloqueia mais:** o caminho real de upload funciona de ponta a ponta quando o rollout acontecer; os tetos são coerentes com o contrato; decisão e autoexecute são estruturalmente imunes a anexos; cleanup converge; A17/A18 aprendem e influenciam de verdade.
- **G01 (gateway de inferência própria) / G02 (provedor de dados)**: continuam abertos por decisão de produto — não bloqueiam NENHUMA capacidade desta entrega (tudo roda com o runtime atual e providers registrados via governança).
- **G07 (decision provider)**: continua bloqueando SOMENTE a habilitação do provider em produção (rollout/custo/SLO); o wiring default-off desta closure não o afeta.
- **G08 (canary autoexecute)**: continua bloqueando o flip `TED_RISK_BASED_AUTOEXECUTE=on`; esta closure ENDURECE o gate (veto estrutural por anexo) — nenhum gate foi alterado para ficar verde.

## 10. Limitações residuais reais

1. Cleanup segue **piggyback no upload** (sem alarm/cron) — convergência garantida pelo cursor, mas frequência depende de uploads.
2. Objeto com delete persistentemente falho segura a janela do cursor (recovery quando a falha cessa; wrap não progride enquanto a falha persistir).
3. Duração de áudio exata só para WAV (residual A13 documentado).
4. Detecção de CORREÇÃO estruturada no runtime: a maquinaria (fingerprint, supersede, tombstone) está implementada e testada no store/P4; o hook de runtime hoje ensina via heurística + extractor LLM — passar `correction` estruturada a partir da relação de continuação do rascunho é follow-up (seam pronta: `learnFromTurn({correction})`).
5. Teto de anexo na PWA é duplicado do contrato (sem dependência de workspace) — drift guard sugerido como follow-up.
6. E2E de navegador (Playwright) do fluxo upload→ref→send continua follow-up (suíte atual cobre worker→DO real em Node).
7. `evidence.payload_too_large` e demais tetos de envelope não mudaram.

## 11. Rollback

- Branch + PR: fechar o PR reverte tudo (nenhum deploy realizado).
- Cada slice é um commit atômico e independente por área (worker/proxy, TedChat+veto, storage/cleanup, memory, forget, skills, E2E) — revert seletivo possível sem conflito estrutural.
- Produção hoje NÃO roda nenhum destes caminhos habilitados (binding ausente + flags off): mesmo um merge acidental não ativa upload/STT/vision/PDF/provider.

## 12. Conclusão

**READY WITH CONTROLLED ROLLOUT.** O código da closure está pronto para merge; a habilitação das capacidades continua gateada por rollout (binding R2, credenciais+ZDR, flags, smoke `workerd`) e pelos gates humanos existentes (G07 para provider, G08 para canary autoexecute, Release B, cutover). Nenhuma pendência foi maquiada: A17 e A18 estão EFETIVAMENTE conectados ao runtime (com provas de caminho real), A19 deixa de ser "por fatia no papel" e passa a ter o caminho real provado por E2E.

## 13. Build da PWA

Resultado do `pnpm build` na PWA: ver seção de validação da sessão (executado no fim; verde/ver §16).

## 14. Estado A17 / A18 / A19 (resumo pedido)

- **A17:** EFETIVA no runtime — aprende com resposta real (heuristic toda turno + LLM 1/5), dedup, supersede via correção (store/P4), esquecimento com cascade + tombstone duplo (fingerprint E conteúdo), sem ressurreição pelo job, AGENT-008 bloqueando saldo/valor.
- **A18:** EFETIVA no runtime — skills ativas competem no budget do `assembleCognition`, dado delimitado sem capability, promoção exige replay+safety+humano (intocado), rollback restaura.
- **A19:** caminho real provado (E2E Worker→DO), tetos coerentes, imunidade estrutural, cleanup convergente; rollout por fatia continua gateado e documentado.
