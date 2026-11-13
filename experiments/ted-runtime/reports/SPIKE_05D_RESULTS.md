# MEU TED — SPIKE 05D RESULTS
## Ponte durável Pending V2 em Postgres sintético + 1 turno live com recibo canônico

**Projeto:** `kust-projetos/meu-ted`
**Worktree:** `D:/projetos/pi-ted-runtime-spike`
**Branch:** `experiment/ted-opencode-runtime`
**Data:** 2026-10-31
**Veredito:** `SPIKE_05_PASS`
**HEAD:** `1567dae` (sem commit nesta tarefa)

> Sem push, PR, merge, deploy ou produção. Sem nova inferência nesta escrita. Nenhum banco real, PWA real, Cloudflare, `apps/`, `docs/`, `docker/` ou `.env` tocado. `05/05L` citados, nunca editados.

---

## 1. Missão e cadeia obrigatória

Missão: provar a cadeia completa durável — **LLM → propose → Pending persistente → confirmação sintética → execução → lançamento → recibo** — contra Postgres sintético exclusivo, encerrando o `NOT_PROVEN_CROSS_PROCESS` do 05L.

Elo idêntico provado: o mesmo identificador percorre todas as etapas, sem re-propose e sem invenção de id:

- `liveProposalId`: `08c3df44-86cd-4965-abd3-4cc2fd4c6ad0`
- `session`: `ses_e6ce4af3cffezrwL7mdDPuA06S`
- `intentionId`: `int-49462defac655ea6d688926fef795137`
- `idempotencyKey`: `ted-d826914b4ffdee52b1ac9843284066fb`
- `txId`: `34bd54f0-32de-481b-9dd7-997d79e3be88` (mutation `0e831573-bdb6-42a5-bc55-5a3e3a079c07`)

---

## 2. Preservação (§1 do spec)

- `05` e `05L` intactos: `reports/SPIKE_05_RESULTS.md`, `reports/SPIKE_05L_RESULTS.md`, `reports/SPIKE_05L_CHECKPOINT.md` citados, nunca editados.
- Snapshots timestamped imutáveis: live `SPIKE_05D_LIVE_live_2026-10-31T17-57-03-518Z.json`, confirm PASS `SPIKE_05D_LIVE_confirm_2026-10-31T18-01-05-079Z.json`, FAIL-closed `SPIKE_05D_LIVE_confirm_2026-10-31T18-00-49-462Z.json`, duráveis `spike-05d-durable-*.json`, negativos `spike-05d-negatives-*.json` — nada sobrescrito (colisão gera sufixo, nunca overwrite).
- Descoberta SDK documentada: `ctx.messageID` em geração é assistant-message (pré-imagem da chave como linkage obrigatório no confirm).

---

## 3. Caminho persistente (§2)

- Endpoints/tabelas/estados/chaves/execução/recibo **reais reaproveitados** de `SPIKE_05_RESULTS.md §4` (fonte `D:/projetos/pi-financeiro` somente leitura): propose 201/200/409, `GET /v2/active` + `GET /v2/:id/outcome`, confirm autenticada server-side, execução com attestation + TX1/TX2 + `withTedReceipt` fail-closed, recibo só em `succeeded`.
- Decisão Postgres: banco `ted_spike_05d` exclusivo em `127.0.0.1:5433` (sintético; `ted_local`/`pi_financeiro` intocados) — `spike-05d/scripts/db-05d.mjs` + `seed-05d.mjs` (households A/B + Itaú/Nubank/Bradesco-B + Mercado/Aluguel/Salário, `ON CONFLICT DO NOTHING`, migrations V001–V063 via `migrate-job.ts`, V038/V039 legacy-only ausentes — esperado).
- Sem 2ª máquina de estados: Pending V2 é a única autoridade. Sem memory-store como prova (R3 do 05 provou a ausência cross-process do one-shot).

---

## 4. Transporte (§3)

- `bootstrap/finance-bridge-pg.ts` (novo): cada invocação abre Pool + Fastify com `createPostgresReadModelStore` + `createPostgresWriteStore` + `createPostgresPendingOperationV2Store(pool)` + `createPendingOperationV2Executor(writes)` + tokenStore sintético + delegation secret sintético; mint host-side por op; fecha pool+app (persistência no Postgres). Recusa URL não-spike.
- `bootstrap/finance-transport-pg.mjs` (novo): `callFinanceDurable` com allowlist de 9 ops; confirm/execute exigem `body.intentionId` explícito (texto livre nunca confirma); default timeout 60s.
- Superfície LLM inalterada: `TOOL_DEFS` continua propose-only (sem confirm/execute) — LLM não confirma por construção.

