# Comparação arquitetural A0 × A1 × B
**Data:** 2026-10-31 · **Fontes:** `OPENCODE_FEASIBILITY_FINAL.md`, relatórios 01–05D, `D:/projetos/pi-financeiro` somente leitura. Sem métricas inventadas; não medido = `NOT_MEASURED`.

## A0 — Harness atual (em produção)
Componentes efetivamente utilizados (paths `apps/agent/src/`):
- **Interpretação/roteamento:** `orchestration/intent-router.ts`, `orchestration/turn-plan.ts` + `turn-budget.ts`, `orchestration/conversation-orchestrator.ts`, `orchestration/financial-claim-guard.ts`, `poc-structured/structured-interpretation.ts` + `registry.ts`, `mutations/semantic-interpretation.ts`, `agent-config/instructions.ts` + `playbook.ts`.
- **Sessões/contexto:** `finance-chat-agent.ts` (DO `FinanceChatAgent`), `worker.ts`, `privacy/history.ts` + `conversation-visibility.ts` + `turn-audience-bindings.ts`, `transcript-safety.ts`.
- **Ferramentas:** `generated/http-tools.ts`, `tools/api-client.ts` + `api-tool-helpers.ts`, `tools/tool-policy.ts`, `tools/intention-ledger.ts`, `tools/duplicate-detector.ts`, `decision/contract.ts` + `transport.ts` + `wiring.ts` + `provider.ts`, `orchestration/pending-operation-coordinator.ts`, `orchestration/account-grounding.ts`, `mutations/mutation-proposal.ts` + `undo-proposal.ts`.
- **Integração financeira:** API autoritativa `apps/api` (Pending V2, attestation TX1/TX2, `withTedReceipt`, idempotência, `authenticatedContext`, `approvalPolicy`); PWA `apps/pwa` (aprovação 2-passos, receipt obrigatório).
- **Erros:** `deterministic-responses.ts`, `grounded-response.ts`, `tool-call-sanitizer.ts`, `approval.execution_uncertain`, `reconcileExpiredExecuting`, `shadow/shadow-runner.ts`.
- **Observabilidade:** `observability/` (events/metrics), `evidence/` (envelope/collector/grounding-validator/formatters), `poc-minimal/poc-telemetry.ts`, `decision/provider.ts` + `judgment/provider.ts`.
- **Persistência/autorização:** DO SQLite + Postgres canônico `pi_financeiro_canonical`, Better-Auth + device-bound + `delegated-token.ts` + `connection-token.ts` + `workspace-alias.ts`, `auth/` + `privacy/dlp.ts` + `dlp/redaction.ts`, `safety/` (auto-execution, usage-policy, tool-approvals), `attachments/` (upload-gate, capability-state).
- **Essencial de negócio (manter em qualquer desenho):** contratos Pending V2, auth server-side, attestation/recibo/idempotência, isolamento workspace, auditoria/observabilidade, multimodal gates.
- **Orquestração própria (candidata a simplificar):** intent-router, conversation-orchestrator, turn-plan/budget, pending-operation-coordinator, seleção manual de tools, parsing financeiro ad-hoc, gerência própria de sessão onde o runtime já persiste.

## A1 — Cloudflare simplificado (proposta, NÃO executada)
Menor fatia para avaliação equivalente (sem métricas — nada medido):
- Worker/DO único com **loop nativo de tools** (sem `intent-router`, sem `conversation-orchestrator`, sem `turn-plan` próprios): LLM → `propose_*` (Pending V2 real) → apresentação server-side → confirm explícito → execute com attestation → recibo.
- Reutilizar intactos: Pending V2, auth, recibo, isolamento, observabilidade mínima.
- Testes mínimos equivalentes: 1 caso 35-mercado + replay 409 + confirm sem intention → recusa + restart GET `proposed` + recibo SQL 1 tx + J06 A/B + J07-B.
- **NÃO atribuir desempenho:** latência/custo/qualidade A1 = `NOT_MEASURED` até executar campanha paga equivalente (1 modelo pinado, 1 prompt, teto por contagem).

