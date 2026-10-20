# 04 — POC Fase 2: comparação A × B × C (reads-only)

**Data:** 2026-10-20 · **Branch:** `feat/ted-v1-full-recovery` (= main `8ccd7a1`)
**Escopo:** protótipo ISOLADO `apps/agent/src/poc-minimal/` + `apps/agent/tests/poc-minimal.test.ts`.
Sem writes, sem tocar o hot path (nenhum arquivo fora de `poc-minimal/`, do teste e deste doc).

## 1. O que foi construído (B — protótipo modelo atual)

| Peça | Arquivo | Reutiliza o quê |
|---|---|---|
| Provider/modelo configurado (só presença de key, nunca valor) | `poc-config.ts` | `llm/provider-registry.ts` (`PROVIDER_SECRET_MAP`, `resolveSecret`, `getProviderEndpoint`) |
| Histórico conversacional (RAM, cap 20) | `poc-history.ts` | nada do hot path (isolado de `agent_memory`/`persistMessages`) |
| System prompt mínimo (constante) | `poc-system.ts` | — |
| Registry de 6 reads reais | `poc-reads.ts` | **mesmo contrato** `ChannelReadTools` de `orchestration/channel-evidence.ts` |
| Intenção determinística (8 cenários) | `poc-intent.ts` | — (propositalmente estreita) |
| Telemetria (tool/read, latência, tokens est., grounded/completed/hallucination) | `poc-telemetry.ts` | — |
| Agente (1 leitura → resposta fundamentada por template; erro = fail-closed sem dígitos) | `poc-agent.ts` | readers do hot path via injeção |
| Testes (13, sem rede/segredos/writes) | `tests/poc-minimal.test.ts` | stubs no contrato `ChannelReadTools` |

Modelo real **não** é chamado no POC: a resposta é template fundamentado na evidência
(`modelCalled=false`, tokens estimados por `chars/4`). O `poc-config.ts` resolve e
descreve provider/modelo de forma sanitizada, pronto para plugar o modelo quando o
gate de custo autorizar — sem mudar o registry.

## 2. Cenários (PLAN Fase 2, §6)

- S1 "Quais contas eu tenho?" · S2 "Liste meus cartões." · S3 "Mostre minhas faturas."
- S4 "Quanto gastei esse mês?" · S5 "Quanto gastei no mês passado?"
- S6 "Quais foram meus gastos de supermercado?" · S7 "O que é cartão de crédito?"
- S8 "Quanto gastei em janeiro de 2020?" (período sem dados)

## 3. Execução

- **A (runtime atual PWA):** `routeIntent()` real executado sobre os 8 textos via
  vitest temporário (arquivo removido após a coleta), 2026-10-20. Só roteamento —
  sem backend live, sem writes.
- **B (protótipo):** `PocMinimalAgent` com readers stubados no contrato real;
  `tests/poc-minimal.test.ts` **15/15 PASS** (`pnpm vitest run tests/poc-minimal.test.ts`)
  — 13 do POC + 2 da P2d (payload inválido `{}` e resumo sem campos → `completed=false`).
- **C (modelo de referência):** **NÃO EXECUTADO**. Motivo: chamada real a provider
  pago exige autorização explícita de custo do operador + gate `TED_REAL_MODEL_EVAL=1`
  (padrão dos evals V3). Checagem limitada à **presença** de aliases (2 presentes,
  resto ausente — valores nunca lidos nem logados). Nenhum número de C foi inventado.

## 4. Tabela A × B (roteamento + grounding)

Legenda: ✅ correto · ⚠️ parcial · ❌ incorreto · `—` não aplicável / não medido live.

