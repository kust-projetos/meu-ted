# Piloto integrado P3.1–P3.6 — conversa única (Etapa A) + validação cognitiva (Etapa B)

Base: `main@5d35084` (PR #300 / P3.6). Branch do piloto: `pilot/p3-integrated`. Nenhum deploy, nenhum dado pessoal.

## Resultado

**P3_INTEGRATED_FLOW_PASS: SIM (Etapa A, provider scriptado, browser real).**

**P3_REAL_MODEL_PASS: SIM (escopo estreito, Etapa B executada)** — modelo real `opencode-go/deepseek-v4.1-flash`: escolha correta de ferramenta (`propose_expense` via intent, zero escrita antes de aprovar) e manutenção de contexto ("qual conta" → Itaú) nos cenários do spec pequeno. Não é prova dos seis fluxos com modelo real.

## Escopo entregue

- Opção única `P2D_P3_PILOT=1` reutilizando o harness P2D (API sintética `buildTestApp`, Agent Worker local, gateway TED, OpenCode SDK 2.2.4, Pending V2, Playwright). Nenhum servidor, framework, banco ou arquitetura novos. Flag mutuamente exclusiva com slices P3 isolados e modos offline/live-prep.
- Correção mínima em `GET /dashboard/month-summary`: parâmetro opt-in `basis` (`liquidez` padrão, byte-for-byte anterior; `competencia` exclui despesas que são pagamentos de fatura via `statementPaymentId`, mesmo predicado do analytics). In-memory/canônico preservam o campo; legado ignora (coluna V056 é canonical-only).
- Etapa B preparada: combo `P2D_LIVE_REAL=1` + `P2D_P3_PILOT=1`, allowlist mínima de leituras no fetch-guard (`GET /categories`, `GET /cards/statements`), spec real pequena (`p3-integrated-real.spec.ts`). Produção segue com P3 writes desativados.

## Fluxos executados (Etapa A)

Data fixa `2026-11-07` (ciclo `2026-11`). Contas: Itaú (A1), Nubank/Neon (A2), cartão Nubank Card.

| # | Mensagem | Proposta | Verificação |
|---|----------|----------|-------------|
| 1 | "Gastei R$ 65 no almoço pela conta Itaú." | `propose_expense` 6500 | card Confirm, zero escrita, confirm → 1 despesa |
| 2 | "Recebi R$ 800 na conta Itaú." | `propose_income` 80000 | idem, 1 receita |
| 3 | "Transfira R$ 150 do Itaú para o Neon." | `propose_transfer` 15000 A1→A2 | 1 transferência atômica, DRE intacto |
| 4 | "Comprei R$ 120 no Nubank, à vista." | `propose_card_purchase` 12000 1x | 1 compra na fatura Nov |
| 5 | "Comprei R$ 600 em 3x no Nubank." | `propose_card_purchase` 60000 3x | 3× R$ 200 em Nov/Dez/Ja, recibo na 1ª parcela, banco intacto |
| 6 | "Pague R$ 300 da fatura do Nubank usando o Itaú." | `propose_statement_payment` 30000 | Nov total 32000, paid 30000 (partial), A1 −30000, dívida −30000 |
| 7 | "Agora quite o restante dessa fatura com a mesma conta." | `propose_statement_payment` 2000 | Nov paid 32000 (paid), A1 −2000 adicional, sem duplicar consumo |

Fatura Nov: total 32000 (12000 + 20000). Pagamentos criam despesa própria com `statementPaymentId` e debitam o banco sem recriar a despesa original (compras 1+3, pagamentos 2).

## Contexto e recuperação (mesma sessão)

- "Quanto falta pagar dessa fatura?" → resposta de texto com restante correto (quitada), sem proposta.
- "Qual conta usei para pagar?" → "Itaú" via contexto.
- Repetir confirmação: nenhum novo card, 7 confirms/7 executes inalterados, ledger sem duplicatas.
- Reload com proposta pendente (despesa extra R$ 10): mesmo card reidratado, zero prompt novo, depois Cancelar → zero escrita.
- "Pague a fatura" com Nov quitada + Dez aberta: pedido de esclarecimento, zero proposta.
- Journal: proposes 8–9 (replay de reload é idempotente/variável), confirms 7, executes 7, cancels 1, zero writes diretos.

## Resumo financeiro (`month-summary`)

Cenário Nov (almoço 6500 + compras Nov 32000 + pagamentos Nov 32000):

- `basis=liquidez` (padrão): `expenseCents 70500` (consumo + pagamentos — dupla contagem econômica, comportamento anterior preservado).
- `basis=competencia`: `expenseCents 38500` (só consumo; pagamentos excluídos).
- Correção aplicada é opt-in; nenhum consumidor quebra por default. Sem refatoração da camada analytics.

## Falhas tratadas (objetivas)

| Mensagem | Ferramenta | Esperado | Observado | Causa | Correção |
|----------|------------|----------|-----------|-------|----------|
| (infra) | — | — | `probe without ready` / webServer timeout | `node_modules` do checkout sem links pnpm + `.env.local` bloqueando preflight live | junctions locais p/ store + mover `.env.local` temporariamente (restaurado); `llm-contracts` reconstruído + relinkado |
| "Transfira R$150…" | `propose_transfer` | card Confirm | card degradado "incompleto" | `dist` de `@pi-finance/llm-contracts` desatualizado (sem ramo transfer no predicado) | rebuild + relink API/Agent |
| "Pague R$300…" | `propose_statement_payment` | card Confirm | card degradado sem apresentação | Agent usava `dist` desatualizado do worktree irmão (sem statement pay) | relink Agent p/ `packages/llm-contracts` |
| (assert spec) | — | saldos | falha em turnos 4–6 | expectativas esqueciam turnos 1–3 | expectativas corrigidas p/ valores medidos |
| (assert spec) | — | proposes 8 | flake 8↔9 | replay de reload idempotente é variável | `>=8` + confirms/executes/cancels exatos |
| Etapa B | modelo real | boot live-real | `probe without ready` também na spec de leitura isolada | infra do sandbox (não do piloto) | Etapa B preparada, não executada |

## Evidência (Etapa A)

- `P2D_P3_PILOT=1 pnpm exec playwright test -g "p3-integrated" --reporter=line` → **1 passed (1.1m)**.
- `apps/api/tests/routes/month-summary.test.ts` → **3 passed**.
- `pwa typecheck` / `api typecheck` / `node --check` probe+guard / `git diff --check` → limpos.
- `node --test p2d-live-modes.test.mjs` → guard ok; 2 falhas são preflight `.env.local` (ambiente, não regressão).
- Evidence JSON: `apps/pwa/test-results/p3-integrated/evidence.json` (saldo A1/A2, dívida cartão, fatura Nov, parcelas, month-summary, journal, mismatches).

## Etapa B (executada, escopo estreito)

- Preparada e executada: combo `P2D_LIVE_REAL=1 + P2D_P3_PILOT=1`, guard mínimo de leituras, spec pequena (`p3-integrated-real.spec.ts`: 1 despesa + contexto, asserts estruturais). Modelo: `opencode-go/deepseek-v4.1-flash` (`live-model.json`).
- Boot live-real resolvido (infra, sem tocar nos fluxos):
  - Causa 1 (timeout): probe real (catálogo + SDK) + wrangler sequenciais estouravam a janela de 240s do `webServer` Playwright → `timeout: 600000` só no entry do stack.
  - Causa 2 (stall): fetch-guard negava `GET /accounts?kind=...` (modelo real chama `list_accounts` com `kind=bank&includeInactive=false`) → loop de retry sem proposta. Guard liberalizado só para os formatos que o runtime emite (`kind` bank/cash/credit_card, `includeInactive` isolado ou combinado); teste do guard atualizado.
- Execução: `P2D_LIVE_REAL=1 P2D_P3_PILOT=1 playwright -g ... p3-integrated-real` → **1 passed (1.5m)**. Evidence `test-results/p3-integrated-real/evidence.json`: `promptCalls 2`, reads `GET /accounts?kind=bank&includeInactive=false` + `GET /categories?kind=expense` (200), `proposals 1`, `financialWrites 0`.
- Bônus comportamental: com prompt "almoço", o modelo recusou categoria errada e pediu confirmação (honesto); com "mercado" (categoria existente), propôs corretamente.
- Transporte do runtime não tem `/cards/statements` no allowlist (só contas/categorias/month-summary) — fora do escopo: a spec real não chama faturas; Etapa B maior dependeria dessa inclusão.

## Entrega

- Correções agrupadas neste PR (código + spec + guard + teste de resumo). Checks existentes executados acima; merge aguarda autorização explícita. Sem deploy.
