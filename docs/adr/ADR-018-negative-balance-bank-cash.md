# ADR-018 — Saldo negativo permitido em contas banco/dinheiro; cartão permanece não-negativo

**Status:** Aceito
**Data:** 2026-09-18

## Contexto

A V4.1 decidiu D1 = opção B (proibir negativo):
`docs/reports/v4.1-decision-gates.md:9` (validação pré-débito sob lock,
`CHECK (balance_cents >= 0)` mantido, clamps `GREATEST(0, …)` removidos),
com diagnóstico em `docs/reports/v4.1-domain-decisions.md` (D1) e reflexos em
`v4.1-canonical-parity.md` (§1, Part C: divergência documentada D1),
`v4.1-schema-parity.md` e `v4.1-financial-integrity.md` (§3).

A triagem read-only pós-deploy (`docs/reports/v4.1-reconciliation-triage.md`
§2–§4.3, item 1) encontrou a conta `814332c4` com saldo armazenado −R$ 560,00
ledger-consistente (detector `detectors.ts:164-221` só emite
`negative_stored_balance` sem `expected` quando o armazenado confere com o
derivado). A triagem classificou o caso como ambíguo (overdraft real vs
lançamento faltante) e pediu decisão humana.

O usuário aprovou política diferente da D1=B: **contas de banco/dinheiro
podem ter saldo negativo, incluindo saldos iniciais; o saldo devedor do
cartão de crédito permanece não-negativo**. Esta decisão substitui a D1=B
como autorização de semântica de saldo.

## Decisão

1. **Escopo por tipo de conta (card scope explícito).** `BANK`/`CASH`
   representam saldo em conta e **podem ser negativos** (cheque
   especial/overdraft real), **incluindo `initial_balance` negativo** na
   criação da conta. `credit_card` representa **saldo devedor em aberto**
   (compras menos pagamentos; crédito disponível =
   `credit_limit_cents - balance_cents`) e **permanece não-negativo**
   (`balance_cents >= 0`).
2. **D1=B está superseded por este ADR** como autorização de semântica de
   saldo. Os relatórios V4.1 acima permanecem como registro histórico fiel
   do que foi diagnosticado, recomendado e implementado — esta decisão os
   **substitui como autorização, não os reescreve**.
3. **Implementação ≠ deploy/mutação de dados.** Este ADR autoriza somente
   implementação em controle de versão (código + testes: validação de
   débito por kind, `CHECK` por kind, deltas exatos sem clamp parcial,
   testes de paridade legacy×canonical atualizados). **Não** autoriza
   deploy, DML/DDL em produção, migração do `CHECK`, backfill de saldos,
   nem cutover canônico — cada um exige autorização, janela e backup
   próprios.
4. **Estado implementado (fonte não commitada, não implantada).** A
   semântica acima está implementada em fonte ainda **não commitada e
   não implantada**: migração `V055__negative_bank_cash_balances.sql`
   (troca o `CHECK (balance_cents >= 0)` global da V001 pelo `CHECK`
   condicional por kind
   `accounts_balance_nonnegative_card_chk CHECK (kind <> 'credit_card' OR
   balance_cents >= 0)`, sem tocar a V001, com bloco `DO` guardado por
   `information_schema` — no-op verificado no shape legado de saldo
   computado — e registro **canônico** em `migrate.ts`;
   **correção fix-v055-legacy-startup-contract: a V055 é canônica
   exclusiva, fora de `LEGACY_SAFE_PREFIXES` com justificativa em
   `LEGACY_EXCLUDED_JUSTIFICATIONS`, porque o ledger legado da VPS
   termina em V054 e o `verifySchema` legado recusa boot com entrada
   V055 no manifesto**);
   validação de débito por kind (`assertDebitAllowed` em
   `writes/postgres.ts`, com paridade em `writes/in-memory.ts`,
   `payables/*` e `cards/*`: `BANK`/`CASH` nunca rejeitam por saldo
   insuficiente, `credit_card` falha com `validation.invalid`; criação de
   conta só aceita `initial_balance` negativo em `bank`/`cash`);
   reconciliação (`detectors.ts`: saldo armazenado negativo
   ledger-coerente não emite finding; linha sem âncora segue `info`
   qualquer que seja o sinal); otimismo da PWA preserva saldo negativo
   (`negative-balance-optimism.test.tsx`). **Nenhum deploy e nenhuma
   DML/DDL em produção ocorreram sobre este conjunto** — o topo aplicado
   em produção segue V053/V054 e este ADR não afirma rollout.

