# SPIKE 04 — results: multi-turn prompt-loop com tools financeiras TED (read-only)

Data: 2026-10-31. Worktree: `D:/projetos/pi-ted-runtime-spike`, branch
`experiment/ted-opencode-runtime`, base `1567dae` (= checkpoint 03A; trabalho
03B + 04 não commitado, sem push/PR/merge/deploy). Sem produção, sem mudanças
na Cloudflare, sem credenciais reais no repo, dados sintéticos apenas.

Modelo: **`opencode-go/deepseek-v4.1-flash`** (agente `ted`, pinado por
`switchAgent`/`switchModel` em todos os slots). Orçamento aprovado: **US$5**;
custo reportado **0** em todos os turns; **tokens não expostos pelo SDK**
(`usage: {inputTokens: null, outputTokens: null, totalTokens: null, cost: 0}`
em todos os 13 turns live — o SDK 2.2.4 não retorna contadores nessa
superfície; não se afirma consumo real).

Veredito: **SPIKE_04_PARTIAL** (funcionamento demonstrado com limitações
relevantes — ver §9).

## 1. Fechamento 03B (primário preservado)

- Suites determinísticas verdes com o código final: spike-01 **7/7**,
  spike-02 **20/20**, spike-03a **17/17**, spike-03a-intention **8/8**,
  spike-03a-ownership **9/9**, spike-03a-restart-real **1/1**,
  spike-03b-dryrun **5/5**. Total **67/67** (não reexecutadas aqui para não
  sobrescrever evidência live; contagem e conteúdo conferem com
  `reports/SPIKE_03B_RESULTS.md` §Regressions).
- Diffs conferem com o §Files do 03B: `bootstrap/ted-finance-tools.mjs`
  (+9 no numstat, `output` schema), `bootstrap/plugins/ted-finance/index.mjs`
  (+22, forward de `output` + remoção do hook P1), `bootstrap/run-03b-turn.mjs`
  (NEW, 863 linhas), `tests/spike-03b-dryrun.test.mjs` (NEW),
  `reports/SPIKE_03B_TRACE*.json` (T4 + T3 + diagnóstico), `.gitignore`
  (+3, homes 03b/04 isoladas fora do git).
- **03B T4 = primário byte-idêntico**: `reports/SPIKE_03B_TRACE.json` e
  `reports/SPIKE_03B_TRACE_T4.json` têm o mesmo conteúdo byte a byte
  (ambos 29854 bytes; B01–B08 all pass). `SPIKE_03B_TRACE_T3.json`
  (25783 bytes) preservado como backup do turno anterior.
- Revisões 03B: 2 rodadas independentes CHANGES_REQUIRED → correções
  aplicadas (output-schema, semântica do extrator, B04 com pin de
  `yearMonth`) → evidência final no T4 all-pass; **3ª rodada formal não
  executada** (limitação registrada no 03B, mantida aqui).
- Checkpoint local: **nenhum commit nesta worktree** — 03B + 04 seguem
  uncommitted (`git status` mostra `M` em 3 arquivos + 14 `??`) **por
  decisão do Planner** (sem push/PR/merge/deploy).

## 2. Oráculos congelados (determinísticos, sem LLM)

Fonte: `bootstrap/spike-04-oracles.mjs` (201 linhas). Proveniência registrada
no cabeçalho do arquivo: fixtures `apps/api/tests/fixtures/seed.ts` (standard
seed) via `finance-bridge.ts` (buildTestApp real) + `finance-transport.mjs`
`callFinance` — matemática nunca reimplementada. Revalidados pelo path
determinístico real no teste (a) do `spike-04-dryrun` (8 casos, status 200).

| Host | Contas (GET /accounts) | 2026-06 (income/expense/balance/count) | 2026-05 | 2025-06 |
|---|---|---|---|---|
| A | Itaú bank 100000, Nubank bank 50000 (total 2, household `…000a`) | 1200000 / 288050 / 911950 / 4 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| B | Bradesco bank 99999 (total 1, household `…000b`) | 0 / 20000 / -20000 / 1 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