---

## 5. Identidade da intenção (§4)

- `deriveIntentionId({sessionID, messageID})` estável por intenção (`int-[0-9a-f]{32}`), nunca `toolCallId`/`messageId` volátil.
- Chave `ted-<sha256(workspace,NUL,intentionId,NUL,tool)>` (`ted-[0-9a-f]{32}`); live: `ted-d826914b4ffdee52b1ac9843284066fb` igual à `idempotency_key` armazenada — vínculo por pré-imagem sha256, checagem obrigatória antes de qualquer efeito.
- Payload divergente na mesma chave → 409 (`idempotency.conflict`/`approval.intention_conflict`); duas despesas legítimas com ids distintos; sem CallID como identidade.

---

## 6. Validação determinística (§5 — 10 passos, 1 linha cada)

1. Propose → 201 `proposed` (`existing:false`, id UUID válido).
2. GET mesmo id → 200 `proposed` (novo processo por construção).
3. Restart GET → mesmo id, `proposed` (D03 durabilidade Postgres).
4. Confirm identidade autorizada + `intentionId` → `confirmed` + attestation (≥32 chars).
5. Execute via attestation → `succeeded`.
6. SQL direto: exatamente 1 tx (3500/Nubank/Mercado/ontem-dinâmico); recibo `operationId==proposalId`, `entity.id==txId`, `status succeeded`; `execution_status succeeded`.
7. Replay confirm pós-succeeded → 409 `approval.not_pending` (zero efeito).
8. Replay execute → 403/409 (zero efeito; contagem segue 1).
9. Outcome → `succeeded` + recibo idêntico (`operationId`/`entity.id`/`mutationId` estáveis).
10. Traces sanitizados por run (sem tokens) com marcadores `process.restart`.

---

## 7. Prova negativa (§6 — 13 casos + linkage-check, 1 linha cada)

1. Id desconhecido → 403 `approval.forbidden` (sem oráculo de existência, nunca 404).
2. Workspace estrangeiro lê nada → 403 `approval.forbidden`.
3. Ator não autorizado confirma → 403, 0 efeitos.
4. Proposta birth-expired → 409 `approval.expired`, 0 rows persistidas.
5. Expiry entre propose e confirm → 409 `approval.expired`, 0 efeitos.
6. Replay mesma chave+payload → 200 `existing:true` mesmo id; 1 efeito fim a fim.
7. 2 executes concorrentes → 1×200 + 1×409 (`execution_in_progress`/`attestation_replayed`), 1 efeito.
8. Mesma intenção + payload divergente → 409 (`idempotency.conflict`/`intention_conflict`), 0 efeitos.
9. Timeout pós-persistência → `tool.timeout` + GET reconcilia `succeeded`, 1 efeito, sem nova intenção.
10. Crash pós-propose pré-confirm → restart vê `proposed`, 0 efeitos.
11. Crash em `executing` (lease expirado forçado) → reconcile recupera `succeeded`, 1 efeito.
12. Recibo sobrevive a restart → outcome em novo processo retorna recibo idêntico.
13. LLM não confirma: hostless → `host_context_required`; `TOOL_DEFS` sem confirm/execute/authorize/reconcile/cancel; confirm sem `body.intentionId` → `tool.invalid_args`; 0 efeitos.
14. Linkage-check: "sim" textual não é op allowlisted (`isDurableOpAllowlisted('sim')==false`) → `tool.invalid_args`; nada executa.

---

## 8. Prova live (§7)

