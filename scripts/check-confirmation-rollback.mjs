#!/usr/bin/env node
/**
 * PR137-HARDEN round 5 — trava operacional de rollback da confirmação.
 *
 * Um rollback do código para o pré-hardening (base `7d6283e`) sobre linhas
 * NOVAS (`reserved`/`inconclusive`/sentinela unbound) é um FALSO-SUCESSO: o
 * leitor antigo ignora `status` e replaya qualquer binding com operation_id
 * como sucesso (provado em
 * `apps/agent/tests/orchestration/confirmation-rollback-compat.test.ts`,
 * caso `ROLLBACK-DANGER`). Por isso o rollback para pré-hardening exige
 * DRENAR as confirmações (sem pendentes/reservas) + aprovação humana —
 * senão BLOQUEADO.
 *
 * Uso: `node scripts/check-confirmation-rollback.mjs --db <sqlite-path>`
 * (o SQLite do DO / backup). Falha (exit 1) se existir qualquer linha com
 * `status <> 'succeeded'` ou `operation_id = ''`. Sem a coluna `status`
 * (schema pré-hardening) o banco já está drenado por construção ⇒ READY.
 */
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

/**
 * Decide a prontidão a partir das linhas lidas (puro, testável sem banco).
 * Linha bloqueadora: `status` diferente de `succeeded` OU `operation_id`
 * vazio (sentinela unbound — o leitor antigo a rebindaria em silêncio).
 */
export const evaluateConfirmationRollbackReadiness = (rows) => {
  const blockers = (rows ?? []).filter(
    (row) => String(row?.status ?? '') !== 'succeeded' || String(row?.operation_id ?? '') === '',
  );
  if (blockers.length === 0) return { ok: true, blockers: [], reason: 'no reserved/unbound/non-succeeded confirmation rows' };
  return {
    ok: false,
    blockers: blockers.slice(0, 20).map((row) => String(row?.intention_id ?? '<unknown>')),
    reason: `${blockers.length} confirmation row(s) would misread as success replay under a pre-hardening binary (reserved/inconclusive/unbound)`,
  };
};

const readRows = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  try {
    try {
      return [...db.prepare(`SELECT intention_id, operation_id, status FROM mutation_confirmations`).all()];
    } catch (error) {
      // Sem a coluna `status`: schema pré-hardening — nada do hardening
      // existe aqui, rollback trivialmente seguro.
      if (/no such column: status/i.test(String(error?.message ?? error))) {
        return [];
      }
      throw error;
    }
  } finally {
    db.close();
  }
};

export const main = () => {
  const index = process.argv.indexOf('--db');
  const dbPath = index >= 0 ? process.argv[index + 1] : undefined;
  if (!dbPath) {
    console.error('Usage: node scripts/check-confirmation-rollback.mjs --db <sqlite-path>');
    process.exitCode = 2;
    return;
  }
  let rows;
  try {
    rows = readRows(dbPath);
  } catch (error) {
    console.error(`Confirmation rollback check failed: cannot read ${dbPath}: ${String(error?.message ?? error)}`);
    process.exitCode = 2;
    return;
  }
  const result = evaluateConfirmationRollbackReadiness(rows);
  if (!result.ok) {
    console.error(
      `Confirmation rollback BLOCKED: ${result.reason}. ` +
      `Drene as confirmações (sem pendentes/reservas — aguarde a quiescência dos turnos em voo e confirme que só restam bindings 'succeeded') + aprovação humana antes do rollback para pré-hardening. ` +
      `Intenções bloqueadoras: ${result.blockers.join(', ')}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Confirmation rollback: READY (${result.reason}).`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