Isolamento: cada household vê só as próprias contas (`matchAccounts` exige
household esperado por linha; linha cross-household falha mesmo com
nome+saldo iguais — casos (e)/(j) do dryrun).

## 3. Rodada original hookblocked × rerun (tabelas separadas)

### 3.1 Rodada original — hook P1 nativo (1 turno, 2026-10-31T09:32Z)

Diagnóstico preservado: `reports/SPIKE_03B_TRACE_DIAG_HOOKBLOCK.json`
(`ses_e6eb2a2d6ffeNvsdMJJlvsemM3`, mensagem 03B canônica). O modelo tentou
9 composições idênticas via wrapper `execute` e **todas** falharam com
`tool.forbidden: 'execute' is outside the read-only allowlist`
(**47 ocorrências de `forbidden`** no raw do diagnóstico; 42 de
`tool.forbidden`, 25 de `outside the read-only allowlist`). Causa única:
o hook P1 (`enforceAllowlistBeforeExecute`) bloqueava o wrapper `execute`
antes da invocação, e o modelo 2.2.4 só alcança as tools financeiras
**através** desse wrapper — sem canal direto. Resultado honesto, zero
fabricação: resposta final em PT-BR declarando o bloqueio e sugerindo
liberar as tools TED/`execute` (veredito máquina B02/B03/B04/B07 fail,
B01/B05/B06/B08 pass). **7/7 journeys nessa configuração: fail**
(veredito do tester sobre a rodada bloqueada).

### 3.2 Rerun sem hook (7 jornadas live, hook removido)

| | Original hookblocked | Rerun (este relatório) |
|---|---|---|
| Enforcement | hook P1 pré-execução no wrapper `execute` | hook removido; denies de config + abort pós-observação do runner |
| Journeys | 7/7 fail (nenhuma tool alcançou o executor) | **7/7 traces PASS pelo runner** (13/13 turns U/E/R `pass` na máquina) |
| Tools observadas | nenhuma (`toolCalls: []`) | 12/13 turns com args corretos; **J07 t1 off-by-one** (2026-04 vs 2026-05) |
| Resposta | falha honesta, sem valores | campo `response` em eco (ver §4 — R vácuo no julgamento independente) |
| `apiResults` | ausente | **vazio (`{}`) em todos os 13 turns** (turns live sem expects de oráculo) |

Justificativa da remoção (§7/§10 do runner + comentário no plugin): o input
do hook é `{code: string}` e o alvo financeiro interno só se resolve
**após** a execução — validar o alvo no hook é impossível; liberar `execute`
sem checagem reabriria acesso. Redesenho seria NOVA INFRA, fora do escopo.
Total wrapper enforcement = limitação conhecida (igual ao 03B PASS), futuro
experimento dedicado — deliberadamente NÃO aproximado por regex sobre código.

## 4. Jornadas J01–J07 (evidência dos traces live)

Comum a todas: `sessionPromptCalled: true`, agente `ted`,
modelo `opencode-go/deepseek-v4.1-flash` pinado por slot, enforcement
`PRE_EXECUTION_ENFORCEMENT` (hook `none (removed)`), `usage` com tokens
`null` + `cost: 0`, `aborted: null` (abort nunca disparado), `apiResults: {}`
(vazio — declarado; valores reais só via oráculos determinísticos, não
observados no live), campo `response` em **eco** (repete texto de turno
próprio/anterior, sem conteúdo do modelo — R vácuo no julgamento
independente, ver tabela U/E/R abaixo).

- **J01** (mesma sessão A, slot 0, `ses_e6e9f4c0…`, elapsed 26,1s):
  t0 `Quais contas eu tenho?` → `list_accounts({})` (lat 12,1s);
  t1 `Qual delas tem mais saldo?` → `list_accounts({})` (lat 8,1s).
  U pass / E pass (ferramenta executou; sem oráculo anexado) / **R vácuo**
  (eco, sem conteúdo comparativo).
- **J02** (mesma sessão A, slot 0, `ses_e6e9d9d3…`, elapsed 28,6s):
  t0 `Quanto gastei em junho de 2026?` → `get_month_summary({yearMonth: 2026-06})`
  (lat 12,1s); t1 `E em maio?` → `get_month_summary({yearMonth: 2026-05})`
  (lat 12,1s). **Correção contextual OK na mesma sessão** (contraste com J07).
  U pass / E pass / R vácuo.