- **Modelo:** `opencode-go/deepseek-v4.1-flash` (pinado único, sem fallback/retry).
- **Mensagem exata (única, 1 prompt):** `"TED, gastei 35 reais no mercado ontem, pelo Nubank."`
- **Fixture:** `spike-05/fixtures/synthetic-case-35-mercado.json` (Nubank `…1112`, Mercado `…2221`, household `…000a`, `amountCents 3500`, `YESTERDAY_DYNAMIC_UTC` → `2026-10-30`).
- **Sequência live (12 passos, com IDs/valores):**
  1. Turno live `session ses_e6ce4af3cffezrwL7mdDPuA06S`, `sessionPromptCount 1/1`, `elapsedMs 24961`.
  2. Modelo listou contas+categorias e selecionou `propose_expense` (finance-only, sem ferramenta estrangeira).
  3. Args observados: `{3500, Nubank …1112, Mercado …2221, 2026-10-30, 'Mercado'}`.
  4. Proposta live `08c3df44-86cd-4965-abd3-4cc2fd4c6ad0` persistida no Postgres durável.
  5. Intenção `int-49462defac655ea6d688926fef795137` / chave `ted-d826914b…` (pré-imagem = mensagem assistant `msg_1931b64a5001…`, não a do usuário).
  6. Restart; linkage provado por chave (pré-imagem) antes de qualquer efeito.
  7. GET confirma `proposed`; SQL `before=0`.
  8. Confirm determinístico → `confirmed` + attestation (43 chars).
  9. Execute → `succeeded`; tx `34bd54f0-…` (mutation `0e831573-…`); contagem `0→1→1`.
  10. Replay recusado: confirm 409 `approval.not_pending`, execute 403 `approval.attestation_replayed`.
  11. Outcome `succeeded` com recibo idêntico (`operationId`=proposta, `entity.id`=lançamento).
  12. Custo: 1/1 prompt; SDK expôs `cost: 0` (teto US$5 desta campanha cumprido pela forma — 1 prompt / 90s / ≤4 passos / sem retry).
- **B01–B06/B08 pass; B07 fail por over-match de regex** (resposta grounded propose-only com confirmação adiada foi marcada como efeito; predicado corrigido pós-live com unit verde, snapshot intacto).
- **FAIL-closed preservado:** tentativa `confirm` anterior com bug do harness (checar corpo do GET em vez da linha durável) recusada com zero efeito (só GET + SQL) — snapshot `…18-00-49-462Z.json`.

---

## 9. Evidência ponta a ponta (§8 — 12 itens, valores literais)

1. `liveProposalId` = `08c3df44-86cd-4965-abd3-4cc2fd4c6ad0`.
2. `session` = `ses_e6ce4af3cffezrwL7mdDPuA06S` (`sessionPromptCount 1/1`).
3. `intentionId` = `int-49462defac655ea6d688926fef795137`.
4. `idempotencyKey` = `ted-d826914b4ffdee52b1ac9843284066fb` (= `idempotency_key` armazenada).
5. `txId` = `34bd54f0-32de-481b-9dd7-997d79e3be88`; receipt mutation = `0e831573-bdb6-42a5-bc55-5a3e3a079c07`.
6. Modelo `opencode-go/deepseek-v4.1-flash`; mensagem exata `"TED, gastei 35 reais no mercado ontem, pelo Nubank."`.
7. Args `{3500, Nubank …1112, Mercado …2221, 2026-10-30, 'Mercado'}`.
8. `elapsedMs 24961`; custo SDK exposto `0` (≠ prova de faturamento — custo SDK vs faturamento separados).
9. SQL: pending `execution_status succeeded`; 1 tx live (descrição `'Mercado'` cap-M; linha determinística `'mercado'` é outra row `391d22aa`); replay 403/409; `ted_local` 0 rows.
10. Testes: durable 1/1, negatives 1/1 (13 casos), url-guard 1/1, live-harness 11/11.
11. Revisores: P1 URL-guard endereçado, REV-03 APPROVED.
12. Sem credenciais em traces/relatório (só `keyLength`, sem valor).

---

## 10. Gates D01–D12 (todos PASS, evidência de 1 linha)

