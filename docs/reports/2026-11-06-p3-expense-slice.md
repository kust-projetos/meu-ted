# P3 — fatia de despesa por conversa (OpenCode-first)

**Data:** 2026-11-06  
**Base:** `c261d92` (head do PR #290)  
**Branch:** `feat/p3-expense-slice`  
**Ambiente:** desenvolvimento local, dados sintéticos, provider HTTP scriptado  
**Veredito:** `P3_EXPENSE_SLICE_PASS` no escopo local/determinístico; sem merge,
deploy ou escrita financeira real.

## 1. Fluxo funcional implementado

```
PWA (mensagem)
  → /api/agent → gateway ted-runtime (loopback)
  → prompt loop OpenCode 2.2.4 (provider scriptado local)
  → tool propose_expense: valida args + identidade host-bound
  → registra INTENÇÃO (sem HTTP, sem escrita)
  → gateway anexa `proposal` ao turno (uma vez)
  → TedChat → Agent broker `POST /rpc/pending-operations/propose`
  → Agent emite SOMENTE `financial.approval.propose` (A4)
  → API `POST /pending-operations/v2/propose` (Pending V2, idempotente)
  → TedChat reidrata o card da lista ativa autoritativa
  → usuário Confirma/Rejeita (caminho de decisão existente)
  → API confirma/executa → recibo canônico → refresh financeiro
```

Com a mensagem exata **“Registre uma despesa de R$ 50 no mercado, na conta
Nubank.”**, o teste determinístico com o SDK real comprova: a mensagem chega ao
loop, o catálogo oferece `propose_expense`, a tool registra
`{amountCents: 5000, description: "mercado", date, accountId, categoryId}` e
**zero** chamadas ao transporte financeiro. O card de R$ 50,00 aparece somente
após a proposta persistir; antes disso, zero lançamentos.

## 2. Arquivos alterados

**Runtime (`apps/ted-runtime`)**
- `src/proposal-intents.mjs` (novo): registry process-local; `take` destrutivo,
  `clear` no início de cada turno; não é registro financeiro.
- `src/tool-defs.mjs`: def/validação/executor de `propose_expense` (intent-only).
- `src/plugin.mjs`: opt-in local `TED_OPENCODE_P3_WRITES_ENABLED=1`
  (não-produção) expõe `propose_expense` + `list_categories`; permissão nativa
  `ted.finance.read/propose_expense`; registry injetado.
- `src/bootstrap.mjs`: `tedConfig(profile, { p3Writes })` adiciona a permissão
  exata apenas no opt-in; `writeTedConfig` aceita o irmão de flag (ida/volta sem
  tratar config própria como trabalho do usuário).
- `src/server.mjs`: limpa o intent no início do turno e o anexa ao DTO de
  sucesso exatamente uma vez.
- `README.md`: catálogo e limites atualizados.

**Agent (`apps/agent`)**
- `src/mutations/pending-proposal-broker.ts` (novo): mint propose-only + validação
  estrita + `createMutationProposal` com chave derivada.
- `src/finance-chat-agent.ts`: `POST /rpc/pending-operations/propose` (sem
  confirm/execute/cancel/authorize).
- `src/worker.ts`: allowlist exata da nova rota (identidade/device carimbados).

**PWA (`apps/pwa`)**
- `src/lib/api/agent-client.ts`: `ExpenseProposalIntent`, sanitização estrita,
  `proposePendingExpense`, campo `proposal` no turno.
- `src/features/ted/TedChat.tsx`: chama o broker após o turno, antes do reload;
  falha vira erro retentável sem card inventado.

**Testes**
- `apps/ted-runtime/tests/p3-propose-expense.test.mjs` (11)
- `apps/ted-runtime/tests/p3-proposal-handoff.test.mjs` (4)
- `apps/ted-runtime/tests/p3-propose-loop.test.mjs` (1, SDK real + provider local)
- `apps/agent/tests/pending-propose-rpc.test.ts` (7)
- `apps/agent/tests/worker-pending-propose.test.ts` (2)
- `apps/pwa/src/lib/api/__tests__/agent-client.proposal.test.ts` (7)
- `apps/pwa/src/features/ted/__tests__/TedChat.propose.test.tsx` (3)
- `apps/api/tests/integration/p3-expense-slice.test.ts` (6)
- `apps/api/tests/integration/p3-expense-broker-flow.test.ts` (4)

## 3. Como a autorização Pending V2/A4 foi reutilizada

- O gateway OpenCode **não** recebeu `AGENT_DELEGATION_SECRET`, não mintou
  capability e não chamou a API de proposta.
- O único emissor continua sendo `apps/agent` (`createDelegatedTurnToken`). O
  broker emite **exatamente** `['financial.approval.propose']`, com
  `deviceId` do device verificado, `requestId` = `intentionId` estável e
  expiração de 300 s do contrato existente.
- A API não foi alterada: o preHandler delegado e
  `requireV2Capability('financial.approval.propose')` continuam a autoridade.
  `Idempotency-Key` é derivada por
  `deriveIdempotencyKey(workspace, intentionId, tool)` — repetição do mesmo
  intent devolve a MESMA operação.
- O LLM não tem ferramenta de confirmar/executar; os testes provam 404 nesses
  caminhos no broker e ausência de executores `confirm_*`/`execute_*` no
  catálogo.
- O card continua vindo da lista ativa autoritativa; a confirmação reutiliza
  `/rpc/pending-operations/:id/decision` e o recibo canônico existentes.

## 4. Resultado dos testes

| Suíte | Resultado |
|---|---|
| `ted-runtime` completo (`node --test tests/`) | **242/242 PASS** |
| Agent completo | **3959 PASS / 1 skip** |
| API completo | **2903 PASS / 425 skips** (Postgres sem `DATABASE_URL_TEST`) |
| PWA completo | **2926 PASS** |
| `p3-propose-loop` (SDK real, provider scriptado) | **PASS** — mensagem exata → tool → intent, zero transporte |
| `p3-expense-slice` (API sintética) | **6/6** — 0 antes, 1 depois, reject 0, replay 1, reload recupera, workspace estranho 403 |
| `p3-expense-broker-flow` (broker real + verificador real) | **4/4** — mint decodificado, 0→1, reject 0, replay sem duplicata, cross-workspace 403 |
| `pnpm typecheck` | **PASS** (6 workspaces) |
| `check-agent-v2-invariants` (A4/A9) | **PASS** (542 arquivos) |
| `pnpm write-policy:check` | **PASS** (183/183) |
| **CI remoto (PR #293, SHA `e6989c2`)** | **CI verde** (inclui `Gate — all checks`, `TED Runtime — lint + typecheck + test`, API, Agent, PWA, Postgres, Security, Docs) e **PWA CI verde** (`quality (22, 10)`, `e2e (22, 10)`) |

Inferência paga/real: **não executada**. Nenhum dado financeiro real, Postgres,
deploy ou merge.

## 5. Bloqueios e riscos residuais

1. **Browser E2E completo com A0 local: não executado.** O fluxo foi provado por
   testes determinísticos de cada contrato (SDK real → intent; cliente → broker;
   broker → API real → confirmação) e por testes de componente do card. Não há
   prova de uma única sessão de browser com A0 rodando localmente.
2. **Turno concluído + chamada do broker perdida:** o retry reusa a mesma
   intenção (idempotente), mas o turno recuperado não reemite o intent; o usuário
   precisa enviar nova mensagem. Não há duplicação financeira nesse caminho.
3. **A0 foi modificado** (rota aditiva autorizada nesta sessão). O broker não
   interpreta texto nem participa de turnos; a decisão de produção continua
   congelada.
4. **`list_categories` acompanha o opt-in de escrita** para permitir resolução de
   categoria; produção força ambos off.
- **CI remoto (PR #293, SHA `e6989c2`):** **CI verde** — `Gate — all checks`,
  `TED Runtime — lint + typecheck + test`, API, Agent, PWA, Postgres, Security,
  Docs e Write policy PASS; **PWA CI verde** — `quality (22, 10)` e
  `e2e (22, 10)` PASS. O PR é empilhado sobre o #290 (`9d86771` + `e6989c2` são
  os commits próprios); a base é `main` porque `ci.yml`/`pwa-ci.yml` só disparam
  em PRs para `main`/`master`. Quando o #290 for mergeado, o diff do #293 colapsa
  para a fatia P3. Nenhum commit foi adicionado ao #290.

## 6. Estado Git

- Worktree `D:\projetos\pi-ted-opencode-product` sincronizada de `9086ea2` para
  `c261d92` (fast-forward), sem tocar o PR #290.
- Preservados antes da sincronização: `apps/pwa/e2e/p2d/p2d-live-offline.spec.ts`
  e `p2d-live-real.spec.ts` (WIP não commitado; cópias em
  `%TEMP%\opencode\p3-preserve-20261106\`). `--no-save/` (node_modules) intacto e
  fora do commit.
- Branch P3 separada; commit e PR sem merge.
- PR: https://github.com/kust-projetos/meu-ted/pull/293 (base `main`, empilhado
  sobre o #290; commit próprio `9d86771`).