## B — OpenCode TED (comprovado nos spikes)
- **Bootstrap:** `bootstrap/ted-config.cjs` + `session-bindings.mjs` + `run-*.mjs` (isolamento `OPENCODE_TEST_HOME/XDG_*` + `TED_HOME_ROOT`, per-identidade OS processes).
- **Facade:** `ted-gateway.mjs` (7–8 chaves frozen, sem shell/prompt/edit/subagent/mcp-connect; tokens via stdin filho).
- **Plugin financeiro:** `plugins/ted-finance/index.mjs` + `ted-finance-tools.mjs` (`propose_expense` + `list_accounts`/`list_categories`/`get_month_summary`, `additionalProperties:false`, `FORBIDDEN_KEYS`, `validateToolArgs`, `deriveIntentionId`).
- **Host-bound:** workspace/actor/device/token/intention injetados pelo host; `ctx.id` só correlação; sem host → `host_context_required`.
- **Bridge:** `finance-transport[.pg].mjs` (allowlist exata, gates body/key) + `finance-bridge[.pg].ts` (Pool+Fastify por invocação 05D, Pending V2 Postgres real, fecha pool+app).
- **Sessões/persistência:** `database.path` por identidade (sqlite) + Postgres `ted_spike_05d` durável (propose→restart→confirm→execute→recibo; lease 60s + reconcile).
- **Testes:** §0 do feasibility (67/67 base + 19/19 + 34/34 + 6/6 + 05D 10 passos §6 + 13 negativos + B01–B08).
- **Dependências:** `@opencode/sdk@2.2.4` pinado (+ cli/client/plugin), `opencode-go/deepseek-v4.1-flash` (live), `tsx` repo, PG `127.0.0.1:5433`; zero MCP/servidor extra; provider `opencode-go` + 30 modelos no catálogo live.
- **Operação por processo/usuário:** 1 processo por identidade (cwd+home+DB separados), mint host-side por op, tokenStore sintético, artifact por run (nunca overwrite).
- **Só-experimento (não levar a prod como está):** homes `.ted-home-*`, bridges one-shot, `confirm-cli` double, oráculos/harness/extractors, traces, seeds sintéticas, `SYNTHETIC_TOKENS`, polling/step-budget best-effort.
- **Levar a prod (se adotado):** facade propose-only, plugin genérico, host-bound + intenção, transport allowlist, Pending V2 como única autoridade, confirm explícito (nunca "sim" textual), recibo-só-`succeeded`, replay/conflict fail-closed, isolamento por identidade.

## Matriz comparativa (mesmos critérios)
`PROVEN/PARTIAL/NOT_PROVEN/BLOCKED` = evidência; `NOT_MEASURED` = não medido. Sem pontuação inventada, sem superioridade estimada.

| Critério | A0 (atual prod) | A1 (simplificado) | B (OpenCode spike) |
|---|---|---|---|
| Interpretação financeira | PROVEN em prod (E2E live-mobile PASS, V1-textual CLOSED) | NOT_MEASURED (não executado) | PROVEN sintético (03B T4, 04 13 turns, 05L propose live); PARTIAL conversacional (J07-B) |
| Seleção correta de tools | PROVEN (registry + policy + coordinators) | NOT_MEASURED | PROVEN (finance-only, B02; sem estrangeira nos turns live) |
| Continuidade conversacional | PROVEN (DO + history + visibility) | NOT_MEASURED | PARTIAL (sqlite restart + PG durável PROVEN; com-modelo pós-restart BLOCKED `provider.no-route`) |
| Ambiguidade | PROVEN (guards + clarificação prod) | NOT_MEASURED | PARTIAL/BLOCKED (J07-B assume 2026-05 sem clarificar) |
| Precisão de valores | PROVEN (âncora+deltas, ADR-018) | NOT_MEASURED | PROVEN (oráculos exatos: 288050/911950/3500, B04) |
| Proposta/confirmação | PROVEN (Pending V2 + 2-passos + receipt) | NOT_MEASURED (reutilizar mesmos contratos) | PROVEN (201/200/409, confirm explícito, "sim" recusado exit 2, recibo só `succeeded`) |
| Isolamento usuários | PROVEN (workspace server-side, Test Family) | NOT_MEASURED | PROVEN estrutural + conteúdo live 04L/J06L (A/B disjuntos, cross 403); live 04 com conteúdo untested (não se afirma) |
| Idempotência/recibos | PROVEN (chave + hash + attestation + reconcile) | NOT_MEASURED | PROVEN (replay 200 mesmo id, divergente 409, concorrente 1 efeito, crash reconcile `succeeded`) |
| Tempo de resposta | PROVEN prod fora deste escopo (E2E live-mobile 1.2min + live-ted-conversation 1.5min — fonte `D:/projetos/pi-financeiro` sessões 2026-10-19/2026-10-14; neste spike: NOT_MEASURED) | NOT_MEASURED | PARTIAL (16.3s/23.2s/24.9s por turno sintético; prod NOT_MEASURED) |
| Tokens | PROVEN (telemetria prod) | NOT_MEASURED | PARTIAL (8200/256/135; 5307/304/108; 04 sem contadores — null) |
| Custo real/estimado | Real prod conhecido operacionalmente; estimado futuro NOT_MEASURED | NOT_MEASURED | Exposto 0 (não é faturamento); billed NOT_MEASURED |
| Manutenção | Alto (roteador+coordenadores próprios) — fato estrutural, não nota | Esperado menor (loop nativo), NOT_MEASURED | Menor superfície (facade+plugin), mas bridges/harness são dívida de experimento |
| Esforço implantação | Nenhum (já em prod) | Médio (novo Worker/DO + reuso API) NOT_MEASURED | Alto se prod (auth prod, rede/banco, quotas, discovery, observabilidade) |
| Recuperação falha | PROVEN (`execution_uncertain`, reconcile, rollback tags) | NOT_MEASURED | PROVEN sintético (timeout reconcilia, crash `executing` recupera, recibo sobrevive restart) |
| Observabilidade/debug | PROVEN (events/metrics/evidence/attest) | NOT_MEASURED | PARTIAL (traces sanitizados + B-oráculos; sem prod telemetry) |
| Adicionar funcionalidade | PROVEN (playbooks/skills/POC) | NOT_MEASURED | PARTIAL (plugin genérico `for def of TOOL_DEFS`; sem prova de nova tool mutante) |

Nota: aprovação sintética ≠ certificação produção em nenhuma coluna.
