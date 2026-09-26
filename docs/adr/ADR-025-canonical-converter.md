# ADR-025 — Arquitetura do conversor Legacy→Canonical e âncora de saldo inicial

**Status:** Aceito
**Data:** 2026-09-25

## Contexto

O cutover Canonical estava bloqueado na inexistência do conversor
(`docs/superpowers/plans/2026-09-22-canonical-cutover.md`). A conversão real
envolve decisões que a ADR-024 não fixa: estratégia física, autenticidade do
ledger `_migrations`, proveniência de audit logs, derivação de identidade,
semântica de saldo materializado e recuperação de falha parcial. Além disso, a
reconciliação legacy computa `saldo inicial + movimentos` enquanto a canônica
computava apenas movimentos — saldos iniciais não nulos gerariam drift falso
pós-cutover.

## Decisão

1. **Forma física:** o conversor arquiva TODAS as relações legacy (tabelas,
   views, sequences, funções próprias, ledger) num schema de arquivo
   (`legacy_archive`) e constrói o `public` canônico vazio executando as
   migrations reais V001–V057 via `runMigrations(pool, false)`. Os dados são
   então importados em ordem de FK. `ALTER` in-place e fabricação de linhas de
   ledger foram rejeitados: o ledger canônico só nasce de execuções reais.
2. **Âncora de saldo:** a migration `V058` (canonical-only, aditiva) cria
   `accounts.initial_balance_cents BIGINT NOT NULL DEFAULT 0`. A reconciliação
   canônica passa a validar `balance_cents == initial_balance_cents + Σ
   movimentos` (fórmula legacy inalterada). O saldo materializado é calculado
   espelhando o write-path canônico (deltas exatos em `bigint`, sem clamp;
   `credit_card` negativo falha fechado; `bank`/`cash` negativos permitidos —
   ADR-018). Uma transação de compra no cartão vinculada por
   `card_purchases.transaction_id` recebe backfill de `statement_id` antes do
   cálculo de saldos e é excluída do saldo da conta, como no write-path.
3. **Proveniência:** `audit_logs` legacy permanece exclusivamente no arquivo —
   nenhum evento sintético é criado no canônico. Objetos de extensão
   (`pgcrypto`) permanecem em `public` (V001/V013/V053 usam `CREATE EXTENSION
   IF NOT EXISTS`); apenas relações próprias da aplicação são arquivadas.
4. **Identidade:** households e memberships ausentes no legado podem ser
   derivados com a semântica de materialização da V020, com os mesmos UUIDs e
   cada derivação marcada no relatório; owner-membership é resolvido por
   evidência (owner → member → vínculo device/operation → fallback single-user)
   e ambiguidade real falha fechada. Nenhuma identidade sintética (ADR-024 §3).
5. **Idempotência e recuperação:** `_conversion_marker` grava `backup_id`,
   fingerprint do plano, estado e resumo. Re-execução com o mesmo `backup_id`
   em estado `completed` apenas reverifica e retorna no-op. Falha em qualquer
   fase grava estado `failed` com a fase e orienta restaurar o backup e
   reiniciar do zero — não há retomada parcial (D6).
6. **Exatidão monetária:** toda aritmética de centavos usa `bigint` com
   verificação de range BIGINT antes de escrita; valores são vinculados como
   decimal exato (string), nunca `float`/`number` em somas.
7. **Fail-closed:** o pipeline exige backup gate (`BACKUP_CONFIRMED=true` +
   `BACKUP_ID`), plano sem blockers, `requireTestDatabase` fora de produção, e
   propaga erros de leitura (ausência de tabela só é aceita comprovada por
   catálogo). Campos sem destino canônico não são descartados: permanecem no
   arquivo e aparecem no relatório (ADR-024 — preservação fiel).

## Consequências

> **Atualização de implementação (2026-09-26, ainda não implantada):** a
> projeção canônica do cartão segue a ADR-018: dívida materializada = âncora
> inicial + compras vivas vinculadas a faturas do mesmo cartão/household −
> `statements.paid_cents`. Compras, parcelas, edição e cancelamento aplicam
> os deltas na mesma transação da fatura e do ledger; o pagamento debita a
> conta pagadora e reduz a dívida do cartão. A reconciliação e o conversor
> verificam a mesma fórmula, sem somar `card_purchases` uma segunda vez nem
> inferir pagamentos históricos por descrição. Âncora negativa de cartão,
> vínculo inválido ou dívida negativa continuam NO-GO. Isto substitui a
> descrição do write-path de cartão nos itens 2 e nas referências históricas
> deste ADR; não autoriza reparo automático de dados nem deploy.

- O cutover deixa de estar bloqueado pela inexistência do conversor; a F2 do
  plano de cutover passa a ser executável com
  `scripts/rehearse-canonical-conversion.mjs` (ensaio em PostgreSQL
  descartável com dump anonimizado) antes de qualquer operação em produção.
- `verifySchema` canônico passa a exigir `accounts.initial_balance_cents`
  (fail-closed no boot canônico pós-V058).
- Rollback pós-conversão: trocar `DB_SCHEMA=legacy` sozinho NÃO é suficiente —
  após o arquivamento, o rollback exige restaurar o dump validado com writes
  parados; writes canônicos pós-conversão se perdem num restore (decisão
  humana de reconciliação).
- Reparos financeiros permanecem proibidos durante a conversão (ADR-024): o
  conversor preserva fiel e reporta; reparo é operação separada no canonical.

## Referências

- `docs/adr/ADR-024-legacy-canonical-conversion-policy.md`.
- `docs/adr/ADR-018-negative-balance-bank-cash.md`.
- `apps/api/src/scripts/canonical-converter/` (plan, archive-and-bootstrap,
  mapping, import, identity, balances, convert).
- `apps/api/src/read-models/sql/V058__account_initial_balance_anchor.sql`.
- `apps/api/src/scripts/reconciliation/sql.ts` (fórmula canônica com âncora).
- `scripts/rehearse-canonical-conversion.mjs`.
- `docs/superpowers/plans/2026-09-22-canonical-cutover.md`.
