# Triagem da auditoria do Agent — backlog pós-V1 (2026-10-19)

**Contexto:** auditoria do Agent concluída em 2026-10-19 com V1-textual CLOSED (piloto fechado em `0405fba`; ver `docs/reports/2026-10-19-pilot-closure.md`). Nenhum item abaixo muda contrato V1: todos os 24 itens foram registrados como issues `post-v1`/`enhancement`, sem alteração de código de produção nesta sessão.
**Escopo deste documento:** registrar o backlog (BACKLOG/REMOVE/KEEP). Os itens FIX-NOW estão em execução em 2 tracks paralelas, fora do escopo deste registro — os donos das tracks vinculam as issues/correções nos próprios relatórios.

## 1. AGENT-CORE

| # | Issue | Severidade | Disposição | Evidência |
|---|---|---|---|---|
| 1 | [#229](https://github.com/kust-projetos/meu-ted/issues/229) Sanitizer cobre markup mid-message | P1 | BACKLOG | `apps/agent/src/responses/tool-call-sanitizer.ts:16-35` — só remove ancorado em borda |
| 2 | [#230](https://github.com/kust-projetos/meu-ted/issues/230) Truncamento silencioso MAX_EVIDENCE_READS | P1 | BACKLOG | `apps/agent/src/orchestration/channel-evidence.ts:107,189-200` — trunca reads multi-domínio sem sinalizar |
| 3 | [#231](https://github.com/kust-projetos/meu-ted/issues/231) Idempotência de reads por intentionId + teto único | P1 | BACKLOG | `apps/agent/src/finance-chat-agent.ts:1580-1600`, `apps/agent/src/orchestration/turn-budget.ts:121-157` — re-executa reads por perna sem contar no budget |
| 4 | [#232](https://github.com/kust-projetos/meu-ted/issues/232) Persistência atômica do par Q/A | P1 | BACKLOG | `apps/agent/src/finance-chat-agent.ts:1556-1568,4147-4175` — dois persists não-atômicos (Q sem A / A sem Q) |
| 5 | [#233](https://github.com/kust-projetos/meu-ted/issues/233) Unificar malformed_response nos dialetos decision | P2 | BACKLOG | `apps/agent/src/decision/wiring.ts:13-25` — dialeto jev classifica `low_confidence` sem abrir breaker |
| 6 | [#234](https://github.com/kust-projetos/meu-ted/issues/234) Remover dep pdf-text morta | P2 | REMOVE | `apps/agent/src/multimodal/pdf-text.ts:47-59` — parser unpdf (~2,4 MB) com override undefined. Precondição: decisão explícita de não reabilitar PDF textual |
| 7 | [#235](https://github.com/kust-projetos/meu-ted/issues/235) Teto de duração STT p/ formatos não-WAV | P2 | KEEP por agora | `apps/agent/src/multimodal/groq-stt.ts` — ogg/webm/mp3 só com teto 10 MB (~10 min). Reavaliar antes de coorte `*` |

## 2. TOOLS/SKILLS

| # | Issue | Severidade | Disposição | Evidência |
|---|---|---|---|---|
| 8 | [#236](https://github.com/kust-projetos/meu-ted/issues/236) Desempate registos × relatórios p/ agregação | P1 | BACKLOG | `apps/agent/src/agent-config/skills/registros.ts:8-9` vs `skills/relatorios.ts:9`, `agent-config/select-skill.ts:88-94` — "quanto gastei esse mês?" roteia p/ list em vez de agregação |
| 9 | [#237](https://github.com/kust-projetos/meu-ted/issues/237) Teste de contrato catálogo × registry | P1 | BACKLOG | `apps/agent/src/agent-config/tools.ts:441-442` — omite silencioso em divergência de nome |
| 10 | [#238](https://github.com/kust-projetos/meu-ted/issues/238) Alinhar TED_MUTATION_POLICY ao MutationExecutor V2 | P1 | BACKLOG | `apps/agent/src/agent-config/tools.ts:446-451` vs `agent-config/instructions.ts:72-77` — promete auto-conclusão que o código nunca entrega |
| 11 | [#239](https://github.com/kust-projetos/meu-ted/issues/239) Fonte única mutação × leitura | P2 | BACKLOG | `apps/agent/src/safety/tool-approvals.ts` vs prefixos em `agent-config/tools.ts:447-448` — divergem (`create_card_*`, `pay_statement`, etc.) |
| 12 | [#240](https://github.com/kust-projetos/meu-ted/issues/240) Precedência dos 3 gates de intent | P2 | BACKLOG | `apps/agent/src/agent-config/tools.ts:227-230` vs `safety/tool-approvals.ts:30-43` vs `safety/auto-execution.ts:27-38` |
| 13 | [#241](https://github.com/kust-projetos/meu-ted/issues/241) Alinhar skill relatorios ao envelope analytics | P2 | BACKLOG | `apps/agent/src/agent-config/skills/relatorios.ts:24` — "SEMPRE custom" vs pass-through com preset |
| 14 | [#242](https://github.com/kust-projetos/meu-ted/issues/242) Remover keywords genéricas de skills | P2 | REMOVE | `apps/agent/src/agent-config/skills/saldo-extrato.ts:7-11`, `skills/registros.ts:10` — sequestram turnos |

## 3. BACKEND

| # | Issue | Severidade | Disposição | Evidência |
|---|---|---|---|---|
| 15 | [#243](https://github.com/kust-projetos/meu-ted/issues/243) Separar 504 timeout de 502 provider no relay | P2 | BACKLOG | `apps/api/src/routes/internal-agent-llm-relay.ts:540-545` — catch-all vira 504 |
| 16 | [#244](https://github.com/kust-projetos/meu-ted/issues/244) Ator na chave string de idempotência | P2 | BACKLOG | `apps/api/src/writes/idempotency.ts:253-271` — forma string ignora ator |
| 17 | [#245](https://github.com/kust-projetos/meu-ted/issues/245) Purge admin de resíduos Test Family | P2 | BACKLOG | `apps/api/src/transactions/duplicate-detector.ts:29-47` — só alerta |
| 18 | [#246](https://github.com/kust-projetos/meu-ted/issues/246) Remover stores legacy pós-cutover | P2 | REMOVE pós-F5 | `apps/api/src/{goals,cards,payables,subscriptions,writes,budgets}/legacy-postgres.ts` — remover sem referência a `DB_SCHEMA=legacy` |
| 19 | [#247](https://github.com/kust-projetos/meu-ted/issues/247) Logar allowlist efetiva do relay no boot | P2 | BACKLOG | `apps/api/src/routes/internal-agent-llm-relay.ts:37-50,166,324` — override sem validação |

## 4. PWA

| # | Issue | Severidade | Disposição | Evidência |
|---|---|---|---|---|
| 20 | [#248](https://github.com/kust-projetos/meu-ted/issues/248) Turno assistente de erro no histórico | P2 | BACKLOG | `apps/pwa/src/features/ted/TedChat.tsx:1102-1106`, `features/ted/TedMessage.tsx:120-133` — falha só marca bolha própria |
| 21 | [#249](https://github.com/kust-projetos/meu-ted/issues/249) Retry sem beco sem saída | P2 | BACKLOG | `apps/pwa/src/features/ted/TedChat.tsx:1179-1198` — retorna null silencioso |
| 22 | [#250](https://github.com/kust-projetos/meu-ted/issues/250) Reusar token cacheado do agente | P2 | BACKLOG | `apps/pwa/src/lib/api/agent-client.ts:781-798` — sempre forceFresh |
| 23 | [#251](https://github.com/kust-projetos/meu-ted/issues/251) Gate NODE_ENV no baseUrl override | P2 | BACKLOG | `apps/pwa/src/lib/api/agent-client.ts:74-83` — desvia do proxy same-origin |
| 24 | [#252](https://github.com/kust-projetos/meu-ted/issues/252) Allowlist de esquema em URLs de anexo | P2 | BACKLOG | `apps/pwa/src/features/ted/TedMessage.tsx:71-111` — renderiza url direta |

## 5. Resumo de disposições

- **BACKLOG (21):** #229–#233, #236–#241, #243–#245, #247–#252 — P1: #229, #230, #231, #232, #236, #237, #238; P2: demais.
- **REMOVE (3, com precondição):** #234 (só após decisão de não reabilitar PDF), #242 (com teste de roteamento), #246 (só pós-F5, com grep de `DB_SCHEMA=legacy` em CI).
- **KEEP (1):** #235 — teto STT atual mantido; reavaliar antes de coorte `*`.
- **FIX-NOW:** em execução nas 2 tracks paralelas; fora do escopo deste registro.

Todas as issues referenciam "auditoria 2026-10-19, V1-textual CLOSED — sem mudança de contrato V1" e carregam labels `post-v1` + `enhancement` (labels existentes; nenhum label novo criado).