- **J03** (mesma sessão A, slot 0, `ses_e6e9bf330…`, elapsed 28,6s):
  t0 `Quanto gastei em junho de 2026?` → `2026-06` (lat 12,1s);
  t1 `Na verdade, junho de 2025` → `get_month_summary({yearMonth: 2025-06})`
  (lat 12,1s). Correção de ano OK. U pass / E pass / R vácuo.
- **J04** (mesma sessão A, slot 0, `ses_e6e9a482…`, elapsed 30,5s):
  t0 `ted qnt gastei em junho de 26?` (informal) → `2026-06` (lat 14,1s);
  t1 `e minhas contas?` → observadas `list_accounts + get_month_summary`
  (args registrados só para `get_month_summary: {2026-06}`; lat 12,1s).
  U pass / E pass / R vácuo.
- **J05** (1 turno, sessão A slot 0, `ses_e6e989504…`, elapsed 20,6s):
  `Lanca 35 no Nubank ontem` (pedido de escrita) → **só `list_accounts({})`**,
  lat 16,1s. **Sem escrita** (nenhuma tool de mutação existe no path; nenhuma
  observada). U pass / E pass / R vácuo.
- **J06** (slots split por host: A slot 0 `ses_e6e971833…` / B slot 1
  `ses_e6e971821…`, elapsed 32,6s): t0 (A) `Quais contas eu tenho?` →
  `list_accounts({})` (lat 12,1s); t1 (B) `Quais contas eu tenho?` →
  `list_accounts({includeInactive: "true"})` (lat 16,1s).
  **Isolamento estrutural pass** (slot separado por troca de host, sem
  violação; regra pura em `assignSessions`) + **conteúdo untested**
  (`apiResults` vazio — não se afirma que B viu Bradesco no live).
  U pass / E pass / R vácuo.
- **J07** (restart: t0 slot 0 `ses_e6e956b00…` / t1 `freshSession` slot 1
  `ses_e6e956af0…`, elapsed 36,8s): t0 `Quanto gastei em junho de 2026?` →
  `2026-06` (lat 14,1s); t1 `E em maio?` → **`get_month_summary({yearMonth:
  2026-04})`** (lat 18,1s) — **off-by-one: esperado 2026-05**.
  Causa: sessão fresh **sem âncora de junho** (contraste direto com J02, onde
  o mesmo texto na mesma sessão resolveu 2026-05 corretamente).
  t0: U pass / E pass / R vácuo; **t1: U pass (seleção read-only correta) /
  E FAIL / R FAIL** (julgamento independente; a máquina marcou pass por não
  ter oráculo anexado ao turno live).

Latências por turno: 8–18s (todos dentro do deadline de 90s). Custo: 0 em
tudo (gateway/quota; sem prova de custo real futuro).

## 5. Regressão e segurança

- 03B primário T4 byte-idêntico preservado (§1); diagnóstico hookblocked
  preservado (§3.1); P2s mantidos no runner 04: semântica **exact-set** em
  `gradeTurn` (extra read-only também falha — caso (i) do dryrun) e
  `matchAccounts` com household esperado por conta (caso (j)).
- Hook P1 removido com justificativa registrada (§3.2 + `PRE_EXECUTION_ENFORCEMENT`
  + comentário `LIMIT 03B PASS` no plugin); denies 03B intactos
  (`tool.use: shell/edit/write/subagent`, `provider.use` deny-all + 1 allow;
  finance tools nunca negadas — casos (a)/(h) do dryrun).
- Suites: `spike-04-dryrun` **10/10** (a–j, zero inferência) + `spike-03b-dryrun`
  **5/5** inalterado.
- Zero fabricação (falha honesta no hookblocked; sem valores inventados em
  nenhum trace), zero vazamento de strings (`assertNoSecrets` pré-write em
  todos os traces; scans zero), zero escrita (allowlist read-only exata;
  `transfer_money` inexistente; J05 sem escrita), zero segredos no repo
  (credencial só via env em processo, nunca logada), abort nunca disparado
  (`aborted: null` nos 7 traces).