## Invariantes

- **Débito exato, nunca parcial silencioso.** Removido o clamp, todo débito
  aplica o delta integral ou falha antes de qualquer crédito (transfer
  falha antes de creditar o destino); sem criação de dinheiro.
- **Cartão nunca negativo.** Qualquer escrita que negativaria
  `credit_card.balance_cents` é erro/gate; available acima do limite é
  erro, não crédito extra.
- **Ledger autoritativo.** Saldo materializado de `BANK`/`CASH` deve
  convergir com o ledger (`transactions`); divergência materializada×ledger
  continua sendo drift, não exceção.
- **Histórico reconciliado, não reescrito.** O finding `814332c4` deixa de
  ser ambíguo somente após a implementação + reconciliação verde; até lá,
  segue visível como drift ativo, não como exceção reconhecida.

## Consequências

> **Atualização de implementação (2026-09-26, ainda não implantada):** no
> canônico, `credit_card.balance_cents` materializa a dívida de todos os
> ciclos: `initial_balance_cents + compras vivas vinculadas − soma dos
> pagamentos das faturas`. O pagamento reduz simultaneamente a dívida e o
> saldo da conta pagadora; um resultado negativo falha sem clamp. A API
> distingue explicitamente `balanceSemantics: outstanding_debt` no cartão
> canônico de `legacy_calculated` no legado; a PWA só usa o saldo como dívida
> quando recebe a primeira semântica. Os dados de teste legados com dívida
> negativa ou compras sem fatura não são convertidos por inferência.

- Detectores e gates passam a distinguir kind: saldo armazenado negativo
  em `BANK`/`CASH` que confere com o ledger não emite finding após a
  implementação; em `credit_card` continua erro (validação de escrita +
  `CHECK` condicional). `negative_stored_balance` como kind histórico da
  triagem pertence ao diagnóstico pré-implementação, não ao
  comportamento pós-implementação.
- Migração do `CHECK` global (`balance_cents >= 0`) para restrição por kind
  exige migração de schema dedicada (fora deste ADR como execução; a
  autorização de desenho está aqui, a execução segue rito próprio com
  backup e janela). O desenho implementado é a V055 (bloco `DO`
  guardado, idempotente, V001 intacta); a aplicação da V055 em qualquer
  ambiente segue rito próprio e não está autorizada por este ADR.
- Rollout: implementação restrita a controle de versão (código de
  escrita/validação + testes), sem DML/DDL, sem acesso a produção, sem
  deploy. Rollback: revogar este ADR por novo ADR; reinstaurar D1=B exige
  reavaliar Fase 2 (payables), Fase 4 (canônico) e paridade Part C.
- Cutover canônico segue bloqueado até paridade re-provada sob a nova
  semântica (a divergência Part C deixa de ser "intencional D1" e vira
  comportamento a re-testar).

## Referências

- `docs/reports/v4.1-decision-gates.md:9` (D1=B, ora superseded como
  autorização).
- `docs/reports/v4.1-domain-decisions.md` (D1: diagnóstico, opções A/B/C).
- `docs/reports/v4.1-reconciliation-triage.md` §§2–4.3 (finding `814332c4`,
  evidência, não autorização).
- `docs/reports/v4.1-canonical-parity.md` §1 (Part C);
  `docs/schema/fingerprint.md` (invariantes de `balance_cents`);
  `docs/architecture/schema-fingerprint.md` (semântica de saldo).
