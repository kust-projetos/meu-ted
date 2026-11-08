# P3.6 — Pagamento de faturas por conversa

**Data:** 2026-11-08  
**Base:** `main@9485294` (P3.4/P3.5 mergeados)  
**Branch:** `feat/p3-statement-payment`  
**SHA:** `7242026`  
**PR:** https://github.com/kust-projetos/meu-ted/pull/300  
**Critério:** `P3_STATEMENT_PAYMENT_PASS`

## Objetivo

Permitir pagamento total e parcial de faturas de cartão pelo TED, com uma
confirmação produzindo um único pagamento. A entrega reutiliza o pagamento
financeiro existente (`CardStore.payStatement` / `payStatementInTx` /
`POST /cards/statements/:id/pay` / `GET /cards/statements`) e conecta ao fluxo
conversacional (OpenCode SDK → broker A4 → Pending V2 → PWA).

## O que foi implementado

### Backend autoritativo (`apps/api`)

- `CardStore.payStatement` aceita `options.idempotencyKey` e executa débito,
  atualização da fatura, delta da dívida do cartão e registro da chave na MESMA
  transação PostgreSQL.
- `runKeyedCardStatementPayment` (em `card-purchase-idempotency.ts`) reutiliza o
  mesmo `idempotency_keys` e o mesmo padrão de claim-race do P3.4/P3.5,
  mudando apenas o envelope persistido para `{ statement }`.
- Contrato `cards.statement.pay` no tool registry com args EXATOS:
  `statementId`, `fromAccountId`, `amountCents`; `autoExecutionEligible: false`.
- Executor reutiliza `payStatement` com a chave persistida do Pending V2 e
  emite recibo canônico com `entity: { type: 'statement', id: statementId }`.
- Apresentação server-side do card: cartão, competência, total, já pago,
  restante, vencimento, status e conta pagadora. O valor pago agora é explícito
  (nunca `amountCents: "total"`).
- Gate de propose: replay-first e validação contra leitura autoritativa —
  conta pagadora precisa ser bank/cash do workspace; fatura precisa existir,
  não pode estar quitada e o valor não pode exceder o restante.
- Gate de confirmação (presentation gate) revalida cartão/fatura/pagador e
  falha fechado quando qualquer contexto está ausente ou divergente.
- `GET /pending-operations/v2/active` reidrata a apresentação da fatura sem
  inventar ids/valores.
- Outcome/recibo mapeiam `cards.statement.pay` para a entidade `statement`.

### Regras financeiras preservadas

- Fatura quitada não recebe outro pagamento.
- Pagamento acima do restante é rejeitado sem alterações.
- Conta pagadora não pode ser cartão de crédito.
- Contas bank/cash podem ficar negativas (ADR-018).
- O pagamento é uma movimentação de saída em `liquidez`; em `competencia` a
  linha com `statement_payment_id` é excluída do agregado de despesa, então a
  compra original continua contada uma única vez. Nenhum cálculo global foi
  alterado.

### Runtime OpenCode (`apps/ted-runtime`)

- `list_card_statements` (leitura, opt-in P3) chama `GET /cards/statements`
  com filtro opcional por cartão e valida a shape (id, cartão, competência,
  total, pago, vencimento, status).
- `propose_statement_payment` (intent-only, opt-in P3) registra a intenção
  `cards.statement.pay` com o tuple exato; não faz HTTP, não escreve e não
  confirma/executa.
- Catálogo e permissões nativas incluem as duas tools; produção continua
  forçando os opt-ins P3 OFF.

### Broker e PWA

- `pending-proposal-broker` aceita `cards.statement.pay` no union de propostas
  e gera resumo "Pagamento de fatura de R$ X".
- `agent-client` valida o intent, mapeia `cards.statement.pay` para a entidade
  `statement` e exige o binding do id da fatura no recibo.
- `TedApprovalCard` renderiza o card do exemplo: cartão, fatura, valor da
  fatura, já pago, pagamento agora e conta pagadora, com Confirmar/Rejeitar.
- O recibo canônico referencia a fatura (`statement`), nunca uma transação
  fictícia.

## Testes

- `apps/api/tests/integration/p3-statement-payment-slice.test.ts` — slice
  sintético em memória (propose/confirm/reject/apresentação/reload/gates).
