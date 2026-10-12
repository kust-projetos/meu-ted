import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateConfirmationRollbackReadiness } from './check-confirmation-rollback.mjs';

test('vazio ou só succeeded ⇒ READY', () => {
  assert.deepEqual(evaluateConfirmationRollbackReadiness([]), {
    ok: true,
    blockers: [],
    reason: 'no reserved/unbound/non-succeeded confirmation rows',
  });
  assert.equal(
    evaluateConfirmationRollbackReadiness([
      { intention_id: 'a', operation_id: 'op-A', status: 'succeeded' },
    ]).ok,
    true,
  );
});

test('reserved/inconclusive/unbound ⇒ BLOQUEADO com as intenções', () => {
  const result = evaluateConfirmationRollbackReadiness([
    { intention_id: 'intent-A', operation_id: 'op-A', status: 'reserved' },
    { intention_id: 'intent-B', operation_id: 'op-B', status: 'inconclusive' },
    { intention_id: 'intent-C', operation_id: '', status: 'reserved' },
    { intention_id: 'intent-ok', operation_id: 'op-ok', status: 'succeeded' },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ['intent-A', 'intent-B', 'intent-C']);
});

test('CLI contra SQLite real: bloqueia com reservas, libera drenado', () => {
  const scriptPath = fileURLToPath(new URL('./check-confirmation-rollback.mjs', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-gate-'));
  const dbPath = path.join(dir, 'draft.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE mutation_confirmations (
      workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '',
      intention_id TEXT NOT NULL, operation_id TEXT NOT NULL, receipt_json TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'succeeded',
      PRIMARY KEY (workspace_id, actor_id, device_id, intention_id)
    );
  `);
  db.prepare(`INSERT INTO mutation_confirmations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'ws', 'actor', 'dev', 'intent-A', 'op-A', null, '2026-10-11T12:00:00.000Z', '2026-10-12T12:00:00.000Z', 'reserved',
  );
  db.close();

  assert.throws(() => execFileSync(process.execPath, [scriptPath, '--db', dbPath], { stdio: 'pipe' }), /BLOCKED/);

  const db2 = new DatabaseSync(dbPath);
  db2.prepare(`UPDATE mutation_confirmations SET status = 'succeeded' WHERE intention_id = 'intent-A'`).run();
  db2.close();
  const out = execFileSync(process.execPath, [scriptPath, '--db', dbPath], { encoding: 'utf8' });
  assert.match(out, /READY/);
});