| Cen. | A: modo/domínio/ops (`routeIntent` real) | A intenção+args | B: read+args (POC) | B intenção+args | Fundamentada (B, evidência stub) | Concluída (B) | Alucinação (B) |
|---|---|---|---|---|---|---|---|
| S1 contas | read/accounts/`list_accounts` | ✅ | `listAccounts` `{}` | ✅ | ✅ ("Nubank R$ 345,67") | ✅ | não |
| S2 cartões | read/cards/`list_cards` | ✅ | `listCards` `{}` | ✅ | ✅ (nunca statements) | ✅ | não |
| S3 faturas | read/payables/`list_payables` | ⚠️ (payables, não statements) | `listStatements` `{}` | ⚠️ (divergência de fonte — ver §5) | ✅ | ✅ | não |
| S4 mês atual | read/transactions/`get_month_summary` | ✅ | `getMonthSummary` `{yearMonth: 2026-10}` | ✅ | ✅ ("R$ 50,00") | ✅ | não |
| S5 mês passado | read/transactions/`get_month_summary` | ✅ (período no reader, cf. #256 P2a) | `getMonthSummary` `{yearMonth: 2026-09}` | ✅ | ✅ | ✅ | não |
| S6 supermercado | read/transactions/`list_transactions` | ✅ | `listTransactions` `{category, limit}` | ✅ | ✅ | ✅ | não |
| S7 conceito | read/cards/`list_cards` | ❌ (pergunta geral dispara leitura) | geral (sem leitura) | ✅ | ✅ (definicional, sem claim de workspace) | ✅ | não |
| S8 2020-01 | **mutation-proposal**/`transactions.expense.create` | ❌❌ (consulta vira proposta de mutação) | `getMonthSummary` `{yearMonth: 2020-01}` | ✅ | ✅ (ausência do escopo, sem valor fictício) | ✅ | não |

Latência/tokens/custo: B com stubs ≈ 0–2 ms por turno, `modelCalled=false`,
tokens estimados (`chars/4`), custo zero. A e C **não** medidos em live nesta fatia
(A exigiria backend com Test Family; C exige gate de custo) — registrar números aqui
sem executá-los seria fabricação.

## 5. Achados (evidência, não hipótese)

1. **S8 é bug real do roteador atual:** "Quanto gastei em janeiro de 2020?" planeja
   `transactions.expense.create` (mutation-proposal). Consulta de período arbitrário
   nunca deveria propor mutação. Local provável: `intent-router.ts` (gramática de
   data × sinal de mutação). A corrigir com teste RED→GREEN dedicado (fora desta fatia).
2. **S7 é misclassificação real:** "O que é cartão de crédito?" planeja `list_cards`.
   Conceito sem operação financeira deveria responder sem leitura.
3. **S3 tem divergência de fonte A×B:** A → `list_payables`, B → `listStatements`.
   Qual fonte responde "faturas" (statements × payables) é decisão de produto/dominio,
   não falha do POC — registrada para a Fase 4 (registry consolidado).
4. S1/S2/S4/S5/S6 convergem: o caminho determinístico atual já roteia bem esses casos
   (consistente com o closure #256/#257, PR #263).

## 6. DECISÃO: `deterministic_fix` (condicional, nos termos do PLAN §6)

- **B acerta 8/8 no roteamento** com registry mínimo + template fundamentado; **A acerta
  6/8** com 2 falhas determinísticas e reproduzíveis (S7, S8). Nada aqui indica falta de
  capacidade do modelo — as falhas estão no roteador determinístico, antes de qualquer LLM.
- Pela árvore do PLAN §6 ("ambos falham → contratos/contexto/prompt" para os casos
  divergentes; o resto já funciona), o próximo passo é **`deterministic_fix`**:
  1. fix S8 (consulta de período arbitrário nunca propõe mutação) + teste dedicado;
  2. fix S7 (pergunta conceitual sem operação → sem leitura) + teste dedicado;
  3. decisão S3 (statements × payables) na Fase 4.
- **`sdk_loop` permanece experimento isolado**, pendente de: (a) gate de custo do
  operador para C; (b) os fixes acima (trocar o runtime com S8 roteando para mutação
  seria trocar o sintoma de lugar). Critério de reavaliação: C executado sob
  `TED_REAL_MODEL_EVAL=1` mostrando ganho material onde o determinístico falha.

## 7. Validação desta fatia (sem commit)

- `pnpm vitest run tests/poc-minimal.test.ts` → **15/15 PASS** (13 do POC + 2 da
  P2d: payload inválido `{}` e resumo sem campos respondem fail-closed com
  `completed=false` — render e grounding viajam separados; a tabela A×B acima
  não muda porque todos os cenários S1–S8 usam payloads válidos).
- `pnpm typecheck` (programa inteiro) → **verde, 0 erros** (inclui `poc-minimal/*`).
- `pnpm lint` (biome, repo inteiro) → **não executado**: o binário trava neste
  ambiente (intermitência já registrada no projeto); mitigação: arquivos novos seguem
  o estilo dos vizinhos (imports `.js`, tipos explícitos, sem `any`).
- `git status` → só untracked: `apps/agent/src/poc-minimal/`,
  `apps/agent/tests/poc-minimal.test.ts`, este doc. **Hot path intocado, sem commit,
  sem segredos** (só presença de aliases, nunca valores).

## 8. Riscos / limites honestos

- B usa stubs: prova roteamento + grounding-template, **não** prova latência/custo
  live nem qualidade de modelo real (isso é C, pendente de gate).
- Template ≠ LLM: fluidez/redação do POC não generalizam para linguagem livre fora
  dos 8 cenários (roteador cai em `general` por desenho — fail-safe, não inteligente).
- S3 segue sem fonte canônica até a decisão da Fase 4.