- `apps/api/tests/integration/postgres-statement-payment-idempotency.test.ts` —
  PostgreSQL real sintético (total, parcial, retry, reconcile, conflito,
  overpay, fatura quitada, pagador cartão, competência).
- `apps/api/tests/approvals/tool-registry.test.ts` e
  `apps/api/tests/approvals/presentation.test.ts` — contrato e apresentação.
- `apps/ted-runtime/tests/p3-statement-payment.test.mjs` — catálogo, args,
  leitura e intent-only.
- `apps/agent/tests/pending-propose-rpc.test.ts` — broker A4.
- `apps/pwa/src/lib/api/__tests__/agent-client.proposal.test.ts` e
  `apps/pwa/src/features/ted/__tests__/TedApprovalCard.test.tsx` — intent e card.
- `apps/pwa/e2e/p2d/p3-statement-payment.spec.ts` — Playwright P2D real
  (Chromium + Next + gateway + OpenCode SDK + Agent Worker + Pending V2),
  com provider local scriptado, sem inferência paga.

## Validação

- `pnpm typecheck` — PASS (llm-contracts, API, PWA, Agent, Codex broker e
  ted-runtime).
- API focada:
  - `tool-registry.test.ts` + `presentation.test.ts` +
    `p3-statement-payment-slice.test.ts` — **39/39 PASS**.
- PostgreSQL real sintético:
  - container PostgreSQL 15 descartável `pi-p36-pg` (porta 55436), marcador
    `_test_marker` = `pi-p36-test`, acessado por túnel SSH do contexto
    `contabo-dev-rootless`;
  - `postgres-statement-payment-idempotency.test.ts` — **9/9 PASS**
    (total, parcial, retry, reconcile, conflito, overpay, fatura quitada,
    pagador cartão e competência).
- Agent focado:
  - `mutation-executor-strict-validation.test.ts` +
    `pending-propose-rpc.test.ts` + `f2a-structured-interpretation.test.ts` —
    **51/51 PASS** (inclui o parser de recibo `statement` e o broker A4).
- Runtime OpenCode:
  - `pnpm --filter pi-finance-ted-runtime test` — **291/291 PASS**.
- PWA focada:
  - `TedApprovalCard.test.tsx` + `agent-client.proposal.test.ts` +
    `mutation-reconciler.test.ts` — **58/58 PASS**.
- Regressões focadas P3 (API):
  - `p3-expense-slice` + `p3-transfer-slice` + `p3-income-broker-flow` +
    `p3-transfer-broker-flow` — **24/24 PASS**.
- Playwright P2D:
  - `P2D_STATEMENT_PAY=1 pnpm --filter pwa exec playwright test
    --config=e2e/playwright.config.ts --project=p2d-synthetic` —
    **1/1 PASS** (57,9 s), cobrindo proposta → card → rejeição → reload →
    confirmação → um único pagamento + recibo `statement`; evidência em
    `apps/pwa/test-results/p3-statement-payment/evidence.json` (gitignored).
- Gates rápidos (pre-commit): `docs:lint`, `action-pins:check`,
  `test:skip-gate`, `capabilities:check`, `write-policy:check`,
  `governance:check`, `boundary:check`, `public-safety --strict` — **PASS**.
- `pnpm lint` completo: não concluído localmente (Biome excedeu o timeout no
  Windows). O lint autoritativo do CI passou no job **Quality — lint +
  typecheck + build**.
- CI do PR #300 — **PASS**:
  - `Gate — all checks` — PASS;
  - `quality (22, 10)` — PASS;
  - `Financial integrity — Postgres` — PASS;
  - `Quality — lint + typecheck + build` — PASS;
  - `TED Runtime — lint + typecheck + test` — PASS;
  - `Functional — tests + smoke` — PASS;
  - `Docs + governance` — PASS;
  - `Agent policies` — PASS.

## Limites (fora de escopo, conforme pedido)

- Sem agendamento de pagamentos.
- Sem juros, renegociação ou estorno.
- Sem novo broker/fluxo de autorização, sem mudança de gates/infra.
- Sem inferência paga e sem contas/faturas reais.
- Sem merge/deploy nesta entrega.