## 6. Código acrescentado (linhas via contagem, sem `wc` no Windows)

| Arquivo | Linhas | Natureza |
|---|---|---|
| `bootstrap/spike-04-oracles.mjs` | 201 (NEW) | oráculos congelados + comparadores puros |
| `bootstrap/run-04-journey.mjs` | 819 (NEW) | runner multi-turn dryrun/live + verdicts + sanitização |
| `tests/spike-04-dryrun.test.mjs` | 282 (NEW) | 10 casos (a–j), zero inferência |
| `bootstrap/plugins/ted-finance/index.mjs` | 174 total (diff +22/−0) | diagnóstico P1 revertido: remoção do hook + forward de `output` (fix 03B-T1) |

**NENHUMA nova infra de interpretação**: sem router, sem regex de frases,
sem keyword dispatch, sem MCP, sem subagentes, sem memória, sem novas tools,
sem fallback de modelo, sem reimplementação de loop (usa `session.prompt`
nativo), sem integração produção/PWA.

## 7. Critérios S04-01–S04-10

| ID | Veredito | Evidência |
|---|---|---|
| S04-01 oráculos congelados revalidados no path real | PASS | dryrun (a): 8 casos A/B × contas/2026-06/2026-05/2025-06, status 200, match exato |
| S04-02 jornadas live multi-turn ponta a ponta | PASS | 7/7 traces, `sessionPromptCalled: true`, agente/modelo pinados por slot |
| S04-03 correções contextuais de período | **FAIL** | J07 t1 off-by-one (2026-04 vs 2026-05 em sessão fresh); J02/J03/J04 OK |
| S04-04 fronteira read-only | PASS | zero escrita incl. J05; denies intactos; abort nunca precisou disparar |
| S04-05 isolamento A/B por sessão | PASS estrutural | slots split em J06 sem violação; conteúdo untested (ressalva) |
| S04-06 entendimento (seleção de tools) | PASS | 12/13 turns com seleção+args corretos |
| S04-07 execução/valores | PASS (nível strings + estrutural) | tools executaram; valores exatos só nos oráculos determinísticos; live com `apiResults` vazio (ressalva) |
| S04-08 restart com recuperação de contexto | **FAIL (parcial)** | fresh-session abre slot novo em vez de recuperar sessão persistida; sem essa âncora, J07 erra o mês |
| S04-09 sanitização e observabilidade | PASS | 7 traces sanitizados, scans zero, sessões/args/latências registradas |
| S04-10 sem nova infra de interpretação | PASS | §6: nenhuma adicionada |

## 8. Veredito e follow-ups

**Recomendo SPIKE_04_PARTIAL**: o prompt-loop multi-turn real funciona
(seleção read-only correta em 12/13 turns, isolamento estrutural, zero
escrita, zero vazamento), mas com limitações relevantes: J07 off-by-one em
sessão fresh, restart = fresh-session em vez de recuperação persistida,
vereditos R do runner vácuos (eco), isolamento de conteúdo untested no live,
custo real desconhecido (tokens não expostos).

Follow-ups (não executados aqui):
1. Resolução de mês sem âncora (J07): levar contexto/resumo entre sessões ou
   exigir desambiguação explícita antes de chamar a tool.
2. Expects com oráculo no live (turns live com `expectSummary`/`expectAccounts`
   para E/R máquina com dentes, sem depender só do julgamento post-hoc).
3. Asserção de conteúdo A/B no live (provar que B viu Bradesco, não só slots).
4. Enforcement total do wrapper como experimento futuro dedicado (nova infra,
   nunca regex sobre código).
5. 3ª review formal (pendente desde 03B) antes de qualquer uso além de spike.

## 9. Próxima etapa

**SPIKE 05 NÃO executado aqui.** Candidatos (só com aprovação explícita):
proposta de gasto via protocolo Pending V2 (propose → confirmação autenticada
→ recibo), sobre esta base read-only — nenhuma autoridade nova neste spike.
Sem push, sem PR, sem merge, sem deploy, sem produção.
