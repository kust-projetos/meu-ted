# P3.5 - compras parceladas por conversa (OpenCode-first)

**Data:** 2026-11-08
**Base:** `5adb6ec` (main, merge do PR #298 - P3.4)
**Branch:** `feat/p3-installments`
**Ambiente:** desenvolvimento local, dados sintéticos, provider HTTP scriptado
**Veredito:** `P3_INSTALLMENTS_PASS` no escopo local/determinístico; sem merge,
deploy ou escrita financeira real.

## 1. Fluxo funcional

```
PWA (mensagem)
  → /api/agent → gateway ted-runtime (loopback)
  → prompt loop OpenCode (provider scriptado local)
  → tool propose_card_purchase: valida args + identidade host-bound
  → registra INTENÇÃO com installmentsTotal (sem HTTP, sem escrita)
  → gateway anexa `proposal` ao turno (uma vez)
  → TedChat → Agent broker `POST /rpc/pending-operations/propose`
  → Agent emite SOMENTE `financial.approval.propose` (A4)
  → API `POST /pending-operations/v2/propose` (Pending V2, idempotente)
  → TedChat reidrata o card ativo autoritativo (prévia com as parcelas)
  → usuário Confirma/Rejeita (mesmo caminho de decisão do P3.4)
  → API confirma/executa → `createCardInstallments` numa ÚNICA transação
  → N parcelas + N faturas + dívida do cartão pelo TOTAL + recibo canônico
```

Com a mensagem exata **"Comprei R$ 1.200 em 6x no Nubank."** o teste P2D
determinístico comprova: o card mostra **Compra parcelada — R$ 1.200,00**,
`Parcelamento 6x de R$ 200,00`, `Primeira fatura 25/11/2026`, cartão e
descrição; antes da confirmação há **zero** parcelas; após a confirmação há
**exatamente 6** parcelas de R$ 200,00, cada uma na fatura do seu ciclo, com a
dívida do cartão em +R$ 1.200,00 (não ×6), saldo bancário intacto e recibo
canônico vinculado à PRIMEIRA parcela.

## 2. Componentes reutilizados (nada foi reimplementado)

- `CardStore.createCardInstallments` / `createCardInstallmentsInTx` (Postgres,
  legacy, in-memory), `splitInstallmentAmounts` e `installmentDates`
  permanecem a regra financeira única.
- `runCardMutation('installments')`, `POST /cards/installments`,
  `runKeyedCardPurchase` e a infraestrutura de idempotência do P3.4.
- `cards.purchase.create` continua sendo a ÚNICA ferramenta de compra no
  Pending V2; `propose_card_purchase` continua sendo a ÚNICA proposta no
  runtime; o broker A4 é o mesmo.
- Nenhum segundo broker, ferramenta, gate, policy, serviço ou infraestrutura.

## 3. Contratos alterados (campo opcional `installmentsTotal`, 1–48)

- **API** (`apps/api/src/approvals/tool-registry.ts`): campo no schema estrito
  da ferramenta; 2–48 roteia para `createCardInstallments` com
  `totalAmountCents = amountCents` (TOTAL); ausente/1 mantém o caminho P3.4
  byte a byte. Um split declarado nunca degrada para 1x.
- **llm-contracts**: `PendingOperationPresentation` ganha
  `installmentsTotal`, `installmentAmountsCents`, `firstStatementClosingDate`,
  `firstStatementDueDate`; o gate de acionabilidade exige contagem válida,
  quantidade exata de parcelas e soma igual ao TOTAL.
- **Runtime** (`apps/ted-runtime/src/tool-defs.mjs`): schema da tool,
  `knownKeys`, validação (1–48; total cobre ≥ 1 centavo por parcela) e
  `normalizedArgs` só carrega o campo quando declarado.
- **Broker A4** (`apps/agent/src/mutations/pending-proposal-broker.ts`): campo
  opcional no contrato estrito + resumo "em Nx".
- **POC estruturado** (`apps/agent/src/poc-structured`): `installmentsTotal`
  no vocabulário fechado (`installment-count`, 1–48).
- **PWA** (`apps/pwa/src/lib/api/agent-client.ts` e `TedApprovalCard.tsx`):
  contrato do intent + prévia que renderiza apenas os valores calculados pelo
  backend; 1x mantém o card atual.

## 4. Idempotência e atomicidade

`createCardInstallments` ganhou `options.idempotencyKey` e reutiliza
`runKeyedCardPurchase`: claim + todas as parcelas + completion commitam na
MESMA transação. Provas em PostgreSQL sintético:

- uma confirmação cria as N parcelas numa transação única;
- retry com a mesma chave devolve o mesmo conjunto (mesmos ids) sem duplicar;
- reconcile pós-commit perdido reexecuta a MESMA chave e devolve o mesmo
  conjunto;
- mesma chave com argumentos diferentes → `idempotency.conflict`, zero escrita;
- falha injetada no meio da criação (trigger no 3º INSERT) → **zero** parcelas,
  zero `card_purchases`, zero chave de idempotência, dívida do cartão intacta;
- recibo canônico `cards.purchase.create` vinculado à primeira transação.

## 5. Testes e resultados

### PostgreSQL sintético (local, PG 15)

`tests/integration/postgres-card-installments-idempotency.test.ts`: **7/7
passed**, cobrindo 6x de R$ 200,00, centavos (R$ 10,00 → 3,33 + 3,33 + 3,34),
retry/conflito, reconcile, falha parcial, compra no dia do fechamento
(ciclo atual) vs. dia seguinte (próximo ciclo) e fim de mês (31/01 → 28/02).

Regressão P3.4 `tests/integration/postgres-card-purchase-idempotency.test.ts`:
**3/3 passed**.

### Playwright P2D (browser real, Agent local, Pending V2)

- `P2D_CARD_INSTALLMENTS=1` → `p3-installments.spec.ts`: **1 passed**
  (confirmação, 6 parcelas, 6 faturas, dívida pelo total, banco intacto,
  recibo, rejeição, reload sem duplicar).
- Regressões focadas: `P2D_CARD` (1x) **1 passed**, `P2D_EXPENSE` **1 passed**,
  `P2D_INCOME` **1 passed**, `P2D_TRANSFER` **1 passed**.

### Suítes locais (árvore final)

- API: **2884 passed / 172 skipped**.
- Agent: **3963 passed / 1 skipped**.
- PWA: **2936 passed / 9 skipped**.
- ted-runtime: **282 passed**.
- llm-contracts: **25 passed**.
- `typecheck`: API, Agent, PWA e llm-contracts verdes.
- Gates: `capabilities:check`, `write-policy:check`, `governance:check`,
  `boundary:check`, `public-safety --strict` verdes.

Nota de honestidade: o provider do E2E é um stub HTTP local scriptado; nenhuma
inferência paga/externa foi usada.

## 6. Limites respeitados

Sem pagamento de fatura, sem juros/acréscimos, sem cancelamento de conjunto de
parcelas, sem novos gates/policies/serviços, sem deploy, sem merge e sem
alteração de produção.

## 7. Bloqueios reais restantes

Nenhum no escopo local. O merge/deploy e o gate `CI` de PR público são ações
fora deste escopo (o PR é aberto sem merge).
