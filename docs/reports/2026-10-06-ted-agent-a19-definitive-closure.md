# Closure definitiva da A19 — `forget_memory` com autorização discriminante, attestation de deploy com retry bounded

**Data:** 2026-10-06 · **Issue:** [#96](https://github.com/kust-projetos/meu-ted/issues/96) · **Branch:** `fix/ted-agent-a19-definitive-closure` (base `main@0cb7a72`)
**Status:** implementado (TDD RED→GREEN por unidade), revisado adversarialmente (2 reviewers independentes + rodada de re-review dos fixes), validado por tester independente.

## 1. HEAD inicial e final

- **HEAD inicial:** `0cb7a728fd24e2c618b4cf55a7f3b04b9979beda` (main, merge do PR #92; confirmado sem commits posteriores, working tree limpa).
- **HEAD final:** ver §10 (commits da branch).

## 2. Estado operacional herdado (o que esta closure encontrou)

O relatório pós-merge do PR #92 foi escrito com o status "**nada deployado**". Entre
aquele relatório e esta closure, os deploys automáticos pós-merge rodaram
(2026-10-06): CI/PWA CI verdes; **PWA Deploy verde com smoke verde**; **Agent Deploy
executou o deploy real** (run `37453906796`), publicou a versão às 11:04:31Z, e o
post-deploy smoke **falhou na attestation `buildSha == EXPECTED_SHA`** (~13 s após o
publish, curl único). A correção documental auditável está no §13 do relatório
pós-merge ([2026-10-05-ted-agent-inteligente-a19-post-merge-closure.md](2026-10-05-ted-agent-inteligente-a19-post-merge-closure.md));
a correção de código é o finding F2 desta closure.

## 3. Findings, root causes e correções

| # | Severidade | Finding | Root cause |
| --- | --- | --- | --- |
| F1 | P1 | `forget_memory` ainda podia apagar a memória ERRADA: query "esqueça minha preferência do banco Nubank" rejeitava o alvo correto ("Prefere usar Nubank" cobria 1/4 = 0.25 do assunto) e aceitava a memória errada ("Minha conta favorita é Banco do Brasil" cobria `minha`+`banco` = 2/4 = 0.5) como alvo único | A regra da closure anterior ("cobertura ≥ 0.5 dos tokens do assunto") conta vocabulário ESTRUTURAL (`minha`, `banco`, `preferencia`) que toda memória do mesmo KIND compartilha — cobertura genérica elegia por contagem, não por identificação |
| F1b | P1 (review round 2) | Bypass da regra discriminante por palavras de FUNÇÃO: "discriminante = token não listado" deixava passar `por` (cortesia — "esqueça … do banco Nu, por favor" apagava "Prefere pagar por Pix"), `nao/lembre/mais/disso` (deíticos da própria frase de esquecimento — "não lembre mais disso" apagava "Não gosta de café") | Enumerar o universo de palavras não-discriminantes é impossível; classes de função gramatical exigem classe própria (fechada por natureza), não omissão da lista de domínio |
| F2 | P1 operacional | Agent Deploy: attestation `buildSha == EXPECTED_SHA` falhou ~13 s após o publish (run `37453906796`); produção convergiu para `0cb7a72` depois (verificado no `/health`: `buildId=37453076114` = run do CI main) | Propagação de versão do Cloudflare Workers é EVENTUALMENTE CONSISTENTE: o `wrangler deploy` retorna no plano de controle e a edge converge em segundos — o smoke de curl único é uma corrida (deploys anteriores passaram por sorte de timing). Hipóteses alternativas descartadas: `wrangler.jsonc` não define `BUILD_SHA` (só `API_ORIGIN` — sem precedence CLI×config); `/health` é servido pelo Worker (nunca pelo DO); host dedicado workers.dev (sem route cruzada); `--var BUILD_SHA` provado funcional pela convergência |
| F2b/F2c | P2 (review deploy round 2) | (b) `fetch` sem `redirect: "manual"` — um 3xx para outro host que reportasse o SHA esperado seria atestado como PASS (fail-open de identidade); (c) tentativa sem deadline — request pendurado consumiria o timeout do job sem diagnóstico final | Injeção de `fetchImpl` sem política de redirect/signal |

### Correções

1. **F1 — só correspondência DISCRIMINANTE autoriza exclusão.** `store.ts`:
   `extractForgetQueryDiscriminators(query)` = tokens normalizados − COMANDO
   (`FORGET_QUERY_STOP_TOKENS`, intocado) − ESTRUTURAL/GENÉRICO (novo
   `FORGET_GENERIC_STRUCTURE_TOKENS`: possessivos + substantivos de
   estrutura/domínio com plurais — nomeiam a CATEGORIA, nunca o alvo) − FUNÇÃO
   (novo `FORGET_FUNCTION_TOKENS`, F1b). Candidato esquecível sse contém ≥ 1
   discriminante (match exato de token normalizado, sem stemming); discriminantes
   vazios ⇒ `[]` (nada é esquecido; o tool pede especificação concreta). Removido
   `FORGET_RELEVANCE_MIN_COVERAGE` (cobertura genérica deixou de ser conceito de
   autorização). `listForgetCandidates` (visibilidade completa, sem truncamento),
   cascade, tombstone e ausência de ids internos: intocados. `tools.ts`: 0 relevantes
   sem discriminantes → "Diga mais especificamente…"; 0 com discriminantes →
   "Não encontrei…" honesto; 2+ → ambiguidade; 1 → esquece. **A lista genérica não é
   load-bearing para segurança** (estrutura não listada → ambiguidade ou alvo único
   AUTO-DESCRITO — decisão do Planner fixada em teste; entrada em excesso → "não
   encontrado"); a lista de FUNÇÃO é fechada por natureza gramatical e deliberadamente
   ampla porque funcionais infestam qualquer conteúdo. Residual fail-closed: tokens
   ≤ 2 chars ("XP") nunca autorizam — viram pedido de especificação.
2. **F1b — classe FUNCTION.** ~90 palavras: preposições/conectivos, cortesia
   ("por", "obrigado", "gentileza"), deíticos/discurso ("disso", "agora", "talvez"…),
   negação ("nao", "nem", "jamais"), quantificadores ("mais", "muito", "todo"…),
   família lembrar/esquecer ("lembre", "lembrar"…). Omissão de funcional só autoriza
   se o conteúdo a contém E é alvo único (ambiguidade em diante) — traps canônicos
   pinados por teste.
3. **F2 — smoke com retry bounded.** Novo `scripts/agent-release-smoke.mjs`
   (`evaluateHealthPayload` puro + `runAgentReleaseSmoke` + `parseArgs` fail-closed):
   404 → FAIL imediato; **3xx → FAIL imediato, nunca seguido (F2b: a attestation
   prova a origem CANÔNICA, `redirect: "manual"`)**; ≥400/rede/non-JSON → retry;
   `ready` sem `buildSha` → FAIL imediato (violação de contrato — propagação nunca
   remove o campo; o handler sempre inclui `buildSha` com fallback `"dev"`); match →
   PASS; diferente → retry (8 × 5 s) e FAIL com o último SHA observado ao esgotar.
   **F2c: cada tentativa tem deadline próprio (`AbortSignal.timeout(requestTimeoutMs)`,
   default 5 s, cobrindo connect+headers+body — abort não consome o timeout do job;
   pior caso explícito 8 × (5 s + 5 s) ≈ 80 s, dentro do `timeout-minutes: 10`).**
   Log por tentativa com o SHA observado (auditoria do que a edge servia).
   `.github/workflows/agent-deploy.yml`: só o step de attestation mudou (helper com
   `$AGENT_PROD_URL` canônica de `$GITHUB_ENV` + `$EXPECTED_SHA`); health-ready curls
   e API health intocados. **Falha verdadeira continua falhando — o retry acomoda
   apenas a convergência.**
4. **F2c LOW — teste falso-verde corrigido:** a asserção de sanitização usava URL
   HTTPS VÁLIDA (nunca lançava) e o `assert.fail` era capturado pelo próprio catch;
   agora usa URL genuinamente não-parseável + `assert.throws` com predicate
   (`/invalid --url/ && !message.includes(marker)`).

## 4. Evidência RED → GREEN

- **F1 (RED):** scratch reproduzindo a lógica ANTIGA (`main@0cb7a72`) fiel ao código:
  subject `{minha, preferencia, banco, nubank}`; candidata correta 1/4 = 0.25
  REJEITADA; candidata errada 2/4 = 0.50 ACEITA → `OLD LOGIC SELECIONA:
  ["Minha conta favorita é Banco do Brasil"]` (a memória errada). 7 falhas nos testes
  novos antes da implementação. GREEN: 46/46 focados.
- **F1b (RED → re-review):** os traps do reviewer viraram regressões (round 1: 3 store
  + 2 runtime no fluxo real com sobreviventes por conteúdo exato; round 2b: +1 tabela
  com as 7 queries literais × 7 conteúdos + +1 caso crítico no fluxo real — "pela
  conta Nu" com o alvo correto presente). GREEN: 53/53 focados; suíte completa do
  agent **1783 passed / 1 skipped**.
- **F2 (contrato):** 21 testes (`node --test`): os 6 casos do briefing
  (match→PASS; converge depois→PASS com retries; nunca converge→FAIL; ready sem
  buildSha→FAIL imediato; diferente→FAIL; 404→FAIL imediato) + transientes
  (rede/JSON/5xx/status≠ready) + redirect fail-imediato (nunca seguido) + deadline
  (signal por tentativa; corpo lento abortado classificado como "deadline exceeded
  while reading body") + abort→retry + CLI fail-closed (incl. `--request-timeout-ms`).
  GREEN 21/21; `validate-deploy-workflows` 6/6 (novo teste exige o helper e a
  ausência do grep único); `validate-deploy-origins` 10/10.
  Smoke REAL read-only contra produção: PASS (SHA `0cb7a72` convergido), com
  `redirect: "manual"` e signal ativos.

## 5. Review independente

| Rodada | Veredito | Achados |
| --- | --- | --- |
| Reviewer memória (round 1) | CHANGES REQUIRED | F1b (P1): bypass por palavras de função (3 reproduções literais) |
| Reviewer deploy (round 1) | CHANGES REQUIRED | F2b/F2c (P2: redirect fail-open; request sem deadline) + LOW (teste falso-verde) |
| Re-review deploy (round 2) | **APPROVED** | 3 findings fechados; LOW residual de cobertura de testes (corpo lento + validação do flag) → adicionado nesta closure |
| Reviewer memória (round 2) | CHANGES REQUIRED | F1b persistia: 7 bypasses novos (`pela/pra/mim/que/quero/pode/nada/das/pelo/dos/respeito`) — classe funcional reescrita como stopwords pt-BR padrão estendidas |
| Re-review memória (round 2b) | CHANGES REQUIRED | 8 bypasses novos (`acerca/inclusive/alem/causa/proposito/podemos/gostaria/hmm`) — locuções congeladas, advérbios de moldura, modais e interjeições incorporados |
| Re-review memória (round 3, critério reenquadrado) | **APPROVED** | Nenhuma violação dos invariantes estruturais (ranking/genérico nunca autorizam; 2+ = ambiguidade; query sem discriminante = nada; alvo apagado sempre contém token escrito pelo usuário). 2 LOW não bloqueantes aplicados: +8 termos de endurecimento pinados; JSDoc distingue alvo direto de cascade descendentes |
| Tester independente | PASS | RED reproduzido na lógica antiga; Agent 1776/1skip (antes do round 2b), PWA 2447, typecheck 5/5 workspaces, 32 testes de script, gates rápidos verdes, `wrangler deploy --dry-run` ok |
| MCP Jev (decisão de commit) | proceder 0.83 | `jev_gate` block ruidoso (confiança 0.21) esclarecido por `jev_decide`: não destrutivo 0.05, escopo autorizado 0.94, sem evidência faltante 0.10 |

## 6. Suítes e validação local (estado final da branch)

| Gate | Resultado |
| --- | --- |
| Agent (completa) | **1785 passed / 1 skipped** (162 arquivos; baseline 1776 → +9 regressões) |
| PWA (`test:stable`) | **2447 passed** (nenhum arquivo PWA tocado) |
| typecheck (raiz, 5 workspaces) + `tsc --noEmit` agent | exit 0 |
| Scripts (`agent-release-smoke`, `validate-deploy-workflows`, `validate-deploy-origins`) | 21 + 6 + 10 verdes |
| Gates rápidos (docs:lint, governance, capabilities, write-policy, public-safety --strict, test:skip-gate, action-pins) | verdes |
| `wrangler deploy --dry-run` (agent) | ok — bindings DO + API_ORIGIN intactos, sem R2 |
| Smoke real read-only (`/health` produção) | PASS, `buildSha=0cb7a72…` |

## 7. Flags e capacidade — estado real

- **Continuam default-off (produção):** `NEXT_PUBLIC_TED_ATTACHMENT_*`,
  `TED_AUDIO_STT_ENABLED`, `TED_VISION_ENABLED`, `TED_PDF_TEXT_ENABLED`,
  `TED_DECISION_PROVIDER`, `GROQ_API_KEY` não provisionada, binding
  `TED_ATTACHMENTS_BUCKET` ausente. Nenhuma capacidade foi habilitada nesta closure.
- **Intocados:** `TED_RISK_BASED_AUTOEXECUTE=shadow`, Release B
  (gate 2026-10-16T21:36:06Z), cutover canônico F3–F5, G01/G02/G07/G08, A18 user
  skills, veto estrutural de autoexecute, tetos por rota, overrides de dependências
  (`proxy-addr`, `source-map-js`) e allowlists com expiração.

### 7.1 Quarto drift de advisory da rodada (Scoped audit da PWA — sharp + cadeia)

O primeiro run de CI do PR #97 falhou no `quality (22, 10) → Scoped audit` com
QUATRO BLOCKED novos — o npm publicou um TERCEIRO advisory de sharp
(GHSA-wq5f-xc86-pv6w, librsvg CVE-2026-96889, estendendo o range vulnerável para
`<=0.35.5-rc.1`), e a mesma vulnerabilidade projetou-se pela cadeia de
dependências (`miniflare→sharp`, `wrangler→miniflare`,
`@opennextjs/cloudflare→wrangler`). Diagnóstico (§14 do briefing):

- **`sharp` (runtime):** o "fix" `0.35.5` JÁ É conhecido e RECUSADO pelo repo — a
  allowlist existente (`pwa-2026-09-19-sharp`) documenta que sharp 0.35.x **quebra o
  bundle OpenNext Cloudflare no Windows**; o pin scoped `next>sharp@0.34.5` é
  deliberado, aceito com expiração 2026-12-31. O drift é apenas de RANGE: a nova
  record (`effects: [miniflare, next]`, range estendido, 3 advisories via) não casa
  mais com as entradas antigas do matcher canônico exato.
- **`miniflare`/`wrangler`/`@opennextjs/cloudflare` (build-time):** afetados EXCLUSIVAMENTE
  via sharp; os "fixAvailable" do npm são **downgrades em cascata** (wrangler
  4.135.0→4.15.2, @opennextjs 1.20.2→1.1.0) que regrediriam a toolchain de build/deploy.
  Nenhum roda em produção Cloudflare.
- **Mitigação mínima correta** (precedente §7.2 do relatório pós-merge — mecanismo
  projetado do gate): 4 entradas ADITIVAS em `scripts/pwa-audit-allowlist.json` com
  as records canônicas exatas do audit vivo, owner, justificativa por pacote e
  expiração **2026-12-31** (a revisão já agendada no workflow
  `future-gate-allowlists-20261231`). Nenhum Critical escondido (todos HIGH);
  nenhuma entrada antiga removida (passam a reportar `RESOLVED`, casando de novo se
  a shape do npm reverter). Gate local: `ACCEPTED — 23 accepted, 6 resolved, zero
  BLOCKED`; policy tests 12/12.

## 8. Limitações residuais reais (classificadas)

1. **Orçamento de propagação (35 s de espera + 40 s de requests) não tem
   suficiência demonstrada contra a distribuição real de latência da Cloudflare** —
   se a propagação exceder a janela, o smoke voltará a falhar (honestamente: FAIL,
   não verde). Follow-up: medir a latência de convergência em produção antes de
   ajustar `--max-attempts`/`--base-delay-ms`.
2. Tokens ≤ 2 chars ("XP") nunca autorizam forget (fail-closed — pedido de
   especificação). Stemming não existe (marcas com flexão morfológica não casam).
3. Termo de domínio não listado que o conteúdo usa LITERALMENTE autoriza alvo único
   auto-descrito (decisão do Planner, fixada em teste); query com sinônimo que o
   conteúdo não usa autoriza nada.
4. Política OR de discriminantes: "esqueça Nubank e Itaú" com só Nubank existente
   esquece Nubank (o pedido parcial não é reportado como parcial) — preexistente,
   sem risco de exclusão errada.
5. Residuais herdados intocados (§13 do relatório pós-merge): redelivery sem dedup
   por `intentionId`, cancel não ensina, LOW de asserções, E2E Playwright do upload.

## 9. Rollback

- Reverter o PR reverte tudo (nenhuma env, binding, flag ou migration).
- Commits atômicos por unidade (agent-memória, smoke-deploy, docs) — revert seletivo.
- Produção NÃO roda nenhum caminho novo habilitado: o forget já existia gated pelo
  A19/rollout e o smoke é infra de CI.

## 10. CI remoto, deploy e attestation

**CI do PR #97 (4 rodadas — as duas primeiras com drift de advisory):**

| Rodada | Commit | Resultado |
| --- | --- | --- |
| 1 | `17c5986`/`383acba`/`2fe73a1` | FAIL — `quality (22, 10) → Scoped audit`: npm publicou 3º advisory de sharp (GHSA-wq5f-xc86-pv6w, librsvg, range estendido a `<=0.35.5-rc.1`) projetado pela cadeia `miniflare→wrangler→@opennextjs` (§7.1) |
| 2 | `e19deb9` | FAIL — mesmo step: a shape do grafo npm do CI resolve `effects:[miniflare]` (sem `next`), e o matcher canônico exato não casou com a entrada local (`[miniflare, next]`) |
| 3 | `1b8afcd` | **ALL GREEN** — 17/17 checks, incluindo required `Gate — all checks` + `quality (22, 10)` |

**Merge:** PR #97 mergeado como **`98fe4038b73c5a16eaad2d560ddf9869fb3122c5`** (`main`).

**Deploys pós-merge (workflows automáticos, ambos success):**

| Pipeline | Run | Resultado |
| --- | --- | --- |
| Agent Deploy (1º evento, par skip "not ready") | `37507379938` | success (deploy skipped — CI/PWA CI ainda em progresso) |
| PWA Deploy (1º evento) | `37507379986` | success |
| **Agent Deploy (deploy real)** | `37507687738` | **success — Gate + deploy + Post-deploy smoke** |
| **PWA Deploy (deploy real)** | `37507687738`-par | success |

**Attestation de release (o teste real do fix F2):** o job `Post-deploy smoke
(read-only)` executou o novo smoke e o log do CI registra
`[agent-release-smoke] attempt 1/8: PASS — buildSha matches expected` — convergência
na primeira tentativa, com retry bounded disponível caso a propagação atrasasse.

**Cadeia autoritativa provada:** HEAD mergeado (`98fe403…`) = run de CI
(`37506599337`, o `buildId` reportado) = SHA implantado (`--var BUILD_SHA`) =
`buildSha` retornado pelo `/health` de produção (verificação read-only independente
pós-deploy: `{"status":"ready","schemaVersion":5,"buildSha":"98fe4038b73c5a16eaad2d560ddf9869fb3122c5",...}`;
`/health/agent` `ready`).

## 11. Conclusão

**READY WITH CONTROLLED ROLLOUT.**

1. `forget_memory` exige correspondência discriminante ✓
2. Palavras genéricas (estrutura/domínio + função) não autorizam exclusão ✓
3. Caso `Nubank × Banco do Brasil` protegido por regressão (RED provado na lógica antiga) ✓
4. Nenhuma memória incorreta apagável por cobertura lexical genérica ✓ (invariantes 1-5 do round 3)
5. CI verde (PR 17/17; main via required checks) ✓
6. Review sem P0/P1 (deploy APPROVED round 2; memória APPROVED round 3; tester PASS) ✓
7. Deploy Agent concluído ✓
8. `/health` ready ✓
9. `/health/agent` ready ✓
10. `buildSha` em produção == SHA mergeado (`98fe403`) ✓ — atestado pelo novo smoke com retry bounded
11. Documentação reflete o deploy real (correção auditável §13 do relatório pós-merge + este relatório) ✓
12. Flags default-off ✓

Gates pendentes (intocados, fora do escopo): Release B (2026-10-16T21:36:06Z),
cutover F3–F5, canary autoexecute (G08), provider de decisão (G07), G01/G02,
rollout A19 (binding R2, credenciais+ZDR, flags), future-dated 2026-12-01/2026-12-31.