| Gate | Status | Evidência |
|---|---|---|
| D01 — Preservação 05/05L | PASS | 05/05L intactos (só citação); snapshots timestamped, nada sobrescrito — 3 fontes (DRAFT + nota live + traces). |
| D02 — Caminho persistente real | PASS | Endpoints/tabelas/estados/recibo reais reaproveitados; `ted_spike_05d` exclusivo. |
| D03 — Restart durável | PASS | GET pós-restart retorna mesmo id `proposed` (durable + live linkage). |
| D04 — Transporte host-bound | PASS | Bridge-pg + transport-pg allowlist 9 ops; confirm/execute exigem `body.intentionId`. |
| D05 — LLM propose-only | PASS | `TOOL_DEFS` sem confirm/execute; hostless → `host_context_required`. |
| D06 — Intenção/chave | PASS | `ted-d826914b…` = chave armazenada (pré-imagem); divergente → 409. |
| D07 — Validação 10 passos | PASS | Durable 1/1 verde (propose→…→outcome, 1 efeito, recibo estável). |
| D08 — Negativas 13+linkage | PASS | Negatives 1/1 (13 casos) + url-guard 1/1 + `sim` recusado. |
| D09 — Live 1 turno | PASS | Snapshot live `…17-57-03-518Z` (1 prompt, args corretos, B01–B06/B08 pass). |
| D10 — Confirm live + recibo | PASS | Snapshot confirm `…18-01-05-079Z` (0→1→1, replay 409/403, recibo idêntico). |
| D11 — Revisão independente | PASS | Testers + reviewers independentes; P1 URL-guard endereçado, REV-03 APPROVED. |
| D12 — Sem segredo/vazamento | PASS | Varredura de segredos (token dev, URL do banco, chave do provider, esquema de auth) = 0 hits neste relatório; traces sem tokens. |

---

## 11. Revisão e limitações

- **Testers/reviewers independentes:** durable/negatives/url-guard/live-harness verdes com DB; P1 URL-guard endereçado (`assertSpikeDatabaseUrl`); REV-03 APPROVED.
- **Residuais (não bloqueiam o PASS, bloqueiam produção):**
  - `cost 0` exposto ≠ faturado (controle real por contagem 1/1).
  - `status pending` vs `execution_status` (projeção UX vs estado persistido — nunca afirmar efeito sem recibo).
  - Pré-exec gate 2.2.4 (hook vê `{code}`, alvo resolve pós-execução; mitigação = denies + facade + abort + propose-only).
  - `authorize` 409 em shadow/off (superfície existe, elegibilidade é política de produto).
  - 4º dryrun não reivindicado como prova (só wiring sem custo).
  - B07-nota: predicado do snapshot corrigido pós-live; snapshot preservado intacto.

---

## 12. Veredito SPIKE_05_PASS (§10) + próxima decisão (§11)

**Veredito: `SPIKE_05_PASS`.** A cadeia LLM→propose→Pending persistente→confirmação sintética→execução→lançamento→recibo está provada de forma durável (Postgres) e live (1 turno real + confirmação determinística da proposta live com recibo canônico + replay recusado), com testers/reviewers independentes e sem tocar produção.

**Próxima decisão (§11): encerrar a viabilidade.** Próximo trabalho — **NÃO iniciado nesta tarefa** — é a síntese A0/A1/B (arquitetura efetiva, contratos Pending V2, bridge/host-bound) como base de handoff. **NÃO iniciar SPIKE 06.**

---

## 13. Arquivos (novos nesta campanha; nenhum fora do escopo tocado)

- `experiments/ted-runtime/bootstrap/finance-bridge-pg.ts` (ponte durável)
- `experiments/ted-runtime/bootstrap/finance-transport-pg.mjs` (transporte allowlisted)
- `experiments/ted-runtime/bootstrap/run-05d-live.mjs` (runner live) + `run-05d-live.test.mjs` (11/11)
- `experiments/ted-runtime/spike-05d/scripts/db-05d.mjs` + `seed-05d.mjs`
- `experiments/ted-runtime/spike-05d/tests/spike-05d-durable.test.mjs` (1/1) + `spike-05d-negatives.test.mjs` (1/1, 13 casos) + `spike-05d-url-guard.test.mjs` (1/1)
- `experiments/ted-runtime/spike-05d/traces/SPIKE_05D_LIVE_live_2026-10-31T17-57-03-518Z.json` + `SPIKE_05D_LIVE_confirm_2026-10-31T18-01-05-079Z.json` (PASS) + `SPIKE_05D_LIVE_confirm_2026-10-31T18-00-49-462Z.json` (FAIL-closed) + dryruns + `spike-05d-durable-*.json` + `spike-05d-negatives-*.json`
- `experiments/ted-runtime/spike-05d/reports/SPIKE_05D_DRAFT.md` + `SPIKE_05D_LIVE_TRACE_NOTES.md`
- Este relatório: `experiments/ted-runtime/reports/SPIKE_05D_RESULTS.md`
